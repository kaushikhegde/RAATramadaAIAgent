/**
 * payments-store.js — durable state for every payment the agent touches.
 * ======================================================================
 * A flat JSON file, for the same reasons creditor-aliases.js is one: it's a
 * handful of rows, it has to survive a server restart, and a human being able
 * to open it in a text editor and see exactly what the agent did is a feature,
 * not a shortcut.
 *
 * This one file answers three separate requirements from the MINT guide at once:
 *
 *   BR01  — no reference number found: the payment sits here as a "draft" and
 *           is NOT sent to Mint. The API makes external_invoice_reference
 *           mandatory, so there is no half-filled transaction to leave sitting
 *           at Mint's end the way the manual process leaves a half-filled form.
 *           The draft has to live somewhere, and this is where.
 *
 *   Audit — "ability to log and show the steps AI Agent has taken". Every state
 *           change is appended to the record's history with a timestamp and who
 *           caused it. Nothing is ever overwritten in place.
 *
 *   Resume — the consultant will not still have the chat open when the payment
 *           is authorised in MintEFT. State cannot live in a session object.
 *
 * Local status (ours, not Mint's):
 *   draft      → missing something (BR01); never sent
 *   staged     → sent to Mint, awaiting a human's authorisation
 *   authorised → human authorised; ready to write back to Tramada
 *   recorded   → written into Tramada; done
 *   declined / cancelled / failed → terminal, nothing written to Tramada
 */

const fs = require("fs");
const path = require("path");

const FILE = process.env.PAYMENTS_STORE_FILE || path.join(__dirname, "payments-store.json");

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(data) {
  // Write-then-rename so a crash mid-write cannot leave a truncated ledger.
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

/** Local id, distinct from Mint's transaction id (which may not exist yet). */
function newId() {
  return "PAY-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
}

/**
 * Dedupe key. Mint's docs say nothing about idempotency, so a retried POST may
 * well create a second real payment. Until Mint confirms otherwise we own this:
 * one booking + one supplier invoice reference = one payment, full stop.
 */
function dedupeKey({ bookingNo, invoiceReference }) {
  return `${String(bookingNo || "").trim()}::${String(invoiceReference || "").trim()}`.toLowerCase();
}

function create(fields) {
  const all = readAll();

  const key = dedupeKey(fields);
  if (fields.invoiceReference) {
    const clash = Object.values(all).find(
      (p) => dedupeKey(p) === key && !["declined", "cancelled", "failed"].includes(p.status)
    );
    if (clash) {
      const err = new Error(
        `Booking ${fields.bookingNo} reference ${fields.invoiceReference} already has payment ${clash.id} (${clash.status}).`
      );
      err.code = "DUPLICATE_PAYMENT";
      err.existing = clash;
      throw err;
    }
  }

  const record = {
    id: newId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: fields.invoiceReference ? "pending" : "draft",
    // Tramada side
    bookingNo: fields.bookingNo || null,
    invoiceReference: fields.invoiceReference || null,
    supplierName: fields.supplierName || null,
    amount: fields.amount ?? null,
    currency: fields.currency || "AUD",
    passengerName: fields.passengerName || null,
    segmentIds: fields.segmentIds || [],
    // Mint side
    mintTransactionId: null,
    mintStatus: null,
    payeeCompanyNumber: fields.payeeCompanyNumber || null,
    // Who
    consultantEmail: fields.consultantEmail || null,
    history: [],
  };

  append(record, "created", fields.invoiceReference ? "Payment staged from Tramada" : "Draft — no reference number (BR01)", fields.consultantEmail);

  all[record.id] = record;
  writeAll(all);
  return record;
}

/** Append to history. Never mutates past entries — this is the audit trail. */
function append(record, event, detail, actor) {
  record.history.push({
    at: new Date().toISOString(),
    event,
    detail: detail || null,
    actor: actor || "agent",
  });
  return record;
}

function update(id, changes, { event, detail, actor } = {}) {
  const all = readAll();
  const record = all[id];
  if (!record) throw new Error(`No payment record ${id}`);

  Object.assign(record, changes, { updatedAt: new Date().toISOString() });
  if (event) append(record, event, detail, actor);

  all[id] = record;
  writeAll(all);
  return record;
}

function get(id) {
  return readAll()[id] || null;
}

function findByMintId(transactionId) {
  return Object.values(readAll()).find((p) => p.mintTransactionId === transactionId) || null;
}

/**
 * Everything still waiting on a human. Called on server start-up: these are the
 * payments staged before the last restart, and they are exactly what the poller
 * has to pick back up.
 */
function listAwaiting() {
  return Object.values(readAll()).filter((p) => p.status === "staged");
}

function list(filter = {}) {
  let out = Object.values(readAll());
  if (filter.status) out = out.filter((p) => p.status === filter.status);
  if (filter.bookingNo) out = out.filter((p) => String(p.bookingNo) === String(filter.bookingNo));
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

module.exports = { create, update, get, list, listAwaiting, findByMintId, dedupeKey };
