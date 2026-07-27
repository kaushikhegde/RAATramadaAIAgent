/**
 * run-pdf.js — run the PDF-upload pipeline straight from a file, no chat/server.
 *
 * It parses an RAA Travel itinerary/costing PDF (or a .txt of its text) into
 * structured data, then drives Tramada with the real Playwright code
 * (tramada-segments.runPdfBooking) over your logged-in CDP Chrome on port 9222:
 *
 *   open booking (from BPAY Ref) → verify client → add Tour + Hotel segments
 *     → add Insurance costing (+ optional Service Fee) → EFT receipt (full amount)
 *
 *   npm run start:chrome                 # opens the dedicated Chrome; log into Tramada in it
 *   npm run pdf -- itinerary.pdf         # STAGES the receipt (does not commit) — review first
 *   npm run pdf -- itinerary.pdf --issue # actually issues the EFT receipt
 *
 * Flags:
 *   --issue          commit the receipt (default is a safe dry-run/stage)
 *   --service-fee    also create the Service Fee costing line (off by default)
 *   --overrides f    JSON file with creditor overrides (see pdf-overrides.example.json)
 *
 * On ANY failure it prints the failing step + full stack, then exits — copy that
 * whole output back to debug (same loop as run-booking.js).
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { parseRaaItineraryFile } = require("./pdf-itinerary");
const { runPdfBooking } = require("./tramada-segments");

// ── args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let file = null;
let issue = false;
let serviceFee = false;
let overridesPath = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--issue") issue = true;
  else if (a === "--service-fee" || a === "--servicefee") serviceFee = true;
  else if (a === "--overrides" || a === "-o") overridesPath = argv[++i];
  else if (!a.startsWith("-")) file = a;
}
if (!file) {
  console.error("\nUsage: node run-pdf.js <itinerary.pdf|.txt> [--issue] [--service-fee] [--overrides file.json]\n");
  process.exit(1);
}

// Apply optional creditor overrides by segment/line kind. The PDF rarely names
// the Tramada creditor, so this lets you pin them without editing code.
function applyOverrides(data, ov) {
  if (!ov) return data;
  const creditors = ov.creditors || {};
  for (const s of data.segments || []) {
    if (creditors[s.kind]) s.creditor = creditors[s.kind];
  }
  for (const l of data.costingLines || []) {
    if (creditors[l.kind]) l.creditor = creditors[l.kind];
  }
  return data;
}

(async () => {
  let data;
  try {
    data = await parseRaaItineraryFile(path.resolve(file));
  } catch (e) {
    console.error(`\n❌ Could not parse ${file}: ${e.message}\n`);
    process.exit(1);
  }

  let overrides = null;
  if (overridesPath) {
    try {
      overrides = JSON.parse(fs.readFileSync(path.resolve(overridesPath), "utf8"));
    } catch (e) {
      console.error(`\n❌ Could not read overrides ${overridesPath}: ${e.message}\n`);
      process.exit(1);
    }
  }
  if (overrides) applyOverrides(data, overrides);
  if (overrides && overrides.includeServiceFee) serviceFee = true;

  // ── show what was extracted ────────────────────────────────────────────
  console.log(`\n▶ Parsed ${file}`);
  console.log(`  Booking: ${data.bookingNo}  (BPAY Ref ${data.bpayRef})`);
  console.log(`  Passengers: ${(data.passengers || []).join(", ")}`);
  for (const s of data.segments || []) {
    console.log(
      `  • ${s.kind.toUpperCase()}: ${s.supplierName}` +
        (s.reference ? ` [${s.reference}]` : "") +
        `  ${s.startDate || s.checkInDate || ""}→${s.finishDate || s.checkOutDate || ""}` +
        `  $${s.amount != null ? s.amount : s.rate}` +
        (s.creditor ? `  creditor=${s.creditor}` : "  creditor=(from supplier name)")
    );
  }
  for (const l of data.costingLines || []) {
    const shown = l.kind === "servicefee" && !serviceFee ? " (SKIPPED — enable with --service-fee)" : "";
    console.log(
      `  • ${l.kind.toUpperCase()}: ${l.supplierName || l.description}  $${l.amount}` +
        (l.creditor ? `  creditor=${l.creditor}` : "  creditor=(from supplier name)") +
        shown
    );
  }
  console.log(
    `  Receipt: EFT  $${data.receipt.amount}  ref=${data.receipt.reference}  allocate=ALL  ` +
      `→ ${issue ? "WILL ISSUE" : "STAGE ONLY (dry-run; add --issue to commit)"}`
  );
  if (data.warnings && data.warnings.length) {
    console.log("  ⚠ warnings:");
    data.warnings.forEach((w) => console.log(`     - ${w}`));
  }
  console.log("");

  // ── run the pipeline ───────────────────────────────────────────────────
  try {
    const res = await runPdfBooking({
      username: process.env.TRAMADA_USERNAME,
      password: process.env.TRAMADA_PASSWORD,
      data,
      includeServiceFee: serviceFee,
      dryRunReceipt: !issue,
      callbacks: {
        onProgress: (p, m) => console.log(`  [${String(p).padStart(3)}%] ${m}`),
        onStage: (name, d) => console.log(`  ✓ ${name}` + (d && d.skipped ? " (skipped)" : "")),
        onError: (m) => console.error(`  ✗ ${m}`),
        onNeedLogin: () =>
          console.log("  🔐 Not logged in — sign into Tramada in the port-9222 Chrome now; the run waits up to 5 min."),
      },
    });
    const rc = res.receipt && res.receipt.receipt;
    console.log(
      `\n✅ DONE — booking ${res.bookingNo}: ` +
        `+${(res.segments || []).length} segment(s), +${(res.costingLines || []).length} costing line(s)` +
        (rc
          ? `, receipt ${rc.receiptNo} for ${rc.amount} (allocated ${rc.allocated})`
          : res.receipt
          ? " — EFT receipt STAGED (not committed; re-run with --issue to commit)"
          : " — no receipt stage") +
        "\n"
    );
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ FAILED: ${err.message}\n`);
    console.error(err.stack);
    console.error("\n(Copy everything above back to debug.)\n");
    process.exit(1);
  }
})();
