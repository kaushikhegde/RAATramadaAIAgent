/**
 * pdf-itinerary.js — parse an RAA Travel itinerary/costing confirmation PDF into
 * the structured data the Tramada PDF pipeline consumes.
 *
 * Targets the text that `pdf-parse` (pdf.js) produces for these RAA PDFs, which is
 * quirky: on page 1 labels are glued to values ("Tour Company:Tour East Bali",
 * "VIVR234951Booking Reference:"), and on the page-2 costing table the four money
 * columns are concatenated with NO separators ("InsuranceTokio Marine221.720.000.00221.72"
 * = Tokio Marine + 221.72 + 0.00 + 0.00 + 221.72). The BPAY ref prints as
 * "00127522Ref:" (value before the label). Extraction below is written around that.
 *
 * IMPORTANT — the creditor (who Tramada pays) is NOT reliably in the PDF. The doc
 * carries product/supplier names ("Tour East Bali", "Novotel Bali", "Tokio
 * Marine"). Per the agreed flow we type that supplier name into Tramada's creditor
 * autocomplete and only ask the user when there's no match. Each parsed
 * segment/line exposes `supplierName` (from the doc) and an empty `creditor`
 * (override) the caller/user can fill.
 *
 *   const { parseRaaItineraryBuffer } = require("./pdf-itinerary");
 *   const data = await parseRaaItineraryBuffer(pdfBuffer);
 *
 * Self-test:  node pdf-itinerary.js /path/to/file.pdf     (or a .txt of the text)
 */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// "22 Aug 26" / "Sat 22 Aug 26" / "22 Aug 2026" -> "2026-08-22". null if unparseable.
function toIsoDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{2,4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  let yr = parseInt(m[3], 10);
  if (m[3].length === 2) yr += 2000;
  if (!mon) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${yr}-${p(mon)}-${p(day)}`;
}

// First / all / last decimal-money value(s) in a string.
// allMoney("221.720.000.00221.72") -> [221.72, 0.00, 0.00, 221.72]  (handles the
// concatenated page-2 columns), so lastMoney(...) is always the AUD Total.
function allMoney(s) {
  return (String(s == null ? "" : s).match(/\d[\d,]*\.\d{2}/g) || []).map((x) => parseFloat(x.replace(/,/g, "")));
}
function money(s) {
  const a = allMoney(s);
  return a.length ? a[0] : null;
}
function lastMoney(s) {
  const a = allMoney(s);
  return a.length ? a[a.length - 1] : null;
}

// BPAY "Ref:" value, e.g. "00127522". pdf-parse prints it BEFORE the label
// ("00127522Ref:"); pdftotext prints it after ("Ref:\n00127522"). Handle both.
function extractBpayRef(raw) {
  // pdf-parse: value glued before the label ("00127522Ref:") — must be adjacent
  // (a bare space is fine) so we don't grab the Biller Code on the line above.
  let m = raw.match(/(\d{6,}) ?Ref:/);
  if (m) return m[1];
  // pdftotext: value on the line after ("Ref:\n00127522").
  m = raw.match(/Ref:\s*\n?\s*(\d{6,})/i);
  return m ? m[1] : null;
}

// BPAY ref -> Tramada booking number: zero-padded booking no + trailing check
// digit. "00127522" -> strip leading zeros ("127522") -> drop check digit -> "12752".
function bpayRefToBookingNo(ref) {
  if (!ref) return null;
  const stripped = String(ref).replace(/^0+/, "");
  return stripped.length > 1 ? stripped.slice(0, -1) : stripped;
}

// A "Date: A/B" pair that follows an anchor within `window` chars → [isoA, isoB].
function dateRangeAfter(raw, anchorRe, window = 200) {
  const m = raw.match(anchorRe);
  if (!m) return [null, null];
  const from = m.index + m[0].length;
  const slice = raw.slice(from, from + window);
  const dm = slice.match(/Date:\s*([\d]{1,2}\s+[A-Za-z]{3}\s+\d{2,4})\s*\/\s*([\d]{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/);
  if (!dm) return [null, null];
  return [toIsoDate(dm[1]), toIsoDate(dm[2])];
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Grand total (AUD incl GST). "Total Booking Cost Inc Pay Direct0.471056.93" and
// "Due0.000.471056.93" both end in the total; take the last decimal of that run.
function extractGrandTotal(raw) {
  let m = raw.match(/Total Booking Cost[^\n]*?([\d.,]+)\s*(?:\n|$)/);
  if (m) { const v = lastMoney(m[1]); if (v) return v; }
  m = raw.match(/\bDue([\d.,]+)/);
  if (m) { const v = lastMoney(m[1]); if (v) return v; }
  m = raw.match(/Deposits\/Paid\s*\n\s*([\d,]+\.\d{2})/i);
  if (m) return money(m[1]);
  return null;
}

/**
 * Parse the plain text of an RAA itinerary/costing PDF (pdf-parse output).
 */
function parseRaaItineraryText(text) {
  const raw = String(text || "").replace(/\r/g, "");
  const lines = raw.split("\n").map((l) => l.trim());
  const warnings = [];

  /* ── booking number (BPAY Ref is authoritative; cross-check printed B#####) ── */
  const bpayRef = extractBpayRef(raw);
  const fromBpay = bpayRefToBookingNo(bpayRef);
  const bMatch = raw.match(/\bB(\d{4,7})\b/);
  const fromB = bMatch ? bMatch[1] : null;
  const bookingNo = fromBpay || fromB;
  if (fromBpay && fromB && fromBpay !== fromB) {
    warnings.push(`Booking number mismatch: BPAY ref gives ${fromBpay} but doc shows B${fromB}.`);
  }
  if (!bookingNo) warnings.push("Could not determine a booking number (no BPAY Ref and no B##### on the doc).");

  /* ── passengers ─────────────────────────────────────────────────────── */
  const paxRe = /^[A-Z][A-Z'’\-]+\/[A-Z][A-Z'’ \-]+\s+(MR|MRS|MS|DR|MISS|MSTR|MASTER|PROF)$/;
  const passengers = [...new Set(lines.filter((l) => paxRe.test(l)))];

  let consultant = (raw.match(/PNR Reference:\s*\n([A-Z][a-z]+ [A-Z][a-z]+)/) ||
    raw.match(/Consultant:\s*\n?\s*([A-Z][a-z]+ [A-Z][a-z]+)/) || [])[1] || "";
  if (/Booking|Number|Reference|Date|Debtor|Return|Depart/i.test(consultant)) consultant = "";
  const debtor = (raw.match(/(RAA of SA Limited[^\n]*)/) || [])[1] || "";

  // Booking references (page 1: "VIVR234951Booking Reference:", "MG752045Booking Reference:").
  const refMatches = [...raw.matchAll(/([A-Z0-9]{4,})\s*Booking Reference:/g)].map((m) => m[1]);
  const tourRef = refMatches.find((r) => /^VIV/i.test(r)) || (raw.match(/\b(VIV[A-Z]?\d{4,})\b/) || [])[1] || null;
  const hotelRef = refMatches.find((r) => /^MG/i.test(r)) || (raw.match(/\b(MG\d{5,})\b/) || [])[1] || null;

  // A "CITY, COUNTRY" line gives the segment city (e.g. "DENPASAR BALI, INDONESIA").
  const cityGuess =
    (raw.match(/\b([A-Z][A-Z]+(?: [A-Z]+)*),\s*[A-Z][A-Za-z]/) || [])[1] ||
    (raw.match(/\n([A-Z][A-Z ]+?)-\s*\1/) || [])[1] || "";

  /* ── segments: Tour + Hotel (page 1 label:value) ────────────────────── */
  const segments = [];

  const tourName = ((raw.match(/Tour Company:\s*([^\n]+)/) || [])[1] || "").trim();
  const tourType = ((raw.match(/Type:\s*([^\n]+)/) || [])[1] || "").trim();
  const tourStart = toIsoDate((raw.match(/Start Date:\s*([A-Za-z]{3}\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/) || [])[1]);
  const tourFinish = toIsoDate((raw.match(/Finish Date:\s*([A-Za-z]{3}\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/) || [])[1]);
  const tourRate = money((raw.match(/AUD\s*[\d,.]+\s*Per Day/i) || [])[0]);
  if (tourName || tourRef) {
    segments.push({
      kind: "tour",
      supplierName: tourName,
      creditor: "",
      description: tourType,
      city: cityGuess,
      startDate: tourStart,
      finishDate: tourFinish || tourStart,
      reference: tourRef,
      amount: tourRate,
      passengers: 1,
    });
  }

  const hotelName = ((raw.match(/Check-Out Date:\s*\n([^\n]+)/) ||
    raw.match(/Hotel Name:\s*\n?([A-Z][^\n]+)/) || [])[1] || "").trim();
  const roomType = ((raw.match(/Room Type:\s*([^\n]+)/) || [])[1] || "").trim();
  const hotelRate = money((raw.match(/AUD\s*[\d,.]+\s*Per Night/i) || [])[0]);
  let [hIn, hOut] = dateRangeAfter(raw, new RegExp((hotelRef || "Novotel") + "[\\s\\S]{0,140}?DENPASAR"), 200);
  if (!hIn) {
    const hd = raw.match(
      /Check-Out Date:\s*\n[^\n]+\n([A-Za-z]{3}\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})\n([A-Za-z]{3}\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/
    );
    if (hd) { hIn = toIsoDate(hd[1]); hOut = toIsoDate(hd[2]); }
  }
  if (hotelName || hotelRef) {
    segments.push({
      kind: "hotel",
      supplierName: hotelName,
      creditor: "",
      city: cityGuess,
      roomType,
      rooms: 1,
      checkInDate: hIn,
      checkOutDate: hOut,
      reference: hotelRef,
      rate: hotelRate,
    });
  }

  /* ── costing lines: Insurance + Service Fee (page 2 concatenated rows) ── */
  const costingLines = [];

  const insCreditor = (raw.match(/\b(Tokio Marine)\b/i) || [])[1] || "";
  const insBlob = (raw.match(/Tokio Marine\s*([\d.,]+)/) || [])[1] || "";
  const insAmount = lastMoney(insBlob);
  const insIssue = toIsoDate((raw.match(/Tokio Marine[\d.,]*\s*\n\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4})/i) || [])[1]);
  const [insStart, insEnd] = dateRangeAfter(raw, /Tokio Marine/i, 200);
  if (insCreditor || insAmount) {
    costingLines.push({
      kind: "insurance",
      supplierName: insCreditor || "Tokio Marine",
      creditor: "",
      startDate: insStart,
      endDate: insEnd,
      issueDate: insIssue,
      reference: "",
      amount: insAmount,
    });
  }

  // "Service FeeCredit Card Fee4.720.000.475.19" — desc is the text before the
  // first digit; total is the last decimal. Require an amount on the line so the
  // "Service Fees" headings in the T&Cs pages don't match.
  const sfeLine = (raw.match(/Service Fee([A-Z][^\n]*?\d+\.\d{2}[\d.,]*)/) || [])[1] || "";
  let sfeDesc = "", sfeAmount = null;
  if (sfeLine) {
    sfeDesc = ((sfeLine.match(/^([^\d]+)/) || [])[1] || "Service Fee").trim();
    sfeAmount = lastMoney(sfeLine);
  }
  if (sfeDesc || sfeAmount) {
    costingLines.push({
      kind: "servicefee",
      description: sfeDesc || "Service Fee",
      supplierName: "RAA- Fees",
      creditor: "",
      amount: sfeAmount,
      optional: true,
    });
  }

  /* ── totals + receipt ───────────────────────────────────────────────── */
  const lineTotal = [
    ...segments.map((s) => s.amount || s.rate || 0),
    ...costingLines.map((c) => c.amount || 0),
  ].reduce((a, b) => a + b, 0);
  const printedTotal = extractGrandTotal(raw);
  const total = printedTotal || round2(lineTotal);
  if (printedTotal && Math.abs(printedTotal - lineTotal) > 0.02) {
    warnings.push(
      `Line items sum to ${round2(lineTotal)} but the doc's grand total is ${printedTotal}. Check the extraction.`
    );
  }

  const receipt = {
    transactionType: "EFT",
    amount: total,
    reference: bpayRef || bookingNo,
    allocation: "ALL",
    dateReceived: null,
  };

  return {
    bookingNo,
    bpayRef,
    bookingNoCrossCheck: fromB,
    passengers,
    consultant: consultant.trim(),
    debtor: debtor.trim(),
    segments,
    costingLines,
    totals: { lineItemsSum: round2(lineTotal), printedTotal, used: total },
    receipt,
    warnings,
  };
}

async function parseRaaItineraryFile(filePath) {
  const fs = require("fs");
  if (/\.txt$/i.test(filePath)) {
    return parseRaaItineraryText(fs.readFileSync(filePath, "utf8"));
  }
  const pdfParse = require("pdf-parse");
  const parsed = await pdfParse(fs.readFileSync(filePath));
  return parseRaaItineraryText(parsed.text);
}

async function parseRaaItineraryBuffer(buffer) {
  const pdfParse = require("pdf-parse");
  const parsed = await pdfParse(buffer);
  return parseRaaItineraryText(parsed.text);
}

module.exports = {
  parseRaaItineraryText,
  parseRaaItineraryFile,
  parseRaaItineraryBuffer,
  toIsoDate,
  bpayRefToBookingNo,
  extractBpayRef,
  allMoney,
  lastMoney,
};

/* ── self-test ─────────────────────────────────────────────────────────── */
if (require.main === module) {
  const path = process.argv[2] || "/tmp/itin.txt";
  parseRaaItineraryFile(path)
    .then((data) => console.log(JSON.stringify(data, null, 2)))
    .catch((e) => { console.error("Parse failed:", e.message); process.exit(1); });
}
