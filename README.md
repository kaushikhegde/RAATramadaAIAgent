# Jetstar Booking Chatbot v6.0

AI-powered Jetstar flight booking assistant with a conversational chat interface. Uses **Gemini AI** for natural conversation and **OpenClaw** for secure browser automation.

## Architecture

```
User ↔ Chat UI (HTML/WebSocket) ↔ Express Server ↔ Gemini AI (conversation)
                                                   ↔ OpenClaw Gateway (browser automation)
```

- **Gemini 2.5 Flash** drives the conversation — collects origin, destination, dates, passengers, preferences
- **OpenClaw Gateway** handles browser automation securely inside Docker (no exposed CDP ports)
- **OpenClaw Canvas** lets you watch the browser automation live in your browser
- Stops at the booking details page (no passenger form filling)

## Prerequisites

- **Node.js** 18+
- **Docker** with OpenClaw containers running
- **Gemini API Key** (free from https://aistudio.google.com/apikey)

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY and OPENCLAW_GATEWAY_TOKEN
```

### 3. Configure OpenClaw Gateway

Your `openclaw.json` (inside `OPENCLAW_CONFIG_DIR`) must allow the browser tool for HTTP invocation. Add or merge this into your config:

```json
{
  "auth": {
    "token": "your-gateway-token-here"
  },
  "gateway": {
    "tools": {
      "allow": ["*"],
      "deny": []
    }
  }
}
```

See `openclaw-config-example.json` in this project for a reference.

After updating the config, restart your OpenClaw containers:
```bash
docker compose down && docker compose up -d
```

### 4. Start the chatbot
```bash
npm start          # Start on PORT 3000
npm run dev        # Same with DEBUG=true
```

### 5. Open the chat
Navigate to http://localhost:3000 in your browser.

### 6. Test Gateway connection (optional)
```bash
node test-gateway.js    # Diagnoses Gateway connectivity and browser tool access
```

## How It Works

1. Open http://localhost:3000 — the chat UI connects via WebSocket
2. The AI assistant asks about your trip (where, when, passengers, preferences)
3. Once all details are collected, a booking summary card appears
4. Click "Confirm & Start Booking" to trigger browser automation
5. Watch the automation live via OpenClaw Canvas
6. Automation navigates through: Home → Search → Flight Selection → Baggage → Seats → Extras → Booking Details
7. Stops at the passenger details page for manual entry

## PDF Upload

You can also upload a booking PDF instead of chatting. The system parses the PDF, extracts booking details, and lets you confirm before automating.

## File Structure

```
booking-automation/
├── package.json               # Dependencies (express, ws, @google/generative-ai, etc.)
├── .env                       # Your config (Gemini key, Gateway URL, token)
├── .env.example               # Template for .env
├── server.js                  # Express + WebSocket backend
├── geminiPrompt.js            # Gemini AI system prompt and personality
├── automator.js               # OpenClaw Gateway browser automation
├── parsePdf.js                # PDF parser for uploaded booking PDFs
├── test-gateway.js            # Gateway diagnostic tool
├── openclaw-config-example.json  # Reference OpenClaw config
├── public/
│   └── index.html             # Chat UI (single-page app)
├── Todo/                      # Drop booking PDFs here (legacy)
└── Completed/                 # Completed bookings (legacy)
```

## Troubleshooting

### Gateway returns 401 Unauthorized
Add `OPENCLAW_GATEWAY_TOKEN` to your `.env` file. The token must match the `auth.token` in your `openclaw.json`.

### Gateway returns 500 (tool execution failed)
The browser tool is likely blocked by the Gateway's default deny list. Update your `openclaw.json` to allow it — see Step 3 above.

### Gateway returns 500 (browser crashed)
Check Docker logs: `docker compose logs openclaw-gateway | tail -50`. Browser binaries may be missing from the container.

### CAPTCHA detected
Jetstar may show a CAPTCHA. Solve it via OpenClaw Canvas — the automation pauses for up to 120 seconds and continues automatically.

## IMPORTANT: Security

- **Never expose browser CDP ports** from Docker containers — this is a massive security risk
- All browser commands go through the OpenClaw Gateway API, which proxies them securely inside the container
- The Gateway token authenticates your requests; keep it secret
