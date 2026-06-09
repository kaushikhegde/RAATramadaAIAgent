#!/usr/bin/env node
/**
 * tramada-run.js — Standalone Tramada TTMS automation (Playwright)
 *
 * Commands:
 *   node tramada-run.js search          Search bookings with status "Booked"
 *   node tramada-run.js add             Add a new booking for GRAY/SPIDER MS
 *
 * Prerequisites:
 *   npm install playwright
 *   npx playwright install chromium
 */

const { chromium } = require("playwright");

const TRAMADA_BASE_URL = process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
//  Login helper — waits for manual login if needed
// ═══════════════════════════════════════════════════════════════

async function ensureLoggedIn(page) {
  console.log("🌐 Opening Tramada...");
  await page.goto(`${TRAMADA_BASE_URL}/login.htm`, { waitUntil: "networkidle" });

  const title = await page.title();
  if (title.toLowerCase().includes("login") || page.url().includes("login.htm")) {
    console.log("🔐 Login page — please log in manually in the browser...");
    console.log("   (waiting up to 2 minutes)");
    await page.waitForURL(url => !url.toString().includes("login.htm"), { timeout: 120000 });
    await page.waitForLoadState("networkidle");
    console.log("✅ Logged in!");
  } else {
    console.log("✅ Already logged in");
  }
  await sleep(1000);
}

// ═══════════════════════════════════════════════════════════════
//  Command: search — Find bookings with status "Booked"
// ═══════════════════════════════════════════════════════════════

async function searchBooked(page) {
  console.log("📂 Navigating to Bookings → Search...");
  await page.goto(`${TRAMADA_BASE_URL}/booking/booking-search.htm`, { waitUntil: "networkidle" });
  await page.waitForSelector("#searchForm_bookingStatus", { timeout: 10000 });

  console.log('🔍 Selecting status "Booked" and searching...');
  await page.selectOption("#searchForm_bookingStatus", "BOOKED");
  await page.click("#searchButton");
  await page.waitForLoadState("networkidle");
  await sleep(1500);

  const bookings = await page.evaluate(() => {
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const header = table.querySelector("tr");
      if (header && header.textContent.includes("Bkg No")) {
        const rows = table.querySelectorAll("tr");
        const results = [];
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 6) {
            results.push({
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
        return results;
      }
    }
    return [];
  });

  console.log(`\n📋 Found ${bookings.length} booking(s) with status "Booked":\n`);
  if (bookings.length > 0) {
    console.table(bookings);
  } else {
    console.log("  (no bookings found)");
  }
}

// ═══════════════════════════════════════════════════════════════
//  Command: add — Add a new booking for GRAY/SPIDER MS
// ═══════════════════════════════════════════════════════════════

/*
  Booking details (from the form exploration):
  ─────────────────────────────────────────────
  Client Code:     GRAY/SPIDER MS  (autocomplete — type "GRAY/SPIDER" then pick from dropdown)
  Auto-populated:  Booking Account → Corporate, Branch → [MIL] RAA Mile End,
                   Debtor → [RAA RETAIL] RAA of SA Limited

  MANDATORY fields (highlighted yellow on validation):
    - Bank Account         select  #bankAccount
    - Departure Date       text    #departureDate       (dd-mm-yyyy)
    - Booking Type         select  #bookingTypeCode
    - Booking Source       select  #sourceTypeCode
    - Destination          select  #destinationTypeCode
    - Dom/Int              select  #domIntCode

  Optional but useful:
    - Return Date          text    #returnDate          (dd-mm-yyyy)
    - Itinerary Summary    text    #itinerarySummary
    - Cabin Class          select  #cabinClassTypeCode
    - Primary Destination  text    #destinationCityCode
*/

async function addBooking(page, bookingData) {
  const {
    clientCode     = "GRAY/SPIDER",
    departureDate,                       // required, dd-mm-yyyy
    returnDate     = "",                 // optional
    bankAccount    = "1",                // "1" = [TRUST] Trust Account
    bookingType    = "LEISURE",          // CORPORATE | GROUPS | LEISURE
    bookingSource  = "EML",             // EML = Email
    destination    = "DOM",              // DOM = Australia, ASIA, EUROPE, etc.
    domInt         = "DOMESTIC",         // DOMESTIC | INTERNATIONAL
    cabinClass     = "ECON",            // ECON | BUS | FIRST | PECON
    itinerary      = "",                 // free text
    primaryDest    = "",                 // city code free text
  } = bookingData;

  if (!departureDate) {
    console.error("❌ departureDate is required (format: dd-mm-yyyy)");
    process.exit(1);
  }

  // ── Step 1: Navigate to Add Booking page ──
  console.log("📂 Navigating to Bookings → Add...");
  await page.goto(`${TRAMADA_BASE_URL}/booking/booking-profile.htm?mode=ADD`, { waitUntil: "networkidle" });
  await page.waitForSelector("#client", { timeout: 10000 });
  console.log("✅ On Booking Add page");

  // ── Step 2: Enter Client Code via autocomplete ──
  console.log(`👤 Entering client code: ${clientCode}...`);
  const clientInput = page.locator("#client");
  await clientInput.click();
  await clientInput.fill("");
  // Type character by character to trigger autocomplete
  await page.type("#client", clientCode, { delay: 80 });
  await sleep(2000); // wait for autocomplete dropdown

  // Click the matching autocomplete option
  // The dropdown is a list of items — find and click the one containing our client code
  const autocompleteItem = page.locator(`.autocomplete-suggestions div, .ac_results li, ul.ui-autocomplete li, div[class*="autocomplete"] div`).filter({ hasText: clientCode });
  const itemCount = await autocompleteItem.count();

  if (itemCount > 0) {
    console.log(`   Found ${itemCount} autocomplete match(es), clicking first...`);
    await autocompleteItem.first().click();
  } else {
    // Fallback: the autocomplete might use a different structure. Let's try a generic approach
    console.log("   Trying fallback autocomplete selection...");
    // Look for any visible dropdown near the client field
    const anyDropdown = page.locator('[class*="autocomplet"] *, [id*="autocomplet"] *, .ac_results *').filter({ hasText: clientCode });
    const ddCount = await anyDropdown.count();
    if (ddCount > 0) {
      await anyDropdown.first().click();
    } else {
      // Last resort: press down arrow and enter
      console.log("   Using keyboard to select from autocomplete...");
      await page.keyboard.press("ArrowDown");
      await sleep(300);
      await page.keyboard.press("Enter");
    }
  }

  await sleep(2000); // wait for form to populate after client selection
  await page.waitForLoadState("networkidle");

  // Verify client was selected (fields should auto-populate)
  const clientValue = await page.inputValue("#client");
  console.log(`   Client set to: ${clientValue}`);

  // ── Step 3: Fill mandatory fields ──
  console.log("📝 Filling booking details...");

  // Bank Account
  console.log("   Bank Account...");
  await page.selectOption("#bankAccount", bankAccount);

  // Departure Date
  console.log(`   Departure Date: ${departureDate}`);
  await page.fill("#departureDate", departureDate);

  // Return Date (optional)
  if (returnDate) {
    console.log(`   Return Date: ${returnDate}`);
    await page.fill("#returnDate", returnDate);
  }

  // Booking Type
  console.log(`   Booking Type: ${bookingType}`);
  await page.selectOption("#bookingTypeCode", bookingType);

  // Booking Source
  console.log(`   Booking Source: ${bookingSource}`);
  await page.selectOption("#sourceTypeCode", bookingSource);

  // Destination
  console.log(`   Destination: ${destination}`);
  await page.selectOption("#destinationTypeCode", destination);

  // Dom/Int
  console.log(`   Dom/Int: ${domInt}`);
  await page.selectOption("#domIntCode", domInt);

  // ── Step 4: Fill optional fields ──
  if (cabinClass) {
    console.log(`   Cabin Class: ${cabinClass}`);
    await page.selectOption("#cabinClassTypeCode", cabinClass);
  }

  if (itinerary) {
    console.log(`   Itinerary Summary: ${itinerary}`);
    await page.fill("#itinerarySummary", itinerary);
  }

  if (primaryDest) {
    console.log(`   Primary Destination: ${primaryDest}`);
    await page.fill("#destinationCityCode", primaryDest);
  }

  await sleep(500);

  // ── Step 5: Click Save ──
  console.log("💾 Saving booking...");
  await page.click("#save");
  await page.waitForLoadState("networkidle");
  await sleep(2000);

  // ── Step 6: Check for errors or success ──
  const errors = await page.evaluate(() => {
    // Error messages appear in a red bordered box at the top
    const errorBox = document.querySelector('div[style*="border"][style*="red"], .errorMessages, fieldset[class*="error"]');
    if (errorBox) {
      return errorBox.textContent.trim().split('\n').map(s => s.trim()).filter(s => s.length > 0);
    }
    // Also check for individual error messages
    const errLinks = document.querySelectorAll('a[href*="error"], span[class*="error"]');
    if (errLinks.length > 0) {
      return Array.from(errLinks).map(e => e.textContent.trim());
    }
    return [];
  });

  if (errors.length > 0) {
    console.log("\n⚠️  Validation errors:");
    errors.forEach(e => console.log(`   - ${e}`));
    console.log("\n   Fix the errors above and try again.");
    return false;
  }

  // Check if URL changed from ADD mode (indicates success)
  const newUrl = page.url();
  const newTitle = await page.title();
  if (!newUrl.includes("mode=ADD")) {
    console.log(`\n✅ Booking saved successfully!`);
    console.log(`   Page: ${newTitle}`);
    console.log(`   URL:  ${newUrl}`);

    // Try to extract the new booking number
    const bkgNo = await page.evaluate(() => {
      // Look for booking number in the page after save
      const text = document.body.innerText;
      const match = text.match(/Booking\s+(\d+)/i) || text.match(/Bkg\s+No\.?\s*(\d+)/i);
      return match ? match[1] : null;
    });

    if (bkgNo) {
      console.log(`   Booking No: ${bkgNo}`);
    }
    return true;
  }

  console.log("\n⚠️  Save may not have completed. Check the browser.");
  return false;
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const command = process.argv[2] || "add";

  console.log("🚀 Launching browser...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await ensureLoggedIn(page);

    if (command === "search") {
      await searchBooked(page);

    } else if (command === "add") {
      // Booking details — edit these or pass via env vars
      await addBooking(page, {
        clientCode:    process.env.CLIENT_CODE    || "GRAY/SPIDER",
        departureDate: process.env.DEP_DATE       || "30-04-2026",
        returnDate:    process.env.RET_DATE        || "10-05-2026",
        bankAccount:   process.env.BANK_ACCOUNT   || "1",          // [TRUST] Trust Account
        bookingType:   process.env.BOOKING_TYPE   || "LEISURE",
        bookingSource: process.env.BOOKING_SOURCE || "EML",        // Email
        destination:   process.env.DESTINATION    || "DOM",         // Australia
        domInt:        process.env.DOM_INT        || "DOMESTIC",
        cabinClass:    process.env.CABIN_CLASS    || "ECON",
        itinerary:     process.env.ITINERARY      || "ADL-SYD-ADL",
        primaryDest:   process.env.PRIMARY_DEST   || "SYD",
      });

    } else {
      console.log(`Unknown command: ${command}`);
      console.log("Usage: node tramada-run.js [search|add]");
      process.exit(1);
    }

    // Keep browser open
    console.log("\n👀 Browser left open — press Ctrl+C to exit.");
    await new Promise(() => {});

  } catch (err) {
    console.error("❌ Error:", err.message);
    try {
      await page.screenshot({ path: "tramada-error.png" });
      console.log("📸 Screenshot saved to tramada-error.png");
    } catch {}
    process.exit(1);
  }
}

main();
