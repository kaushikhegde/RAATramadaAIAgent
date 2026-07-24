/**
 * run-booking.js — run the FULL Tramada pipeline straight from a JSON file.
 *
 * No chat, no server, no typing details one by one. It reads booking.json (or a
 * path you pass) and drives Tramada with the REAL Playwright code
 * (tramada-segments.runFullBooking) over your logged-in CDP Chrome on port 9222.
 *
 *   npm run start:chrome          # opens the dedicated Chrome; log into Tramada in it
 *   npm run book                  # runs booking.json
 *   node run-booking.js other.json  # or run a different file
 *
 * Every step is logged. On ANY failure it prints the exact failing step and the
 * full stack, then exits — copy that whole output back and it pinpoints the fix.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { runFullBooking } = require("./tramada-segments");

// Args: [file.json] [--booking 12800]
//   --booking N  resume an EXISTING booking instead of creating a new one.
//                Already-present passenger/segments/costings are detected and
//                skipped, so only the missing stages run.
const argv = process.argv.slice(2);
let file = "booking.json";
let existingBookingNo = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--booking" || argv[i] === "-b") {
    existingBookingNo = argv[++i];
  } else if (!argv[i].startsWith("-")) {
    file = argv[i];
  }
}

let data;
try {
  data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
} catch (e) {
  console.error(`\n❌ Could not read/parse ${file}: ${e.message}\n`);
  process.exit(1);
}

console.log(`\n▶ Running pipeline from ${file}` + (existingBookingNo ? ` — RESUMING booking ${existingBookingNo}` : ""));
console.log(`  client=${data.clientCode}  segments=${(data.segments || []).length}  ` +
  `costings=${(data.costings || []).length}  receipt=${data.receipt && data.receipt.amount} ` +
  `(dryRunReceipt=${data.dryRunReceipt === true})\n`);

runFullBooking({
  username: process.env.TRAMADA_USERNAME,
  password: process.env.TRAMADA_PASSWORD,
  clientCode: data.clientCode,
  booking: data.booking,
  existingBookingNo,
  segments: data.segments || [],
  costings: data.costings || [],
  receipt: data.receipt,
  dryRunReceipt: data.dryRunReceipt === true,
  callbacks: {
    onProgress: (p, m) => console.log(`  [${String(p).padStart(3)}%] ${m}`),
    onStage: (name) => console.log(`  ✓ stage complete: ${name}`),
    onError: (m) => console.error(`  ✗ ${m}`),
    onNeedLogin: () =>
      console.log("  🔐 Not logged in — sign into Tramada in the port-9222 Chrome now; the run waits up to 5 min."),
  },
})
  .then((res) => {
    const rc = res.receipt && res.receipt.receipt;
    console.log(
      `\n✅ DONE — booking ${res.bookingNo}` +
        (rc ? `, receipt ${rc.receiptNo} for ${rc.amount} (allocated ${rc.allocated})` : " (receipt not committed)") +
        "\n"
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error(`\n❌ FAILED: ${err.message}\n`);
    console.error(err.stack);
    console.error("\n(Copy everything above back to debug.)\n");
    process.exit(1);
  });
