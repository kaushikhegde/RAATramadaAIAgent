# PDF upload → Tramada segments + costings + EFT receipt

Upload an RAA Travel itinerary/costing PDF. It resolves the booking from the BPAY
Ref, adds the **Tour** + **Hotel** segments and the **Insurance** costing line,
then stages an **EFT** receipt for the full amount and issues it after you confirm.

## Two ways to run

### 1. Command line (tested, recommended for first runs)

```bash
npm run start:chrome                       # opens the port-9222 Chrome; log into Tramada in it
npm run pdf -- path/to/itinerary.pdf       # STAGES the receipt (nothing committed) — review the output
npm run pdf -- path/to/itinerary.pdf --issue   # actually issues the EFT receipt
```

Flags:
- `--issue` — commit the EFT receipt (default is a safe stage/dry-run).
- `--service-fee` — also create the Service-Fee line (off by default; EFT normally has no card surcharge).
- `--overrides pdf-overrides.json` — pin the Tramada **creditor** per line when the
  PDF's supplier name doesn't match a Tramada creditor. See `pdf-overrides.example.json`.

A `.txt` of the PDF text also works (handy for testing the parser).

### 2. In the chat UI

`npm run chat`, then click the **PDF upload** button and pick the itinerary PDF.
You get an **extraction card** (booking, passengers, segments, costings, EFT total)
with editable **creditor** fields and a "create Service Fee?" checkbox. Flow:

1. **Create in Tramada** → adds segments + costings, stages the EFT receipt.
2. **Issue EFT receipt** → commits it.

## What it does / safety

- **Booking id from BPAY Ref**: `00127522` → booking `12752` (strip leading zeros,
  drop the check digit); cross-checked against the printed `B#####`.
- **Client guard**: verifies the booking's client matches the PDF passengers and
  **stops without changing anything** on a mismatch.
- **Idempotent / resumable**: skips any Tour/Hotel/Insurance/Service-Fee already on
  the booking, and skips the receipt if the booking is already fully paid. Safe to re-run.
- **EFT** = transaction type `ET`; reference = the BPAY Ref; amount = the PDF grand
  total; allocated across all segments. Receipt is **staged first, issued only on confirm**.

## Creditors (important)

The PDF names products/suppliers (Tour East Bali, Novotel, Tokio Marine) but not
always the Tramada **creditor** that gets paid. The pipeline types the supplier name
into Tramada's creditor autocomplete; if it doesn't match it stops with a clear
message. Pin the right creditor via the chat card's creditor field, or `--overrides`
on the CLI (e.g. tour → "Viva Holidays").

## Files

| File | What |
|---|---|
| `pdf-itinerary.js` | NEW — parses the RAA PDF text into structured data |
| `run-pdf.js` | NEW — CLI runner (`npm run pdf`) |
| `pdf-overrides.example.json` | NEW — creditor-override template |
| `tramada-segments.js` | + `addTourSegment`, `addInsuranceCosting`, `addServiceFeeCosting`, `runAddCostingLines`, `runPdfBooking` |
| `tramada-receipt.js` | unchanged — already supports EFT (`ET`) |
| `server.js` | + `tramada_pdf_upload` handler (parse → create → issue) |
| `public/index.html` | + extraction/preview cards; upload now sends the itinerary flow |
| `package.json` | + `pdf` script |

## Known follow-ups

- **Service Fee** fee-type is chosen via a "Select Fee Type" lookup on the Tramada
  form that isn't automated yet — it's off by default (EFT rarely has a card fee).
  If you need it, map that lookup live first.
- Assumes the booking already exists in Tramada with its passengers (the PDF is a
  confirmation of an existing booking), so no passenger step is run.
