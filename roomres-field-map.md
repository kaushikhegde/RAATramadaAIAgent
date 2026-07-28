# Room-Res (RAA) — live site map for quote automation

Mapped live on 28-Jul-2026 against `https://room-res.com` while logged in as
**RAA Scyne Test Account / Kaushik Hegde**. Everything below was read off the real DOM.

---

## 1. Site shape

Base: `https://room-res.com`

| Nav item            | Path                        | What it is |
|---------------------|-----------------------------|------------|
| Home                | `/account`                  | Search panel (Hotels / Transfers / Attractions / Car Rentals / Tours) + agent tools |
| Reservations & Sales| `/account/reservations`     | Confirmed/paid bookings. Columns: Booking ID, Itinerary Code, Booking Date, Status, Payment Date, Customer, Check-in Date, Paid Amount, Product, Agent |
| Itineraries         | `/account/itineraries`      | Draft + held itineraries (this is the "cart"/quote basket) |
| Quotes              | `/account/customerquotes`   | Customer quote webpages generated off itineraries |
| Profile             | `/agent/profile`            | Agent details |
| Rewards             | `/account/rewards`          | Points/missions |
| Saved searches      | `/account/searches`         | |

Deep links used by the flow:

- Itinerary view: `/account/itinerary?id=<itineraryId>`  (e.g. `788795`)
- Quote builder:  `/account/customerQuoteStep1?id=<itineraryId>`
- One-click quote:`/account/createDefaultQuote?id=<itineraryId>`
- Public quote:   `/CustomerQuote/RAA_Scyne_Test_Account?id=<uuid>`

---

## 2. The quote flow (what "create a quote" actually means here)

```
Search  ->  Hotel page  ->  BOOK THIS ROOM  ->  /book  (guest names)  ->  Proceed
        ->  DRAFT ITINERARY is created  ("Draft Itinerary - TU788795 for Test User - Not Held or Paid for")
        ->  Create Customer Quote  (or one-click createDefaultQuote)
        ->  Quote appears in /account/customerquotes with a Quote Number (Q4xxxxx) + public URL + PDF
```

Key point: **"Proceed" does not pay or hold anything.** It creates a *draft itinerary*.
Payment only happens on the itinerary page via the "Pay & Confirm" tab
(`Pay & Confirm Booking(s)` red button) or "Hold & Pay Later". The automation stops
before both of those.

---

## 3. Home search form — `/account`

All ids are stable (not CSS-module hashed):

| Field | Selector | Notes |
|---|---|---|
| Destination | `#destination` (name `destination`) | Autocomplete. Groups: Cities/Areas, Point Of Interests, Hotels, Airports/Train Stations |
| Include package rates | `input[name="pkg"]` (checkbox) | default checked, value `1` |
| From | `#from` (name `dateFrom`) | display format `01-Aug-2026`, opens a datepicker |
| To | `#to` (name `dateTo`) | same |
| Rooms/guests | `#rooms` (name `room-0-adults`) | options `1`, `2`, `more` |
| Submit | button "Search hotels" | |

The destination suggestion list items are `div.XTFeuz0fElseLZ_7-koIa` — a hashed
CSS-module class, so **select by exact text, not by class**. The list takes ~3.4s
to appear and must never be raced with a fixed sleep — see §3b.

### 3a. The search is fully URL-driven (this is the big win)

Submitting produces:

```
/search?dateFrom=01-Aug-2026
       &dateTo=03-Aug-2026
       &destination=Sydney%2C+NSW%2C+AU
       &id=7222                 <- destination id from the autocomplete
       &ishotel=0
       &pkg=1
       &room-0-adults=2
       &room-0-children=0
       &roomsAmount=1
```

So once we know the destination `id`, we can skip the whole autocomplete + datepicker
dance and navigate straight to a search URL. Only the `id` needs the autocomplete
(one keystroke pass, cached per destination).

### 3b. The destination autocomplete is SLOW — wait on its API, not the DOM

Measured live on 28-Jul-2026, typing `Sydney` into `#destination`:

| | |
|---|---|
| typing finishes | +0.6s |
| `getdestinations` response | **+1.5s** |
| suggestion list actually paints | **+3.4s** |

A fixed `sleep(1200)` + a single DOM snapshot therefore **always** sampled the page
before the list existed, and every search died with *"Room-Res didn't offer a
destination matching …"* even though the list was about to render correctly.

The dropdown is backed by:

```
POST https://sam045jz07.execute-api.ap-southeast-2.amazonaws.com/rrwebapi-prod/v2/autocomplete/getdestinations
  {"keyword":"Sydney","userId":…,"agencyId":…}

  → {"destinations":[
       {"id":7222,"destination":"Sydney, NSW, AU","category":"Cities/Areas","levenshtein":8,"score":-80.49},
       …20 rows…
     ]}
```

Two things make this response the right thing to wait on:

* it carries the **same `id`** the search URL needs (`7222` — cf. §3a), so the id
  is available without ever clicking a suggestion; and
* `"destinations": []` is a **definitive** "no such destination" (Room-Res does not
  fuzzy-match — `Sydnye` returns zero rows), so a typo can fail in ~2s instead of
  waiting out the full timeout.

It is debounced but still fires for prefixes, so match the response to the request's
`keyword` — acting on the reply for `Sydne` can resolve a different destination.

After the API confirms a hit, the DOM row still has to be clicked to populate the
form, and the list **reflows while rendering** — so poll for the same text at the
same position twice before clicking, then confirm the field actually took the pick.
See `pickDestination()` in `room-res-quote.js`.

### 7a. The hotel block gained action rows — don't parse by position alone

The draft-itinerary hotel block is no longer just name / rooms / rating / address.
Seen live on `SG788967` (28-Jul-2026):

```
01-Aug-2026 - 03-Aug-2026
83 OSHR, Bondi Junction              <- hotel, city
1 Room, 1 Guests
Delete this Hotel from Itinerary     <- NEW action row
2/5
83 Old South Head Rd , Bondi Junction, AU
Hotel Notes                          <- NEW action row
Room Details
```

Two traps, both of which produced a *confident but wrong* draft summary reading
`SG788967: Delete this Hotel from Itinerary`:

* **Hotel names can start with a digit** (`83 OSHR`). The original parser skipped
  any line matching `/^\d/` to step over `1 Room, 2 Guests` — which silently
  discarded the real name and fell through to the delete link below it.
* **`Hotel Notes` now sits between the address and `Room Details`**, so "the line
  before Room Details" is no longer the address.

Skip lines you can *name* (the rooms/guests line, the `x/5` rating, known action
labels) rather than by shape. Regression cover: the `ITIN2` block in
`test-roomres.js`.

The header also carries more than one code series — `AQ…` and `SG…` both occur.

---

## 4. Search results — `/search`

Left rail filters: Hotel Name (`Enter hotel name` + arrow), Hotel Stars, Price per night,
Customer Rating, Neighbourhood. Top bar: View by (Card List), Sort by (Recommended), Showing (25).

Each hotel card shows **two rate tracks**:

- **RAA Net Rates** — yellow button, agent/net price (e.g. from AUD $269)
- **Online Prices** — "View Online Rates" button, retail price + `Commission $19.95`

Both open the hotel page in a **new tab**.

### 4a. Scraping the cards — two traps (found 28-Jul-2026, second pass)

The card's price panel reads, verbatim:

```
Average 1 night, 1 Guest
RAA NET RATE
from AUD $1,778
RAA Net Rates
ONLINE PRICES
from AUD $2,000
Commission $96.22
View Online Rates
```

⚠️ **Trap A — the card boundary must not be decided by text length.** The scraper
climbed up from the `a[href*="/hotelpage/"]` until `innerText` passed 90 characters.
That makes the boundary depend on **how many amenity chips a hotel lists**: The York
(5 chips: CBD, 24-hour front desk, air conditioning, bar, childcare) stopped one level
short of its price panel and scraped as priceless, while 83 OSHR (2 chips: Bondi
Junction, Lift) reached it. Measured live on Sydney 01→03-Aug-2026: **2 of 25 cards had
a price**. Climb until the ancestor contains `from AUD` instead, stopping before any
ancestor holding two hotel links. That reads **25 of 25**.

⚠️ **Trap B — `Commission $…` is a dollar figure on the card, and it is the smallest
one.** `Math.min` over every `$` on the card returns the commission ($96.22), not the
room rate ($1,778). Read only the labelled `from AUD $…` lines, and keep the two tracks
apart: net and online differ by hundreds of dollars on the same card, so a track-blind
comparison ranks nothing.

Combined, these two put a **$1,778/night** Bondi apartment on a quote as "the cheapest"
when a **$269** hotel was the first card on the same page — the shortlist was the two
cards that happened to scrape a price, ranked on their commission. Nothing about the run
looked wrong at the time, which is why `chooseHotel` now reports `priced N of M` in its
reason and sets `partialPricing`.

---

## 5. Hotel page — `/hotelpage/<hotelId>`

```
/hotelpage/140205?dateFrom=..&dateTo=..&destination=..&ishotel=0&pkg=1
                 &room-0-adults=2&room-0-children=0&roomsAmount=1
                 &type=net          <- net vs online rate track
                 &provider=3
                 &externalRef=
                 &actid=<uuid>      <- per-search activity id
```

Room area: top carousel of rate cards, then a full rate list with
`Filter by: Room Only / Breakfast Included / Flexible Cancellation / Pay Later`.

Each rate row carries: room name, refundability (NON REFUNDABLE / FLEXIBLE CANCELLATION),
board type (Room Only / Bed And Breakfast), TOTAL PRICE (AUD) for the whole stay, nights,
and a green **BOOK THIS ROOM** link.

---

## 6. Book page — `/book/<hotelId>`

```
/book/140205?...&roomId=0
            &roomRateCode=<opaque>
            &topRoomCategoryIndex=3&tp=683
```

### 6a. `roomRateCode` format varies by provider — never construct it

Two different providers on the *same hotel* produce two different encodings:

| Provider | `roomId` | `roomRateCode` |
|---|---|---|
| `provider=3`  | `STU.ST-1` | pipe-delimited: `20260801\|20260803\|W\|280\|133762\|STU.ST-1\|BAR CAMP\|RO\|\|1~2~0\|\|P@07~…` |
| `provider=14` | `0` | opaque 150-char hex hash |

**Rule for the automation: always follow the real `BOOK THIS ROOM` link. Never build
this URL by hand.** The rate row's link is the only reliable source.

### 6b. The form is a full hidden-field payload (verified live)

Reading `document.querySelectorAll('input,select,textarea,button')` on `/book/140205`
(provider 14) gives:

| # | Type | `name` | Live value |
|---|---|---|---|
| 2 | hidden | `bookingId` | *(empty on create)* |
| 3 | hidden | `hotelId` | `140205` |
| 4 | hidden | `dateFrom` | `01-Aug-2026` |
| 5 | hidden | `dateTo` | `03-Aug-2026` |
| 6 | hidden | `provider` | `14` |
| 7 | hidden | `total` | **`682.65`** |
| 8 | hidden | `cancellationDeadline` | `2026-07-28` |
| 9 | hidden | `pointsToUse` | `0` |
| 10 | hidden | `roomId` | `0` |
| 11 | hidden | `roomRateCode` | *(the opaque code)* |
| 12/13 | hidden | `room-0-adults` / `room-0-children` | `2` / `0` |
| 14 | select | `room-0-guest-0-title` | `Title / Mr / Mrs / Ms` |
| 15 | hidden | `room-0-guest-0-type` | `AD` (adult) |
| 16 | text | `room-0-guest-0-firstname` | |
| 17 | text | `room-0-guest-0-lastname` | |
| 18 | select | `room-0-guest-0-country` | ISO-2, default `AU` |
| 19 | tel | `room-0-phone` | |
| 20–23 | | `room-0-guest-1-title/-type/-firstname/-lastname` | |
| 24 | checkbox | `isTemplate` | `false` |
| 25 | checkbox | `accept` | **`true`** (pre-ticked) |
| 26 | button | — | `Proceed` |

Naming convention: **`room-<roomIndex>-guest-<guestIndex>-<field>`**, zero-based, plus
one `room-<roomIndex>-phone` per room. This is what makes multi-room support trivial.

> **`total` is the single most valuable field on the page.** It is the exact net cost
> (`682.65`) as a raw number — no `$`, no commas, no text parsing. Read it from
> `input[name="total"]` rather than scraping the price panel.

> ⚠️ **They are `type="hidden"`, and that has already cost us a live run.** Every field
> above the `title` select is hidden, so anything that waits on one must pass
> `state: "attached"`. Playwright's `waitForSelector` defaults to `state: "visible"`,
> which a hidden input can never satisfy — the wait sits there finding the elements
> and timing out on them anyway:
>
> ```
> waiting for locator('input[name="total"], input[name="roomRateCode"]') to be visible
>   64 × locator resolved to 2 elements. Proceeding with the first one:
> ```
>
> That is what stalled the 28-Jul-2026 run on `/book/4506591`: the step died before
> the guest fields were ever touched, so the screenshot showed an untouched form and
> a `Proceed` button that was never clicked. Read hidden values with `evaluate()`;
> never wait on their visibility. Regression cover: `test-roomres-bookform.js`.

**The form shape varies by provider.** Provider 3 renders only First/Last name per guest;
provider 14 adds Title, Country and Phone; provider 19 has Title/First/Last **and no
Country** (seen live on `/book/4506591`). The script must enumerate the actual
`room-*-guest-*` inputs present and fill what exists, not assume a fixed set.

### 6c. Some providers REQUIRE the guest contact number — and say so in their own JS

Provider 19 refuses `Proceed` with **"This field is required."** under *Guest Contact
Mobile Number* (`room-0-phone`) when it is blank. Two traps:

* **The field carries no `required` attribute** — not `required`, not `aria-required`.
  Checked live: `readBookFormShape` sees the box, and *nothing* on the form is marked
  required. So there is no constraint to pre-flight; the validation is entirely in the
  site's own JavaScript.
* **`Proceed` fails silently.** The click registers, no navigation happens, and the
  only evidence is the message painted next to the box.

So the run must *read the page's complaint* rather than wait out the navigation
timeout — the old code sat for 90s and then reported "check the form for validation
errors", which is exactly the information the page was already displaying.
`readBookFormErrors()` scrapes the visible complaints and the run fails in seconds.

The number itself is **never fabricated** — it goes to a real hotel, so it must be the
traveller's own. `lookupBookingClient` reads it off the Tramada passenger record
(`input[name="mobile"]`, "Mobile No") on the same trip that fetches the client name,
and the chat passes it to `runRoomResDraft` as `phone`. If the passenger has no mobile
on file the run stops and says so, rather than substituting anything.

The `<field>` half is also spelled inconsistently between providers (`firstname`,
`first-name`, `firstName`), so `readBookFormShape` normalises it to one key. If a
provider drops the convention altogether it falls back to matching the form's own
labels ("Guest First Name", "Guest Last Name", "Guest Contact Mobile Number") and
reports `shapeSource: "labels"` so the fallback is visible in the stage log.

`form_input`-style value setting (native setter + `input`/`change` events) sticks
correctly on these React inputs — verified live; no keystroke simulation needed here.

Right rail price panel text (for cross-checking `total`):

```
The York by Swiss-Belhotel International
5 York Street, Sydney, New South Wales, 2000, AU
1 Room: Studio
1 Aug 2026 - 3 Aug 2026
2 Guests
Saturday, August 1, 2026   $341.32
Sunday, August 2, 2026     $341.32
Total  $682.65AUD
This price is inclusive of 10% GST
ABN 24 610 780 320
Board Type  Room Only
```

---

## 7. Itinerary page — `/account/itinerary?id=<id>`

`Proceed` does a **client-side redirect to `/account/itinerary?id=<newItineraryId>`**.
There is no interstitial and no confirmation dialog. Wait for the URL to change.

The **itinerary code is derived, not random**: guest initials + itinerary id.
`Autotest Quoteone` + `788851` → **`AQ788851`**. (Earlier: `Test User` + `788795` → `TU788795`.)
So the code can be predicted from the lead guest name once the id is known — but read it
off the header rather than computing it.

There is **no embedded JSON state and no JSON API** on this page — no `__NEXT_DATA__`,
no `/api/` XHR (verified by reading the network log on a clean load). The page is
server-rendered, so the itinerary must be read as text. The good news is that the text
is completely regular:

```
Draft Itinerary - AQ788851 for Autotest Quoteone - Not Held or Paid for
...
01-Aug-2026 - 03-Aug-2026
The York by Swiss-Belhotel International, Sydney
1 Room, 2 Guests
4.5/5
5 York Street , Sydney, AU
Room Details
Room 1: Studio
Guest 1: Autotest Quoteone
Guest 2: Autotest Quotetwo
Board Type: Room Only
Price Details
Saturday, August 1, 2026    $341.32
Sunday, August 2, 2026      $341.32
Total Price:  $682.65AUD
This price is inclusive of 10% GST
Cancellation Policy
FREE Cancellation until 28-Jul-2026 12:00
If you cancel this booking from now until 28-Jul-2026 12:00, cancellation charge=$0.00.
If you cancel this booking from 28-Jul-2026 12:00 onwards, cancellation charge $682.65.
```

Every field the Tramada segment needs is in there: dates, hotel, city, address, room
count, guest count, room type, guest names, board type, per-night rows, total, and the
cancellation deadline. Parse with anchored regexes (`/^Room (\d+): (.+)$/m`,
`/^Guest (\d+): (.+)$/m`, `/Total Price:\s*\$([\d,.]+)AUD/`, etc.).

Header: `Draft Itinerary - TU788795 for Test User - Not Held or Paid for`

Action buttons: `Refresh All Rates`, `Add Another Product`, `Change Itinerary Code`,
`Create Template`, **`Create Customer Quote`**, `The Duplicator: Create Another Itinerary Like This`,
plus the one-click quote link → `/account/createDefaultQuote?id=<id>`.

Per-segment card: date range, hotel name + city, rooms/guests, room type, guest names,
board type, per-night price rows, **Total Price** (inc 10% GST), cancellation policy,
`Add Transfer to this Hotel` / `Add Transfer from this Hotel` / `Add Attraction to this Hotel`,
and `Delete this Hotel from Itinerary`.

Bottom: two tabs — **Pay & Confirm** (points, credit card dropdown, `Pay & Confirm Booking(s)`)
and **Hold & Pay Later**. *The automation must never touch either.*

---

## 8. Quote builder — `/account/customerQuoteStep1?id=<itineraryId>`

Title: "Build a Beautiful Customer Quote Webpage for Itinerary 788795".
Note on the page: *Room-Res.com prices will not be on the quote, and nor will Cancellation Policies.*

23 controls, all with clean ids:

| # | Selector | Type | Meaning |
|---|---|---|---|
| 1 | `#addTitieText` (name `addTitieText`) | text | Quote title, e.g. "Sydney Escape" (note the typo in the id — it's `Titie`, not `Title`) |
| 2 | `#add_title_yes` / `#add_title_no` | radio | include the title |
| 3 | `#add_main_image_no` / `#add_main_image_yes` | radio | default image vs custom upload |
| 4 | `#packageDescription`, `#packageDescription2`, `#packageDescription3` | text | 3 package-highlight lines, pre-filled e.g. "3 Nights at 5 Star The York by Swiss-Belhotel International" / "Enjoy Wonderful Sydney" / "Great Value" |
| 5 | `#showAddDescription_yes` / `_no` | radio | include the highlights |
| 6 | `#show_customer_name_yes` / `_no` | radio | include customer name |
| 7 | `#show_itinerary_date_mode1` / `2` / `0` | radio | how itinerary dates display |
| 8 | `#show_total_price_yes` / `_no` | radio | show a total price to the customer |
| 9 | `#guestTotalPrice` | number | **the price quoted to the customer** (i.e. net cost + our margin) |
| 10 | `#add_price_yes` / `_no` | radio | per-element prices |
| 11 | `#personalMessageText` | text | personal message |
| 12 | `#personalMessage_yes` / `_no` | radio | include it |
| — | button "Generate Quote" | | commits the quote (two of them — top and bottom, identical) |

The Generate Quote control is `<button class="btn btn--green" type="submit">Generate
Quote</button>`, wrapped in a full-width `<div>` that carries the same `innerText`. Match
on `button` / `input[type=submit]` only — widening the selector to `div` hands back the
wrapper.

### 8a. Live defaults — two of them are traps

Read straight off a freshly-opened builder for itinerary 788851:

| Control | Default | Note |
|---|---|---|
| `addTitieText` | `Sydney Escape` | auto-generated from the destination |
| `add_title` | **Include** | |
| `add_main_image` | **Use the Default Image** | |
| `packageDescription` | `2 Nights at 5 Star The York by Swiss-Belhotel International` | night count is computed |
| `packageDescription2` | `Enjoy Wonderful Sydney` | |
| `packageDescription3` | `Great Value` | |
| `showAddDescription` | Include | |
| `show_customer_name` | Include | |
| `show_itinerary_date_mode` | `mode1` (Include Dates) | |
| **`show_total_price`** | **`_no` — DON'T show** | ⚠️ trap 1 |
| **`guestTotalPrice`** | **`682.65` — the agent NET cost** | ⚠️ trap 2 |
| `add_price` | No | |
| `personalMessageText` | `I think you'll love this package, and it's great value. Call me to discuss.` | |
| `personalMessage` | Include | |

⚠️ **Trap 1:** if the script does nothing, the customer sees a quote with **no price at
all**. `#show_total_price_yes` must be clicked explicitly.

⚠️ **Trap 1b — the ordering trap (found 28-Jul-2026, second pass).** `#guestTotalPrice`
is **`display: none` while `show_total_price` is `_no`**, i.e. on every fresh load.
Verified live on the builder for itinerary `788967`:

| | `display` | box | `offsetParent` | `value` |
|---|---|---|---|---|
| on load | `none` | 0 × 0 | `null` | `3556.75` |
| after clicking `#show_total_price_yes` | `block` | 157 × 33 | set | `3556.75` |

The value is in the DOM the whole time, so *reading* it works — but the box is not
**visible** until the radio is ticked. Playwright's `waitForSelector` defaults to
`state:"visible"`, so waiting on `#guestTotalPrice` *before* clicking the radio can
never resolve: it burns its full timeout and throws, leaving a draft itinerary with no
quote against it. Exactly the same shape as the hidden-input trap on `/book` (§6b), and
it is what stopped every run between the draft and the quote.

Correct order: wait `state:"attached"` → click `#show_total_price_yes` → wait
`state:"visible"` → overwrite the price. The `Your total agent price…` label sits in the
same hidden block, so read that after the reveal too.

Note also that these radios are real `<input type=radio>` boxes (13 × 13, visible) but
React owns their `checked` state — click and then **verify `.checked`**, rather than
trusting that the click landed.

⚠️ **Trap 2:** `#guestTotalPrice` comes pre-filled with the **agent net cost**. Left
alone, we quote the customer our own cost price and make zero margin. It must be
overwritten with cost + margin every single time.

The page also prints the net cost as label text next to the box:
`Your total agent price for this itinerary is $682.65` — a useful cross-check.

### 8b. "See more content options. Click Here" reveals three more radios

| `name` | Options | Default |
|---|---|---|
| `showMap` (`#showMap_on` / `#showMap_off`) | Include / Don't Include | **Include** |
| `showContentForAnotherElement` | Yes / No | No |
| `showFlightDetail` | Yes / No | No |

These three are collapsed until the "Click Here" link is clicked, so they are absent
from the DOM on first load. Only touch them if we ever need to hide the map.

### 8c. What `Generate Quote` actually does (previously unmapped)

**It does not navigate.** The URL stays `/account/customerQuoteStep1?id=<itineraryId>`.
The result is appended to the bottom of the same page:

```
Quote URL: https://room-res.com/CustomerQuote/RAA_Scyne_Test_Account?id=<uuid>
PDF Link:  Generate PDF
[ Copy Link ]  [ Post to Facebook ]
```

So the automation waits for the `Quote URL:` block to appear and reads the href out of
it. Format: `/CustomerQuote/<AccountSlug>?id=<uuid>` where `<AccountSlug>` is the agency
account name with underscores (`RAA_Scyne_Test_Account`) and `<uuid>` is the quote's
public id — **not** the itinerary id and **not** the quote number.

`PDF Link: Generate PDF` is an on-demand generator, not a pre-built file.

**The quote number (`Q4xxxxx`) is not shown here.** It only appears in the quotes list,
so it has to be read back from `/account/customerquotes` (section 9).

### 8d. Public quote page — what the customer sees

`GET /CustomerQuote/RAA_Scyne_Test_Account?id=<uuid>` renders:

```
Your Trip                       [I like it!]
Sydney Escape - Autotest
01-Aug-2026 - 03-Aug-2026
Prepared for Autotest Quoteone.
Total Price = $780.00          <- the QUOTED price, never the net cost
2 Nights at 5 Star The York by Swiss-Belhotel International
Enjoy Wonderful Sydney
Great Value
The York by Swiss-Belhotel International, Sydney
Studio - Room Only / 1 Rooms, 2 Adults
5 York Street, Sydney, New South Wales, 2000, AU
[property description] [Google map] [personal message]
[I like it]  "Clicking this button won't confirm the booking, but it will start
             reserving the items..."
```

Confirmed: the net cost never leaks to the customer page, and the `I like it` button is
an expression of interest only — it does not book or pay.

---

## 9. Quotes list — `/account/customerquotes`

Tabs: View All Quotes / View Itinerary Quotes Only / View Template Quotes Only.
Columns: **Itinerary Code, Customer Name, Agent Name, Quote Name, Quote Number,
Total Cost Price, Total Price Quoted, See PDF, Open URL, Edit Quote, Customer Interaction (view count)**.

Live examples in the test account (top row is the run described in section 12):

| Itinerary | Customer | Quote name | Quote no. | Cost price | Price quoted |
|---|---|---|---|---|---|
| AQ788851 | Autotest Quoteone | Sydney Escape - Autotest | **Q422380** | 682.65 | **780.00** |
| TU788795 | Test User | Sydney Escape | Q422376 | 749.65 | 749.65 |
| KK786950 | kk kk | Palm Cove Escape | Q422250 | 1070.25 | 1070.25 |

`Total Cost Price` = what we pay Room-Res. `Total Price Quoted` = `#guestTotalPrice`.
That gap is the margin, and it is what has to be reflected in the Tramada costing line.

### 9a. DOM shape — how to read the quote number back

The page contains **exactly one `<table>`**, with one `<tbody> <tr>` per quote and
**12 `<td>` per row** at fixed indices:

| idx | Content | idx | Content |
|---|---|---|---|
| 0 | Itinerary Code (`AQ788851`) | 6 | Total Price Quoted (`780.00`) |
| 1 | Customer Name | 7 | See PDF → `View` |
| 2 | Agent Name | 8 | Open URL → `View` |
| 3 | Quote Name | 9 | `Edit Quote` |
| 4 | **Quote Number (`Q422380`)** | 10 | `View: 0` (customer interaction count) |
| 5 | Total Cost Price (`682.65`) | 11 | *(empty)* |

Read-back algorithm: after `Generate Quote`, load `/account/customerquotes`, find the
`tr` whose `td[0]` equals the itinerary code, take `td[4]` as the quote number and
`td[5]`/`td[6]` as cost/quoted. Newest quote is the first row, but match on the
itinerary code rather than trusting the order.

---

## 10. What this gives the automation

Everything on the critical path has either a stable `id` or a URL parameter, so the
Playwright module can be almost entirely URL-driven:

1. `#destination` autocomplete once → destination `id`
2. `GET /search?...` → pick hotel (by name filter or first/cheapest)
3. `GET /hotelpage/<id>?...&type=net` → pick rate row (room type + board + refundability)
4. `BOOK THIS ROOM` → `/book/<id>?...` → fill guest names → **Proceed**
5. Land on `/account/itinerary?id=<n>` → scrape hotel, dates, room, board, per-night, total
6. `Create Customer Quote` → fill `#addTitieText`, `#packageDescription*`, `#guestTotalPrice` → **Generate Quote**
7. Read back Quote Number + public URL + PDF from `/account/customerquotes`

Then hand `{ hotel, address, city, checkIn, checkOut, roomType, boardType, guests,
nights, netTotal, quotedTotal, itineraryCode, quoteNumber, quoteUrl }` to the existing
Tramada hotel-segment + costing + EFT-receipt creators.

---

## 11. Not yet mapped

- Transfers / Attractions / Car Rentals / Tours tabs (hotels only so far)
- "Hold & Pay Later" flow and what confirmation number it produces
- The `Generate PDF` output format (on-demand generator, not inspected)
- Multi-room / children / multi-hotel itineraries (the `room-<n>-guest-<m>-*` naming
  makes this look mechanical, but it has not been run)
- What `I like it` on the public quote page posts back, and where that lands in the
  agent portal (presumably the `Customer Interaction` column)

---

## 12. Verified end-to-end run — 28-Jul-2026

Run live on the RAA Scyne Test Account with the user's explicit permission, to capture
the post-submit pages. Nothing was paid or held.

| Step | Result |
|---|---|
| Search | `Sydney, NSW, AU` (`id=7222`), 01-Aug-2026 → 03-Aug-2026, 1 room / 2 adults |
| Hotel | The York by Swiss-Belhotel International (`hotelId=140205`), RAA Net Rates (`type=net`) |
| Rate | Studio, Flexible Cancellation, Room Only, provider 14, `tp=683` |
| Book form | Mr Autotest Quoteone + Ms Autotest Quotetwo, AU, `0400000000` |
| Hidden `total` | `682.65` |
| **Proceed** | → `/account/itinerary?id=788851`, draft `AQ788851`, *Not Held or Paid for* |
| Quote builder | title `Sydney Escape - Autotest`, `show_total_price_yes`, `guestTotalPrice = 780.00` |
| **Generate Quote** | Quote URL appended in place: `/CustomerQuote/RAA_Scyne_Test_Account?id=3b9382f9-42b1-4200-8272-a198e9c7a365` |
| Quotes list | `AQ788851 · Q422380 · cost 682.65 · quoted 780.00` |
| Public page | renders `Total Price = $780.00`; net cost not exposed |

Elapsed: roughly 45 seconds of page time. Neither `Pay & Confirm Booking(s)` nor
`Hold & Pay Later` was touched.

**Clean-up note:** `AQ788851` / `Q422380` are throwaway test records. They are draft +
quote only — no booking, no payment, no supplier commitment — but they will sit in the
Itineraries and Quotes lists until deleted from the portal by hand.

---

## 13. Timing and stability notes for the Playwright module

- The site is a React SPA. After every navigation, wait on a **content anchor**, not a
  fixed timeout: `Draft Itinerary -` on the itinerary page, `Build a Beautiful Customer
  Quote Webpage` on the builder, `Quote URL:` after Generate Quote.
- Search results and the hotel page take 5–8s to populate; the hotel page renders its
  header before the rate list exists, so wait for `BOOK THIS ROOM` specifically.
- `BOOK THIS ROOM` navigates **in the same tab** when clicked from the hotel page, but
  the search-results rate buttons (`RAA Net Rates` / `View Online Rates`) open a **new
  tab**. Under CDP, handle the `page`/`popup` event rather than assuming same-tab.
- `actid` (the per-search activity id) stayed valid across a full browser-context
  restart during this run, so it is not a short-lived nonce — but treat it as
  session-scoped and re-run the search if the hotel page 404s or shows no rates.
- Rate-row prices on the hotel page are rounded for display (`$683`); the authoritative
  figure is `input[name="total"]` on `/book` (`682.65`). Never quote off the rounded one.
