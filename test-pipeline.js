/**
 * test-pipeline.js — run the FULL chain from the command line:
 *   create booking → add flight + hotel segments → cost the flight → receipt.
 *
 * Attaches to the shared CDP Chrome (npm run start:chrome), which must already
 * be logged into Tramada (so no OTP). Edit the sample data below to taste.
 *
 *   npm run start:chrome                 # log into Tramada in that window once
 *   node test-pipeline.js                # preview: creates booking+segments+costing, receipt NOT committed
 *   node test-pipeline.js --commit       # also issues the receipt
 */

require("dotenv").config();
const { runFullBooking } = require("./tramada-segments");

const commit = process.argv.includes("--commit");

// ── Sample data (sandbox). Replace with real values as needed. ──
const clientCode = "GRAY/SPIDER"; // Tramada client (SURNAME/FIRSTNAME)

const booking = {
  // Jetstar-style booking header (see tramada-booking.js mapJetstarToTramada)
  originCode: "MEL",
  destinationCode: "SYD",
  departureDate: "2026-08-10",   // YYYY-MM-DD
  returnDate: "2026-08-12",
  tripType: "return",
  adults: 1,
  passengers: [{ firstName: "Spider", lastName: "Gray", type: "adult" }],
};

const segments = [
  {
    kind: "flight",
    airline: "Qantas",
    flightNumber: "QF400",
    class: "Economy",
    fromCity: "MEL",
    toCity: "SYD",
    departureDate: "2026-08-10",
    departureTime: "09:00",
    arrivalDate: "2026-08-10",
    arrivalTime: "10:25",
    status: "HK",
  },
  {
    kind: "hotel",
    hotelName: "Test Hotel Sydney",
    cityCode: "SYD",
    roomType: "Standard King",
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-12",
    creditor: "TEMPO HOLIDAYS",
    rate: "220.00",   // AUD incl GST (self-costs the hotel)
    rooms: 1,
    nights: 2,
    status: "HK",
  },
];

// Cost the flight so it becomes receiptable (hotels self-cost above).
const costings = [
  {
    creditor: "TEMPO HOLIDAYS", // supplier/consolidator creditor
    airline: "QF",
    class: "Economy",
    fare: "330.00",             // AUD incl GST
    passengerType: "Adult",
    fareType: "Published",
  },
];

const receipt = {
  transactionType: "Cash",
  amount: "550.00",             // 330 flight + 220 hotel
  reference: "Pipeline-Test-1",
  // dateReceived defaults to today; payerName auto = booking client name
  allocation: "ALL",
};

runFullBooking({
  clientCode,
  booking,
  segments,
  costings,
  receipt,
  dryRunReceipt: !commit,
  callbacks: {
    onProgress: (p, m) => console.log(`  [${String(p).padStart(3)}%] ${m}`),
    onStage: (name, data) =>
      console.log(`  ── stage: ${name} ──`, JSON.stringify(data).slice(0, 300)),
    onError: (m) => console.error("  ERROR:", m),
  },
})
  .then((res) => {
    console.log("\n✅ Pipeline result:");
    console.log("   booking:", res.bookingNo);
    console.log("   receipt:", res.receipt && (res.receipt.receipt || "(preview, not committed)"));
    if (!commit) console.log("\nRe-run with --commit to issue the receipt.");
  })
  .catch((e) => {
    console.error("\nFailed:", e.message);
    process.exit(1);
  });
