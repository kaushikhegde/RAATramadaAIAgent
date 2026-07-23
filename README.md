# Jetstar Booking Chatbot v6.0

AI-powered Jetstar flight booking assistant with a conversational chat interface. Uses **Gemini AI** for natural conversation and **Playwright over the Chrome DevTools Protocol (CDP)** to drive your real Chrome browser for booking automation.

## Architecture

```
User ↔ Chat UI (HTML/WebSocket) ↔ Express Server ↔ Gemini AI (conversation)
                                                   ↔ Playwright → real Chrome via CDP :9222
                                                   ↔ Tramada TTMS (add + search bookings)
```

- **Gemini 2.5 Flash** drives the conversation — collects origin, destination, dates, passengers, preferences
- **Playwright connects to your real Chrome** over CDP (port 9222). Using real Chrome — not bundled Chromium — gives an authentic TLS fingerprint that passes Akamai bot detection on jetstar.com
- A persistent profile (`.jetstar-profile-cdp/`) keeps cookies warm between runs
- After Jetstar, an optional **Tramada TTMS** step adds the booking and searches it back

## Prerequisites

- **Node.js** 18+
- **Google Chrome** installed
- **Gemini API Key** (free from https://aistudio.google.com/apikey)

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY
```

### 3. Start Chrome with remote debugging
Quit Chrome completely first (Cmd+Q on Mac), then:
```bash
npm run start:chrome      # launches Chrome on port 9222 with the .jetstar-profile-cdp profile
```
On a fresh profile, browse to jetstar.com once manually to warm up cookies.

### 4. Start the chatbot
```bash
npm run dev               # CDP_MODE=external DEBUG=true node server.js
# or
npm start                 # same without DEBUG
```

### 5. Open the chat
Navigate to http://localhost:3000 in your browser.

### Tramada-only mode (skip Jetstar)

To collect details in the chat and record the booking straight into Tramada — no Jetstar
automation, no `--remote-debugging-port` needed:

```bash
SKIP_JETSTAR=true CDP_MODE=internal node server.js
```

- `SKIP_JETSTAR=true` — after you confirm, the Tramada form appears immediately. The chat
  also stops asking for Jetstar-only details (contact email/phone, budget, baggage, seats,
  insurance) and asks which client to file the booking under instead.
- `CDP_MODE=internal` — launches Chrome directly instead of attaching to port 9222.
  In `external` mode the Tramada automation still falls back to launching Chrome if
  nothing is listening on the CDP port, so this is optional.

## How It Works

1. Open http://localhost:3000 — the chat UI connects via WebSocket
2. The AI assistant asks about your trip (where, when, passengers, preferences)
3. Once all details are collected, a booking summary card appears
4. Click "Confirm & Start Booking" — Playwright connects to your Chrome on port 9222
5. Watch the automation live in that Chrome window as it navigates:
   Home → Search → Flight Selection → Baggage → Seats → Extras → Review & Pay
6. Stops at the Review & Pay page and emits an itinerary card (screenshot saved to `Completed/review-and-pay.png`)
7. Optionally enter Tramada credentials to add the booking to TTMS and search it back

## PDF Upload

You can also upload a booking PDF instead of chatting. The system parses the PDF (`parsePdf.js`, with a Python fallback in `extractPdfText.py`), extracts booking details, and lets you confirm before automating. Standalone PDF runs read from `Todo/` and move the file to `Completed/`.

## NPM Scripts

| Script              | What it does                                              |
|---------------------|----------------------------------------------------------|
| `npm run start:chrome` | Launch Chrome with remote debugging on port 9222      |
| `npm run dev`       | Run the server with DEBUG logging (recommended for demo)  |
| `npm start`         | Run the server                                            |
| `npm run book:chrome` | Run `booking.js` standalone against system Chrome       |
| `npm run book:cdp`  | Run `booking.js` standalone, connecting via CDP           |
| `npm run validate`  | Validate a booking PDF without automating                 |

## File Structure

```
booking-automation/
├── package.json           # Dependencies (express, ws, playwright, @google/generative-ai)
├── .env.example           # Template for .env (Gemini key, port, CDP port)
├── start-chrome.sh        # Launches real Chrome with remote debugging on :9222
├── server.js              # Express + WebSocket backend; orchestrates the flow
├── geminiPrompt.js        # Gemini AI system prompt and personality
├── booking.js             # Jetstar booking automation (Playwright over CDP)
├── parsePdf.js            # PDF parser for uploaded booking PDFs
├── extractPdfText.py      # Python PDF-text fallback used by parsePdf.js
├── tramada-automator.js   # Tramada TTMS automation
├── tramada-booking.js     # Tramada add + search-booked flow
├── public/
│   ├── index.html         # Chat UI (single-page app)
│   └── tramada.html       # Tramada panel
├── Todo/                  # Drop booking PDFs here (standalone PDF runs)
├── Completed/             # Output: screenshots + itinerary JSON
└── old_code/              # Archived: previous OpenClaw/Docker architecture & backups
```

## Troubleshooting

### Chrome won't start with debugging
Chrome must be **fully closed** (Cmd+Q) before running `npm run start:chrome`. If a normal Chrome window is open, it won't expose the debugging port.

### Blocked by Akamai / CAPTCHA
Jetstar may show a CAPTCHA or block page. Solve it manually in the Chrome window — the automation pauses and continues once you're through. A warm `.jetstar-profile-cdp/` profile (cookies from prior browsing) reduces blocks.

### "Cannot connect to Chrome on port 9222"
Make sure `npm run start:chrome` is running and reported "Chrome is ready on port 9222". You can verify with `curl http://127.0.0.1:9222/json/version`.
