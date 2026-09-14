/**
 * demo-dvc-live.js — a runnable, watchable demo of DVC creation via ICCP.
 * =========================================================================
 *   node demo-dvc-live.js
 *
 * Drives the REAL server.js chat pipeline over a real WebSocket, exactly as
 * the browser UI would. Only ONE thing is stubbed: the Tramada browser read
 * (tramada-payment.js), the same seam test-payment-flows.js stubs — because
 * that step needs a live, logged-in Chrome against a real Tramada booking,
 * which isn't available here. Everything downstream of that read is real,
 * unstubbed code: the BR03/BR04/BR05/BR06 plan arithmetic (payment-views.js),
 * the "CREATE CARD" confirmation gate, dvc-card-issuer.js, and a real OAuth
 * 1.0a-signed SOAP round trip to iccp-client.js — it just lands on
 * mock-iccp-server.js (started automatically below) instead of Mastercard's
 * real sandbox, because RAA's company isn't provisioned there yet.
 *
 * The stubbed booking data below is not invented — it mirrors the real
 * screenshots of RAA's Westpac "Create Single Request" form: booking 12752,
 * branch "RAA Marion", supplier Room-Res, client Megan Gray, reference
 * MG752045.
 *
 * Swapping this from "demo" to "real": change ICCP_ENVIRONMENT=sandbox (once
 * Mastercard/Westpac finish provisioning RAA's company) and remove the
 * tramada-payment.js stub below — nothing else in server.js changes.
 */

const path = require("path");
const { spawn } = require("child_process");

const MOCK_ICCP_PORT = Number(process.env.MOCK_ICCP_PORT || 4100);
const SERVER_PORT = Number(process.env.DEMO_PORT || 4321);

/* ── Stub the Tramada read — the one seam this demo cannot run live ──── */
const BOOKING = {
  flow: "dvc",
  flowLabel: "Westpac DVC",
  flowKind: "supplier",
  bookingNo: "12752",
  clientName: "Megan Gray",
  consultant: "Megan Gray",
  agentInitials: "MG",
  level1Branch: "RAA Marion",
  supplier: "Room-Res",
  suppliers: [{ value: "1", text: "Room-Res" }],
  needsSupplierChoice: false,
  transactionType: null,
  presets: {},
  segments: [
    {
      reference: "RRC - MG752045",
      segType: "Hotel",
      creditorPayable: "246.75",
      creditorDue: "246.75",
      amountText: "246.75",
      amount: 246.75,
    },
  ],
  segmentsFound: true,
  amountHeader: "Creditor Due",
  amountColumnConflict: null,
  total: 246.75,
};

const stub = {
  readPaymentBooking: async (opts) => {
    if (opts.bookingNo !== BOOKING.bookingNo) {
      const err = new Error(`Booking ${opts.bookingNo} could not be found in Tramada.`);
      err.code = "BOOKING_NOT_FOUND";
      throw err;
    }
    return BOOKING;
  },
  readCreditorPayment: (o) => stub.readPaymentBooking({ ...o, flow: o.flow || "mint" }),
  toAmount: (t) => Number(String(t).replace(/[^0-9.]/g, "")) || null,
};
const stubPath = require.resolve("./tramada-payment");
require.cache[stubPath] = { id: stubPath, filename: stubPath, path: path.dirname(stubPath), loaded: true, exports: stub };

/* ── Pretty printing ──────────────────────────────────────────────────── */
const plain = (s) => String(s || "").replace(/<b>/g, "\x1b[1m").replace(/<\/b>/g, "\x1b[0m").replace(/<i>/g, "\x1b[3m").replace(/<\/i>/g, "\x1b[0m").replace(/<br\s*\/?>/g, "\n");
const bot = (s) => console.log(`\n\x1b[36m🤖  ${plain(s)}\x1b[0m`);
const you = (s) => console.log(`\n\x1b[33m🧑  ${s}\x1b[0m`);
const info = (s) => console.log(`\x1b[90m    ${s}\x1b[0m`);

async function main() {
  console.log("\x1b[1m\n=== RAA DVC-via-ICCP live demo (mock card issuer, real everything else) ===\x1b[0m");

  // 1. Start the mock ICCP server as a real child process, real HTTP, real OAuth signing.
  console.log("\nStarting mock-iccp-server.js …");
  const mockEnv = { ...process.env, MOCK_ICCP_PORT: String(MOCK_ICCP_PORT), MOCK_ICCP_REPLICATION_LAG_MS: "0" };
  const mock = spawn(process.execPath, ["mock-iccp-server.js"], { cwd: __dirname, env: mockEnv, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("mock-iccp-server did not start in time")), 8000);
    mock.stdout.on("data", (d) => {
      if (/listening/.test(d.toString())) { clearTimeout(t); resolve(); }
    });
    mock.stderr.on("data", (d) => process.stderr.write(d));
  });
  info(`mock-iccp-server up on :${MOCK_ICCP_PORT}`);

  // 2. Boot the real server.js in-process, pointed at the mock.
  process.env.PORT = String(SERVER_PORT);
  process.env.CDP_MODE = "external";
  process.env.ICCP_ENVIRONMENT = "mock";
  process.env.ICCP_MOCK_BASE_URL = `http://localhost:${MOCK_ICCP_PORT}`;
  process.env.ICCP_COMPANY_ID = process.env.ICCP_COMPANY_ID || "427521";
  process.env.ICCP_RCN_ID = process.env.ICCP_RCN_ID || "13800";
  process.env.ICCP_RCN_ALIAS = process.env.ICCP_RCN_ALIAS || "Sandbox Card";
  process.env.ICCP_TEMPLATE_ID = process.env.ICCP_TEMPLATE_ID || "21680";
  process.env.PAYMENTS_STORE_FILE = process.env.PAYMENTS_STORE_FILE || path.join(__dirname, "demo-payments-store.json");
  require("./server.js");
  await new Promise((r) => setTimeout(r, 500));
  info(`server.js up on :${SERVER_PORT}`);

  // 3. Drive the payments tab exactly as a consultant would type into the chat.
  const WebSocket = require("ws");
  const ws = new WebSocket(`ws://localhost:${SERVER_PORT}/ws?mode=payments`);

  const script = ["Westpac DVC", "12752", "Standard (7 days)", "CREATE CARD"];
  let step = 0;

  await new Promise((resolve, reject) => {
    let quiet = null;
    const settle = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        if (step >= script.length) { ws.close(); resolve(); return; }
        const line = script[step++];
        you(line);
        ws.send(JSON.stringify({ type: "user_message", text: line }));
        settle();
      }, 600);
    };

    ws.on("open", settle);
    ws.on("message", (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.type === "bot_message") bot(d.text);
      else if (d.type === "payment_plan") {
        console.log("\n\x1b[35m📋 Westpac request plan:\x1b[0m");
        for (const [k, v] of d.plan.rows) info(`${k}: ${plain(v)}`);
        if (d.plan.warnings?.length) for (const w of d.plan.warnings) console.log(`\x1b[31m    ⚠ ${plain(w)}\x1b[0m`);
      } else if (d.type === "payment_summary") {
        console.log(`\n\x1b[35m📄 ${d.view.title}\x1b[0m`);
        for (const [k, v] of d.view.rows) info(`${k}: ${v}`);
      } else if (d.type === "iccp_request") {
        console.log(`\n\x1b[34m📤 Request sent to Mastercard ICCP (${d.environment}):\x1b[0m`);
        console.log(d.xml.split("\n").map((l) => `    ${l}`).join("\n"));
      } else if (d.type === "dvc_card_issued") {
        console.log("\n\x1b[42m\x1b[30m  💳 CARD ISSUED (mock — not a real card)  \x1b[0m");
        info(`purchase request: ${d.card.purchaseRequestId}`);
        info(`card number:      ${d.card.cardNumber}`);
        info(`expiry:           ${d.card.expiry}`);
        info(`cvv:              ${d.card.cvv}`);
        info(`environment:      ${d.card.environment}`);
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
  mock.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error("\nDEMO FAILED:", err);
  process.exit(1);
});
