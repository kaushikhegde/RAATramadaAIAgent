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
const { buildSystemPrompt, buildPipelinePrompt } = require("./geminiPrompt");
const { runTramadaAutomation } = require("./tramada-automator");
const { runTramadaAddAndSearch } = require("./tramada-booking");
const { runTramadaReceipt, searchBookingsForReceipt } = require("./tramada-receipt");
const { runFullBooking } = require("./tramada-segments");

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
  sendToClient(ws, {
    type: "bot_message",
    text: SKIP_JETSTAR
      ? "G'day! ✈️ I'm your travel booking assistant. Tell me the trip details and I'll record the booking in Tramada — or upload a booking PDF if you have one ready!"
      : "G'day! ✈️ I'm your Jetstar booking assistant. I can help you find and book flights on Jetstar. Just tell me where you'd like to go, or upload a booking PDF if you have one ready!",
    quickReplies: ["Book a flight", "Upload PDF"],
  });
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
      ? buildPipelinePrompt()
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

    // Send user message to Gemini
    const result = await session.geminiChat.sendMessage(userText);
    const response = result.response.text();

    // Pipeline mode: look for the {"intent":"pipeline"} JSON. If present, stage
    // it and ask the user to confirm; otherwise just relay the chat.
    if (PIPELINE_MODE) {
      let pipe = parsePipelineIntent(response);
      // JSON started but didn't parse (e.g. truncated) → ask Gemini to re-emit
      // it compact, so a broken block is never shown or left half-run.
      if (!pipe.intent && /"intent"\s*:\s*"pipeline"/.test(response)) {
        sendToClient(ws, { type: "bot_message", text: "Finalising your booking — one sec…" });
        try {
          const retry = await session.geminiChat.sendMessage(
            "Output ONLY the pipeline JSON object again, minified on a single line, no code fences, no other text."
          );
          pipe = parsePipelineIntent(retry.response.text());
        } catch { /* fall through */ }
      }
      if (pipe.intent) {
        const human = stripJson(pipe.text);
        if (human) sendToClient(ws, { type: "bot_message", text: human });
        sendToClient(ws, { type: "bot_message", text: summarizePipeline(pipe.intent) });
        await runPipelineFromChat(session, pipe.intent);
        return;
      }
      // No JSON — normal chat. Never show a raw/partial JSON fragment.
      sendToClient(ws, { type: "bot_message", text: stripJson(response) || response });
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
function parsePipelineIntent(response) {
  const candidates = [];
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const bare = response.match(/\{[\s\S]*"intent"\s*:\s*"pipeline"[\s\S]*\}/);
  if (bare) candidates.push(bare[0]);
  for (const c of candidates) {
    try {
      const data = JSON.parse(c);
      if (data && data.intent === "pipeline" && data.clientCode && data.receipt) {
        return { intent: data, text: stripJson(response) };
      }
    } catch { /* try next candidate */ }
  }
  return { intent: null, text: response };
}

function summarizePipeline(p) {
  const segs = (p.segments || [])
    .map((s) => (s.kind === "flight" ? `✈️ ${s.airline} ${s.flightNumber} ${s.fromCity}→${s.toCity}` : `🏨 ${s.hotelSupplier || s.hotelName} (${s.nights}n @ ${s.rate})`))
    .join("  ·  ");
  return (
    `Here's the full booking I'll record:\n` +
    `• Client: ${p.clientCode}\n` +
    `• ${segs}\n` +
    `• Receipt: ${p.receipt.transactionType} ${p.receipt.amount} (ref ${p.receipt.reference})`
  );
}

// Run the whole pipeline from a confirmed chat intent, streaming progress.
async function runPipelineFromChat(session, intent) {
  const { ws } = session;
  sendToClient(ws, { type: "bot_message", text: "Beauty — opening Tramada and recording it now. I'll keep you posted…" });
  try {
    const result = await runFullBooking({
      username: process.env.TRAMADA_USERNAME,
      password: process.env.TRAMADA_PASSWORD,
      clientCode: intent.clientCode,
      booking: intent.booking,
      segments: intent.segments || [],
      costings: intent.costings || [],
      receipt: intent.receipt,
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
            text: "🔐 I need you signed into Tramada in the Chrome window on port 9222. Log in there now (including OTP) — I'll detect it and keep going automatically, no need to touch this chat.",
          }),
      },
    });
    const rc = result.receipt && result.receipt.receipt;
    sendToClient(ws, { type: "pipeline_complete", result });
    sendToClient(ws, {
      type: "bot_message",
      text: rc
        ? `Done ✅ Booking ${result.bookingNo} created and receipt ${rc.receiptNo} issued for ${rc.amount}.`
        : `Done ✅ Booking ${result.bookingNo} — pipeline complete.`,
    });
  } catch (err) {
    // Keep the collected booking so the user can retry without re-entering it.
    session.pendingPipeline = intent;
    sendToClient(ws, { type: "error", text: `Pipeline failed: ${err.message}` });
    const needsLogin = /not logged in|login/i.test(err.message);
    sendToClient(ws, {
      type: "bot_message",
      text: needsLogin
        ? "Your booking is saved here — nothing lost. Sign into Tramada in the Chrome window that `npm run start:chrome` opened (port 9222 — NOT your normal browser), then reply **retry** and I'll run the exact same booking again."
        : "Your booking is saved here — reply **retry** to run it again, or tell me what to change.",
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
