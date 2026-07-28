/**
 * tramada-booking.js — Playwright + CDP Tramada add+search for the chat flow.
 *
 * Connects to the shared CDP Chrome (start-chrome.sh on port 9222), so it
 * runs alongside the Jetstar tab. Programmatic login (no manual prompt).
 * Maps a Jetstar bookingData object to Tramada's Add Booking form fields,
 * saves the booking, then runs the existing "Booked" status search.
 *
 * Used by server.js after the Jetstar itinerary is captured.
 */

const { chromium } = require("playwright");

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";

// "internal" launches real Chrome directly (no remote-debugging port needed).
// "external" attaches to a Chrome already started with --remote-debugging-port,
// falling back to launching Chrome if that port isn't listening.
const CDP_MODE = process.env.CDP_MODE || "external";
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || "chrome";
const HEADLESS = process.env.HEADLESS === "true";

// Australian airport codes — used to auto-detect DOM vs INT.
// Mirrors the Aussie list in geminiPrompt.js / parsePdf.js.
const AU_AIRPORT_CODES = new Set([
  "SYD", "MEL", "BNE", "OOL", "PER", "ADL", "CNS", "HBA", "DRW",
  "CBR", "NTL", "MCY", "TSV", "LST", "AVV", "MKY", "HVB",
  "AYQ", "PPP", "BNK", "BQB",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// yyyy-mm-dd → dd-mm-yyyy (the format Tramada's date inputs expect)
function toTramadaDate(isoDate) {
  if (!isoDate) return "";
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : isoDate;
}

// Truncate a string to maxLen, appending an ellipsis when shortened.
function truncate(s, maxLen) {
  if (!s) return s;
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + "...";
}

// Format the chat-collected passenger list into a compact "Pax: ..." segment.
// Example: "Pax: John Smith, Jane Smith, Tim Smith (8)"
function formatPaxSegment(passengers) {
  if (!Array.isArray(passengers) || passengers.length === 0) return "";
  const parts = passengers
    .map((p) => {
      const name = `${(p.firstName || "").trim()} ${(p.lastName || "").trim()}`.trim();
      if (!name) return "";
      const ageNeeded = p.type === "child" || p.type === "infant";
      return ageNeeded && p.age != null ? `${name} (${p.age})` : name;
    })
    .filter(Boolean);
  return parts.length ? `Pax: ${parts.join(", ")}` : "";
}

// Map Jetstar bookingData to Tramada Add-Booking field shape.
function mapJetstarToTramada(booking, clientCode) {
  const origin = (booking.originCode || "").toUpperCase();
  const dest = (booking.destinationCode || "").toUpperCase();
  const isDomestic = AU_AIRPORT_CODES.has(origin) && AU_AIRPORT_CODES.has(dest);

  const baseSegments = [
    `${origin || "?"} → ${dest || "?"}`,
    booking.tripType === "return" && booking.returnDate
      ? `${booking.departureDate} → ${booking.returnDate}`
      : `${booking.departureDate}`,
    `${booking.adults || 1} adult${(booking.adults || 1) > 1 ? "s" : ""}` +
      ((booking.children || 0) > 0 ? `, ${booking.children} child${booking.children > 1 ? "ren" : ""}` : "") +
      ((booking.infants || 0) > 0 ? `, ${booking.infants} infant${booking.infants > 1 ? "s" : ""}` : ""),
  ];
  const paxSegment = formatPaxSegment(booking.passengers);
  if (paxSegment) baseSegments.push(paxSegment);

  // Cap at 250 chars — Tramada's text fields are roughly that wide.
  const itinerarySummary = truncate(baseSegments.join(" • "), 250);

  // Non-flight sources (e.g. a Room-Res hotel quote) have no origin/destination
  // airports, so the derived values above read as nonsense for them. They pass
  // `tramadaOverrides` with the header fields they can state correctly, and only
  // those are replaced. Purely additive: the Jetstar path never sets it.
  const overrides = {};
  for (const [k, v] of Object.entries(booking.tramadaOverrides || {})) {
    if (v !== undefined && v !== null) overrides[k] = v;
  }

  return {
    clientCode,
    departureDate: toTramadaDate(booking.departureDate),
    returnDate: toTramadaDate(booking.returnDate),
    bankAccount: "1",                             // [TRUST] Trust Account
    bookingType: "LEISURE",
    bookingSource: "EML",
    // destinationTypeCode has NO "INT" option. Valid values are region codes
    // (DOM, ASIA, EUROPE, USA_CANADA, NZ, ...) or OTHER. Domestic => DOM;
    // international => the caller-supplied region, else OTHER (a safe default).
    destination: isDomestic ? "DOM" : (booking.destinationRegion || "OTHER"),
    domInt: isDomestic ? "DOMESTIC" : "INTERNATIONAL",
    cabinClass: "ECON",
    itinerary: itinerarySummary,
    primaryDest: dest,
    ...overrides,
  };
}

/**
 * Get a browser to drive Tramada with.
 *
 * Tramada has no bot detection to defeat, so a plainly-launched Chrome works —
 * unlike the Jetstar flow, which needs the warm CDP profile to get past Akamai.
 *
 * @returns {Promise<{browser: import('playwright').Browser, launched: boolean}>}
 *   `launched` is true when we started Chrome ourselves (so we own closing it).
 */
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
    // In external mode we must attach to the Chrome the user is logged into.
    // Launching a throwaway Chrome here would be UNAUTHENTICATED and produce a
    // misleading "not logged in" — so fail honestly instead.
    throw new Error(
      `Could not connect to Chrome on ${CDP_HOST}:${CDP_PORT}. ` +
        `Run "npm run start:chrome" and log into Tramada IN THAT WINDOW first ` +
        `(it's a separate Chrome from your normal browser). [${cdpErr.message}]`
    );
  }
}

// Reliable auth check: hit a PROTECTED page and see if Tramada bounces us to
// login. (Checking login.htm directly is unreliable — Tramada serves the login
// form there even for authenticated sessions, causing false "not logged in".)
async function tramadaIsAuthed(page) {
  await page
    .goto(`${TRAMADA_BASE_URL}/home/home.htm`, { waitUntil: "domcontentloaded" })
    .catch(() => {});
  return !page.url().includes("login.htm");
}

/**
 * Ensure the page's Tramada session is authenticated.
 *  - Warm CDP Chrome already logged in → returns immediately.
 *  - Credentials provided → logs in programmatically.
 *  - Otherwise → calls onNeedLogin() and WAITS (polls) for the user to sign in
 *    manually in the shared Chrome (this is where they enter the OTP), up to 5
 *    minutes, then continues. It never just quits the run.
 */
async function tramadaLogin(page, username, password, onNeedLogin) {
  if (await tramadaIsAuthed(page)) return;

  if (username && password) {
    await page.goto(`${TRAMADA_BASE_URL}/login.htm`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#username", { state: "visible", timeout: 15000 });
    await page.fill("#username", username);
    await page.fill("#loginForm_password", password);
    await page.click("#loginForm_login");
    await page.waitForURL((u) => !u.toString().includes("login.htm"), { timeout: 30000 }).catch(() => {});
    if (page.url().includes("login.htm")) {
      throw new Error("Tramada login failed (check credentials / OTP).");
    }
    await sleep(500);
    return;
  }

  // No credentials — ask the user to log in and wait for them.
  if (typeof onNeedLogin === "function") onNeedLogin();
  const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes for manual login + OTP
  while (Date.now() < deadline) {
    await sleep(3000);
    if (await tramadaIsAuthed(page)) {
      await sleep(500);
      return;
    }
  }
  throw new Error("Timed out waiting for Tramada login. Sign in to the shared Chrome and try again.");
}

async function tramadaAddBooking(page, mapped) {
  await page.goto(`${TRAMADA_BASE_URL}/booking/booking-profile.htm?mode=ADD`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#client", { timeout: 15000 });

  // Client autocomplete — type and pick the first match
  const clientInput = page.locator("#client");
  await clientInput.click();
  await clientInput.fill("");
  await clientInput.type(mapped.clientCode, { delay: 80 });
  await sleep(2000);

  const acItem = page
    .locator(
      `.autocomplete-suggestions div, .ac_results li, ul.ui-autocomplete li, div[class*="autocomplete"] div`
    )
    .filter({ hasText: mapped.clientCode });
  if ((await acItem.count()) > 0) {
    await acItem.first().click();
  } else {
    // Fallback: keyboard-select first suggestion
    await page.keyboard.press("ArrowDown");
    await sleep(300);
    await page.keyboard.press("Enter");
  }
  await sleep(1500);

  // Mandatory fields. IMPORTANT: picking the client fires an ajax refresh that
  // re-renders parts of the form and can RESET selects that were set too early
  // (seen live: "Bank Account must be selected" on save). So set everything,
  // wait for the refresh to settle, then VERIFY and re-set anything wiped.
  const setFields = async () => {
    await page.selectOption("#bankAccount", mapped.bankAccount).catch(() => {});
    await page.fill("#departureDate", mapped.departureDate);
    if (mapped.returnDate) await page.fill("#returnDate", mapped.returnDate);
    await page.selectOption("#bookingTypeCode", mapped.bookingType).catch(() => {});
    await page.selectOption("#sourceTypeCode", mapped.bookingSource).catch(() => {});
    await page.selectOption("#destinationTypeCode", mapped.destination).catch(() => {});
    await page.selectOption("#domIntCode", mapped.domInt).catch(() => {});
    if (mapped.cabinClass) await page.selectOption("#cabinClassTypeCode", mapped.cabinClass).catch(() => {});
    if (mapped.itinerary) await page.fill("#itinerarySummary", mapped.itinerary);
    if (mapped.primaryDest) await page.fill("#destinationCityCode", mapped.primaryDest);
  };

  await setFields();
  await sleep(1500); // let the client-selection ajax finish re-rendering

  const wiped = await page.evaluate(() => {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
    return ["bankAccount", "bookingTypeCode", "sourceTypeCode", "destinationTypeCode", "domIntCode"]
      .filter((id) => !v(id));
  });
  if (wiped.length) {
    await setFields(); // the refresh reset some selects — set them again
    await sleep(400);
  }

  await page.click("#save");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);

  // Success = an id in the URL (post-save: booking-profile.htm?...&id=12345).
  // A REJECTED save re-renders the form — sometimes without mode=ADD in the
  // URL — so key off the id, and if it's missing surface the on-page
  // validation messages ("Bank Account must be selected", etc.) loudly.
  const url = page.url();
  const urlMatch = url.match(/[?&]id=(\d+)/);
  if (!urlMatch) {
    const errors = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("a, span, li, font, div").forEach((n) => {
        if (n.children.length) return;
        const t = (n.textContent || "").trim();
        if (t && t.length < 200 && /must be|is required|is invalid|cannot be|already exists/i.test(t)) {
          out.push(t);
        }
      });
      return [...new Set(out)].slice(0, 8);
    });
    throw new Error(
      `Booking save was rejected${errors.length ? ": " + errors.join("; ") : " (no booking id in URL — a required field was missing)"}`
    );
  }

  return { bookingNo: urlMatch[1], url };
}

async function tramadaSearchBooked(page) {
  await page.goto(`${TRAMADA_BASE_URL}/booking/booking-search.htm`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#searchForm_bookingStatus", { timeout: 15000 });
  await page.selectOption("#searchForm_bookingStatus", "BOOKED");
  await page.click("#searchButton");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);

  return await page.evaluate(() => {
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const header = table.querySelector("tr");
      if (header && header.textContent.includes("Bkg No")) {
        const rows = table.querySelectorAll("tr");
        const out = [];
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 6) {
            out.push({
              bkgNo: cells[1]?.textContent?.trim() || "",
              client: cells[2]?.textContent?.trim() || "",
              debtor: cells[3]?.textContent?.trim() || "",
              itinerary: cells[4]?.textContent?.trim() || "",
              depDate: cells[5]?.textContent?.trim() || "",
              retDate: cells[6]?.textContent?.trim() || "",
              finalTkt: cells[7]?.textContent?.trim() || "",
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
 * Run the full chat-mode chain: log in → add booking → search.
 *
 * @param {object} args
 * @param {string} args.username
 * @param {string} args.password
 * @param {string} args.clientCode  Tramada client autocomplete value (e.g. "GRAY/SPIDER")
 * @param {object} args.booking     Jetstar bookingData (originCode, destinationCode, departureDate, returnDate, ...)
 * @param {object} [args.callbacks] { onProgress(pct, msg), onError(msg), onAddComplete(addResult), onSearchComplete(rows) }
 * @returns {Promise<{add: object, bookings: Array}>}
 */
async function runTramadaAddAndSearch({
  username,
  password,
  clientCode,
  booking,
  skipSearch = false, // pipeline mode: bookingNo comes from the URL; skip the 15s search poll
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});
  const onAddComplete = callbacks.onAddComplete || (() => {});
  const onSearchComplete = callbacks.onSearchComplete || (() => {});

  // Credentials are optional — if the shared Chrome is already logged in,
  // tramadaLogin() reuses that warm session and skips the login form. We only
  // fail (inside tramadaLogin) if we actually land on login.htm without creds.
  if (!clientCode) throw new Error("Tramada clientCode is required (e.g. GRAY/SPIDER)");
  if (!booking || !booking.departureDate) {
    throw new Error("booking.departureDate is required for Tramada add");
  }

  const mapped = mapJetstarToTramada(booking, clientCode);

  let browser, context, page, launched = false;
  let _ok = false;
  try {
    ({ browser, launched } = await openBrowser(onProgress));
    const contexts = browser.contexts();
    context = contexts[0] || (await browser.newContext());
    page = await context.newPage();

    onProgress(15, "Logging into Tramada...");
    await tramadaLogin(page, username, password, callbacks.onNeedLogin);

    onProgress(45, `Adding booking for client "${clientCode}" (${mapped.domInt})...`);
    const addResult = await tramadaAddBooking(page, mapped);

    // Pipeline mode: the booking number is already extracted from the post-save
    // URL, and the new booking is simply the most recent one — no need to poll
    // the BOOKED search index (which lags ~15s behind a fresh save).
    if (skipSearch) {
      onAddComplete(addResult);
      onProgress(100, `Booking ${addResult.bookingNo || ""} saved.`.trim());
      _ok = true;
      return { add: addResult, bookings: [], mapped };
    }

    // Tramada's BOOKED search index lags a few seconds behind a fresh save.
    // Poll the search up to ~15s and stop early once we can match the new row.
    const POLL_DELAYS_MS = [3000, 3000, 3000, 3000, 3000]; // up to 5 attempts, 15s total
    const tryMatch = (rows) => {
      if (addResult.bookingNo) {
        const byNo = rows.find((r) => r.bkgNo === addResult.bookingNo);
        if (byNo) return byNo;
      }
      // Fallback: client name + departure date (Tramada returns dd-mm-yyyy in the table).
      const expectedDep = mapped.departureDate;
      const codeKey = (clientCode || "").toUpperCase().replace(/\s+/g, "");
      return (
        rows.find(
          (r) =>
            r.depDate === expectedDep &&
            (r.client || "").toUpperCase().replace(/\s+/g, "").includes(codeKey)
        ) || null
      );
    };

    let bookings = [];
    let summary = null;
    for (let i = 0; i < POLL_DELAYS_MS.length; i++) {
      onProgress(
        60 + i * 6,
        i === 0
          ? "Searching booked status..."
          : `Booking not in index yet — retrying (${i + 1}/${POLL_DELAYS_MS.length})...`
      );
      await sleep(POLL_DELAYS_MS[i]);
      bookings = await tramadaSearchBooked(page);
      summary = tryMatch(bookings);
      if (summary) break;
    }

    onSearchComplete(bookings);

    const enrichedAdd = { ...addResult, summary };
    onAddComplete(enrichedAdd);

    onProgress(100, summary ? "Tramada done." : "Tramada saved (search row not yet indexed).");
    _ok = true;
    return { add: enrichedAdd, bookings, mapped };
  } catch (err) {
    onError(err.message);
    throw err;
  } finally {
    try {
      // On failure leave the tab open so the error state can be inspected;
      // close it only after a clean run.
      if (page && _ok) await page.close();
    } catch { /* tab may already be closed */ }
    try {
      // If we launched Chrome this shuts it down; if we attached over CDP it only
      // drops the connection, leaving the user's Chrome running.
      if (browser) await browser.close();
    } catch { /* CDP disconnect */ }
  }
}

module.exports = { runTramadaAddAndSearch, mapJetstarToTramada, toTramadaDate };
