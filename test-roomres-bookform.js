/**
 * test-roomres-bookform.js — the /book form reader, against a real DOM.
 *
 * This exists because of a live failure on 28-Jul-2026: the run stalled for 30s
 * on the Room-Res booking page and then died with
 *
 *   waiting for locator('input[name="total"], input[name="roomRateCode"]')
 *   to be visible — 64 × locator resolved to 2 elements
 *
 * The elements were there all along. They are HIDDEN inputs (field map §6b) and
 * waitForSelector defaults to state:"visible", which a hidden input can never
 * satisfy, so the step timed out before fillGuests ever ran — which is why the
 * guest boxes on the screenshot were empty and Proceed was never clicked.
 *
 * The unit suite (test-roomres.js) can't catch that class of bug: it's pure and
 * browser-free by design, and this one lives entirely in the DOM. So this file
 * launches headless Chromium against synthetic copies of the two form shapes we
 * mapped live, plus a label-only shape, and drives the REAL readBookFormShape /
 * fillGuests over them. No network, no login, no Room-Res account touched.
 *
 *   node test-roomres-bookform.js        (or: npm run test:bookform)
 */

const { chromium } = require("playwright");
const rr = require("./room-res-quote");

let passed = 0;
let failed = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
}

function ok(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
}

async function throws(label, fn, pattern) {
  try {
    await fn();
    failed++;
    console.log(`  ✗ ${label}\n      expected a throw, got none`);
  } catch (e) {
    if (pattern.test(e.message)) { passed++; console.log(`  ✓ ${label}`); }
    else { failed++; console.log(`  ✗ ${label}\n      wrong error: ${e.message}`); }
  }
}

/* ── fixtures ──────────────────────────────────────────────────────────────
 * Transcribed from roomres-field-map.md §6b, which was mapped against the live
 * site. The hidden-ness matters more than anything else here — that IS the bug.
 */

// Provider 14: Title + First + Last + Country per guest, one phone per room.
const PROVIDER_14 = `
<form>
  <input type="hidden" name="bookingId" value="">
  <input type="hidden" name="hotelId" value="140205">
  <input type="hidden" name="dateFrom" value="01-Aug-2026">
  <input type="hidden" name="dateTo" value="03-Aug-2026">
  <input type="hidden" name="provider" value="14">
  <input type="hidden" name="total" value="682.65">
  <input type="hidden" name="cancellationDeadline" value="2026-07-28">
  <input type="hidden" name="pointsToUse" value="0">
  <input type="hidden" name="roomId" value="0">
  <input type="hidden" name="roomRateCode" value="OPAQUE-RATE-CODE-1">
  <input type="hidden" name="room-0-adults" value="2">
  <input type="hidden" name="room-0-children" value="0">
  <select name="room-0-guest-0-title"><option value="">Title</option><option value="Mr">Mr</option><option value="Ms">Ms</option></select>
  <input type="hidden" name="room-0-guest-0-type" value="AD">
  <input type="text" name="room-0-guest-0-firstname">
  <input type="text" name="room-0-guest-0-lastname">
  <select name="room-0-guest-0-country"><option value="AU">Australia</option><option value="NZ">New Zealand</option></select>
  <input type="tel" name="room-0-phone">
  <select name="room-0-guest-1-title"><option value="">Title</option><option value="Mr">Mr</option></select>
  <input type="hidden" name="room-0-guest-1-type" value="AD">
  <input type="text" name="room-0-guest-1-firstname">
  <input type="text" name="room-0-guest-1-lastname">
  <input type="checkbox" name="isTemplate">
  <input type="checkbox" name="accept" checked>
  <button type="button">Proceed</button>
</form>`;

// Provider 3: First/Last only — no title, no country, no phone.
const PROVIDER_3 = `
<form>
  <input type="hidden" name="hotelId" value="4506591">
  <input type="hidden" name="provider" value="3">
  <input type="hidden" name="total" value="1778.38">
  <input type="hidden" name="roomRateCode" value="OPAQUE-RATE-CODE-3">
  <input type="hidden" name="room-0-adults" value="1">
  <input type="text" name="room-0-guest-0-firstname">
  <input type="text" name="room-0-guest-0-lastname">
  <input type="checkbox" name="accept" checked>
  <button type="button">Proceed</button>
</form>`;

// A provider that spells the field half differently. Same convention, different
// casing/hyphenation — normalisation should flatten all of it to one key set.
const CAMEL_CASE = `
<form>
  <input type="hidden" name="total" value="410.00">
  <input type="hidden" name="provider" value="21">
  <input type="text" name="room-0-guest-0-firstName">
  <input type="text" name="room-0-guest-0-last-name">
  <input type="tel" name="room-0-mobile">
  <button type="button">Proceed</button>
</form>`;

// No room-*-guest-* naming at all — only what a human reads off the page. This
// mirrors the lead-guest block in the 28-Jul screenshot.
const LABELS_ONLY = `
<form>
  <input type="hidden" name="totalPrice" value="1778.38">
  <label for="gt">Title</label>
  <select id="gt"><option value="">Title</option><option value="Mr">Mr</option></select>
  <label for="gfn">Guest First Name</label>
  <input type="text" id="gfn">
  <label for="gln">Guest Last Name</label>
  <input type="text" id="gln">
  <label for="gph">Guest Contact Mobile Number</label>
  <input type="text" id="gph">
  <button type="button">Proceed</button>
</form>`;

// Nothing usable — the reader must say so rather than proceed with blanks.
const NO_GUEST_FIELDS = `
<form>
  <input type="hidden" name="total" value="99.00">
  <input type="text" name="promoCode">
  <button type="button">Proceed</button>
</form>`;

const valuesOf = (page, sels) =>
  page.evaluate((ss) => ss.map((s) => { const el = document.querySelector(s); return el ? el.value : null; }), sels);

// Any Chromium will do — this test only renders its own HTML strings. Prefer
// Playwright's own build, fall back to an installed Chrome so the test doesn't
// force a browser download on a machine that already has one.
async function launchAnyChromium() {
  const explicit = process.env.PW_CHROMIUM_PATH;
  if (explicit) return await chromium.launch({ headless: true, executablePath: explicit });
  try {
    return await chromium.launch({ headless: true });
  } catch (e) {
    return await chromium.launch({ headless: true, channel: "chrome" });
  }
}

(async () => {
  const browser = await launchAnyChromium();
  const page = await browser.newPage();
  const load = async (html) => { await page.setContent(`<html><body>${html}</body></html>`); };

  console.log("\n=== the failing wait (the actual 28-Jul bug) ===\n");
  await load(PROVIDER_14);

  // Reproduce the old behaviour first, so the test proves the diagnosis and not
  // just the fix. The default state is "visible"; hidden inputs never get there.
  let timedOut = false;
  try {
    await page.waitForSelector('input[name="total"], input[name="roomRateCode"]', { timeout: 1200 });
  } catch (e) {
    timedOut = /Timeout/i.test(e.message);
  }
  ok('the default (visible) wait still times out on these hidden inputs', timedOut,
    "if this stops failing, Room-Res made the fields visible and the comment in room-res-quote.js is stale");

  let attachedOk = true;
  try {
    await page.waitForSelector('input[name="total"], input[name="roomRateCode"]', { state: "attached", timeout: 3000 });
  } catch (e) {
    attachedOk = false;
  }
  ok('state:"attached" resolves them immediately — this is the fix', attachedOk);

  console.log("\n=== provider 14: title + first + last + country + phone ===\n");
  let shape = await rr.readBookFormShape(page);
  check("reads the hidden net total", shape.total, "682.65");
  check("reads the provider", shape.provider, "14");
  check("reads the hotel id", shape.hotelId, "140205");
  check("reads the opaque rate code", shape.roomRateCode, "OPAQUE-RATE-CODE-1");
  check("reads the cancellation deadline", shape.cancellationDeadline, "2026-07-28");
  check("found both guest slots", shape.guests.length, 2);
  // "type" is the hidden AD/CH adult-or-child marker (§6b). It's enumerated
  // because it genuinely is a guest field; fillGuests simply never writes to it.
  check("guest 1 has title, first, last, country", Object.keys(shape.guests[0].fields).sort(), ["country", "firstname", "lastname", "title", "type"]);
  check("guest 2 has no country box", Object.keys(shape.guests[1].fields).sort(), ["firstname", "lastname", "title", "type"]);
  check("found the room phone", shape.phones, ['[name="room-0-phone"]']);
  check("used the name convention, not the label fallback", shape.shapeSource, "room-guest-names");
  check("saw the pre-ticked accept box", shape.hasAccept, true);

  let filled = await rr.fillGuests(page, shape, [
    { firstName: "Megan", lastName: "Gray", title: "Ms" },
    { firstName: "Sam", lastName: "Gray" },
  ], { phone: "0400111222" });
  check("reports both guests filled", filled.map((f) => f.name), ["Megan Gray", "Sam Gray"]);
  check("the name boxes actually hold the names", await valuesOf(page, [
    '[name="room-0-guest-0-firstname"]', '[name="room-0-guest-0-lastname"]',
    '[name="room-0-guest-1-firstname"]', '[name="room-0-guest-1-lastname"]',
  ]), ["Megan", "Gray", "Sam", "Gray"]);
  check("the title select took", await valuesOf(page, ['[name="room-0-guest-0-title"]']), ["Ms"]);
  check("country defaulted to AU", await valuesOf(page, ['[name="room-0-guest-0-country"]']), ["AU"]);
  check("the phone went in", await valuesOf(page, ['[name="room-0-phone"]']), ["0400111222"]);

  console.log("\n=== provider 3: first/last only ===\n");
  await load(PROVIDER_3);
  shape = await rr.readBookFormShape(page);
  check("reads its net total", shape.total, "1778.38");
  check("one guest slot", shape.guests.length, 1);
  check("only the fields it has", Object.keys(shape.guests[0].fields).sort(), ["firstname", "lastname"]);
  check("no phone box to fill", shape.phones, []);
  filled = await rr.fillGuests(page, shape, [{ firstName: "Megan", lastName: "Gray", title: "Ms" }], { phone: "0400111222" });
  check("fills what exists and ignores the rest", await valuesOf(page, [
    '[name="room-0-guest-0-firstname"]', '[name="room-0-guest-0-lastname"]',
  ]), ["Megan", "Gray"]);

  console.log("\n=== a rate that wants more guests than we have ===\n");
  await load(PROVIDER_14);
  shape = await rr.readBookFormShape(page);
  await throws("refuses to guess the second guest's name",
    () => rr.fillGuests(page, shape, [{ firstName: "Megan", lastName: "Gray" }]),
    /needs 2 guest name\(s\) but only 1/);
  await load(PROVIDER_14);
  shape = await rr.readBookFormShape(page);
  filled = await rr.fillGuests(page, shape, [{ firstName: "Megan", lastName: "Gray" }], { padGuests: true });
  check("pads only when explicitly told to", filled.map((f) => f.name), ["Megan Gray", "Guest2 Gray"]);

  console.log("\n=== firstName / last-name spelling ===\n");
  await load(CAMEL_CASE);
  shape = await rr.readBookFormShape(page);
  check("normalises both spellings to one key set", Object.keys(shape.guests[0].fields).sort(), ["firstname", "lastname"]);
  check("recognises room-0-mobile as the phone", shape.phones, ['[name="room-0-mobile"]']);
  await rr.fillGuests(page, shape, [{ firstName: "Megan", lastName: "Gray" }], { phone: "0400111222" });
  check("fills them", await valuesOf(page, ['[name="room-0-guest-0-firstName"]', '[name="room-0-guest-0-last-name"]']), ["Megan", "Gray"]);

  console.log("\n=== label-only form (the shape in the 28-Jul screenshot) ===\n");
  await load(LABELS_ONLY);
  shape = await rr.readBookFormShape(page);
  check("falls back to the page's own labels", shape.shapeSource, "labels");
  check("still finds the total under an aliased name", shape.total, "1778.38");
  check("builds one lead-guest slot", shape.guests.length, 1);
  check("matched title, first, last", Object.keys(shape.guests[0].fields).sort(), ["firstname", "lastname", "title"]);
  check("matched the mobile box", shape.phones, ["#gph"]);
  await rr.fillGuests(page, shape, [{ firstName: "Megan", lastName: "Gray", title: "Mr" }], { phone: "0400111222" });
  check("fills by id when there is no name attribute", await valuesOf(page, ["#gfn", "#gln", "#gph"]), ["Megan", "Gray", "0400111222"]);

  console.log("\n=== a form with no guest fields at all ===\n");
  await load(NO_GUEST_FIELDS);
  shape = await rr.readBookFormShape(page);
  check("finds no guest slots", shape.guests.length, 0);
  await throws("stops with a readable message, listing what it did see",
    () => rr.fillGuests(page, shape, [{ firstName: "Megan", lastName: "Gray" }]),
    /Couldn't find any guest name fields.*promoCode/s);

  console.log("\n=== a form that discards what we type ===\n");
  await load(PROVIDER_3);
  shape = await rr.readBookFormShape(page);
  // Stand in for a React re-render wiping the box a moment after we set it.
  await page.evaluate(() => {
    const el = document.querySelector('[name="room-0-guest-0-lastname"]');
    el.addEventListener("input", () => { setTimeout(() => { el.value = ""; }, 0); });
  });
  await throws("notices the empty box instead of clicking Proceed into a validation error",
    () => rr.fillGuests(page, shape, [{ firstName: "Megan", lastName: "Gray" }]),
    /came back empty.*room-0-guest-0-lastname/s);

  await browser.close();

  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\n💥 " + (e && e.stack ? e.stack : e) + "\n");
  process.exit(1);
});
