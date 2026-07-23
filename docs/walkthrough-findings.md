# Live Walkthrough Findings — Full Pipeline (booking → segments → costing → receipt)

Ran the exact steps the code encodes against the live sandbox (already-logged-in
browser, no OTP), on a fresh booking **#12773**. This is what we proved and — more
importantly — the gaps that would make the code error out. **Fix these before the
first `node test-pipeline.js` run.**

## What worked ✅
- **Booking creation** (`booking-profile.htm?mode=ADD`) — created #12773. The `id`
  comes back in the URL exactly as the code reads it. Selecting the client
  auto-populated the required **Booking Account** (`accountTypeCode`), so the code
  correctly relies on that.
- **Flight segment** — saved once the values were corrected (see fixes below):
  `FLT | QF / 0400 / Y | MEL → SYD`.
- **Hotel pricing** — the inline rate math works: AUD Rate 220 × 2 nights →
  Client Due **440**. Fields `audRateIncGst`, `numberOfRooms`, `duration` are right.
- **Ticket costing math** — Local/AUD amount 330 → Client Due **330** computed.
- **Cash receipt** — already proven earlier (issued **R.0000009349** on #12770).

## Gaps found — REQUIRED code fixes 🔧

### 1. Passengers must be added before costing (CRITICAL)
The booking is created with **no passengers**, and both **hotel segments** and
**ticket costings** fail with **"Passenger is required."** (This was the real cause
of the hotel save failing, not a field problem.)

**Fix:** after creating the booking, add a passenger via
`booking-passengers.htm` — select **"This Client"** in `#passengerSourceSelect`
(value `THIS_CLIENT`) → click **Add as Passenger(s)** → the passenger profile
pre-fills from the client → **Save**. Do this before any hotel segment or costing.
The pipeline orchestrator needs a new `addPassengers` stage between booking and
segments.

### 2. Flight segment fields are validated — not free text
Live validation rejected the code's current values:
- **Flight Number** must be **≤ 4 characters** — "QF400" failed; use the numeric
  part only (`400`, Tramada stored it as `0400`).
- **Class** must be **≤ 2 characters** — "Economy" failed; use a booking-class code (`Y`).
- **Airline Name** is a **validated autocomplete** — plain "Qantas" was rejected;
  typing "QANTAS" and letting it resolve to `QANTAS AIRWAYS(QF)` works.
- **Departure/Arrival City** are **autocompletes** — plain "SYD" gave
  "Arrival City must be entered"; must type and pick the `(SYD) SYDNEY, AUSTRALIA`
  suggestion (the `pickAutocomplete` pattern, not `fill`).

**Fix in `addFlightSegment`:** cap flightNumber to ≤4 / class to ≤2, and use
`pickAutocomplete` (type → select suggestion) for `#airline`, `#departureCityCode`,
`#arrivalCityCode` instead of `fill`.

### 3. Creditor fields ARE autocompletes (confirmed)
On the hotel and ticket-costing forms, `#costingcreditor` needs the type→pick
flow ("TEMPO" → select `[TEMPO] TEMPO HOLIDAYS`). The `pickAutocomplete` helper is
correct — just make sure it's used (it is) and that a match is actually clicked.

### 4. Destination "INT" is invalid (from booking mapping)
`destinationTypeCode` valid values are ASIA, EUROPE, USA_CANADA, **DOM**, OTHER, …
— there is **no `INT`**. `tramada-booking.js` maps international → `"INT"`, which
would fail. Map domestic → `DOM` (works) and international → a real region
(or `OTHER`).

### 5. Saving via raw JS `value=` is unreliable
Some forms didn't commit values set with `element.value=` (the flight failed the
first time). Playwright's `fill()`/`selectOption()` fire proper input/change
events and are reliable — so **the code's mechanism is fine**; this was only a
limitation of the manual walkthrough. No code change needed, but always check for
the validation error box after each save (the code's `readSaveErrors` does this).

## Net
The pipeline's **shape** is correct and every selector resolves, but it needs the
**passenger stage** (#1) and the **flight-field fixes** (#2) before it runs clean
end-to-end. #4 matters only for international bookings. With those in, the chain
booking → passenger → segments → costing → receipt will complete without errors.
