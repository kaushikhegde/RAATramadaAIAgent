/**
 * dvc-card-issuer.js — turns a confirmed DVC plan into a live card via ICCP.
 * ============================================================================
 * Sits between server.js's chat flow and iccp-client.js. Jobs, in order:
 *
 *   1. Map payment-views.js's dvcPlanView() output (BR03/BR04/BR05/BR06
 *      already computed) onto ICCP's real request shape. The custom field
 *      names/order/casing below (Purchase Type, Agent Initials, Store Code,
 *      Supplier Name, Supplier Reference, Tramada Booking Number, Member/Pax
 *      name, Segment Type, Card Request Date) are taken from an actual filled
 *      Westpac "Create Single Request" screenshot for the RAA DVC Supplier
 *      Payments Template — not guessed.
 *
 *   2. Resolve ICCP's supplierId — NOT the Tramada creditor (e.g. Room-Res).
 *      The screenshot showed "Supplier" on that form is the CONSULTANT'S OWN
 *      BRANCH (e.g. "RAA Marion", who receives the VCN by email), matching
 *      tramada-payment.js's level1Branch. Resolved via a live getSuppliers
 *      lookup rather than hardcoded, since branch → supplierId is account
 *      configuration, not something derivable from the booking.
 *
 *   3. Enforce the human-authorisation gate. submitPurchaseRequest both
 *      creates AND activates a usable card — there is no separate "Submit"
 *      click to withhold the way the Westpac portal has one, so the gate has
 *      to live here, in front of the API call: issueCard() requires the exact
 *      confirmation literal "CREATE CARD" (see server.js) and refuses to run
 *      without it — the same structural idea as mint-client.js hardcoding
 *      "create_payment" rather than "create_and_authorise_payment".
 *
 *   4. PCI hygiene: the full card number and CVV (ICCP calls it Avv) are
 *      returned to the caller exactly once, to be shown to the consultant and
 *      copied into Tramada notes / LastPass by them (BR09). Nothing written
 *      to payments-store.js ever includes them — only masked last 4 + expiry.
 *
 * Account-level IDs (companyId, dataSourceId, RCN, templateId) are NOT
 * booking data — they identify RAA's own ICCP account and are read from env,
 * since Mastercard's docs say these are configured by "your Mastercard
 * administrator" per company, not chosen per request.
 */

const iccpClient = require("./iccp-client");
const paymentsStore = require("./payments-store");

function maskLast4(cardNumber) {
  const digits = String(cardNumber || "").replace(/\D/g, "");
  return digits ? digits.slice(-4) : null;
}

/** ICCP's Expiry is one 4-char YYMM string. Format for humans as MM/YY. */
function formatExpiry(yymm) {
  const s = String(yymm || "");
  if (s.length !== 4) return s || null;
  return `${s.slice(2, 4)}/${s.slice(0, 2)}`;
}

function monthsBetween(from, to) {
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)));
  return Math.min(24, Math.max(1, Math.ceil(days / 30)));
}

// Resolved once per company per process — read-only lookup, safe to cache.
const supplierIdCache = new Map();

/** Resolve the RAA branch (e.g. "RAA Marion") to ICCP's supplierId for it. */
async function resolveBranchSupplierId(companyId, branchName) {
  if (!branchName) return null;
  const cacheKey = String(companyId);
  let suppliers = supplierIdCache.get(cacheKey);
  if (!suppliers) {
    suppliers = await iccpClient.getSuppliers(companyId);
    supplierIdCache.set(cacheKey, suppliers);
  }
  const norm = (s) => String(s || "").trim().toLowerCase();
  const match =
    suppliers.find((s) => norm(s.name) === norm(branchName)) ||
    suppliers.find((s) => norm(s.name).includes(norm(branchName)));
  return match ? match.id : null;
}

/**
 * Build the ICCP request object from a dvcPlanView() result plus the Tramada
 * read it was computed from. Field values are uppercased where the real
 * template screenshot showed them uppercased.
 */
async function buildPurchaseRequestFields(result, plan) {
  const byLabel = Object.fromEntries(plan.customFields.map((f) => [f.label, f.value]));
  const upper = (v) => (v == null ? "" : String(v).toUpperCase());

  const companyId = process.env.ICCP_COMPANY_ID;
  const dataSourceId = process.env.ICCP_DATA_SOURCE_ID || null;
  const rcnId = process.env.ICCP_RCN_ID;
  const rcnAlias = process.env.ICCP_RCN_ALIAS || null;
  const templateId = process.env.ICCP_TEMPLATE_ID;
  const purchaseType = process.env.ICCP_PURCHASE_TYPE || "All MCCs";
  const timeZone = process.env.ICCP_DEFAULT_TIMEZONE || "Australia/Brisbane";

  const missingConfig = ["ICCP_COMPANY_ID", "ICCP_RCN_ID", "ICCP_TEMPLATE_ID"].filter((k) => !process.env[k]);
  if (missingConfig.length) {
    throw new Error(
      `Missing ICCP account configuration: ${missingConfig.join(", ")}. These identify RAA's own ICCP company/real ` +
        `card/purchase template — set them in .env (use iccpClient.getCompanies/getRealCards/getCompanyPurchaseTemplates ` +
        `to look up the real values against the sandbox).`
    );
  }

  const supplierId = await resolveBranchSupplierId(companyId, result.level1Branch);

  return {
    companyId,
    dataSourceId,
    rcnId,
    rcnAlias,
    description: `${result.bookingNo} ${result.supplier || ""}`.trim().slice(0, 80),
    validFor: monthsBetween(plan.startDate, plan.endDate),
    templateId,
    ruleName: `Booking ${result.bookingNo}`.slice(0, 100),
    velocityControl: {
      maxTrans: 0, // BR05 — 0 is documented to mean unlimited transactions
      cumulativeLimit: plan.cumulativeLimit,
      period: "C", // Continuous — matches maxTrans:0 per ICCP docs
      currencyType: "B", // billing currency of the real card (AUD)
    },
    validityPeriodControl: {
      from: plan.startDate,
      to: plan.endDate,
      timeZone,
    },
    customFields: [
      { name: "Purchase Type", value: purchaseType },
      { name: "Agent Initials", value: upper(byLabel["Agent Initials"]) },
      { name: "Store Code", value: upper(byLabel["Store Code"]) },
      { name: "Supplier Name", value: upper(byLabel["Supplier Name"]) },
      { name: "Supplier Reference", value: byLabel["Supplier Reference"] || "" },
      { name: "Tramada Booking Number", value: byLabel["Tramada Booking Number"] || "" },
      { name: "Member/Pax name", value: upper(byLabel["Member/Pax Name"]) },
      { name: "Segment Type", value: upper(byLabel["Segment Type"]) },
      { name: "Card Request Date", value: byLabel["Card Request Date"] || "" },
    ],
    supplierId,
    notifySupplier: true,
    disableCardImage: true,
  };
}

/**
 * @param result   the tramada-payment.js readPaymentBooking() output (flow "dvc")
 * @param plan     payment-views.js dvcPlanView(result, answers) output
 * @param confirm  must be exactly the literal string "CREATE CARD"
 * @param consultantEmail  who authorised it, for the audit trail
 * @param onRequestBuilt  optional (xml) => void, called with the exact SOAP
 *                 request body right before it is sent — lets a caller (e.g.
 *                 server.js) show the consultant the real outgoing request.
 */
async function issueCard({ result, plan, confirm, consultantEmail, onRequestBuilt }) {
  if (confirm !== "CREATE CARD") {
    throw new Error('Card issuance requires the exact confirmation "CREATE CARD" — refusing to proceed.');
  }
  if (plan.warnings && plan.warnings.some((w) => /missing from the tramada booking/i.test(w))) {
    throw new Error("Refusing to issue: required custom data fields are still missing (see the plan's warnings).");
  }

  const fields = await buildPurchaseRequestFields(result, plan);

  if (onRequestBuilt) {
    try {
      onRequestBuilt(iccpClient.buildSubmitPurchaseRequestXml(fields));
    } catch {
      // Display-only — never let a formatting problem block the real call.
    }
  }

  // Recorded BEFORE the API call so there is an audit trail even if the call
  // itself fails or times out.
  const record = paymentsStore.create({
    provider: "iccp-dvc",
    bookingNo: result.bookingNo,
    invoiceReference: result.segments?.map((s) => s.reference).find(Boolean) || null,
    supplierName: result.supplier,
    amount: result.total,
    cumulativeLimit: plan.cumulativeLimit,
    validFrom: plan.startDate,
    validTo: plan.endDate,
    consultantEmail,
  });

  paymentsStore.update(record.id, { status: "requesting" }, {
    event: "iccp_request_sent",
    detail: `submitPurchaseRequest — env=${iccpClient.environment()}, limit=$${plan.cumulativeLimit}`,
    actor: consultantEmail || "agent",
  });

  let created;
  try {
    created = await iccpClient.createDVC(fields, {
      idempotencyKey: `${result.bookingNo}:${result.supplier || ""}:${record.id}`,
    });
  } catch (err) {
    paymentsStore.update(record.id, { status: "failed" }, {
      event: "iccp_request_failed",
      detail: err.message,
      actor: "agent",
    });
    throw err;
  }

  const expiryDisplay = formatExpiry(created.expiry);

  paymentsStore.update(
    record.id,
    {
      status: "issued",
      purchaseRequestId: created.purchaseRequestId,
      vcnLast4: maskLast4(created.cardNumber),
      vcnExpiry: expiryDisplay,
    },
    {
      event: "iccp_card_issued",
      detail: `purchaseRequestId=${created.purchaseRequestId}, card ending ${maskLast4(created.cardNumber)}`,
      actor: consultantEmail || "agent",
    }
  );

  // The only place in this codebase the full number/CVV exist. Returned once;
  // the caller must display them and must not log or persist them further.
  return {
    paymentRecordId: record.id,
    purchaseRequestId: created.purchaseRequestId,
    cardNumber: created.cardNumber,
    expiry: expiryDisplay,
    cvv: created.cvv,
    environment: iccpClient.environment(),
  };
}

module.exports = { issueCard, buildPurchaseRequestFields, maskLast4, formatExpiry };
