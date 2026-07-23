/**
 * test-receipt.js — standalone runner for the receipt automation.
 *
 * Exercises tramada-receipt.js WITHOUT the chat UI. It attaches to the shared
 * CDP Chrome (npm run start:chrome, port 9222), which must already be logged
 * into Tramada — the module reuses that session and skips login, so no OTP.
 *
 * Usage:
 *   # 1) Start Chrome with remote debugging and log into Tramada in it once:
 *   npm run start:chrome
 *
 *   # 2) Preview (fills the form, screenshots, does NOT issue):
 *   node test-receipt.js --booking 12770 --amount 110 --ref Booking-101
 *
 *   # 3) Commit (actually issues the receipt):
 *   node test-receipt.js --booking 12770 --amount 110 --ref Booking-101 --commit
 *
 *   # Options:
 *   --type Cash|EFT|Cheque|"Credit Card"   (default Cash)
 *   --date 2026-07-23                       (default today)
 *   --alloc ALL                             (default ALL)
 *   --search "GRAY"                         (list bookings for a client, then exit)
 */

require("dotenv").config();
const fs = require("fs");
const { runTramadaReceipt, searchBookingsForReceipt } = require("./tramada-receipt");

// ── tiny arg parser ──
function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

async function main() {
  // Optional: just search and list bookings (req 5), then exit.
  const search = arg("search");
  if (search) {
    const rows = await searchBookingsForReceipt({ clientName: search });
    console.log(`\nFound ${rows.length} booking(s) for "${search}":`);
    rows.forEach((r) =>
      console.log(`  ${r.bookingNo}  ${r.clientName}  ${r.itinerary}  ${r.depDate}`)
    );
    return;
  }

  const bookingNo = arg("booking");
  const amount = arg("amount");
  const reference = arg("ref");
  const commit = arg("commit") === true;

  if (!bookingNo || amount == null || !reference) {
    console.error(
      "Missing args. Example:\n" +
        "  node test-receipt.js --booking 12770 --amount 110 --ref Booking-101 [--commit]"
    );
    process.exit(1);
  }

  const result = await runTramadaReceipt({
    bookingNo,
    dryRun: !commit,
    receipt: {
      transactionType: arg("type", "Cash"),
      amount,
      reference,
      dateReceived: arg("date"), // undefined → today
      allocation: arg("alloc", "ALL"),
      // For a Credit Card test, pass a card object here instead:
      // card: { number:"4111111111111111", type:"Visa", holder:"MS SPIDER GRAY",
      //         expiry:"12/28", creditor:"TEMPO HOLIDAYS", authNumber:"123456" },
    },
    callbacks: {
      onProgress: (p, m) => console.log(`  [${String(p).padStart(3)}%] ${m}`),
      onError: (m) => console.error(`  ERROR: ${m}`),
    },
  });

  console.log("\n── Booking ──");
  console.log(result.details);
  console.log("\n── Staged receipt ──");
  console.log(result.staged);

  if (result.committed) {
    console.log("\n✅ COMMITTED:", result.receipt);
  } else {
    if (result.previewImage) {
      fs.writeFileSync("Completed/receipt-preview.png", Buffer.from(result.previewImage, "base64"));
      console.log("\n📸 Preview saved to Completed/receipt-preview.png (NOT committed).");
    }
    console.log("Re-run with --commit to actually issue it.");
  }
}

main().catch((e) => {
  console.error("\nFailed:", e.message);
  process.exit(1);
});
