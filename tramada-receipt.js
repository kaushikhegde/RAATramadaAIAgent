/**
 * tramada-receipt.js — Playwright + CDP receipt automation for the chat flow.
 *
 * Companion to tramada-booking.js. Where that module ADDS a booking, this one
 * records a RECEIPT against an existing booking:
 *
 *   resolve booking (by number, or search + pick from a list)
 *     -> confirm booking details
 *       -> guard: an itinerary segment must exist & be costed
 *         -> Booking Transactions > Receipts > Add/Issue Receipt
 *           -> fill (Cash / EFT / Credit Card), allocate to segment(s)
 *             -> preview -> issue -> read back the new Receipt No.
 *
 * All selectors were mapped live against the raatravelsandbox TTMS (v7.10.3);
 * see docs/tramada-receipt-workflow.md for the field map.
 *
 * Reuses the shared CDP Chrome (start-chrome.sh, port 9222) so it runs in the
 * SAME already-logged-in browser as the rest of the flow. Because it attaches
 * to a live session and skips login when one exists, a warm Tramada session
 * means no repeated OTP challenge.
 */

const { chromium } = require("playwright");

const TRAMADA_BASE_URL =
  process.env.TRAMADA_URL || "https://asp.tramada.com.au/ttms/raatravelsandbox";
const CDP_PORT = parseInt(process.env.CDP_PORT || "9222", 10);
const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_MODE = process.env.CDP_MODE || "external";
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || "chrome";
const HEADLESS = process.env.HEADLESS === "true";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tramada Transaction Type dropdown values (receipt.transactionTypeCode).
const TXN_TYPE = {
  CASH: "CA",
  CHEQUE: "CQ",
  CREDIT_CARD: "CC", // "Credit Card CCCF"
  CREDIT_CARD_SWIPE: "CS",
  EFT: "ET",
};

// yyyy-mm-dd -> dd-mm-yyyy (Tramada date input format). Passes through
// values already in dd-mm-yyyy, and defaults blank to today.
function toTramadaDate(input) {
  if (!input) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
  }
  const iso = String(input).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  return input; // assume already dd-mm-yyyy
}

// Normalise a caller-supplied transaction type to a Tramada code.
function resolveTxnType(t) {
  if (!t) return TXN_TYPE.CASH;
  const key = String(t).toUpperCase().replace(/[\s-]+/g, "_");
  if (TXN_TYPE[key]) return TXN_TYPE[key];
  // Accept raw codes too (CA/CQ/CC/CS/ET)
  const raw = String(t).toUpperCase();
  if (Object.values(TXN_TYPE).includes(raw)) return raw;
  // Common aliases
  if (/CARD/.test(raw)) return TXN_TYPE.CREDIT_CARD;
  if (/CASH/.test(raw)) return TXN_TYPE.CASH;
  if (/EFT|TRANSFER|BANK/.test(raw)) return TXN_TYPE.EFT;
  return TXN_TYPE.CASH;
}

function isCreditCard(code) {
  return code === TXN_TYPE.CREDIT_CARD || code === TXN_TYPE.CREDIT_CARD_SWIPE;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Browser / login (mirrors tramada-booking.js)
 * ──────────────────────────────────────────────────────────────────────── */

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
    // Fail honestly rather than launching an unauthenticated throwaway Chrome.
    throw new Error(
      `Could not connect to Chrome on ${CDP_HOST}:${CDP_PORT}. ` +
        `Run "npm run start:chrome" and log into Tramada IN THAT WINDOW first. [${cdpErr.message}]`
    );
  }
}

/**
 * Ensure we have an authenticated Tramada session on `page`.
 * If credentials are supplied and we land on login.htm, it logs in.
 * If the session is already warm (attached CDP Chrome), it just returns —
 * so a browser a human already signed into (past OTP) is reused as-is.
 */
// Reliable auth check via a PROTECTED page (login.htm serves the form even when
// authenticated, which false-alarms as "not logged in").
async function tramadaIsAuthed(page) {
  await page
    .goto(`${TRAMADA_BASE_URL}/home/home.htm`, { waitUntil: "domcontentloaded" })
    .catch(() => {});
  return !page.url().includes("login.htm");
}

async function ensureLoggedIn(page, { username, password, onNeedLogin } = {}) {
  if (await tramadaIsAuthed(page)) return; // warm session — nothing to do

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

/* ─────────────────────────────────────────────────────────────────────────
 * Step 1 — resolve the booking (req 5)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Search bookings and return a list to show in chat when the user has no
 * booking number. Returns [{bookingNo, clientName, debtorName, itinerary,
 * depDate, retDate, finalTkt}].
 *
 * @param {object} opts { status?: NEW|QUOTE|BOOKED|FINALISED|CANCELLED, clientName?, bookingNo? }
 */
// Fill a sidebar search field located by its LABEL text (the input ids vary
// per tenant; the labels don't). Sets value with proper events.
async function fillSearchFieldByLabel(page, labelText, value) {
  if (!value) return false;
  return await page.evaluate((arg) => {
    const leaves = Array.from(document.querySelectorAll("body *")).filter(
      (n) => n.children.length === 0 && (n.textContent || "").trim().toLowerCase() === arg.label.toLowerCase()
    );
    for (const lb of leaves) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      walker.currentNode = lb;
      let n;
      while ((n = walker.nextNode())) {
        if (n.tagName === "INPUT" && (!n.type || n.type === "text")) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(n, arg.value);
          n.dispatchEvent(new Event("input", { bubbles: true }));
          n.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }, { label: labelText, value: String(value) });
}

async function searchBookings(page, opts = {}) {
  await page.goto(`${TRAMADA_BASE_URL}/booking/booking-search.htm`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("#searchButton", { timeout: 15000 });

  const hasFilters = !!(opts.status || opts.bookingNo || (opts.clientName || "").trim());

  // NO filters → the landing page ALREADY shows "Recently Accessed Bookings".
  // Clicking Search with empty criteria returns an empty set on this tenant
  // (which read as "No bookings found") — so just scrape the recent list.
  if (!hasFilters) {
    await sleep(600);
    return await scrapeBookingList(page);
  }

  if (opts.status) {
    await page.selectOption("#searchForm_bookingStatus", opts.status).catch(() => {});
  }
  if (opts.bookingNo) {
    await fillSearchFieldByLabel(page, "Booking No", opts.bookingNo);
  }
  if (opts.clientName) {
    await fillSearchFieldByLabel(page, "Client Name", opts.clientName);
  }

  await page.click("#searchButton");
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);

  return await scrapeBookingList(page);
}

// Scrape whichever table carries the "Bkg No" header (search results or the
// default "Recently Accessed Bookings" list).
async function scrapeBookingList(page) {
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const header = table.querySelector("tr");
      if (header && /Bkg\s*No/i.test(header.textContent)) {
        const rows = table.querySelectorAll("tr");
        const out = [];
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 6) {
            out.push({
              bookingNo: clean(c[1]),
              clientName: clean(c[2]),
              debtorName: clean(c[3]),
              itinerary: clean(c[4]),
              depDate: clean(c[5]),
              retDate: clean(c[6]),
              finalTkt: clean(c[7]),
            });
          }
        }
        return out;
      }
    }
    return [];
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Step 2 — booking details (req 1)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Open a booking by its number and scrape the header details for confirmation.
 * The booking id in Tramada URLs IS the booking number, so we navigate directly.
 */
async function getBookingDetails(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-summary.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(600);

  const details = await page.evaluate(() => {
    // The left header block uses <b>Label:</b> value pairs; read the sidebar text.
    const bodyText = document.body.innerText;
    const grab = (label) => {
      const re = new RegExp(label + "\\s*:?\\s*([^\\n]+)", "i");
      const m = bodyText.match(re);
      return m ? m[1].trim() : "";
    };
    const clientName = grab("Client Name");
    return {
      bookingNo: grab("Booking No\\.?"),
      client: grab("Client"),
      clientName,
      // Payer Name always = booking client name (business rule)
      payerName: clientName,
      debtor: grab("Debtor"),
      itinerary: grab("Itinerary"),
      bookDate: grab("Book\\.? Date"),
      depDate: grab("Dep\\.? Date"),
    };
  });

  const loaded = !page.url().includes("booking-search") && !!details.bookingNo;
  if (!loaded) {
    throw new Error(`Booking ${bookingNo} could not be opened.`);
  }
  return details;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Guard — an itinerary segment must exist before a receipt can be raised
 * ──────────────────────────────────────────────────────────────────────── */

async function getItinerarySegments(page, bookingNo) {
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-itineraries.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await sleep(500);
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const header = table.querySelector("tr");
      if (header && /Seg\.?\s*Type/i.test(header.textContent)) {
        const rows = table.querySelectorAll("tr");
        const segs = [];
        for (let i = 1; i < rows.length; i++) {
          const c = rows[i].querySelectorAll("td");
          if (c.length >= 3) {
            segs.push({ segType: clean(c[1]), reference: clean(c[2]) });
          }
        }
        return segs;
      }
    }
    return [];
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Step 3 — the receipt form
 * ──────────────────────────────────────────────────────────────────────── */

// Read the "Segments To Allocate" table on the open receipt form:
// [{ segId, segType, reference, debtorDue }]
async function readAllocatableSegments(page) {
  return await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input[id^="allocationAmount_"]').forEach((inp) => {
      const segId = inp.id.replace("allocationAmount_", "");
      const row = inp.closest("tr");
      const cells = row ? Array.from(row.querySelectorAll("td")).map((td) => td.textContent.trim()) : [];
      out.push({
        segId,
        segType: cells[1] || "",
        reference: cells[3] || "",
        debtorDue: cells[6] || inp.value || "",
      });
    });
    return out;
  });
}

/**
 * Open a fresh Debtor Payment Receipt form for a booking and fill the header
 * fields. Returns the list of allocatable segments so the caller can allocate.
 */
// Set a field with native setter + input/change/blur events — the method the
// two successful hand-driven receipts used (matches the browser extension's
// form_input). Plain Playwright fill() skips the change handlers Tramada uses.
async function setFieldWithEvents(page, selector, value) {
  if (value == null || value === "") return;
  const el = page.locator(selector);
  if (!(await el.count())) return;
  await el.first().evaluate((n, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(n, v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
    n.dispatchEvent(new Event("blur", { bubbles: true }));
  }, String(value));
}

async function openReceiptForm(page, bookingNo, receipt) {
  // PROVEN PATH: open the Receipts list and click "Add / Issue Receipt".
  // (Navigating straight to the form URL once ended in a Tramada server error
  // on Issue — the button flow is what both successful receipts used.)
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-receipts.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  await page.waitForSelector('input[value="Add / Issue Receipt"]', { timeout: 15000 });
  await page.click('input[value="Add / Issue Receipt"]');
  await page.waitForSelector("#receipttransactionTypeCode", { timeout: 20000 });

  const txn = resolveTxnType(receipt.transactionType);

  // Transaction Type (req 2) — set first so credit-card sections render.
  await page.selectOption("#receipttransactionTypeCode", txn);
  await sleep(800);

  // Payer Name = booking client name (business rule, req: always client name).
  if (receipt.payerName) {
    await setFieldWithEvents(page, "#receiptpayerName", receipt.payerName);
  }
  // Date Received (defaults to today if omitted).
  await setFieldWithEvents(page, "#receiptdateReceived", toTramadaDate(receipt.dateReceived));
  // Amount Received.
  await setFieldWithEvents(page, "#receiptreceiptAmount", String(receipt.amount));
  // Reference — REQUIRED (req 6).
  if (!receipt.reference) {
    throw new Error("Receipt reference is required.");
  }
  await setFieldWithEvents(page, "#receiptreferenceNumber", String(receipt.reference));

  return { txn, segments: await readAllocatableSegments(page) };
}

/**
 * Credit-card path (req 4): enter a NEW booking credit card each time — a card
 * tied to this receipt, NOT saved to the client profile. Reached only via the
 * receipt form's "Add" button, which opens client-edit-credit-card.htm in
 * booking-card mode.
 *
 * NOTE: card data is sensitive. `card` should be supplied over a secure channel;
 * this module only types what it is given and never logs it.
 *
 * @param {object} card { number, type, holder, expiry } and optional { creditor, authNumber }
 */
async function enterNewBookingCard(page, card) {
  if (card.creditor) {
    // Creditor Details select (shows once Credit Card is chosen).
    await page.selectOption("#creditor", { label: card.creditor }).catch(async () => {
      await page.selectOption("#creditor", card.creditor).catch(() => {});
    });
  }

  // Click "Add" — Tramada opens the card form in a popup window.
  let popup = null;
  try {
    [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 8000 }),
      page.click("#addCreditCardButton"),
    ]);
  } catch {
    popup = null; // fall through to in-page fallback
  }

  const cardCtx = popup || page; // some tenants render an in-page modal instead
  await cardCtx.waitForSelector("#cardNumberDisplay", { timeout: 15000 });

  await cardCtx.fill("#cardNumberDisplay", String(card.number));
  if (card.type) {
    await cardCtx.selectOption("#cardType", { label: card.type }).catch(async () => {
      await cardCtx.selectOption("#cardType", card.type).catch(() => {});
    });
  }
  if (card.holder) await cardCtx.fill("#cardHolder", String(card.holder));
  if (card.expiry) await cardCtx.fill("#expiryDate", String(card.expiry));

  // Save the booking card. If it was a popup it closes; the parent refreshes
  // its #receiptcreditCard dropdown with (and auto-selects) the new card.
  if (popup) {
    await Promise.all([
      popup.waitForEvent("close").catch(() => {}),
      popup.click("#save"),
    ]);
  } else {
    await cardCtx.click("#save");
  }
  await sleep(1500);

  // Ensure a card is selected on the parent form; if not, pick the newest option.
  await page.evaluate(() => {
    const sel = document.getElementById("receiptcreditCard");
    if (sel && !sel.value && sel.options.length) {
      sel.selectedIndex = sel.options.length - 1;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  // Authorisation Number (optional).
  if (card.authNumber) {
    await page.fill("#receiptcreditCardAuthNumber", String(card.authNumber));
  }
}

/**
 * Allocate the receipt across segments (req 3).
 *
 * @param {"ALL"|Array} allocation
 *   "ALL"                    -> tick every segment, use each segment's due
 *   [{ segId, amount }]      -> allocate specific amounts to specific segments
 *   [{ index, amount }]      -> same, by row index (0-based)
 */
async function allocateSegments(page, allocation, segments) {
  if (!segments || segments.length === 0) {
    throw new Error(
      "No costed segments to allocate against — create & cost an itinerary segment first."
    );
  }

  if (allocation === "ALL" || allocation == null) {
    // PROVEN PATH: real-click the "Segments To Allocate" section's Select All
    // button — its onclick both ticks every row AND auto-fills each allocation
    // amount with the segment's due. (Hand-ticking checkboxes left the amounts
    // empty, which is what sank the first manual attempt.) There are two
    // #selectAll buttons on the page; the segments one is the second.
    const selectAlls = page.locator("#selectAll");
    const n = await selectAlls.count();
    if (n > 0) {
      await selectAlls.nth(n - 1).click();
      await sleep(800);
    }
    // Verify: every checkbox ticked and amounts populated; fix up any gaps the
    // button missed using the segment's own due value.
    await page.evaluate(() => {
      document.querySelectorAll('input[id^="allocationAmount_"]').forEach((inp) => {
        const row = inp.closest("tr");
        const cb = row && row.querySelector('input[name="segmentsToAllocate"]');
        if (cb && !cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (!parseFloat(inp.value || "0")) {
          const cells = row ? Array.from(row.querySelectorAll("td")).map((td) => td.textContent.trim()) : [];
          const due = cells.filter((c) => /^\d+(\.\d\d)?$/.test(c)).pop();
          if (due) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            setter.call(inp, due);
            inp.dispatchEvent(new Event("input", { bubbles: true }));
            inp.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
      });
    });
    return;
  }

  // Specific allocations.
  for (const a of allocation) {
    const seg =
      a.segId != null
        ? segments.find((s) => s.segId === String(a.segId))
        : segments[a.index];
    if (!seg) continue;
    // Set amount (with events, so Tramada's tally recomputes) and tick the row.
    await setFieldWithEvents(page, `#allocationAmount_${seg.segId}`, String(a.amount));
    await page.evaluate((segId) => {
      const inp = document.getElementById("allocationAmount_" + segId);
      const row = inp && inp.closest("tr");
      const cb = row && row.querySelector('input[name="segmentsToAllocate"]');
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, seg.segId);
  }
}

// Read back the top REAL receipt row after issuing — skips "No records found"
// and TOTALS rows; only a row whose Receipt No. looks like "R.000..." counts.
async function readLatestReceipt(page) {
  return await page.evaluate(() => {
    const clean = (el) => (el && el.textContent ? el.textContent.trim() : "");
    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const header = table.querySelector("tr");
      if (header && /Receipt\s*No/i.test(header.textContent)) {
        const rows = table.querySelectorAll("tr");
        let row = null;
        for (let i = 1; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll("td");
          if (cells.length >= 9 && /^R\./i.test((cells[1].textContent || "").trim())) {
            row = rows[i];
            break;
          }
        }
        if (!row) return null;
        const c = row.querySelectorAll("td");
        return {
          receiptNo: clean(c[1]),
          receiptCategory: clean(c[2]),
          receiptType: clean(c[3]),
          transType: clean(c[4]),
          receivedFrom: clean(c[5]),
          reference: clean(c[6]),
          dateReceived: clean(c[7]),
          amount: clean(c[8]),
          allocated: clean(c[9]),
        };
      }
    }
    return null;
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Orchestrator
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Create (and optionally issue) a receipt against an existing booking.
 *
 * @param {object} args
 * @param {string} [args.username] / [args.password]  Only used if the shared
 *        Chrome session is NOT already logged in (avoids re-triggering OTP).
 * @param {string|number} args.bookingNo   Booking to receipt against (req 5:
 *        if you don't have one, call searchBookingsForReceipt first and let the
 *        user pick).
 * @param {object} args.receipt
 *        {
 *          transactionType: "Cash"|"EFT"|"Cheque"|"Credit Card"|"Credit Card Swipe",
 *          amount: number|string,
 *          reference: string,             // REQUIRED (req 6)
 *          dateReceived?: "YYYY-MM-DD",   // defaults today
 *          payerName?: string,            // defaults to booking client name (req: always client name)
 *          allocation?: "ALL" | [{segId|index, amount}],   // req 3
 *          card?: { number, type, holder, expiry, creditor?, authNumber? } // req 4, credit card only
 *        }
 * @param {boolean} [args.dryRun=false]  When true: fill the form and capture a
 *        preview screenshot but DO NOT click Issue (nothing is committed, and
 *        for credit cards the card popup is skipped so no card is created).
 *        Use this to show the user a confirmation before committing.
 * @param {object} [args.callbacks] { onProgress(pct,msg), onError(msg) }
 * @returns {Promise<{details, segments, staged, receipt?, previewImage?}>}
 */
async function runTramadaReceipt({
  username,
  password,
  bookingNo,
  receipt = {},
  dryRun = false,
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  const onError = callbacks.onError || (() => {});

  if (!bookingNo) throw new Error("bookingNo is required (resolve or ask the user first).");
  if (!receipt.reference) throw new Error("receipt.reference is required.");
  if (receipt.amount == null || receipt.amount === "") {
    throw new Error("receipt.amount is required.");
  }

  const txnCode = resolveTxnType(receipt.transactionType);
  if (isCreditCard(txnCode) && !dryRun && !receipt.card) {
    throw new Error("Credit card receipt requires receipt.card { number, type, holder, expiry }.");
  }

  let browser, context, page, launched = false;
  let _ok = false;
  try {
    ({ browser, launched } = await openBrowser(onProgress));
    context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();

    onProgress(12, "Checking Tramada session...");
    await ensureLoggedIn(page, { username, password, onNeedLogin: callbacks.onNeedLogin });

    onProgress(25, `Opening booking ${bookingNo}...`);
    const details = await getBookingDetails(page, bookingNo);

    onProgress(35, "Checking itinerary segments...");
    const itin = await getItinerarySegments(page, bookingNo);
    if (!itin || itin.length === 0) {
      throw new Error(
        `Booking ${bookingNo} has no itinerary segment. Create (and cost) an ` +
          `itinerary segment before raising a receipt.`
      );
    }

    // Payer Name always = booking client name unless explicitly overridden.
    const payerName = receipt.payerName || details.payerName || details.clientName || "";

    onProgress(50, `Preparing ${dryRun ? "receipt preview" : "receipt"}...`);
    const { segments } = await openReceiptForm(page, bookingNo, {
      ...receipt,
      payerName,
    });

    // Credit card entry only on real commit (a card is a real side effect;
    // dryRun skips it so a preview never creates a card).
    if (isCreditCard(txnCode) && !dryRun) {
      onProgress(60, "Entering new booking credit card...");
      await enterNewBookingCard(page, receipt.card);
    }

    onProgress(70, "Allocating to segment(s)...");
    await allocateSegments(page, receipt.allocation || "ALL", segments);
    await sleep(400);

    const staged = {
      bookingNo: String(bookingNo),
      transactionType: txnCode,
      payerName,
      amount: String(receipt.amount),
      reference: String(receipt.reference),
      dateReceived: toTramadaDate(receipt.dateReceived),
      allocation: receipt.allocation || "ALL",
      segments,
    };

    if (dryRun) {
      onProgress(90, "Preview ready — awaiting confirmation (not committed).");
      let previewImage = null;
      try {
        previewImage = await page.screenshot({ encoding: "base64", fullPage: true });
      } catch { /* screenshot optional */ }
      onProgress(100, "Preview ready.");
      _ok = true;
      return { details, itinerary: itin, segments, staged, previewImage, committed: false };
    }

    onProgress(85, "Issuing receipt...");
    // Real click on Issue, then WAIT for a definitive outcome: back on the
    // receipts list (success), a Tramada error page, or on-form validation
    // errors. A fixed sleep raced the server and produced false successes.
    await page.click("#issue");
    for (let i = 0; i < 25; i++) {
      await sleep(600);
      const url = page.url();
      if (/booking-receipts\.htm/i.test(url)) break; // back on the list → issued
      const title = (await page.title().catch(() => "")) || "";
      if (/error page/i.test(title)) {
        throw new Error("Tramada returned a server error page after Issue.");
      }
      const errs = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll("a, span, li, font, div").forEach((n) => {
          if (n.children.length) return;
          const t = (n.textContent || "").trim();
          if (t && t.length < 200 && /must be|is required|is invalid|cannot be/i.test(t)) out.push(t);
        });
        return [...new Set(out)].slice(0, 8);
      }).catch(() => []);
      if (errs.length) throw new Error(`Receipt rejected: ${errs.join("; ")}`);
      if (i === 8) { try { await page.click("#issue", { timeout: 3000 }); } catch { /* busy */ } }
    }

    // Land on the Booking Receipts list and read back the new receipt.
    if (!page.url().includes("booking-receipts")) {
      await page.goto(
        `${TRAMADA_BASE_URL}/booking/booking-receipts.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
        { waitUntil: "domcontentloaded" }
      );
      await sleep(800);
    }
    const issued = await readLatestReceipt(page);

    // STRICT: success means a real receipt number (R.000...) in the list —
    // anything else is a failure, never a silent "Receipt issued."
    if (!issued || !/^R\./i.test(issued.receiptNo || "")) {
      try { await page.screenshot({ path: "last-error.png", fullPage: true }); } catch { /* best-effort */ }
      throw new Error(
        "Receipt was NOT created — the receipts list shows no new receipt. [screenshot: last-error.png]"
      );
    }

    onProgress(100, `Receipt ${issued.receiptNo} issued.`);
    _ok = true;
    return { details, itinerary: itin, segments, staged, receipt: issued, committed: true };
  } catch (err) {
    onError(err.message);
    throw err;
  } finally {
    try {
      // On failure leave the tab open (failed form stays inspectable).
      if (page && _ok) await page.close();
    } catch { /* tab may be closed */ }
    try {
      if (browser) await browser.close(); // CDP: only drops the connection
    } catch { /* ignore */ }
  }
}

/**
 * Convenience wrapper for the "no booking number" branch (req 5):
 * open a search, return the list for the chat to display.
 */
async function searchBookingsForReceipt({ username, password, status, clientName, bookingNo } = {}) {
  let browser, page;
  try {
    ({ browser } = await openBrowser(() => {}));
    const context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();
    await ensureLoggedIn(page, { username, password });
    return await searchBookings(page, { status, clientName, bookingNo });
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
}

module.exports = {
  runTramadaReceipt,
  searchBookingsForReceipt,
  // exported for reuse/testing
  toTramadaDate,
  resolveTxnType,
  TXN_TYPE,
};
