/**
 * tramada-automator.js — Tramada TTMS Booking Automation
 * =======================================================
 * Automates the Tramada Travel Management System:
 *  1. Login to Tramada TTMS
 *  2. Navigate to Bookings → Search
 *  3. Select Booking Status "Booked"
 *  4. Click Search to get results
 *  5. Extract and return booking data
 *
 * Uses the same puppeteer-extra + stealth stack as automator.js
 */

const { exec } = require("child_process");

// ── Browser deps — try puppeteer-extra first, fall back to plain puppeteer-core ──
let puppeteerLib = null;
let usingExtra = false;
try {
  const { addExtra } = require("puppeteer-extra");
  const rebrowserPuppeteer = require("puppeteer-core");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  puppeteerLib = addExtra(rebrowserPuppeteer);
  puppeteerLib.use(StealthPlugin());
  usingExtra = true;
  console.log("✅ [tramada] puppeteer-extra + stealth loaded");
} catch (e) {
  try {
    puppeteerLib = require("puppeteer-core");
    console.log("✅ [tramada] puppeteer-core loaded (no stealth — fine for Tramada)");
  } catch (e2) {
    console.warn(`⚠️ [tramada] No puppeteer available: ${e2.message}`);
  }
}

const DEBUG = process.env.DEBUG === "true";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const TRAMADA_BASE_URL = process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";

function debug(msg) {
  if (DEBUG) console.log(`  [tramada] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════
//  TramadaBrowser — puppeteer-extra wrapper for Tramada
// ═══════════════════════════════════════════════════════════════

class TramadaBrowser {
  constructor(port = CDP_PORT, host = CDP_HOST) {
    this.port = port;
    this.host = host;
    this.browser = null;
    this.page = null;
  }

  async launch() {
    if (!puppeteerLib) {
      throw new Error("No puppeteer library available. Run: npm install puppeteer-core");
    }

    const chromePath = process.env.CHROME_PATH || this._findChrome();
    const cdpMode = process.env.CDP_MODE || "external";

    if (cdpMode === "internal") {
      // INTERNAL MODE: Launch Chrome (used inside Docker)
      debug(`Launching internal Chrome at ${chromePath}...`);

      this.browser = await puppeteerLib.launch({
        executablePath: chromePath,
        headless: false,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--window-size=1280,900",
          "--start-maximized",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-blink-features=AutomationControlled",
          "--lang=en-AU",
          `--display=${process.env.DISPLAY || ":99"}`,
          `--remote-debugging-port=${this.port}`,
          "--remote-debugging-address=0.0.0.0",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
        defaultViewport: null,
      });

      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();
    } else {
      // EXTERNAL MODE: Connect to user's already-running Chrome
      debug(`Connecting to Chrome at ${this.host}:${this.port}...`);
      const cdpUrl = `http://${this.host}:${this.port}`;
      let versionInfo;
      try {
        const res = await fetch(`${cdpUrl}/json/version`);
        versionInfo = await res.json();
      } catch (e) {
        throw new Error(
          `Cannot reach Chrome at ${cdpUrl}. Start the shared CDP Chrome first:\n` +
          `  npm run start:chrome\n` +
          `\n` +
          `That launches a Chrome on port ${this.port} with the shared persistent profile\n` +
          `(.jetstar-profile-cdp/) used by both Jetstar and Tramada automation.`
        );
      }

      const wsUrl = versionInfo.webSocketDebuggerUrl;
      if (!wsUrl) throw new Error("No webSocketDebuggerUrl from Chrome");

      debug(`Connecting via WebSocket: ${wsUrl}`);
      this.browser = await puppeteerLib.connect({ browserWSEndpoint: wsUrl });
      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();
    }

    // Set reasonable timeouts
    this.page.setDefaultNavigationTimeout(60000);
    this.page.setDefaultTimeout(30000);

    debug("Browser ready");
    return this;
  }

  _findChrome() {
    const { execSync } = require("child_process");
    const platform = process.platform;

    // Common Chrome paths by platform
    const candidates = platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : platform === "win32"
      ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
         "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"]
      : ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];

    for (const p of candidates) {
      try {
        const fs = require("fs");
        if (fs.existsSync(p)) return p;
      } catch {}
    }

    // Try `which`
    try {
      return execSync("which google-chrome-stable || which google-chrome || which chromium-browser 2>/dev/null")
        .toString().trim().split("\n")[0];
    } catch {}

    return "/usr/bin/google-chrome-stable"; // fallback
  }

  async close() {
    try {
      if (this.browser) {
        const cdpMode = process.env.CDP_MODE || "external";
        if (cdpMode === "internal") {
          await this.browser.close();
        } else {
          this.browser.disconnect();
        }
      }
    } catch (e) {
      debug(`Close error: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Tramada Automation Steps
// ═══════════════════════════════════════════════════════════════

/**
 * Login to Tramada TTMS
 */
async function tramadaLogin(page, username, password, notify) {
  notify(10, "Navigating to Tramada login page...");
  await page.goto(`${TRAMADA_BASE_URL}/login.htm`, { waitUntil: "networkidle2" });
  await sleep(1000);

  // Check we're on the login page
  const pageTitle = await page.title();
  debug(`Page title: ${pageTitle}`);

  if (!pageTitle.toLowerCase().includes("login")) {
    // Might already be logged in
    if (pageTitle.toLowerCase().includes("notice board") || pageTitle.toLowerCase().includes("booking")) {
      notify(15, "Already logged in to Tramada");
      return true;
    }
    throw new Error(`Unexpected page: ${pageTitle}`);
  }

  notify(15, "Entering credentials...");

  // Fill username (the real field, not the fake autocomplete-buster)
  await page.waitForSelector("#username", { visible: true });
  await page.click("#username");
  await page.type("#username", username, { delay: 50 });

  // Fill password
  await page.waitForSelector("#loginForm_password", { visible: true });
  await page.click("#loginForm_password");
  await page.type("#loginForm_password", password, { delay: 50 });

  // Click Login button
  notify(20, "Clicking Login...");
  await page.click("#loginForm_login");

  // Wait for navigation to dashboard/notice board
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
  await sleep(1000);

  const afterTitle = await page.title();
  debug(`After login title: ${afterTitle}`);

  if (afterTitle.toLowerCase().includes("login")) {
    // Check for error messages
    const errorMsg = await page.evaluate(() => {
      const err = document.querySelector(".errorMessage, .error, .alert");
      return err ? err.textContent.trim() : null;
    });
    throw new Error(`Login failed: ${errorMsg || "Invalid credentials"}`);
  }

  notify(25, "Successfully logged in to Tramada!");
  return true;
}

/**
 * Navigate to Bookings → Search page
 */
async function navigateToBookingSearch(page, notify) {
  notify(30, "Navigating to Bookings → Search...");

  // Option 1: Direct URL navigation (most reliable for frame-based apps)
  await page.goto(`${TRAMADA_BASE_URL}/booking/booking-search.htm`, { waitUntil: "networkidle2" });
  await sleep(1500);

  // Verify we're on the booking search page
  const title = await page.title();
  debug(`Booking search page title: ${title}`);

  // Check for the search form
  const hasSearchForm = await page.evaluate(() => {
    return !!document.querySelector("#searchForm_bookingStatus");
  });

  if (!hasSearchForm) {
    // Fallback: Try clicking through menu
    debug("Direct URL didn't load search form, trying menu navigation...");
    notify(35, "Using menu navigation...");

    await page.goto(`${TRAMADA_BASE_URL}/home/notice-board.htm`, { waitUntil: "networkidle2" });
    await sleep(1000);

    // Hover over Bookings menu to open dropdown
    const bookingsLink = await page.evaluateHandle(() => {
      const links = [...document.querySelectorAll("a")];
      return links.find(a => a.textContent.trim() === "Bookings");
    });

    if (bookingsLink) {
      await bookingsLink.asElement().hover();
      await sleep(500);

      // Click "Search" in the dropdown
      const searchLink = await page.evaluateHandle(() => {
        const links = [...document.querySelectorAll("a")];
        return links.find(a => a.textContent.trim() === "Search" && a.href.includes("booking-search"));
      });

      if (searchLink) {
        await searchLink.asElement().click();
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 });
        await sleep(1000);
      }
    }
  }

  // Final verification
  const hasForm = await page.evaluate(() => {
    return !!document.querySelector("#searchForm_bookingStatus");
  });

  if (!hasForm) {
    throw new Error("Could not navigate to Booking Search page");
  }

  notify(40, "On Booking Search page");
  return true;
}

/**
 * Select Booking Status "Booked" and click Search
 */
async function searchBookedBookings(page, notify) {
  notify(45, 'Selecting Booking Status "Booked"...');

  // Select "Booked" from the Booking Status dropdown
  await page.waitForSelector("#searchForm_bookingStatus", { visible: true });
  await page.select("#searchForm_bookingStatus", "BOOKED");
  await sleep(500);

  // Verify the selection took
  const selectedValue = await page.evaluate(() => {
    const sel = document.querySelector("#searchForm_bookingStatus");
    return sel ? sel.value : null;
  });
  debug(`Selected booking status: ${selectedValue}`);

  if (selectedValue !== "BOOKED") {
    throw new Error(`Failed to select Booked status, got: ${selectedValue}`);
  }

  // Click the Search button
  notify(55, "Clicking Search...");
  await page.click("#searchButton");

  // Wait for results to load
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {
    debug("No full navigation after search, might be AJAX");
  });
  await sleep(2000);

  notify(65, "Search results loading...");
  return true;
}

/**
 * Extract booking results from the results table
 */
async function extractBookingResults(page, notify) {
  notify(70, "Extracting booking results...");

  const results = await page.evaluate(() => {
    const rows = document.querySelectorAll("table.list tr, table.results tr, table[class*='booking'] tr");
    if (!rows || rows.length === 0) {
      // Try broader search — any table with Bkg No. header
      const allTables = document.querySelectorAll("table");
      for (const table of allTables) {
        const headerRow = table.querySelector("tr");
        if (headerRow && headerRow.textContent.includes("Bkg No")) {
          const dataRows = table.querySelectorAll("tr");
          const bookings = [];
          for (let i = 1; i < dataRows.length; i++) {  // skip header
            const cells = dataRows[i].querySelectorAll("td");
            if (cells.length >= 6) {
              bookings.push({
                bookingNo: cells[1]?.textContent?.trim() || "",
                clientName: cells[2]?.textContent?.trim() || "",
                debtorName: cells[3]?.textContent?.trim() || "",
                itinerary: cells[4]?.textContent?.trim() || "",
                depDate: cells[5]?.textContent?.trim() || "",
                retDate: cells[6]?.textContent?.trim() || "",
                finalTkt: cells[7]?.textContent?.trim() || "",
              });
            }
          }
          return { bookings, total: bookings.length };
        }
      }
      return { bookings: [], total: 0 };
    }

    // Parse the standard results table
    const bookings = [];
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll("td");
      if (cells.length >= 6) {
        bookings.push({
          bookingNo: cells[1]?.textContent?.trim() || "",
          clientName: cells[2]?.textContent?.trim() || "",
          debtorName: cells[3]?.textContent?.trim() || "",
          itinerary: cells[4]?.textContent?.trim() || "",
          depDate: cells[5]?.textContent?.trim() || "",
          retDate: cells[6]?.textContent?.trim() || "",
          finalTkt: cells[7]?.textContent?.trim() || "",
        });
      }
    }
    return { bookings, total: bookings.length };
  });

  // Check for pagination info
  const paginationInfo = await page.evaluate(() => {
    const pageEl = document.querySelector("td[colspan]");
    const text = pageEl ? pageEl.textContent.trim() : "";
    // Look for "Page" info or total records
    const pageInfo = document.body.innerText.match(/Page\s+.*?(\d+)/);
    const totalInfo = document.body.innerText.match(/(\d+)\s+record/i);
    return {
      pageText: text,
      currentPage: pageInfo ? pageInfo[1] : "1",
      totalRecords: totalInfo ? totalInfo[1] : null,
    };
  });

  notify(85, `Found ${results.total} bookings with status "Booked"`);
  debug(`Pagination: ${JSON.stringify(paginationInfo)}`);

  return {
    bookings: results.bookings,
    total: results.total,
    pagination: paginationInfo,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Main Automation Runner
// ═══════════════════════════════════════════════════════════════

/**
 * Run full Tramada automation:
 *  1. Login
 *  2. Navigate to Bookings → Search
 *  3. Select "Booked" status
 *  4. Search and extract results
 *
 * @param {Object} config - { username, password }
 * @param {Object} callbacks - { onProgress(pct, msg), onComplete(data), onError(err) }
 */
async function runTramadaAutomation(config, callbacks = {}) {
  const { username, password } = config;
  const notify = (pct, msg) => {
    console.log(`[tramada ${pct}%] ${msg}`);
    if (callbacks.onProgress) callbacks.onProgress(pct, msg);
  };

  if (!username || !password) {
    throw new Error("Tramada username and password are required");
  }

  let browser = null;
  try {
    // Step 0: Launch browser
    notify(5, "Starting browser...");
    browser = new TramadaBrowser();
    await browser.launch();
    const page = browser.page;

    // Step 1: Login
    await tramadaLogin(page, username, password, notify);

    // Step 2: Navigate to Bookings → Search
    await navigateToBookingSearch(page, notify);

    // Step 3: Select "Booked" and search
    await searchBookedBookings(page, notify);

    // Step 4: Extract results
    const results = await extractBookingResults(page, notify);

    // Take a screenshot of the results
    notify(90, "Taking screenshot of results...");
    let screenshot = null;
    try {
      screenshot = await page.screenshot({ encoding: "base64", fullPage: false });
    } catch (e) {
      debug(`Screenshot failed: ${e.message}`);
    }

    notify(100, `Done! Found ${results.total} booked bookings.`);

    const output = {
      success: true,
      results,
      screenshot,
      message: `Found ${results.total} bookings with status "Booked"`,
    };

    if (callbacks.onComplete) callbacks.onComplete(output);
    return output;

  } catch (err) {
    console.error(`[tramada] Error: ${err.message}`);
    notify(0, `Error: ${err.message}`);
    if (callbacks.onError) callbacks.onError(err);
    throw err;
  } finally {
    // Keep browser open so user can see results via noVNC
    // Don't close: if (browser) await browser.close();
    debug("Automation complete (browser left open for inspection)");
  }
}

module.exports = { runTramadaAutomation, TramadaBrowser };
