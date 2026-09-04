/**
 * mint-client.js — the ONLY module in this project that talks to MintEFT.
 * ======================================================================
 * Deliberately thin: it speaks HTTP, it knows the documented field names, and
 * it knows nothing whatsoever about Tramada, bookings or chat. All the mapping
 * lives above it. That separation is what lets the whole payment flow be built
 * and rehearsed against the local mock before a real API key exists.
 *
 * Swapping mock → UAT → production is ONE environment variable:
 *
 *   MINT_BASE_URL=http://localhost:4000/eft/v1                    (mock, today)
 *   MINT_BASE_URL=https://secure-uatsb.mintpayments.net/eft/v1    (UAT, on key issue)
 *   MINT_BASE_URL=https://secure.mintpayments.com/eft/v1          (production)
 *
 * Nothing else in the codebase changes. That is the entire point of this file,
 * so resist adding mode-dependent branches here — if a "if (MOCK)" ever appears
 * below, the mock has stopped proving anything about production.
 *
 * Field names are the documented ones VERBATIM (external_invoice_reference,
 * payee.mint_company_number, due_at_utc, ...). They are not renamed to
 * something tidier, because every rename is a bug that waits until UAT day to
 * show itself.
 *
 * Docs: https://mint-payments.readme.io/reference/createtransaction
 */

const fs = require("fs");
const path = require("path");

const BASE_URL = (process.env.MINT_BASE_URL || "http://localhost:4000/eft/v1").replace(/\/+$/, "");
const API_KEY = process.env.MINT_API_KEY || "";
const TIMEOUT_MS = Number(process.env.MINT_TIMEOUT_MS || 30000);
const DEBUG = process.env.DEBUG === "true";

// Every request and response goes to a file, in mock mode as well as live. The
// first UAT call is then a DIFF against the mock's log rather than a debugging
// session — which is worth far more than the few lines it costs here.
const LOG_FILE = process.env.MINT_LOG_FILE || path.join(__dirname, "mint-api-log.jsonl");

function log(...args) {
  if (DEBUG) console.log("[mint]", ...args);
}

function audit(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error("[mint] could not write api log:", err.message);
  }
}

/** An error carrying Mint's own response_code/response_message where it gave one. */
class MintError extends Error {
  constructor(message, { status, responseCode, responseMessage, body } = {}) {
    super(message);
    this.name = "MintError";
    this.status = status;
    this.responseCode = responseCode;
    this.responseMessage = responseMessage;
    this.body = body;
  }
}

async function request(method, endpoint, { body, query } = {}) {
  let url = BASE_URL + endpoint;
  if (query) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")
    ).toString();
    if (qs) url += "?" + qs;
  }

  const started = Date.now();
  log(method, url);

  let res;
  let text;
  try {
    res = await fetch(url, {
      method,
      headers: {
        // The documented scheme: an opaque bearer token, not a JWT.
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    // Timeouts and connection failures land here. They matter more than they
    // look: a timed-out POST /transactions may still have created a payment at
    // Mint's end, so callers must reconcile rather than blindly retry.
    audit({ direction: "error", method, url, body: redact(body), error: err.message, ms: Date.now() - started });
    throw new MintError(`Mint request failed (${err.name}): ${err.message}`, { status: 0 });
  }

  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  audit({
    direction: "call",
    method,
    url,
    request: redact(body),
    status: res.status,
    response: parsed,
    ms: Date.now() - started,
  });

  if (!res.ok) {
    throw new MintError(
      parsed?.response_message || parsed?.error?.message || `Mint returned HTTP ${res.status}`,
      {
        status: res.status,
        responseCode: parsed?.response_code,
        responseMessage: parsed?.response_message,
        body: parsed,
      }
    );
  }

  return parsed;
}

// Nothing sensitive should ever reach the log file. The bearer token never
// appears in a body, but passenger names do, so they are kept — Mint receives
// them anyway — while anything that looks like a secret is stripped.
function redact(body) {
  if (!body || typeof body !== "object") return body;
  const clone = JSON.parse(JSON.stringify(body));
  for (const key of ["api_key", "apiKey", "password", "token", "authorization"]) {
    if (key in clone) clone[key] = "<redacted>";
  }
  return clone;
}

/**
 * Create an UNAUTHORISED payment — BR02, expressed as code.
 *
 * `type` is a hardcoded literal, not a parameter, and not a variable read from
 * config. The API also offers "create_and_authorise_payment", which would move
 * money without a human. Because that string cannot be reached from anywhere in
 * this codebase, the agent is structurally incapable of processing a payment —
 * a far stronger control than a rule that says it mustn't.
 *
 * Returns Mint's transaction object; status will be pending_for_authorisation.
 */
async function createPayment({ transaction, user, payer, payee }) {
  return request("POST", "/transactions", {
    body: {
      transaction: { ...transaction, type: "create_payment" },
      user,
      payer,
      payee,
    },
  });
}

/** Current state of one transaction. This is what the poller calls against real Mint. */
async function getTransaction(transactionId) {
  return request("GET", `/transaction-by-id/${encodeURIComponent(transactionId)}`);
}

/** Full status timeline — Mint's own audit trail, worth storing alongside ours. */
async function getStatusHistory(transactionId) {
  return request("GET", `/${encodeURIComponent(transactionId)}/status-history`);
}

/** Recovery path: find a transaction again when we have the references but lost the id. */
async function searchTransactions(filters = {}) {
  return request("GET", "/transaction_search", { query: filters });
}

/** Resolve a Tramada supplier name to a Mint payee (and its mint_company_number). */
async function searchPayees(query) {
  return request("GET", "/payee-search", { query: typeof query === "string" ? { name: query } : query });
}

/** Abandon a staged payment the consultant rejected. */
async function cancelTransaction(transactionId, reason) {
  return request("POST", "/cancel/transactions", {
    body: { transaction_id: transactionId, reason: reason || "Cancelled by consultant" },
  });
}

/** Which Mint are we pointed at? Used for the loud banner in the chat UI. */
function environment() {
  if (/localhost|127\.0\.0\.1/.test(BASE_URL)) return "mock";
  if (/uatsb|uat/i.test(BASE_URL)) return "uat";
  return "production";
}

module.exports = {
  createPayment,
  getTransaction,
  getStatusHistory,
  searchTransactions,
  searchPayees,
  cancelTransaction,
  environment,
  MintError,
  BASE_URL,
};
