# How the Gemini prompt takes input and drives the automation

This explains the path from a user typing in the chat to a receipt (or full
pipeline) being created in Tramada — where Gemini sits, what it emits, and how the
server turns that into browser automation.

## The pieces

- **`geminiPrompt.js`** — builds the *system prompt* (personality + what to collect
  + the exact JSON to emit). Two builders: `buildSystemPrompt()` (booking) and the
  new `buildReceiptPrompt()` (receipt/pipeline).
- **`server.js`** — runs the chat loop, parses Gemini's reply, and calls the
  automation. Gemini **never touches the browser**; it only produces structured JSON.
- **`tramada-*.js`** — Playwright modules that actually drive Tramada.

## The data flow

```
                    ┌─────────────────────────────────────────────┐
   User types  ───► │ WebSocket  → server.js handleUserMessage()   │
   in chat UI       └───────────────┬─────────────────────────────┘
                                    │ forwards text + history
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ Gemini 2.5 Flash                             │
                    │  systemInstruction = buildReceiptPrompt()    │
                    │  • asks 1–2 questions at a time              │
                    │  • books the ORDER: find booking → confirm   │
                    │    details → segment → receipt → confirm     │
                    │  • payer name never asked (always client)    │
                    └───────────────┬─────────────────────────────┘
                                    │ replies with plain chat...
                                    │ ...until everything is collected
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ When complete, Gemini emits a ```json block: │
                    │ { "intent":"receipt", "bookingNo":"12770",   │
                    │   "receipt":{ transactionType, amount,       │
                    │     reference, dateReceived, allocation,     │
                    │     card } }                                 │
                    └───────────────┬─────────────────────────────┘
                                    │ server.js parses the JSON out of the reply
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ server.js dispatches by intent:              │
                    │  • receipt_run   → runTramadaReceipt()       │
                    │  • pipeline_run  → runFullBooking()          │
                    │  (dryRun first = PREVIEW, no commit)         │
                    └───────────────┬─────────────────────────────┘
                                    │ Playwright over CDP (port 9222)
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ Tramada in the shared Chrome (already logged │
                    │ in → no OTP). Fills forms, allocates, and    │
                    │ stops before Issue.                          │
                    └───────────────┬─────────────────────────────┘
                                    │ preview summary + screenshot
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ Chat shows the staged receipt + "Yes/Cancel" │
                    │ User confirms → same call with confirmed:true│
                    │ → clicks Issue → reads back Receipt No.      │
                    └─────────────────────────────────────────────┘
```

## What the prompt is responsible for (the "input" side)

`buildReceiptPrompt()` makes Gemini do the *conversation and validation*, so the
automation receives clean, complete data:

1. **Resolve the booking (req 5)** — if the user gives a number, use it; if not,
   Gemini asks for a client name, the server runs `receipt_search`, and Gemini
   shows the list and asks which one.
2. **Confirm details (req 1)** — Gemini echoes booking no/client/debtor/itinerary.
3. **Segment/allocation (req 3)** — "all segments" or specific amounts.
4. **Receipt details** — transaction type (req 2, Cash/EFT/Credit Card), amount,
   **reference (req 6, required — Gemini won't finish without it)**, date (defaults
   today). **Payer name is never asked** — the automation always uses the booking's
   client name.
5. **Credit card (req 4)** — if Credit Card, Gemini collects card type/holder/
   number/expiry/creditor; the automation enters it as a *new booking card*, not
   saved to the client profile.
6. **Confirm before commit** — Gemini summarises everything and waits for "yes".
   Only then does it emit the JSON, and even then the server previews first.

## Why the split (Gemini vs automation)

Gemini is good at messy human input (dates like "next Friday", partial info,
corrections) and turning it into one clean JSON object. The Playwright modules are
deterministic and know Tramada's exact fields. Keeping them separate means the
automation always gets validated, structured data — and a bad/incomplete chat can
never half-fill a financial form, because no JSON is emitted until everything
(especially the required reference) is present and confirmed.

## The contract (what server.js expects from Gemini)

```json
{
  "intent": "receipt",              // or "pipeline"
  "bookingNo": "12770",
  "receipt": {
    "transactionType": "Cash",       // Cash | EFT | Cheque | Credit Card | Credit Card Swipe
    "amount": "110.00",
    "reference": "Booking-101",      // REQUIRED
    "dateReceived": "2026-07-23",    // optional, defaults today
    "allocation": "ALL",             // or [{ "segId": "...", "amount": "..." }]
    "card": null                     // or { number, type, holder, expiry, creditor, authNumber }
  }
}
```

For the full pipeline the JSON also carries `clientCode`, `booking`, `segments`,
and `costings` (see `test-pipeline.js` for the exact shapes), and the server calls
`runFullBooking()` instead of `runTramadaReceipt()`.
