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
    onProgress(5, `No CDP Chrome on :${CDP_PORT} — launching Chrome directly...`);
    return await launchChrome();
  }
}

async function ensureLoggedIn(page, { username, password } = {}) {
  await page.goto(`${TRAMADA_BASE_URL}/login.htm`, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("login.htm")) return;
  if (!username || !password) {
    throw new Error(
      "Tramada session is not logged in and no credentials were provided. " +
        "Sign in to Tramada in the shared Chrome first (this also clears OTP)."
    );
  }
  await page.waitForSelector("#username", { state: "visible", timeout: 15000 });
  await page.fill("#username", username);
  await page.fill("#loginForm_password", password);
  await page.click("#loginForm_login");
  try {
    await page.waitForURL((u) => !u.toString().includes("login.htm"), { timeout: 30000 });
  } catch {
    if (page.url().includes("login.htm")) throw new Error("Tramada login failed.");
  }
  await page.waitForLoadState("domcontentloaded");
  await sleep(500);
}

/* ── small helpers ─────────────────────────────────────────────────────── */

// Fill a field only if a value was supplied and the field exists.
async function fillIf(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (await el.count()) await el.first().fill(String(value));
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

// Type into an autocomplete text field and try to accept the first suggestion.
// Creditor fields (#costingcreditor) use this pattern in some tenants.
async function pickAutocomplete(page, selector, value) {
  if (!value) return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  await el.first().click();
  await el.first().fill("");
  await el.first().type(String(value), { delay: 60 });
  await sleep(1500);
  const item = page
    .locator(".autocomplete-suggestions div, ul.ui-autocomplete li, div[class*='autocomplete'] div")
    .filter({ hasText: String(value) });
  if (await item.count()) {
    await item.first().click();
  } else {
    await page.keyboard.press("ArrowDown").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
  }
  await sleep(400);
}

// Read any validation errors after a save.
async function readSaveErrors(page) {
  return await page.evaluate(() => {
    const box = document.querySelector(
      'div[style*="border"][style*="red"], .errorMessages, fieldset[class*="error"]'
    );
    if (box) {
      return box.textContent.trim().split("\n").map((s) => s.trim()).filter(Boolean);
    }
    return [];
  });
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
  await fillIf(page, "#departureDate", toTramadaDate(seg.departureDate)); // required
  await fillIf(page, "#departureTime", seg.departureTime);
  await fillIf(page, "#arrivalDate", toTramadaDate(seg.arrivalDate));     // required
  await fillIf(page, "#arrivalTime", seg.arrivalTime);
  await fillIf(page, "#fareBasis", seg.fareBasis);
  await selectIf(page, "#itinerarystatusTypeCode", seg.status || "HK");   // Confirmed [HK]
  await selectIf(page, "#baggageAllowanceTypeCode", seg.baggage);

  await sleep(300);
  await page.click("#save");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1000);

  const errors = await readSaveErrors(page);
  if (errors.length) throw new Error(`Flight segment errors: ${errors.join("; ")}`);
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
  }
  await fillIf(page, "#hotelName", seg.hotelName || seg.hotelNameFreeForm); // free-form name
  // City Code (#checkInLocation) is an autocomplete too.
  await pickAutocomplete(page, "#checkInLocation", seg.cityCode);    // e.g. SYD
  await selectIf(page, "#roomTypeCode", seg.roomTypeCode);
  await fillIf(page, "#roomType", seg.roomType);           // free-form room type
  await fillIf(page, "#checkInDate", toTramadaDate(seg.checkInDate));
  await fillIf(page, "#checkOutDate", toTramadaDate(seg.checkOutDate));
  await selectIf(page, "#itinerarystatusTypeCode", seg.status || "HK");

  // Creditor (supplier being paid). Choose "Different from supplier" then set it.
  if (seg.creditor) {
    const diff = page.locator("#creditorDifferentRadio");
    if (await diff.count()) await diff.check().catch(() => {});
    await pickAutocomplete(page, "#costingcreditor", seg.creditor);
  }

  // Pricing (this is what makes the hotel receiptable). AUD rate incl GST is the
  // primary field for AUD bookings; localRateInclGst mirrors it for local currency.
  await fillIf(page, "#audRateIncGst", seg.rate);
  await fillIf(page, "#localRateInclGst", seg.localRate || seg.rate);
  await fillIf(page, "#numberOfRooms", seg.rooms || 1);
  await selectIf(page, "#durationTypeCode", seg.durationType || "Nights");
  await fillIf(page, "#duration", seg.nights);

  await sleep(400);
  await page.click("#save");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  const errors = await readSaveErrors(page);
  if (errors.length) throw new Error(`Hotel segment errors: ${errors.join("; ")}`);
  return { type: "HTL", reference: seg.hotelName || seg.creditor || "Hotel" };
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
  await fillIf(page, "#audAmountIncGst", ticket.fare);
  await fillIf(page, "#localTicketAmountIncGst", ticket.localFare || ticket.fare);

  await sleep(400);
  await page.click("#save");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  const errors = await readSaveErrors(page);
  if (errors.length) throw new Error(`Ticket costing errors: ${errors.join("; ")}`);
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
  try {
    ({ browser } = await openBrowser(onProgress));
    const ctx = browser.contexts()[0] || (await browser.newContext());
    page = await ctx.newPage();
    await ensureLoggedIn(page, { username: args.username, password: args.password });
    return await fn(page);
  } finally {
    try { if (page) await page.close(); } catch {}
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
  segments = [],
  costings = [],
  receipt,
  dryRunReceipt = true,
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});
  const onStage = callbacks.onStage || (() => {});

  try {
    // 1) Create the booking header.
    onProgress(5, "Creating booking...");
    const addRes = await runTramadaAddAndSearch({
      username, password, clientCode, booking,
      callbacks: { onProgress: (p, m) => onProgress(5 + Math.round(p * 0.2), m) },
    });
    const bookingNo = addRes.add && addRes.add.bookingNo;
    if (!bookingNo) throw new Error("Booking created but no booking number was returned.");
    onStage("booking", { bookingNo, add: addRes.add });

    // 2) Add a passenger — REQUIRED before hotel segments / costings, else they
    //    fail with "Passenger is required." Defaults to the booking's client.
    onProgress(26, "Adding passenger...");
    const paxResult = await runAddPassenger({
      username, password, bookingNo,
      source: (booking && booking.passengerSource) || "This Client",
      callbacks: { onProgress: (p, m) => onProgress(26 + Math.round(p * 0.03), m) },
    });
    onStage("passenger", paxResult);

    // 3) Add segments (flight + hotel).
    onProgress(30, "Adding itinerary segments...");
    const segResult = await runAddSegments({
      username, password, bookingNo, segments,
      callbacks: { onProgress: (p, m) => onProgress(30 + Math.round(p * 0.2), m) },
    });
    onStage("segments", segResult);

    // 3) Cost the flights (hotels self-cost on their form).
    let costResult = { done: [], costingTable: [] };
    if (costings.length) {
      onProgress(55, "Costing flights...");
      costResult = await runAddCostings({
        username, password, bookingNo, costings,
        callbacks: { onProgress: (p, m) => onProgress(55 + Math.round(p * 0.15), m) },
      });
      onStage("costing", costResult);
    }

    // 4) Receipt (preview by default; caller confirms, then re-run with dryRunReceipt=false).
    onProgress(75, dryRunReceipt ? "Building receipt preview..." : "Issuing receipt...");
    const receiptResult = await runTramadaReceipt({
      username, password, bookingNo, receipt, dryRun: dryRunReceipt,
      callbacks: { onProgress: (p, m) => onProgress(75 + Math.round(p * 0.24), m) },
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
  toTramadaDate,
  toFlightNumber,
  toClassCode,
};
