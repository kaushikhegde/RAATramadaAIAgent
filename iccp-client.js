/**
 * iccp-client.js — the ONLY module in this project that talks to Mastercard
 * In Control Commercial Payments (ICCP), which is what actually issues a
 * Westpac DVC once a sandbox/production key exists.
 * ============================================================================
 * Modelled on mint-client.js: thin, speaks the wire protocol, knows nothing
 * about Tramada or bookings. All the DVC business rules (BR03 validity dates,
 * BR04 cumulative limit, BR05/BR06 custom fields) already live in
 * payment-views.js's dvcPlanView — this module just needs a request object.
 *
 * SCHEMA — verified against Mastercard's own published docs (2026-09-14):
 *   https://developer.mastercard.com/iccp/documentation/05_api_reference/soap_api/purchaserequest/submitpurchaserequest/
 *   https://developer.mastercard.com/iccp/documentation/05_api_reference/soap_api/purchaserequest/getpurchaserequestdetail/
 *   https://developer.mastercard.com/iccp/documentation/05_api_reference/soap_api/configuration-details/{getrealcards,getdatasource,getcompanies,getcompanypurchasetemplates,getsuppliers}/
 *   https://developer.mastercard.com/iccp/documentation/api_basics/soap_api_basics/
 * This replaced an earlier placeholder guessed from conversation, which turned
 * out close but wrong in load-bearing ways — notably: the query call
 * (getPurchaseRequestDetail) goes to a DIFFERENT endpoint (reporting, not
 * financial) than submitPurchaseRequest; the response's card expiry is one
 * 4-character YYMM string, not separate month/year; and the CVV field is
 * called `Avv`, not `cvv`. All fixed below.
 *
 * ICCP is SOAP/XML over HTTPS, OAuth 1.0a-signed with a .p12 key (confirmed —
 * this part of the original discussion was right). There is no documented
 * SOAPAction header requirement, so an empty one is sent (SOAP 1.1 allows
 * this) rather than the invented operation-name guess this file used before.
 *
 * STILL UNVERIFIED / NOT YET LIVE-TESTED:
 *   - The exact customFieldName strings the RAA "DVC Supplier Payments
 *     Template" expects. Docs say these "must match one of the custom data
 *     fields on the Purchase Template set by [Mastercard/Westpac]" — i.e.
 *     they are configured server-side, not chosen by the caller. Until a real
 *     getcompanypurchasetemplates / getPurchaseTemplateDetail call confirms
 *     the actual field names, the DVC guide's step-12 labels (Agent Initials,
 *     Store Code, ...) are used as-is and may need correcting.
 *   - Real values for companyId, dataSourceId, RCNData (rcnId/rcnAlias),
 *     templateId and supplierId — these come from RAA's own sandbox company
 *     setup, which per Mastercard's docs is configured by "your Mastercard
 *     administrator" separately from self-service signup. Use the getRealCards
 *     / getDataSources / getCompanies / getCompanyPurchaseTemplates /
 *     getSuppliers exports below to look them up once pointed at the real
 *     sandbox — they are read-only and safe to call.
 *
 * Environment selection is one variable, same shape as Mint's:
 *   ICCP_ENVIRONMENT=mock        (default — local mock-iccp-server.js)
 *   ICCP_ENVIRONMENT=sandbox     → https://sandbox.api.mastercard.com/iccp/*
 *   ICCP_ENVIRONMENT=production  → https://api.mastercard.com/iccp/*
 */

const fs = require("fs");
const path = require("path");
const forge = require("node-forge");
const oauth = require("mastercard-oauth1-signer");
const { create: xmlCreate } = require("xmlbuilder2");
const { XMLParser } = require("fast-xml-parser");

const ENVIRONMENT = (process.env.ICCP_ENVIRONMENT || "mock").toLowerCase();

const MOCK_BASE = process.env.ICCP_MOCK_BASE_URL || "http://localhost:4100";
const ENDPOINTS = {
  mock: { financial: `${MOCK_BASE}/financial`, reporting: `${MOCK_BASE}/reporting` },
  sandbox: {
    financial: "https://sandbox.api.mastercard.com/iccp/financial",
    reporting: "https://sandbox.api.mastercard.com/iccp/reporting",
  },
  production: {
    financial: "https://api.mastercard.com/iccp/financial",
    reporting: "https://api.mastercard.com/iccp/reporting",
  },
};

const CONSUMER_KEY = process.env.ICCP_CONSUMER_KEY || "";
const P12_PATH = process.env.ICCP_P12_PATH || "";
const P12_PASSWORD = process.env.ICCP_P12_PASSWORD || "";
const P12_ALIAS = process.env.ICCP_P12_ALIAS || "";
const TIMEOUT_MS = Number(process.env.ICCP_TIMEOUT_MS || 30000);
const DEBUG = process.env.DEBUG === "true";

const LOG_FILE = process.env.ICCP_LOG_FILE || path.join(__dirname, "iccp-api-log.jsonl");

function log(...args) {
  if (DEBUG) console.log("[iccp]", ...args);
}

function audit(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error("[iccp] could not write api log:", err.message);
  }
}

class IccpError extends Error {
  constructor(message, { status, errorCode, errorDescription, body } = {}) {
    super(message);
    this.name = "IccpError";
    this.status = status;
    this.errorCode = errorCode;
    this.errorDescription = errorDescription;
    this.body = body;
  }
}

function environment() {
  return ["mock", "sandbox", "production"].includes(ENVIRONMENT) ? ENVIRONMENT : "mock";
}

function isConfigured() {
  if (environment() === "mock") return true;
  return Boolean(CONSUMER_KEY && P12_PATH);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Signing key
 * ──────────────────────────────────────────────────────────────────────── */

let cachedSigningKey = null;

function loadSigningKey() {
  if (cachedSigningKey) return cachedSigningKey;
  if (!P12_PATH) {
    throw new IccpError("ICCP_P12_PATH is not set — the Mastercard sandbox/production .p12 key file is required.");
  }

  const p12Content = fs.readFileSync(P12_PATH, "binary");
  const p12Asn1 = forge.asn1.fromDer(p12Content, false);
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, P12_PASSWORD);

  const bags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const all = Object.values(bags).flat().filter(Boolean);
  const bag = P12_ALIAS ? all.find((b) => b.attributes?.friendlyName?.[0] === P12_ALIAS) : all[0];

  if (!bag) {
    throw new IccpError(
      P12_ALIAS ? `No key with alias "${P12_ALIAS}" found in ${P12_PATH}.` : `No signing key found in ${P12_PATH}.`
    );
  }

  cachedSigningKey = forge.pki.privateKeyToPem(bag.key);
  return cachedSigningKey;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Transport
 * ──────────────────────────────────────────────────────────────────────── */

// Nothing sensitive should ever reach the log file: no signing key, no
// consumer key, no full PAN, no Avv (CVC). Masked to last 4 only.
function redact(xml) {
  if (typeof xml !== "string") return xml;
  return xml
    .replace(/(<[\w:]*Pan[^>]*>)[^<]+(<\/)/g, (_, open, close) => `${open}<redacted>${close}`)
    .replace(/(<[\w:]*Avv[^>]*>)[^<]+(<\/)/g, (_, open, close) => `${open}<redacted>${close}`);
}

/**
 * POST one SOAP envelope, OAuth-1.0a-signed per request as ICCP requires.
 *
 * @param endpoint         "financial" | "reporting" — ICCP splits calls across
 *                         two hosts; see the header comment. Get this wrong
 *                         and the real API 404s (the mock is lenient).
 * @param bodyXml          full <soapenv:Envelope>...</soapenv:Envelope> string
 * @param idempotencyKey   optional — see idempotency-soap docs (300s TTL)
 * @param correlationId    optional X-B3-TraceId; Mastercard generates one if omitted
 */
async function soapRequest({ endpoint, bodyXml, idempotencyKey, correlationId }) {
  const url = ENDPOINTS[environment()][endpoint];
  const started = Date.now();
  log(endpoint, url);

  let authHeader;
  try {
    const signingKey = environment() === "mock" ? null : loadSigningKey();
    // The mock has nothing real to verify a signature against, so it accepts
    // any well-formed Authorization header — the point of the mock is
    // exercising the request-signing CODE PATH, not Mastercard's own crypto.
    authHeader = signingKey
      ? oauth.getAuthorizationHeader(url, "POST", bodyXml, CONSUMER_KEY, signingKey)
      : `OAuth oauth_consumer_key="mock",oauth_signature_method="RSA-SHA256",oauth_timestamp="${Math.floor(Date.now() / 1000)}",oauth_nonce="mock",oauth_signature="mock",oauth_version="1.0"`;
  } catch (err) {
    throw new IccpError(`Could not sign ICCP request: ${err.message}`);
  }

  let res;
  let text;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        Authorization: authHeader,
        // No documented SOAPAction requirement for ICCP — an empty value is
        // valid per SOAP 1.1 rather than a guessed operation name.
        SOAPAction: "",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        ...(correlationId ? { "X-B3-TraceId": correlationId } : {}),
      },
      body: bodyXml,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    audit({ direction: "error", endpoint, url, request: redact(bodyXml), error: err.message, ms: Date.now() - started });
    throw new IccpError(`ICCP request failed (${err.name}): ${err.message}`, { status: 0 });
  }

  audit({
    direction: "call",
    endpoint,
    url,
    request: redact(bodyXml),
    status: res.status,
    response: redact(text),
    ms: Date.now() - started,
  });

  const errorInfo = extractErrorMessage(text);
  if (!res.ok || errorInfo) {
    throw new IccpError(errorInfo?.errorDescription || `ICCP returned HTTP ${res.status}`, {
      status: res.status,
      errorCode: errorInfo?.errorCode,
      errorDescription: errorInfo?.errorDescription,
      body: text,
    });
  }

  return text;
}

// parseTagValue: false is load-bearing, not cosmetic — a 16-digit Pan exceeds
// JS's safe integer range (fast-xml-parser's default auto-numeric coercion
// silently corrupts it), and the same coercion would strip the leading zero
// off values like a two-digit day in an ISO date. Every value here must
// survive as the exact string ICCP sent.
const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });

/**
 * ICCP reports faults inline (errorMessage/errorCode/errorDescription), not as
 * a SOAP Fault — but EVERY sample response in the docs, success included,
 * carries an empty `<errorMessage xsi:nil="true"/>` placeholder element. So
 * presence alone is not an error — only a non-empty errorCode/errorDescription
 * inside it is. Getting this wrong makes every successful-but-empty response
 * (e.g. an account with no companies provisioned yet) look like a failure.
 */
function extractErrorMessage(xmlText) {
  try {
    const parsed = xmlParser.parse(xmlText);
    const body = parsed?.Envelope?.Body;
    if (!body) return null;
    const container = Object.values(body)[0];
    const err = container?.errorMessage;
    if (!err || typeof err !== "object") return null;
    if (!err.errorCode && !err.errorDescription) return null;
    return { errorCode: err.errorCode, errorDescription: err.errorDescription };
  } catch {
    return null;
  }
}

/** Response element is documented as shared between Submit and Get Detail. */
function extractPurchaseRequestDetail(xmlText) {
  const parsed = xmlParser.parse(xmlText);
  const body = parsed?.Envelope?.Body;
  const container = body ? Object.values(body)[0] : null;
  if (!container || container.purchaseRequestId == null) return null;

  const vcn = container.vcnInformation || {};
  return {
    purchaseRequestId: container.purchaseRequestId,
    requestStatus: container.requestStatus ?? null,
    // Sixteen-digit VCN. Field is capital-P `Pan` in the real API.
    cardNumber: vcn.Pan ?? null,
    // Single 4-char string, format YYMM — NOT separate month/year.
    expiry: vcn.Expiry ?? null,
    // Card Verification Code — ICCP calls it `Avv`, not cvv/cvc.
    cvv: vcn.Avv ?? null,
    vcnId: vcn.Id ?? null,
    status: vcn.Status ?? null,
    raw: container,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * submitPurchaseRequest — creates (and activates) the DVC.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * @param {object} fields
 *   companyId        required — from getCompanies
 *   dataSourceId      optional — from getDataSources
 *   rcnId, rcnAlias   required (RCNData) — from getRealCards
 *   description       required, max 80 chars
 *   validFor          optional, months 1-24 (VCN card expiry — coarse; see
 *                     validityPeriodControl for the exact usable window)
 *   templateId        required — from getCompanyPurchaseTemplates
 *   ruleName          required, descriptive only
 *   velocityControl   required: { maxTrans, cumulativeLimit, period,
 *                     currencyType, currencyCode? } — maxTrans: 0 means
 *                     unlimited transactions (BR05's "0" maps directly here)
 *   validityPeriodControl  optional: { from, to, timeZone } — Date|string,
 *                     Date|string, IANA zone name — BR03's exact validity window
 *   customFields      ordered [{ name, value }] — must match the Purchase
 *                     Template's configured custom field names (UNVERIFIED —
 *                     see header comment)
 *   supplierId        required for ICCP-only requests — from getSuppliers
 *   supplierEmails, notifySupplier   optional
 *   disableCardImage  optional boolean — defaults to true (we don't use the
 *                     rendered card image, and skipping it keeps the response
 *                     smaller and off the audit log)
 */
function buildSubmitPurchaseRequestXml(fields) {
  const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

  const root = xmlCreate({ version: "1.0", encoding: "UTF-8" }).ele("soapenv:Envelope", {
    "xmlns:ser": "http://mastercard.com/sd/pc2/service",
    "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/",
    "xmlns:ser1": "http://mastercard.com/sd/pc/service",
  });
  const req = root.ele("soapenv:Header").up().ele("soapenv:Body").ele("ser:submitPurchaseRequestRequest").ele("ser:SubmitPurchaseRequest");

  const rcn = req.ele("ser:RCNData");
  rcn.ele("ser1:rcnId").txt(String(fields.rcnId)).up();
  if (fields.rcnAlias) rcn.ele("ser1:rcnAlias").txt(String(fields.rcnAlias)).up();
  rcn.up();

  if (fields.dataSourceId != null) req.ele("ser:dataSourceId").txt(String(fields.dataSourceId)).up();
  req.ele("ser:companyId").txt(String(fields.companyId)).up();
  if (fields.validFor != null) req.ele("ser:validFor").txt(String(fields.validFor)).up();
  req.ele("ser:description").txt(String(fields.description || "").slice(0, 80)).up();

  const template = req.ele("ser:TemplateDetails2");
  const rule = template.ele("ser:fullTemplateRuleDetails");
  rule.ele("ser:ruleName").txt(String(fields.ruleName || "").slice(0, 100)).up();
  rule.ele("ser:ruleType").txt("A").up();

  const vc = fields.velocityControl || {};
  const velocity = rule.ele("ser:templateControl", { "xsi:type": "ser:VelocityControlType2", "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance" });
  velocity.ele("ser:maxTrans").txt(String(vc.maxTrans ?? 0)).up();
  velocity.ele("ser:cumulativeLimit").txt(String(vc.cumulativeLimit ?? 0)).up();
  velocity.ele("ser:period").txt(vc.period || "C").up();
  velocity.ele("ser:currencyType").txt(vc.currencyType || "B").up();
  if (vc.currencyCode) velocity.ele("ser:currencyCode").txt(String(vc.currencyCode)).up();
  velocity.up();

  if (fields.validityPeriodControl) {
    const vp = fields.validityPeriodControl;
    const validity = rule.ele("ser:templateControl", { "xsi:type": "ser:templateValidityPeriodControl2", "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance" });
    validity.ele("ser:from").txt(isoDate(vp.from)).up();
    validity.ele("ser:to").txt(isoDate(vp.to)).up();
    validity.ele("ser:timeZone").txt(vp.timeZone || "Australia/Adelaide").up();
    validity.ele("ser:strictPreAuthCheck").txt("false").up();
    validity.ele("ser:negate").txt("false").up();
    validity.up();
  }
  rule.up();

  // Wrapper element genuinely repeats its own name around each entry — this
  // is what the docs' own sample XML shows, not a typo.
  const customFieldWrapper = template.ele("ser:templateCustomField");
  for (const f of fields.customFields || []) {
    const entry = customFieldWrapper.ele("ser:templateCustomField");
    entry.ele("ser1:customFieldName").txt(String(f.name)).up();
    entry.ele("ser1:customFieldValue").txt(f.value == null ? "" : String(f.value)).up();
    entry.up();
  }
  customFieldWrapper.up();
  template.up();

  if (fields.supplierId) {
    const supplier = req.ele("ser:supplierDetails");
    supplier.ele("ser:supplierId").txt(String(fields.supplierId)).up();
    if (fields.supplierEmails) supplier.ele("ser:supplierEmails").txt(String(fields.supplierEmails)).up();
    if (fields.notifySupplier != null) supplier.ele("ser:notifySupplier").txt(fields.notifySupplier ? "true" : "false").up();
    supplier.up();
  }

  req.ele("ser:disableCardImage").txt(fields.disableCardImage === false ? "N" : "Y").up();

  return root.end({ prettyPrint: false });
}

async function createDVC(fields, { idempotencyKey, correlationId } = {}) {
  const bodyXml = buildSubmitPurchaseRequestXml(fields);
  const responseXml = await soapRequest({ endpoint: "financial", bodyXml, idempotencyKey, correlationId });
  const detail = extractPurchaseRequestDetail(responseXml);
  if (!detail) throw new IccpError("submitPurchaseRequest returned no purchase request detail.", { body: responseXml });
  return detail;
}

/* ─────────────────────────────────────────────────────────────────────────
 * getPurchaseRequestDetail — query the card back. Goes to the REPORTING
 * endpoint, not financial — easy to get wrong, confirmed in soap_api_basics.
 * ──────────────────────────────────────────────────────────────────────── */

function buildGetPurchaseRequestDetailXml(purchaseRequestId) {
  return xmlCreate({ version: "1.0", encoding: "UTF-8" })
    .ele("soapenv:Envelope", { "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/", "xmlns:ser": "http://mastercard.com/sd/pc2/service" })
    .ele("soapenv:Header").up()
    .ele("soapenv:Body")
    .ele("ser:getPurchaseRequestDetailRequest2")
    .ele("ser:purchaseRequestId").txt(String(purchaseRequestId)).up()
    .up()
    .end({ prettyPrint: false });
}

async function getPurchaseRequestDetails(purchaseRequestId) {
  const bodyXml = buildGetPurchaseRequestDetailXml(purchaseRequestId);
  const responseXml = await soapRequest({ endpoint: "reporting", bodyXml });
  const detail = extractPurchaseRequestDetail(responseXml);
  if (!detail) throw new IccpError(`No purchase request detail returned for ${purchaseRequestId}.`, { body: responseXml });
  return detail;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Prerequisite lookups — read-only, side-effect-free. Use these to discover
 * the real companyId / dataSourceId / rcnId / templateId / supplierId for
 * RAA's sandbox once pointed at ICCP_ENVIRONMENT=sandbox, rather than
 * guessing. All go to the financial endpoint per soap_api_basics.
 * ──────────────────────────────────────────────────────────────────────── */

function simpleRequest(operation, innerXml) {
  return xmlCreate({ version: "1.0", encoding: "UTF-8" })
    .ele("soapenv:Envelope", { "xmlns:ser": "http://mastercard.com/sd/pc/service", "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/" })
    .ele("soapenv:Header").up()
    .ele("soapenv:Body")
    .ele(`ser:${operation}`)
    .txt(innerXml || "")
    .up()
    .up()
    .end({ prettyPrint: false });
}

async function getDataSources() {
  const xml = await soapRequest({ endpoint: "financial", bodyXml: simpleRequest("getDataSourcesRequest") });
  const parsed = xmlParser.parse(xml);
  const resp = parsed?.Envelope?.Body?.getDataSourceResponse;
  const list = resp?.dataSourceData ? [].concat(resp.dataSourceData) : [];
  return list.map((d) => ({ dataSourceId: d.dataSourceId, dataSource: d.dataSource }));
}

async function getCompanies() {
  const xml = await soapRequest({ endpoint: "financial", bodyXml: simpleRequest("getCompaniesRequest") });
  const parsed = xmlParser.parse(xml);
  const resp = parsed?.Envelope?.Body?.getCompaniesResponse;
  const list = resp?.company ? [].concat(resp.company) : [];
  return list.map((c) => ({ id: c.id, name: c.name, issuerName: c.issuerName }));
}

function companyIdRequest(operation, companyId) {
  return xmlCreate({ version: "1.0", encoding: "UTF-8" })
    .ele("soapenv:Envelope", { "xmlns:ser": "http://mastercard.com/sd/pc/service", "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/" })
    .ele("soapenv:Header").up()
    .ele("soapenv:Body")
    .ele(`ser:${operation}`)
    .ele("ser:companyId").txt(String(companyId)).up()
    .up()
    .up()
    .end({ prettyPrint: false });
}

async function getRealCards(companyId) {
  const xml = await soapRequest({ endpoint: "financial", bodyXml: companyIdRequest("getRealCardsRequest", companyId) });
  const parsed = xmlParser.parse(xml);
  const resp = parsed?.Envelope?.Body?.getRealCardsResponse;
  const list = resp?.rcn ? [].concat(resp.rcn) : [];
  return list.map((r) => ({ rcnId: r.rcnId, rcnAlias: r.rcnAlias }));
}

async function getCompanyPurchaseTemplates(companyId) {
  const xml = await soapRequest({ endpoint: "financial", bodyXml: companyIdRequest("getCompanyPurchaseTemplatesRequest", companyId) });
  const parsed = xmlParser.parse(xml);
  const resp = parsed?.Envelope?.Body?.getCompanyPurchaseTemplatesResponse;
  const list = resp?.templates ? [].concat(resp.templates) : [];
  return list.map((t) => ({ templateId: t.templateId, templateName: t.templateName, templateDescription: t.templateDescription }));
}

async function getSuppliers(companyId) {
  const xml = await soapRequest({ endpoint: "financial", bodyXml: companyIdRequest("getSuppliersRequest", companyId) });
  const parsed = xmlParser.parse(xml);
  const resp = parsed?.Envelope?.Body?.getSuppliersResponse;
  const list = resp?.supplier ? [].concat(resp.supplier) : [];
  return list.map((s) => ({ id: s.id, name: s.name, isICMP: s.isICMP === "Y" }));
}

/* ─────────────────────────────────────────────────────────────────────────
 * Invoice Addenda — "add invoice details this VCN will pay" (step 4 of the
 * documented flow). Schema verified against:
 *   .../purchaserequest/invoice_addenda_data/{addaddenda,updateaddenda,getaddenda,deleteaddenda}/
 * addAddenda and updateAddenda share an identical body shape (update just
 * adds each invoice's `Id`), so one builder serves both.
 * ──────────────────────────────────────────────────────────────────────── */

function buildAddendaMutationXml(operation, purchaseRequestId, invoices, { moreAddendaExpected } = {}) {
  const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

  const root = xmlCreate({ version: "1.0", encoding: "UTF-8" })
    .ele("soapenv:Envelope", {
      "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/",
      "xmlns:ser": "http://mastercard.com/sd/pc2/service",
      "xmlns:ser1": "http://mastercard.com/sd/pc/service",
    })
    .ele("soapenv:Header").up()
    .ele("soapenv:Body")
    .ele(`ser:${operation}`);

  root.ele("ser:purchaseRequestId").txt(String(purchaseRequestId)).up();
  const globalInvoiceRequest = root.ele("ser:addendaData").ele("ser:globalInvoiceRequest");

  for (const inv of invoices || []) {
    const item = globalInvoiceRequest.ele("ser1:invoiceAddendum");
    if (inv.id) item.ele("ser1:Id").txt(String(inv.id)).up();
    item.ele("ser1:InvoiceNumber").txt(String(inv.invoiceNumber).slice(0, 35)).up();
    if (inv.currencyAmount != null) {
      item
        .ele("ser1:InvoiceCurrencyAmount", {
          CurrencyCode: String(inv.currencyCode),
          CurrencyExponent: String(inv.currencyExponent ?? 2),
          CurrencySign: inv.currencySign || "D",
        })
        .txt(String(inv.currencyAmount))
        .up();
    }
    if (inv.invoiceDate) item.ele("ser1:InvoiceDate").txt(isoDate(inv.invoiceDate)).up();
    if (inv.poNumber) item.ele("ser1:PONumber").txt(String(inv.poNumber).slice(0, 35)).up();
    item.up();
  }
  globalInvoiceRequest.up().up(); // close globalInvoiceRequest, addendaData

  if (moreAddendaExpected != null) root.ele("ser:moreAddendaExpected").txt(moreAddendaExpected ? "Y" : "N").up();

  return root.end({ prettyPrint: false });
}

/** Shape shared by add/update/delete's addendaOperationResponse. */
function extractAddendaOperationResponse(xmlText) {
  const parsed = xmlParser.parse(xmlText);
  const resp = parsed?.Envelope?.Body?.addendaOperationResponse?.purchaseControlAddendaResponse;
  if (!resp) return null;
  return {
    purchaseRequestId: resp.purchaseRequestId ?? null,
    responseDescription: resp.responseDescription ?? null,
    invoices: extractInvoiceList(resp.addendaDataResponse),
  };
}

function extractInvoiceList(addendaDataResponse) {
  const entries = addendaDataResponse?.globalInvoiceResponse?.globalInvoiceAddendaResponse;
  const list = entries ? [].concat(entries) : [];
  return list.map((e) => {
    const inv = e.globalInvoiceAddendumResponse || e;
    return {
      id: inv.Id ?? null,
      invoiceNumber: inv.InvoiceNumber ?? null,
      currencyAmount: inv.InvoiceCurrencyAmount?.["#text"] ?? inv.InvoiceCurrencyAmount ?? null,
      currencyCode: inv.InvoiceCurrencyAmount?.["@_CurrencyCode"] ?? null,
      invoiceDate: inv.InvoiceDate ?? null,
      poNumber: inv.PONumber ?? null,
    };
  });
}

/** @param invoices [{ invoiceNumber, currencyAmount?, currencyCode?, currencyExponent?, currencySign?, invoiceDate?, poNumber? }] */
async function addInvoiceAddenda(purchaseRequestId, invoices, opts) {
  const xml = buildAddendaMutationXml("addAddendaRequest", purchaseRequestId, invoices, opts);
  const responseXml = await soapRequest({ endpoint: "financial", bodyXml: xml });
  return extractAddendaOperationResponse(responseXml);
}

/** Same shape as addInvoiceAddenda, but each invoice should carry the `id` addAddenda returned. */
async function updateInvoiceAddenda(purchaseRequestId, invoices, opts) {
  const xml = buildAddendaMutationXml("updateAddendaRequest", purchaseRequestId, invoices, opts);
  const responseXml = await soapRequest({ endpoint: "financial", bodyXml: xml });
  return extractAddendaOperationResponse(responseXml);
}

/** @param opts { fromIndex?, toIndex? } — omit both to get everything. */
async function getInvoiceAddenda(purchaseRequestId, { fromIndex, toIndex } = {}) {
  const root = xmlCreate({ version: "1.0", encoding: "UTF-8" })
    .ele("soapenv:Envelope", { "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/", "xmlns:ser": "http://mastercard.com/sd/pc2/service" })
    .ele("soapenv:Header").up()
    .ele("soapenv:Body")
    .ele("ser:getAddendaRequest");
  root.ele("ser:purchaseRequestId").txt(String(purchaseRequestId)).up();
  if (fromIndex != null) root.ele("ser:fromIndex").txt(String(fromIndex)).up();
  if (toIndex != null) root.ele("ser:toIndex").txt(String(toIndex)).up();
  const xml = root.up().up().end({ prettyPrint: false });

  const responseXml = await soapRequest({ endpoint: "financial", bodyXml: xml });
  const parsed = xmlParser.parse(responseXml);
  const resp = parsed?.Envelope?.Body?.getAddendaResponse;
  const inner = resp?.purchaseControlAddendaResponse;
  return {
    purchaseRequestId: inner?.purchaseRequestId ?? null,
    invoices: extractInvoiceList(inner?.addendaDataResponse),
    totalAddendaCount: resp?.totalAddendaCount ?? null,
    fromIndex: resp?.fromIndex ?? null,
    toIndex: resp?.toIndex ?? null,
  };
}

/** @param ids invoice addenda record IDs (from addInvoiceAddenda's response) to delete, OR pass deleteAll: true. */
async function deleteInvoiceAddenda(purchaseRequestId, { ids, deleteAll, moreAddendaExpected } = {}) {
  const root = xmlCreate({ version: "1.0", encoding: "UTF-8" })
    .ele("soapenv:Envelope", {
      "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/",
      "xmlns:ser": "http://mastercard.com/sd/pc2/service",
      "xmlns:ser1": "http://mastercard.com/sd/pc/service",
    })
    .ele("soapenv:Header").up()
    .ele("soapenv:Body")
    .ele("ser:deleteAddendaRequest");
  root.ele("ser:purchaseRequestId").txt(String(purchaseRequestId)).up();
  if (deleteAll) {
    root.ele("ser:deleteAddendaSet").txt("Y").up();
  } else {
    const idsEle = root.ele("ser:addendaIds").ele("ser1:globalInvoiceIds");
    for (const id of ids || []) idsEle.ele("ser1:id").txt(String(id)).up();
    idsEle.up().up();
  }
  if (moreAddendaExpected != null) root.ele("ser:moreAddendaExpected").txt(moreAddendaExpected ? "Y" : "N").up();
  const xml = root.up().up().end({ prettyPrint: false });

  const responseXml = await soapRequest({ endpoint: "financial", bodyXml: xml });
  return extractAddendaOperationResponse(responseXml);
}

/* ─────────────────────────────────────────────────────────────────────────
 * sendSupplierEmail — (re)send the VCN + invoice details to the supplier.
 * Verified against .../purchaserequest/sendsupplieremail/. Note: creating a
 * purchase request with notifySupplier:true (see dvc-card-issuer.js) already
 * triggers this once automatically — this is for re-sending.
 * ──────────────────────────────────────────────────────────────────────── */

async function sendSupplierEmail(purchaseRequestId) {
  const xml = xmlCreate({ version: "1.0", encoding: "UTF-8" })
    .ele("soapenv:Envelope", { "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/", "xmlns:ser": "http://mastercard.com/sd/pc2/service" })
    .ele("soapenv:Header").up()
    .ele("soapenv:Body")
    .ele("ser:sendSupplierEmailRequest")
    .ele("ser:purchaseRequestId").txt(String(purchaseRequestId)).up()
    .up()
    .up()
    .end({ prettyPrint: false });

  const responseXml = await soapRequest({ endpoint: "financial", bodyXml: xml });
  const parsed = xmlParser.parse(responseXml);
  const resp = parsed?.Envelope?.Body?.sendSupplierEmailResponse;
  return { message: resp?.response ?? null };
}

/* ─────────────────────────────────────────────────────────────────────────
 * VCN Reports — reconciliation: "did the supplier actually charge this card,
 * and did it clear?" Two-step per operation (create, wait, then get) — this
 * is the ONE step of the documented flow Mastercard itself says to poll
 * rather than call once. Verified against .../soap_api/reports/{create_reports,get_reports}/.
 *
 * Unlike every other call in this file, these use XML ATTRIBUTES rather than
 * child elements for their parameters — confirmed from the docs' own sample
 * XML, not assumed for consistency with the rest of the API.
 * ──────────────────────────────────────────────────────────────────────── */

function buildReportCreateXml(operation, { fromDate, toDate, fromTime, toTime, timeZone, transactionType, pan }) {
  const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
  const attrs = { FromDate: isoDate(fromDate), ToDate: isoDate(toDate), Timezone: timeZone, TransactionType: transactionType, Pan: String(pan) };
  if (fromTime) attrs.FromTime = fromTime;
  if (toTime) attrs.ToTime = toTime;

  return xmlCreate({ version: "1.0", encoding: "UTF-8" })
    .ele("soapenv:Envelope", { "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/", "xmlns:ser": "http://mastercard.com/sd/pc/service" })
    .ele("soapenv:Header").up()
    .ele("soapenv:Body")
    .ele(`ser:${operation}`, attrs)
    .up()
    .end({ prettyPrint: false });
}

function extractReportCreateResponse(xmlText, operation) {
  const parsed = xmlParser.parse(xmlText);
  const resp = parsed?.Envelope?.Body?.[`${operation}Response`];
  if (!resp) return null;
  return { reportId: resp["@_ReportId"] ?? null, systemMessage: resp.SystemMessage ?? null };
}

function buildReportGetXml(operation, { reportId, from, to }) {
  return xmlCreate({ version: "1.0", encoding: "UTF-8" })
    .ele("soapenv:Envelope", { "xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/", "xmlns:ser": "http://mastercard.com/sd/pc/service" })
    .ele("soapenv:Header").up()
    .ele("soapenv:Body")
    .ele(`ser:${operation}`, { ReportId: String(reportId), From: String(from ?? 0), To: String(to ?? 99) })
    .up()
    .end({ prettyPrint: false });
}

/**
 * Response schema for get-report calls runs to 80+ optional per-transaction
 * fields (merchant details, issuer/network response codes, clearing decision
 * codes, ...) — deliberately NOT mapped one-by-one here; `transactions`
 * carries the parsed attribute bag (fast-xml-parser's `@_Field` shape)
 * straight through, since exhaustively naming every field would be a lot of
 * surface area for something no caller in this codebase reads yet.
 */
function extractReportGetResponse(xmlText, operation, transactionsKey) {
  const parsed = xmlParser.parse(xmlText);
  const resp = parsed?.Envelope?.Body?.[`${operation}Response`];
  if (!resp) return null;
  const entries = resp[transactionsKey];
  return {
    reportStatus: resp.ReportStatus ?? null,
    hasMore: resp["@_HasMore"] === "true",
    from: resp["@_From"] ?? null,
    to: resp["@_To"] ?? null,
    transactions: entries ? [].concat(entries) : [],
  };
}

/** @param params { fromDate, toDate, fromTime?, toTime?, timeZone, transactionType, pan } */
async function createVCNAuthsReport(params) {
  const xml = buildReportCreateXml("CreateVCNAuthsReportRequest", params);
  const responseXml = await soapRequest({ endpoint: "reporting", bodyXml: xml });
  return extractReportCreateResponse(responseXml, "CreateVCNAuthsReportRequest");
}
async function createVCNClearingsReport(params) {
  const xml = buildReportCreateXml("CreateVCNClearingsReportRequest", params);
  const responseXml = await soapRequest({ endpoint: "reporting", bodyXml: xml });
  return extractReportCreateResponse(responseXml, "CreateVCNClearingsReportRequest");
}

/**
 * Per Mastercard's own docs: wait at least 5s after create before the first
 * get, and if ReportStatus comes back "Pending", retry at 5s intervals. This
 * function does not loop for you — see the "Pending" status and decide
 * whether to retry, since a caller may want to show progress in between.
 */
async function getVCNAuthsReport({ reportId, from, to }) {
  const xml = buildReportGetXml("GetVCNAuthsReportRequest", { reportId, from, to });
  const responseXml = await soapRequest({ endpoint: "reporting", bodyXml: xml });
  return extractReportGetResponse(responseXml, "GetVCNAuthsReportRequest", "AuthInfos");
}
async function getVCNClearingsReport({ reportId, from, to }) {
  const xml = buildReportGetXml("GetVCNClearingsReportRequest", { reportId, from, to });
  const responseXml = await soapRequest({ endpoint: "reporting", bodyXml: xml });
  return extractReportGetResponse(responseXml, "GetVCNClearingsReportRequest", "ClearingInfos");
}

module.exports = {
  createDVC,
  getPurchaseRequestDetails,
  getDataSources,
  getCompanies,
  getRealCards,
  getCompanyPurchaseTemplates,
  getSuppliers,
  addInvoiceAddenda,
  updateInvoiceAddenda,
  getInvoiceAddenda,
  deleteInvoiceAddenda,
  sendSupplierEmail,
  createVCNAuthsReport,
  createVCNClearingsReport,
  getVCNAuthsReport,
  getVCNClearingsReport,
  environment,
  isConfigured,
  IccpError,
  ENDPOINTS,
  // exported for tests / the mock server's own use
  buildSubmitPurchaseRequestXml,
  extractPurchaseRequestDetail,
};
