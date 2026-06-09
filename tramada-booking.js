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

  return {
    clientCode,
    departureDate: toTramadaDate(booking.departureDate),
    returnDate: toTramadaDate(booking.returnDate),
    bankAccount: "1",                             // [TRUST] Trust Account
    bookingType: "LEISURE",
    bookingSource: "EML",
    destination: isDomestic ? "DOM" : "INT",
    domInt: isDomestic ? "DOMESTIC" : "INTERNATIONAL",
    cabinClass: "ECON",
    itinerary: itinerarySummary,
    primaryDest: dest,
  };
}

async function tramadaLogin(page, username, password) {
  await page.goto(`${TRAMADA_BASE_URL}/login.htm`, { waitUntil: "domcontentloaded" });

  // Already logged in? Tramada redirects away from login.htm.
  if (!page.url().includes("login.htm")) return;

  await page.waitForSelector("#username", { state: "visible", timeout: 15000 });
  await page.fill("#username", username);
  await page.fill("#loginForm_password", password);
  await page.click("#loginForm_login");

  // Wait for a redirect away from login.htm (success) or the login form to re-appear with an error.
  try {
    await page.waitForURL((url) => !url.toString().includes("login.htm"), { timeout: 30000 });
  } catch {
    const stillOnLogin = page.url().includes("login.htm");
    if (stillOnLogin) {
      throw new Error("Tramada login failed (still on login.htm — check credentials).");
    }
  }
  await page.waitForLoadState("domcontentloaded");
  await sleep(500);
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

  // Mandatory fields
  await page.selectOption("#bankAccount", mapped.bankAccount);
  await page.fill("#departureDate", mapped.departureDate);
  if (mapped.returnDate) await page.fill("#returnDate", mapped.returnDate);
  await page.selectOption("#bookingTypeCode", mapped.bookingType);
  await page.selectOption("#sourceTypeCode", mapped.bookingSource);
  await page.selectOption("#destinationTypeCode", mapped.destination);
  await page.selectOption("#domIntCode", mapped.domInt);

  // Optional
  if (mapped.cabinClass) await page.selectOption("#cabinClassTypeCode", mapped.cabinClass);
  if (mapped.itinerary) await page.fill("#itinerarySummary", mapped.itinerary);
  if (mapped.primaryDest) await page.fill("#destinationCityCode", mapped.primaryDest);

  await sleep(400);
  await page.click("#save");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1500);

  // Errors?
  const errors = await page.evaluate(() => {
    const box = document.querySelector(
      'div[style*="border"][style*="red"], .errorMessages, fieldset[class*="error"]'
    );
    if (box) {
      return box.textContent
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const links = document.querySelectorAll('a[href*="error"], span[class*="error"]');
    return links.length ? Array.from(links).map((e) => e.textContent.trim()) : [];
  });

  if (errors.length > 0) {
    throw new Error(`Tramada validation errors: ${errors.join("; ")}`);
  }

  if (page.url().includes("mode=ADD")) {
    throw new Error("Tramada save did not complete (still on Add page).");
  }

  // Pull the new booking number — URL is the reliable source: post-save the page
  // is /booking-profile.htm?mode=edit&...&id=12506&... — fall back to page text.
  const url = page.url();
  let bkgNo = null;
  const urlMatch = url.match(/[?&]id=(\d+)/);
  if (urlMatch) {
    bkgNo = urlMatch[1];
  } else {
    bkgNo = await page.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/Booking\s+(\d+)/i) || text.match(/Bkg\s+No\.?\s*(\d+)/i);
      return m ? m[1] : null;
    });
  }

  return { bookingNo: bkgNo, url };
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
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});
  const onAddComplete = callbacks.onAddComplete || (() => {});
  const onSearchComplete = callbacks.onSearchComplete || (() => {});

  if (!username || !password) throw new Error("Tramada username and password are required");
  if (!clientCode) throw new Error("Tramada clientCode is required (e.g. GRAY/SPIDER)");
  if (!booking || !booking.departureDate) {
    throw new Error("booking.departureDate is required for Tramada add");
  }

  const mapped = mapJetstarToTramada(booking, clientCode);

  let browser, context, page;
  try {
    onProgress(5, `Connecting to CDP Chrome at ${CDP_HOST}:${CDP_PORT}...`);
    browser = await chromium.connectOverCDP(`http://${CDP_HOST}:${CDP_PORT}`);
    const contexts = browser.contexts();
    context = contexts[0] || (await browser.newContext());
    page = await context.newPage();

    onProgress(15, "Logging into Tramada...");
    await tramadaLogin(page, username, password);

    onProgress(45, `Adding booking for client "${clientCode}" (${mapped.domInt})...`);
    const addResult = await tramadaAddBooking(page, mapped);

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
    return { add: enrichedAdd, bookings, mapped };
  } catch (err) {
    onError(err.message);
    throw err;
  } finally {
    try {
      if (page) await page.close();
    } catch { /* tab may already be closed */ }
    try {
      if (browser) await browser.close();
    } catch { /* CDP disconnect */ }
  }
}

module.exports = { runTramadaAddAndSearch, mapJetstarToTramada, toTramadaDate };
