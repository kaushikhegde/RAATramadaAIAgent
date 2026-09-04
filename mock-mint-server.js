/**
 * mock-mint-server.js — a stand-in for MintEFT, spoken over real HTTP.
 * ====================================================================
 * Run this until Mint issue an API key. It implements the documented MintEFT
 * contract closely enough that swapping to UAT is one environment variable.
 *
 *   node mock-mint-server.js          # listens on :4000
 *
 * WHY A SERVER AND NOT A STUB
 * ---------------------------
 * Mocking at the function boundary (stubbing createPayment() in JS) tests your
 * own imagination. Mocking at the NETWORK boundary tests JSON serialisation,
 * headers, timeouts, HTTP status codes and error-body shapes — which is where
 * integrations actually break. So this is a real Express app, mint-client.js
 * makes real fetch() calls to it, and every one of those paths gets exercised
 * before a real key exists.
 *
 * TWO SURFACES, KEPT SEPARATE ON PURPOSE
 * --------------------------------------
 *   /eft/v1/*   the documented MintEFT API. Mirrors the real thing. When the
 *               key arrives, this half is thrown away and nothing else moves.
 *   /mock/*     the control plane — the human's authorisation, fault injection,
 *               the event stream. NONE of this exists at real Mint.
 *
 * That split is not cosmetic. In production the consultant authorises inside
 * MintEFT's own web UI, on a screen you do not own and cannot call. The /mock
 * routes stand in for that screen. Keeping them under an obviously fake prefix
 * is what stops the POC quietly growing a dependency on a capability Mint does
 * not offer.
 *
 * THE EVENT STREAM AND ITS TRAP
 * -----------------------------
 * GET /mock/events is Server-Sent Events: the moment a human answers, this
 * pushes, and the agent reacts without ever having blocked. That is the right
 * shape — but REAL MINT HAS NO WEBHOOKS. The spec documents none. So the agent
 * must never subscribe to this directly; it subscribes to payment-events.js,
 * which is fed by this stream in mock mode and by a poller against real Mint.
 * Identical events either way. See payment-events.js.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.MOCK_MINT_PORT || 4000);
const DB_FILE = process.env.MOCK_MINT_DB || path.join(__dirname, "mock-mint-db.json");

// Any non-empty key is accepted — the point is exercising the auth PATH, not
// the secret. A missing or malformed header still gets a real 401.
const REQUIRE_AUTH = process.env.MOCK_MINT_NO_AUTH !== "true";

// Fault injection. Production will be slower and less reliable than localhost,
// and the agent's behaviour under a hang or a 500 is more interesting than its
// behaviour on the happy path.
const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS || 0);
const FAIL_RATE = Number(process.env.MOCK_FAIL_RATE || 0); // 0..1

const app = express();
app.use(express.json({ limit: "1mb" }));

// ─── Storage ─────────────────────────────────────────────────────
function readDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { transactions: {}, payees: seedPayees() };
  }
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/**
 * Seeded from real Tramada creditor names, deliberately spelled the way a
 * separate system would spell them. The near-duplicates are the point: supplier
 * name matching is the failure mode with no automated recovery, and it has to
 * be a real problem in the mock or it will be a surprise in production.
 */
function seedPayees() {
  return [
    { mint_company_number: "M100411", name: "POD 39 SYDNEY PTY LTD", bsb: "062-000", account: "****1234" },
    { mint_company_number: "M100412", name: "Q CITY HOTEL MANAGEMENT", bsb: "062-000", account: "****5678" },
    { mint_company_number: "M100413", name: "SWISS-BELHOTEL THE YORK", bsb: "062-000", account: "****9012" },
    { mint_company_number: "M100414", name: "SWISS-BELHOTEL INTERNATIONAL AUST", bsb: "062-000", account: "****9013" },
    { mint_company_number: "M100415", name: "JETSTAR AIRWAYS PTY LTD", bsb: "083-004", account: "****3344" },
    { mint_company_number: "M100416", name: "QANTAS AIRWAYS LIMITED", bsb: "083-004", account: "****3345" },
    { mint_company_number: "M100417", name: "ACCOR HOTELS AUSTRALIA", bsb: "062-100", account: "****7788" },
    { mint_company_number: "M100418", name: "RAA TRAVEL PTY LTD", bsb: "105-900", account: "****0001" },
  ];
}

/** BR03: Mint transaction numbers are M00 followed by six digits. */
function newTransactionId(db) {
  let id;
  do {
    id = "M00" + String(Math.floor(100000 + Math.random() * 900000));
  } while (db.transactions[id]);
  return id;
}

// ─── Event stream (mock control plane, NOT part of the Mint API) ──
const subscribers = new Set();

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(payload);
    } catch {
      subscribers.delete(res);
    }
  }
  console.log(`[mock-mint] → ${event}`, data.transaction_id || "");
}

// ─── Middleware ──────────────────────────────────────────────────
function errorBody(code, message, detail) {
  return {
    response_code: code,
    response_message: message,
    error: { code, message, detail: detail || null },
  };
}

// Applies to the API surface only — the /mock control plane is unauthenticated
// on purpose, because it represents a human at a browser, not an API caller.
app.use("/eft/v1", async (req, res, next) => {
  if (LATENCY_MS) await new Promise((r) => setTimeout(r, LATENCY_MS));

  if (FAIL_RATE > 0 && Math.random() < FAIL_RATE) {
    console.log("[mock-mint] injected 500");
    return res.status(500).json(errorBody("500", "Internal server error (injected by mock)"));
  }

  if (REQUIRE_AUTH) {
    const auth = req.get("authorization") || "";
    if (!/^Bearer\s+\S+/i.test(auth)) {
      return res.status(401).json(errorBody("401", "Unauthorized", "Missing or malformed Authorization bearer token"));
    }
  }
  next();
});

// ─── POST /eft/v1/transactions ───────────────────────────────────
const REQUIRED = [
  ["transaction.external_invoice_reference", (b) => b?.transaction?.external_invoice_reference],
  ["transaction.external_transaction_reference", (b) => b?.transaction?.external_transaction_reference],
  ["transaction.amount", (b) => b?.transaction?.amount],
  ["transaction.currency", (b) => b?.transaction?.currency],
  ["transaction.due_at_utc", (b) => b?.transaction?.due_at_utc],
  ["transaction.type", (b) => b?.transaction?.type],
  ["user.email", (b) => b?.user?.email],
  ["user.ip_address", (b) => b?.user?.ip_address],
  ["user.user_agent", (b) => b?.user?.user_agent],
  ["user.timezone", (b) => b?.user?.timezone],
  ["payer.mint_company_number", (b) => b?.payer?.mint_company_number],
  ["payee.mint_company_number", (b) => b?.payee?.mint_company_number],
];

const VALID_TYPES = ["create_payment", "create_and_authorise_payment", "create_and_lock_payment", "request_payment"];

app.post("/eft/v1/transactions", (req, res) => {
  const body = req.body || {};

  const missing = REQUIRED.filter(([, get]) => {
    const v = get(body);
    return v === undefined || v === null || v === "";
  }).map(([name]) => name);

  if (missing.length) {
    return res.status(400).json(errorBody("400", "Bad Request", `Missing required field(s): ${missing.join(", ")}`));
  }

  const { transaction, user, payer, payee } = body;

  if (!VALID_TYPES.includes(transaction.type)) {
    return res.status(400).json(errorBody("400", "Bad Request", `Invalid transaction.type "${transaction.type}"`));
  }
  if (typeof transaction.amount !== "number" || !(transaction.amount > 0)) {
    return res.status(400).json(errorBody("400", "Bad Request", "transaction.amount must be a positive number"));
  }

  const db = readDb();

  if (!db.payees.some((p) => p.mint_company_number === payee.mint_company_number)) {
    return res.status(400).json(errorBody("400", "Bad Request", `Unknown payee ${payee.mint_company_number}`));
  }

  // NOT idempotent — on purpose. Mint's docs say nothing about idempotency, so
  // the honest assumption is that a retried POST creates a second real payment.
  // The mock reproduces that, which forces the dedupe guard in payments-store.js
  // to be real rather than theoretical.
  const id = newTransactionId(db);
  const now = new Date().toISOString();

  // create_payment lands unauthorised and STAYS there until a human acts. That
  // is the whole human-in-the-loop control (BR02), and the mock must never
  // advance it on a timer, however convenient that would be for a demo.
  const status = transaction.type === "create_and_authorise_payment" ? "authorised" : "pending_for_authorisation";

  const record = {
    transaction_id: id,
    status,
    created_date_utc: now,
    amount: transaction.amount,
    currency: transaction.currency,
    external_invoice_reference: transaction.external_invoice_reference,
    external_transaction_reference: transaction.external_transaction_reference,
    passenger_name: transaction.passenger_name || null,
    booking: transaction.booking || null,
    notes: transaction.notes || null,
    due_at_utc: transaction.due_at_utc,
    type: transaction.type,
    payer,
    payee,
    initiated_by: user.email,
    status_history: [{ status, at: now, by: user.email }],
    response_code: "200",
    response_message: "Success",
  };

  db.transactions[id] = record;
  writeDb(db);

  console.log(`[mock-mint] created ${id} (${status}) ${transaction.currency} ${transaction.amount} → ${payee.mint_company_number}`);

  // Stands in for the payment appearing in MintEFT's queue for a human to
  // review. In production this event does not exist — the consultant simply
  // sees it in the Mint UI.
  if (status === "pending_for_authorisation") {
    emit("authorisation_required", {
      transaction_id: id,
      amount: record.amount,
      currency: record.currency,
      payee_name: db.payees.find((p) => p.mint_company_number === payee.mint_company_number)?.name || null,
      payee_company_number: payee.mint_company_number,
      external_invoice_reference: record.external_invoice_reference,
      external_transaction_reference: record.external_transaction_reference,
      passenger_name: record.passenger_name,
      initiated_by: record.initiated_by,
    });
  }

  res.status(200).json({
    transaction_id: id,
    status,
    created_date_utc: now,
    response_code: "200",
    response_message: "Success",
  });
});

// ─── POST /eft/v1/cancel/transactions ────────────────────────────
app.post("/eft/v1/cancel/transactions", (req, res) => {
  const { transaction_id: txnId, reason } = req.body || {};
  const db = readDb();
  const txn = db.transactions[txnId];

  if (!txn) return res.status(404).json(errorBody("404", "Not Found", `No transaction ${txnId}`));
  if (["settled", "approved"].includes(txn.status)) {
    return res.status(400).json(errorBody("400", "Bad Request", `Cannot cancel a ${txn.status} transaction`));
  }

  setStatus(db, txn, "cancelled", reason || "Cancelled");
  writeDb(db);
  res.status(200).json({ transaction_id: txnId, status: "cancelled", response_code: "200", response_message: "Success" });
});

// ─── GET /eft/v1/payee-search ────────────────────────────────────
app.get("/eft/v1/payee-search", (req, res) => {
  const q = String(req.query.name || req.query.q || "").trim().toLowerCase();
  const db = readDb();
  const results = q
    ? db.payees.filter((p) => p.name.toLowerCase().includes(q) || tokenOverlap(p.name, q))
    : db.payees;
  res.status(200).json({ payees: results, response_code: "200", response_message: "Success" });
});

// Crude on purpose: enough to return the near-duplicates so the ambiguity is
// visible, not enough to resolve it. Resolving it is the caller's problem, and
// it is meant to be.
function tokenOverlap(name, q) {
  const a = new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const b = String(q).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return b.some((t) => t.length > 3 && a.has(t));
}

// ─── GET /eft/v1/transaction_search ──────────────────────────────
app.get("/eft/v1/transaction_search", (req, res) => {
  const db = readDb();
  let out = Object.values(db.transactions);
  const { status, external_transaction_reference: extTxn, external_invoice_reference: extInv } = req.query;

  if (status) out = out.filter((t) => t.status === status);
  if (extTxn) out = out.filter((t) => t.external_transaction_reference === extTxn);
  if (extInv) out = out.filter((t) => t.external_invoice_reference === extInv);

  res.status(200).json({ transactions: out, count: out.length, response_code: "200", response_message: "Success" });
});

// ─── GET /eft/v1/transaction-by-id/:id ───────────────────────────
// This is what the POLLER calls against real Mint. It must work in the mock too
// — otherwise the polling feeder is never exercised before UAT.
app.get("/eft/v1/transaction-by-id/:id", (req, res) => {
  const db = readDb();
  const txn = db.transactions[req.params.id];
  if (!txn) return res.status(404).json(errorBody("404", "Not Found", `No transaction ${req.params.id}`));
  res.status(200).json({ ...txn, response_code: "200", response_message: "Success" });
});

// ─── GET /eft/v1/:id/status-history ──────────────────────────────
// Registered last: it is the loosest pattern on this prefix and would otherwise
// swallow the named routes above.
app.get("/eft/v1/:id/status-history", (req, res) => {
  const db = readDb();
  const txn = db.transactions[req.params.id];
  if (!txn) return res.status(404).json(errorBody("404", "Not Found", `No transaction ${req.params.id}`));
  res.status(200).json({
    transaction_id: txn.transaction_id,
    status_history: txn.status_history,
    response_code: "200",
    response_message: "Success",
  });
});

function setStatus(db, txn, status, detail, by) {
  txn.status = status;
  txn.status_history.push({ status, at: new Date().toISOString(), detail: detail || null, by: by || "human" });
  emit("status_changed", {
    transaction_id: txn.transaction_id,
    status,
    detail: detail || null,
    amount: txn.amount,
    currency: txn.currency,
    external_transaction_reference: txn.external_transaction_reference,
  });
  return txn;
}

// ═══ /mock — the control plane. None of this exists at real Mint. ═══

/**
 * SSE stream. Pushes the instant a human answers, so the agent never blocks and
 * never polls in mock mode. payment-events.js consumes this.
 */
app.get("/mock/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  subscribers.add(res);
  console.log(`[mock-mint] subscriber connected (${subscribers.size} total)`);

  const keepAlive = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* closed */ }
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAlive);
    subscribers.delete(res);
    console.log(`[mock-mint] subscriber gone (${subscribers.size} left)`);
  });
});

/** Everything sitting in the queue — what the human would see in MintEFT. */
app.get("/mock/pending", (_req, res) => {
  const db = readDb();
  res.json(Object.values(db.transactions).filter((t) => t.status === "pending_for_authorisation"));
});

/** The human says yes. Stands in for clicking Confirm in MintEFT. */
app.post("/mock/authorise/:id", (req, res) => {
  const db = readDb();
  const txn = db.transactions[req.params.id];
  if (!txn) return res.status(404).json({ error: `No transaction ${req.params.id}` });
  if (txn.status !== "pending_for_authorisation") {
    return res.status(409).json({ error: `Transaction is ${txn.status}, not pending_for_authorisation` });
  }
  setStatus(db, txn, "authorised", req.body?.note || null, req.body?.by || "human");
  writeDb(db);
  res.json({ transaction_id: txn.transaction_id, status: txn.status });
});

/** The human says no. */
app.post("/mock/decline/:id", (req, res) => {
  const db = readDb();
  const txn = db.transactions[req.params.id];
  if (!txn) return res.status(404).json({ error: `No transaction ${req.params.id}` });
  setStatus(db, txn, "declined", req.body?.reason || "Declined by consultant", req.body?.by || "human");
  writeDb(db);
  res.json({ transaction_id: txn.transaction_id, status: txn.status });
});

/**
 * Advance an authorised payment down the bank rail. Real settlement takes days;
 * this exists so the later states can be rehearsed in seconds.
 */
app.post("/mock/settle/:id", (req, res) => {
  const db = readDb();
  const txn = db.transactions[req.params.id];
  if (!txn) return res.status(404).json({ error: `No transaction ${req.params.id}` });
  setStatus(db, txn, req.body?.status || "settled", "Advanced by mock", "bank");
  writeDb(db);
  res.json({ transaction_id: txn.transaction_id, status: txn.status });
});

/** Wipe between test runs. */
app.post("/mock/reset", (_req, res) => {
  writeDb({ transactions: {}, payees: seedPayees() });
  console.log("[mock-mint] reset");
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[mock-mint] listening on http://localhost:${PORT}`);
  console.log(`[mock-mint]   API surface : http://localhost:${PORT}/eft/v1`);
  console.log(`[mock-mint]   control     : http://localhost:${PORT}/mock/pending`);
  console.log(`[mock-mint]   events (SSE): http://localhost:${PORT}/mock/events`);
  if (!REQUIRE_AUTH) console.log("[mock-mint]   WARNING: auth check disabled");
  if (LATENCY_MS) console.log(`[mock-mint]   injecting ${LATENCY_MS}ms latency`);
  if (FAIL_RATE) console.log(`[mock-mint]   injecting ${Math.round(FAIL_RATE * 100)}% failure rate`);
});
