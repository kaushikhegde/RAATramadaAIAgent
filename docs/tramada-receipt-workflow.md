# Tramada Receipt Workflow — Page & Field Map

Scanned live from the sandbox (`asp.tramada.com.au/ttms/raatravelsandbox`, Tramada v7.10.3)
using booking **12770** (GRAY/SPIDER MS, MEL-SYD) as the reference booking.

This maps the pages, URLs, and form field IDs needed to automate the six receipt
requirements from the client. It extends the existing `tramada-booking.js`
(login → add booking → search) with the **itinerary → receipt** flow.

---

## The workflow at a glance

```
Booking (must exist, be "Booked")
   └─ Booking Segments ▸ Itinerary   ← at least one segment MUST exist & be costed/invoiced
        └─ Booking Transactions ▸ Receipts
             └─ Add / Issue Receipt  ← the receipt form (Cash or Credit Card)
                  └─ allocate amount across segments → Issue
```

Client rule confirmed on-screen: a receipt can only allocate against **segments that
have been costed/invoiced**. If there is no itinerary segment, the "Segments To Allocate"
table is empty and there is nothing to receipt against. So **itinerary first, receipt second.**

---

## Page URLs (all take `?mode=edit&id={bookingId}`)

Left-sidebar navigation on any booking page. `{id}` = booking number (e.g. 12770).

| Group | Page | URL |
|---|---|---|
| Booking File | Summary (details) | `/booking/booking-summary.htm?mode=edit&id={id}` |
| Booking Segments | **Itinerary** | `/booking/booking-itineraries.htm?mode=edit&id={id}` |
| Booking Segments | Costing | `/booking/booking-costings.htm?mode=edit&id={id}` |
| Booking Transactions | **Receipts** | `/booking/booking-receipts.htm?mode=edit&id={id}` |
| Booking Transactions | Invoices | `/booking/booking-invoices.htm?mode=edit&id={id}` |
| Booking Transactions | Account | `/booking/booking-account.htm?mode=edit&id={id}` |

Base URL prefix: `https://asp.tramada.com.au/ttms/raatravelsandbox`

---

## Requirement 5 — find the booking (search / list)

**Page:** `/booking/booking-search.htm`

On load it shows **"Recently Accessed Bookings"** (a ready-made list). To search:

| Field | Selector | Notes |
|---|---|---|
| Booking No | `#searchForm_bookingNo` (Booking No text box) | direct lookup |
| Booking Status | `#searchForm_bookingStatus` | options: `NEW`, `QUOTE`, `BOOKED`, `FINALISED`, `CANCELLED` |
| Client Name | Client Name text box | |
| Search button | `#searchButton` (submit) | |

Each result row's **Action** icon links to
`/booking/booking-summary.htm?mode=edit&id={id}` — that `id` is the booking number.

**Automation logic (req 5):** if the user gives a booking number → go straight to the
summary page. If not → open booking-search, read the list (columns: Bkg No, Client Name,
Debtor Name, Itinerary, Dep date, Ret date, Final TKT), show it in chat, and ask which one.

---

## Requirement 1 — show booking details to confirm

**Page:** `/booking/booking-summary.htm?mode=edit&id={id}`

Header block (top-left of every booking page) and the summary panel expose everything
needed to echo back to chat:

- **Booking No.** (e.g. 12770)
- **Client** / Client Name (e.g. GRAY/SPIDER MS — Ms SPIDER GRAY)
- **Debtor** (e.g. RAA of SA Limited (Retail))
- **Itinerary** summary (e.g. MEL-SYD)
- **Book Date, Departure Date, Return Date**
- **Client/Debtor Balance** panel: Total Due, Receipted, Balance, Unallocated Receipt Amount
- **Status** banner (New / Quote / Booked / Finalised) — shown as a coloured strip

---

## Prerequisite — Itinerary / segments

**Page:** `/booking/booking-itineraries.htm?mode=edit&id={id}` (title "Booking Itinerary")

- Table columns: Action, Seg. Type, Reference, Start Date, Time, Finish Date, Time,
  Start City, Finish City, Status.
- **Segment Type** dropdown (Flight / Hotel / Car / …) + **Add Segment** button to create one.
- Segment types seen: `FLT` (flight), `HTL` (hotel). Each segment has its own edit page,
  e.g. hotel = `/booking/booking-hotel-segment.htm?mode=edit&parentId={id}&id={segId}`.

A segment must be **costed** (Booking Segments ▸ Costing) so it produces a "Debtor Due"
amount before it appears in the receipt's "Segments To Allocate" table.

---

## Requirements 2, 3, 6 — the receipt form

**Receipts list page:** `/booking/booking-receipts.htm?mode=edit&id={id}`
- Receipt-category dropdown + **Add / Issue Receipt** button (`#... "Add / Issue Receipt"`).
- Category options: `DEBTOR_PAYMENT_RECEIPT` (default), `AGENCY_CC_DEBTOR_PAYMENT_RECEIPT`,
  `MIGRATION_DEBTOR_PAYMENT_RECEIPT`, `CREDITOR_REFUND_RECEIPT`.
- Use **Debtor Payment Receipt** — it handles both Cash and Credit Card via the Transaction
  Type field (below). Clicking Add opens:

**Receipt form:** `/booking/booking-debtor-payment-receipt.htm?mode=add&parentId={id}&isAgencyCreditCardReceipt=false`

Field map (element `id` → meaning):

| Field | Element `id` | Type | Requirement |
|---|---|---|---|
| **Transaction Type** | `receipttransactionTypeCode` | select | **req 2** — options: `Cash`, `Cheque`, `Credit Card CCCF` (value `CC`), `Credit Card Swipe`, `EFT` |
| Bank Account | `receiptagencyBankAccount` | select | `[TRUST] Trust Account` (value `1`) |
| Received From | `debtor` | text | prefilled with debtor |
| Payer Name | `receiptpayerName` | text | |
| Date Received | `receiptdateReceived` | text | `dd-mm-yyyy` |
| Amount Received | `receiptreceiptAmount` | text | total receipt amount |
| **Reference** | `receiptreferenceNumber` | text | **req 6 — required** |
| Document Type | `documentType` | select | `Receipt Plus Allocation` / `Receipt Only` |
| Email (deliver doc) | `useEmail` | checkbox | |
| **Preview** | `#preview` | submit | shows the receipt before issuing |
| **Issue** | `#issue` | submit | **commits the receipt** |

### Segment allocation (req 3 — "which segment or all, & amount by segment")

Section **"Segments To Allocate"** at the bottom. One row per costed segment:

| Field | Element `id` pattern | Meaning |
|---|---|---|
| Allocate amount | `allocationAmount_{segId}` | amount to apply to that segment (e.g. `allocationAmount_74801`, prefilled with Debtor Due 110.00) |
| Row checkbox | `segmentsToAllocate` (per row) | include this segment |
| Round Remaining | `roundRemaining` | rounding helper |
| Select All / Deselect All | buttons | allocate to **all** segments at once |

Live tally line: `Amt Rcvd + Unalloc Rcpts − Seg Total − RO Amt = Unalloc`.
- **"All segments"** → click Select All (or tick every row) and let amounts default to each
  segment's Debtor Due.
- **"By segment"** → tick only the chosen row(s) and type the amount into
  `allocationAmount_{segId}`.

---

## Requirement 4 — Credit Card: new card each time, NOT saved to client profile

When **Transaction Type = Credit Card CCCF / Swipe**, the receipt form reveals two extra
sections:

**Creditor Details**
- `creditor` (select) — the supplier the card charge is for (e.g. TEMPO HOLIDAYS).

**Credit Card Details**
- `receiptcreditCard` (select) — list of **existing** cards (saved client cards + booking cards).
- `addCreditCardButton` — **"Add"** button → opens `/client/client-edit-credit-card.htm`.
- `receiptcreditCardAuthNumber` (text) — Authorisation Number.

The **Add** button opens the card-entry form as a **Booking Credit Card** — a card attached
to *this receipt/booking only*, which is **not** added to the client's saved-card profile.
(Proof: opening `client-edit-credit-card.htm` standalone returns *"This credit card is not a
Booking Credit Card and cannot be edited"* — the transient booking-card path is only
reachable through the receipt's Add button.)

**Card-entry form fields** (`/client/client-edit-credit-card.htm`):

| Field | Element `id` | Type |
|---|---|---|
| Card Number | `cardNumberDisplay` | text |
| Card Type | `cardType` | select — Debit Cards, Givex Gift Cards, MasterCard, PayID, Redemption Voucher, Visa |
| Card Holder | `cardHolder` | text |
| Expiry Date | `expiryDate` | text |
| De-activate | `deActivateCheck` | checkbox |
| Save | `#save` | submit |

**So req 4 is satisfied by design:** always reach the card form via the receipt's **Add**
button (booking card, transient) rather than picking a saved card or adding one from the
client page — that way a fresh card is entered per receipt and nothing lands on the client
profile.

> ⚠️ Automation note on card data: entering raw card numbers is sensitive. Whatever drives
> this should collect the PAN over a secure channel and type it into `cardNumberDisplay`;
> the assistant itself should not handle/store card numbers in plain text.

---

## Suggested automation sequence (to add to `tramada-booking.js`)

1. **Resolve booking** — if bookingNo given, open summary; else open booking-search, scrape
   the list, present it, ask for the number (req 5).
2. **Confirm details** — read the summary header, echo Booking No + details to chat (req 1).
3. **Guard: itinerary exists** — open booking-itineraries; if empty, stop and tell the user a
   segment/itinerary must be created (and costed) first.
4. **Open receipt form** — booking-receipts → Add/Issue Receipt (Debtor Payment Receipt).
5. **Set header fields** — Transaction Type (Cash vs Credit Card, req 2), Amount Received,
   Reference (req 6, required), Date Received, Payer Name.
6. **If Credit Card** — select creditor, click **Add** to enter a new booking card (req 4),
   set Authorisation Number.
7. **Allocate** — all segments (Select All) or specific `allocationAmount_{segId}` values (req 3).
8. **Preview → Issue** — click `#preview` to show, then `#issue` to commit. After issue, read
   back the new Receipt No. from the receipts list and show it in chat.

## Element quick-reference (copy/paste selectors)

```
# Search
#searchForm_bookingNo, #searchForm_bookingStatus, #searchButton

# Receipt form
#receipttransactionTypeCode      # Cash | Cheque | CC | Credit Card Swipe | EFT
#receiptagencyBankAccount        # bank account (Trust)
#receiptpayerName
#receiptdateReceived             # dd-mm-yyyy
#receiptreceiptAmount
#receiptreferenceNumber          # REQUIRED
#documentType
#creditor                        # only when Credit Card
#receiptcreditCard               # saved-card select (only when Credit Card)
#addCreditCardButton             # "Add" -> new booking card
#receiptcreditCardAuthNumber
#allocationAmount_{segId}        # per-segment amount
#roundRemaining
#preview, #issue                 # submit buttons

# New booking card form (client-edit-credit-card.htm via Add)
#cardNumberDisplay, #cardType, #cardHolder, #expiryDate, #save
```
