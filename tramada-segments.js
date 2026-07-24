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

async function selectIf(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  // Try by value, then by label.
  try {
    await el.first().selectOption(value);
  } catch {
    try { await el.first().selectOption({ label: String(value) }); } catch { /* leave default */ }
  }
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
 * Click Save and WAIT for a definitive outcome: either the page navigates away
 * from the *-segment form (success) or an error box appears (real rejection).
 * A fixed post-click sleep raced the server — on a slow save the check fired
 * while the submit was still in flight, producing a false "did not save" with
 * a perfectly-filled, error-free form left on screen. Polls up to ~15s and
 * re-clicks Save once midway in case the first click was swallowed.
 */
async function saveSegmentForm(page) {
  const clickSave = async () => {
    try { await page.click("#save", { timeout: 5000 }); } catch { /* button busy */ }
  };
  await clickSave();
  for (let i = 0; i < 25; i++) {
    await sleep(600);
    if (!/-segment\.htm/i.test(page.url())) return; // navigated → saved
    const errs = await readSaveErrors(page);
    if (errs.length) return; // rejected with visible errors → assertSaved reports them
    if (i === 8) await clickSave(); // ~5s in and nothing happened — click once more
  }
}

// After a segment save, confirm it actually persisted. Tramada redirects to the
// itinerary/costing list on success; if we're still on the *-segment form, the
// save was rejected (usually validation) — surface it loudly instead of the
// misleading downstream "no itinerary segment". Saves a screenshot of the
// failed form to last-error.png so the state is inspectable afterwards.
async function assertSaved(page, kind) {
  const stillOnForm = /-segment\.htm/i.test(page.url());
  const errors = await readSaveErrors(page);
  if (stillOnForm || errors.length) {
    let shot = "";
    try {
      await page.screenshot({ path: "last-error.png", fullPage: true });
      shot = " [screenshot: last-error.png]";
    } catch { /* screenshot is best-effort */ }
    throw new Error(
      `${kind} did not save${errors.length ? ": " + errors.join("; ") : " (form rejected, no error text found)"}${shot}`
    );
  }
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

  // Hotel Name (#supplierName) is a VALIDATED AUTOCOMPLETE of known suppliers
  // (type "Holi" → [RTSYD51108] HOLIDAY INN ...). Pick from it when a listed
  // supplier is given; otherwise use the free-form field (#hotelName) so a
  // non-listed hotel still records a name.
  if (seg.hotelSupplier) {
    await pickAutocomplete(page, "#supplierName", seg.hotelSupplier);
    // Picking a supplier fires an ajax that auto-fills the address block —
    // let it finish re-rendering before touching the fields below it.
    await sleep(1500);
  }
  await fillIf(page, "#hotelName", seg.hotelName || seg.hotelNameFreeForm); // free-form name
  // City Code (#checkInLocation) is an autocomplete too.
  await pickAutocomplete(page, "#checkInLocation", seg.cityCode);    // e.g. SYD
  await selectIf(page, "#roomTypeCode", seg.roomTypeCode);
  await fillIf(page, "#roomType", seg.roomType);           // free-form room type
  await setDateField(page, "#checkInDate", toTramadaDate(seg.checkInDate));
  await setDateField(page, "#checkOutDate", toTramadaDate(seg.checkOutDate));
  await selectIf(page, "#itinerarystatusTypeCode", seg.status || "HK");

  // Creditor (supplier being paid). Choose "Different from supplier" then set it.
  if (seg.creditor) {
    const diff = page.locator("#creditorDifferentRadio");
    if (await diff.count()) await diff.check().catch(() => {});
    await pickAutocomplete(page, "#costingcreditor", seg.creditor);
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
  await assertSaved(page, `Hotel segment ${seg.hotelSupplier || seg.hotelName || ""}`);
  return { type: "HTL", reference: seg.hotelName || seg.hotelSupplier || seg.creditor || "Hotel" };
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

    // 4) Receipt (preview by default; caller confirms, then re-run with dryRunReceipt=false).
    onProgress(75, dryRunReceipt ? "Building receipt preview..." : "Issuing receipt...");
    const receiptResult = await runTramadaReceipt({
      username, password, bookingNo, receipt, dryRun: dryRunReceipt,
      callbacks: { onNeedLogin, onProgress: (p, m) => onProgress(75 + Math.round(p * 0.24), m) },
    });
    onStage("receipt", receiptResult);

    onProgress(100, dryRunReceipt ? "Pipeline ready (receipt not committed)." : "Pipeline complete.");
    return { bookingNo, booking: addRes.add, segments: segResult, costing: costResult, receipt: receiptResult };
  } catch (err) {
    onError(err.message);
    throw err;
  }
}

module.exports = {
  runFullBooking,
  runAddPassenger,
  runAddSegments,
  runAddCostings,
  // page-level (for composing on a shared page / testing)
  addPassenger,
  addFlightSegment,
  addHotelSegment,
  addTicketCosting,
  readCostings,
  readItinerary,
  toTramadaDate,
  toFlightNumber,
  toClassCode,
};
