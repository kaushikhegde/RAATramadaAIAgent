/**
 * mint-payment-issuer.js — turns a confirmed Mint payment onto a staged,
 * UNAUTHORISED MintEFT transaction via the API. Sits between server.js's chat
 * flow and mint-client.js, the same role dvc-card-issuer.js plays for ICCP.
 * ============================================================================
 *
 *   1. Resolve the Tramada supplier name to exactly one Mint payee
 *      (mint_company_number). mock-mint-server.js seeds deliberate
 *      near-duplicate payee names for exactly this reason — supplier matching
 *      here is a real problem with no automated recovery, so an ambiguous or
 *      absent match is surfaced to a human, never guessed.
 *
 *   2. Map the Tramada read onto MintEFT's documented request shape
 *      (external_invoice_reference, passenger_name, mint_company_number, ...).
 *
 *   3. Stage the payment via mintClient.createPayment() — which is hardcoded to
 *      transaction.type "create_payment", never "create_and_authorise_payment"
 *      (BR02). This module adds no confirmation gate of its own on top of that,
 *      because the API call itself is structurally incapable of moving money;
 *      the real authorisation still only happens when a human clicks Confirm
 *      inside MintEFT's own UI, on a screen this codebase does not own.
 *
 *   4. Record it in payments-store.js BEFORE the API call, so there is an audit
 *      trail even if the call itself fails or times out — same reasoning as
 *      dvc-card-issuer.js.
 *
 * RAA's own Mint account number (MINT_PAYER_COMPANY_NUMBER) is account
 * configuration, not booking data — read from env, same treatment iccp-client.js
 * gives companyId/templateId.
 */

const mintClient = require("./mint-client");
const paymentsStore = require("./payments-store");
const { lastName, firstReference, referenceToken } = require("./payment-views");

// Resolved payee lookups are safe to cache for the process's life — Mint's own
// payee list changes about as often as a new supplier is onboarded.
const payeeCache = new Map();

/** RAA's own Mint account/company number — required by both payee-search and createPayment. */
function getPayerCompanyNumber() {
  const payerCompanyNumber = process.env.MINT_PAYER_COMPANY_NUMBER;
  if (!payerCompanyNumber) {
    throw new Error(
      "Missing MINT_PAYER_COMPANY_NUMBER — RAA's own Mint company/account number, set by Mint's own " +
        "administrator, not booking data. Set it in .env."
    );
  }
  return payerCompanyNumber;
}

/**
 * Resolve a Tramada supplier name to a Mint payee.
 *
 * @returns {Promise<{payee}|{error}|{candidates}>}
 *   payee       exactly one match — safe to stage a payment against
 *   error       no match at all — nothing to stage
 *   candidates  more than one match — the caller must ask a human which one
 */
async function resolvePayee(supplierName) {
  if (!supplierName) {
    return { error: "No supplier name on the booking to search Mint payees with." };
  }

  // ⚠️ TEMPORARY DEMO OVERRIDE — MINT_FORCE_PAYEE_COMPANY_NUMBER, set in .env.
  // Real Tramada suppliers won't resolve until each one is individually
  // onboarded as a Mint payee (an admin/KYC action on Mint's side, not
  // self-service — see MEMORY on the ICCP company/RCN placeholders for the
  // same pattern). Until that's done, every booking is forced onto one known,
  // working sandbox payee regardless of its real supplier, so the rest of the
  // pipeline (staging, authorisation watch, Tramada write-back) can still be
  // exercised end-to-end. Remove this block once real suppliers resolve.
  if (process.env.MINT_FORCE_PAYEE_COMPANY_NUMBER) {
    return {
      payee: {
        mint_company_number: process.env.MINT_FORCE_PAYEE_COMPANY_NUMBER,
        name: process.env.MINT_FORCE_PAYEE_NAME || process.env.MINT_FORCE_PAYEE_COMPANY_NUMBER,
      },
    };
  }

  const key = supplierName.trim().toLowerCase();
  if (payeeCache.has(key)) return { payee: payeeCache.get(key) };

  const resp = await mintClient.searchPayees({
    companyNumber: getPayerCompanyNumber(),
    payeeNameOrNumber: supplierName,
  });
  // Mint's own inconsistency: payee-search returns the payee's number as
  // `company_number`, but createPayment's payer/payee objects require it under
  // `mint_company_number`. Normalize once, here, rather than at every caller.
  const payees = (resp && resp.payees ? resp.payees : []).map((p) => ({
    ...p,
    mint_company_number: p.mint_company_number || p.company_number,
  }));

  if (payees.length === 0) {
    return {
      error:
        `No Mint payee found for "${supplierName}" — add it in MintEFT's own payee list first, ` +
        `or check the spelling against Tramada's Creditor field.`,
    };
  }
  if (payees.length > 1) {
    return { candidates: payees };
  }
  payeeCache.set(key, payees[0]);
  return { payee: payees[0] };
}

/** Mint's due_at_utc wants "yyyy-MM-dd'T'HH:mm:ss" — no milliseconds, no trailing Z. */
function toMintUtcDateTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "");
}

/** Mint step 9's field mapping, expressed as the documented API request shape. */
function buildTransactionFields(result, { payee, consultantEmail }) {
  const ref = firstReference(result);
  const invoiceReference = ref ? referenceToken(ref) : null;

  const payerCompanyNumber = getPayerCompanyNumber();

  return {
    transaction: {
      external_invoice_reference: invoiceReference,
      // "Sender's Reference" in MintEFT's own UI — RAA's own convention is
      // booking number prefixed with B (e.g. booking 123456 -> "B123456").
      external_transaction_reference: `B${result.bookingNo}`,
      amount: Number(result.total),
      currency: "AUD",
      due_at_utc: toMintUtcDateTime(new Date()),
      passenger_name: lastName(result.clientName),
      // `booking` is an OBJECT in Mint's real schema ("optional booking-related
      // metadata"), not a string — its sub-fields aren't documented anywhere
      // this codebase has seen, so it's left out rather than guessed. The
      // booking number itself already travels in external_transaction_reference,
      // which the guide maps it to.
      notes: `RAA booking ${result.bookingNo}`,
    },
    user: {
      // Tramada's read only ever gives us the consultant's NAME (Cons1, e.g.
      // "Megan Gray") — this codebase has no source of their real email
      // anywhere — so a caller passing that name through as "consultantEmail"
      // must not land here verbatim. Only used when it actually looks like
      // one; otherwise the configured system address, never a bare name.
      email: /.+@.+\..+/.test(String(consultantEmail || "")) ? consultantEmail : (process.env.MINT_DEFAULT_USER_EMAIL || ""),
      // A server-to-server call has no real browser IP to report; Mint's schema
      // still requires the field, so this is a documented placeholder, not a
      // spoofed client address.
      ip_address: process.env.MINT_USER_IP || "127.0.0.1",
      user_agent: "RAATramadaAIAgent/1.0",
      timezone: process.env.MINT_DEFAULT_TIMEZONE || "Australia/Brisbane",
    },
    payer: { mint_company_number: payerCompanyNumber },
    payee: { mint_company_number: payee.mint_company_number },
    invoiceReference,
  };
}

/**
 * Stage an UNAUTHORISED Mint payment (BR02).
 *
 * @param result           tramada-payment.js's readPaymentBooking() output (flow "mint")
 * @param payee            a single resolved payee from resolvePayee()
 * @param consultantEmail  who initiated it, for the audit trail and Mint's user.email
 * @param onRequestBuilt   optional ({transaction,user,payer,payee}) => void, called with
 *                         the exact request body right before it is sent — lets a caller
 *                         (e.g. server.js) show the consultant the real outgoing request,
 *                         same idea as dvc-card-issuer.js's onRequestBuilt for ICCP's XML.
 * @throws {Error}         with .code === "DUPLICATE_PAYMENT" when this booking+reference
 *                         already has a non-terminal payment (payments-store.js's dedupe guard)
 */
async function stagePayment({ result, payee, consultantEmail, onRequestBuilt }) {
  const fields = buildTransactionFields(result, { payee, consultantEmail });

  // Created before the API call — an audit trail exists even if the call fails.
  const record = paymentsStore.create({
    provider: "mint",
    bookingNo: result.bookingNo,
    invoiceReference: fields.invoiceReference,
    supplierName: result.supplier,
    amount: result.total,
    passengerName: fields.transaction.passenger_name,
    payeeCompanyNumber: payee.mint_company_number,
    consultantEmail,
  });

  paymentsStore.update(record.id, { status: "staged" }, {
    event: "mint_request_sent",
    detail: `createPayment — env=${mintClient.environment()}, amount=$${result.total}`,
    actor: consultantEmail || "agent",
  });

  const requestBody = {
    transaction: fields.transaction,
    user: fields.user,
    payer: fields.payer,
    payee: fields.payee,
  };

  if (onRequestBuilt) {
    try {
      onRequestBuilt(requestBody);
    } catch {
      // Display-only — never let a formatting problem block the real call.
    }
  }

  let created;
  try {
    created = await mintClient.createPayment({
      transaction: fields.transaction,
      user: fields.user,
      payer: fields.payer,
      payee: fields.payee,
    });
  } catch (err) {
    paymentsStore.update(record.id, { status: "failed" }, {
      event: "mint_request_failed",
      detail: err.message,
      actor: "agent",
    });
    throw err;
  }

  const updated = paymentsStore.update(
    record.id,
    { mintTransactionId: created.transaction_id, mintStatus: created.status },
    {
      event: "mint_transaction_staged",
      detail: `transaction_id=${created.transaction_id}, status=${created.status}`,
      actor: consultantEmail || "agent",
    }
  );

  return { record: updated, transaction: created };
}

module.exports = { resolvePayee, stagePayment };
