/**
 * demo-mint-live.js — a runnable, watchable demo of Mint staging via the API,
 * mirroring demo-dvc-live.js for the ICCP/DVC side.
 * =========================================================================
 *   node demo-mint-live.js
 *
 * Drives the REAL server.js chat pipeline over a real WebSocket. TWO things
 * are stubbed, both because they need a live, logged-in Chrome against a real
 * Tramada booking, which isn't available here:
 *   - tramada-payment.js's readPaymentBooking      (the Tramada read)
 *   - tramada-payment.js's issueCreditorPayment    (the Tramada write-back)
 *
 * Everything else is real, unstubbed code: mint-payment-issuer.js's payee
 * resolution and staging, a real HTTP call to mint-client.js's createPayment()
 * (hardcoded to "create_payment" — BR02), payment-events.js's SSE watch, and
 * the background write-back trigger in server.js — it just lands on
 * mock-mint-server.js (started automatically below) instead of real MintEFT,
 * and finishes against the stubbed Tramada write-back instead of a real one.
 *
 * The "human authorising in MintEFT" step is simulated by POSTing to the
 * mock's own /mock/authorise/:id control-plane route — the one thing that
 * does not exist at real Mint (see mock-mint-server.js's header).
 */

const path = require("path");
const { spawn } = require("child_process");

const MOCK_MINT_PORT = Number(process.env.MOCK_MINT_PORT || 4000);
const SERVER_PORT = Number(process.env.DEMO_PORT || 4322);

/* ── Stub the Tramada read AND write-back — the two seams this demo cannot
 * run live ──────────────────────────────────────────────────────────────── */
const BOOKING = {
  flow: "mint",
  flowLabel: "Mint",
  flowKind: "supplier",
  bookingNo: "13061",
  clientName: "Megan Gray",
  consultant: "Megan Gray",
  supplier: "RAA TRAVEL PTY LTD", // matches mock-mint-server.js's seeded payees exactly
  suppliers: [{ value: "1", text: "RAA TRAVEL PTY LTD" }],
  needsSupplierChoice: false,
  transactionType: "EFT",
  presets: {},
  segments: [
    {
      reference: "RRC - MG752045",
      segType: "Air",
      creditorPayable: "374.29",
      amountText: "374.29",
      amount: 374.29,
    },
  ],
  segmentsFound: true,
  amountHeader: "Creditor Payable",
  total: 374.29,
};

const stub = {
  readPaymentBooking: async (opts) => {
    if (String(opts.bookingNo) !== BOOKING.bookingNo) {
      const err = new Error(`Booking ${opts.bookingNo} could not be found in Tramada.`);
      err.code = "BOOKING_NOT_FOUND";
      throw err;
    }
    return BOOKING;
  },
  readCreditorPayment: (o) => stub.readPaymentBooking({ ...o, flow: o.flow || "mint" }),
  issueCreditorPayment: async ({ bookingNo, reference }) => {
    // Stands in for the real Issue Creditor Payment form submission — see
    // tramada-payment.js's own header on why that page's write-back is
    // unverified and not something this demo can exercise for real.
    return { details: {}, committed: true, verified: true, bookingNo: String(bookingNo), reference: String(reference) };
  },
  toAmount: (t) => Number(String(t).replace(/[^0-9.]/g, "")) || null,
  getFlow: () => ({}),
  initialsFrom: () => null,
  PAYMENT_FLOWS: {},
};
const stubPath = require.resolve("./tramada-payment");
require.cache[stubPath] = { id: stubPath, filename: stubPath, path: path.dirname(stubPath), loaded: true, exports: stub };

/* ── Pretty printing ──────────────────────────────────────────────────── */
const plain = (s) => String(s || "").replace(/<b>/g, "\x1b[1m").replace(/<\/b>/g, "\x1b[0m").replace(/<i>/g, "\x1b[3m").replace(/<\/i>/g, "\x1b[0m").replace(/<br\s*\/?>/g, "\n");
const bot = (s) => console.log(`\n\x1b[36m🤖  ${plain(s)}\x1b[0m`);
const you = (s) => console.log(`\n\x1b[33m🧑  ${s}\x1b[0m`);
const info = (s) => console.log(`\x1b[90m    ${s}\x1b[0m`);

async function main() {
  console.log("\x1b[1m\n=== RAA Mint-via-API live demo (mock Mint, stubbed Tramada) ===\x1b[0m");

  // 1. Start the mock Mint server as a real child process, real HTTP.
  console.log("\nStarting mock-mint-server.js …");
  const mockEnv = { ...process.env, MOCK_MINT_PORT: String(MOCK_MINT_PORT) };
  const mock = spawn(process.execPath, ["mock-mint-server.js"], { cwd: __dirname, env: mockEnv, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("mock-mint-server did not start in time")), 8000);
    mock.stdout.on("data", (d) => {
      if (/listening/.test(d.toString())) { clearTimeout(t); resolve(); }
    });
    mock.stderr.on("data", (d) => process.stderr.write(d));
  });
  info(`mock-mint-server up on :${MOCK_MINT_PORT}`);

  // 2. Boot the real server.js in-process, pointed at the mock.
  process.env.PORT = String(SERVER_PORT);
  process.env.CDP_MODE = "external";
  process.env.MINT_BASE_URL = `http://localhost:${MOCK_MINT_PORT}/eft/v1`;
  process.env.MINT_API_KEY = process.env.MINT_API_KEY || "demo-key";
  process.env.MINT_PAYER_COMPANY_NUMBER = process.env.MINT_PAYER_COMPANY_NUMBER || "M999999";
  // Tramada's read only ever gives us the consultant's NAME, not their email
  // (see mint-payment-issuer.js) — this is the configured system address
  // user.email falls back to.
  process.env.MINT_DEFAULT_USER_EMAIL = process.env.MINT_DEFAULT_USER_EMAIL || "consultant@raa.com.au";
  process.env.MINT_POLL_INTERVAL_MS = "2000"; // irrelevant in mock (SSE), harmless if it ever falls back
  process.env.PAYMENTS_STORE_FILE = process.env.PAYMENTS_STORE_FILE || path.join(__dirname, "demo-mint-payments-store.json");
  require("./server.js");
  await new Promise((r) => setTimeout(r, 500));
  info(`server.js up on :${SERVER_PORT}`);

  // 3. Drive the payments tab exactly as a consultant would type into the chat.
  const WebSocket = require("ws");
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ws?mode=payments`);

  // Staging now fires automatically once the booking read completes — no
  // confirmation click in front of it (see server.js's runPaymentRead).
  const script = ["Mint", BOOKING.bookingNo];
  let step = 0;
  let done = false;

  await new Promise((resolve, reject) => {
    let quiet = null;
    const finish = () => { if (!done) { done = true; clearTimeout(quiet); resolve(); } };

    const settle = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        if (step >= script.length) return; // wait for the background watcher instead of closing
        const line = script[step++];
        you(line);
        ws.send(JSON.stringify({ type: "user_message", text: line }));
        settle();
      }, 600);
    };

    ws.on("open", settle);
    ws.on("message", (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.type === "bot_message") {
        bot(d.text);
        // The human authorising inside MintEFT's own UI — simulated by hitting
        // the mock's control-plane route, the one thing that has no real-Mint
        // equivalent (see mock-mint-server.js's header).
        const m = /transaction <b>(M\d+)<\/b>/.exec(d.text);
        if (m) {
          const txnId = m[1];
          setTimeout(async () => {
            info(`(simulating the human clicking "Confirm" in MintEFT for ${txnId}...)`);
            const res = await fetch(`http://localhost:${MOCK_MINT_PORT}/mock/authorise/${txnId}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ by: "demo-mint-live.js" }),
            });
            info(`mock authorise responded ${res.status}`);
          }, 800);
        }
        if (/^Done ✅/.test(d.text)) finish();
      } else if (d.type === "payment_summary") {
        console.log(`\n\x1b[35m📄 ${d.view.title}\x1b[0m`);
        for (const [k, v] of d.view.rows) info(`${k}: ${v}`);
      } else if (d.type === "payment_plan") {
        console.log(`\n\x1b[35m📋 ${d.plan.title}\x1b[0m`);
        for (const [k, v] of d.plan.rows) info(`${k}: ${plain(v)}`);
        for (const f of d.plan.customFields || []) info(`${f.label}: ${f.value ? plain(f.value) : "(missing)"}  [${f.source}]`);
        if (d.plan.warnings?.length) for (const w of d.plan.warnings) console.log(`\x1b[31m    ⚠ ${plain(w)}\x1b[0m`);
      } else if (d.type === "mint_request") {
        console.log(`\n\x1b[34m📤 Request sent to MintEFT (${d.environment}):\x1b[0m`);
        console.log(JSON.stringify(d.body, null, 2).split("\n").map((l) => `    ${l}`).join("\n"));
      } else if (d.type === "mint_payment_authorised") {
        console.log("\n\x1b[42m\x1b[30m  ✅ MINT PAYMENT AUTHORISED  \x1b[0m");
        info(`booking:        ${d.bookingNo}`);
        info(`transaction id: ${d.transactionId}`);
      } else if (d.type === "payment_handover") {
        console.log(`\n\x1b[35m➡ Handover — ${d.handover.system}\x1b[0m`);
        for (const [k, v] of d.handover.fields) info(`${k}: ${plain(v)}`);
      } else if (d.type === "error") {
        console.log(`\n\x1b[31m✗ ERROR: ${d.text}\x1b[0m`);
      }
      settle();
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("demo timed out")), 30000);
  });

  console.log("\n\x1b[1m=== Demo complete ===\x1b[0m\n");
  ws.close();
  mock.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nDEMO FAILED:", err);
  process.exit(1);
});
