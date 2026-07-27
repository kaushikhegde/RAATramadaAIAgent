# PDF-upload feature — live Tramada field mapping

Mapped live on booking **12752** (GRAY/MEGAN DR, BALI, total 1056.93) — the exact
booking the sample PDF (BPAY Ref 00127522) resolves to. This booking is already
fully built, so every form below was read in **edit mode** (real field ids + real values).

Base path: `/ttms/raatravelsandbox/booking/`
Booking id == display no here (12752). URL pattern: `?mode=edit&id=<recordId>&parentId=<bookingId>`

---

## 1. TOUR SEGMENT — `booking-tour-segment.htm`

**How to open the ADD form:** on `booking-itineraries.htm`, set the segment-type
`<select name="segmentType" id="segmentType">` to `TOUR`, then click
`<input name="add" id="addSegmentButton">`.
segmentType options: `BUS, CAR, COMMENT, CRUISE, FERRY, FLIGHT, HOTEL, MISC, TOUR, TRAIN, TRANSFER`.

Edit URL seen: `booking-tour-segment.htm?mode=edit&id=74741&pageSourceParam=itinerariesPage&parentId=12752`
(133 total fields; the important ones below.)

| Purpose | field name | value on 12752 |
|---|---|---|
| Tour company (free form / supplier name) | `tourCompanyName` | Tour East Bali |
| Creditor autocomplete (display) | `costing.creditor` | [VIVA] Viva  Holidays |
| Creditor code (resolved) | `calculatorCreditor` | VIVA |
| Creditor same/diff radio | `creditorSameOrDifferentFromSupplier` | DIFFERENT (opts: DIFFERENT, SAME_AS_SUPPLIER) |
| Service description (free text) | `freeTextDescription` | Rural Charm of Bali / SIC / Area 2 |
| Departure city (autocomplete) | `departureCity` | (DPS) DENPASAR BALI, INDONESIA |
| Finish city (autocomplete) | `finishCity` | (DPS) DENPASAR BALI, INDONESIA |
| Start date | `startDate` | 22-08-2026 |
| Finish date | `finishDate` | 22-08-2026 |
| Confirmation / issue date | `itinerary.confirmationOrIssueDate` | 22-08-2026 |
| **Reference / confirmation no** | `itinerary.confirmationOrReferenceNumber` | VIVR234951 |
| Creditor invoice number | `costing.creditorInvoiceNumber` | VIVR234951 |
| Segment status | `itinerary.statusTypeCode` | [HK] Confirmed |
| Ticket type | `ticketStatusTypeCode` | [TICKET_ISSUE] |
| Travel type | `travelTypeCode` | [INTERNATIONAL] |
| Currency | `currencyCode` | [AUD] |
| Applied FX rate | `appliedCurrencyRate` | 1.00 |
| Local rate excl GST | `localRateExclGst` | 425.32 |
| Local rate incl GST | `localRateInclGst` | 425.32 |
| AUD rate incl GST | `audRateInclGst` | 425.32 |
| No. of passengers | `numberOfPassengers` | 1 |
| Duration unit | `durationTypeCode` | [DAYS] |
| Duration value | `duration` | 1 |
| Save | `save` (submit) | |

Notes:
- Costing block is shared with flight/hotel forms (`costing.*` names identical).
- Passengers pre-selected via `selectPassengersButton`; both pax already attached.
- Amount 425.32 sits in localRate*, audRateInclGst (all equal since AUD, GST-free intl).

---

## 2. INSURANCE COSTING LINE — `booking-insurance-segment.htm`

**How to open the ADD form:** on `booking-costings.htm`, set
`<select name="segmentType" id="segmentType">` to `INSURANCE`, then click **Add Segment**.
Costing segmentType options: `BUS, CAR, CRUISE, DTAX, FERRY, FEX, HOTEL, INSURANCE, MCOS, MISC, PACKAGE, TICKET, TOUR, TRAIN, TRANSFER, VISA`.

Edit URL seen: `booking-insurance-segment.htm?mode=edit&id=74738&pageSourceParam=costingsPage&parentId=12752`
(87 fields total.)

| Purpose | field name | value on 12752 |
|---|---|---|
| Creditor autocomplete (display) | `costing.creditor` | [TOKIOMARINE] Tokio Marine |
| Creditor code (resolved) | `calculatorCreditor` | TOKIOMARINE |
| Policy type | `policyTypeCode` (select) | (blank) |
| Start date | `startDate` | 20-08-2026 |
| End date | `endDate` | 30-08-2026 |
| Status | `statusTypeCode` | [CONFIRMED] |
| Issue date | `confirmationOrIssueDate` | 22-07-2026 |
| **Policy No. (reference)** | `confirmationOrReferenceNumber` | 21088536 |
| Creditor invoice no. | `costing.creditorInvoiceNumber` | 21088536 |
| **Amount excl GST** | `policyGrossAmountExclGst` | 221.72 |
| **Amount incl GST** | `policyGrossAmountInclGst` | 221.72 |
| Apply GST | `applyGst` (checkbox) | off |
| Save | `save` | |

Notes: primary $ input is `policyGrossAmountInclGst`; `costing.supplierRates*` auto-fill from it.

---

## 3. SERVICE FEE COSTING LINE — `booking-service-fee-segment.htm`

**How to open the ADD form:** on `booking-costings.htm`, click the **Add Service Fee**
button (separate from Add Segment). The fee-type is chosen via a **Select Fee Type**
lookup button on the form (sets `feeType`, e.g. `A_CS_SFE_FEE`).

Edit URL seen: `booking-service-fee-segment.htm?mode=edit&id=74747&pageSourceParam=costingsPage&parentId=12752`
(80 fields total.)

| Purpose | field name | value on 12752 |
|---|---|---|
| Service fee category | `serviceFeeType` (select) | [BOOKING_FEE] Booking Fee |
| (hidden mirror) | `notDisplayingServiceFeeType` | BOOKING_FEE |
| Consultant | `consultant` (select) | [194] Megan Gray [WEST] |
| Fee type code (via Select Fee Type lookup) | `feeType` | A_CS_SFE_FEE |
| Description (free text) | `description` | Credit Card Fee |
| Passenger ref | `passengerRefName` | (blank) |
| Comments | `comments` (textarea) | (blank) |
| Creditor autocomplete (display) | `costing.creditor` | [RAAFEES] RAA- Fees |
| Creditor code (resolved) | `calculatorCreditor` | RAAFEES |
| Ticket type | `ticketStatusTypeCode` | [TICKET_ISSUE] |
| Issue date | `issueDate` | 23-07-2026 |
| Payment type | `costing.paymentTypeCode` | [PRE_PAID] Chargeable |
| Apply GST | `applyGst` (checkbox) | on |
| Quantity | `quantity` | 1 |
| **Amount excl GST** | `grossFeeAmountExclGst` | 4.72 |
| **Amount incl GST** | `grossFeeAmountInclGst` | 5.19 |
| Amount mode | `feeAmountType` | DOLLAR_INCL_GST |
| Save | `save` | |

Notes: this SFE on 12752 is a "Credit Card Fee" (5.19 incl 0.47 GST). Under an **EFT**
receipt there is usually **no** credit-card surcharge — so whether to create this line
depends on what the uploaded PDF actually itemises. Flag for the feature logic.

---

## 4. EFT RECEIPT — `booking-debtor-payment-receipt.htm`

**How to open (PROVEN path):** on `booking-receipts.htm`, leave the
`<select name="receiptCategory">` on `DEBTOR_PAYMENT_RECEIPT` and click
**Add / Issue Receipt**. (Direct URL nav to the receipt page caused a server error
before — always go through the button.)
Add-mode URL: `booking-debtor-payment-receipt.htm?mode=add&isMigrationReceipt=false&isPxIssue=false&parentId=<bookingId>&isAgencyCreditCardReceipt=false`

receiptCategory options: `DEBTOR_PAYMENT_RECEIPT, AGENCY_CC_DEBTOR_PAYMENT_RECEIPT, MIGRATION_DEBTOR_PAYMENT_RECEIPT, CREDITOR_REFUND_RECEIPT`.

### >>> Transaction Type dropdown — `receipt.transactionTypeCode` (id `receipttransactionTypeCode`)

| value | text |
|---|---|
| `CA` | Cash |
| `CQ` | Cheque |
| `CC` | Credit Card CCCF |
| `CS` | Credit Card Swipe |
| **`ET`** | **EFT**  ← use this |

### Other receipt fields

| Purpose | field name | note |
|---|---|---|
| Bank account | `receipt.agencyBankAccount` | `1` = [TRUST] Trust Account (only option) |
| Payer name | `receipt.payerName` | set = booking client name (Dr Megan GRAY) |
| Date received | `receipt.dateReceived` | defaults today (25-07-2026); use today |
| Amount received | `receipt.receiptAmount` | = PDF total (1056.93) |
| Reference | `receipt.referenceNumber` | = BPAY Ref (00127522) |
| Document type | `documentType` | Receipt Plus Allocation / Receipt Only |
| Received from | autocomplete (Received From) | defaults to debtor RAA of SA Limited |
| Email checkbox | `useEmail` | leave off |

### Allocation + commit
- **Segments To Allocate** has its own **Select All** — there are TWO `id=selectAll`
  buttons on the page; the **2nd** (`buttons[2]`, the one under "Segments To Allocate")
  allocates the receipt across all segments. Click it, then verify allocated == amount.
- Commit button: `<input name="issue" id="issue" value="Issue">`.
- STRICT success check: after Issue, the new row must show a receipt number starting
  `R.` (e.g. R.0000009348). Existing rows on 12752: R.9345 (Cash), R.9346 (CC Swipe),
  R.9347 (Agency CC) — none EFT, so ET is new for this booking.

---

## FEATURE-BUILD IMPLICATIONS (read before coding)

1. **BPAY Ref → booking id.** Sample Ref `00127522` = booking **12752** + trailing
   check digit `2`, zero-padded. Parse: strip leading zeros, drop last digit →
   `0012752|2`. VERIFY by opening the booking and matching client/passenger/total
   before touching anything. Stop & show if client name mismatches the PDF.
2. **Idempotency.** Booking 12752 is ALREADY fully built (2 segments, 4 costing lines,
   3 receipts, balance 0.00). A real run must detect existing Tour/Hotel/INS/SFE lines
   and existing receipts and SKIP them — never blind-add. Reuse the resume/"already
   exists" detection from tramada-segments.js.
3. **Creditor autocomplete** everywhere uses the proven pickAutocomplete widget
   (`costing.creditor` display + `calculatorCreditor` code). Type the PDF supplier name
   (Viva Holidays / Tokio Marine / RAA-Fees); only ask the user when no match.
4. **Service Fee (SFE)** on 12752 is a credit-card surcharge — likely NOT present when
   paying by EFT. Only create it if the uploaded PDF itemises a fee. Confirm with user.
5. **Confirm before Issue** (user requirement): show the receipt summary — ET/EFT,
   amount = PDF total, reference = BPAY Ref, allocate-all — and wait for a yes before
   clicking `issue`.
6. All segment/costing forms share the `costing.*` and rate blocks already handled in
   tramada-segments.js — the Tour/Insurance/SFE additions are new form pages + a few
   type-specific fields, not a new costing engine.

