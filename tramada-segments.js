/**
 * tramada-segments.js — Playwright + CDP itinerary/segment + costing automation.
 *
 * Fills the middle of the pipeline that tramada-booking.js (add booking) and
 * tramada-receipt.js (receipt) leave open:
 *
 *   add booking  →  ADD SEGMENTS (flight, hotel)  →  COST THEM  →  receipt
 *
 * Field IDs were mapped live against raatravelsandbox TTMS (v7.10.3):
 *   - Flight segment:  booking-flight-segment.htm?mode=add&parentId={id}
 *   - Hotel segment:   booking-hotel-segment.htm?mode=add&parentId={id}   (pricing is inline → self-costs)
 *   - Ticket costing:  booking-air-segment.htm?mode=add&pageSourceParam=costingsPage&parentId={id}
 *   - Costing list:    booking-costings.htm?mode=edit&id={id}
 *
 * IMPORTANT — only COSTED segments are receiptable. A hotel is costed on its own
 * form (rate incl GST). A flight/ticket carries no price on the segment form, so
 * it must be costed separately via a Ticket costing entry.
 *
 * NOTE on creditor fields (#costingcreditor): these behave like autocompletes in
 * Tramada. This module types the value; if a tenant requires picking a matched
 * suggestion, verify that step live (see the pickAutocomplete helper).
 */

const { chromium } = require("playwright");
const { runTramadaAddAndSearch } = require("./tramada-booking");
const { runTramadaReceipt } = require("./tramada-receipt");

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_MODE = process.env.CDP_MODE || "external";
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || "chrome";
const HEADLESS = process.env.HEADLESS === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toTramadaDate(input) {
  if (!input) return "";
  const iso = String(input).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  return input;
}

// Flight number: digits only, max 4 chars ("QF400" -> "400"). Tramada rejects >4.
function toFlightNumber(v) {
  return String(v || "").replace(/\D/g, "").slice(0, 4);
}

// Booking-class code, max 2 chars. Maps common cabin names; else takes ≤2 chars.
function toClassCode(v) {
  if (!v) return "";
  const map = { economy: "Y", business: "J", first: "F", "premium economy": "W", premium: "W" };
  const key = String(v).trim().toLowerCase();
  if (map[key]) return map[key];
  return String(v).toUpperCase().slice(0, 2);
}

/* ── browser / login (same pattern as sibling modules) ─────────────────── */

async function openBrowser(onProgress) {
  const launchChrome = async () => {
    const browser = await chromium.launch({
      channel: BROWSER_CHANNEL,
      headless: HEADLESS,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    return { browser, launched: true };
  };
  if (CDP_MODE === "internal") {
    onProgress(5, `Launching Chrome (${BROWSER_CHANNEL})...`);
    return await launchChrome();
  }
  onProgress(5, `Connecting to CDP Chrome at ${CDP_HOST}:${CDP_PORT}...`);
  try {
    const browser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);
    return { browser, launched: false };
  } catch (cdpErr) {
    // Fail honestly rather than launching an unauthenticated throwaway Chrome
    // (which would produce a misleading "not logged in").
    throw new Error(
      `Could not connect to Chrome on ${CDP_HOST}:${CDP_PORT}. ` +
        `Run "npm run start:chrome" and log into Tramada IN THAT WINDOW first. [${cdpErr.message}]`
    );
  }
}

// Reliable auth check via a PROTECTED page (login.htm serves the form even when
// authenticated, so checking it directly gives false "not logged in").
async function tramadaIsAuthed(page) {
  await page
    .goto(`${TRAMADA_BASE_URL}/home/home.htm`, { waitUntil: "domcontentloaded" })
    .catch(() => {});
  return !page.url().includes("login.htm");
}

async function ensureLoggedIn(page, { username, password, onNeedLogin } = {}) {
  if (await tramadaIsAuthed(page)) return;

  if (username && password) {
    await page.goto(`${TRAMADA_BASE_URL}/login.htm`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#username", { state: "visible", timeout: 15000 });
    await page.fill("#username", username);
    await page.fill("#loginForm_password", password);
    await page.click("#loginForm_login");
    await page.waitForURL((u) => !u.toString().includes("login.htm"), { timeout: 30000 }).catch(() => {});
    if (page.url().includes("login.htm")) throw new Error("Tramada login failed (check credentials / OTP).");
    await sleep(500);
    return;
  }

  // No credentials — ask the user to sign in and WAIT (don't quit the run).
  if (typeof onNeedLogin === "function") onNeedLogin();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await tramadaIsAuthed(page)) { await sleep(500); return; }
  }
  throw new Error("Timed out waiting for Tramada login. Sign in to the shared Chrome and try again.");
}

/* ── small helpers ─────────────────────────────────────────────────────── */

// Fill a field only if a value was supplied and the field exists AND is
// editable. Tramada computes some fields (e.g. hotel #duration from the
// check-in/out dates) and marks them readonly — filling those hangs Playwright
// for 30s, so skip them. Short timeout so a surprise never stalls a run.
async function fillIf(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  const first = el.first();
  const editable = await first
    .evaluate((n) => !n.readOnly && !n.disabled)
    .catch(() => true);
  if (!editable) return; // computed/readonly field — Tramada fills it itself
  await first.fill(String(value), { timeout: 10000 });
}

// Set a <select> instantly by matching value, exact label, or label-contains.
// (Playwright's selectOption WAITS 30s per failed attempt when the value
// doesn't exactly match an option — "Adult" vs value "ADULT", "Published" vs
// label "Published [PUBLISHED]" — which is what made costing take minutes.)
async function selectIf(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  await el.first().evaluate((sel, want) => {
    const w = String(want).trim().toLowerCase();
    const opts = Array.from(sel.options || []);
    const hit =
      opts.find((o) => (o.value || "").toLowerCase() === w) ||
      opts.find((o) => (o.textContent || "").trim().toLowerCase() === w) ||
      opts.find((o) => (o.textContent || "").toLowerCase().includes(w));
    if (hit) {
      sel.value = hit.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, String(value)).catch(() => { /* leave default */ });
}

// In-page finder for the best autocomplete suggestion for the input given by
// arg.sel. CRITICAL: only nodes in the DROPDOWN ZONE — directly BELOW the
// input and horizontally overlapping it — are candidates. Without that, a
// contains-match can hit unrelated page text (the sidebar "Itinerary: MEL →
// SYD" link matched "MEL" once, and clicking it navigated the whole page).
// Prefers an exact CODE match — "(MEL) ..." / "[TEMPO] ..." — over contains.
// Returns {text, x, y} or null; when arg.doClick, also fires a synthetic click.
function _findSuggestion(arg) {
  const input = document.querySelector(arg.sel);
  if (!input) return null;
  const ir = input.getBoundingClientRect();
  const val = String(arg.raw).trim().toUpperCase();
  const esc = val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const inDropdownZone = (n) => {
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const below = r.top >= ir.bottom - 4 && r.top <= ir.bottom + 340; // just under the field
    const overlap = r.left < ir.right + 80 && r.right > ir.left - 80; // roughly same column
    return below && overlap;
  };

  const vis = Array.from(document.querySelectorAll("li, div, td, a")).filter(
    (n) =>
      n.offsetParent !== null &&
      (n.textContent || "").trim() &&
      (n.textContent || "").length < 80 &&
      inDropdownZone(n)
  );

  let hit = vis.find((n) => new RegExp("^\\s*[\\(\\[]" + esc + "[\\)\\]]").test(n.textContent || ""));
  if (!hit) {
    hit = vis.find((n) => {
      const t = (n.textContent || "").trim().toUpperCase();
      return t.includes(val) && t !== val; // skip the input's own text echo
    });
  }
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  if (arg.doClick) hit.click();
  return { text: (hit.textContent || "").trim().slice(0, 60), x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Fill a Tramada autocomplete field reliably.
 *
 * Per attempt (max 2, re-typing between attempts):
 *   1. Type with REAL keystrokes, then poll until the suggestion list is
 *      loaded AND STABLE (same entry at the same position on two consecutive
 *      polls — dropdowns reposition while rendering, which made single-shot
 *      coordinate clicks miss).
 *   2. Commit with a SYNTHETIC in-page click first — proven for the city and
 *      supplier dropdowns (it's what saved the flights in earlier runs).
 *   3. VERIFY the field's value actually changed. If not, fall back to a REAL
 *      mouse click at freshly measured coordinates — required by the Creditor
 *      widget, which ignores synthetic clicks. Verify again.
 * Fields that expand inline with no dropdown (e.g. Airline) are accepted via a
 * blur-and-check. Only after both attempts fail does it throw.
 */
async function pickAutocomplete(page, selector, value) {
  if (!value) return null;
  const el = page.locator(selector);
  if (!(await el.count())) return null;
  const first = el.first();
  const typed = String(value).trim().toUpperCase();

  // The pick "registered" iff the field no longer holds just the raw typed text.
  const registered = async () => {
    const v = ((await first.inputValue().catch(() => "")) || "").trim();
    return v && v.toUpperCase() !== typed ? v : null;
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    await first.click();
    await first.fill("");
    await first.type(String(value), { delay: 60 }); // real keystrokes → dropdown

    // Poll for a STABLE match: same text & position on two consecutive polls.
    let match = null;
    let prev = null;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      const cur = await page
        .evaluate(_findSuggestion, { sel: selector, raw: String(value), doClick: false })
        .catch(() => null);
      if (cur && prev && cur.text === prev.text && Math.abs(cur.y - prev.y) < 2) {
        match = cur;
        break;
      }
      prev = cur;
    }

    if (!match) {
      // No dropdown — maybe an inline-expanding field (Airline). Blur and check.
      await first.evaluate((n) => n.blur()).catch(() => {});
      await sleep(800);
      const v = await registered();
      if (v) return v; // widget expanded it itself, e.g. "QANTAS" → "QANTAS AIRWAYS(QF)"
      continue; // re-type and try again
    }

    // (a) Synthetic in-page click — the method that worked for city/supplier.
    await page.evaluate(_findSuggestion, { sel: selector, raw: String(value), doClick: true }).catch(() => null);
    await sleep(500);
    let v = await registered();
    if (v) return v;

    // (b) Real mouse click at FRESH coordinates — needed by the Creditor widget.
    const fresh =
      (await page.evaluate(_findSuggestion, { sel: selector, raw: String(value), doClick: false }).catch(() => null)) ||
      match;
    await page.mouse.move(fresh.x, fresh.y);
    await sleep(150);
    await page.mouse.click(fresh.x, fresh.y);
    await sleep(600);
    v = await registered();
    if (v) return v;
    // Neither click registered — loop re-types and tries once more.
  }

  throw new Error(`Autocomplete ${selector}: could not select "${value}" (no click registered after 2 attempts)`);
}

// Set a date input the PROVEN way: native setter + input/change/blur events
// (this is exactly how all three successful manual bookings were driven).
// Playwright fill() left the hotel Check Out Date mangled, so dates avoid it.
// Verifies the field holds exactly what we set.
async function setDateField(page, selector, value) {
  if (!value) return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  const got = await el.first().evaluate((n, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(n, v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
    n.dispatchEvent(new Event("blur", { bubbles: true }));
    return n.value;
  }, String(value));
  if (got !== String(value)) {
    throw new Error(`Date field ${selector} ended up as "${got}" (expected "${value}")`);
  }
}

// Read any validation errors after a save.
async function readSaveErrors(page) {
  return await page.evaluate(() => {
    const out = [];
    const sels = [
      'div[style*="border"][style*="red"]',
      ".errorMessages",
      'fieldset[class*="error"]',
      '[class*="error" i]',
      'font[color="red"]',
      'span[style*="red"]',
      'a[href*="#"][style*="red"]',
    ];
    document.querySelectorAll(sels.join(",")).forEach((box) => {
      const t = (box.textContent || "").trim();
      if (t && t.length < 400 && /invalid|must be|required|entered|cannot|no longer than|already/i.test(t)) {
        t.split("\n").map((s) => s.trim()).filter(Boolean).forEach((s) => out.push(s));
      }
    });

    // Layout-based fallback: Tramada renders the error box between the
    // "Add / Edit ..." title and the "Segment Created :" label. Whatever text
    // sits in that band IS the error list, regardless of markup/CSS.
    const lines = (document.body.innerText || "").split("\n").map((s) => s.trim());
    const start = lines.findIndex((l) => /^Add\s*\/\s*Edit/i.test(l));
    const end = lines.findIndex((l) => /^Segment Created/i.test(l));
    if (start >= 0 && end > start + 1) {
      lines
        .slice(start + 1, end)
        .filter((l) => l && !/^(Help|Knowledge Base|Undo|Save)$/i.test(l))
        .forEach((l) => out.push(l));
    }
    return [...new Set(out)].slice(0, 10);
  });
}

// Set a money/number field the proven way: native setter + input/change/blur
// events, so Tramada's recompute handlers (Client Due totals) actually fire —
// Playwright fill() alone left the totals at 0.00. Verifies numerically
// (Tramada may reformat "200" → "200.00").
async function setMoneyField(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  const got = await el.first().evaluate((n, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(n, v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
    n.dispatchEvent(new Event("blur", { bubbles: true }));
    return n.value;
  }, String(value));
  if (Math.abs(parseFloat(got || "0") - parseFloat(String(value))) > 0.001) {
    throw new Error(`Field ${selector} ended up as "${got}" (expected ${value})`);
  }
}

/**
 * Has the segment form reached a SAVED state? Two distinct success shapes:
 *  - Flights: Tramada NAVIGATES back to the itinerary list.
 *  - Hotels: Tramada RELOADS THE SAME FORM in edit mode — the URL gains an id
 *    and the "Segment Created :" header gets a timestamp. Treating that as
 *    "not saved" made the code re-click Save and record the segment again.
 */
async function segmentFormSaved(page) {
  const url = page.url();
  if (!/-segment\.htm/i.test(url)) return true; // navigated away → saved
  if (/[?&]id=\d+/.test(url)) return true; // form reloaded in EDIT mode → saved
  return await page.evaluate(() => {
    const m = (document.body.innerText || "").match(/Segment Created\s*:\s*([^\n]+)/i);
    return !!(m && m[1] && m[1].trim()); // "Segment Created : Fri 24 Jul ..." → saved
  }).catch(() => false);
}

/**
 * Click Save and WAIT for a definitive outcome: a saved state (navigation OR
 * edit-mode reload) or an error box. Polls up to ~15s; re-clicks Save once
 * midway ONLY while the form is still verifiably unsaved.
 */
async function saveSegmentForm(page) {
  const clickSave = async () => {
    try { await page.click("#save", { timeout: 5000 }); } catch { /* button busy */ }
  };
  await clickSave();
  for (let i = 0; i < 25; i++) {
    await sleep(600);
    if (await segmentFormSaved(page)) return; // saved (either shape)
    const errs = await readSaveErrors(page);
    if (errs.length) return; // rejected with visible errors → assertSaved reports them
    if (i === 8) await clickSave(); // ~5s in, still unsaved and error-free — click once more
  }
}

// After a segment save, confirm it actually persisted (either success shape).
// Only an unsaved form is a failure — surfaced with the on-page validation
// text and a screenshot in last-error.png.
async function assertSaved(page, kind) {
  if (await segmentFormSaved(page)) return;
  const errors = await readSaveErrors(page);
  let shot = "";
  try {
    await page.screenshot({ path: "last-error.png", fullPage: true });
    shot = " [screenshot: last-error.png]";
  } catch { /* screenshot is best-effort */ }
  throw new Error(
    `${kind} did not save${errors.length ? ": " + errors.join("; ") : " (form rejected, no error text found)"}${shot}`
  );
}

/* ── Flight segment (details only; not priced) ─────────────────────────── */

async function addFlightSegment(page, bookingNo, seg) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-flight-segment.htm?mode=add&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#airline", { timeout: 15000 });

  // Airline + cities are VALIDATED AUTOCOMPLETES (type → pick), not free text.
  // Airline "QANTAS" resolves to "QANTAS AIRWAYS(QF)"; cities to "(SYD) SYDNEY, ...".
  await pickAutocomplete(page, "#airline", seg.airline);            // Airline Name (required)
  await pickAutocomplete(page, "#departureCityCode", seg.fromCity); // e.g. MEL (required)
  await pickAutocomplete(page, "#arrivalCityCode", seg.toCity);     // e.g. SYD (required)
  // Flight Number must be ≤4 chars (digits only); Class must be ≤2 chars (booking code).
  await fillIf(page, "#flightNumber", toFlightNumber(seg.flightNumber));
  await fillIf(page, "#airlineClass", toClassCode(seg.class));      // Class
  await setDateField(page, "#departureDate", toTramadaDate(seg.departureDate)); // required
  await fillIf(page, "#departureTime", seg.departureTime);
  await setDateField(page, "#arrivalDate", toTramadaDate(seg.arrivalDate));     // required
  await fillIf(page, "#arrivalTime", seg.arrivalTime);
  await fillIf(page, "#fareBasis", seg.fareBasis);
  await selectIf(page, "#itinerarystatusTypeCode", seg.status || "HK");   // Confirmed [HK]
  await selectIf(page, "#baggageAllowanceTypeCode", seg.baggage);

  // Journey Info (right column) = the stopOvers sector-0 collection. Its
  // Departure City auto-syncs from the main field, but the ARRIVAL city does
  // NOT — leaving "Journey Info › Arrival City" blank. Fill sector-0 arrival
  // (autocomplete) plus its dates/times so the journey detail matches the
  // itinerary. Wrapped in try/catch: on tenants without this section the
  // selectors simply don't exist and are skipped.
  try {
    await setDateField(page, "#stopOversFieldSetCollectiondepartureDate0", toTramadaDate(seg.departureDate));
    await fillIf(page, "#stopOversFieldSetCollectiondepartureTime0", seg.departureTime);
    await setDateField(page, "#stopOversFieldSetCollectionarrivalDate0", toTramadaDate(seg.arrivalDate));
    await fillIf(page, "#stopOversFieldSetCollectionarrivalTime0", seg.arrivalTime);
    await pickAutocomplete(page, "#stopOversFieldSetCollectionarrivalCityCode0", seg.toCity);
  } catch { /* no Journey Info sector on this tenant */ }

  await sleep(300);
  await saveSegmentForm(page);
  await assertSaved(page, `Flight segment ${seg.fromCity || ""}→${seg.toCity || ""}`);
  return { type: "FLT", reference: `${seg.airline || ""} ${seg.flightNumber || ""}`.trim() };
}

/* ── Hotel segment (pricing inline → self-costs) ───────────────────────── */

async function addHotelSegment(page, bookingNo, seg) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-hotel-segment.htm?mode=add&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#supplierName, #hotelName", { timeout: 15000 });

  // Hotel name. #supplierName is a VALIDATED AUTOCOMPLETE of KNOWN suppliers.
  // Document names ("Novotel Bali Ngurah Rai Airport") usually AREN'T in that
  // list (Tramada has "NOVOTEL BALI AIRPORT"), so: only try the autocomplete for
  // an explicit listed supplier, and on no-match FALL BACK to the free-form name
  // field (#hotelName) instead of hard-failing the whole run.
  const hotelNameValue = seg.hotelName || seg.hotelNameFreeForm || seg.supplierName;
  let pickedSupplier = false;
  if (seg.hotelSupplier) {
    try {
      await pickAutocomplete(page, "#supplierName", seg.hotelSupplier);
      await sleep(1500); // supplier ajax auto-fills the address block
      pickedSupplier = true;
    } catch { /* not a listed supplier → free-form below */ }
  }
  if (!pickedSupplier) {
    await fillIf(page, "#hotelName", hotelNameValue);
  }
  // City Code (#checkInLocation) autocomplete — non-fatal (a doc city that
  // doesn't match a Tramada city won't kill the save).
  try { await pickAutocomplete(page, "#checkInLocation", seg.cityCode || seg.city); } catch { /* leave blank */ }
  await selectIf(page, "#roomTypeCode", seg.roomTypeCode);
  await fillIf(page, "#roomType", seg.roomType);           // free-form room type
  await setDateField(page, "#checkInDate", toTramadaDate(seg.checkInDate));
  await setDateField(page, "#checkOutDate", toTramadaDate(seg.checkOutDate));
  await selectIf(page, "#itinerarystatusTypeCode", seg.status || "HK");

  // Creditor (REQUIRED by Tramada). Choose "Different from supplier" then match
  // it. If it's missing or doesn't match a listed creditor, STOP and ask the
  // user — don't skip (Tramada would reject the save) or guess.
  {
    const diff = page.locator("#creditorDifferentRadio");
    if (await diff.count()) await diff.check().catch(() => {});
    if (!seg.creditor) throw makeNeedsCreditor("hotel", seg.supplierName);
    const unmatched = await pickCreditor(page, "#costingcreditor", seg.creditor);
    if (unmatched) throw makeNeedsCreditor("hotel", unmatched);
  }

  // Pricing (this is what makes the hotel receiptable). AUD rate incl GST is the
  // primary field for AUD bookings; localRateInclGst mirrors it for local currency.
  await setMoneyField(page, "#audRateIncGst", seg.rate);
  await setMoneyField(page, "#localRateInclGst", seg.localRate || seg.rate);
  await fillIf(page, "#numberOfRooms", seg.rooms || 1);
  await selectIf(page, "#durationTypeCode", seg.durationType || "Nights");
  // NOTE: #duration is READONLY — Tramada auto-computes nights from the
  // check-in/check-out dates. Do not fill it (fillIf skips readonly anyway).

  await sleep(400);
  await saveSegmentForm(page);
  await assertSaved(page, `Hotel segment ${hotelNameValue || ""}`.trim());
  return { type: "HTL", reference: hotelNameValue || seg.creditor || "Hotel" };
}

/* ── Ticket costing (costs a flight so it becomes receiptable) ──────────── */

async function addTicketCosting(page, bookingNo, ticket) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-air-segment.htm?mode=add&pageSourceParam=costingsPage&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#airlineCode, #costingcreditor", { timeout: 15000 });

  await pickAutocomplete(page, "#costingcreditor", ticket.creditor); // supplier/airline creditor
  await fillIf(page, "#airlineCode", ticket.airline);
  await fillIf(page, "#ticketClass", ticket.class);
  await selectIf(page, "#passengerTypeCode", ticket.passengerType || "Adult");
  await selectIf(page, "#ticketFareCode", ticket.fareType || "Published");
  await fillIf(page, "#itinerarySummary", ticket.itinerary);
  await fillIf(page, "#ticketNumber", ticket.ticketNumber);

  // Amount (incl GST). AUD Amount is the client-facing fare; the Client Due
  // (costingclientAmountDue) computes from it automatically.
  await setMoneyField(page, "#audAmountIncGst", ticket.fare);
  await setMoneyField(page, "#localTicketAmountIncGst", ticket.localFare || ticket.fare);

  await sleep(400);
  await saveSegmentForm(page);
  await assertSaved(page, `Ticket costing ${ticket.airline || ""} ${ticket.class || ""}`.trim());
  return { type: "TKT", reference: `${ticket.airline || ""} ${ticket.class || ""}`.trim() };
}

/* ── PDF-pipeline segments/costings (Tour, Insurance, Service Fee) ───────────
 *
 * Field ids mapped live on booking 12752 (see pdf-field-map.md). Tramada's
 * element id = the field NAME with dots removed (verified: costing.creditor →
 * #costingcreditor, itinerary.statusTypeCode → #itinerarystatusTypeCode). NOTE
 * the Tour form uses audRate**Incl**Gst (with an "l"), unlike the Hotel form's
 * audRateIncGst — the ids below are the exact verified names, not guesses.
 * ────────────────────────────────────────────────────────────────────────── */

// Try to match a creditor autocomplete. Returns null on success, or the
// UNMATCHED value so the caller can report it. The run CONTINUES instead of
// hard-failing on a name that isn't a listed Tramada creditor (doc names like
// "Tour East Bali" / "Novotel Bali Ngurah Rai Airport" usually aren't).
async function pickCreditor(page, selector, value) {
  if (!value) return null;
  try { await pickAutocomplete(page, selector, value); return null; }
  catch { return value; }
}

// Raise a recognizable "I need a creditor from the user" signal. The caller
// (server) catches this, PAUSES the run, asks the user for the creditor, and
// re-runs with their answer — instead of skipping (which then fails Tramada's
// required "Creditor Name must be entered") or guessing.
function makeNeedsCreditor(kind, supplierName) {
  const e = new Error(`Creditor needed for ${kind}${supplierName ? ` "${supplierName}"` : ""}.`);
  e.needsCreditor = { kind, supplierName: supplierName || "" };
  return e;
}

/* ── Tour segment (itinerary) ──────────────────────────────────────────── */

async function addTourSegment(page, bookingNo, seg) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-tour-segment.htm?mode=add&pageSourceParam=itinerariesPage&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#tourCompanyName, #costingcreditor", { timeout: 15000 });

  // Tour company FREE-FORM name (the product, e.g. "Tour East Bali").
  await fillIf(page, "#tourCompanyName", seg.supplierName || seg.tourCompany);

  // Creditor (REQUIRED). Choose "Different from supplier" then match it. If it's
  // missing or unmatched, STOP and ask the user rather than skip/guess.
  {
    const diff = page.locator('[name="creditorSameOrDifferentFromSupplier"][value="DIFFERENT"]');
    if (await diff.count()) await diff.first().check().catch(() => {});
    const creditor = seg.creditor || seg.supplierName;
    if (!creditor) throw makeNeedsCreditor("tour", seg.supplierName);
    const unmatched = await pickCreditor(page, "#costingcreditor", creditor);
    if (unmatched) throw makeNeedsCreditor("tour", unmatched);
  }

  await fillIf(page, "#freeTextDescription", seg.description);
  if (seg.city) {
    // City autocompletes are non-fatal (a doc city that doesn't match won't kill the save).
    try { await pickAutocomplete(page, "#departureCity", seg.city); } catch { /* skip */ }
    try { await pickAutocomplete(page, "#finishCity", seg.city); } catch { /* skip */ }
  }
  await setDateField(page, "#startDate", toTramadaDate(seg.startDate));
  await setDateField(page, "#finishDate", toTramadaDate(seg.finishDate || seg.startDate));
  await setDateField(page, "#itineraryconfirmationOrIssueDate", toTramadaDate(seg.startDate));
  await fillIf(page, "#itineraryconfirmationOrReferenceNumber", seg.reference);
  await fillIf(page, "#costingcreditorInvoiceNumber", seg.reference);
  await selectIf(page, "#itinerarystatusTypeCode", seg.status || "HK");

  // Amount: put the line TOTAL in the rate with passengers=1 / duration=1 so
  // Tramada's computed total equals the doc's tour total exactly (no surprise
  // rate × pax × days multiplication).
  await setMoneyField(page, "#localRateInclGst", seg.amount);
  await setMoneyField(page, "#audRateInclGst", seg.amount);
  await fillIf(page, "#numberOfPassengers", seg.passengers || 1);
  await selectIf(page, "#durationTypeCode", seg.durationType || "Days");
  await fillIf(page, "#duration", seg.duration || 1);

  await sleep(400);
  await saveSegmentForm(page);
  await assertSaved(page, `Tour segment ${seg.supplierName || ""}`.trim());
  return { type: "TUR", reference: seg.reference || seg.supplierName || "Tour" };
}

/* ── Insurance costing line ────────────────────────────────────────────── */

async function addInsuranceCosting(page, bookingNo, ins) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-insurance-segment.htm?mode=add&pageSourceParam=costingsPage&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#costingcreditor", { timeout: 15000 });

  const creditor = ins.creditor || ins.supplierName; // e.g. "Tokio Marine" (IS on the doc)
  if (!creditor) throw makeNeedsCreditor("insurance", ins.supplierName);
  const insUnmatched = await pickCreditor(page, "#costingcreditor", creditor);
  if (insUnmatched) throw makeNeedsCreditor("insurance", insUnmatched);
  await setDateField(page, "#startDate", toTramadaDate(ins.startDate));
  await setDateField(page, "#endDate", toTramadaDate(ins.endDate));
  await selectIf(page, "#statusTypeCode", ins.status || "Confirmed");
  await setDateField(page, "#confirmationOrIssueDate", toTramadaDate(ins.issueDate));
  await fillIf(page, "#confirmationOrReferenceNumber", ins.reference); // policy no (if any)
  await fillIf(page, "#costingcreditorInvoiceNumber", ins.reference);

  // Primary amount (incl GST). Insurance here is GST-free so excl auto-mirrors it.
  await setMoneyField(page, "#policyGrossAmountInclGst", ins.amount);

  await sleep(400);
  await saveSegmentForm(page);
  await assertSaved(page, `Insurance line ${ins.supplierName || ins.creditor || ""}`.trim());
  return { type: "INS", reference: ins.reference || ins.supplierName || "Insurance" };
}

/* ── Service Fee costing line (OPTIONAL) ────────────────────────────────────
 * Under an EFT receipt there is normally no credit-card surcharge, so the PDF
 * pipeline SKIPS this by default. When enabled, the fee-TYPE code (e.g.
 * A_CS_SFE_FEE) is normally chosen via a "Select Fee Type" lookup on the form —
 * that lookup is NOT yet automated here; we set the visible fields and rely on a
 * default/typed fee type. If a run needs a specific fee type, map that lookup
 * live first. Kept best-effort so the main EFT path never depends on it.
 * ────────────────────────────────────────────────────────────────────────── */

async function addServiceFeeCosting(page, bookingNo, fee) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-service-fee-segment.htm?mode=add&pageSourceParam=costingsPage&parentId=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#description, #costingcreditor", { timeout: 15000 });

  await selectIf(page, "#serviceFeeType", fee.serviceFeeType || "Booking Fee");
  if (fee.feeType) await fillIf(page, "#feeType", fee.feeType);
  await fillIf(page, "#description", fee.description || "Service Fee");
  const creditor = fee.creditor || fee.supplierName;
  if (creditor) {
    const feeUnmatched = await pickCreditor(page, "#costingcreditor", creditor);
    if (feeUnmatched) throw makeNeedsCreditor("servicefee", feeUnmatched);
  }
  await fillIf(page, "#quantity", fee.quantity || 1);
  await setMoneyField(page, "#grossFeeAmountInclGst", fee.amount);
  await fillIf(page, "#issueDate", toTramadaDate(fee.issueDate));

  await sleep(400);
  await saveSegmentForm(page);
  await assertSaved(page, `Service fee ${fee.description || ""}`.trim());
  return { type: "SFE", reference: fee.description || "Service Fee" };
}

// Read the costing table so callers can confirm what's receiptable.
async function readCostings(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-costings.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(600);
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    const tables = document.querySelectorAll("table");
    for (const t of tables) {
      const head = t.querySelector("tr");
      if (head && /Due\s*inc\s*GST/i.test(head.textContent)) {
        const rows = t.querySelectorAll("tr");
        const out = [];
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 7 && !/TOTALS/i.test(rows[i].textContent)) {
            out.push({ segType: clean(c[1]), reference: clean(c[2]), dueIncGst: clean(c[7]) });
          }
        }
        return out;
      }
    }
    return [];
  });
}

// Read the itinerary list — used when resuming an existing booking to skip
// segments that are already there.
async function readItinerary(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-itineraries.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(600);
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    for (const t of document.querySelectorAll("table")) {
      const h = t.querySelector("tr");
      if (h && /Seg\.?\s*Type/i.test(h.textContent)) {
        const out = [];
        const rows = t.querySelectorAll("tr");
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 3 && clean(c[1])) out.push({ segType: clean(c[1]), reference: clean(c[2]) });
        }
        return out;
      }
    }
    return [];
  });
}

// Booking header details (for the state card): client, itinerary, dates.
async function readBookingHeader(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-summary.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(500);
  return await page.evaluate(() => {
    const text = document.body.innerText || "";
    const grab = (label) => {
      const m = text.match(new RegExp(label + "\\s*:?\\s*([^\\n]+)", "i"));
      return m ? m[1].trim() : "";
    };
    return {
      bookingNo: grab("Booking No\\.?"),
      client: grab("Client"),
      clientName: grab("Client Name"),
      itinerary: grab("Itinerary"),
      bookDate: grab("Book\\.? Date"),
      depDate: grab("Dep\\.? Date"),
      totalDue: grab("Total Client/Debtor Due"),
      receipted: grab("Client/Debtor Receipted"),
      balance: grab("Client/Debtor Balance"),
    };
  });
}

// Existing receipts on the booking (part-payments visible in the state card).
async function readReceiptsList(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-receipts.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(500);
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    for (const t of document.querySelectorAll("table")) {
      const h = t.querySelector("tr");
      if (h && /Receipt\s*No/i.test(h.textContent)) {
        const out = [];
        const rows = t.querySelectorAll("tr");
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 9 && /^R\./i.test(clean(c[1]))) {
            out.push({
              receiptNo: clean(c[1]),
              transType: clean(c[4]),
              reference: clean(c[6]),
              dateReceived: clean(c[7]),
              amount: clean(c[8]),
              allocated: clean(c[9]),
            });
          }
        }
        return out;
      }
    }
    return [];
  });
}

/**
 * Read the full state of a booking in one pass: header, itinerary segments,
 * costing lines, and receipts. Powers the "what's already here" summary card
 * and the assistant's suggestions (e.g. remaining balance).
 */
async function runReadBookingState({ username, password, bookingNo, callbacks = {} } = {}) {
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, async (page) => {
    const header = await readBookingHeader(page, bookingNo);
    const segments = await readItinerary(page, bookingNo);
    const costings = await readCostings(page, bookingNo);
    const receipts = await readReceiptsList(page, bookingNo);
    return { bookingNo: String(bookingNo), header, segments, costings, receipts };
  });
}

/* ── Passenger (REQUIRED before hotel segments and costings) ───────────── */

/**
 * Add a passenger to the booking. Without at least one passenger, hotel
 * segments and ticket costings fail with "Passenger is required."
 * Default source "This Client" adds the booking's client as the traveller.
 */
async function addPassenger(page, bookingNo, { source = "This Client" } = {}) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-passengers.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector("#passengerSourceSelect", { timeout: 15000 });

  // Idempotent: if the booking already has a passenger (e.g. resuming an
  // existing booking), don't add a duplicate.
  const hasPassenger = await page.evaluate(() => !/No records found/i.test(document.body.innerText));
  if (hasPassenger) return { source, skipped: true };
  await selectIf(page, "#passengerSourceSelect", source); // "This Client" => THIS_CLIENT
  await sleep(300);
  await page.click("#add"); // "Add as Passenger(s)"
  await page.waitForLoadState("domcontentloaded");
  await sleep(800);
  // A passenger-profile confirm form (pre-filled from the client) may appear — save it.
  const save = page.locator("#save");
  if (await save.count()) {
    await save.first().click();
    await page.waitForLoadState("domcontentloaded");
    await sleep(800);
  }
  return { source };
}

async function runAddPassenger({ username, password, bookingNo, source, callbacks = {} }) {
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, (page) =>
    addPassenger(page, bookingNo, { source })
  );
}

/* ── Standalone runners (open their own page over CDP) ─────────────────── */

async function withPage(args, fn) {
  const onProgress = (args.callbacks && args.callbacks.onProgress) || (() => {});
  let browser, page;
  let ok = false;
  try {
    ({ browser } = await openBrowser(onProgress));
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await ensureLoggedIn(page, {
      username: args.username,
      password: args.password,
      onNeedLogin: args.callbacks && args.callbacks.onNeedLogin,
    });
    const result = await fn(page);
    ok = true;
    return result;
  } finally {
    // On SUCCESS close our tab. On FAILURE leave it open — the failed form
    // (with its error messages) stays on screen for inspection. Disconnecting
    // from a CDP browser doesn't close the user's Chrome or its tabs.
    if (ok) {
      try { if (page) await page.close(); } catch {}
    }
    try { if (browser) await browser.close(); } catch {}
  }
}

/**
 * Add a list of segments to a booking.
 * @param {Array} segments  each: { kind: "flight"|"hotel", ...fields }
 */
async function runAddSegments({ username, password, bookingNo, segments = [], callbacks = {} }) {
  const onProgress = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, async (page) => {
    const added = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      onProgress(20 + i * 10, `Adding ${s.kind} segment ${i + 1}/${segments.length}...`);
      if (s.kind === "flight") added.push(await addFlightSegment(page, bookingNo, s));
      else if (s.kind === "hotel") added.push(await addHotelSegment(page, bookingNo, s));
      else if (s.kind === "tour") added.push(await addTourSegment(page, bookingNo, s));
      else throw new Error(`Unknown segment kind: ${s.kind}`);
    }
    onProgress(100, `Added ${added.length} segment(s).`);
    return added;
  });
}

/**
 * Add ticket costings for flights.
 * @param {Array} costings  each ticket: { creditor, airline, class, fare, ... }
 */
async function runAddCostings({ username, password, bookingNo, costings = [], callbacks = {} }) {
  const onProgress = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, async (page) => {
    const done = [];
    for (let i = 0; i < costings.length; i++) {
      onProgress(20 + i * 10, `Costing ticket ${i + 1}/${costings.length}...`);
      done.push(await addTicketCosting(page, bookingNo, costings[i]));
    }
    const costingTable = await readCostings(page, bookingNo);
    onProgress(100, `Costed ${done.length} ticket(s).`);
    return { done, costingTable };
  });
}

/**
 * Add standalone costing LINES (insurance, service fee) — the ones added on the
 * Costing page rather than the itinerary. Each: { kind:"insurance"|"servicefee", ... }.
 */
async function runAddCostingLines({ username, password, bookingNo, lines = [], callbacks = {} }) {
  const onProgress = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo required");
  return await withPage({ username, password, callbacks }, async (page) => {
    const added = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      onProgress(20 + i * 10, `Adding ${l.kind} costing ${i + 1}/${lines.length}...`);
      if (l.kind === "insurance") added.push(await addInsuranceCosting(page, bookingNo, l));
      else if (l.kind === "servicefee") added.push(await addServiceFeeCosting(page, bookingNo, l));
      else throw new Error(`Unknown costing line kind: ${l.kind}`);
    }
    onProgress(100, `Added ${added.length} costing line(s).`);
    return added;
  });
}

/* ── Full pipeline orchestrator ────────────────────────────────────────── */

/**
 * Run the entire chain: create booking → add segments → cost flights → receipt.
 * Each stage reuses the tested single-purpose modules; the booking number from
 * stage 1 threads through the rest.
 *
 * @param {object} args
 * @param {string} args.clientCode                Tramada client (e.g. "GRAY/SPIDER")
 * @param {object} args.booking                   Jetstar-style booking (see tramada-booking.js)
 * @param {Array}  args.segments                  [{kind:"flight"|"hotel", ...}]
 * @param {Array}  [args.costings]                ticket costings for flights [{creditor, airline, class, fare}]
 * @param {object} args.receipt                   see tramada-receipt.js runTramadaReceipt
 * @param {boolean}[args.dryRunReceipt=true]      preview the receipt (no commit) by default
 * @param {object} [args.callbacks]               { onProgress(pct,msg), onError(msg), onStage(name,data) }
 */
async function runFullBooking({
  username,
  password,
  clientCode,
  booking,
  existingBookingNo = null, // resume this booking instead of creating a new one
  segments = [],
  costings = [],
  receipt,
  dryRunReceipt = true,
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});
  const onStage = callbacks.onStage || (() => {});
  const onNeedLogin = callbacks.onNeedLogin; // propagate to every stage's login check

  try {
    // 1) Create the booking header — or RESUME an existing booking.
    let bookingNo;
    let addRes = { add: null };
    if (existingBookingNo) {
      bookingNo = String(existingBookingNo);
      onProgress(5, `Resuming existing booking ${bookingNo} — skipping create.`);
      onStage("booking", { bookingNo, resumed: true });
    } else {
      onProgress(5, "Creating booking...");
      addRes = await runTramadaAddAndSearch({
        username, password, clientCode, booking,
        skipSearch: true, // bookingNo comes from the URL — no need for the 15s search poll
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(5 + Math.round(p * 0.2), m) },
      });
      bookingNo = addRes.add && addRes.add.bookingNo;
      if (!bookingNo) throw new Error("Booking created but no booking number was returned.");
      onStage("booking", { bookingNo, add: addRes.add });
    }

    // 2) Add a passenger — REQUIRED before hotel segments / costings, else they
    //    fail with "Passenger is required." Idempotent: skips if one exists.
    onProgress(26, "Adding passenger...");
    const paxResult = await runAddPassenger({
      username, password, bookingNo,
      source: (booking && booking.passengerSource) || "This Client",
      callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(26 + Math.round(p * 0.03), m) },
    });
    onStage("passenger", paxResult);

    // 3) Add segments (flight + hotel). When resuming, first read what the
    //    booking already has and skip that many of each kind — so a re-run
    //    never duplicates the segments that saved before the failure.
    let segmentsToAdd = segments;
    if (existingBookingNo) {
      const existing = await withPage({ username, password, callbacks: { onNeedLogin } }, (page) =>
        readItinerary(page, bookingNo)
      );
      const have = {
        flight: existing.filter((s) => /FLT/i.test(s.segType)).length,
        hotel: existing.filter((s) => /HTL/i.test(s.segType)).length,
      };
      const seen = { flight: 0, hotel: 0 };
      segmentsToAdd = [];
      for (const s of segments) {
        if (seen[s.kind] < (have[s.kind] || 0)) {
          seen[s.kind]++;
          onProgress(30, `Skipping existing ${s.kind} segment (already on booking).`);
        } else {
          segmentsToAdd.push(s);
        }
      }
    }
    onProgress(30, "Adding itinerary segments...");
    const segResult = segmentsToAdd.length
      ? await runAddSegments({
          username, password, bookingNo, segments: segmentsToAdd,
          callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(30 + Math.round(p * 0.2), m) },
        })
      : [];
    onStage("segments", segResult);

    // 4) Cost the flights (hotels self-cost on their form). When resuming,
    //    skip as many ticket costings as already exist.
    let costResult = { done: [], costingTable: [] };
    let costingsToAdd = costings;
    if (existingBookingNo && costings.length) {
      const table = await withPage({ username, password, callbacks: { onNeedLogin } }, (page) =>
        readCostings(page, bookingNo)
      );
      const haveTkts = table.filter((r) => /TKT/i.test(r.segType)).length;
      if (haveTkts > 0) {
        onProgress(55, `Skipping ${haveTkts} existing ticket costing(s).`);
        costingsToAdd = costings.slice(haveTkts);
      }
    }
    if (costingsToAdd.length) {
      onProgress(55, "Costing flights...");
      costResult = await runAddCostings({
        username, password, bookingNo, costings: costingsToAdd,
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(55 + Math.round(p * 0.15), m) },
      });
      onStage("costing", costResult);
    }

    // 5) Receipt — OPTIONAL: only when receipt details were provided. This lets
    //    the assistant run segments/costing-only jobs on existing bookings.
    let receiptResult = null;
    if (receipt && receipt.reference) {
      onProgress(75, dryRunReceipt ? "Building receipt preview..." : "Issuing receipt...");
      receiptResult = await runTramadaReceipt({
        username, password, bookingNo, receipt, dryRun: dryRunReceipt,
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(75 + Math.round(p * 0.24), m) },
      });
      onStage("receipt", receiptResult);
    } else {
      onProgress(95, "No receipt requested — skipping receipt stage.");
    }

    onProgress(100, dryRunReceipt && receiptResult ? "Pipeline ready (receipt not committed)." : "Pipeline complete.");
    return { bookingNo, booking: addRes.add, segments: segResult, costing: costResult, receipt: receiptResult };
  } catch (err) {
    onError(err.message);
    throw err;
  }
}

/**
 * PDF-driven pipeline: given the structured data parsed from an RAA itinerary/
 * costing PDF, add its Tour + Hotel segments and Insurance (and optionally
 * Service Fee) costing lines to the EXISTING booking (resolved from the BPAY
 * Ref), then stage/issue an EFT receipt for the full amount.
 *
 * Safe by design:
 *  - Verifies the booking exists and the client matches the PDF; STOPS on
 *    mismatch without changing anything.
 *  - Idempotent: skips any Tour/Hotel/Insurance/Service-Fee that is already on
 *    the booking, and skips the receipt if the booking is already fully paid.
 *  - dryRunReceipt defaults TRUE — the receipt is staged (screenshot) but not
 *    committed, so the caller can confirm before issuing (req: confirm first).
 *
 * @param {object} args
 * @param {object} args.data                parsed PDF (see pdf-itinerary.js)
 * @param {boolean}[args.includeServiceFee=false]  create the Service-Fee line too
 * @param {boolean}[args.dryRunReceipt=true]       stage (don't commit) the receipt
 * @param {object} [args.callbacks]         { onProgress, onError, onStage, onNeedLogin }
 */
async function runPdfBooking({
  username,
  password,
  data,
  includeServiceFee = false,
  dryRunReceipt = true,
  forceClient = false, // apply to this booking even if its client differs from
                       // the PDF (uses THIS booking's client — explicit request)
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});
  const onStage = callbacks.onStage || (() => {});
  const onNeedLogin = callbacks.onNeedLogin;

  const bookingNo = data && data.bookingNo;
  if (!bookingNo) throw new Error("No booking number in the parsed PDF (BPAY Ref missing?).");

  try {
    // 1) Verify the booking exists AND the client matches the PDF.
    onProgress(5, `Opening booking ${bookingNo}...`);
    const state = await withPage({ username, password, callbacks: { onNeedLogin } }, async (page) => {
      const header = await readBookingHeader(page, bookingNo);
      const segments = await readItinerary(page, bookingNo);
      const costings = await readCostings(page, bookingNo);
      const receipts = await readReceiptsList(page, bookingNo);
      return { header, segments, costings, receipts };
    });
    const { header, segments: existingSegs, costings: existingCosts, receipts } = state;

    if (!header || !header.bookingNo) {
      throw new Error(`Booking ${bookingNo} could not be opened in Tramada — check the BPAY Ref.`);
    }
    // Match on the full SURNAME/FIRSTNAME key, not just surname — several GRAY
    // family members exist, so surname-only would wrongly pass GRAY/SPIDER for a
    // GRAY/MEGAN PDF. Strip titles (MR/MS/DR…) and non-name chars first.
    const nameKey = (s) => String(s || "").toUpperCase()
      .replace(/\b(MR|MRS|MS|DR|MISS|MSTR|MASTER|PROF)\b/g, "")
      .replace(/[^A-Z/]/g, "").trim();
    const paxKeys = (data.passengers || []).map(nameKey).filter(Boolean);
    const hdrKey = nameKey(header.client);
    let clientOk;
    if (hdrKey.includes("/")) {
      clientOk = !paxKeys.length || paxKeys.some((k) => k === hdrKey || k.includes(hdrKey) || hdrKey.includes(k));
    } else {
      // No slash-format client on the header — fall back to surname match.
      const surnames = paxKeys.map((k) => k.split("/")[0]).filter(Boolean);
      const hay = `${header.client || ""} ${header.clientName || ""}`.toUpperCase().replace(/[^A-Z]/g, "");
      clientOk = !surnames.length || surnames.some((s) => hay.includes(s));
    }
    const clientMismatch = !clientOk;
    onStage("verify", { bookingNo, header, clientOk, forceClient, paxKeys, hdrKey });
    if (clientMismatch && !forceClient) {
      throw new Error(
        `Client mismatch — booking ${bookingNo} is "${(header.client || header.clientName || "").trim()}" ` +
          `but the PDF is for ${(data.passengers || []).join(", ")}. Stopping; nothing changed. ` +
          `(This PDF belongs to booking ${data.bookingNo}.)`
      );
    }
    if (clientMismatch && forceClient) {
      // Explicit request to reuse the PDF on a different booking. Segments attach
      // to THIS booking's passengers and the receipt payer is THIS booking's
      // client automatically — we just proceed past the guard.
      onProgress(8, `Booking ${bookingNo} is a different client ("${(header.client || "").trim()}") — applying with THIS booking's client, as requested.`);
    }

    // 2) Segments — add Tour/Hotel not already present (idempotent).
    const haveTUR = existingSegs.some((s) => /TUR/i.test(s.segType));
    const haveHTL = existingSegs.some((s) => /HTL/i.test(s.segType));
    const segsToAdd = (data.segments || []).filter(
      (s) => (s.kind === "tour" && !haveTUR) || (s.kind === "hotel" && !haveHTL)
    );
    let segResult = [];
    if (segsToAdd.length) {
      onProgress(30, `Adding ${segsToAdd.length} itinerary segment(s)...`);
      segResult = await runAddSegments({
        username, password, bookingNo, segments: segsToAdd,
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(30 + Math.round(p * 0.25), m) },
      });
    } else {
      onProgress(30, "Tour/Hotel segments already present — skipping.");
    }
    onStage("segments", { added: segResult, skipped: { tour: haveTUR, hotel: haveHTL } });

    // 3) Costing lines — Insurance always; Service Fee only if asked (EFT
    //    normally has no card surcharge).
    const haveINS = existingCosts.some((c) => /INS/i.test(c.segType));
    const haveSFE = existingCosts.some((c) => /SFE/i.test(c.segType));
    const linesToAdd = (data.costingLines || []).filter((l) => {
      if (l.kind === "insurance") return !haveINS;
      if (l.kind === "servicefee") return includeServiceFee && !haveSFE;
      return false;
    });
    let costResult = [];
    if (linesToAdd.length) {
      onProgress(58, `Adding ${linesToAdd.length} costing line(s)...`);
      costResult = await runAddCostingLines({
        username, password, bookingNo, lines: linesToAdd,
        callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(58 + Math.round(p * 0.17), m) },
      });
    } else {
      onProgress(58, "Costing lines already present — skipping.");
    }
    onStage("costingLines", { added: costResult, skipped: { insurance: haveINS, servicefee: haveSFE } });

    // 4) EFT receipt — but ONLY if the booking has an outstanding balance. A
    //    fully-paid booking (12752 etc.) has NOTHING to allocate on the receipt
    //    form, so attempting one throws "No costed segments to allocate". This
    //    must be skipped for BOTH the dry-run stage and a real commit.
    const balance = parseFloat(String(header.balance || "").replace(/[^0-9.\-]/g, "") || "0");
    const alreadyReceipted = balance <= 0.005 && (receipts || []).length > 0;
    const addedAnything = (segResult.length + costResult.length) > 0;
    // If we didn't add anything new, the balance we read up front is current;
    // nothing outstanding → no receipt to raise.
    const skipReceipt = !addedAnything && balance <= 0.005;

    let receiptResult = null;
    let receiptSkipped = false;
    let receiptSkipReason = null;
    if (skipReceipt) {
      receiptSkipped = true;
      receiptSkipReason = alreadyReceipted ? "already receipted" : "nothing outstanding";
      onProgress(100, `Booking ${bookingNo} has no outstanding balance (${balance.toFixed(2)}) — no EFT receipt to raise.`);
      onStage("receipt", { skipped: true, reason: receiptSkipReason, receipts });
    } else if (data.receipt) {
      onProgress(78, dryRunReceipt ? "Staging EFT receipt (not committed)..." : "Issuing EFT receipt...");
      try {
        receiptResult = await runTramadaReceipt({
          username, password, bookingNo,
          receipt: { ...data.receipt, transactionType: "EFT" },
          dryRun: dryRunReceipt,
          skipIfNoAllocatable: true, // fully-paid booking → clean skip, not a throw
          callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(78 + Math.round(p * 0.2), m) },
        });
        if (receiptResult && receiptResult.skipped) {
          receiptSkipped = true;
          receiptSkipReason = receiptResult.reason || "nothing to allocate";
          receiptResult = null;
          onStage("receipt", { skipped: true, reason: receiptSkipReason });
        } else {
          onStage("receipt", receiptResult);
        }
      } catch (e) {
        // Safety net: an empty allocation table means nothing is outstanding —
        // treat as a clean skip rather than a hard failure.
        if (/no costed segments to allocate|nothing to allocate/i.test(e.message || "")) {
          receiptSkipped = true;
          receiptSkipReason = "nothing outstanding to allocate";
          onProgress(100, `Nothing outstanding to allocate on booking ${bookingNo} — skipping EFT receipt.`);
          onStage("receipt", { skipped: true, reason: receiptSkipReason });
        } else {
          throw e;
        }
      }
    }

    const nothingToDo = !addedAnything && receiptSkipped;
    onProgress(100, dryRunReceipt ? "Ready — EFT receipt staged (confirm to issue)." : "PDF booking complete.");
    return {
      bookingNo, header,
      segments: segResult, costingLines: costResult, receipt: receiptResult,
      alreadyReceipted, receiptSkipped, receiptSkipReason, nothingToDo, balance,
      clientMismatch,
    };
  } catch (err) {
    onError(err.message);
    throw err;
  }
}

module.exports = {
  runFullBooking,
  runPdfBooking,
  runReadBookingState,
  runAddPassenger,
  runAddSegments,
  runAddCostings,
  runAddCostingLines,
  // page-level (for composing on a shared page / testing)
  addPassenger,
  addFlightSegment,
  addHotelSegment,
  addTourSegment,
  addTicketCosting,
  addInsuranceCosting,
  addServiceFeeCosting,
  readCostings,
  readItinerary,
  readBookingHeader,
  readReceiptsList,
  toTramadaDate,
  toFlightNumber,
  toClassCode,
};
