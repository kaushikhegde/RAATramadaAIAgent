/**
 * server.js — Jetstar Booking Chatbot Backend (v5)
 * ==================================================
 * Express + WebSocket server that:
 *  1. Serves the chat UI (public/index.html)
 *  2. Connects to Gemini AI as a conversational agent
 *  3. Collects booking details through natural conversation
 *  4. Triggers browser automation via Playwright over Chrome CDP (port 9222)
 *  5. Sends real-time progress updates over WebSocket
 *
 * Usage:
 *   npm start          # Start on PORT (default 3000)
 *   npm run dev         # Same (dev alias)
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocket, WebSocketServer } = require("ws");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { runJetstarBooking } = require("./booking");
const { buildSystemPrompt, buildAssistantPrompt } = require("./geminiPrompt");
const { runTramadaAutomation } = require("./tramada-automator");
const { runTramadaAddAndSearch } = require("./tramada-booking");
const { runTramadaReceipt, searchBookingsForReceipt } = require("./tramada-receipt");
const { runFullBooking, runReadBookingState, runPdfBooking } = require("./tramada-segments");
const { parseRaaItineraryBuffer } = require("./pdf-itinerary");
const { runRoomResDraft, runRoomResQuote, closeRoomResPage } = require("./room-res-quote");
const { runRoomResToTramada, findTramadaClients, lookupBookingClient } = require("./room-res-tramada");
const roomResChat = require("./roomres-chat");
const { readPaymentBooking } = require("./tramada-payment");
const paymentViews = require("./payment-views");

// ─── Config ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEBUG = process.env.DEBUG === "true";
// Skip the Jetstar browser automation and go straight from chat → Tramada.
// Tramada only needs chat-collected fields, so nothing from Jetstar is required.
const SKIP_JETSTAR = process.env.SKIP_JETSTAR === "true";
// Full "from the top" mode: chat collects booking→segments→costing→receipt and
// the assistant runs the whole Tramada pipeline (tramada-segments.runFullBooking).
const PIPELINE_MODE = process.env.PIPELINE_MODE === "true";

// ─── Tabs ────────────────────────────────────────────────────────
// These two flags used to be read once at start-up, which is why switching
// between the Jetstar flow and the Tramada assistant meant restarting with a
// different npm script. They are now per-CONNECTION: each browser tab opens its
// own WebSocket carrying ?mode=, gets its own session, its own Gemini prompt and
// its own history, so all three run side by side in one server.
//
// The env vars survive as the DEFAULT for a socket that names no mode, so the
// existing npm scripts keep working exactly as they do today.
const MODES = {
  flights:  { pipeline: false, skipJetstar: false },
  tramada:  { pipeline: true,  skipJetstar: true  },
  // Payments is a structured flow, not a conversation: booking number in,
  // scrape, confirm, stage with Mint. It runs neither of the Gemini prompts.
  payments: { pipeline: false, skipJetstar: true,  noGemini: true },
};

const DEFAULT_MODE = PIPELINE_MODE ? "tramada" : "flights";

function resolveMode(requested) {
  return MODES[requested] ? requested : DEFAULT_MODE;
}

function log(...args) {
  if (DEBUG) console.log("[server]", ...args);
}

/**
 * Escape a value being dropped into a bot_message.
 *
 * These messages are deliberately HTML — the field mappings are unreadable
 * without <b> — so the page renders them as markup. That makes every value
 * read out of Tramada, and everything the consultant types, something that has
 * to be escaped on the way in: a supplier named "Smith & Sons <AU>" should
 * appear as itself rather than as a broken tag.
 */
function esc(v) {
  return String(v == null ? "" : v).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// Accepts a 3-letter IATA code or a known city name and returns the IATA code.
// Mirrors the airports listed in geminiPrompt.js.
const _CITY_TO_IATA = {
  sydney: "SYD", melbourne: "MEL", brisbane: "BNE", "gold coast": "OOL",
  perth: "PER", adelaide: "ADL", cairns: "CNS", hobart: "HBA", darwin: "DRW",
  canberra: "CBR", newcastle: "NTL", "sunshine coast": "MCY", townsville: "TSV",
  launceston: "LST", "bali": "DPS", "denpasar": "DPS", tokyo: "NRT",
  singapore: "SIN", auckland: "AKL", queenstown: "ZQN", honolulu: "HNL",
  phuket: "HKT",
};
function normalizeAirportCode(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (/^[A-Z]{3}$/i.test(v)) return v.toUpperCase();
  const stripped = v.replace(/\s*-\s*[A-Z]{3}$/i, "").trim().toLowerCase();
  return _CITY_TO_IATA[stripped] || null;
}

// ─── Validate Gemini key ─────────────────────────────────────────
if (!GEMINI_API_KEY || GEMINI_API_KEY === "your-gemini-api-key-here") {
  console.warn(
    "\n⚠️  GEMINI_API_KEY not set! Copy .env.example → .env and add your key.\n" +
      "   Get one free at https://aistudio.google.com/apikey\n"
  );
}

// ─── Express app ─────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);

// ─── WebSocket server ────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const requested = new URL(req.url, "http://localhost").searchParams.get("mode");
  const mode = resolveMode(requested);
  console.log(`🔌 Client connected (${mode} tab)`);
  const session = createSession(ws, mode);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleClientMessage(session, msg);
    } catch (err) {
      console.error("Bad message:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Client disconnected");
    session.active = false;
  });

  // Send welcome message
  if (session.mode === "payments") {
    askPaymentType(session);
  } else if (session.pipelineMode) {
    sendToClient(ws, {
      type: "bot_message",
      text: "Hi — I can create a new booking in Tramada, open an existing one to add segments, costings or receipts, or take an RAA itinerary PDF and build it out for you (segments, costings and the EFT receipt). Pick an option below, or use the 📎 button to upload a PDF.",
      quickReplies: ["Create new booking", "Browse existing bookings", "📎 Upload itinerary PDF"],
    });
  } else {
    sendToClient(ws, {
      type: "bot_message",
      text: session.skipJetstar
        ? "G'day! ✈️ I'm your travel booking assistant. Tell me the trip details and I'll record the booking in Tramada — or upload a booking PDF if you have one ready!"
        : "G'day! ✈️ I'm your Jetstar booking assistant. I can help you find and book flights on Jetstar. Just tell me where you'd like to go, or upload a booking PDF if you have one ready!",
      quickReplies: ["Book a flight", "Upload PDF"],
    });
  }
});

// ─── Session management ──────────────────────────────────────────
function createSession(ws, mode = DEFAULT_MODE) {
  const cfg = MODES[mode] || MODES[DEFAULT_MODE];
  return {
    ws,
    active: true,
    mode,                      // "flights" | "tramada" | "payments"
    pipelineMode: cfg.pipeline,
    skipJetstar: cfg.skipJetstar,
    chatHistory: [],          // Gemini conversation history
    bookingData: null,        // Extracted booking JSON
    automationRunning: false,
    geminiChat: null,         // Gemini chat session
    roomRes: null,            // Room-Res quote conversation (roomres-chat.js state)
    roomResPending: null,      // that flow paused on a question only the user can answer (creditor / city)
    pendingPayment: null,      // payments tab paused on a supplier choice
    paymentType: null,         // payments tab: which system the payment goes through
    pendingBookingNo: null,    // booking number typed before the transaction type
  };
}

// ─── Gemini AI setup ─────────────────────────────────────────────
function getGeminiChat(session) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "your-gemini-api-key-here") {
    return null;
  }
  // Fall back to the module defaults when called without a session, so any
  // caller added later behaves as it did before tabs existed.
  const pipeline = session ? session.pipelineMode : PIPELINE_MODE;
  const skipJetstar = session ? session.skipJetstar : SKIP_JETSTAR;

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-3.5-flash-lite",
    systemInstruction: pipeline
      ? buildAssistantPrompt()
      : buildSystemPrompt({ skipJetstar }),
  });

  return model.startChat({
    history: [],
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
      // Large enough for the full pipeline JSON (booking + multiple segments +
      // costing + receipt) — at 1024 a return-trip booking truncates mid-JSON.
      maxOutputTokens: 4096,
    },
  });
}

// ─── Handle client messages ──────────────────────────────────────
async function handleClientMessage(session, msg) {
  const { ws } = session;

  switch (msg.type) {
    case "user_message":
      await handleUserMessage(session, msg.text);
      break;

    case "pdf_upload":
      await handlePdfUpload(session, msg.filename, msg.data);
      break;

    // RAA itinerary/costing PDF → Tramada segments + costings + EFT receipt.
    // stage: "parse" (extract & show card) → "create" (add segments/costings +
    // stage receipt) → "issue" (commit the EFT receipt). Confirm before issue.
    case "tramada_pdf_upload":
      await handleTramadaPdfUpload(session, msg);
      break;

    // Room-Res hotel quote → Tramada segment (+ optional receipt). The button
    // does exactly what typing "create quote" does — one flow, one code path.
    case "roomres_start":
      await handleRoomResStart(session);
      break;

    case "tramada_search":
      await handleTramadaSearch(session, msg.username, msg.password);
      break;

    case "tramada_chain":
      await handleTramadaChain(session, msg.username, msg.password, msg.clientCode);
      break;

    // ── Receipt flow ──────────────────────────────────────────────
    // req 5: no booking number → search & return a list to pick from.
    case "receipt_search":
      await handleReceiptSearch(session, msg);
      break;

    // Preview (fill, don't commit) then commit. The chat confirms BEFORE
    // committing: send { confirmed: false } (or omit) for a preview, then
    // { confirmed: true } to actually issue.
    case "receipt_run":
      await handleReceiptRun(session, msg);
      break;

    // Full pipeline: booking → segments → costing → receipt. Same confirm gate
    // as receipt_run: omit `confirmed` to preview the receipt, send it true to
    // commit. Booking + segments + costing are created either way.
    case "pipeline_run":
      await handlePipelineRun(session, msg);
      break;

    default:
      log("Unknown message type:", msg.type);
  }
}

// ─── Payments tab ────────────────────────────────────────────────
// Four flows, from docs/: Westpac DVC, Mint, TravelPay and IPSI. The tab asks
// which one FIRST, because they are not the same job with a different logo on
// the end — they land on different Tramada pages, read different columns, and
// three of the four need something from the consultant that Tramada does not
// hold.
//
//   Mint / TravelPay  Payments → Creditor Payment → EFT → Payment To.
//                     Identical reads; different external forms.
//   Westpac DVC       Receipts → Agency CC Debtor Receipt → Creditor, then a
//                     validity period and a cumulative limit the consultant
//                     has to agree to before a card is requested.
//   IPSI              Receipts → Debtor Payment Receipt. Money coming IN from
//                     a customer already charged in IPSI, so the amount and
//                     reference are transcribed from the IPSI approved page
//                     and cross-checked against Tramada.
//
// Everything here is READ-ONLY in Tramada and read-only in the payment system.
// Every guide ends the agent's involvement before money moves — Mint BR02,
// TravelPay BR02, DVC BR07/BR10, IPSI BR07 — so the last thing this code does
// is show a human exactly what to type, and stop.

function extractBookingNo(text) {
  const m = String(text || "").match(/\b(\d{4,7})\b/);
  return m ? m[1] : null;
}

// ─── Step 0: which system are we paying through? ──────────────────
// Asked FIRST so the answer is on the record before any booking is touched:
// the flow decides which Tramada page is even opened, so it cannot be inferred
// later from a form that is already half filled in.
const PAYMENT_TYPES = [
  { id: "dvc",       label: "Westpac DVC", match: /^(1|w|westpac|dvc|westpac ?dvc)$/ },
  { id: "mint",      label: "Mint",        match: /^(2|m|mint|mint ?eft)$/ },
  { id: "travelpay", label: "TravelPay",   match: /^(3|t|travel ?pay)$/ },
  { id: "ipsi",      label: "IPSI",        match: /^(4|i|ipsi)$/ },
];

const PAYMENT_TYPE_LABELS = PAYMENT_TYPES.map((t) => t.label);

/**
 * The chosen transaction type, or `null` for anything unrecognised.
 *
 * Deliberately strict — the four systems are the whole list, and a near-miss
 * re-asks rather than picking the closest one. Sending a payment through the
 * wrong system is not something the consultant can undo from this screen.
 */
function readPaymentType(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[.!?]+$/, "");
  if (!t) return null;
  return PAYMENT_TYPES.find((type) => type.match.test(t)) || null;
}

function askPaymentType(session, prefix) {
  sendToClient(session.ws, {
    type: "bot_message",
    text:
      (prefix ? prefix + "<br><br>" : "") +
      "What kind of transaction do you want me to pay?",
    quickReplies: PAYMENT_TYPE_LABELS,
  });
}

/** What to ask for after the type is settled. IPSI takes money from a customer. */
function bookingPrompt(type) {
  return type.id === "ipsi"
    ? `<b>IPSI</b> it is — a customer receipt. What's the booking number from the IPSI approved page?`
    : `<b>${type.label}</b> it is. What's the booking number?`;
}

/**
 * Yes / no / neither, for the confirmation that stands in front of the payment.
 *
 * Returns `null` for anything it does not recognise, and the caller re-asks.
 * Unclear must never fall through to yes: this is the last gate before a
 * consultant is sent off to move real money, and a loose /yes|y/ test matches
 * the "y" in "why?" and the "no" branch never runs at all.
 */
function readYesNo(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (/^(y|yes|yep|yeah|ok|okay|sure|continue|proceed|go ahead)$/.test(t)) return "yes";
  if (/^(n|no|nope|nah|not now|cancel|stop)$/.test(t)) return "no";
  return null;
}

/**
 * The last screen: the field-by-field mapping, and the full stop.
 *
 * The mapping is the one thing the payment system's own screen cannot show —
 * over there the consultant is looking at empty fields with nothing to say
 * what Tramada called any of them. Sent as a card rather than a paragraph so
 * the values can be read off one at a time while typing.
 */
function sendPaymentHandover(session, result, extra) {
  sendToClient(session.ws, {
    type: "payment_handover",
    handover: paymentViews.handoverView(result, extra || {}),
  });
}

/* ── IPSI: the four values off the approved page ─────────────────── */
// Step 1 of the IPSI guide happens before the agent is involved at all: a human
// takes the card over the phone and IPSI shows an Approved page. These are the
// four things on it that Tramada needs, asked one at a time because they are
// being transcribed off another screen.
const IPSI_QUESTIONS = [
  {
    key: "transactionRef",
    ask: "What's the <b>IPSI transaction reference number</b> from the approved page?",
    parse: (t) => (t.trim() ? t.trim() : null),
    retry: "I need the transaction reference from the IPSI approved page — it goes into Tramada's Reference field.",
  },
  {
    key: "cardholderName",
    // BR01/BR05 — the person who actually paid, which is not always the client.
    ask:
      "What's the <b>cardholder name</b> from the approved page?<br><br>" +
      "If the person paying isn't the customer on the booking, give me their first and last name (BR01).",
    parse: (t) => (t.trim().length >= 2 ? t.trim() : null),
    retry: "I need the cardholder's name as it appears on the IPSI approved page.",
  },
  {
    key: "amount",
    ask: "What <b>amount</b> did IPSI approve?",
    parse: (t) => {
      const n = Number(String(t).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n > 0 ? n : null;
    },
    retry: "Give me the approved amount as a number, e.g. <b>374.29</b>.",
  },
  {
    key: "cardType",
    // BR02 — confirmed with the customer, because it picks which dummy card is
    // used in Tramada. BR04 means the real number is never entered anywhere.
    ask: "What <b>card type</b> did the customer use? I'll match the RAA dummy card to it (BR02/BR04).",
    parse: (t) => {
      const s = String(t).trim().toLowerCase();
      const known = [
        ["visa", "Visa"],
        ["master", "Mastercard"],
        ["mc", "Mastercard"],
        ["amex", "Amex"],
        ["american express", "Amex"],
        ["diners", "Diners"],
      ].find(([k]) => s.includes(k));
      return known ? known[1] : null;
    },
    retry: "Which card type — <b>Visa</b>, <b>Mastercard</b>, <b>Amex</b> or <b>Diners</b>?",
    quickReplies: ["Visa", "Mastercard", "Amex", "Diners"],
  },
];

function askIpsiQuestion(session, index, prefix) {
  const q = IPSI_QUESTIONS[index];
  sendToClient(session.ws, {
    type: "bot_message",
    text: (prefix ? prefix + "<br><br>" : "") + q.ask,
    quickReplies: q.quickReplies,
  });
}

/* ── DVC: the validity period (BR03) ─────────────────────────────── */

function askDvcValidity(session, prefix) {
  sendToClient(session.ws, {
    type: "bot_message",
    text:
      (prefix ? prefix + "<br><br>" : "") +
      "How long should the card be valid for?<br><br>" +
      "<b>Standard</b> is 7 days from today. Use <b>custom</b> for an overseas hotel where " +
      "check-in is further out than that, and I'll run the card to the check-in date (BR03).",
    quickReplies: ["Standard (7 days)", "Custom check-in date"],
  });
}

/**
 * DVC steps 8–12 — the Westpac request, with the arithmetic done.
 *
 * Sent as its own card because it is a different screen from the Tramada read:
 * this is what the consultant is about to key into Create Single Request, and
 * the cumulative limit and validity dates on it are computed, not copied.
 */
function sendDvcPlan(session, pending) {
  const plan = paymentViews.dvcPlanView(pending.payment, pending.answers, new Date());
  pending.plan = plan;

  sendToClient(session.ws, { type: "payment_plan", plan });

  sendToClient(session.ws, {
    type: "bot_message",
    text:
      `That's the Westpac request for booking <b>${pending.payment.bookingNo}</b>. ` +
      `Shall I show you the rest — Submit, the card into the booking notes, and the receipt back in Tramada?`,
    quickReplies: ["Yes", "No"],
  });
}

async function handlePaymentsMessage(session, userText) {
  const { ws } = session;
  const text = String(userText || "").trim();

  if (/^(cancel|stop|reset|start over)$/i.test(text)) {
    session.pendingPayment = null;
    session.pendingBookingNo = null;
    // Back to the top, not back to the booking prompt: "start over" on a
    // payment run means the transaction type is up for grabs again too.
    session.paymentType = null;
    askPaymentType(session, "Cleared.");
    return;
  }

  // ── Step 0 — the transaction type, before anything else ──────────
  // Nothing below this point runs until it is answered, so a booking number
  // sent first is held rather than dropped, and the consultant does not have
  // to type it a second time.
  if (!session.paymentType) {
    const chosen = readPaymentType(text);
    if (!chosen) {
      const early = extractBookingNo(text);
      if (early) session.pendingBookingNo = early;
      askPaymentType(
        session,
        early
          ? `Got booking <b>${early}</b> — I'll come back to it.`
          : `I need one of the four: ${PAYMENT_TYPE_LABELS.join(", ")}.`
      );
      return;
    }

    session.paymentType = chosen;

    // A booking number sent ahead of the type answers the next question too,
    // so ask it only when it is genuinely still open.
    const held = session.pendingBookingNo;
    session.pendingBookingNo = null;
    if (held) {
      sendToClient(ws, {
        type: "bot_message",
        text: `<b>${chosen.label}</b> it is — picking up booking <b>${held}</b>.`,
      });
      await runPaymentRead(session, held, null);
      return;
    }

    sendToClient(ws, { type: "bot_message", text: bookingPrompt(chosen) });
    return;
  }

  // The type is settled, but naming another one is a change of mind rather
  // than a booking number that failed to parse — take it and re-ask.
  if (!session.pendingPayment) {
    const switched = readPaymentType(text);
    if (switched && switched.id !== session.paymentType.id) {
      session.paymentType = switched;
      sendToClient(ws, { type: "bot_message", text: `Switched to ${bookingPrompt(switched)}` });
      return;
    }
  }

  const pending = session.pendingPayment;

  // ── IPSI — transcribing the approved page, one field at a time ───
  if (pending && pending.awaitingIpsi != null) {
    const index = pending.awaitingIpsi;
    const q = IPSI_QUESTIONS[index];
    const value = q.parse(text);
    if (value == null) {
      sendToClient(ws, { type: "bot_message", text: q.retry, quickReplies: q.quickReplies });
      return;
    }
    pending.ipsi[q.key] = value;

    if (index + 1 < IPSI_QUESTIONS.length) {
      pending.awaitingIpsi = index + 1;
      askIpsiQuestion(session, index + 1);
      return;
    }

    // All four in hand. The cross-check against Tramada is the whole reason
    // for reading the booking before asking: BR06 says the allocation must
    // match, and a mismatch is worth surfacing before the receipt is drafted
    // rather than after it is issued.
    pending.awaitingIpsi = null;
    pending.awaitingConfirm = true;
    const diff =
      Math.abs(Number(pending.ipsi.amount) - Number(pending.payment.total || 0)) > 0.005;
    sendToClient(ws, {
      type: "bot_message",
      text:
        `Got it — <b>$${Number(pending.ipsi.amount).toFixed(2)}</b> from ` +
        `<b>${esc(pending.ipsi.cardholderName)}</b> on a ${pending.ipsi.cardType} card, ` +
        `reference <b>${esc(pending.ipsi.transactionRef)}</b>.` +
        (diff
          ? `<br><br><b>That doesn't match Tramada</b>, which has ` +
            `$${Number(pending.payment.total || 0).toFixed(2)} to allocate. BR06 says these must ` +
            `agree before you tick the A column.`
          : "") +
        `<br><br>Shall I map it onto the Tramada receipt?`,
      quickReplies: ["Yes", "No"],
    });
    return;
  }

  // ── DVC — the validity period, then a date if they chose custom ──
  if (pending && pending.awaitingValidity) {
    if (/^(1|standard|standard \(7 days\)|7|7 days)$/i.test(text)) {
      pending.awaitingValidity = false;
      pending.answers = { validity: "standard" };
      sendDvcPlan(session, pending);
      pending.awaitingConfirm = true;
      return;
    }
    if (/^(2|custom|custom check-?in date|check-?in)$/i.test(text)) {
      pending.awaitingValidity = false;
      pending.awaitingCheckIn = true;
      sendToClient(ws, {
        type: "bot_message",
        text: "What's the <b>check-in date</b>? (DD/MM/YYYY)",
      });
      return;
    }
    // A date typed straight at the question is a custom period — take it.
    const asDate = paymentViews.parseDate(text);
    if (asDate) {
      pending.awaitingValidity = false;
      pending.answers = { validity: "custom", checkInDate: asDate };
      sendDvcPlan(session, pending);
      pending.awaitingConfirm = true;
      return;
    }
    askDvcValidity(session, "I need one or the other.");
    return;
  }

  if (pending && pending.awaitingCheckIn) {
    const date = paymentViews.parseDate(text);
    if (!date) {
      sendToClient(ws, {
        type: "bot_message",
        text: "I couldn't read that as a date. Give it to me as <b>DD/MM/YYYY</b> — e.g. 25/12/2026.",
      });
      return;
    }
    pending.awaitingCheckIn = false;
    pending.answers = { validity: "custom", checkInDate: date };
    sendDvcPlan(session, pending);
    pending.awaitingConfirm = true;
    return;
  }

  // Awaiting the Yes/No in front of the payment. Handled before anything else
  // reads this message, so a bare "no" here is a no to THIS question and not a
  // booking number that failed to parse.
  if (pending && pending.awaitingConfirm) {
    const answer = readYesNo(text);

    // A booking number typed at the prompt means "a different booking" — take
    // it rather than making them cancel first and type it twice.
    const other = answer ? null : extractBookingNo(text);
    if (other) {
      session.pendingPayment = null;
      await runPaymentRead(session, other, null);
      return;
    }

    if (answer === "no") {
      session.pendingPayment = null;
      sendToClient(ws, {
        type: "bot_message",
        text:
          `Stopped there — nothing went to ${session.paymentType.label} and nothing was issued in ` +
          `Tramada for booking <b>${pending.bookingNo}</b>. Send me another booking number when you're ready.`,
      });
      return;
    }

    if (answer !== "yes") {
      sendToClient(ws, {
        type: "bot_message",
        text: `Sorry — I need a yes or a no on booking <b>${pending.bookingNo}</b>.`,
        quickReplies: ["Yes", "No"],
      });
      return;
    }

    session.pendingPayment = null;
    sendPaymentHandover(session, pending.payment, { plan: pending.plan, ipsi: pending.ipsi });
    return;
  }

  // Awaiting a supplier choice from a multi-creditor booking.
  if (pending && pending.awaitingSupplier) {
    const { bookingNo, suppliers } = pending;
    const byIndex = /^\d+$/.test(text) ? suppliers[Number(text) - 1] : null;
    const chosen =
      byIndex ||
      suppliers.find((o) => o.text.toLowerCase() === text.toLowerCase()) ||
      suppliers.find((o) => o.text.toLowerCase().includes(text.toLowerCase()));

    if (!chosen) {
      sendToClient(ws, {
        type: "bot_message",
        text: `I couldn't match "${esc(text)}" to a supplier on booking ${bookingNo}. Reply with the number from the list, or the supplier name.`,
      });
      return;
    }
    session.pendingPayment = null;
    await runPaymentRead(session, bookingNo, chosen.text);
    return;
  }

  const bookingNo = extractBookingNo(text);
  if (!bookingNo) {
    sendToClient(ws, {
      type: "bot_message",
      text:
        `Give me a booking number (e.g. <b>13061</b>) and I'll read the ` +
        `<b>${session.paymentType.label}</b> ${
          session.paymentType.id === "ipsi" ? "receipt" : "creditor payment"
        } out of Tramada.`,
    });
    return;
  }

  await runPaymentRead(session, bookingNo, null);
}

let paymentReadSeq = 0;

async function runPaymentRead(session, bookingNo, supplier) {
  const { ws } = session;
  const type = session.paymentType;

  if (session.automationRunning) {
    sendToClient(ws, { type: "bot_message", text: "Already reading a booking — give that one a moment." });
    return;
  }
  session.automationRunning = true;

  // Every read carries its own id so the page draws it a NEW progress card.
  // A second booking number used to be typed into the first one's card, which
  // overwrote how far the failed attempt actually got — the one thing worth
  // reading after a booking comes back not found.
  const runId = `pay-${Date.now().toString(36)}-${++paymentReadSeq}`;

  sendToClient(ws, {
    type: "bot_message",
    text: `Reading booking <b>${bookingNo}</b> in Tramada for <b>${type.label}</b>${supplier ? ` — <b>${esc(supplier)}</b>` : ""}…`,
  });

  try {
    const result = await readPaymentBooking({
      flow: type.id,
      bookingNo,
      supplier,
      callbacks: {
        onProgress: (pct, m) =>
          session.active && sendToClient(ws, { type: "pipeline_progress", runId, percent: pct, message: m }),
        onNeedLogin: () =>
          sendToClient(ws, {
            type: "bot_message",
            text: "Tramada needs a login — sign in to the shared Chrome window, then send the booking number again.",
          }),
      },
    });

    // More than one creditor means more than one payment: one external
    // transaction and one human authorisation each. DVC BR08 spells it out —
    // one card per supplier, per booking. Ask rather than guess: paying the
    // right amount to the wrong supplier has no automated recovery.
    if (result.needsSupplierChoice) {
      session.pendingPayment = { bookingNo, awaitingSupplier: true, suppliers: result.suppliers };
      const list = result.suppliers.map((o, i) => `${i + 1}. ${esc(o.text)}`).join("<br>");
      sendToClient(ws, {
        type: "bot_message",
        text:
          `Booking <b>${bookingNo}</b> (${esc(result.clientName || "client unknown")}) has ` +
          `${result.suppliers.length} creditors. Each is its own payment` +
          (type.id === "dvc" ? " and its own card (BR08)" : "") +
          `. Which one are we paying?<br><br>${list}`,
      });
      return;
    }

    sendToClient(ws, { type: "payment_summary", payment: result, view: paymentViews.summaryView(result) });

    if (!result.segmentsFound || result.segments.length === 0) {
      session.pendingPayment = null;
      sendToClient(ws, {
        type: "bot_message",
        text:
          `Nothing to allocate on booking <b>${bookingNo}</b> — the Segments to Allocate table is empty, ` +
          `so there's no ${type.id === "ipsi" ? "outstanding amount" : "creditor payable"} here. ` +
          `Send me another booking number.`,
      });
      return;
    }

    const pending = { bookingNo, payment: result, ipsi: {}, answers: null, plan: null };
    session.pendingPayment = pending;

    // Each flow asks for whatever Tramada could not tell it, then confirms.
    // The confirm is always last and always buttons rather than free text:
    // it is the gate in front of a human being sent to move money, and a typed
    // answer is where "no, don't" gets read as a yes.
    if (type.id === "ipsi") {
      pending.awaitingIpsi = 0;
      askIpsiQuestion(
        session,
        0,
        `Booking <b>${bookingNo}</b> found — <b>$${Number(result.total || 0).toFixed(2)}</b> to allocate ` +
          `across ${result.segments.length} segment${result.segments.length === 1 ? "" : "s"}.<br><br>` +
          `Now the four values off the IPSI approved page.`
      );
      return;
    }

    if (type.id === "dvc") {
      pending.awaitingValidity = true;
      askDvcValidity(
        session,
        `Booking <b>${bookingNo}</b> found — ${result.supplier ? `<b>${esc(result.supplier)}</b>, ` : ""}` +
          `<b>$${Number(result.total || 0).toFixed(2)}</b> across ${result.segments.length} ` +
          `segment${result.segments.length === 1 ? "" : "s"}.`
      );
      return;
    }

    pending.awaitingConfirm = true;
    sendToClient(ws, {
      type: "bot_message",
      text:
        `Booking <b>${bookingNo}</b> found — ${result.supplier ? `<b>${esc(result.supplier)}</b>, ` : ""}` +
        `<b>$${Number(result.total || 0).toFixed(2)}</b> across ${result.segments.length} ` +
        `segment${result.segments.length === 1 ? "" : "s"}.<br><br>` +
        `Continue with making the payment via <b>${type.label}</b>?`,
      quickReplies: ["Yes", "No"],
    });
  } catch (err) {
    // A booking that isn't there is the consultant's to fix, not a fault — so
    // it reads as a plain answer and asks for another number, rather than as
    // the automation falling over. Everything else is still an error.
    if (err.code === "BOOKING_NOT_FOUND") {
      session.pendingPayment = null;
      sendToClient(ws, {
        type: "bot_message",
        text: `Booking <b>${bookingNo}</b> could not be found in Tramada. Check the number and send me another one.`,
      });
    } else {
      sendToClient(ws, { type: "error", text: `Tramada read failed: ${err.message}` });
    }
  } finally {
    session.automationRunning = false;
  }
}

// ─── Process user text messages through Gemini ───────────────────
async function handleUserMessage(session, userText) {
  const { ws } = session;

  // Show typing indicator
  sendToClient(ws, { type: "typing" });

  // ── Payments tab ──
  // Owns its messages outright: a bare booking number here means "read this
  // booking's creditor payment", not something for the booking assistant.
  if (session.mode === "payments") {
    await handlePaymentsMessage(session, userText);
    return;
  }

  // ── Room-Res quote flow ──
  // Ahead of everything else, and deliberately outside the PIPELINE_MODE gate:
  // once this conversation is running it owns the user's messages, so a bare
  // "yes" means yes to ITS question and not to something staged earlier — and
  // the "Create quote" button works whichever way the server was started.
  if (session.roomResPending) {
    const reply = userText.trim();
    const kind = session.roomResPending.kind;
    if (/^(cancel|stop|no|nvm|never ?mind|quit)$/i.test(reply)) {
      session.roomResPending = null;
      session.roomRes = null;
      await closeRoomResPage().catch(() => {});
      sendToClient(ws, { type: "bot_message", text: "Cancelled — the Room-Res quote is still there, but nothing went into Tramada." });
      return;
    }
    sendToClient(ws, {
      type: "bot_message",
      text:
        kind === "city"
          ? `Using "${reply}" as the Tramada city — carrying on…`
          : `Using "${reply}" as the creditor — carrying on…`,
    });
    await resumeRoomResPending(session, reply);
    return;
  }

  if (session.roomRes) {
    await stepRoomRes(session, userText);
    return;
  }

  if (roomResChat.isStart(userText)) {
    await handleRoomResStart(session);
    return;
  }

  // ── Pipeline mode: run the whole booking→segments→costing→receipt chain ──
  if (session.pipelineMode) {
    // Awaiting a creditor the run PAUSED on — take this reply as the creditor
    // name, apply it, and resume the run from where it stopped.
    if (session.pendingCreditor) {
      const pc = session.pendingCreditor;
      const reply = userText.trim();
      if (/^(cancel|stop|no|nvm|never ?mind|quit)$/i.test(reply)) {
        session.pendingCreditor = null;
        sendToClient(ws, { type: "bot_message", text: "Cancelled — stopped there, nothing more changed." });
        return;
      }
      (pc.data.segments || []).forEach((it) => { if (it.kind === pc.needed.kind) it.creditor = reply; });
      (pc.data.costingLines || []).forEach((it) => { if (it.kind === pc.needed.kind) it.creditor = reply; });
      session.pendingCreditor = null;
      sendToClient(ws, { type: "bot_message", text: `Using "${reply}" as the ${pc.needed.kind} creditor — continuing…` });
      await executePdfRun(session, pc.data, pc.opts);
      return;
    }

    // If a pipeline is staged and the user confirms, run it now.
    if (
      session.pendingPipeline &&
      /(yes|confirm|go|do it|issue|proceed|book it|run it|retry|try again|again|logged ?in|ready|done)/i.test(userText)
    ) {
      const intent = session.pendingPipeline;
      session.pendingPipeline = null;
      await runPipelineFromChat(session, intent);
      return;
    }
    if (session.pendingPipeline && /^\s*(no|cancel|stop|wait)/i.test(userText)) {
      session.pendingPipeline = null;
      sendToClient(ws, { type: "bot_message", text: "No worries — cancelled. Tell me what to change." });
      return;
    }

    // "use / apply the same PDF for booking 12806" — apply the last uploaded PDF
    // to a different booking, using THAT booking's own client (explicit request).
    if (session.lastPdf && /\bpdf\b/i.test(userText) && /\b(use|apply|run|create|add|do|same|for)\b/i.test(userText)) {
      const bkgM = userText.match(/(?:booking\s*(?:no\.?\s*)?|for\s+|to\s+|on\s+|#|\()\s*(\d{4,6})\b/i) ||
        userText.match(/\b(\d{4,6})\s+booking\b/i);
      if (bkgM) { await runPdfForBooking(session, bkgM[1]); return; }
    }
  }

  // Check if user confirmed booking
  if (
    session.bookingData &&
    /yes.*book|confirm|let'?s? go|book it|proceed|start booking/i.test(userText)
  ) {
    if (session.skipJetstar) {
      sendToClient(ws, {
        type: "bot_message",
        text: "Beauty! Let's get this straight into Tramada.",
      });
      sendToClient(ws, {
        type: "tramada_prompt",
        clientCode: session.bookingData.clientCode || "",
      });
      return;
    }
    sendToClient(ws, {
      type: "bot_message",
      text: "Awesome! Starting the booking automation now. I'll keep you updated on each step...",
    });
    startAutomation(session);
    return;
  }

  // If no Gemini key, use fallback conversation
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "your-gemini-api-key-here") {
    sendToClient(ws, {
      type: "bot_message",
      text: "⚠️ Gemini API key not configured. Please add your key to the .env file and restart the server.\n\nGet a free key at: https://aistudio.google.com/apikey",
    });
    return;
  }

  try {
    // Initialize chat if needed
    if (!session.geminiChat) {
      session.geminiChat = getGeminiChat(session);
    }

    // Send user message to Gemini. If a PDF was uploaded this session, prepend
    // its context so follow-up questions ("what's in the PDF", "use it for X")
    // are understood instead of getting a blank greeting.
    let toSend = userText;
    if (session.pipelineMode && session.lastPdf) {
      const p = session.lastPdf;
      const segs = (p.segments || []).map((s) => `${s.kind} ${s.supplierName || ""}`.trim()).join("; ");
      const costs = (p.costingLines || []).map((c) => `${c.kind} ${c.supplierName || c.description || ""}`.trim()).join("; ");
      toSend =
        `[CONTEXT] The user uploaded an RAA itinerary PDF for booking ${p.bookingNo} ` +
        `(passengers: ${(p.passengers || []).join(", ")}), EFT total $${p.receipt && p.receipt.amount}, ` +
        `BPAY ref ${p.receipt && p.receipt.reference}. Segments: ${segs || "none"}. Costing lines: ${costs || "none"}. ` +
        `Applying this PDF to a DIFFERENT booking number is supported (it reuses these segments/costings there, with a ` +
        `client-name safety check). Use this context to answer; do not greet the user again.\n\n[USER] ${userText}`;
    }
    const result = await session.geminiChat.sendMessage(toSend);
    const response = result.response.text();

    // Assistant mode: handle intents (list_bookings / open_booking / run) with
    // results fed back to the model as [SYSTEM] messages, up to 3 hops.
    if (session.pipelineMode) {
      await handleAssistantResponse(session, response, 0);
      return;
    }

    // Parse Gemini response — check if it contains JSON booking data
    const parsed = parseGeminiResponse(response);

    if (parsed.bookingData) {
      session.bookingData = parsed.bookingData;
      log("Booking data extracted:", JSON.stringify(parsed.bookingData, null, 2));

      // Send the text part of the response
      if (parsed.text) {
        sendToClient(ws, { type: "bot_message", text: parsed.text });
      }

      // Send booking summary card
      sendToClient(ws, { type: "summary", booking: parsed.bookingData });
    } else {
      // Regular message with optional quick replies
      sendToClient(ws, {
        type: "bot_message",
        text: parsed.text,
        quickReplies: parsed.quickReplies || null,
      });
    }
  } catch (err) {
    console.error("Gemini error:", err.message);
    sendToClient(ws, {
      type: "error",
      text: `AI error: ${err.message}. Please try again.`,
    });
  }
}

// ─── Parse Gemini response ───────────────────────────────────────
function parseGeminiResponse(response) {
  const result = { text: response, bookingData: null, quickReplies: null };

  // Look for JSON booking data in the response (between ```json ... ``` or raw JSON)
  const jsonMatch =
    response.match(/```json\s*([\s\S]*?)```/) ||
    response.match(/\{[\s\S]*"origin"[\s\S]*"destination"[\s\S]*\}/);

  if (jsonMatch) {
    try {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const data = JSON.parse(jsonStr);

      // Validate it looks like booking data
      if (data.origin && data.destination && data.departureDate) {
        const originCode = normalizeAirportCode(data.origin);
        const destinationCode = normalizeAirportCode(data.destination);
        result.bookingData = {
          origin: data.origin || "",
          originCode,
          destination: data.destination || "",
          destinationCode,
          departureDate: data.departureDate || "",
          returnDate: data.returnDate || "",
          tripType: data.returnDate ? "return" : "one-way",
          adults: data.adults || 1,
          children: data.children || 0,
          childAges: data.childAges || [],
          infants: data.infants || 0,
          infantAges: data.infantAges || [],
          passengers: Array.isArray(data.passengers) ? data.passengers : [],
          contactEmail: (data.contact && data.contact.email) || "",
          contactPhone: (data.contact && data.contact.phone) || "",
          // Tramada client the booking is filed against (e.g. "GRAY/SPIDER").
          clientCode: (data.clientCode || "").trim(),
          budget: data.budget || "",
          timePreference: data.timePreference || "any",
          checkedBags: data.checkedBags || "no",
          carryOn: data.carryOn || "7kg",
          seatPreference: data.seatPreference || "no preference",
          insurance: data.insurance || "no",
        };

        // Remove JSON from the text response
        result.text = response
          .replace(/```json[\s\S]*?```/, "")
          .replace(/\{[\s\S]*"origin"[\s\S]*"destination"[\s\S]*\}/, "")
          .trim();
      }
    } catch {
      // JSON parse failed — just send as text
      log("JSON parse failed in Gemini response");
    }
  }

  // Look for quick replies (lines starting with - or *)
  const lines = result.text.split("\n");
  const quickLines = lines.filter(
    (l) => /^[\-\*]\s/.test(l.trim()) && l.trim().length < 40
  );
  if (quickLines.length >= 2 && quickLines.length <= 5) {
    result.quickReplies = quickLines.map((l) =>
      l.trim().replace(/^[\-\*]\s*/, "")
    );
  }

  return result;
}

// ─── Handle PDF upload ───────────────────────────────────────────
async function handlePdfUpload(session, filename, base64Data) {
  const { ws } = session;
  sendToClient(ws, { type: "typing" });

  try {
    // Save PDF temporarily
    const tmpDir = path.join(__dirname, "tmp");
    if (!require("fs").existsSync(tmpDir)) {
      require("fs").mkdirSync(tmpDir, { recursive: true });
    }
    const tmpPath = path.join(tmpDir, filename);
    require("fs").writeFileSync(tmpPath, Buffer.from(base64Data, "base64"));

    // Parse PDF using existing parser
    const { parsePdf, validateBooking, printBookingSummary } = require("./parsePdf");
    const booking = await parsePdf(tmpPath);
    const validation = validateBooking(booking);

    if (validation.valid) {
      session.bookingData = {
        origin: booking.origin || "",
        originCode: booking.originCode || normalizeAirportCode(booking.origin),
        destination: booking.destination || "",
        destinationCode: booking.destinationCode || normalizeAirportCode(booking.destination),
        departureDate: booking.departureDate || "",
        returnDate: booking.returnDate || "",
        tripType: booking.returnDate ? "return" : "one-way",
        adults: booking.adults || 1,
        children: booking.children || 0,
        childAges: booking.childAges || [],
        infants: booking.infants || 0,
        infantAges: booking.infantAges || [],
        passengers: Array.isArray(booking.passengers) ? booking.passengers : [],
        contactEmail: booking.contactEmail || "",
        contactPhone: booking.contactPhone || "",
        budget: booking.budget || "",
        timePreference: "any",
        checkedBags: "no",
        carryOn: "7kg",
        seatPreference: "no preference",
        insurance: "no",
      };

      sendToClient(ws, {
        type: "bot_message",
        text: `📄 Great! I've read your PDF "${filename}" and extracted the booking details:`,
      });
      sendToClient(ws, { type: "summary", booking: session.bookingData });
      sendToClient(ws, {
        type: "bot_message",
        text: "Would you like to adjust any of these details, or shall I start the booking?",
        quickReplies: ["Yes, book it!", "Change something"],
      });
    } else {
      const missing = validation.errors.join(", ");
      sendToClient(ws, {
        type: "bot_message",
        text: `📄 I read your PDF but some details are missing: ${missing}. Let me ask you about those...`,
      });

      // Feed to Gemini to continue conversation
      if (session.geminiChat) {
        const prompt = `The user uploaded a PDF with these extracted details: ${JSON.stringify(booking)}. However these fields are missing or invalid: ${missing}. Please ask the user about the missing details to complete the booking.`;
        const result = await session.geminiChat.sendMessage(prompt);
        sendToClient(ws, { type: "bot_message", text: result.response.text() });
      }
    }

    // Clean up temp file
    require("fs").unlinkSync(tmpPath);
  } catch (err) {
    console.error("PDF parse error:", err.message);
    sendToClient(ws, {
      type: "error",
      text: `Couldn't read that PDF: ${err.message}. Try telling me your booking details instead!`,
    });
  }
}

// ─── Room-Res quote flow ─────────────────────────────────────────
// The conversation itself lives in roomres-chat.js (a pure state machine); this
// is only the part that owns the browser. Each turn: advance the machine, send
// whatever it wants to say, and if it asked for a browser action, run it and
// feed the result back in. Loops because one action's result often leads
// straight into the next (guests → draft, price → quote).

function roomResCallbacks(session) {
  const { ws } = session;
  return {
    onProgress: (pct, m) => session.active && sendToClient(ws, { type: "pipeline_progress", percent: pct, message: m }),
    onStage: (name, d) => session.active && sendToClient(ws, { type: "pipeline_stage", stage: `roomres:${name}`, data: d }),
    onError: () => {}, // reported by the caller, with the step's own wording
    onNeedLogin: () =>
      session.active &&
      sendToClient(ws, {
        type: "bot_message",
        text:
          "🔐 Sign into **Room-Res** (and Tramada) in the Chrome window on port 9222 — " +
          "I'll spot it and carry on. I never type credentials myself.",
      }),
  };
}

// Execute one browser action for the flow. Returns whatever the action produced,
// or `{ error }` — resume() knows how to put the conversation back on its feet.
async function runRoomResAction(session, action) {
  const st = session.roomRes;
  const d = st.data;
  const callbacks = roomResCallbacks(session);
  const auth = { username: process.env.TRAMADA_USERNAME, password: process.env.TRAMADA_PASSWORD };

  switch (action) {
    case "bookingClient":
      return await lookupBookingClient({ ...auth, bookingNo: d.existingBookingNo, callbacks });

    case "draft":
      return await runRoomResDraft({ ...roomResChat.draftArgs(st), callbacks });

    case "quote":
      return await runRoomResQuote({
        itineraryId: d.itineraryId,
        itineraryCode: d.itineraryCode,
        quotedPrice: d.quotedPrice,
        title: `${d.draft.hotelName} — ${d.draft.city}`,
        callbacks,
      });

    case "clients":
      return await findTramadaClients({ ...auth, surname: d.surname, callbacks });

    case "tramada":
      return await runRoomResToTramada({ ...auth, ...roomResChat.tramadaArgs(st), callbacks });

    case "receipt":
      return await runRoomResToTramada({
        ...auth,
        ...roomResChat.tramadaArgs(st),
        existingBookingNo: d.bookingNo || d.existingBookingNo,
        receipt: d.receipt,
        dryRunReceipt: d.dryRunReceipt !== false,
        // The "tramada" action already put the segment on this booking. Without
        // this the receipt step added a duplicate one — and it runs twice
        // (stage, then issue), so it added two.
        receiptOnly: true,
        callbacks,
      });

    default:
      throw new Error(`Unknown Room-Res action: ${action}`);
  }
}

// Run the machine forward from a turn's output until it wants the user again.
// Split out from stepRoomRes so a creditor answer can re-enter mid-flow, at the
// exact action that stopped, without pushing a message through advance().
async function driveRoomRes(session, out) {
  const { ws } = session;

  for (let hop = 0; hop < 8; hop++) {
    session.roomRes = out.state;
    for (const m of out.messages || []) sendToClient(ws, { type: "bot_message", text: m });
    // The Room-Res tab is now held open BETWEEN phases, so the run's browser
    // page outlives a single action — it belongs to the conversation. Release it
    // exactly where the conversation ends, and nowhere else: "waiting on the
    // user" is the case the whole thing exists for, so it must not close there.
    if (!out.state) { await closeRoomResPage().catch(() => {}); return; }   // cancelled
    if (!out.run) return;                                                   // waiting on the user
    if (out.state.step === "done") { await closeRoomResPage().catch(() => {}); return; }

    const action = out.run;
    sendToClient(ws, { type: "typing" });
    let result;
    try {
      result = await runRoomResAction(session, action);
    } catch (err) {
      // Same pause-and-ask as the PDF pipeline: an unmatched creditor stops the
      // run, we ask, and the answer resumes it. Remembering the answer is
      // creditor-aliases' job, and only once the run has actually succeeded.
      // Two questions only the user can answer, both handled the same way: park
      // the action, ask, and re-run the SAME action once the answer lands.
      if (err && err.needsCreditor) {
        session.roomResPending = { action, kind: "creditor", needed: err.needsCreditor };
        sendToClient(ws, {
          type: "bot_message",
          text:
            `✋ I couldn't match a Tramada creditor for ${err.needsCreditor.supplierName || "this hotel"}. ` +
            "Reply with the exact Tramada creditor name and I'll carry on — or say **cancel** to stop. " +
            "(The booking goes against the hotel itself, so this needs to be right.)",
        });
        return;
      }
      if (err && err.needsCity) {
        session.roomResPending = { action, kind: "city", needed: err.needsCity };
        const tried = (err.needsCity.tried || []).join(", ");
        sendToClient(ws, {
          type: "bot_message",
          text:
            `✋ Tramada wouldn't accept a City Code for this hotel — I tried ${tried || "everything I had"}. ` +
            "Room-Res reports the suburb rather than the city, so reply with the Tramada city (e.g. **Sydney** or **SYD**) " +
            "and I'll carry on — or say **cancel** to stop.",
        });
        return;
      }
      result = { error: err.message };
    }
    out = roomResChat.resume(session.roomRes, action, result);
  }

  sendToClient(ws, { type: "bot_message", text: "That's gone around further than expected — stopping here. Say **create quote** to start again." });
  session.roomRes = null;
  await closeRoomResPage().catch(() => {}); // the runaway-loop exit is an end too
}

// Drive the flow from the user's message all the way to its next question.
async function stepRoomRes(session, userText) {
  await driveRoomRes(session, roomResChat.advance(session.roomRes, userText));
}

// Start (or restart) the flow — from the "Create quote" button or the chat.
async function handleRoomResStart(session) {
  const { ws } = session;
  session.roomResPending = null;
  // A new run must not inherit the previous run's tab — that one is parked on
  // someone else's itinerary.
  await closeRoomResPage().catch(() => {});
  const started = roomResChat.startQuoteFlow();
  session.roomRes = started.state;
  for (const m of started.messages) sendToClient(ws, { type: "bot_message", text: m });
}

// The user has answered the creditor question. Put the name on the flow's data
// so tramadaArgs() carries it, then re-run the action that stopped — not the
// next one, and not through advance(), because the conversation never moved on.
async function resumeRoomResPending(session, reply) {
  const pending = session.roomResPending;
  session.roomResPending = null;
  if (!session.roomRes) {
    sendToClient(session.ws, { type: "bot_message", text: "That flow has already finished — say **create quote** to start another." });
    return;
  }
  if (pending.kind === "city") session.roomRes.data.cityCode = reply;
  else session.roomRes.data.creditor = reply;
  await driveRoomRes(session, { state: session.roomRes, messages: [], run: pending.action });
}

// ─── Handle RAA itinerary PDF → Tramada (segments + costings + EFT receipt) ──
// Apply user-supplied creditor overrides (by segment/line kind) to the parsed data.
function applyPdfCreditors(data, creditors) {
  if (!creditors) return;
  for (const s of data.segments || []) if (creditors[s.kind]) s.creditor = creditors[s.kind];
  for (const l of data.costingLines || []) if (creditors[l.kind]) l.creditor = creditors[l.kind];
}

function pdfPipelineCallbacks(session) {
  const { ws } = session;
  return {
    onProgress: (pct, m) => session.active && sendToClient(ws, { type: "pipeline_progress", percent: pct, message: m }),
    onStage: (name, d) => session.active && sendToClient(ws, { type: "pipeline_stage", stage: name, data: d }),
    onError: (m) => session.active && sendToClient(ws, { type: "error", text: `Tramada: ${m}` }),
    onNeedLogin: () =>
      session.active &&
      sendToClient(ws, {
        type: "bot_message",
        text: "🔐 Sign into Tramada in the Chrome window on port 9222 (from `npm run start:chrome`) — I'll detect it and continue.",
      }),
  };
}

// Run one PDF pipeline stage and handle the outcome — including the "needs
// creditor" PAUSE: when a creditor can't be resolved, we stop, remember the run
// context in session.pendingCreditor, and ask the user. Their next chat message
// is taken as the creditor and the run resumes (see handleUserMessage).
async function executePdfRun(session, data, opts) {
  const { ws } = session;
  const cb = pdfPipelineCallbacks(session);
  delete cb.onError; // this function reports errors itself (avoids a duplicate line)
  try {
    const result = await runPdfBooking({
      username: process.env.TRAMADA_USERNAME,
      password: process.env.TRAMADA_PASSWORD,
      data,
      includeServiceFee: opts.includeServiceFee,
      dryRunReceipt: opts.dryRunReceipt !== false,
      forceClient: !!opts.forceClient,
      callbacks: cb,
    });
    session.currentBookingNo = result.bookingNo;
    session.pendingCreditor = null;
    const nSeg = result.segments.length, nCost = result.costingLines.length;

    if (result.clientMismatch) {
      const who = (result.header && (result.header.client || result.header.clientName)) || "a different client";
      sendToClient(ws, {
        type: "bot_message",
        text: `ℹ️ Booking ${result.bookingNo} is ${who} — different from the PDF (${(data.passengers || []).join(", ")}). I used booking ${result.bookingNo}'s client, as you asked.`,
      });
    }

    if (result.receiptSkipped) {
      session.pendingPdf = null;
      session.pendingPdfIssue = null;
      const did = [nSeg ? `added ${nSeg} segment(s)` : "", nCost ? `added ${nCost} costing line(s)` : ""].filter(Boolean).join(" and ");
      sendToClient(ws, {
        type: "bot_message",
        text: result.nothingToDo
          ? `Booking ${result.bookingNo} already has everything and is fully receipted (balance ${Number(result.balance).toFixed(2)}). Nothing to do. ✅`
          : `${did ? did.charAt(0).toUpperCase() + did.slice(1) + " on " : ""}booking ${result.bookingNo}; no outstanding balance, so no EFT receipt was needed. ✅`,
      });
      return;
    }

    session.pendingPdf = { data, filename: `PDF-${result.bookingNo}` };
    session.pendingPdfIssue = { includeServiceFee: opts.includeServiceFee, forceClient: !!opts.forceClient };
    sendToClient(ws, { type: "pdf_receipt_preview", result, receipt: data.receipt });
    sendToClient(ws, {
      type: "bot_message",
      text:
        `Segments and costings are in for booking ${result.bookingNo}. The EFT receipt for ` +
        `$${data.receipt.amount} (ref ${data.receipt.reference}, allocate all) is staged but NOT issued. ` +
        `Hit "Issue EFT receipt" to commit it.`,
    });
  } catch (err) {
    if (err && err.needsCreditor) {
      // PAUSE — remember where to resume, then ask the user for the creditor.
      session.pendingCreditor = { needed: err.needsCreditor, data, opts };
      const n = err.needsCreditor;
      sendToClient(ws, {
        type: "bot_message",
        text:
          `✋ I couldn't match a Tramada creditor for the ${n.kind}${n.supplierName ? ` "${n.supplierName}"` : ""}. ` +
          `Reply with the exact Tramada creditor name to use (it must be a creditor that exists in Tramada) and I'll continue — or say "cancel" to stop.`,
      });
      return;
    }
    const needsLogin = /not logged in|log into tramada|login/i.test(err.message || "");
    sendToClient(ws, { type: "error", text: `PDF run failed: ${err.message}` });
    sendToClient(ws, {
      type: "bot_message",
      text: needsLogin
        ? "Sign into Tramada in the port-9222 Chrome window, then say **retry**."
        : "Say **retry** to run it again — it skips whatever already saved — or tell me what to change.",
    });
  }
}

async function handleTramadaPdfUpload(session, msg) {
  const { ws } = session;
  const stage = msg.stage || "parse";

  try {
    // Step 1 — parse the uploaded PDF and show the extraction card.
    if (stage === "parse") {
      sendToClient(ws, { type: "typing" });
      const buf = Buffer.from(msg.data, "base64");
      const data = await parseRaaItineraryBuffer(buf);
      if (!data.bookingNo) {
        sendToClient(ws, {
          type: "error",
          text: "Couldn't find a booking number (BPAY Ref) in that PDF. Is it an RAA itinerary/costing confirmation?",
        });
        return;
      }
      session.pendingPdf = { data, filename: msg.filename };
      session.lastPdf = data; // persist for follow-up questions ("use this PDF for booking N")
      sendToClient(ws, { type: "pdf_extract", filename: msg.filename, data });
      const warn = (data.warnings || []).length ? ` (⚠ ${data.warnings.length} warning(s) — see card)` : "";
      sendToClient(ws, {
        type: "bot_message",
        text:
          `📄 Read "${msg.filename}". Booking ${data.bookingNo}, EFT total $${data.receipt.amount}${warn}. ` +
          `Check the details and creditors on the card, then hit “Create in Tramada”.`,
      });
      return;
    }

    // Steps 2 & 3 need the staged parse.
    if (!session.pendingPdf) {
      sendToClient(ws, { type: "error", text: "Upload the itinerary PDF again — I don't have it staged." });
      return;
    }
    const data = session.pendingPdf.data;
    applyPdfCreditors(data, msg.creditors);
    const includeServiceFee = !!msg.includeServiceFee;

    // Step 2 — create segments + costings, STAGE (don't commit) the EFT receipt.
    if (stage === "create") {
      sendToClient(ws, { type: "bot_message", text: "On it — adding segments and costings, and staging the EFT receipt. Progress below." });
      await executePdfRun(session, data, { includeServiceFee, dryRunReceipt: true, forceClient: false });
      return;
    }

    // Step 3 — issue the EFT receipt. runPdfBooking is idempotent: it skips the
    // segments/costings created in step 2 and just issues the receipt.
    if (stage === "issue") {
      sendToClient(ws, { type: "bot_message", text: "Issuing the EFT receipt now…" });
      const result = await runPdfBooking({
        username: process.env.TRAMADA_USERNAME,
        password: process.env.TRAMADA_PASSWORD,
        data,
        includeServiceFee: (session.pendingPdfIssue && session.pendingPdfIssue.includeServiceFee) || includeServiceFee,
        dryRunReceipt: false, // commit
        forceClient: !!(session.pendingPdfIssue && session.pendingPdfIssue.forceClient),
        callbacks: pdfPipelineCallbacks(session),
      });
      session.currentBookingNo = result.bookingNo;
      session.pendingPdf = null;
      session.pendingPdfIssue = null;
      sendToClient(ws, { type: "pipeline_complete", result });
      const rc = result.receipt && result.receipt.receipt;
      sendToClient(ws, {
        type: "bot_message",
        text: rc
          ? `✅ Done — booking ${result.bookingNo}, EFT receipt ${rc.receiptNo} for ${rc.amount} (allocated ${rc.allocated}).`
          : result.receiptSkipped
          ? `✅ Booking ${result.bookingNo} is up to date — no EFT receipt was needed (${result.receiptSkipReason}).`
          : `✅ Done — booking ${result.bookingNo} updated.`,
      });
      return;
    }

    sendToClient(ws, { type: "error", text: `Unknown PDF stage "${stage}".` });
  } catch (err) {
    console.error("Tramada PDF error:", err.message);
    const needsLogin = /not logged in|log into tramada|login/i.test(err.message);
    sendToClient(ws, { type: "error", text: `PDF run failed: ${err.message}` });
    sendToClient(ws, {
      type: "bot_message",
      text: needsLogin
        ? "Sign into Tramada in the port-9222 Chrome window, then hit the button again — it resumes and skips whatever already saved."
        : "A re-run is safe — it skips anything already created. Fix the issue above (e.g. a creditor that didn't match) and try again.",
    });
  }
}

// Apply the last-uploaded PDF to a DIFFERENT booking number (from a chat
// follow-up like "use the same PDF for 12806"). runPdfBooking's client-match
// guard stops safely if that booking belongs to a different client.
async function runPdfForBooking(session, targetBooking) {
  const { ws } = session;
  const src = session.lastPdf;
  if (!src) {
    sendToClient(ws, { type: "bot_message", text: "I don't have a PDF staged — upload one first." });
    return;
  }
  const data = { ...src, bookingNo: String(targetBooking), receipt: { ...src.receipt } };
  sendToClient(ws, {
    type: "bot_message",
    text: `Applying the uploaded PDF (originally booking ${src.bookingNo}) to booking ${targetBooking} using booking ${targetBooking}'s OWN client, and staging the EFT receipt without committing.`,
  });
  // executePdfRun handles the outcome AND the "needs creditor" pause/resume.
  await executePdfRun(session, data, { includeServiceFee: false, dryRunReceipt: true, forceClient: true });
  return;
}

// ─── Start automation ────────────────────────────────────────────
async function startAutomation(session) {
  if (session.automationRunning) {
    sendToClient(session.ws, {
      type: "bot_message",
      text: "Automation is already running. Please wait...",
    });
    return;
  }

  session.automationRunning = true;

  const steps = [
    "Navigate to Jetstar",
    "Search for flights",
    "Select departure flight",
    "Select return flight",
    "Select baggage",
    "Handle seats",
    "Skip extras",
    "Reach booking details",
  ];

  // Send initial progress card
  sendToClient(session.ws, { type: "progress", steps, currentStep: 0 });

  try {
    await runJetstarBooking({
      booking: session.bookingData,
      callbacks: {
        onStep: (stepIndex, message) => {
          if (!session.active) return;
          sendToClient(session.ws, { type: "progress", steps, currentStep: stepIndex });
          sendToClient(session.ws, { type: "automation_update", text: message });
        },
        onError: (message) => {
          if (!session.active) return;
          sendToClient(session.ws, { type: "error", text: message });
        },
        onItinerary: (itinerary, savedPath) => {
          if (!session.active) return;
          // Stash on the session so the Tramada chain step can pick up the booking
          // without the client having to round-trip it back.
          session.lastItinerary = itinerary;
          session.lastItineraryPath = savedPath;
          sendToClient(session.ws, { type: "itinerary", itinerary, savedPath });
          // Prompt the user for Tramada credentials right after the itinerary card.
          sendToClient(session.ws, {
            type: "tramada_prompt",
            clientCode: (session.bookingData && session.bookingData.clientCode) || "",
          });
        },
        onComplete: (message) => {
          if (!session.active) return;
          sendToClient(session.ws, {
            type: "progress",
            steps,
            currentStep: steps.length,
          });
          sendToClient(session.ws, { type: "automation_complete", text: message });
        },
      },
    });
  } catch (err) {
    console.error("Automation error:", err);
    sendToClient(session.ws, {
      type: "error",
      text: `Automation failed: ${err.message}`,
    });
  } finally {
    session.automationRunning = false;
  }
}

// ─── Handle the Jetstar→Tramada chain (add + search) ────────────
async function handleTramadaChain(session, username, password, clientCode) {
  const { ws } = session;

  // Fall back to the client the user gave Gemini during the chat.
  const client =
    (clientCode || "").trim() ||
    ((session.bookingData && session.bookingData.clientCode) || "").trim();

  if (!username || !password || !client) {
    sendToClient(ws, {
      type: "error",
      text: "Tramada username, password, and client code are all required.",
    });
    return;
  }

  const booking = (session.lastItinerary && session.lastItinerary.booking) || session.bookingData;
  if (!booking || !booking.departureDate) {
    sendToClient(ws, {
      type: "error",
      text: session.skipJetstar
        ? "No booking details in session yet — tell me your trip details first."
        : "No Jetstar itinerary in session yet — run the booking first.",
    });
    return;
  }

  sendToClient(ws, { type: "bot_message", text: "Starting Tramada add + search..." });

  try {
    const result = await runTramadaAddAndSearch({
      username,
      password,
      clientCode: client,
      booking,
      callbacks: {
        onProgress: (pct, msg) => {
          if (!session.active) return;
          sendToClient(ws, { type: "tramada_progress", percent: pct, message: msg });
        },
        onError: (err) => {
          if (!session.active) return;
          sendToClient(ws, { type: "error", text: `Tramada error: ${err}` });
        },
        onAddComplete: (addResult) => {
          if (!session.active) return;
          sendToClient(ws, { type: "tramada_add_complete", data: addResult });
        },
        onSearchComplete: (rows) => {
          if (!session.active) return;
          sendToClient(ws, { type: "tramada_results", data: rows });
        },
      },
    });

    sendToClient(ws, { type: "tramada_complete", data: result });
  } catch (err) {
    sendToClient(ws, { type: "error", text: `Tramada chain failed: ${err.message}` });
  }
}

// ─── Handle Tramada search via WebSocket ────────────────────────
async function handleTramadaSearch(session, username, password) {
  const { ws } = session;

  if (!username || !password) {
    sendToClient(ws, { type: "error", text: "Tramada username and password are required" });
    return;
  }

  sendToClient(ws, { type: "bot_message", text: "Starting Tramada booking search..." });

  try {
    const result = await runTramadaAutomation(
      { username, password },
      {
        onProgress: (pct, msg) => {
          if (!session.active) return;
          sendToClient(ws, { type: "tramada_progress", percent: pct, message: msg });
        },
        onComplete: (data) => {
          if (!session.active) return;
          sendToClient(ws, { type: "tramada_complete", data });
        },
        onError: (err) => {
          if (!session.active) return;
          sendToClient(ws, { type: "error", text: `Tramada error: ${err.message}` });
        },
      }
    );

    sendToClient(ws, { type: "tramada_results", data: result });
  } catch (err) {
    sendToClient(ws, { type: "error", text: `Tramada search failed: ${err.message}` });
  }
}

// ─── Receipt: search bookings (req 5 — no booking number given) ──
async function handleReceiptSearch(session, msg) {
  const { ws } = session;
  try {
    sendToClient(ws, { type: "bot_message", text: "Searching bookings..." });
    const bookings = await searchBookingsForReceipt({
      username: msg.username,
      password: msg.password,
      status: msg.status,          // optional: NEW|QUOTE|BOOKED|FINALISED|CANCELLED
      clientName: msg.clientName,  // optional filter
      bookingNo: msg.bookingNo,    // optional filter
    });
    sendToClient(ws, { type: "receipt_booking_list", bookings });
    if (!bookings.length) {
      sendToClient(ws, {
        type: "bot_message",
        text: "No bookings matched. Try a client name or a different status.",
      });
    }
  } catch (err) {
    sendToClient(ws, { type: "error", text: `Booking search failed: ${err.message}` });
  }
}

// ─── Receipt: preview then commit (confirm-before-commit gate) ───
async function handleReceiptRun(session, msg) {
  const { ws } = session;

  const bookingNo = msg.bookingNo;
  const receipt = msg.receipt || {};
  const confirmed = msg.confirmed === true;

  if (!bookingNo) {
    sendToClient(ws, { type: "error", text: "Booking number is required to raise a receipt." });
    return;
  }
  if (!receipt.reference) {
    sendToClient(ws, { type: "error", text: "Receipt reference is required." });
    return;
  }

  const callbacks = {
    onProgress: (pct, m) => {
      if (session.active) sendToClient(ws, { type: "receipt_progress", percent: pct, message: m });
    },
    onError: (m) => {
      if (session.active) sendToClient(ws, { type: "error", text: `Receipt error: ${m}` });
    },
  };

  try {
    const result = await runTramadaReceipt({
      username: msg.username,
      password: msg.password,
      bookingNo,
      receipt,
      dryRun: !confirmed, // preview unless explicitly confirmed
      callbacks,
    });

    if (!confirmed) {
      // Show the staged receipt + booking details and ask the user to confirm.
      sendToClient(ws, {
        type: "receipt_preview",
        details: result.details,
        staged: result.staged,
        segments: result.segments,
        previewImage: result.previewImage || null,
      });
      sendToClient(ws, {
        type: "bot_message",
        text:
          `Ready to issue this receipt on booking ${bookingNo}: ` +
          `${result.staged.amount} (ref ${result.staged.reference}). ` +
          `Confirm to commit — nothing has been saved yet.`,
        quickReplies: ["Yes, issue it", "Cancel"],
      });
      return;
    }

    // Committed.
    sendToClient(ws, { type: "receipt_complete", receipt: result.receipt, details: result.details });
    sendToClient(ws, {
      type: "bot_message",
      text: result.receipt
        ? `Done ✅ Receipt ${result.receipt.receiptNo} issued for ${result.receipt.amount} ` +
          `(ref ${result.receipt.reference}), allocated ${result.receipt.allocated}.`
        : "Receipt issued.",
    });
  } catch (err) {
    sendToClient(ws, { type: "error", text: `Receipt failed: ${err.message}` });
  }
}

// ─── Full pipeline: booking → segments → costing → receipt ───────
async function handlePipelineRun(session, msg) {
  const { ws } = session;
  const confirmed = msg.confirmed === true;

  if (!msg.clientCode || !msg.booking) {
    sendToClient(ws, { type: "error", text: "clientCode and booking are required to run the pipeline." });
    return;
  }
  if (!msg.receipt || !msg.receipt.reference) {
    sendToClient(ws, { type: "error", text: "receipt.reference is required." });
    return;
  }

  try {
    const result = await runFullBooking({
      username: msg.username,
      password: msg.password,
      clientCode: msg.clientCode,
      booking: msg.booking,
      segments: msg.segments || [],
      costings: msg.costings || [],
      receipt: msg.receipt,
      dryRunReceipt: !confirmed, // preview the receipt unless confirmed
      callbacks: {
        onProgress: (pct, m) => {
          if (session.active) sendToClient(ws, { type: "pipeline_progress", percent: pct, message: m });
        },
        onError: (m) => {
          if (session.active) sendToClient(ws, { type: "error", text: `Pipeline error: ${m}` });
        },
        onStage: (name, data) => {
          if (session.active) sendToClient(ws, { type: "pipeline_stage", stage: name, data });
        },
      },
    });

    if (!confirmed) {
      sendToClient(ws, {
        type: "pipeline_preview",
        bookingNo: result.bookingNo,
        staged: result.receipt && result.receipt.staged,
        previewImage: result.receipt && result.receipt.previewImage,
      });
      sendToClient(ws, {
        type: "bot_message",
        text:
          `Booking ${result.bookingNo} created with its segments and costing. ` +
          `Receipt is staged (${msg.receipt.amount}, ref ${msg.receipt.reference}) but NOT committed. Confirm to issue it.`,
        quickReplies: ["Yes, issue it", "Cancel"],
      });
      return;
    }

    sendToClient(ws, { type: "pipeline_complete", result });
    sendToClient(ws, {
      type: "bot_message",
      text: result.receipt && result.receipt.receipt
        ? `Done ✅ Booking ${result.bookingNo}, receipt ${result.receipt.receipt.receiptNo} issued.`
        : `Done ✅ Booking ${result.bookingNo} — pipeline complete.`,
    });
  } catch (err) {
    sendToClient(ws, { type: "error", text: `Pipeline failed: ${err.message}` });
  }
}

// ─── Pipeline chat helpers ───────────────────────────────────────
// Remove any JSON (fenced or bare, even if truncated/unclosed) from display text.
function stripJson(t) {
  if (!t) return t;
  return String(t)
    .replace(/```[\s\S]*$/g, "")              // any code fence to end (handles unclosed)
    .replace(/\{[\s\S]*"intent"[\s\S]*$/g, "") // bare JSON fragment to end
    .trim();
}

// Pull a {"intent":"pipeline", ...} JSON block out of a Gemini reply.
// Pull any assistant intent out of a Gemini reply.
// kinds: "list" (list_bookings) | "open" (open_booking) | "run" (run/pipeline).
function parseAssistantIntent(response) {
  const candidates = [];
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const bare = response.match(/\{[\s\S]*"intent"\s*:\s*"[a-z_]+"[\s\S]*\}/i);
  if (bare) candidates.push(bare[0]);
  for (const c of candidates) {
    try {
      const data = JSON.parse(c);
      if (!data || !data.intent) continue;
      if (data.intent === "list_bookings") return { kind: "list", data, text: stripJson(response) };
      if (data.intent === "open_booking" && data.bookingNo) return { kind: "open", data, text: stripJson(response) };
      if (
        (data.intent === "run" || data.intent === "pipeline") &&
        (data.booking || data.existingBookingNo || data.segments || data.costings || data.receipt)
      ) {
        return { kind: "run", data, text: stripJson(response) };
      }
    } catch { /* try next candidate */ }
  }
  return { kind: null, data: null, text: response };
}

// Handle one Gemini reply in assistant mode: relay the human text, execute any
// intent, feed the result back as [SYSTEM], and process the follow-up reply.
async function handleAssistantResponse(session, response, depth) {
  const { ws } = session;
  let parsed = parseAssistantIntent(response);

  // JSON present but unparseable (truncated) → ask for a compact re-emit once.
  if (!parsed.kind && /"intent"\s*:/.test(response)) {
    try {
      const retry = await session.geminiChat.sendMessage(
        "[SYSTEM] Your last JSON was cut off. Output ONLY that intent JSON again, minified on a single line, no code fences, no other text."
      );
      parsed = parseAssistantIntent(retry.response.text());
    } catch { /* fall through */ }
  }

  const human = stripJson(parsed.text || response);
  if (!parsed.kind) {
    sendToClient(ws, { type: "bot_message", text: human || response });
    return;
  }
  if (human) sendToClient(ws, { type: "bot_message", text: human });
  if (depth >= 3) {
    sendToClient(ws, { type: "bot_message", text: "Let me pause here — tell me what you'd like to do next." });
    return;
  }

  const creds = { username: process.env.TRAMADA_USERNAME, password: process.env.TRAMADA_PASSWORD };
  const needLoginMsg = () =>
    session.active &&
    sendToClient(ws, {
      type: "bot_message",
      text: "🔐 Please sign into Tramada in the port-9222 Chrome window (including OTP) — I'll pick it up and continue automatically.",
    });

  if (parsed.kind === "list") {
    try {
      const bookings = await searchBookingsForReceipt({
        ...creds,
        clientName: (parsed.data.clientName || "").trim() || undefined,
      });
      sendToClient(ws, { type: "booking_list", bookings });
      const lines =
        bookings.slice(0, 15).map((b) => `${b.bookingNo} ${b.clientName} ${b.itinerary} dep ${b.depDate}`).join("; ") ||
        "none found";
      const r = await session.geminiChat.sendMessage(
        `[SYSTEM] ${bookings.length} bookings are now shown to the user in a card: ${lines}. Briefly ask which booking number to open (or offer a client-name search if the list is empty).`
      );
      await handleAssistantResponse(session, r.response.text(), depth + 1);
    } catch (err) {
      sendToClient(ws, { type: "error", text: `Couldn't list bookings: ${err.message}` });
    }
    return;
  }

  if (parsed.kind === "open") {
    const no = String(parsed.data.bookingNo || "").replace(/\D/g, "");
    if (!no) {
      sendToClient(ws, { type: "bot_message", text: "Which booking number should I open?" });
      return;
    }
    try {
      const state = await runReadBookingState({
        ...creds,
        bookingNo: no,
        callbacks: { onNeedLogin: needLoginMsg },
      });
      session.currentBookingNo = no;
      sendToClient(ws, { type: "booking_state", state });
      const h = state.header || {};
      const segLine = state.segments.map((s) => `${s.segType} ${s.reference}`).join(", ") || "none";
      const costLine = state.costings.map((c) => `${c.segType}=${c.dueIncGst}`).join(", ") || "none";
      const rcptLine =
        state.receipts.map((r2) => `${r2.receiptNo} ${r2.amount} (alloc ${r2.allocated})`).join(", ") || "none";
      const r = await session.geminiChat.sendMessage(
        `[SYSTEM] Booking ${no} opened; a full state card is already visible to the user — don't repeat it line by line. ` +
          `client=${h.client}; itinerary=${h.itinerary}; dep=${h.depDate}; segments: ${segLine}; costings: ${costLine}; ` +
          `receipts: ${rcptLine}; totalDue=${h.totalDue}; receipted=${h.receipted}; balance=${h.balance}. ` +
          `Give a one-sentence read of where this booking stands and ask what they'd like to do.`
      );
      await handleAssistantResponse(session, r.response.text(), depth + 1);
    } catch (err) {
      sendToClient(ws, { type: "error", text: `Couldn't open booking ${no}: ${err.message}` });
    }
    return;
  }

  // kind === "run"
  await runPipelineFromChat(session, parsed.data);
}

// Run the whole pipeline from a confirmed chat intent, streaming progress.
async function runPipelineFromChat(session, intent) {
  const { ws } = session;

  // If the model targeted "the current booking" implicitly, use the one opened
  // earlier in this conversation.
  if (!intent.existingBookingNo && !intent.booking && session.currentBookingNo) {
    intent.existingBookingNo = session.currentBookingNo;
  }

  sendToClient(ws, { type: "bot_message", text: "On it — recording this in Tramada now. Progress below." });
  try {
    const result = await runFullBooking({
      username: process.env.TRAMADA_USERNAME,
      password: process.env.TRAMADA_PASSWORD,
      clientCode: intent.clientCode,
      booking: intent.booking,
      existingBookingNo: intent.existingBookingNo || null,
      segments: intent.segments || [],
      costings: intent.costings || [],
      receipt: intent.receipt || null,
      dryRunReceipt: false, // the user already confirmed in chat
      callbacks: {
        onProgress: (pct, m) => session.active && sendToClient(ws, { type: "pipeline_progress", percent: pct, message: m }),
        onStage: (name, data) => session.active && sendToClient(ws, { type: "pipeline_stage", stage: name, data }),
        onError: (m) => session.active && sendToClient(ws, { type: "error", text: `Tramada: ${m}` }),
        // Not logged in → tell the user and WAIT (the automation polls up to 5 min).
        onNeedLogin: () =>
          session.active &&
          sendToClient(ws, {
            type: "bot_message",
            text: "🔐 I need you signed into Tramada in the Chrome window on port 9222 (the one `npm run start:chrome` opened). Log in there now — I'll detect it and continue automatically.",
          }),
      },
    });
    session.currentBookingNo = result.bookingNo;
    const rc = result.receipt && result.receipt.receipt;
    sendToClient(ws, { type: "pipeline_complete", result });

    const outcome = rc
      ? `booking ${result.bookingNo}, receipt ${rc.receiptNo} for ${rc.amount} (allocated ${rc.allocated})`
      : `booking ${result.bookingNo} updated (no receipt this run)`;
    // Let the model phrase the confirmation and the "anything else?" follow-up.
    try {
      const r = await session.geminiChat.sendMessage(
        `[SYSTEM] Run complete: ${outcome}. Confirm this to the user in one short sentence and ask if there's anything else.`
      );
      sendToClient(ws, { type: "bot_message", text: stripJson(r.response.text()) || `Done — ${outcome}.` });
    } catch {
      sendToClient(ws, { type: "bot_message", text: `Done — ${outcome}.` });
    }
  } catch (err) {
    // Keep the collected details so the user can retry without re-entering.
    session.pendingPipeline = intent;
    sendToClient(ws, { type: "error", text: `Run failed: ${err.message}` });
    const needsLogin = /not logged in|log into tramada|login/i.test(err.message);
    sendToClient(ws, {
      type: "bot_message",
      text: needsLogin
        ? "Everything you entered is saved. Sign into Tramada in the port-9222 Chrome window, then say **retry** and I'll run the same job again."
        : "Everything you entered is saved — say **retry** to run it again, or tell me what to change.",
    });
  }
}

// ─── Helper: send JSON to client ─────────────────────────────────
function sendToClient(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Tramada REST API endpoint ─────────────────────────────────
app.post("/api/tramada/search-booked", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    const result = await runTramadaAutomation(
      { username, password },
      {
        onProgress: (pct, msg) => {
          log(`[tramada ${pct}%] ${msg}`);
        },
      }
    );
    res.json(result);
  } catch (err) {
    console.error("[tramada] API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve Tramada UI page
app.get("/tramada", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "tramada.html"));
});

// ─── Start server ────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`
╔════════════════════════════════════════════════╗
║    ✈️  Jetstar Booking Chatbot — v6.0          ║
║    🌐 http://localhost:${PORT}                  ║
║    📡 WebSocket: ws://localhost:${PORT}/ws       ║
╚════════════════════════════════════════════════╝
  `);
  // Marker so you can confirm THIS build is running after a restart.
  console.log("🧾 PDF pipeline: build 2026-07-28a — plus the Room-Res \"create quote\" flow (hotel quote → Tramada segment → receipt)\n");

  if (!GEMINI_API_KEY || GEMINI_API_KEY === "your-gemini-api-key-here") {
    console.log("⚠️  Set GEMINI_API_KEY in .env to enable AI chat\n");
  } else {
    console.log("✅ Gemini AI ready\n");
  }

  // ── Check shared CDP Chrome (for both Jetstar + Tramada automation) ──
  const cdpHost = process.env.CDP_HOST || "127.0.0.1";
  const cdpPort = process.env.CDP_PORT || "9222";
  let cdpOk = false;
  try {
    const res = await fetch(`http://${cdpHost}:${cdpPort}/json/version`);
    cdpOk = res.ok;
  } catch { /* not running */ }

  if (cdpOk) {
    console.log(`✅ CDP Chrome reachable at ${cdpHost}:${cdpPort}`);
    console.log("   Jetstar + Tramada automation will share this Chrome.\n");
  } else {
    console.log(`⚠️  No CDP Chrome at ${cdpHost}:${cdpPort}`);
    console.log("   Start it before triggering automation:");
    console.log("     npm run start:chrome");
    console.log("   First run: manually browse jetstar.com once in that window to warm cookies.\n");
  }
});
