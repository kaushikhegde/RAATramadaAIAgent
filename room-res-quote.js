/**
 * room-res-quote.js — Playwright + CDP automation for room-res.com (agent portal).
 *
 *   search → hotel page → rate row → /book (guest names) → Proceed
 *          → draft itinerary → Create Customer Quote → Generate Quote
 *          → read Quote Number back from /account/customerquotes
 *
 * Field/DOM behaviour was mapped live on 28-Jul-2026 — see roomres-field-map.md.
 * Everything surprising in here traces back to a numbered section of that doc.
 *
 * ── The run is deliberately SPLIT IN TWO ────────────────────────────────────
 *   1) runRoomResDraft()          → builds the draft itinerary, returns the NET COST
 *   2) runRoomResQuote()          → takes the quoted (sell) price, generates the quote
 *
 * That split exists because the agreed behaviour is "show the cost, wait for the
 * human to type the price" (no automatic margin %). The draft itinerary lives
 * server-side under a stable id, so the browser page can close between the two
 * calls and the chat can ask its question in between. runRoomResFullQuote() does
 * both back-to-back when the price is already known (tests / re-runs).
 *
 * ── Non-obvious things this module is careful about ─────────────────────────
 *   • roomRateCode encoding differs per provider (§6a) — we NEVER build a /book
 *     URL, we always follow the real BOOK THIS ROOM link.
 *   • The /book form shape differs per provider (§6b) — provider 3 is First/Last
 *     only, provider 14 adds Title/Country/Phone. We enumerate the actual
 *     room-*-guest-* inputs and fill what exists.
 *   • The authoritative net cost is input[name="total"] on /book (§6b), NOT the
 *     rounded price shown on the rate row ($683 vs the real 682.65).
 *   • Quote builder trap 1 (§8a): show_total_price defaults to NO → the customer
 *     would see a quote with no price. We always click #show_total_price_yes —
 *     and we click it FIRST, because #guestTotalPrice is display:none until it
 *     is ticked, so any visible-wait on the price box before that never returns.
 *   • Quote builder trap 2 (§8a): #guestTotalPrice is pre-filled with our own NET
 *     COST → left alone we quote at zero margin. We always overwrite it.
 *   • Generate Quote does NOT navigate (§8c) — the result is appended to the same
 *     page, so we wait for the "Quote URL:" block, not for a URL change.
 *   • The quote number (Q4xxxxx) is not on the builder page at all (§8c) — it is
 *     read back from the quotes table by matching td[0] on the itinerary code (§9a).
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *   This module NEVER touches "Pay & Confirm Booking(s)" or "Hold & Pay Later".
 *   A draft itinerary holds nothing and costs nothing. It also never types
 *   credentials — if the shared Chrome isn't signed into Room-Res it asks the
 *   user to sign in and waits.
 */

const { chromium } = require("playwright");

const ROOMRES_BASE_URL = (process.env.ROOMRES_URL || "https://room-res.com").replace(/\/+$/, "");
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_MODE = process.env.CDP_MODE || "external";
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || "chrome";
const HEADLESS = process.env.HEADLESS === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── date helpers ───────────────────────────────────────────────────────── */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ISO (2026-08-01) or dd-Mon-yyyy → Room-Res display format "01-Aug-2026".
function toRoomResDate(input) {
  if (!input) return "";
  const s = String(input).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}-${MONTHS[parseInt(iso[2], 10) - 1]}-${iso[1]}`;
  const dmy = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (dmy) return `${String(dmy[1]).padStart(2, "0")}-${dmy[2][0].toUpperCase()}${dmy[2].slice(1, 3).toLowerCase()}-${dmy[3]}`;
  return s;
}

// "01-Aug-2026" → "2026-08-01" (what Tramada's toTramadaDate expects as input).
function roomResDateToIso(input) {
  if (!input) return "";
  const s = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return s;
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mi < 0) return s;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

function nightsBetween(isoFrom, isoTo) {
  const a = Date.parse(`${roomResDateToIso(isoFrom)}T00:00:00Z`);
  const b = Date.parse(`${roomResDateToIso(isoTo)}T00:00:00Z`);
  if (!isFinite(a) || !isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

function money(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
  return isFinite(n) ? n : null;
}

/* ── browser / login ────────────────────────────────────────────────────── */

async function openBrowser(onProgress) {
  if (CDP_MODE === "internal") {
    onProgress(3, `Launching Chrome (${BROWSER_CHANNEL})...`);
    const browser = await chromium.launch({
      channel: BROWSER_CHANNEL,
      headless: HEADLESS,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    return { browser };
  }
  onProgress(3, `Connecting to CDP Chrome at ${CDP_HOST}:${CDP_PORT}...`);
  try {
    const browser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);
    return { browser };
  } catch (cdpErr) {
    throw new Error(
      `Could not connect to Chrome on ${CDP_HOST}:${CDP_PORT}. ` +
        `Run "npm run start:chrome" and sign into room-res.com IN THAT WINDOW first. [${cdpErr.message}]`
    );
  }
}

// Authed = /account renders the agent dashboard rather than a sign-in form.
// (Same trap as Tramada: the login route serves a form even when authenticated,
// so we test a PROTECTED page instead of the login page.)
async function roomResIsAuthed(page) {
  await page.goto(`${ROOMRES_BASE_URL}/account`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(400);
  const url = page.url();
  if (/\/(login|signin|sign-in|auth)\b/i.test(url)) return false;
  if (!/\/account/i.test(url)) return false;
  // A visible password box on /account means we were bounced to a sign-in form.
  const pw = await page.locator('input[type="password"]:visible').count().catch(() => 0);
  return pw === 0;
}

// We never type Room-Res credentials — the user signs in themselves in the
// shared Chrome window and we wait for it (up to 5 min).
async function ensureRoomResLoggedIn(page, { onNeedLogin } = {}) {
  if (await roomResIsAuthed(page)) return;
  if (typeof onNeedLogin === "function") onNeedLogin();
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await roomResIsAuthed(page)) {
      await sleep(500);
      return;
    }
  }
  throw new Error("Timed out waiting for a Room-Res sign-in. Sign into room-res.com in the shared Chrome and try again.");
}

/* ── the kept-open page ─────────────────────────────────────────────────────
 * The draft and the quote are two separate calls with a HUMAN QUESTION between
 * them, and the draft's tab used to be closed the instant it succeeded. That
 * threw away the itinerary the agent had just asked to see, and made the quote
 * phase pay for a fresh CDP connect, a login check and a re-navigation every
 * time. So a call can now ask to KEEP its page, and the next call in the same
 * run picks it back up.
 *
 * One slot on purpose: this drives one shared Chrome for one agent. Two
 * concurrent Room-Res runs would be fighting over the same window whatever we
 * cached here.
 */
let _sticky = null; // { browser, page }

function _stickyAlive() {
  if (!_sticky) return false;
  try {
    return !!(_sticky.page && !_sticky.page.isClosed() && _sticky.browser && _sticky.browser.isConnected());
  } catch {
    return false;
  }
}

/**
 * Let go of the kept-open page. The caller owns this: the run only ends when
 * the CONVERSATION ends, which this module can't see. Safe to call when there
 * is nothing to release.
 */
async function closeRoomResPage() {
  const s = _sticky;
  _sticky = null;
  if (!s) return;
  try { if (s.page && !s.page.isClosed()) await s.page.close(); } catch {}
  try { if (s.browser) await s.browser.close(); } catch {}
}

async function withRoomResPage(args, fn) {
  const onProgress = (args.callbacks && args.callbacks.onProgress) || (() => {});
  const keepOpen = !!args.keepOpen;
  const reuse = _stickyAlive();

  let browser, page;
  let ok = false;
  try {
    if (reuse) {
      // The tab from the previous phase is still up and still signed in. Skip
      // the connect and the login check — that's the point of keeping it.
      ({ browser, page } = _sticky);
      onProgress(3, "Picking up the open Room-Res tab...");
    } else {
      await closeRoomResPage(); // a dead slot, if there was one
      ({ browser } = await openBrowser(onProgress));
      const ctx = browser.contexts()[0] || (await browser.newContext());
      page = await ctx.newPage();
      await ensureRoomResLoggedIn(page, { onNeedLogin: args.callbacks && args.callbacks.onNeedLogin });
    }
    const result = await fn(page, page.context());
    ok = true;
    return result;
  } finally {
    if (ok && keepOpen) {
      // Hand the tab to the next phase rather than closing it. The browser
      // connection has to stay up too — dropping it takes the tab with it.
      _sticky = { browser, page };
    } else {
      _sticky = null;
      // On success close our tab; on failure leave it open so the user can see
      // exactly which page we died on. Disconnecting from a CDP browser never
      // closes the user's Chrome.
      if (ok) {
        try { if (page) await page.close(); } catch {}
      }
      try { if (browser) await browser.close(); } catch {}
    }
  }
}

/* ── low-level page helpers ─────────────────────────────────────────────── */

// React-safe value setting: call the NATIVE value setter then fire input+change,
// which is what React's synthetic event system actually listens to. Verified
// live on the /book form and the quote builder (§6b).
async function reactSet(page, selector, value) {
  if (value == null || value === "") return false;
  return await page.evaluate(
    ({ sel, val }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, String(val));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    { sel: selector, val: value }
  );
}

// <select>: match by value, exact label, then label-contains. Never uses
// Playwright's selectOption (which blocks for 30s on a near-miss).
async function selectSet(page, selector, value) {
  if (value == null || value === "") return false;
  return await page.evaluate(
    ({ sel, want }) => {
      const el = document.querySelector(sel);
      if (!el || !el.options) return false;
      const w = String(want).trim().toLowerCase();
      const opts = Array.from(el.options);
      const hit =
        opts.find((o) => (o.value || "").toLowerCase() === w) ||
        opts.find((o) => (o.textContent || "").trim().toLowerCase() === w) ||
        opts.find((o) => (o.textContent || "").toLowerCase().includes(w));
      if (!hit) return false;
      el.value = hit.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    { sel: selector, want: value }
  );
}

// NOTE: this reports whether the element was THERE, not whether the click
// landed — the click error is swallowed. Fine for cosmetic radios; never use it
// to gate something that matters. Use setRadio() for those.
async function clickIfPresent(page, selector) {
  const el = page.locator(selector);
  if (!(await el.count().catch(() => 0))) return false;
  await el.first().click({ timeout: 8000 }).catch(() => {});
  return true;
}

// Click a radio and CONFIRM it took. These are real <input type=radio> boxes but
// React owns their checked state, so a click Playwright considers successful can
// still leave the radio unchecked — and on this page one of those radios is the
// difference between a quote with a price and a quote without one. Falls back to
// a native in-page click, which React's synthetic listener also sees.
async function setRadio(page, selector) {
  const el = page.locator(selector);
  if (!(await el.count().catch(() => 0))) return false;
  const isChecked = () =>
    page.evaluate((s) => {
      const e = document.querySelector(s);
      return !!(e && e.checked);
    }, selector);

  if (await isChecked()) return true;
  await el.first().click({ timeout: 8000 }).catch(() => {});
  if (await isChecked()) return true;

  await page.evaluate((s) => {
    const e = document.querySelector(s);
    if (e) e.click();
  }, selector);
  return await isChecked();
}

// Wait for a piece of page TEXT rather than a fixed timeout (§13). Room-Res
// pages take 5-8s and render their header before their content, so anchoring on
// content is the only reliable gate.
async function waitForText(page, pattern, { timeout = 45000, label = "" } = {}) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const txt = await page.evaluate(() => document.body && document.body.innerText).catch(() => "");
    if (txt && re.test(txt)) return txt;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label || re} on ${page.url()}`);
}

// Follow a link we scraped. Prefer navigating to the href in the SAME tab:
// Room-Res opens rate links with target=_blank (§13) and juggling popups over
// CDP is avoidable noise. Falls back to a real click + popup race if there's
// no usable href.
async function followHref(page, href, { waitFor } = {}) {
  if (!href) throw new Error("followHref: no href");
  await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (waitFor) await waitForText(page, waitFor.pattern, { timeout: waitFor.timeout || 45000, label: waitFor.label });
  return page;
}

/* ── step 1: destination resolution + search ────────────────────────────── */

// Destination id cache. Only the destination id needs the autocomplete dance;
// once we have it the whole search is a plain URL (§3a). Cached per process —
// the ids are stable server-side reference data.
const _destCache = new Map();

// In-page reader for the #destination suggestion list. Only nodes in the
// DROPDOWN ZONE — directly BELOW the input and horizontally overlapping it —
// are candidates; without that a contains-match can hit unrelated page chrome.
// arg.baseline is the zone text captured BEFORE typing (the home page already
// has ~9 zone nodes of its own), so subtracting it leaves the real rows and
// lets us tell "list hasn't rendered yet" from "list rendered, no match".
// Returns { options, hit }; when arg.doClick, also clicks the hit.
function _findDestSuggestion(arg) {
  const input = document.querySelector("#destination");
  if (!input) return null;
  const ir = input.getBoundingClientRect();
  const txt = (n) => (n.innerText || "").trim();

  const nodes = Array.from(document.querySelectorAll("div,li,span,a")).filter((n) => {
    const r = n.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    if (!(r.top >= ir.bottom - 6 && r.top <= ir.bottom + 420)) return false;
    if (!(r.left < ir.right + 80 && r.right > ir.left - 80)) return false;
    const t = txt(n);
    return t && t.length < 90 && !t.includes("\n");
  });

  const base = new Set(arg.baseline || []);
  const rows = nodes.filter((n) => !base.has(txt(n)));
  const w = String(arg.want).trim().toLowerCase();
  const hit =
    rows.find((n) => txt(n).toLowerCase() === w) ||
    rows.find((n) => txt(n).toLowerCase().startsWith(w)) ||
    rows.find((n) => txt(n).toLowerCase().includes(w));

  // Rows nest (the same text appears on a div and its parent li), so dedupe
  // before reporting them back to the user.
  const out = { options: Array.from(new Set(rows.map(txt))).slice(0, 12), hit: null };
  if (hit) {
    out.hit = { text: txt(hit), y: Math.round(hit.getBoundingClientRect().top) };
    if (arg.doClick) {
      hit.scrollIntoView({ block: "center" });
      hit.click();
    }
  }
  return out;
}

// The suggestion list is backed by POST .../v2/autocomplete/getdestinations
// with {"keyword": <what's typed>} -> {"destinations":[{id, destination,
// category, ...}]} (§3b). That response is the authoritative signal: it lands
// ~1.5s after typing, a good 2s BEFORE the list paints, and an empty array is a
// definitive "no such destination" rather than "not rendered yet".
const DEST_API_RE = /autocomplete\/getdestinations/i;

// Pick the API row that best matches what the user asked for. The API's own
// ordering is already scored, but we prefer an explicit text match so a fuzzy
// server-side hit can never silently swap the destination underneath us.
function _bestDestRow(rows, want) {
  const w = String(want).trim().toLowerCase();
  const t = (r) => String(r.destination || "").trim().toLowerCase();
  return rows.find((r) => t(r) === w) || rows.find((r) => t(r).startsWith(w)) || rows.find((r) => t(r).includes(w)) || null;
}

/**
 * Type into #destination and commit a suggestion.
 *
 * The list paints ~3.4s after the first keystroke (§3b), so the old fixed 1.2s
 * sleep + single DOM snapshot always sampled the page before the list existed
 * and every search died with "didn't offer a destination".
 *
 * Two stages instead:
 *   1. Gate on the autocomplete RESPONSE — decisive, and ~2s earlier than the
 *      paint. An empty list there is a real typo, so we fail in seconds rather
 *      than burning the whole timeout twice waiting for something never coming.
 *   2. Poll the DOM for a STABLE row (same text at the same position on two
 *      consecutive reads — the list reflows while rendering) before clicking,
 *      then confirm the field took the pick. Same shape as Tramada's
 *      pickAutocomplete. Retries once, re-typing, before giving up.
 *
 * Returns { text, id } on success, or { text: null, options } listing what
 * Room-Res actually offered so the error can name real alternatives.
 */
async function pickDestination(page, destination, { timeout = 25000 } = {}) {
  const typed = String(destination).trim();
  let offered = [];

  // Collect autocomplete responses for exactly OUR keyword — the widget is
  // debounced but still emits calls for prefixes ("Sydne"), and acting on a
  // prefix's results would resolve the wrong destination.
  let apiRows = null;
  const onResponse = async (res) => {
    if (!DEST_API_RE.test(res.url())) return;
    let keyword = "";
    try { keyword = JSON.parse(res.request().postData() || "{}").keyword || ""; } catch {}
    if (String(keyword).trim().toLowerCase() !== typed.toLowerCase()) return;
    try {
      const body = await res.json();
      if (Array.isArray(body && body.destinations)) apiRows = body.destinations;
    } catch { /* unreadable → leave null and fall back to reading the DOM */ }
  };
  page.on("response", onResponse);

  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      apiRows = null;
      await page.click("#destination");
      await page.fill("#destination", "");

      // Zone text before any list exists — everything here is page chrome.
      const baseline =
        (await page.evaluate(_findDestSuggestion, { want: " ", baseline: [], doClick: false }).catch(() => null))
          ?.options || [];

      await page.type("#destination", typed, { delay: 90 }); // real keystrokes → dropdown

      // Phase 1 — wait for the API verdict. If it says "no destinations", stop
      // immediately: no amount of extra waiting will make a typo resolve.
      const apiDeadline = Date.now() + timeout;
      while (apiRows === null && Date.now() < apiDeadline) await sleep(200);
      let wantText = typed;
      let wantId = null;
      if (apiRows !== null) {
        const row = _bestDestRow(apiRows, typed);
        if (!row) {
          return { text: null, options: apiRows.map((r) => String(r.destination || "")).filter(Boolean).slice(0, 12) };
        }
        wantText = String(row.destination).trim();
        wantId = row.id != null ? String(row.id) : null;
      }

      // Phase 2 — the row is coming; wait for it to paint and settle, then click.
      // wantText is the API's canonical string, so this is an exact match when the
      // API answered, and the looser contains-match only when it didn't.
      const deadline = Date.now() + timeout;
      let match = null;
      let prev = null;
      while (Date.now() < deadline) {
        await sleep(250);
        const cur = await page.evaluate(_findDestSuggestion, { want: wantText, baseline, doClick: false }).catch(() => null);
        if (!cur) continue;
        if (cur.hit && prev && prev.hit && cur.hit.text === prev.hit.text && Math.abs(cur.hit.y - prev.hit.y) < 2) {
          match = cur.hit;
          break;
        }
        // List rendered and settled with no match → a genuine miss, not slowness.
        // Stop waiting and report it rather than burning the full timeout twice.
        if (!cur.hit && prev && !prev.hit && cur.options.length >= 3 && cur.options.length === prev.options.length) {
          offered = cur.options;
          return { text: null, options: offered };
        }
        prev = cur;
      }
      if (!match) continue; // no list at all this pass — re-type and try again

      await page.evaluate(_findDestSuggestion, { want: wantText, baseline, doClick: true }).catch(() => null);

      // Registered = the widget took the pick: it either rewrote the field to the
      // full form ("Sydney" → "Sydney, NSW, AU") or closed the list. Checking the
      // value alone would misread a caller who already passed the full form.
      for (let i = 0; i < 12; i++) {
        await sleep(250);
        const v = ((await page.inputValue("#destination").catch(() => "")) || "").trim();
        const still = await page.evaluate(_findDestSuggestion, { want: wantText, baseline, doClick: false }).catch(() => null);
        if (v && (v.toLowerCase() !== typed.toLowerCase() || !still || !still.hit)) return { text: match.text, id: wantId };
      }
    }
    return { text: null, options: offered };
  } finally {
    page.off("response", onResponse);
  }
}

function buildSearchUrl({ destination, destinationId, dateFrom, dateTo, adults = 2, children = 0, rooms = 1, pkg = true }) {
  const q = new URLSearchParams({
    dateFrom: toRoomResDate(dateFrom),
    dateTo: toRoomResDate(dateTo),
    destination,
    id: String(destinationId),
    ishotel: "0",
    pkg: pkg ? "1" : "0",
    "room-0-adults": String(adults),
    "room-0-children": String(children),
    roomsAmount: String(rooms),
  });
  return `${ROOMRES_BASE_URL}/search?${q.toString()}`;
}

/**
 * Run the real search form once to learn the destination id, and land on the
 * results page. Returns { destination, destinationId, url }.
 */
async function searchViaForm(page, opts, onProgress = () => {}) {
  const { destination, dateFrom, dateTo, adults = 2, children = 0 } = opts;
  onProgress(12, `Searching Room-Res for ${destination}...`);

  await page.goto(`${ROOMRES_BASE_URL}/account`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#destination", { timeout: 30000 });

  // Destination is a validated autocomplete: real keystrokes, then pick the
  // suggestion by TEXT (the suggestion class is a hashed CSS module — §3).
  const { text: picked, id: pickedId, options } = await pickDestination(page, destination);

  if (!picked) {
    const alts = (options || []).filter((o) => /,/.test(o)).slice(0, 5);
    throw new Error(
      `Room-Res didn't offer a destination matching "${destination}".` +
        (alts.length ? ` It offered: ${alts.join(" | ")}.` : ` Try the full form, e.g. "Sydney, NSW, AU".`)
    );
  }

  await reactSet(page, "#from", toRoomResDate(dateFrom));
  await reactSet(page, "#to", toRoomResDate(dateTo));
  await selectSet(page, "#rooms", String(adults));
  await sleep(300);

  // Submit — the resulting URL carries the destination id we want to cache.
  const submitted = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button,input[type=submit],a"));
    const b = btns.find((x) => /search\s*hotels?/i.test((x.innerText || x.value || "").trim()));
    if (!b) return false;
    b.click();
    return true;
  });
  if (!submitted) throw new Error('Could not find the "Search hotels" button on the Room-Res home page.');

  await page.waitForURL((u) => /\/search\?/.test(u.toString()), { timeout: 60000 });
  const url = page.url();
  // The submitted URL is the primary source of the id; the autocomplete API
  // reported the same id (§3b) and backs it up if the form ever drops it.
  const destinationId = new URL(url).searchParams.get("id") || pickedId || "";
  const resolvedDestination = new URL(url).searchParams.get("destination") || picked;
  if (destinationId) _destCache.set(destination.trim().toLowerCase(), { destinationId, destination: resolvedDestination });
  return { destination: resolvedDestination, destinationId, url };
}

/**
 * Scrape the search-results page into hotel candidates.
 * Class names are hashed CSS modules, so we anchor on the one stable thing:
 * every card contains at least one <a href="/hotelpage/...">.
 */
async function scrapeSearchResults(page) {
  return await page.evaluate(() => {
    const HOTEL_LINK = 'a[href*="/hotelpage/"]';
    const anchors = Array.from(document.querySelectorAll(HOTEL_LINK));
    const roots = [];
    const cards = [];

    // Climb to the CARD — the smallest ancestor carrying the rate panel
    // ("from AUD $…") as well as the hotel link.
    //
    // This used to climb until innerText passed 90 characters, which made the
    // card boundary depend on HOW MANY AMENITY CHIPS a hotel happens to list.
    // The York (5 chips) stopped one level short of its price panel and scraped
    // as priceless; 83 OSHR (2 chips) reached it. Every richly-described hotel
    // then dropped out of the "cheapest" comparison below, leaving a shortlist
    // of two sparse apartment listings — the most expensive rooms on the page.
    // Anchor on the content we actually need instead of on a text length.
    const climb = (a) => {
      let node = a;
      let best = a;
      for (let i = 0; i < 12 && node.parentElement; i++) {
        const parent = node.parentElement;
        // Never climb into a node holding two hotel links: that is the results
        // list, not a card, and merging two cards is worse than missing a price.
        if (parent.querySelectorAll(HOTEL_LINK).length > 1) break;
        node = parent;
        best = node;
        if (/from\s*AUD/i.test(node.innerText || "")) break;
      }
      return best;
    };

    // Star rating: five 12px SVGs per card, gold (#fed000) filled against grey
    // (#99A1AF) empty. There is no text form of it — the "4.3/5 Overall Ratings"
    // line is the REVIEW score, an entirely different number, and that is what
    // the old /(\d(?:\.\d)?)\s*(?:star|\/5)/ was quietly reading.
    const GOLD = /#fed000|rgb\(\s*254,\s*208,\s*0\s*\)/i;
    const starsOf = (root) => {
      const paths = Array.from(root.querySelectorAll("svg path"));
      if (!paths.length) return null;
      let gold = 0;
      for (const p of paths) {
        const attr = p.getAttribute("fill") || "";
        let computed = "";
        try { computed = getComputedStyle(p).fill || ""; } catch {}
        if (GOLD.test(attr) || GOLD.test(computed)) gold++;
      }
      // Outside 1–5 we didn't find a star row; say "unknown" rather than guess.
      return gold >= 1 && gold <= 5 ? gold : null;
    };

    for (const a of anchors) {
      const root = climb(a);
      let idx = roots.indexOf(root);
      if (idx === -1) {
        idx = roots.length;
        roots.push(root);
        cards.push({ text: (root.innerText || "").trim(), stars: starsOf(root), links: [] });
      }
      const href = a.href || "";
      let track = "";
      try { track = new URL(href).searchParams.get("type") || ""; } catch {}
      const label = (a.innerText || a.textContent || "").trim();
      if (!track) track = /net\s*rate/i.test(label) ? "net" : /online/i.test(label) ? "online" : "";
      cards[idx].links.push({ href, label, track });
    }

    const NOISE = /^(from\b|aud\b|\$|view\b|book\b|raa net|online price|commission|per night|show on map|map\b|select|more info|details|\d+(\.\d+)?\/5$|\d+ review)/i;

    // Read the LABELLED figures only, and keep the two tracks apart. The panel
    // reads:
    //     RAA NET RATE / from AUD $1,778 / RAA Net Rates
    //     ONLINE PRICES / from AUD $2,000 / Commission $96.22 / View Online Rates
    // "Commission $96.22" is a dollar amount too, and it is reliably the
    // SMALLEST one on the card — so a bare Math.min over every $ on the card
    // returns the commission and calls it the room rate. That is exactly what
    // it did: the two hotels that survived the scrape were ranked, and picked,
    // on their commission.
    const readPrices = (text) => {
      const out = { net: null, online: null };
      let section = "";
      for (const line of text.split("\n").map((s) => s.trim()).filter(Boolean)) {
        if (/commission/i.test(line)) continue; // never a room rate
        if (/raa\s*net\s*rate/i.test(line)) { section = "net"; continue; }
        if (/online\s*price/i.test(line)) { section = "online"; continue; }
        const m = line.match(/from\s*(?:AUD|A\$)?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
        if (!m || !section) continue;
        const n = parseFloat(m[1].replace(/,/g, ""));
        if (isFinite(n) && n > 0 && out[section] == null) out[section] = n;
      }
      return out;
    };

    return cards.map((c) => {
      const lines = c.text.split("\n").map((s) => s.trim()).filter(Boolean);
      const name = lines.find((l) => l.length > 3 && !NOISE.test(l)) || lines[0] || "";
      const { net, online } = readPrices(c.text);
      return {
        hotelName: name,
        netPrice: net,
        onlinePrice: online,
        stars: c.stars,
        // Kept for callers that don't care about the track. Prefer net: it is
        // our cost, and it is the default track.
        fromPrice: net != null ? net : online,
        links: c.links,
        snippet: lines.slice(0, 6).join(" | "),
      };
    }).filter((c) => c.hotelName && c.links.length);
  });
}

// Loose name matching — "york" should find "The York by Swiss-Belhotel International".
function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
function scoreNameMatch(candidate, want) {
  const c = normName(candidate);
  const w = normName(want);
  if (!c || !w) return 0;
  if (c === w) return 100;
  if (c.startsWith(w)) return 80;
  if (c.includes(w)) return 60;
  // token overlap
  const wt = String(want).toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!wt.length) return 0;
  const hits = wt.filter((t) => c.includes(normName(t))).length;
  return Math.round((hits / wt.length) * 50);
}

/**
 * Pick the hotel per the agreed rule: an explicitly named hotel wins; with no
 * name supplied we take the cheapest card on the chosen rate track.
 */
const DEFAULT_MIN_STARS = 3;

function chooseHotel(cards, { hotelName, rateTrack, minStars = DEFAULT_MIN_STARS } = {}) {
  const withTrack = cards
    .map((c) => {
      const exact = c.links.find((l) => l.track === rateTrack);
      const any = c.links[0];
      return { ...c, chosenLink: exact || any, hasTrack: !!exact };
    })
    .filter((c) => c.chosenLink && c.chosenLink.href);

  if (!withTrack.length) return { hotel: null, reason: "no hotel cards found" };

  if (hotelName) {
    const scored = withTrack
      .map((c) => ({ c, score: scoreNameMatch(c.hotelName, hotelName) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 50) {
      return { hotel: scored[0].c, reason: `matched "${hotelName}"`, alternatives: scored.slice(1, 6).map((s) => s.c.hotelName) };
    }
    return {
      hotel: null,
      reason: `no hotel in the results matched "${hotelName}"`,
      alternatives: withTrack.slice(0, 10).map((c) => c.hotelName),
    };
  }

  // Compare on the track we were actually asked for — the net and online prices
  // on a card differ by hundreds of dollars, so mixing them ranks nothing.
  const priceOn = (c) => {
    const p = rateTrack === "online" ? c.onlinePrice : c.netPrice;
    if (p != null) return p;
    const other = rateTrack === "online" ? c.netPrice : c.onlinePrice;
    return other != null ? other : c.fromPrice;
  };

  const priced = withTrack
    .map((c) => ({ c, price: priceOn(c) }))
    .filter((x) => x.price != null)
    .sort((a, b) => a.price - b.price);

  // A star floor, so "cheapest" doesn't put a shared dormitory in front of a
  // client. It applies ONLY where the page actually told us the rating: an
  // unknown star count is never a reason to drop a hotel, so if the markup
  // changes and stars stop parsing the floor quietly stops applying instead of
  // emptying the shortlist. Silently shrinking the candidate list is exactly how
  // the pricing bug stayed invisible.
  const floor = Number(minStars) || 0;
  const meetsFloor = (c) => !floor || c.stars == null || c.stars >= floor;
  let eligible = priced.filter((x) => meetsFloor(x.c));
  let floorNote = "";
  if (floor && priced.length && !eligible.length) {
    eligible = priced;
    floorNote = `, nothing at ${floor}★ or above so the floor was dropped`;
  } else if (floor && eligible.length < priced.length) {
    const skipped = priced.length - eligible.length;
    floorNote = `, ${skipped} under ${floor}★ skipped`;
  }

  const pick = eligible.length ? eligible[0].c : withTrack[0];

  // Say how much of the page we could actually price. "Cheapest" computed over a
  // rump of the results is the failure that put a $1,778/night Bondi apartment
  // on a quote when a $269 hotel was sitting at the top of the same page — and
  // it looked exactly like a working run. If that ever recurs, it says so here.
  const coverage = `priced ${priced.length} of ${withTrack.length}`;
  const reason = eligible.length
    ? `cheapest ${rateTrack === "online" ? "online" : "net"} rate on the results page ($${eligible[0].price}` +
      `${pick.stars ? `, ${pick.stars}★` : ""}, ${coverage}${floorNote})`
    : `first result — no prices could be read off any of the ${withTrack.length} cards`;

  return {
    hotel: pick,
    reason,
    minStars: floor,
    partialPricing: priced.length > 0 && priced.length < withTrack.length,
    alternatives: (eligible.length ? eligible.map((x) => x.c) : withTrack).slice(1, 6).map((c) => c.hotelName),
  };
}

/* ── step 2: hotel page → rate row ──────────────────────────────────────── */

/**
 * Scrape the rate list. The only stable anchor is the BOOK THIS ROOM link (§5);
 * everything else on the row is read from the row's own text.
 */
async function scrapeRateRows(page) {
  return await page.evaluate(() => {
    const clickable = Array.from(document.querySelectorAll("a,button")).filter((n) =>
      /book\s+this\s+room/i.test((n.innerText || n.textContent || "").trim())
    );
    const roots = [];
    const rows = [];

    const climb = (a) => {
      let node = a;
      let best = a;
      for (let i = 0; i < 8 && node && node.parentElement; i++) {
        node = node.parentElement;
        best = node;
        const t = (node.innerText || "").trim();
        if (t.length > 70) break;
      }
      return best;
    };

    for (const a of clickable) {
      const root = climb(a);
      let idx = roots.indexOf(root);
      if (idx === -1) {
        idx = roots.length;
        roots.push(root);
        rows.push({ text: (root.innerText || "").trim(), href: a.href || "" });
      } else if (!rows[idx].href) {
        rows[idx].href = a.href || "";
      }
    }

    const NOISE = /^(book this room|total price|aud|\$|non refundable|flexible cancellation|pay later|room only|bed and breakfast|breakfast included|\d+ night)/i;

    return rows.map((r) => {
      const lines = r.text.split("\n").map((s) => s.trim()).filter(Boolean);
      const roomName = lines.find((l) => l.length > 2 && !NOISE.test(l)) || lines[0] || "";
      const prices = (r.text.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/g) || [])
        .map((m) => parseFloat(m.replace(/[^0-9.]/g, "")))
        .filter((n) => isFinite(n) && n > 0);
      const board = (r.text.match(/(Room Only|Bed And Breakfast|Breakfast Included|Half Board|Full Board|All Inclusive)/i) || [])[1] || "";
      const refundable = /flexible cancellation/i.test(r.text)
        ? "Flexible Cancellation"
        : /non\s*refundable/i.test(r.text)
        ? "Non Refundable"
        : "";
      return {
        roomName,
        // NOTE: display prices are ROUNDED (§13). This is only used to CHOOSE a
        // row — the authoritative cost is input[name="total"] on /book.
        displayPrice: prices.length ? Math.max(...prices) : null,
        board,
        refundable,
        href: r.href,
      };
    }).filter((r) => r.href);
  });
}

function chooseRate(rows, { roomPreference, boardPreference, refundableOnly } = {}) {
  let pool = rows.slice();
  if (refundableOnly) {
    const flex = pool.filter((r) => /flexible/i.test(r.refundable));
    if (flex.length) pool = flex;
  }
  if (boardPreference) {
    const b = pool.filter((r) => scoreNameMatch(r.board, boardPreference) >= 60);
    if (b.length) pool = b;
  }
  if (roomPreference) {
    const scored = pool
      .map((r) => ({ r, score: scoreNameMatch(r.roomName, roomPreference) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0] && scored[0].score >= 50) return { rate: scored[0].r, reason: `matched room "${roomPreference}"` };
  }
  const priced = pool.filter((r) => r.displayPrice != null).sort((a, b) => a.displayPrice - b.displayPrice);
  const pick = priced[0] || pool[0] || rows[0];
  return { rate: pick, reason: priced.length ? "cheapest available rate" : "first available rate" };
}

/* ── step 3: /book form ─────────────────────────────────────────────────── */

/**
 * Enumerate the guest fields that ACTUALLY exist on this provider's book form
 * (§6b — provider 3 is First/Last only, provider 14 adds Title/Country/Phone).
 *
 * Three things this is careful about, each of which has already bitten us:
 *
 *  • Almost everything worth reading here is a HIDDEN input (§6b) — `total`
 *    included — so this runs entirely inside page.evaluate() and never waits on
 *    an element being visible. The caller's wait must be state:"attached" too.
 *  • The room-<r>-guest-<g>-<field> convention holds across the providers we
 *    mapped, but the field half is spelled inconsistently between them
 *    (firstname / first-name / firstName), so it gets normalised to one key.
 *  • If some provider abandons the convention entirely, fall back to reading the
 *    form's own labels ("Guest First Name", "Guest Last Name"). Better a
 *    label-matched fill than a run that reports success with empty name boxes.
 *
 * Every field carries its own `sel`, because the fallback path finds elements
 * that have an id but no name.
 */
async function readBookFormShape(page) {
  return await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("input,select,textarea"));
    const selFor = (el) =>
      el.name ? `[name="${el.name}"]` : el.id ? `#${(window.CSS && CSS.escape ? CSS.escape(el.id) : el.id)}` : "";
    const fields = all.map((el) => ({
      name: el.name || "",
      sel: selFor(el),
      type: (el.type || el.tagName || "").toLowerCase(),
      value: el.type === "checkbox" ? String(el.checked) : el.value || "",
    }));
    const byName = (n) => fields.find((f) => f.name === n);
    const valOf = (n) => (byName(n) ? byName(n).value : "");

    // firstName / first-name / fname / givenName all mean the same box.
    const canon = (raw) => {
      const k = String(raw).toLowerCase().replace(/[^a-z]/g, "");
      if (/^(firstname|fname|givenname|given|forename)$/.test(k)) return "firstname";
      if (/^(lastname|lname|surname|familyname|family)$/.test(k)) return "lastname";
      if (/^(title|salutation)$/.test(k)) return "title";
      if (/^(country|countrycode|nationality)$/.test(k)) return "country";
      return k;
    };

    const guests = [];
    const slotFor = (room, index) => {
      let g = guests.find((x) => x.room === room && x.index === index);
      if (!g) { g = { room, index, fields: {} }; guests.push(g); }
      return g;
    };

    // Everything the page tells a human about a box: its own attributes, its
    // <label for=…>, and any label wrapped around it.
    const describe = (el) => {
      const bits = [el.name || "", el.id || "", el.placeholder || "", el.getAttribute("aria-label") || ""];
      if (el.id) {
        const l = document.querySelector(`label[for="${window.CSS && CSS.escape ? CSS.escape(el.id) : el.id}"]`);
        if (l) bits.push(l.innerText || "");
      }
      const wrap = el.closest("label");
      if (wrap) bits.push(wrap.innerText || "");
      return bits.join(" ").toLowerCase();
    };

    let shapeSource = "room-guest-names";
    for (const f of fields) {
      const m = f.name.match(/^room-(\d+)-guest-(\d+)-(.+)$/);
      if (!m) continue;
      slotFor(+m[1], +m[2]).fields[canon(m[3])] = { name: f.name, sel: f.sel, type: f.type };
    }

    // Fallback: no room-*-guest-* inputs at all. Match on what the page tells a
    // human — its labels, placeholders and aria-labels — and call it guest 0.
    if (!guests.length) {
      shapeSource = "labels";
      const g0 = slotFor(0, 0);
      for (const el of all) {
        const t = (el.type || el.tagName || "").toLowerCase();
        if (["hidden", "checkbox", "radio", "submit", "button"].includes(t)) continue;
        const sel = selFor(el);
        if (!sel) continue;
        const d = describe(el);
        const key = /first\s*name|given\s*name/.test(d)
          ? "firstname"
          : /last\s*name|surname|family\s*name/.test(d)
          ? "lastname"
          : /\btitle\b|salutation/.test(d)
          ? "title"
          : /country|nationality/.test(d)
          ? "country"
          : "";
        if (!key || g0.fields[key]) continue;
        g0.fields[key] = { name: el.name || "", sel, type: t };
      }
      if (!Object.keys(g0.fields).length) guests.length = 0;
    }
    guests.sort((a, b) => a.room - b.room || a.index - b.index);

    // Phone: room-<r>-phone by convention, but accept a type="tel" box or one
    // the page labels "Guest Contact Mobile Number" for providers that differ.
    // Deliberately narrow — typing a phone number into the wrong box is worse
    // than leaving an optional field blank.
    const phones = [];
    for (const el of all) {
      const t = (el.type || el.tagName || "").toLowerCase();
      if (!["tel", "text", "number"].includes(t)) continue;
      const nm = el.name || "";
      const d = describe(el);
      const looksPhone =
        /^room-\d+-(phone|mobile|tel|contact)/i.test(nm) ||
        t === "tel" ||
        (/\b(phone|mobile|cell)\b|contact\s*(number|no)/.test(d) && !/e-?mail/.test(d));
      const sel = selFor(el);
      if (!looksPhone || !sel || phones.includes(sel)) continue;
      phones.push(sel);
    }

    // `total` is the whole reason we're on this page (§6b). Take the canonical
    // name first, then a same-meaning alias, so a rename doesn't stop the run.
    let total = valOf("total");
    if (!total) {
      const alt = fields.find((f) => /^(total|totalprice|grandtotal|totalamount|amount)$/i.test(f.name.replace(/[^a-z]/gi, "")) && f.value);
      if (alt) total = alt.value;
    }

    return {
      total,
      hotelId: valOf("hotelId"),
      provider: valOf("provider"),
      dateFrom: valOf("dateFrom"),
      dateTo: valOf("dateTo"),
      cancellationDeadline: valOf("cancellationDeadline"),
      roomRateCode: valOf("roomRateCode"),
      adults: valOf("room-0-adults"),
      children: valOf("room-0-children"),
      guests,
      phones,
      shapeSource,
      hasAccept: !!byName("accept"),
      // Diagnostics only — makes the next provider surprise a five-second read
      // of the error message instead of another live debugging session.
      allNames: fields.map((f) => f.name || f.sel).filter(Boolean),
    };
  });
}

/**
 * Fill the guest block. `guests` is [{ firstName, lastName, title, country, phone }].
 * Extra guest slots on the form beyond the supplied list are filled by repeating
 * the lead guest's SURNAME with a numbered first name only if `padGuests` is set —
 * otherwise we fail loudly, because a silently-wrong guest name is worse than a
 * stopped run.
 */
async function fillGuests(page, shape, guests, { padGuests = false, defaultCountry = "AU", phone = "" } = {}) {
  if (!guests || !guests.length) throw new Error("No guest names supplied for the Room-Res booking form.");
  if (!shape.guests.length) {
    throw new Error(
      "Couldn't find any guest name fields on the Room-Res booking form. " +
        `Fields present: ${(shape.allNames || []).slice(0, 25).join(", ") || "none"}.`
    );
  }
  const filled = [];
  const mustHaveValue = [];

  for (let i = 0; i < shape.guests.length; i++) {
    const slot = shape.guests[i];
    let g = guests[i];
    if (!g) {
      if (!padGuests) {
        throw new Error(
          `The rate needs ${shape.guests.length} guest name(s) but only ${guests.length} were supplied. ` +
            `Add the missing name(s) or search for ${guests.length} adult(s).`
        );
      }
      g = { firstName: `Guest${i + 1}`, lastName: guests[0].lastName };
    }
    const set = async (field, value) => {
      const f = slot.fields[field];
      if (!f || value == null || value === "") return;
      const sel = f.sel || `[name="${f.name}"]`;
      if (f.type === "select-one" || f.type === "select") await selectSet(page, sel, value);
      else { await reactSet(page, sel, value); mustHaveValue.push(sel); }
    };
    await set("title", g.title);
    await set("firstname", g.firstName);
    await set("lastname", g.lastName);
    await set("country", g.country || defaultCountry);
    filled.push({ room: slot.room, index: slot.index, name: `${g.firstName || ""} ${g.lastName || ""}`.trim() });
  }

  const tel = phone || (guests[0] && guests[0].phone) || "";
  if (tel) for (const p of shape.phones) await reactSet(page, p, tel);

  // Read the names back. A React form can quietly discard a programmatic value,
  // and an empty name box means Proceed bounces on a validation error we would
  // then have to reverse-engineer from a screenshot. Fail here instead, loudly.
  const empty = await page.evaluate((sels) => {
    return sels.filter((s) => {
      const el = document.querySelector(s);
      return !el || !String(el.value || "").trim();
    });
  }, mustHaveValue);
  if (empty.length) {
    throw new Error(
      `Typed the guest details but ${empty.length} field(s) came back empty (${empty.join(", ")}). ` +
        "The booking form may have re-rendered — worth re-running."
    );
  }

  return filled;
}

/**
 * Read the /book form's own validation complaints.
 *
 * The form validates in its OWN JavaScript, not with HTML constraints: provider
 * 19's "Guest Contact Mobile Number" carries no `required` attribute at all
 * (verified live), so there is nothing to pre-flight — the only honest signal
 * that Proceed was refused is the message the page paints next to the offending
 * box. Also reports empty phone boxes, since that is the one we keep hitting.
 */
async function readBookFormErrors(page) {
  return await page.evaluate(() => {
    const messages = [];
    for (const n of Array.from(document.querySelectorAll("div,span,p,label,small"))) {
      const s = (n.innerText || "").trim();
      if (!s || s.length > 90 || s.includes("\n")) continue;
      if (!/required|invalid|must be|please (enter|provide|select)/i.test(s)) continue;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) continue; // not actually on screen
      if (!messages.includes(s)) messages.push(s);
    }
    const emptyPhones = Array.from(document.querySelectorAll("input"))
      .filter((el) => /phone|mobile|tel/i.test(el.name || "") && !String(el.value || "").trim())
      .map((el) => el.name);
    return { messages, emptyPhones };
  });
}

/* ── step 4: itinerary page ─────────────────────────────────────────────── */

/**
 * Parse the draft-itinerary page text (§7). The page is server-rendered with no
 * __NEXT_DATA__ and no JSON API, but the text is completely regular, so anchored
 * regexes are reliable.
 */
function parseItineraryText(text) {
  const t = String(text || "");
  const out = {
    itineraryCode: "",
    customerName: "",
    status: "",
    checkIn: "",
    checkOut: "",
    hotelName: "",
    city: "",
    address: "",
    rooms: 1,
    guestCount: 0,
    roomTypes: [],
    guestNames: [],
    boardType: "",
    nightlyRates: [],
    totalPrice: null,
    currency: "AUD",
    cancellationDeadline: "",
    raw: t,
  };

  const hdr = t.match(/(?:Draft\s+)?Itinerary\s*-\s*([A-Z0-9]+)\s+for\s+(.+?)\s*(?:-\s*(.+?))?$/m);
  if (hdr) {
    out.itineraryCode = hdr[1].trim();
    out.customerName = (hdr[2] || "").trim();
    out.status = (hdr[3] || "").trim();
  }

  const dates = t.match(/(\d{1,2}-[A-Za-z]{3}-\d{4})\s*-\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/);
  if (dates) {
    out.checkIn = roomResDateToIso(dates[1]);
    out.checkOut = roomResDateToIso(dates[2]);
  }

  const lines = t.split("\n").map((s) => s.trim());

  // Lines in the hotel block that are page furniture, not content. Room-Res
  // added several of these (Delete this Hotel / Hotel Notes / the Duplicator)
  // after the original mapping, and they sit right where the name and address
  // are read from (§7a).
  const isRoomsLine = (l) => /^\d+\s*Rooms?\s*,\s*\d+\s*Guests?/i.test(l);
  const isRating = (l) => /^\d+(\.\d+)?\/5$/.test(l);
  const isFurniture = (l) =>
    /^(delete this hotel|add transfer|add another|refresh all rates|change itinerary code|create template|create customer quote|the duplicator|click here|hotel notes|room details|price details|cancellation policy)/i.test(
      l
    );

  // Hotel + city sits on the line right after the date range (§7).
  if (dates) {
    const di = lines.findIndex((l) => l.includes(dates[1]) && l.includes(dates[2]));
    for (let i = di + 1; i < Math.min(lines.length, di + 6); i++) {
      const l = lines[i];
      // Skip only what we can NAME. The old rule was "skip anything starting
      // with a digit" — aimed at "1 Room, 2 Guests", but it also discarded every
      // hotel whose name begins with a number ("83 OSHR, Bondi Junction"), and
      // then latched onto the "Delete this Hotel from Itinerary" link below it.
      if (!l || isRoomsLine(l) || isRating(l) || isFurniture(l)) continue;
      const parts = l.split(",").map((s) => s.trim());
      if (parts.length >= 2) {
        out.hotelName = parts.slice(0, -1).join(", ");
        out.city = parts[parts.length - 1];
      } else {
        out.hotelName = l;
      }
      break;
    }
  }

  const rg = t.match(/(\d+)\s*Rooms?,\s*(\d+)\s*Guests?/i);
  if (rg) {
    out.rooms = parseInt(rg[1], 10);
    out.guestCount = parseInt(rg[2], 10);
  }

  // Address = the last real line before "Room Details" — walking back past the
  // rating and any furniture ("Hotel Notes" now sits between them).
  const rdIdx = lines.findIndex((l) => /^Room Details$/i.test(l));
  if (rdIdx > 0) {
    for (let i = rdIdx - 1; i >= 0 && i >= rdIdx - 5; i--) {
      if (!lines[i] || isRating(lines[i]) || isFurniture(lines[i])) continue;
      out.address = lines[i].replace(/\s+,/g, ",");
      break;
    }
  }

  for (const m of t.matchAll(/^Room\s+(\d+):\s*(.+)$/gm)) out.roomTypes.push(m[2].trim());
  for (const m of t.matchAll(/^Guest\s+(\d+):\s*(.+)$/gm)) out.guestNames.push(m[2].trim());

  const board = t.match(/^Board Type:\s*(.+)$/m);
  if (board) out.boardType = board[1].trim();

  for (const m of t.matchAll(/^([A-Z][a-z]+day,\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4})\s*\$?([\d,]+\.\d{2})/gm)) {
    out.nightlyRates.push({ date: m[1], amount: money(m[2]) });
  }

  const total = t.match(/Total Price:\s*\$?\s*([\d,]+(?:\.\d{2})?)\s*([A-Z]{3})?/i);
  if (total) {
    out.totalPrice = money(total[1]);
    if (total[2]) out.currency = total[2];
  }

  const cxl = t.match(/FREE Cancellation until\s*([^\n]+)/i);
  if (cxl) out.cancellationDeadline = cxl[1].trim();

  out.nights = nightsBetween(out.checkIn, out.checkOut);
  return out;
}

async function readItineraryPage(page, itineraryId) {
  await page.goto(`${ROOMRES_BASE_URL}/account/itinerary?id=${encodeURIComponent(itineraryId)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  const text = await waitForText(page, /Itinerary\s*-\s*[A-Z0-9]+\s+for\s/i, { timeout: 45000, label: "the draft itinerary header" });
  const parsed = parseItineraryText(text);
  parsed.itineraryId = String(itineraryId);
  parsed.itineraryUrl = page.url();
  return parsed;
}

/* ── step 5: quote builder + read-back ──────────────────────────────────── */

async function readQuotesTable(page) {
  await page.goto(`${ROOMRES_BASE_URL}/account/customerquotes`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await waitForText(page, /Quote\s*Number|Itinerary\s*Code/i, { timeout: 45000, label: "the quotes table" });
  return await page.evaluate(() => {
    const table = document.querySelector("table");
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    const txt = (el) => (el && el.textContent ? el.textContent.trim() : "");
    return rows
      .map((tr) => {
        const td = tr.querySelectorAll("td");
        if (td.length < 7) return null;
        const openUrl = tr.querySelector('a[href*="CustomerQuote"]');
        return {
          itineraryCode: txt(td[0]),
          customerName: txt(td[1]),
          agentName: txt(td[2]),
          quoteName: txt(td[3]),
          quoteNumber: txt(td[4]),
          totalCostPrice: txt(td[5]),
          totalPriceQuoted: txt(td[6]),
          publicUrl: openUrl ? openUrl.href : "",
        };
      })
      .filter(Boolean);
  });
}

/**
 * Build + generate the customer quote for an existing draft itinerary.
 * `quotedPrice` is REQUIRED — see trap 2 in the header comment.
 */
async function buildQuote(page, itineraryId, opts) {
  const { quotedPrice, title, packageLines, personalMessage, showCustomerName = true } = opts;

  await page.goto(`${ROOMRES_BASE_URL}/account/customerQuoteStep1?id=${encodeURIComponent(itineraryId)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  // We now hold this tab across the sell-price question, which a human can take
  // any amount of time over — so an expired session is a real outcome here, and
  // it deserves better than "timed out waiting for the quote builder".
  try {
    await waitForText(page, /Build a Beautiful Customer Quote Webpage/i, { timeout: 45000, label: "the quote builder" });
  } catch (err) {
    const signedOut = await page.locator('input[type="password"]:visible').count().catch(() => 0);
    if (signedOut) {
      throw new Error(
        "The Room-Res session expired while I was waiting for the sell price. " +
          "Sign in again in the shared Chrome window and send me the price once more — the draft itinerary is untouched."
      );
    }
    throw err;
  }

  // ⚠️ ORDERING — #guestTotalPrice is display:none while show_total_price is
  // "no", which is its default (§8a trap 1). waitForSelector defaults to
  // state:"visible", and a display:none box can never satisfy that, so waiting
  // for the price field BEFORE revealing it hung for the full 30s and killed
  // every run right here — the draft existed, the quote never did. Same trap as
  // the hidden inputs on /book (§6b). Wait for ATTACHED, reveal, then wait for
  // visible.
  await page.waitForSelector("#guestTotalPrice", { state: "attached", timeout: 30000 });

  // ⚠️ TRAP 1 — defaults to "no", which produces a quote with no price at all,
  // and also keeps the price box hidden. Must happen before we can type in it.
  const shownPrice = await setRadio(page, "#show_total_price_yes");
  if (!shownPrice) {
    throw new Error(
      'Could not tick "show total price" (#show_total_price_yes) on the quote builder — refusing to generate a quote with no price.'
    );
  }
  await page.waitForSelector("#guestTotalPrice", { state: "visible", timeout: 15000 }).catch(() => {});

  // The builder prints our net cost as label text — grab it as a cross-check
  // against what /book told us (§8a). Read it AFTER the reveal: the label sits
  // beside the price box and is part of the same hidden block.
  const pageText = await page.evaluate(() => document.body.innerText || "");
  const agentPriceLabel = (pageText.match(/total agent price for this itinerary is\s*\$?\s*([\d,]+(?:\.\d{2})?)/i) || [])[1];

  // NOTE the site's own typo in this id: addTitieText, not addTitleText (§8).
  if (title) await reactSet(page, "#addTitieText", title);
  if (packageLines && packageLines.length) {
    if (packageLines[0]) await reactSet(page, "#packageDescription", packageLines[0]);
    if (packageLines[1]) await reactSet(page, "#packageDescription2", packageLines[1]);
    if (packageLines[2]) await reactSet(page, "#packageDescription3", packageLines[2]);
  }
  if (personalMessage) {
    await reactSet(page, "#personalMessageText", personalMessage);
    await setRadio(page, "#personalMessage_yes");
  }
  if (showCustomerName) await setRadio(page, "#show_customer_name_yes");
  await sleep(300);

  // ⚠️ TRAP 2 — pre-filled with OUR NET COST. Always overwrite.
  const priceNum = money(quotedPrice);
  if (priceNum == null || priceNum <= 0) throw new Error(`Invalid quoted price "${quotedPrice}".`);
  await reactSet(page, "#guestTotalPrice", priceNum.toFixed(2));
  await sleep(200);

  const readBack = await page.evaluate(() => {
    const el = document.querySelector("#guestTotalPrice");
    return el ? el.value : "";
  });
  if (money(readBack) == null || Math.abs(money(readBack) - priceNum) > 0.005) {
    throw new Error(`Quoted price didn't stick on the form (wanted ${priceNum.toFixed(2)}, field reads "${readBack}").`);
  }

  // Generate Quote does NOT navigate — the result is appended below (§8c).
  // There are two identical buttons (top and bottom); either does the job. Match
  // on the element's OWN text, not innerText inherited from a wrapper div — the
  // builder wraps each button in a full-width div carrying the same string, and
  // widening the selector list to divs would hand back the wrapper instead.
  const clicked = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll("button,input[type=submit],input[type=button],a")).filter(
      (x) => /generate\s*quote/i.test((x.innerText || x.value || "").trim()) && !x.disabled
    );
    if (!cands.length) return false;
    const b = cands[0];
    b.scrollIntoView({ block: "center" });
    b.click();
    return true;
  });
  if (!clicked) throw new Error('Could not find an enabled "Generate Quote" button on the quote builder.');

  try {
    await waitForText(page, /Quote URL:/i, { timeout: 60000, label: "the generated Quote URL" });
  } catch (err) {
    // Don't report a bare timeout: the builder validates in its own JS and paints
    // the reason on the page, exactly like /book does (§6c). Quote it.
    const said = await readBookFormErrors(page).catch(() => null);
    const msgs = said && said.messages.length ? ` The page said: "${said.messages.join(" ")}"` : "";
    throw new Error(
      `Clicked "Generate Quote" but no Quote URL came back within 60s.${msgs} ` +
        `Check ${ROOMRES_BASE_URL}/account/customerquotes — the quote may have been created anyway.`
    );
  }

  const publicUrl = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll("a")).find((x) => /\/CustomerQuote\//i.test(x.href || ""));
    if (a) return a.href;
    const m = (document.body.innerText || "").match(/Quote URL:\s*(\S+)/i);
    return m ? m[1] : "";
  });

  return {
    itineraryId: String(itineraryId),
    quotedPrice: priceNum,
    agentPriceLabel: money(agentPriceLabel),
    publicUrl,
    builderUrl: page.url(),
  };
}

/* ── public API ─────────────────────────────────────────────────────────── */

/**
 * PHASE 1 — search, pick a hotel + rate, fill guests, Proceed, read the draft.
 * Returns everything the chat needs to show the cost and ask for a sell price.
 * Nothing is held or paid: a draft itinerary is just a cart.
 *
 * @param {object}   o
 * @param {string}   o.destination      e.g. "Sydney, NSW, AU" (autocompleted)
 * @param {string}   o.dateFrom         ISO or dd-Mon-yyyy
 * @param {string}   o.dateTo
 * @param {number}   o.adults           default 2
 * @param {number}   o.children         default 0
 * @param {string}   o.rateTrack        "net" (RAA Net Rates) | "online"  — asked per run
 * @param {string}   [o.hotelName]      explicit hotel; omitted → cheapest
 * @param {string}   [o.roomPreference]
 * @param {string}   [o.boardPreference]
 * @param {boolean}  [o.refundableOnly]
 * @param {Array}    o.guests           [{ firstName, lastName, title?, country?, phone? }]
 * @param {boolean}  [o.padGuests]      allow filling surplus guest slots (default false)
 */
async function runRoomResDraft(o = {}) {
  const cb = o.callbacks || {};
  const onProgress = cb.onProgress || (() => {});
  const onStage = cb.onStage || (() => {});
  const onError = cb.onError || (() => {});

  const rateTrack = (o.rateTrack || "net").toLowerCase() === "online" ? "online" : "net";
  if (!o.destination) throw new Error("destination is required (e.g. \"Sydney, NSW, AU\").");
  if (!o.dateFrom || !o.dateTo) throw new Error("dateFrom and dateTo are required.");
  if (!o.guests || !o.guests.length) throw new Error("At least one guest name is required.");

  try {
    // keepOpen: the very next thing that happens is the chat asking a human for
    // a sell price, and the answer comes back to runRoomResQuote — which wants
    // this exact tab, still signed in, still on the itinerary.
    return await withRoomResPage({ callbacks: cb, keepOpen: true }, async (page) => {
      // 1) Search. Use the cached destination id when we have one (§3a).
      const cached = _destCache.get(String(o.destination).trim().toLowerCase());
      let searchUrl;
      if (cached && cached.destinationId) {
        searchUrl = buildSearchUrl({
          destination: cached.destination || o.destination,
          destinationId: cached.destinationId,
          dateFrom: o.dateFrom,
          dateTo: o.dateTo,
          adults: o.adults || 2,
          children: o.children || 0,
          rooms: o.rooms || 1,
        });
        onProgress(12, `Searching ${cached.destination || o.destination}...`);
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      } else {
        const s = await searchViaForm(page, { ...o, adults: o.adults || 2 }, onProgress);
        searchUrl = s.url;
      }

      onProgress(22, "Reading search results...");
      // Results take 5-8s to populate (§13) — poll for cards rather than sleeping.
      let cards = [];
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        cards = await scrapeSearchResults(page);
        if (cards.length) break;
        await sleep(1000);
      }
      if (!cards.length) throw new Error(`No hotels came back for ${o.destination} on those dates.`);

      const { hotel, reason, alternatives } = chooseHotel(cards, {
        hotelName: o.hotelName,
        rateTrack,
        // A named hotel is the agent's decision and overrides the floor; only an
        // unnamed "cheapest" is filtered.
        minStars: o.hotelName ? 0 : o.minStars != null ? o.minStars : DEFAULT_MIN_STARS,
      });
      if (!hotel) {
        const err = new Error(
          `${reason}. Available: ${(alternatives || []).slice(0, 8).join(", ") || "none"}.`
        );
        err.hotelNotFound = { wanted: o.hotelName, alternatives: alternatives || [] };
        throw err;
      }
      if (o.hotelName && !hotel.hasTrack) {
        onProgress(24, `Note: "${hotel.hotelName}" has no ${rateTrack === "net" ? "RAA Net" : "Online"} rate link — using the rate link it does have.`);
      }
      onStage("hotelChosen", { hotelName: hotel.hotelName, reason, fromPrice: hotel.fromPrice, alternatives, rateTrack });
      onProgress(30, `Opening ${hotel.hotelName} (${reason})...`);

      // 2) Hotel page. Wait for the RATE LIST specifically — the header renders
      //    several seconds before the rates do (§13).
      await followHref(page, hotel.chosenLink.href, {
        waitFor: { pattern: /BOOK THIS ROOM/i, timeout: 60000, label: "the rate list" },
      });
      const rows = await scrapeRateRows(page);
      if (!rows.length) throw new Error(`No bookable rates on ${hotel.hotelName} for those dates.`);

      const { rate, reason: rateReason } = chooseRate(rows, {
        roomPreference: o.roomPreference,
        boardPreference: o.boardPreference,
        refundableOnly: o.refundableOnly,
      });
      onStage("rateChosen", { roomName: rate.roomName, board: rate.board, refundable: rate.refundable, reason: rateReason, displayPrice: rate.displayPrice });
      onProgress(42, `Selected "${rate.roomName}" (${rateReason})...`);

      // 3) Book form. NEVER construct this URL — roomRateCode encoding is
      //    provider-specific (§6a); we follow the row's real link.
      await followHref(page, rate.href, { waitFor: { pattern: /Proceed|Guest|First\s*Name/i, timeout: 60000, label: "the booking form" } });
      // state:"attached" is not optional here. `total` and `roomRateCode` are
      // HIDDEN inputs (§6b), and waitForSelector defaults to state:"visible" —
      // which a hidden input can never satisfy, so the default spent 30s finding
      // the fields it was looking at and then timing out on them anyway.
      await page.waitForSelector('input[name="total"], input[name="roomRateCode"]', {
        state: "attached",
        timeout: 30000,
      });

      const shape = await readBookFormShape(page);
      const netCost = money(shape.total);
      if (netCost == null) {
        throw new Error(
          "Could not read the net total from the Room-Res booking form. " +
            `Fields present: ${(shape.allNames || []).slice(0, 25).join(", ") || "none"}.`
        );
      }
      onStage("bookForm", {
        provider: shape.provider,
        hotelId: shape.hotelId,
        netCost,
        guestSlots: shape.guests.length,
        shapeSource: shape.shapeSource,
        fields: shape.guests.map((g) => Object.keys(g.fields)),
      });
      onProgress(52, `Net cost is $${netCost.toFixed(2)} — filling guest details...`);

      // Some providers (19 seen live) REQUIRE a guest contact number. It is the
      // TRAVELLER's own, read off the Tramada passenger record by the caller —
      // never invented here, because this form reaches a real hotel. Its absence
      // is reported below rather than papered over.
      const contactPhone = o.phone;
      const filled = await fillGuests(page, shape, o.guests, {
        padGuests: !!o.padGuests,
        defaultCountry: o.country || "AU",
        phone: contactPhone,
      });

      // "accept" is pre-ticked (§6b); only tick it if this provider ships it off.
      await page.evaluate(() => {
        const el = document.querySelector('[name="accept"]');
        if (el && el.type === "checkbox" && !el.checked) el.click();
      });

      onProgress(62, "Creating the draft itinerary...");
      const beforeUrl = page.url();
      const proceeded = await page.evaluate(() => {
        const b = Array.from(document.querySelectorAll("button,input[type=submit],a")).find((x) =>
          /^\s*proceed\s*$/i.test((x.innerText || x.value || "").trim())
        );
        if (!b) return false;
        b.scrollIntoView({ block: "center" });
        b.click();
        return true;
      });
      if (!proceeded) throw new Error('Could not find the "Proceed" button on the Room-Res booking form.');

      // Proceed either redirects to /account/itinerary?id=<newId> (client-side,
      // no interstitial — §7) or the form's own JS refuses and paints a message.
      // Race the two: waiting out the full navigation timeout and *then* saying
      // "check for validation errors" wasted 90s on a page that already said
      // exactly what was wrong (§6c).
      const landed = (u) => /\/account\/itinerary\?id=\d+/.test(String(u));
      let problem = null;
      const proceedDeadline = Date.now() + 90000;
      while (Date.now() < proceedDeadline && !landed(page.url())) {
        const errs = await readBookFormErrors(page).catch(() => null);
        if (errs && errs.messages.length) {
          // Confirm it's a real refusal and not a message mid-navigation.
          await sleep(1500);
          if (!landed(page.url())) { problem = errs; break; }
        }
        await sleep(500);
      }

      if (!landed(page.url())) {
        const said = problem && problem.messages.length ? ` It said: "${problem.messages.join(" ")}"` : "";
        const needsPhone = problem && problem.emptyPhones.length && !contactPhone;
        throw new Error(
          `Room-Res refused the booking form (still at ${page.url() === beforeUrl ? "the booking form" : page.url()}).${said}` +
            (needsPhone
              ? ` This provider (${shape.provider || "?"}) requires a guest contact mobile and the traveller has none on file — ` +
                `add a Mobile No to the passenger record in Tramada, then re-run.`
              : "")
        );
      }
      const itineraryId = new URL(page.url()).searchParams.get("id");

      onProgress(80, "Reading the draft itinerary...");
      const itin = await readItineraryPage(page, itineraryId);

      // Cross-check: the itinerary total must agree with the /book total. A
      // mismatch means the rate moved under us — surface it, don't paper over it.
      if (itin.totalPrice != null && Math.abs(itin.totalPrice - netCost) > 0.02) {
        onProgress(82, `⚠️ Itinerary total $${itin.totalPrice.toFixed(2)} differs from the booking-form total $${netCost.toFixed(2)} — using the itinerary figure.`);
      }
      const cost = itin.totalPrice != null ? itin.totalPrice : netCost;

      const draft = {
        itineraryId: String(itineraryId),
        itineraryCode: itin.itineraryCode,
        itineraryUrl: itin.itineraryUrl,
        status: itin.status,
        rateTrack,
        provider: shape.provider,
        hotelId: shape.hotelId,
        hotelName: itin.hotelName || hotel.hotelName,
        city: itin.city,
        // The city the AGENT searched, kept alongside the suburb the itinerary
        // reports. Room-Res says "Haymarket" or "Bondi Junction" where Tramada
        // wants "Sydney", and only this field knows which city was meant.
        searchedDestination: o.destination || "",
        address: itin.address,
        checkIn: itin.checkIn,
        checkOut: itin.checkOut,
        nights: itin.nights,
        rooms: itin.rooms,
        guestCount: itin.guestCount,
        roomType: itin.roomTypes[0] || rate.roomName,
        roomTypes: itin.roomTypes,
        boardType: itin.boardType || rate.board,
        refundable: rate.refundable,
        cancellationDeadline: itin.cancellationDeadline,
        guestNames: itin.guestNames.length ? itin.guestNames : filled.map((f) => f.name),
        nightlyRates: itin.nightlyRates,
        netCost: cost,
        currency: itin.currency || "AUD",
        searchUrl,
        selection: { hotelReason: reason, rateReason, alternatives },
      };
      onStage("draft", draft);
      onProgress(100, `Draft itinerary ${draft.itineraryCode} created — net cost $${cost.toFixed(2)}.`);
      return draft;
    });
  } catch (err) {
    onError(err.message);
    throw err;
  }
}

/**
 * PHASE 2 — generate the customer quote off an existing draft itinerary.
 * `quotedPrice` is what the customer sees; the margin is quotedPrice - netCost.
 */
async function runRoomResQuote(o = {}) {
  const cb = o.callbacks || {};
  const onProgress = cb.onProgress || (() => {});
  const onStage = cb.onStage || (() => {});
  const onError = cb.onError || (() => {});

  const itineraryId = o.itineraryId;
  if (!itineraryId) throw new Error("itineraryId is required.");
  const priceNum = money(o.quotedPrice);
  if (priceNum == null || priceNum <= 0) throw new Error("A quoted price is required (cost + margin).");

  try {
    // keepOpen again: the generated Quote URL is the one thing the agent most
    // wants to look at, and the flow moves on to Tramada next. server.js drops
    // the tab via closeRoomResPage() when the conversation actually finishes.
    return await withRoomResPage({ callbacks: cb, keepOpen: true }, async (page) => {
      onProgress(15, "Opening the quote builder...");
      const built = await buildQuote(page, itineraryId, {
        quotedPrice: priceNum,
        title: o.title,
        packageLines: o.packageLines,
        personalMessage: o.personalMessage,
        showCustomerName: o.showCustomerName !== false,
      });
      onStage("quoteGenerated", built);
      onProgress(70, "Reading the quote number back...");

      // The quote number only exists in the quotes list (§8c/§9a). Match on the
      // itinerary code — never trust row order.
      const code = o.itineraryCode || (await (async () => {
        const itin = await readItineraryPage(page, itineraryId);
        return itin.itineraryCode;
      })());

      let row = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const rows = await readQuotesTable(page);
        row = rows.find((r) => r.itineraryCode && code && r.itineraryCode.toUpperCase() === String(code).toUpperCase());
        if (row) break;
        await sleep(2500);
      }

      const quote = {
        itineraryId: String(itineraryId),
        itineraryCode: code || "",
        quoteNumber: row ? row.quoteNumber : "",
        quoteName: row ? row.quoteName : o.title || "",
        customerName: row ? row.customerName : "",
        totalCostPrice: row ? money(row.totalCostPrice) : built.agentPriceLabel,
        totalPriceQuoted: row ? money(row.totalPriceQuoted) : priceNum,
        quotedPrice: priceNum,
        publicUrl: built.publicUrl || (row ? row.publicUrl : ""),
        builderUrl: built.builderUrl,
        quotesListUrl: `${ROOMRES_BASE_URL}/account/customerquotes`,
      };
      if (quote.totalCostPrice != null) quote.margin = +(quote.totalPriceQuoted - quote.totalCostPrice).toFixed(2);
      if (!quote.quoteNumber) {
        onProgress(95, `⚠️ Quote generated but its number hasn't appeared in the quotes list yet — check ${quote.quotesListUrl}.`);
      }
      onStage("quote", quote);
      onProgress(100, quote.quoteNumber ? `Quote ${quote.quoteNumber} created.` : "Quote created.");
      return quote;
    });
  } catch (err) {
    onError(err.message);
    throw err;
  }
}

/** Convenience: both phases in one call, for when the sell price is known upfront. */
async function runRoomResFullQuote(o = {}) {
  const draft = await runRoomResDraft(o);
  const quote = await runRoomResQuote({
    itineraryId: draft.itineraryId,
    itineraryCode: draft.itineraryCode,
    quotedPrice: o.quotedPrice,
    title: o.title,
    packageLines: o.packageLines,
    personalMessage: o.personalMessage,
    callbacks: o.callbacks,
  });
  return { draft, quote };
}

/** Search only — hotel candidates for a destination/date range, nothing created. */
async function searchRoomResHotels(o = {}) {
  const cb = o.callbacks || {};
  return await withRoomResPage({ callbacks: cb }, async (page) => {
    const cached = _destCache.get(String(o.destination || "").trim().toLowerCase());
    if (cached && cached.destinationId) {
      await page.goto(
        buildSearchUrl({
          destination: cached.destination || o.destination,
          destinationId: cached.destinationId,
          dateFrom: o.dateFrom,
          dateTo: o.dateTo,
          adults: o.adults || 2,
          children: o.children || 0,
          rooms: o.rooms || 1,
        }),
        { waitUntil: "domcontentloaded", timeout: 60000 }
      );
    } else {
      await searchViaForm(page, { ...o, adults: o.adults || 2 }, cb.onProgress || (() => {}));
    }
    let cards = [];
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      cards = await scrapeSearchResults(page);
      if (cards.length) break;
      await sleep(1000);
    }
    const track = (o.rateTrack || "net").toLowerCase() === "online" ? "online" : "net";
    return cards.map((c) => ({
      hotelName: c.hotelName,
      fromPrice: c.fromPrice,
      stars: c.stars,
      hasNetRate: c.links.some((l) => l.track === "net"),
      hasOnlineRate: c.links.some((l) => l.track === "online"),
      href: (c.links.find((l) => l.track === track) || c.links[0]).href,
    }));
  });
}

/* ── Tramada bridge ─────────────────────────────────────────────────────── */

/**
 * Tramada client strings are "SURNAME/FIRSTNAME MR" — split one into the guest
 * shape the Room-Res book form wants. This is how guest names come across when
 * an existing Tramada booking was supplied (agreed behaviour: reuse the client's
 * name, only ask in chat when there isn't one).
 */
function tramadaClientToGuest(clientString) {
  const raw = String(clientString || "").trim();
  if (!raw) return null;
  const titleM = raw.match(/\b(MR|MRS|MS|MISS|DR|MSTR|MASTER|PROF)\b/i);
  const title = titleM ? titleM[1][0].toUpperCase() + titleM[1].slice(1).toLowerCase() : "";
  const cleaned = raw.replace(/\b(MR|MRS|MS|MISS|DR|MSTR|MASTER|PROF)\b/gi, "").trim();
  const titleCase = (s) => String(s || "").trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  if (cleaned.includes("/")) {
    const [last, first] = cleaned.split("/").map((s) => s.trim());
    return { firstName: titleCase(first), lastName: titleCase(last), title };
  }
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: titleCase(parts[0] || ""), lastName: "", title };
  return { firstName: titleCase(parts[0]), lastName: titleCase(parts.slice(1).join(" ")), title };
}

/**
 * Map a Room-Res draft + quote onto the `seg` object addHotelSegment() consumes.
 *
 * Agreed conventions baked in here:
 *   • confirmationNumber = "Q422380 / AQ788851" — both references in one field.
 *   • creditor           = the REAL HOTEL, not a blanket Room-Res creditor. The
 *     caller resolves it (alias cache → Tramada match); leaving it null makes
 *     addHotelSegment throw needsCreditor, which is the existing stop-and-ask.
 *   • rate               = the SELL price (what the client pays) by default, so
 *     the segment is receiptable for the quoted amount. Pass rateBasis:"cost"
 *     to book it at our net cost instead. Both figures are returned either way.
 *
 * `confirmationNumber` is consumed by addHotelSegment via setConfirmationRef(),
 * which PROBES the form for whichever confirmation/reference input it actually
 * has (the hotel form's id couldn't be read without a signed-in browser, so it
 * is discovered at runtime and reported back as `confirmationField`).
 *
 * ⚠️ Still needs a live check on the Tramada hotel-segment form: if it has
 *    SEPARATE cost and sell fields, the cost side should be populated from
 *    `cost` rather than leaving the margin implicit. Both figures are on this
 *    object either way, so wiring that up is a one-line change once confirmed.
 */
/**
 * Candidates for Tramada's City Code, best first.
 *
 * Room-Res reports the SUBURB on the itinerary — "Haymarket" for a hotel in
 * Sydney, "Bondi Junction" for one in Sydney's east — and Tramada's city
 * autocomplete knows neither. The city the agent typed into the search IS the
 * city, so it leads. The address is mined last: Room-Res writes it as
 * "83 Old South Head Rd, Bondi Junction, New South Wales, AU", so the parts
 * between the street and the country are worth a try before giving up.
 */
function cityCandidatesFor(draft, explicit) {
  const out = [];
  const add = (v) => {
    const s = String(v || "").trim();
    // "Sydney, NSW, AU" → the widget wants just the city.
    const head = s.split(",")[0].trim();
    if (head && head.length > 1 && !out.some((x) => x.toLowerCase() === head.toLowerCase())) out.push(head);
  };

  add(explicit);
  add(draft.searchedDestination);
  add(draft.city);

  const parts = String(draft.address || "").split(",").map((s) => s.trim()).filter(Boolean);
  // Drop the street (first) and the country code (last); what's left is
  // suburb / state, in that order.
  for (const p of parts.slice(1, -1)) add(p);

  return out;
}

function quoteToTramadaHotelSegment(draft, quote, opts = {}) {
  const cost = draft && draft.netCost != null ? +Number(draft.netCost).toFixed(2) : null;
  const sell = quote && quote.quotedPrice != null ? +Number(quote.quotedPrice).toFixed(2) : cost;
  const basis = (opts.rateBasis || "sell").toLowerCase();
  const rate = basis === "cost" ? cost : sell;

  const refParts = [quote && quote.quoteNumber, draft && draft.itineraryCode].filter(Boolean);

  return {
    kind: "hotel",
    // Identity
    hotelName: draft.hotelName,
    hotelNameFreeForm: draft.hotelName,
    supplierName: draft.hotelName,
    // Try the real hotel as a listed Tramada supplier; addHotelSegment falls back
    // to the free-form name field when it isn't one.
    hotelSupplier: opts.hotelSupplier || draft.hotelName,
    city: draft.city,
    cityCode: opts.cityCode || draft.city,
    // Ordered best-guess list for Tramada's City Code autocomplete, which is a
    // hard requirement on the segment. The searched destination comes FIRST:
    // draft.city is the SUBURB Room-Res reports ("Haymarket"), and Tramada has
    // no such city, so leading with it left the field blank and the save was
    // rejected with "City Code is invalid".
    cityCandidates: cityCandidatesFor(draft, opts.cityCode),
    address: draft.address,
    // Stay
    checkInDate: draft.checkIn,
    checkOutDate: draft.checkOut,
    nights: draft.nights,
    rooms: draft.rooms || 1,
    durationType: "Nights",
    roomType: draft.roomType,
    roomTypeCode: opts.roomTypeCode,
    boardType: draft.boardType,
    status: opts.status || "HK",
    // Money
    rate,
    localRate: rate,
    cost,
    sell,
    margin: cost != null && sell != null ? +(sell - cost).toFixed(2) : null,
    currency: draft.currency || "AUD",
    // References (agreed format: "Q422380 / AQ788851")
    confirmationNumber: refParts.join(" / "),
    quoteNumber: quote && quote.quoteNumber,
    itineraryCode: draft.itineraryCode,
    quoteUrl: quote && quote.publicUrl,
    // Creditor — resolved by the caller; null triggers the stop-and-ask flow.
    creditor: opts.creditor || null,
    source: "room-res",
  };
}

/** One-line summary for the chat card. */
function describeDraft(draft) {
  const bits = [
    draft.hotelName,
    draft.city,
    `${draft.checkIn} → ${draft.checkOut}`,
    `${draft.nights} night${draft.nights === 1 ? "" : "s"}`,
    draft.roomType,
    draft.boardType,
    `${draft.rooms} room${draft.rooms === 1 ? "" : "s"}, ${draft.guestCount} guest${draft.guestCount === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return `${draft.itineraryCode}: ${bits.join(" · ")} — net cost $${Number(draft.netCost).toFixed(2)}`;
}

module.exports = {
  // two-phase flow (the one the chat uses)
  runRoomResDraft,
  runRoomResQuote,
  // Both phases keep their tab open so the run can span the sell-price question.
  // The caller releases it when the CONVERSATION ends — see server.js.
  closeRoomResPage,
  // convenience / testing
  runRoomResFullQuote,
  searchRoomResHotels,
  // Tramada bridge
  quoteToTramadaHotelSegment,
  cityCandidatesFor,
  tramadaClientToGuest,
  describeDraft,
  // exported for reuse / unit tests
  pickDestination,
  parseItineraryText,
  readBookFormShape,
  fillGuests,
  chooseHotel,
  chooseRate,
  buildSearchUrl,
  toRoomResDate,
  roomResDateToIso,
  nightsBetween,
};
