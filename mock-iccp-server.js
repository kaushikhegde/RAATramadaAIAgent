/**
 * mock-iccp-server.js — a stand-in for Mastercard ICCP, spoken over real HTTP.
 * =============================================================================
 * Run this until the real ICCP sandbox has RAA's company/RCN/template/supplier
 * setup confirmed (per Mastercard: "Your Mastercard administrator performs
 * this setup ... you cannot make successful calls until this is complete").
 * Same reasoning as mock-mint-server.js: mocking at the network boundary
 * exercises OAuth 1.0a signing, SOAP envelopes and headers — the stuff that
 * actually breaks in an integration.
 *
 *   node mock-iccp-server.js          # listens on :4100
 *
 * Schema and the two-endpoint split (financial vs reporting) are verified
 * against Mastercard's published ICCP docs (see iccp-client.js's header
 * comment for the exact URLs) — this is not a guess. Seed data below (company,
 * RCN, template, suppliers, custom field names) is modelled on the real
 * "RAA – DVC Supplier Payments Template" as seen in an actual filled-in
 * Westpac Create Single Request screenshot, so the mock exercises the same
 * shape RAA's real sandbox should return.
 *
 * Routes by the request body's ROOT ELEMENT NAME (not by URL path beyond
 * /financial vs /reporting) — matching how the real gateway is documented to
 * work (operation identified by the SOAP body, no required SOAPAction).
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const PORT = Number(process.env.MOCK_ICCP_PORT || 4100);
const DB_FILE = process.env.MOCK_ICCP_DB || path.join(__dirname, "mock-iccp-db.json");
const REPLICATION_LAG_MS = Number(process.env.MOCK_ICCP_REPLICATION_LAG_MS ?? 5000);

const app = express();
app.use(express.text({ type: ["text/xml", "application/xml", "application/soap+xml"], limit: "1mb" }));

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false });

function readDb() {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    db = { purchaseRequests: {}, ...seed() };
  }
  // Tolerates a db file written before addenda/reports existed.
  db.addenda = db.addenda || {};
  db.reports = db.reports || {};
  return db;
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

/** Modelled on the real RAA sandbox project, as far as the screenshots showed. */
function seed() {
  return {
    company: { id: "427521", name: "RAA of South Australia", issuerName: "WESTPAC" },
    dataSource: { dataSourceId: "4272", dataSource: "300840201 Purchase Control 2.0 Custom Financial CF PURCHASE CONTROL 2.0" },
    realCards: [{ rcnId: "13800", rcnAlias: "Sandbox Card" }],
    templates: [{ templateId: "21680", templateName: "RAA - DVC Supplier Payments Template", templateDescription: "Used for RAA DVC supplier payments, with Velocity and Validity Period controls" }],
    suppliers: [
      { id: "14100", name: "RAA Marion", isICMP: false },
      { id: "14101", name: "RAA Walkerville", isICMP: false },
      { id: "14102", name: "RAA Mile End", isICMP: false },
    ],
    addenda: {}, // purchaseRequestId -> [{ id, invoiceNumber, currencyAmount, currencyCode, currencyExponent, currencySign, invoiceDate, poNumber }]
    reports: {}, // reportId -> { kind, status, readyAt, transactions }
  };
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}
function errorXml(errorCode, errorDescription) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:getPurchaseRequestDetail xmlns="http://mastercard.com/sd/pc/service" xmlns:ns2="http://mastercard.com/sd/pc2/service">
      <ns2:errorMessage>
        <ns2:errorCode>${escapeXml(errorCode)}</ns2:errorCode>
        <ns2:errorDescription>${escapeXml(errorDescription)}</ns2:errorDescription>
      </ns2:errorMessage>
    </ns2:getPurchaseRequestDetail>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/** A fake 16-digit PAN that does not collide with a real card-network test range. */
function fakeCardNumber(db) {
  let n;
  do {
    n = "9" + String(Math.floor(Math.random() * 1e14)).padStart(14, "0");
    n += luhnCheckDigit(n);
  } while (Object.values(db.purchaseRequests).some((p) => p.cardNumber === n));
  return n;
}
function luhnCheckDigit(numStr) {
  let sum = 0, alt = true;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let d = Number(numStr[i]);
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return String((10 - (sum % 10)) % 10);
}
function newPurchaseRequestId(db) {
  let id;
  do { id = String(Math.floor(1000000 + Math.random() * 9000000)); } while (db.purchaseRequests[id]);
  return id;
}

// Any Authorization header that looks OAuth-1.0a-shaped is accepted — the
// point is exercising the signing PATH, not Mastercard's own verification.
app.use((req, res, next) => {
  const auth = req.get("authorization") || "";
  if (!/^OAuth\s+oauth_consumer_key=/i.test(auth)) {
    return res.status(401).type("text/xml").send(errorXml("UNAUTHORIZED", "Missing or malformed OAuth 1.0a Authorization header"));
  }
  next();
});

function rootElementName(bodyXml) {
  const m = String(bodyXml || "").match(/<(?:[\w-]+:)?([A-Za-z][\w-]*)[ >]/);
  return m ? m[1] : null;
}

function handlerFor(path, bodyXml) {
  let parsed;
  try {
    parsed = xmlParser.parse(bodyXml);
  } catch {
    return null;
  }
  const body = parsed?.Envelope?.Body;
  if (!body) return null;
  const rootKey = Object.keys(body)[0];
  return { parsed, body: body[rootKey], rootKey };
}

app.post(["/financial", "/reporting"], (req, res) => {
  const bodyXml = req.body || "";
  const parsed = handlerFor(req.path, bodyXml);
  if (!parsed) return res.status(400).type("text/xml").send(errorXml("BAD_XML", "Could not parse request XML"));

  const { rootKey, body } = parsed;
  const handlers = {
    submitPurchaseRequestRequest: handleSubmitPurchaseRequest,
    getPurchaseRequestDetailRequest2: handleGetPurchaseRequestDetail,
    getDataSourcesRequest: handleGetDataSources,
    getCompaniesRequest: handleGetCompanies,
    getRealCardsRequest: handleGetRealCards,
    getCompanyPurchaseTemplatesRequest: handleGetCompanyPurchaseTemplates,
    getSuppliersRequest: handleGetSuppliers,
    addAddendaRequest: (req, res, b) => handleAddendaMutation(req, res, b, "add"),
    updateAddendaRequest: (req, res, b) => handleAddendaMutation(req, res, b, "update"),
    deleteAddendaRequest: handleDeleteAddenda,
    getAddendaRequest: handleGetAddenda,
    sendSupplierEmailRequest: handleSendSupplierEmail,
    CreateVCNAuthsReportRequest: (req, res, b) => handleCreateReport(req, res, b, "auths"),
    CreateVCNClearingsReportRequest: (req, res, b) => handleCreateReport(req, res, b, "clearings"),
    GetVCNAuthsReportRequest: (req, res, b) => handleGetReport(req, res, b, "auths"),
    GetVCNClearingsReportRequest: (req, res, b) => handleGetReport(req, res, b, "clearings"),
  };
  const handler = handlers[rootKey];
  if (!handler) return res.status(400).type("text/xml").send(errorXml("UNKNOWN_OPERATION", `Unknown request root element "${rootKey}"`));
  return handler(req, res, body);
});

function handleSubmitPurchaseRequest(req, res, body) {
  const inner = body?.SubmitPurchaseRequest || {};
  const db = readDb();
  const id = newPurchaseRequestId(db);
  const cardNumber = fakeCardNumber(db);
  const now = new Date();
  const expiry = String((now.getFullYear() + 2) % 100).padStart(2, "0") + String(now.getMonth() + 1).padStart(2, "0");

  const record = {
    purchaseRequestId: id,
    requestStatus: "Approved",
    createdAt: now.toISOString(),
    queryableAfter: new Date(now.getTime() + REPLICATION_LAG_MS).toISOString(),
    cardNumber,
    expiry,
    avv: String(Math.floor(100 + Math.random() * 900)),
    description: inner.description ?? null,
    cumulativeLimit: inner?.TemplateDetails2?.fullTemplateRuleDetails?.templateControl?.[0]?.cumulativeLimit ?? null,
  };
  db.purchaseRequests[id] = record;
  writeDb(db);

  console.log(`[mock-iccp] submitPurchaseRequest → ${id}, card ending ${cardNumber.slice(-4)}, expiry ${expiry}`);
  res.status(200).type("text/xml").send(purchaseRequestDetailXml(record));
}

function handleGetPurchaseRequestDetail(req, res, body) {
  const id = body?.purchaseRequestId;
  const db = readDb();
  const record = db.purchaseRequests[id];
  if (!record) return res.status(404).type("text/xml").send(errorXml("PRNF", `No purchase request ${id}`));
  if (new Date() < new Date(record.queryableAfter)) {
    return res.status(404).type("text/xml").send(errorXml("PR_NOT_READY", `Purchase request ${id} is not yet queryable (replication lag)`));
  }
  res.status(200).type("text/xml").send(purchaseRequestDetailXml(record));
}

function purchaseRequestDetailXml(record) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:getPurchaseRequestDetail xmlns="http://mastercard.com/sd/pc/service" xmlns:ns2="http://mastercard.com/sd/pc2/service">
      <ns2:purchaseRequestId>${record.purchaseRequestId}</ns2:purchaseRequestId>
      <ns2:requestStatus>${record.requestStatus}</ns2:requestStatus>
      <ns2:vcnInformation>
        <ns2:Pan>${record.cardNumber}</ns2:Pan>
        <ns2:Expiry>${record.expiry}</ns2:Expiry>
        <ns2:Avv>${record.avv}</ns2:Avv>
        <ns2:Status>S</ns2:Status>
        <ns2:EVCNIndicator>false</ns2:EVCNIndicator>
      </ns2:vcnInformation>
    </ns2:getPurchaseRequestDetail>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function handleGetDataSources(_req, res) {
  const { dataSource } = readDb();
  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getDataSourceResponse xmlns="http://mastercard.com/sd/pc/service">
      <dataSourceData>
        <dataSourceId>${dataSource.dataSourceId}</dataSourceId>
        <dataSource>${escapeXml(dataSource.dataSource)}</dataSource>
      </dataSourceData>
    </getDataSourceResponse>
  </soapenv:Body>
</soapenv:Envelope>`);
}

function handleGetCompanies(_req, res) {
  const { company } = readDb();
  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getCompaniesResponse xmlns="http://mastercard.com/sd/pc/service">
      <company><id>${company.id}</id><name>${escapeXml(company.name)}</name><issuerName>${escapeXml(company.issuerName)}</issuerName></company>
    </getCompaniesResponse>
  </soapenv:Body>
</soapenv:Envelope>`);
}

function handleGetRealCards(_req, res) {
  const { realCards } = readDb();
  const rows = realCards.map((r) => `<rcn><rcnId>${r.rcnId}</rcnId><rcnAlias>${escapeXml(r.rcnAlias)}</rcnAlias></rcn>`).join("\n");
  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getRealCardsResponse xmlns="http://mastercard.com/sd/pc/service">${rows}</getRealCardsResponse>
  </soapenv:Body>
</soapenv:Envelope>`);
}

function handleGetCompanyPurchaseTemplates(_req, res) {
  const { templates } = readDb();
  const rows = templates.map((t) => `<templates><templateId>${t.templateId}</templateId><templateName>${escapeXml(t.templateName)}</templateName><templateDescription>${escapeXml(t.templateDescription)}</templateDescription></templates>`).join("\n");
  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <getCompanyPurchaseTemplatesResponse xmlns="http://mastercard.com/sd/pc/service">${rows}</getCompanyPurchaseTemplatesResponse>
  </soapenv:Body>
</soapenv:Envelope>`);
}

function handleGetSuppliers(_req, res) {
  const { suppliers } = readDb();
  const rows = suppliers.map((s) => `<ns2:supplier><ns2:id>${s.id}</ns2:id><ns2:name>${escapeXml(s.name)}</ns2:name></ns2:supplier>`).join("\n");
  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:getSuppliersResponse xmlns="http://mastercard.com/sd/pc/service" xmlns:ns2="http://mastercard.com/sd/pc2/service">${rows}</ns2:getSuppliersResponse>
  </soapenv:Body>
</soapenv:Envelope>`);
}

/* ── Invoice Addenda ─────────────────────────────────────────────────── */

function newAddendaId() {
  return "0ADN" + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function parseInvoiceAddendumEntries(body) {
  const entries = body?.addendaData?.globalInvoiceRequest?.invoiceAddendum;
  return entries ? [].concat(entries) : [];
}

function addendaOperationResponseXml(purchaseRequestId, responseDescription, invoices) {
  const rows = invoices
    .map(
      (inv) => `<ns2:globalInvoiceAddendaResponse><ns2:globalInvoiceAddendumResponse>
        <Id>${inv.id}</Id>
        <InvoiceNumber>${escapeXml(inv.invoiceNumber)}</InvoiceNumber>
        ${inv.currencyAmount != null ? `<InvoiceCurrencyAmount CurrencySign="${inv.currencySign}" CurrencyExponent="${inv.currencyExponent}" CurrencyCode="${inv.currencyCode}">${inv.currencyAmount}</InvoiceCurrencyAmount>` : ""}
        ${inv.invoiceDate ? `<InvoiceDate>${inv.invoiceDate}</InvoiceDate>` : ""}
        ${inv.poNumber ? `<PONumber>${escapeXml(inv.poNumber)}</PONumber>` : ""}
      </ns2:globalInvoiceAddendumResponse></ns2:globalInvoiceAddendaResponse>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:addendaOperationResponse xmlns="http://mastercard.com/sd/pc/service" xmlns:ns2="http://mastercard.com/sd/pc2/service">
      <ns2:purchaseControlAddendaResponse>
        <ns2:purchaseRequestId>${purchaseRequestId}</ns2:purchaseRequestId>
        <ns2:responseDescription>${escapeXml(responseDescription)}</ns2:responseDescription>
        <ns2:addendaDataResponse><ns2:globalInvoiceResponse>${rows}</ns2:globalInvoiceResponse></ns2:addendaDataResponse>
      </ns2:purchaseControlAddendaResponse>
    </ns2:addendaOperationResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function handleAddendaMutation(req, res, body, mode) {
  const purchaseRequestId = body?.purchaseRequestId;
  const db = readDb();
  if (!db.purchaseRequests[purchaseRequestId]) {
    return res.status(404).type("text/xml").send(errorXml("PRNF", `No purchase request ${purchaseRequestId}`));
  }

  const incoming = parseInvoiceAddendumEntries(body);
  db.addenda[purchaseRequestId] = db.addenda[purchaseRequestId] || [];
  const stored = [];

  for (const entry of incoming) {
    const currencyAmount = entry.InvoiceCurrencyAmount?.["#text"] ?? entry.InvoiceCurrencyAmount ?? null;
    const record = {
      id: mode === "update" && entry.Id ? entry.Id : newAddendaId(),
      invoiceNumber: entry.InvoiceNumber,
      currencyAmount,
      currencyCode: entry.InvoiceCurrencyAmount?.["@_CurrencyCode"] ?? null,
      currencyExponent: entry.InvoiceCurrencyAmount?.["@_CurrencyExponent"] ?? null,
      currencySign: entry.InvoiceCurrencyAmount?.["@_CurrencySign"] ?? null,
      invoiceDate: entry.InvoiceDate ?? null,
      poNumber: entry.PONumber ?? null,
    };
    if (mode === "update") {
      const idx = db.addenda[purchaseRequestId].findIndex((r) => r.id === record.id);
      if (idx >= 0) db.addenda[purchaseRequestId][idx] = record;
      else db.addenda[purchaseRequestId].push(record);
    } else {
      db.addenda[purchaseRequestId].push(record);
    }
    stored.push(record);
  }
  writeDb(db);

  const verb = mode === "update" ? "Update" : "Add";
  console.log(`[mock-iccp] ${verb} Addenda → ${purchaseRequestId}, ${stored.length} record(s)`);
  res.status(200).type("text/xml").send(addendaOperationResponseXml(purchaseRequestId, `Request for ${verb} Addenda successfully created.`, stored));
}

function handleGetAddenda(req, res, body) {
  const purchaseRequestId = body?.purchaseRequestId;
  const db = readDb();
  const all = db.addenda[purchaseRequestId] || [];
  const fromIndex = body?.fromIndex != null ? Number(body.fromIndex) : 0;
  const toIndex = body?.toIndex != null ? Number(body.toIndex) : all.length - 1;
  const slice = all.slice(fromIndex, toIndex + 1);

  const xml = addendaOperationResponseXml(purchaseRequestId, "Request for Get Addenda successfully created.", slice).replace(
    "addendaOperationResponse",
    "getAddendaResponse"
  );
  // Splice in the count/index fields getAddendaResponse carries that the
  // shared operation-response shape does not.
  res
    .status(200)
    .type("text/xml")
    .send(xml.replace("</ns2:purchaseControlAddendaResponse>", `</ns2:purchaseControlAddendaResponse><ns2:totalAddendaCount>${all.length}</ns2:totalAddendaCount>`));
}

function handleDeleteAddenda(req, res, body) {
  const purchaseRequestId = body?.purchaseRequestId;
  const db = readDb();
  const existing = db.addenda[purchaseRequestId] || [];
  let deletedCount;

  if (body?.deleteAddendaSet === "Y") {
    deletedCount = existing.length;
    db.addenda[purchaseRequestId] = [];
  } else {
    const ids = [].concat(body?.addendaIds?.globalInvoiceIds?.id || []);
    deletedCount = existing.filter((r) => ids.includes(r.id)).length;
    db.addenda[purchaseRequestId] = existing.filter((r) => !ids.includes(r.id));
  }
  writeDb(db);

  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:addendaOperationResponse xmlns="http://mastercard.com/sd/pc/service" xmlns:ns2="http://mastercard.com/sd/pc2/service">
      <ns2:purchaseControlAddendaResponse>
        <ns2:purchaseRequestId>${purchaseRequestId}</ns2:purchaseRequestId>
        <ns2:responseDescription>The application successfully deleted ${deletedCount} addenda records for the purchase request ID ${purchaseRequestId}</ns2:responseDescription>
      </ns2:purchaseControlAddendaResponse>
    </ns2:addendaOperationResponse>
  </soapenv:Body>
</soapenv:Envelope>`);
}

function handleSendSupplierEmail(req, res, body) {
  const purchaseRequestId = body?.purchaseRequestId;
  const db = readDb();
  if (!db.purchaseRequests[purchaseRequestId]) {
    return res.status(404).type("text/xml").send(errorXml("PRNF", `No purchase request ${purchaseRequestId}`));
  }
  console.log(`[mock-iccp] sendSupplierEmail → ${purchaseRequestId}`);
  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <ns2:sendSupplierEmailResponse xmlns="http://mastercard.com/sd/pc/service" xmlns:ns2="http://mastercard.com/sd/pc2/service">
      <ns2:response>Supplier email successfully created.</ns2:response>
    </ns2:sendSupplierEmailResponse>
  </soapenv:Body>
</soapenv:Envelope>`);
}

/* ── VCN Reports ──────────────────────────────────────────────────────── */

function newReportId(db) {
  let id;
  do { id = String(Math.floor(1000 + Math.random() * 9000)); } while (db.reports[id]);
  return id;
}

/** Attribute-style request — parsed body carries values under `@_AttrName`. */
function attr(body, name) {
  return body?.[`@_${name}`];
}

function handleCreateReport(req, res, body, kind) {
  const db = readDb();
  const reportId = newReportId(db);

  // A couple of plausible fake transactions so getReport has something to
  // show once "ready" — reports are only interesting once a VCN this mock
  // created has actually been charged, which nothing here simulates, so
  // these are illustrative rather than tied to a real purchase request.
  const fakeTransactions =
    kind === "auths"
      ? [{ TxnType: "Authorization", MerchantName: "ROOM-RES", MerchantAmount: "246.75", MerchantCurrencyCode: "AUD", IssuerResponse: "Approved or completed successfully", TxnDateTime: "09-14 10:32:00" }]
      : [{ ClearingType: "Debit", MerchantName: "ROOM-RES", MerchantAmount: "246.75", MerchantCurrencyCode: "AUD", SettlementDate: new Date().toISOString().slice(0, 10) }];

  db.reports[reportId] = { kind, status: "Pending", readyAt: Date.now() + Number(process.env.MOCK_ICCP_REPORT_LAG_MS ?? 3000), transactions: fakeTransactions, pan: attr(body, "Pan") };
  writeDb(db);

  const operation = kind === "auths" ? "CreateVCNAuthsReportRequest" : "CreateVCNClearingsReportRequest";
  console.log(`[mock-iccp] ${operation} → report ${reportId} for PAN ending ${String(attr(body, "Pan") || "").slice(-4)}`);

  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <${operation}Response ReportId="${reportId}" xmlns="http://mastercard.com/sd/pc/service">
      <SystemMessage>Create VCN ${kind} report has been submitted.</SystemMessage>
    </${operation}Response>
  </soapenv:Body>
</soapenv:Envelope>`);
}

function handleGetReport(req, res, body, kind) {
  const reportId = attr(body, "ReportId");
  const db = readDb();
  const report = db.reports[reportId];
  if (!report) return res.status(404).type("text/xml").send(errorXml("RPNF", `No report ${reportId}`));

  const ready = Date.now() >= report.readyAt;
  if (ready && report.status === "Pending") {
    report.status = "Completed";
    writeDb(db);
  }

  const operation = kind === "auths" ? "GetVCNAuthsReportRequest" : "GetVCNClearingsReportRequest";
  const entryTag = kind === "auths" ? "AuthInfos" : "ClearingInfos";
  const from = attr(body, "From") ?? "0";
  const to = attr(body, "To") ?? "99";

  const rows =
    report.status === "Completed"
      ? report.transactions
          .map((t) => `<${entryTag} ${Object.entries(t).map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ")}/>`)
          .join("\n")
      : "";

  res.status(200).type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <${operation}Response HasMore="false" To="${to}" From="${from}" xmlns="http://mastercard.com/sd/pc/service">
      <ReportStatus>${report.status}</ReportStatus>
      ${rows}
    </${operation}Response>
  </soapenv:Body>
</soapenv:Envelope>`);
}

/** Wipe between test runs. */
app.post("/mock/reset", (_req, res) => {
  writeDb({ purchaseRequests: {}, ...seed() });
  console.log("[mock-iccp] reset");
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[mock-iccp] listening on http://localhost:${PORT}`);
  console.log(`[mock-iccp]   financial: http://localhost:${PORT}/financial`);
  console.log(`[mock-iccp]   reporting: http://localhost:${PORT}/reporting`);
  if (REPLICATION_LAG_MS) console.log(`[mock-iccp]   simulating ${REPLICATION_LAG_MS}ms query replication lag`);
});
