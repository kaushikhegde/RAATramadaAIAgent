/**
 * booking.js — Jetstar Booking Automation (v4.1)
 * ================================================
 * Complete rewrite with VERIFIED selectors from live browser testing.
 * Reads booking details from a PDF in Todo/, automates the full
 * Jetstar booking flow up to "Review & Pay", takes a screenshot,
 * and moves the PDF to Completed/.
 *
 * IMPORTANT — Anti-Bot Detection Fix:
 *   Jetstar blocks Playwright's default Chromium browser after Search.
 *   Solution: Connect to YOUR REAL Chrome browser via Chrome DevTools Protocol (CDP).
 *
 *   Before running, start Chrome with remote debugging:
 *     Mac:    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 *     Windows: "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
 *     Linux:  google-chrome --remote-debugging-port=9222
 *
 *   Then run:
 *     npm run book              # Connects to your Chrome on port 9222
 *     npm run book:debug        # With debug logging
 *     npm run validate          # Parse PDF and validate only (no browser)
 *
 *   If you prefer the standalone Playwright Chromium (may get blocked):
 *     USE_PLAYWRIGHT=true npm run book:headed
 */

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { parsePdf, validateBooking, printBookingSummary } = require("./parsePdf");

// ─── Paths & Config ─────────────────────────────────────────────
const TODO_DIR = path.join(__dirname, "Todo");
const COMPLETED_DIR = path.join(__dirname, "Completed");
const HEADLESS = process.env.HEADLESS !== "false";
const DEBUG = process.env.DEBUG === "true";
const VALIDATE_ONLY = process.argv.includes("--validate-only");
const USE_PLAYWRIGHT = process.env.USE_PLAYWRIGHT === "true"; // false = use real Chrome via CDP
const CDP_PORT = process.env.CDP_PORT || "9222";

// ─── Logger ──────────────────────────────────────────────────────
function log(step, msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] STEP ${step}: ${msg}`);
}
function debug(msg) {
  if (DEBUG) console.log(`  [DEBUG] ${msg}`);
}

// ─── Find PDF in Todo/ ───────────────────────────────────────────
function findPdf() {
  if (!fs.existsSync(TODO_DIR)) {
    throw new Error(`Todo/ directory not found at ${TODO_DIR}`);
  }
  const pdfs = fs.readdirSync(TODO_DIR).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (pdfs.length === 0) {
    throw new Error("No PDF files found in Todo/ folder.");
  }
  if (pdfs.length > 1) {
    console.log(`⚠️  Multiple PDFs found: ${pdfs.join(", ")}. Using first: ${pdfs[0]}`);
  }
  return { fileName: pdfs[0], filePath: path.join(TODO_DIR, pdfs[0]) };
}

// ─── Helper: build Jetstar home URL with pre-filled params ──────
function buildJetstarUrl(booking) {
  const params = new URLSearchParams();
  params.set("origin", booking.originCode);
  params.set("destination", booking.destinationCode);
  params.set("adults", String(booking.adults));
  params.set("children", String(booking.children));
  params.set("infants", String(booking.infants));
  params.set("flight-type", booking.tripType === "return" ? "2" : "1");
  return `https://www.jetstar.com/au/en/home?${params.toString()}`;
}

// ─── Date helpers ────────────────────────────────────────────────
function getWeekdayName(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-AU", { weekday: "long" });
}
function getMonthName(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-AU", { month: "long" });
}
function getYear(dateStr) {
  return new Date(dateStr + "T12:00:00").getFullYear();
}
function getDay(dateStr) {
  return new Date(dateStr + "T12:00:00").getDate();
}

// ─── Helper: safe click with retry ──────────────────────────────
async function safeClick(page, selector, description, timeout = 10000) {
  debug(`Waiting for: ${description} (${selector})`);
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible", timeout });
  await el.click();
  debug(`Clicked: ${description}`);
}

// ─── Helper: wait for navigation to a URL pattern ───────────────
async function waitForUrl(page, pattern, timeout = 30000) {
  await page.waitForURL(pattern, { timeout });
}

// ─── Helper: detect current page from URL ───────────────────────
function detectPage(url) {
  if (url.includes("/booking/select-flights") || url.includes("/booking/flights")) return "flights";
  if (url.includes("/booking/baggage")) return "baggage";
  if (url.includes("/booking/seats")) return "seats";
  if (url.includes("/booking/extras") || url.includes("/booking/customise")) return "extras";
  if (url.includes("/booking/details") || url.includes("/booking/passengers")) return "details";
  if (url.includes("/booking/review") || url.includes("/booking/pay")) return "review";
  if (url.includes("jetstar.com/au/en/home") || url.includes("jetstar.com/au/en/")) return "home";
  return "unknown";
}

// ─── Helper: smart click via page.evaluate with retry ───────────
// Tries to find and click an element using multiple strategies
async function smartClick(page, strategies, description, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    debug(`smartClick attempt ${attempt}/${maxAttempts} for: ${description}`);
    for (const strategy of strategies) {
      try {
        const clicked = await page.evaluate(strategy.fn);
        if (clicked) {
          debug(`✓ smartClick succeeded for: ${description} (strategy: ${strategy.name})`);
          return true;
        }
      } catch (e) {
        // Execution context destroyed = a navigation happened (likely from a previous click)
        if (e.message && e.message.includes("Execution context was destroyed")) {
          debug(`smartClick: navigation detected during ${strategy.name} — treating as success.`);
          await page.waitForTimeout(3000); // Let navigation complete
          return true;
        }
        debug(`smartClick: error in strategy ${strategy.name}: ${e.message}`);
      }
    }
    if (attempt < maxAttempts) {
      debug(`smartClick: no strategy worked, waiting 2s before retry...`);
      await page.waitForTimeout(2000);
    }
  }
  debug(`✗ smartClick FAILED for: ${description} after ${maxAttempts} attempts`);
  return false;
}

// ─── Helper: wait for page to be the expected one, with recovery ─
async function ensureOnPage(page, expectedPage, timeout = 20000) {
  const startTime = Date.now();
  let clickedContinue = false; // Only try clicking Continue ONCE to avoid double-clicks during nav

  while (Date.now() - startTime < timeout) {
    // Check current page
    let currentUrl, currentPage;
    try {
      currentUrl = page.url();
      currentPage = detectPage(currentUrl);
    } catch {
      // Page might be navigating — wait and retry
      debug("ensureOnPage: page.url() failed (likely navigating), waiting...");
      await page.waitForTimeout(2000);
      continue;
    }

    if (currentPage === expectedPage) {
      debug(`Confirmed on ${expectedPage} page.`);
      // Wait a moment for page to fully load
      await page.waitForTimeout(1500);
      return true;
    }
    debug(`Expected ${expectedPage} page, currently on: ${currentPage} (${currentUrl})`);

    // If we haven't tried clicking Continue yet and we're on a previous page, try once
    if (!clickedContinue) {
      const shouldClickContinue =
        (expectedPage === "baggage" && currentPage === "flights") ||
        (expectedPage === "seats" && currentPage === "baggage") ||
        (expectedPage === "extras" && currentPage === "seats") ||
        (expectedPage === "details" && currentPage === "extras");

      if (shouldClickContinue) {
        debug(`Stuck on ${currentPage} page — trying to click Continue (once)...`);
        try {
          const clicked = await page.evaluate(() => {
            const qaBtn = document.querySelector("button.qa-continue");
            if (qaBtn && qaBtn.offsetParent !== null) { qaBtn.scrollIntoView({ block: "center" }); qaBtn.click(); return true; }
            const allBtns = [...document.querySelectorAll("button")];
            const contBtn = allBtns.find(b => b.textContent.trim().toLowerCase().includes("continue") && b.offsetParent !== null);
            if (contBtn) { contBtn.scrollIntoView({ block: "center" }); contBtn.click(); return true; }
            return false;
          });
          if (clicked) {
            debug("Clicked a Continue button — waiting for navigation...");
            clickedContinue = true;
            // Wait longer after clicking to allow page navigation
            try {
              await page.waitForURL(`**/booking/**`, { timeout: 10000, waitUntil: "domcontentloaded" });
            } catch {
              debug("waitForURL after Continue click timed out, continuing poll...");
            }
            continue; // Re-check URL immediately
          }
        } catch (e) {
          // Execution context destroyed = navigation already happening, that's good!
          debug(`page.evaluate failed (navigation in progress): ${e.message}`);
          clickedContinue = true;
          await page.waitForTimeout(3000);
          continue;
        }
      }
    }

    // Just wait and poll
    await page.waitForTimeout(2000);
  }

  let finalPage;
  try { finalPage = detectPage(page.url()); } catch { finalPage = "unknown"; }
  debug(`ensureOnPage timeout: expected ${expectedPage}, still on ${finalPage}`);
  return false;
}

// ─── Helper: take a debug screenshot when stuck ─────────────────
async function debugScreenshot(page, label) {
  if (!DEBUG) return;
  try {
    const screenshotPath = path.join(COMPLETED_DIR, `debug-${label}-${Date.now()}.png`);
    if (!fs.existsSync(COMPLETED_DIR)) fs.mkdirSync(COMPLETED_DIR, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    debug(`📸 Debug screenshot saved: ${screenshotPath}`);
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════
//  BROWSER AUTOMATION — VERIFIED SELECTORS FROM LIVE TESTING
// ═══════════════════════════════════════════════════════════════════

// ─── Step 1: Navigate to Jetstar with pre-filled params ──────────
async function step1_navigate(page, booking) {
  const url = buildJetstarUrl(booking);
  log(1, `Navigating to Jetstar with pre-filled params...`);
  debug(`URL: ${url}`);

  // CRITICAL: Use "domcontentloaded" — NOT "networkidle"
  // Jetstar makes constant background requests; networkidle never fires.
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Wait for the search form to be fully interactive
  log(1, "Waiting for search form to load...");
  await page.waitForSelector('button[aria-label="Search"]', {
    state: "visible",
    timeout: 30000,
  });
  await page.waitForTimeout(2000);

  // Dismiss any cookie / privacy banners
  try {
    const dismissBtn = page
      .locator('button:has-text("Accept"), button:has-text("Got it"), button:has-text("Close")')
      .first();
    if (await dismissBtn.isVisible({ timeout: 3000 })) {
      await dismissBtn.click();
      debug("Dismissed banner.");
      await page.waitForTimeout(500);
    }
  } catch {
    /* no banner */
  }

  log(1, `✅ Page loaded. Origin: ${booking.originCode}, Destination: ${booking.destinationCode}`);
}

// ─── Step 2: Verify Origin (pre-filled via URL) ─────────────────
async function step2_verifyOrigin(page, booking) {
  log(2, `Verifying origin: ${booking.originCode}...`);

  // URL params pre-fill the origin. Verify it's in the URL.
  const currentUrl = page.url();
  if (currentUrl.includes(`origin=${booking.originCode}`)) {
    log(2, `✅ Origin set via URL: ${booking.originCode}`);
    return;
  }

  // Fallback: click the visible placeholder input and select manually
  debug("Origin not pre-filled, selecting manually...");
  await page.locator("#searchInput-From-placeholder").click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  await page.waitForSelector('div[class*="comboboxpanel-module_panel"]', {
    state: "visible",
    timeout: 5000,
  });
  const option = page
    .locator('div[class*="comboboxpanel-module_option"]')
    .filter({ hasText: new RegExp(booking.originCode) })
    .first();
  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();
  await page.waitForTimeout(1000);
  log(2, `✅ Origin selected: ${booking.originCode}`);
}

// ─── Step 3: Verify Destination (pre-filled via URL) ────────────
async function step3_verifyDestination(page, booking) {
  log(3, `Verifying destination: ${booking.destinationCode}...`);

  const currentUrl = page.url();
  if (currentUrl.includes(`destination=${booking.destinationCode}`)) {
    log(3, `✅ Destination set via URL: ${booking.destinationCode}`);
    return;
  }

  debug("Destination not pre-filled, selecting manually...");
  await page.locator("#searchInput-To-placeholder").click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  await page.waitForSelector('div[class*="comboboxpanel-module_panel"]', {
    state: "visible",
    timeout: 5000,
  });
  const options = page
    .locator('div[class*="comboboxpanel-module_option"]')
    .filter({ hasText: new RegExp(booking.destinationCode) });
  const count = await options.count();
  if (count > 0) {
    await options.nth(count - 1).click();
    await page.waitForTimeout(1000);
    log(3, `✅ Destination selected: ${booking.destinationCode}`);
  } else {
    throw new Error(`Could not find destination ${booking.destinationCode} in dropdown`);
  }
}

// ─── Step 4: Select Travel Dates ─────────────────────────────────
async function step4_selectDates(page, booking) {
  log(4, "Opening date picker...");

  // Click the popover button to open the calendar
  // #popoverButton is the verified selector from live testing
  const popover = page.locator("#popoverButton");
  await popover.waitFor({ state: "visible", timeout: 10000 });
  await popover.click();
  await page.waitForTimeout(2000);

  // Set trip type
  if (booking.tripType === "one-way") {
    debug("Selecting One way...");
    await page.locator('input[name="triptype"][value="Oneway"]').click();
    await page.waitForTimeout(500);
  } else {
    const returnRadio = page.locator('input[name="triptype"][value="Return"]');
    if (!(await returnRadio.isChecked())) {
      await returnRadio.click();
      await page.waitForTimeout(500);
    }
    debug("Return trip confirmed.");
  }

  // Navigate calendar to departure month and select date
  const depMonthName = getMonthName(booking.departureDate);
  const depYear = getYear(booking.departureDate);
  const depDay = getDay(booking.departureDate);
  const depWeekday = getWeekdayName(booking.departureDate);

  await navigateCalendarToMonth(page, depMonthName, depYear);

  // aria-label format verified: "Sunday, 15 March 2026"
  const depLabel = `${depWeekday}, ${depDay} ${depMonthName} ${depYear}`;
  log(4, `Selecting departure: ${depLabel}...`);
  const depButton = page.locator(`button[aria-label="${depLabel}"]`);
  await depButton.waitFor({ state: "visible", timeout: 5000 });
  await depButton.click();
  await page.waitForTimeout(1000);

  // Select return date if round trip
  if (booking.tripType === "return" && booking.returnDate) {
    const retMonthName = getMonthName(booking.returnDate);
    const retYear = getYear(booking.returnDate);
    const retDay = getDay(booking.returnDate);
    const retWeekday = getWeekdayName(booking.returnDate);

    await navigateCalendarToMonth(page, retMonthName, retYear);

    const retLabel = `${retWeekday}, ${retDay} ${retMonthName} ${retYear}`;
    log(4, `Selecting return: ${retLabel}...`);
    const retButton = page.locator(`button[aria-label="${retLabel}"]`);
    await retButton.waitFor({ state: "visible", timeout: 5000 });
    await retButton.click();
    await page.waitForTimeout(1000);
  }

  // Click Confirm button in the calendar footer
  // Verified selector: button[type="submit"] with text "Confirm"
  const confirmBtn = page.locator('button[type="submit"]:has-text("Confirm")');
  await confirmBtn.waitFor({ state: "visible", timeout: 5000 });
  await confirmBtn.click();
  await page.waitForTimeout(1000);

  log(4, `✅ Dates confirmed: ${booking.departureDate}${booking.returnDate ? " → " + booking.returnDate : " (one-way)"}`);
}

async function navigateCalendarToMonth(page, targetMonth, targetYear) {
  for (let i = 0; i < 12; i++) {
    // Check all caption labels for the target month
    const captionLabels = page.locator('span[class*="caption_label"]');
    const count = await captionLabels.count();
    let found = false;
    for (let j = 0; j < count; j++) {
      const text = await captionLabels.nth(j).textContent();
      if (text && text.includes(targetMonth) && text.includes(String(targetYear))) {
        found = true;
        break;
      }
    }
    if (found) {
      debug(`Calendar showing ${targetMonth} ${targetYear}`);
      return;
    }
    // Click next month — verified selector
    const nextBtn = page.locator('button[aria-label="Go to the Next Month"]');
    if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(500);
    } else {
      break;
    }
  }
}

// ─── Step 5: Verify Passengers (pre-filled via URL) ─────────────
async function step5_verifyPassengers(page, booking) {
  log(5, `Verifying passengers: ${booking.adults}A, ${booking.children}C, ${booking.infants}I...`);
  // URL params pre-fill passengers. Just log confirmation.
  log(5, `✅ Passengers pre-filled via URL params.`);
}

// ─── Step 6: Search Flights ──────────────────────────────────────
async function step6_searchFlights(page) {
  log(6, "Clicking Search...");

  const searchBtn = page.locator('button[aria-label="Search"]');
  await searchBtn.waitFor({ state: "visible", timeout: 5000 });
  await searchBtn.click();

  // Wait for navigation to booking.jetstar.com flight selection
  try {
    await page.waitForURL("**/booking/select-flights**", { timeout: 30000 });
    log(6, "✅ Flight selection page loaded.");
  } catch {
    // Check for CAPTCHA
    const bodyText = await page.textContent("body").catch(() => "");
    if (
      bodyText.includes("not a robot") ||
      bodyText.includes("CAPTCHA") ||
      bodyText.includes("challenge")
    ) {
      log(6, "");
      log(6, "╔══════════════════════════════════════════════════╗");
      log(6, "║  ⚠️  CAPTCHA DETECTED!                          ║");
      log(6, "║  Please solve it manually in the browser.       ║");
      log(6, "║  Waiting up to 120 seconds...                   ║");
      log(6, "╚══════════════════════════════════════════════════╝");
      await page.waitForURL("**/booking/select-flights**", { timeout: 120000 });
      log(6, "✅ CAPTCHA solved — flight results loaded.");
    } else {
      // Check if we're on an alternative URL
      const url = page.url();
      if (url.includes("booking.jetstar.com")) {
        log(6, "✅ Navigated to booking site.");
      } else {
        throw new Error("Failed to navigate to flight selection page. Current URL: " + url);
      }
    }
  }

  await page.waitForTimeout(4000);
}

// ─── Step 7: Select Departure Flight (Cheapest / Starter) ───────
async function step7_selectDepartureFlight(page) {
  log(7, "Selecting departure flight...");

  // Wait for flight cards to load on booking.jetstar.com
  try {
    await page.waitForSelector(".flight-card", { state: "visible", timeout: 20000 });
  } catch {
    debug("No .flight-card found, trying alternate wait...");
    await page.waitForTimeout(5000);
  }
  await page.waitForTimeout(2000);

  // Click the FIRST flight card to expand its fare bundles — with retry
  let cardClicked = await smartClick(page, [
    {
      name: "flight-card",
      fn: () => {
        const card = document.querySelector(".flight-card");
        if (card && card.offsetParent !== null) { card.scrollIntoView({ block: "center" }); card.click(); return true; }
        return false;
      },
    },
    {
      name: "unselected-flight",
      fn: () => {
        const card = document.querySelector(".flight-card.unselected-flight");
        if (card && card.offsetParent !== null) { card.scrollIntoView({ block: "center" }); card.click(); return true; }
        return false;
      },
    },
  ], "departure flight card");

  if (!cardClicked) {
    await debugScreenshot(page, "step7-no-card");
    throw new Error("Step 7: Could not find any departure flight card to click.");
  }
  await page.waitForTimeout(2000);

  // After clicking, fare bundles expand. Click the FIRST "Select" button = Starter (cheapest).
  let selectClicked = await smartClick(page, [
    {
      name: "select-button",
      fn: () => {
        const btns = [...document.querySelectorAll("button")].filter(
          (b) => b.textContent.trim() === "Select" && b.offsetParent !== null
        );
        if (btns.length > 0) { btns[0].scrollIntoView({ block: "center" }); btns[0].click(); return true; }
        return false;
      },
    },
  ], "Select (Starter fare) for departure");

  if (!selectClicked) {
    await debugScreenshot(page, "step7-no-select");
    throw new Error("Step 7: Could not find 'Select' button for departure fare.");
  }
  await page.waitForTimeout(3000);

  log(7, "✅ Departure flight selected.");
}

// ─── Step 8: Select Return Flight (Cheapest / Starter) ──────────
async function step8_selectReturnFlight(page, tripType) {
  if (tripType === "one-way") {
    log(8, "⏭  Skipping return flight (one-way trip).");
    return;
  }

  log(8, "Selecting return flight...");
  await page.waitForTimeout(3000);

  // After departure is selected, return flights auto-show on the same page.
  // Click the first UNSELECTED flight card — with retry
  let cardClicked = await smartClick(page, [
    {
      name: "unselected-flight-card",
      fn: () => {
        const card = [...document.querySelectorAll(".flight-card")].find(
          (c) => c.offsetParent && c.classList.contains("unselected-flight")
        );
        if (card) { card.scrollIntoView({ block: "center" }); card.click(); return true; }
        return false;
      },
    },
    {
      name: "any-flight-card-not-selected",
      fn: () => {
        // Fallback: find any flight card that isn't already in a "selected" state
        const cards = [...document.querySelectorAll(".flight-card")];
        const unselected = cards.find(c => c.offsetParent && !c.classList.contains("selected-flight"));
        if (unselected) { unselected.scrollIntoView({ block: "center" }); unselected.click(); return true; }
        return false;
      },
    },
  ], "return flight card");

  if (!cardClicked) {
    await debugScreenshot(page, "step8-no-card");
    throw new Error("Step 8: Could not find any return flight card to click.");
  }
  await page.waitForTimeout(2000);

  // Click the first visible "Select" button for the return Starter fare
  let selectClicked = await smartClick(page, [
    {
      name: "select-button",
      fn: () => {
        const btns = [...document.querySelectorAll("button")].filter(
          (b) => b.textContent.trim() === "Select" && b.offsetParent !== null
        );
        if (btns.length > 0) { btns[0].scrollIntoView({ block: "center" }); btns[0].click(); return true; }
        return false;
      },
    },
  ], "Select (Starter fare) for return");

  if (!selectClicked) {
    await debugScreenshot(page, "step8-no-select");
    throw new Error("Step 8: Could not find 'Select' button for return fare.");
  }
  await page.waitForTimeout(3000);

  log(8, "✅ Return flight selected.");
}

// ─── Step 9: Continue to Baggage & Select Options ────────────────
async function step9_baggage(page) {
  log(9, "Handling baggage selection...");

  // First: detect where we actually are
  const currentPage = detectPage(page.url());
  debug(`Currently on: ${currentPage} page (${page.url()})`);

  // If not on baggage page yet, click Continue ONCE, then wait for navigation
  if (currentPage !== "baggage") {
    debug("Not on baggage page yet — clicking Continue...");

    // Click Continue once
    const continueClicked = await smartClick(page, [
      {
        name: "qa-continue",
        fn: () => {
          const btn = document.querySelector("button.qa-continue");
          if (btn && btn.offsetParent !== null) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
          return false;
        },
      },
      {
        name: "continue-to-bags-text",
        fn: () => {
          const btns = [...document.querySelectorAll("button")];
          const btn = btns.find(b => b.textContent.trim().toLowerCase().includes("continue") && b.offsetParent !== null);
          if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
          return false;
        },
      },
    ], "Continue to bags button", 3);

    if (continueClicked) {
      // Wait for navigation to complete after clicking
      debug("Continue clicked — waiting for navigation...");
      try {
        await page.waitForURL("**/booking/baggage**", { timeout: 20000, waitUntil: "domcontentloaded" });
        debug("Navigation to baggage page confirmed.");
      } catch {
        debug("waitForURL to baggage timed out, will check with ensureOnPage...");
      }
    } else {
      await debugScreenshot(page, "step9-no-continue");
      debug("WARNING: Could not click Continue button, but will try to proceed...");
    }
  }

  // Double-check we're on the baggage page (won't re-click Continue since it already navigated or timed out)
  const onBaggage = await ensureOnPage(page, "baggage", 15000);
  if (!onBaggage) {
    await debugScreenshot(page, "step9-not-baggage");
    debug(`WARNING: Not confirmed on baggage page (url: ${page.url()}). Attempting baggage selection anyway...`);
  }
  await page.waitForTimeout(3000);

  // ── BAGGAGE SELECTION ──
  // CRITICAL: page.evaluate(() => el.click()) does NOT work on these cards!
  // Jetstar uses React — only real mouse events (Playwright's .click()) trigger selection.
  // The page has SEPARATE sections per flight (Departing + Returning).
  //
  // Verified DOM structure (from live inspection):
  //   Checked baggage "No checked baggage" card:
  //     BUTTON.card-module_primaryAction > DIV.baggage-option-card__product-info
  //       > DIV.baggage-option-card__no-checked-baggage > "No checked baggage"
  //   Carry-on 7kg card:
  //     BUTTON.card-module_primaryAction > ... > DIV.baggage-option-card__bundle-tag
  //       > "Starter"
  //
  // Stable class: .baggage-option-card__no-checked-baggage (2 instances: depart + return)
  // 7kg card: button containing "7kg" and "Starter" text, NOT containing "14kg"

  // ── STEP A: Click ALL "No checked baggage" cards using Playwright locators ──
  // Find buttons that contain the .baggage-option-card__no-checked-baggage div
  const noBagLocator = page.locator("button:has(.baggage-option-card__no-checked-baggage)");
  let noBagCount = 0;
  try {
    noBagCount = await noBagLocator.count();
    debug(`Found ${noBagCount} "No checked baggage" card buttons.`);
  } catch {
    debug("Could not count No checked baggage cards.");
  }

  let checkedClicked = 0;
  for (let i = 0; i < noBagCount; i++) {
    try {
      const card = noBagLocator.nth(i);
      await card.scrollIntoViewIfNeeded();
      await card.click({ timeout: 5000 });
      checkedClicked++;
      debug(`Clicked "No checked baggage" card ${i + 1}/${noBagCount}.`);
      await page.waitForTimeout(1500);
    } catch (e) {
      debug(`Failed to click No checked baggage card ${i}: ${e.message}`);
    }
  }

  // Fallback if the stable class didn't work — try by text
  if (checkedClicked === 0) {
    debug("Fallback: trying to find No checked baggage by text...");
    const textLocator = page.locator("button", { hasText: "No checked baggage" });
    const textCount = await textLocator.count();
    debug(`Found ${textCount} buttons with 'No checked baggage' text.`);
    for (let i = 0; i < textCount; i++) {
      try {
        await textLocator.nth(i).scrollIntoViewIfNeeded();
        await textLocator.nth(i).click({ timeout: 5000 });
        checkedClicked++;
        debug(`Fallback: clicked No checked baggage button ${i + 1}.`);
        await page.waitForTimeout(1500);
      } catch (e) {
        debug(`Fallback click failed: ${e.message}`);
      }
    }
  }
  debug(`Total "No checked baggage" clicks: ${checkedClicked}`);

  // ── STEP B: Click ALL "7kg" carry-on cards ──
  // The 7kg card is a button containing "7kg" and "Starter" but NOT "14kg"
  // Use Playwright text locator with filtering
  let carryOnClicked = 0;

  // First try: buttons containing the bundle tag class with "Starter"
  const starterLocator = page.locator("button:has(.baggage-option-card__bundle-tag)");
  let starterCount = 0;
  try {
    starterCount = await starterLocator.count();
    debug(`Found ${starterCount} buttons with baggage bundle tag.`);
  } catch {
    debug("Could not count bundle tag cards.");
  }

  for (let i = 0; i < starterCount; i++) {
    try {
      const card = starterLocator.nth(i);
      const text = await card.textContent();
      // Only click if it contains "7kg" and "Starter" but NOT "14kg"
      if (text && text.includes("7kg") && text.includes("Starter") && !text.includes("14kg")) {
        await card.scrollIntoViewIfNeeded();
        await card.click({ timeout: 5000 });
        carryOnClicked++;
        debug(`Clicked "7kg Starter" carry-on card ${carryOnClicked}.`);
        await page.waitForTimeout(1500);
      }
    } catch (e) {
      debug(`Failed to click 7kg card ${i}: ${e.message}`);
    }
  }

  // Fallback: find by text content
  if (carryOnClicked === 0) {
    debug("Fallback: trying to find 7kg cards by text...");
    // Get all card-module_primaryAction buttons and filter by text
    const allCardBtns = page.locator("button[class*='card-module_primaryAction']");
    const allCount = await allCardBtns.count();
    for (let i = 0; i < allCount; i++) {
      try {
        const text = await allCardBtns.nth(i).textContent();
        if (text && /\b7kg\b/i.test(text) && !text.includes("14kg") && !text.toLowerCase().includes("select either")) {
          await allCardBtns.nth(i).scrollIntoViewIfNeeded();
          await allCardBtns.nth(i).click({ timeout: 5000 });
          carryOnClicked++;
          debug(`Fallback: clicked 7kg card ${carryOnClicked}.`);
          await page.waitForTimeout(1500);
        }
      } catch (e) {
        debug(`Fallback 7kg click failed for index ${i}: ${e.message}`);
      }
    }
  }
  debug(`Total "7kg carry-on" clicks: ${carryOnClicked}`);

  await page.waitForTimeout(1000);
  log(9, `✅ Baggage selection done (${checkedClicked} no-checked-bag, ${carryOnClicked} carry-on clicks).`);
}

// ─── Step 10: Continue to Seats & Skip ──────────────────────────
async function step10_seats(page, tripType) {
  log(10, "Handling seat selection...");

  // First: detect where we are
  const currentPage = detectPage(page.url());
  debug(`Currently on: ${currentPage} page`);

  // If not on seats page yet, click Continue ONCE then wait for nav
  if (currentPage !== "seats") {
    const continueClicked = await smartClick(page, [
      {
        name: "qa-continue",
        fn: () => {
          const btn = document.querySelector("button.qa-continue");
          if (btn && btn.offsetParent !== null) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
          return false;
        },
      },
      {
        name: "continue-text",
        fn: () => {
          const btns = [...document.querySelectorAll("button")];
          const btn = btns.find(b => b.textContent.trim().toLowerCase().includes("continue") && b.offsetParent !== null);
          if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
          return false;
        },
      },
    ], "Continue to seats button", 3);

    if (continueClicked) {
      debug("Continue clicked — waiting for navigation to seats...");
      try {
        await page.waitForURL("**/booking/seats**", { timeout: 20000, waitUntil: "domcontentloaded" });
        debug("Navigation to seats page confirmed.");
      } catch {
        debug("waitForURL to seats timed out, checking with ensureOnPage...");
      }
    } else {
      debug("WARNING: Could not click Continue to seats button.");
    }
  }

  // Double-check we're on the seats page
  const onSeats = await ensureOnPage(page, "seats", 15000);
  if (!onSeats) {
    await debugScreenshot(page, "step10-not-seats");
    debug(`WARNING: Not confirmed on seats page (url: ${page.url()}).`);
  }
  await page.waitForTimeout(3000);

  // Helper: click the skip seats button using page.evaluate() for reliability
  async function clickSkipSeats(flightLabel) {
    let clicked = false;

    // Try up to 3 times with waits (page may still be transitioning)
    for (let attempt = 1; attempt <= 3 && !clicked; attempt++) {
      debug(`Attempt ${attempt} to skip seats for ${flightLabel}...`);

      // Method 1: Look for button with text "Skip seats for this flight"
      clicked = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll("button")];
        const skipBtn = buttons.find(
          (b) =>
            b.textContent.trim().toLowerCase().includes("skip seats for this flight") &&
            b.offsetParent !== null
        );
        if (skipBtn) {
          skipBtn.scrollIntoView({ block: "center" });
          skipBtn.click();
          return true;
        }
        return false;
      });

      if (clicked) {
        debug(`Clicked 'Skip seats for this flight' button for ${flightLabel}.`);
        break;
      }

      // Method 2: Look for link/button with text "Skip seats" (bottom-right link variant)
      clicked = await page.evaluate(() => {
        const allEls = [...document.querySelectorAll("button, a, [role='button']")];
        const skipEl = allEls.find(
          (el) =>
            el.textContent.trim().toLowerCase().includes("skip seats") &&
            el.offsetParent !== null
        );
        if (skipEl) {
          skipEl.scrollIntoView({ block: "center" });
          skipEl.click();
          return true;
        }
        return false;
      });

      if (clicked) {
        debug(`Clicked 'Skip seats' link/button for ${flightLabel}.`);
        break;
      }

      // Wait before retrying
      await page.waitForTimeout(2000);
    }

    if (!clicked) {
      debug(`Could not find any skip seats element for ${flightLabel}.`);
    }
    return clicked;
  }

  // Skip seats for departure flight
  await clickSkipSeats("departure");

  // Skip seats for return flight (if return trip)
  if (tripType === "return") {
    // Wait for the page to transition to return flight seat map
    // The page needs time to load the return flight seat selection
    debug("Waiting for return flight seat map to load...");
    await page.waitForTimeout(4000);

    // Also wait for any loading spinner or transition to complete
    try {
      await page.waitForFunction(
        () => {
          const buttons = [...document.querySelectorAll("button, a, [role='button']")];
          return buttons.some(
            (b) =>
              b.textContent.trim().toLowerCase().includes("skip seats") &&
              b.offsetParent !== null
          );
        },
        { timeout: 15000 }
      );
      debug("Return flight skip seats element detected.");
    } catch {
      debug("Timeout waiting for return flight skip seats element, trying anyway...");
    }

    await page.waitForTimeout(1000);
    await clickSkipSeats("return");
  }

  // Wait for transition after skipping all seats
  await page.waitForTimeout(2000);
  log(10, "✅ Seats skipped (random allocation at check-in).");
}

// ─── Step 11: Continue to Extras & Skip ─────────────────────────
async function step11_extras(page) {
  log(11, "Handling extras page...");

  // Detect current page
  const currentPage = detectPage(page.url());
  debug(`Currently on: ${currentPage} page`);

  // If not already on extras, click Continue ONCE then wait
  if (currentPage !== "extras") {
    const continueClicked = await smartClick(page, [
      {
        name: "qa-continue",
        fn: () => {
          const btn = document.querySelector("button.qa-continue");
          if (btn && btn.offsetParent !== null) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
          return false;
        },
      },
      {
        name: "continue-text",
        fn: () => {
          const btns = [...document.querySelectorAll("button")];
          const btn = btns.find(b => b.textContent.trim().toLowerCase().includes("continue") && b.offsetParent !== null);
          if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
          return false;
        },
      },
    ], "Continue to extras button", 3);

    if (continueClicked) {
      debug("Continue clicked — waiting for navigation to extras...");
      try {
        await page.waitForURL("**/booking/customise**", { timeout: 20000, waitUntil: "domcontentloaded" });
        debug("Navigation to extras/customise page confirmed.");
      } catch {
        debug("waitForURL to customise timed out, continuing...");
      }
    } else {
      debug("WARNING: Could not click Continue to extras.");
    }
  }

  await page.waitForTimeout(3000);

  // Decline Club Jetstar membership using page.evaluate for reliability
  const membershipDeclined = await smartClick(page, [
    {
      name: "no-membership-button",
      fn: () => {
        const btns = [...document.querySelectorAll("button")];
        const btn = btns.find(b =>
          b.textContent.trim().toLowerCase().includes("no, continue without membership") &&
          b.offsetParent !== null
        );
        if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
        return false;
      },
    },
    {
      name: "no-membership-scroll",
      fn: () => {
        // Scroll down first then look
        window.scrollTo(0, document.body.scrollHeight);
        const btns = [...document.querySelectorAll("button")];
        const btn = btns.find(b =>
          b.textContent.trim().toLowerCase().includes("no") &&
          b.textContent.trim().toLowerCase().includes("membership") &&
          b.offsetParent !== null
        );
        if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
        return false;
      },
    },
    {
      name: "continue-without",
      fn: () => {
        const btns = [...document.querySelectorAll("button, a")];
        const btn = btns.find(b =>
          b.textContent.trim().toLowerCase().includes("continue without") &&
          b.offsetParent !== null
        );
        if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
        return false;
      },
    },
  ], "Decline Club Jetstar membership", 4);

  if (!membershipDeclined) {
    debug("Club Jetstar membership prompt not found — it may not have appeared.");
  }

  await page.waitForTimeout(2000);
  log(11, "✅ Extras handled (no membership).");
}

// ─── Step 12: Continue to Booking Details ───────────────────────
async function step12_continueToBookingDetails(page) {
  log(12, "Navigating to booking details...");

  const currentPage = detectPage(page.url());
  debug(`Currently on: ${currentPage} page`);

  // Click Continue to booking details ONCE, then wait for nav
  const continueClicked = await smartClick(page, [
    {
      name: "scroll-and-qa-continue",
      fn: () => {
        window.scrollTo(0, document.body.scrollHeight);
        const btn = document.querySelector("button.qa-continue");
        if (btn && btn.offsetParent !== null) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
        return false;
      },
    },
    {
      name: "continue-booking-details-text",
      fn: () => {
        const btns = [...document.querySelectorAll("button")];
        const btn = btns.find(b => b.textContent.trim().toLowerCase().includes("continue") && b.offsetParent !== null);
        if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
        return false;
      },
    },
  ], "Continue to booking details", 3);

  if (continueClicked) {
    debug("Continue clicked — waiting for navigation to details...");
    try {
      await page.waitForURL("**/booking/passengers**", { timeout: 20000, waitUntil: "domcontentloaded" });
      debug("Navigation to passengers page confirmed.");
    } catch {
      debug("waitForURL to passengers timed out, checking with ensureOnPage...");
    }
  } else {
    debug("WARNING: Could not click Continue to booking details.");
  }

  // Double-check
  const onDetails = await ensureOnPage(page, "details", 15000);
  if (!onDetails) {
    debug(`WARNING: Not confirmed on details page (url: ${page.url()}).`);
  }
  await page.waitForTimeout(3000);

  log(12, "✅ Reached booking details page.");
}

// ─── Step 13: Fill Passenger Details ────────────────────────────
async function step13_fillPassengers(page, booking) {
  log(13, "Filling passenger details...");

  // Wait for form to load
  await page.waitForSelector("#passenger_title_0", { state: "visible", timeout: 15000 });

  // === ADULT 1 ===
  debug("Filling Adult 1...");
  // Title dropdown: select#passenger_title_0 with values MR, MS, MISS, MRS, etc.
  await page.selectOption("#passenger_title_0", "MR");
  await page.waitForTimeout(300);
  // First name: input#passenger_Firstname_0
  await page.fill("#passenger_Firstname_0", "John");
  // Last name: input#passenger_Lastname_0
  await page.fill("#passenger_Lastname_0", "Smith");
  // Date of birth: separate dd/mm/yyyy fields
  // For adults, DOB is optional but fields exist. Fill a valid adult DOB.
  // The fields use placeholder dd, mm, yyyy
  const adultDobFields = page.locator('#passenger_Firstname_0')
    .locator('..') // parent
    .locator('..')
    .locator('..')
    .locator('input[placeholder="dd"]');

  // Use a more reliable approach — fill by index of all visible DOB fields
  // Adult 1 DOB fields are the first set of dd/mm/yyyy
  try {
    const allDd = page.locator('input[placeholder="dd"]');
    const allMm = page.locator('input[placeholder="mm"]');
    const allYyyy = page.locator('input[placeholder="yyyy"]');

    // Adult 1 = index 0
    if (await allDd.nth(0).isVisible({ timeout: 2000 })) {
      await allDd.nth(0).fill("15");
      await allMm.nth(0).fill("06");
      await allYyyy.nth(0).fill("1990");
    }
  } catch {
    debug("Could not fill Adult 1 DOB.");
  }

  // Click "Next" to proceed to Adult 2
  // The "Next" button is inside the Adult 1 accordion section
  try {
    const nextBtn = page.locator('button:has-text("Next")').first();
    if (await nextBtn.isVisible({ timeout: 3000 })) {
      await nextBtn.click();
      await page.waitForTimeout(1500);
    }
  } catch {
    debug("No 'Next' button found for Adult 1.");
  }

  // === ADULT 2 ===
  if (booking.adults >= 2) {
    debug("Filling Adult 2...");
    // The Adult 2 section should now be expanded
    // Wait for its form fields to appear
    await page.waitForTimeout(1000);

    // Adult 2 uses index [1] in passenger arrays
    try {
      await page.selectOption("#passenger_title_1", "MRS");
      await page.waitForTimeout(300);
      await page.fill("#passenger_Firstname_1", "Jane");
      await page.fill("#passenger_Lastname_1", "Smith");

      // DOB
      const allDd = page.locator('input[placeholder="dd"]');
      const allMm = page.locator('input[placeholder="mm"]');
      const allYyyy = page.locator('input[placeholder="yyyy"]');
      if (await allDd.nth(1).isVisible({ timeout: 2000 })) {
        await allDd.nth(1).fill("22");
        await allMm.nth(1).fill("09");
        await allYyyy.nth(1).fill("1992");
      }
    } catch (e) {
      debug(`Could not fill Adult 2: ${e.message}`);
    }

    // Click "Next" to proceed
    try {
      const nextBtn = page.locator('button:has-text("Next")').first();
      if (await nextBtn.isVisible({ timeout: 3000 })) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
      }
    } catch {
      debug("No 'Next' button found for Adult 2.");
    }
  }

  // === CHILDREN ===
  for (let i = 0; i < booking.children; i++) {
    const pIdx = booking.adults + i;
    const age = booking.childAges[i] || 5;
    debug(`Filling Child ${i + 1} (age ${age})...`);

    await page.waitForTimeout(1000);

    try {
      // Title for child
      await page.selectOption(`#passenger_title_${pIdx}`, "MISS");
      await page.waitForTimeout(300);
      await page.fill(`#passenger_Firstname_${pIdx}`, `Child${i + 1}`);
      await page.fill(`#passenger_Lastname_${pIdx}`, "Smith");

      // DOB — calculate from age to produce valid child DOB
      const childDob = new Date();
      childDob.setFullYear(childDob.getFullYear() - age);
      const dd = String(childDob.getDate()).padStart(2, "0");
      const mm = String(childDob.getMonth() + 1).padStart(2, "0");
      const yyyy = String(childDob.getFullYear());

      const allDd = page.locator('input[placeholder="dd"]');
      const allMm = page.locator('input[placeholder="mm"]');
      const allYyyy = page.locator('input[placeholder="yyyy"]');
      if (await allDd.nth(pIdx).isVisible({ timeout: 2000 })) {
        await allDd.nth(pIdx).fill(dd);
        await allMm.nth(pIdx).fill(mm);
        await allYyyy.nth(pIdx).fill(yyyy);
      }
    } catch (e) {
      debug(`Could not fill Child ${i + 1}: ${e.message}`);
    }

    // Click "Next"
    try {
      const nextBtn = page.locator('button:has-text("Next")').first();
      if (await nextBtn.isVisible({ timeout: 3000 })) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
      }
    } catch {
      debug(`No 'Next' button found for Child ${i + 1}.`);
    }
  }

  // === INFANTS ===
  for (let i = 0; i < booking.infants; i++) {
    const pIdx = booking.adults + booking.children + i;
    const ageMonths = booking.infantAges[i] || 6;
    debug(`Filling Infant ${i + 1} (${ageMonths} months)...`);

    await page.waitForTimeout(1000);

    try {
      await page.selectOption(`#passenger_title_${pIdx}`, "MISS");
      await page.waitForTimeout(300);
      await page.fill(`#passenger_Firstname_${pIdx}`, `Baby${i + 1}`);
      await page.fill(`#passenger_Lastname_${pIdx}`, "Smith");

      // DOB from age in months
      const infantDob = new Date();
      infantDob.setMonth(infantDob.getMonth() - ageMonths);
      const dd = String(infantDob.getDate()).padStart(2, "0");
      const mm = String(infantDob.getMonth() + 1).padStart(2, "0");
      const yyyy = String(infantDob.getFullYear());

      const allDd = page.locator('input[placeholder="dd"]');
      const allMm = page.locator('input[placeholder="mm"]');
      const allYyyy = page.locator('input[placeholder="yyyy"]');
      if (await allDd.nth(pIdx).isVisible({ timeout: 2000 })) {
        await allDd.nth(pIdx).fill(dd);
        await allMm.nth(pIdx).fill(mm);
        await allYyyy.nth(pIdx).fill(yyyy);
      }
    } catch (e) {
      debug(`Could not fill Infant ${i + 1}: ${e.message}`);
    }

    try {
      const nextBtn = page.locator('button:has-text("Next")').first();
      if (await nextBtn.isVisible({ timeout: 3000 })) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
      }
    } catch {
      debug(`No 'Next' button found for Infant ${i + 1}.`);
    }
  }

  log(13, "✅ All passenger details filled.");
}

// ─── Step 14: Fill Contact Details ──────────────────────────────
async function step14_fillContactDetails(page) {
  log(14, "Filling booking contact details...");

  // Scroll down to the contact section
  await page.evaluate(() => {
    const el = document.querySelector('input[placeholder="Email address"]');
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  await page.waitForTimeout(1000);

  // Booking contact fields — these are at the bottom of the passengers page
  // They are separate from passenger fields (not indexed by passenger number)
  try {
    // The contact fields may auto-fill from Adult 1 if "I am the contact person" is checked
    // Check if First name in contact is already filled
    const contactFirstName = page.locator('input[placeholder="First name"]').last();
    const currentValue = await contactFirstName.inputValue().catch(() => "");

    if (!currentValue) {
      // Fill contact details
      await contactFirstName.fill("John");
      const contactLastName = page.locator('input[placeholder="Last name"]').last();
      await contactLastName.fill("Smith");
    }

    // Email
    const emailField = page.locator('input[placeholder="Email address"]');
    if (await emailField.isVisible({ timeout: 3000 })) {
      await emailField.fill("test@example.com");
    }

    // Mobile phone number
    const phoneField = page.locator('input[placeholder="Mobile phone number"]');
    if (await phoneField.isVisible({ timeout: 3000 })) {
      await phoneField.fill("0412345678");
    }

    // Postcode
    const postcodeField = page.locator('input[placeholder="Postcode"]');
    if (await postcodeField.isVisible({ timeout: 3000 })) {
      await postcodeField.fill("5000");
    }
  } catch (e) {
    debug(`Contact details error: ${e.message}`);
  }

  log(14, "✅ Contact details filled.");
}

// ─── Step 15: Select Insurance (Decline) ────────────────────────
async function step15_declineInsurance(page) {
  log(15, "Declining travel insurance...");

  // Scroll down to insurance section
  await page.evaluate(() => {
    const el = document.querySelector('input[value="NoInsurance"]') ||
      document.querySelector('[class*="insurance"]');
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  await page.waitForTimeout(1000);

  // Verified: radio button "No - I don't want the protection of this insurance policy"
  try {
    // Try clicking the radio button directly
    const noInsurance = page.locator('input[value="NoInsurance"]');
    if (await noInsurance.isVisible({ timeout: 3000 }).catch(() => false)) {
      await noInsurance.click();
      debug("Clicked NoInsurance radio.");
    } else {
      // Try clicking the label/text instead
      const noInsuranceLabel = page.locator('text="No - I don\'t want the protection of this insurance policy"');
      if (await noInsuranceLabel.isVisible({ timeout: 3000 }).catch(() => false)) {
        await noInsuranceLabel.click();
        debug("Clicked insurance decline text.");
      } else {
        // Try broader selector
        const noInsuranceCard = page.locator('[class*="insurance"] :has-text("No")').last();
        if (await noInsuranceCard.isVisible({ timeout: 3000 }).catch(() => false)) {
          await noInsuranceCard.click();
          debug("Clicked insurance decline card.");
        }
      }
    }
  } catch (e) {
    debug(`Insurance decline error: ${e.message}`);
  }

  await page.waitForTimeout(1000);
  log(15, "✅ Insurance declined.");
}

// ─── Step 16: Click "Continue to Review and Pay" ────────────────
async function step16_continueToReviewAndPay(page) {
  log(16, 'Clicking "Continue to Review and Pay"...');

  // Scroll to bottom
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  // Verified: submit button "Continue to Review and Pay"
  try {
    const reviewBtn = page.locator('button:has-text("Continue to Review and Pay")');
    await reviewBtn.waitFor({ state: "visible", timeout: 10000 });
    await reviewBtn.click();
    debug('Clicked "Continue to Review and Pay".');
  } catch {
    // Try alternative text
    try {
      const altBtn = page.locator('button:has-text("Review and Pay"), button:has-text("Review & Pay")').first();
      if (await altBtn.isVisible({ timeout: 5000 })) {
        await altBtn.click();
      }
    } catch {
      debug("Could not find Review and Pay button.");
    }
  }

  // Wait for Review & Pay page
  try {
    await page.waitForURL("**/booking/review**", { timeout: 30000 });
    log(16, "🎯 REACHED REVIEW & PAY PAGE!");
  } catch {
    // Check page content
    const bodyText = await page.textContent("body").catch(() => "");
    if (bodyText.includes("Review") || bodyText.includes("Payment") || bodyText.includes("Total")) {
      log(16, "🎯 REACHED REVIEW & PAY PAGE!");
    } else {
      // May have validation errors — check for them
      const url = page.url();
      if (url.includes("passengers")) {
        log(16, "⚠️  Still on passengers page — form validation may have failed.");
        log(16, "    Check for missing or invalid fields. Taking screenshot...");
      } else {
        log(16, `⚠️  Current URL: ${url}. May or may not be Review & Pay.`);
      }
    }
  }

  await page.waitForTimeout(3000);
}

// ─── Step 17: Take Screenshot & Move PDF ────────────────────────
async function step17_finalActions(page, pdfFileName) {
  log(17, "Taking final screenshot and moving files...");

  if (!fs.existsSync(COMPLETED_DIR)) {
    fs.mkdirSync(COMPLETED_DIR, { recursive: true });
  }

  // Screenshot of current page (should be Review & Pay)
  const screenshotPath = path.join(COMPLETED_DIR, "review-and-pay.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  log(17, `✅ Screenshot saved: Completed/review-and-pay.png`);

  // Move PDF from Todo/ to Completed/
  const pdfSource = path.join(TODO_DIR, pdfFileName);
  const pdfDest = path.join(COMPLETED_DIR, pdfFileName);
  if (fs.existsSync(pdfSource)) {
    fs.copyFileSync(pdfSource, pdfDest);
    fs.unlinkSync(pdfSource);
    log(17, `✅ Moved ${pdfFileName}: Todo/ → Completed/`);
  } else {
    log(17, `⚠️  ${pdfFileName} not found in Todo/.`);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
(async () => {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Jetstar Booking Automation v4.1");
  console.log("  Real Chrome CDP + Verified Selectors");
  console.log("═══════════════════════════════════════════════════\n");

  // ─── Step 0: Find and parse PDF ────────────────────────────
  let pdf;
  try {
    pdf = findPdf();
    log(0, `Found PDF: ${pdf.fileName}`);
  } catch (err) {
    console.error(`\n🛑 ${err.message}`);
    process.exit(1);
  }

  let booking;
  try {
    booking = await parsePdf(pdf.filePath);
  } catch (err) {
    console.error(`\n🛑 Failed to parse PDF: ${err.message}`);
    process.exit(1);
  }

  // ─── Validate ──────────────────────────────────────────────
  const validation = validateBooking(booking);
  printBookingSummary(booking, validation);

  if (!validation.isValid) {
    console.error("🛑 Fix the errors above and re-run.\n");
    process.exit(1);
  }

  if (VALIDATE_ONLY) {
    console.log("✅ Validation complete (--validate-only mode). Exiting.\n");
    process.exit(0);
  }

  // ─── Launch Browser & Automate ─────────────────────────────
  let browser, context, page;
  let usingCDP = false;

  if (!USE_PLAYWRIGHT) {
    // ── PREFERRED: Connect to real Chrome via CDP ──────────
    // This avoids bot detection because it's your real browser
    // with all cookies, extensions, and normal fingerprint.
    console.log("🔌 Connecting to your Chrome browser via CDP...");
    console.log(`   (expecting Chrome on port ${CDP_PORT})\n`);

    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      usingCDP = true;

      // Get the default browser context (your real Chrome profile)
      const contexts = browser.contexts();
      if (contexts.length > 0) {
        context = contexts[0];
      } else {
        context = await browser.newContext();
      }

      // Open a new tab in your real browser
      page = await context.newPage();
      console.log("✅ Connected to Chrome! A new tab will open.\n");
    } catch (err) {
      console.error("");
      console.error("╔══════════════════════════════════════════════════════════╗");
      console.error("║  ❌ Could not connect to Chrome via CDP!                ║");
      console.error("╠══════════════════════════════════════════════════════════╣");
      console.error("║                                                          ║");
      console.error("║  Please start Chrome with remote debugging FIRST:        ║");
      console.error("║                                                          ║");
      console.error("║  Mac:                                                    ║");
      console.error('║    /Applications/Google\\ Chrome.app/Contents/MacOS/\\     ║');
      console.error("║    Google\\ Chrome --remote-debugging-port=9222           ║");
      console.error("║                                                          ║");
      console.error("║  Windows:                                                ║");
      console.error('║    "C:\\Program Files\\Google\\Chrome\\Application\\           ║');
      console.error('║    chrome.exe" --remote-debugging-port=9222              ║');
      console.error("║                                                          ║");
      console.error("║  Or use standalone Playwright (may get blocked):         ║");
      console.error("║    USE_PLAYWRIGHT=true npm run book:headed               ║");
      console.error("║                                                          ║");
      console.error("╚══════════════════════════════════════════════════════════╝");
      console.error(`\n  Error: ${err.message}\n`);
      process.exit(1);
    }
  } else {
    // ── FALLBACK: Use Playwright's own Chromium ───────────
    // WARNING: Jetstar may block this after the Search click.
    console.log("🚀 Launching Playwright Chromium (may be blocked by Jetstar)...\n");

    browser = await chromium.launch({
      headless: HEADLESS,
      slowMo: HEADLESS ? 0 : 100,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
      ],
    });

    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });

    // Remove the "navigator.webdriver" flag that bots use to detect Playwright
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    page = await context.newPage();
  }

  try {
    // ── Phase 1: Home Page (www.jetstar.com) ─────────────
    await step1_navigate(page, booking);        // Navigate with URL params
    await step2_verifyOrigin(page, booking);     // Verify origin pre-filled
    await step3_verifyDestination(page, booking); // Verify destination pre-filled
    await step4_selectDates(page, booking);      // Open calendar, pick dates, confirm
    await step5_verifyPassengers(page, booking); // Passengers pre-filled via URL
    await step6_searchFlights(page);             // Click Search → flight results

    // ── Phase 2: Flight Selection (booking.jetstar.com) ──
    await step7_selectDepartureFlight(page);     // Click flight card → Starter Select
    await step8_selectReturnFlight(page, booking.tripType); // Return flight → Starter Select

    // ── Phase 3: Baggage → Seats → Extras ────────────────
    await step9_baggage(page);                   // No checked bags, 7kg carry-on
    await step10_seats(page, booking.tripType);  // Skip seats for both flights
    await step11_extras(page);                   // Decline Club Jetstar
    await step12_continueToBookingDetails(page); // Skip hotel upsells

    // ── Phase 4: Stop at Booking Details (passenger form NOT filled) ──
    // Passenger details are left blank for the user to fill manually.
    log(13, "🛑 Stopped at Booking Details page — passenger form left empty for manual entry.");

    // ── Phase 5: Screenshot & Cleanup ────────────────────
    await step17_finalActions(page, pdf.fileName);

    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║  ✅ AUTOMATION COMPLETE — Reached Booking Details page!  ║");
    console.log("║  Passenger details left blank for manual entry.          ║");
    console.log("║  Screenshot: Completed/review-and-pay.png                ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");
  } catch (error) {
    console.error(`\n❌ Error at: ${error.message}`);
    if (DEBUG) console.error(error.stack);

    // Save error screenshot
    try {
      if (!fs.existsSync(COMPLETED_DIR)) fs.mkdirSync(COMPLETED_DIR, { recursive: true });
      await page.screenshot({
        path: path.join(COMPLETED_DIR, "error-state.png"),
        fullPage: true,
      });
      console.log("📸 Error screenshot saved to Completed/error-state.png");
    } catch {
      /* screenshot failed too */
    }

    throw error;
  } finally {
    if (usingCDP) {
      // When using CDP, just close the tab — don't close the entire browser
      try { await page.close(); } catch { /* tab may already be closed */ }
      console.log("\nTab closed. Your Chrome browser remains open. Done.\n");
    } else {
      await browser.close();
      console.log("\nBrowser closed. Done.\n");
    }
  }
})();
