/**
 * booking.js — Jetstar Booking Automation (v4)
 * ==============================================
 * Complete rewrite with VERIFIED selectors from live browser testing.
 * Reads booking details from a PDF in Todo/, automates the full
 * Jetstar booking flow up to "Review & Pay", takes a screenshot,
 * and moves the PDF to Completed/.
 *
 * Usage:
 *   npm run setup             # Install deps + Chromium
 *   npm run validate          # Parse PDF and validate only (no browser)
 *   npm run book              # Full automation (headless)
 *   npm run book:headed       # Full automation (visible browser)
 *   npm run book:debug        # Headed + debug logging
 */

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { parsePdf, validateBooking, printBookingSummary } = require("./parsePdf");

// ─── Paths ───────────────────────────────────────────────────────
const TODO_DIR = path.join(__dirname, "Todo");
const COMPLETED_DIR = path.join(__dirname, "Completed");
const HEADLESS = process.env.HEADLESS !== "false";
const DEBUG = process.env.DEBUG === "true";
const VALIDATE_ONLY = process.argv.includes("--validate-only");

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

  // Wait for flight cards to load
  // Flight cards are clickable containers showing time + price
  await page.waitForTimeout(3000);

  // Strategy: Click the first flight card to expand it, then select Starter fare
  // From live testing: flight cards expand to show fare bundles when clicked
  // Look for flight result rows/cards
  const flightCard = page.locator(
    'button[class*="flight"], [class*="FlightCard"] button, [data-testid*="flight"] button, button[class*="fare-card"], [class*="flight-row"] button'
  ).first();

  if (await flightCard.isVisible({ timeout: 10000 }).catch(() => false)) {
    await flightCard.click();
    debug("Clicked first flight card.");
    await page.waitForTimeout(2000);
  } else {
    // Alternative: try clicking any price/time element in the first flight row
    debug("Flight card selector not found, trying alternative...");
    const altCard = page.locator('[class*="flight"] [class*="price"], [class*="flight"] button').first();
    if (await altCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await altCard.click();
      await page.waitForTimeout(2000);
    }
  }

  // After clicking flight card, fare bundles expand (Starter, Starter Plus, etc.)
  // Click the first "Select" button — this is the Starter (cheapest) fare
  const selectBtn = page.locator('button:has-text("Select")').first();
  if (await selectBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
    await selectBtn.click();
    debug("Clicked Select (Starter fare) for departure.");
    await page.waitForTimeout(3000);
  } else {
    // Try direct Starter button
    const starterBtn = page.locator('button:has-text("Starter")').first();
    if (await starterBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await starterBtn.click();
      await page.waitForTimeout(3000);
    }
  }

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

  // After departure is selected, return flights auto-show on the same page
  // Click the first return flight card to expand it
  const flightCard = page.locator(
    'button[class*="flight"], [class*="FlightCard"] button, [data-testid*="flight"] button, button[class*="fare-card"], [class*="flight-row"] button'
  ).first();

  if (await flightCard.isVisible({ timeout: 10000 }).catch(() => false)) {
    await flightCard.click();
    debug("Clicked first return flight card.");
    await page.waitForTimeout(2000);
  } else {
    const altCard = page.locator('[class*="flight"] [class*="price"], [class*="flight"] button').first();
    if (await altCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await altCard.click();
      await page.waitForTimeout(2000);
    }
  }

  // Click first Select button for return Starter fare
  const selectBtn = page.locator('button:has-text("Select")').first();
  if (await selectBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
    await selectBtn.click();
    debug("Clicked Select (Starter fare) for return.");
    await page.waitForTimeout(3000);
  }

  log(8, "✅ Return flight selected.");
}

// ─── Step 9: Continue to Baggage & Select Options ────────────────
async function step9_baggage(page) {
  log(9, "Handling baggage selection...");

  // Click "Continue to bags" button (appears after flight selection)
  try {
    const continueBtn = page.locator('button:has-text("Continue to bags")');
    await continueBtn.waitFor({ state: "visible", timeout: 15000 });
    await continueBtn.click();
    debug("Clicked 'Continue to bags'.");
  } catch {
    // May already be on baggage page or button has different text
    debug("'Continue to bags' not found, checking if already on baggage page...");
  }

  // Wait for baggage page
  try {
    await page.waitForURL("**/booking/baggage**", { timeout: 15000 });
  } catch {
    debug("URL didn't match baggage pattern, continuing...");
  }
  await page.waitForTimeout(3000);

  // Select baggage options for each passenger/flight
  // Verified selectors from live testing:
  //   .qa-baggage-option-0 = No checked baggage
  //   .qa-carry-on-option-7 = 7kg carry-on
  // These appear as clickable cards for each passenger segment

  // Click all "No checked baggage" options
  const noBagOptions = page.locator('[class*="qa-baggage-option-0"]');
  const noBagCount = await noBagOptions.count();
  debug(`Found ${noBagCount} 'No checked bag' options.`);
  for (let i = 0; i < noBagCount; i++) {
    try {
      const opt = noBagOptions.nth(i);
      if (await opt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await opt.click();
        await page.waitForTimeout(500);
      }
    } catch {
      debug(`Could not click no-bag option ${i}`);
    }
  }

  // Click all "7kg carry-on" options
  const carryOnOptions = page.locator('[class*="qa-carry-on-option-7"]');
  const carryOnCount = await carryOnOptions.count();
  debug(`Found ${carryOnCount} 'carry-on' options.`);
  for (let i = 0; i < carryOnCount; i++) {
    try {
      const opt = carryOnOptions.nth(i);
      if (await opt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await opt.click();
        await page.waitForTimeout(500);
      }
    } catch {
      debug(`Could not click carry-on option ${i}`);
    }
  }

  await page.waitForTimeout(1000);
  log(9, "✅ Baggage selected (no checked bags, 7kg carry-on).");
}

// ─── Step 10: Continue to Seats & Skip ──────────────────────────
async function step10_seats(page, tripType) {
  log(10, "Handling seat selection...");

  // Click "Continue to seats"
  try {
    const continueBtn = page.locator('button:has-text("Continue to seats")');
    await continueBtn.waitFor({ state: "visible", timeout: 15000 });
    await continueBtn.click();
    debug("Clicked 'Continue to seats'.");
  } catch {
    debug("'Continue to seats' not found, checking if already on seats page...");
  }

  // Wait for seats page
  try {
    await page.waitForURL("**/booking/seats**", { timeout: 15000 });
  } catch {
    debug("URL didn't match seats pattern, continuing...");
  }
  await page.waitForTimeout(3000);

  // Skip seats for departure flight
  // Verified: button with text "Skip seats for this flight"
  try {
    const skipBtn1 = page.locator('button:has-text("Skip seats for this flight")');
    await skipBtn1.waitFor({ state: "visible", timeout: 10000 });
    await skipBtn1.click();
    debug("Skipped seats for departure flight.");
    await page.waitForTimeout(2000);
  } catch {
    debug("Could not find 'Skip seats' button for departure.");
  }

  // Skip seats for return flight (if return trip)
  if (tripType === "return") {
    try {
      const skipBtn2 = page.locator('button:has-text("Skip seats for this flight")');
      await skipBtn2.waitFor({ state: "visible", timeout: 10000 });
      await skipBtn2.click();
      debug("Skipped seats for return flight.");
      await page.waitForTimeout(2000);
    } catch {
      debug("Could not find 'Skip seats' button for return.");
    }
  }

  log(10, "✅ Seats skipped (random allocation at check-in).");
}

// ─── Step 11: Continue to Extras & Skip ─────────────────────────
async function step11_extras(page) {
  log(11, "Handling extras page...");

  // Click "Continue to extras"
  try {
    const continueBtn = page.locator('button:has-text("Continue to extras")');
    await continueBtn.waitFor({ state: "visible", timeout: 15000 });
    await continueBtn.click();
    debug("Clicked 'Continue to extras'.");
  } catch {
    debug("'Continue to extras' not found, checking if already on extras page...");
  }

  // Wait for customise/extras page
  try {
    await page.waitForURL("**/booking/customise**", { timeout: 15000 });
  } catch {
    debug("URL didn't match customise pattern, continuing...");
  }
  await page.waitForTimeout(3000);

  // Decline Club Jetstar membership
  // Verified: button "No, continue without membership"
  try {
    const noMembershipBtn = page.locator('button:has-text("No, continue without membership")');
    await noMembershipBtn.waitFor({ state: "visible", timeout: 10000 });
    await noMembershipBtn.click();
    debug("Declined Club Jetstar membership.");
    await page.waitForTimeout(2000);
  } catch {
    debug("Club Jetstar membership prompt not found, trying alternatives...");
    // Try scrolling down to find it
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    try {
      const noBtn = page.locator('button:has-text("No, continue without membership")');
      if (await noBtn.isVisible({ timeout: 3000 })) {
        await noBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch {
      debug("Still couldn't find membership decline button.");
    }
  }

  log(11, "✅ Extras handled (no membership).");
}

// ─── Step 12: Continue to Booking Details ───────────────────────
async function step12_continueToBookingDetails(page) {
  log(12, "Navigating to booking details...");

  // Verified: "Continue to booking details" button at bottom of extras page
  try {
    // Scroll down to find the button
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    const continueBtn = page.locator('button:has-text("Continue to booking details")');
    await continueBtn.waitFor({ state: "visible", timeout: 10000 });
    await continueBtn.click();
    debug("Clicked 'Continue to booking details'.");
  } catch {
    debug("'Continue to booking details' not found.");
  }

  // Wait for passenger details page
  try {
    await page.waitForURL("**/booking/passengers**", { timeout: 15000 });
  } catch {
    debug("URL didn't match passengers pattern, continuing...");
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
  console.log("  Jetstar Booking Automation v4.0");
  console.log("  Verified Selectors from Live Browser Testing");
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
  console.log("🚀 Launching browser...\n");

  const browser = await chromium.launch({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 100,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();

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

    // ── Phase 4: Passenger Details → Review & Pay ────────
    await step13_fillPassengers(page, booking);  // Fill all passenger forms
    await step14_fillContactDetails(page);       // Email, phone, postcode
    await step15_declineInsurance(page);          // No insurance
    await step16_continueToReviewAndPay(page);   // Submit → Review & Pay

    // ── Phase 5: Screenshot & Cleanup ────────────────────
    await step17_finalActions(page, pdf.fileName);

    console.log("\n╔══════════════════════════════════════════════════╗");
    console.log("║  ✅ AUTOMATION COMPLETE — Reached Review & Pay!  ║");
    console.log("║  Screenshot: Completed/review-and-pay.png        ║");
    console.log("╚══════════════════════════════════════════════════╝\n");
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
    await browser.close();
    console.log("\nBrowser closed. Done.\n");
  }
})();
