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

// ─── Config ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEBUG = process.env.DEBUG === "true";
// Skip the Jetstar browser automation and go straight from chat → Tramada.
// Tramada only needs chat-collected fields, so nothing from Jetstar is required.
const SKIP_JETSTAR = process.env.SKIP_JETSTAR === "true";
// Full "from the top" mode: chat collects booking→segments→costing→receipt and
// the assistant runs the whole Tramada pipeline (tramada-segments.runFullBooking).
const PIPELINE_MODE = process.env.PIPELINE_MODE === "true";

function log(...args) {
  if (DEBUG) console.log("[server]", ...args);
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

wss.on("connection", (ws) => {
  console.log("🔌 Client connected");
  const session = createSession(ws);

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
  if (PIPELINE_MODE) {
    sendToClient(ws, {
      type: "bot_message",
      text: "Hi — I can create a new booking in Tramada, open an existing one to add segments, costings or receipts, or take an RAA itinerary PDF and build it out for you (segments, costings and the EFT receipt). Pick an option below, or use the 📎 button to upload a PDF.",
      quickReplies: ["Create new booking", "Browse existing bookings", "📎 Upload itinerary PDF"],
    });
  } else {
    sendToClient(ws, {
      type: "bot_message",
      text: SKIP_JETSTAR
        ? "G'day! ✈️ I'm your travel booking assistant. Tell me the trip details and I'll record the booking in Tramada — or upload a booking PDF if you have one ready!"
        : "G'day! ✈️ I'm your Jetstar booking assistant. I can help you find and book flights on Jetstar. Just tell me where you'd like to go, or upload a booking PDF if you have one ready!",
      quickReplies: ["Book a flight", "Upload PDF"],
    });
  }
});

// ─── Session management ──────────────────────────────────────────
function createSession(ws) {
  return {
    ws,
    active: true,
    chatHistory: [],          // Gemini conversation history
    bookingData: null,        // Extracted booking JSON
    automationRunning: false,
    geminiChat: null,         // Gemini chat session
  };
}

// ─── Gemini AI setup ─────────────────────────────────────────────
function getGeminiChat() {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "your-gemini-api-key-here") {
    return null;
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: PIPELINE_MODE
      ? buildAssistantPrompt()
      : buildSystemPrompt({ skipJetstar: SKIP_JETSTAR }),
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

// ─── Process user text messages through Gemini ───────────────────
async function handleUserMessage(session, userText) {
  const { ws } = session;

  // Show typing indicator
  sendToClient(ws, { type: "typing" });

  // ── Pipeline mode: run the whole booking→segments→costing→receipt chain ──
  if (PIPELINE_MODE) {
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
    if (SKIP_JETSTAR) {
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
      session.geminiChat = getGeminiChat();
    }

    // Send user message to Gemini. If a PDF was uploaded this session, prepend
    // its context so follow-up questions ("what's in the PDF", "use it for X")
    // are understood instead of getting a blank greeting.
    let toSend = userText;
    if (PIPELINE_MODE && session.lastPdf) {
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
    if (PIPELINE_MODE) {
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
      text: SKIP_JETSTAR
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
  console.log("🧾 PDF pipeline: build 2026-07-27f — stops & asks you for a creditor when it cannot match one\n");

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
