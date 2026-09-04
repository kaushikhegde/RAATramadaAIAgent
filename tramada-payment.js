/**
 * tramada-payment.js — Tramada side of the MINT creditor-payment flow.
 * =====================================================================
 * Covers steps 1–6 of docs/Payments_Guide_MINT.md: open the booking, go to
 * Payments, choose Creditor Payment, open Issue Creditor Payment, set the
 * transaction type to EFT, pick the supplier, and READ the Segments to Allocate
 * table. Everything the agent needs before it can stage a payment with Mint.
 *
 * IT DOES NOT ISSUE ANYTHING. There is no Issue click in this file. Reading the
 * booking is Phase A; writing the Mint transaction id back into Tramada is a
 * separate run that only happens after a human has authorised in Mint.
 *
 * SELECTORS
 * ---------
 * Located by LABEL and BUTTON TEXT rather than by id. That is the same call
 * fillSearchFieldByLabel makes in tramada-receipt.js — "the input ids vary per
 * tenant; the labels don't" — and it matters more here, because unlike the
 * receipt page nobody has ever inspected the creditor payment page. Run
 * probe-payment-page.js to confirm the real ids; this module is written not to
 * need them.
 *
 * Navigation follows the BUTTON, never a direct form URL. tramada-receipt.js:372
 * records that deep-linking a form URL once produced a Tramada server error on
 * Issue, and the receipt flow only became reliable when it clicked through.
 */

const {
  openBrowser,
  ensureLoggedIn,
  getBookingDetails,
  TRAMADA_BASE_URL,
} = require("./tramada-receipt");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBUG = process.env.DEBUG === "true";

function log(...a) {
  if (DEBUG) console.log("[tramada-payment]", ...a);
}

/** Money text ("1,234.56", "$374.29", "(12.00)") → Number, or null. */
function toAmount(text) {
  if (text == null) return null;
  const negative = /^\s*\(.*\)\s*$/.test(String(text));
  const cleaned = String(text).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Step 2 — Payments under Booking Transactions.
 *
 * Tries the URL that matches every other booking page first, then falls back to
 * clicking the left-nav link by its text. The fallback is what makes this work
 * without the probe: if booking-payments.htm is wrong, the nav link is right.
 */
async function openPaymentsPage(page, bookingNo) {
  const guessed = `${TRAMADA_BASE_URL}/booking/booking-payments.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`;
  await page.goto(guessed, { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(600);

  const looksRight = await page.evaluate(() =>
    /payment/i.test(document.body.innerText.slice(0, 4000)) && !/not found|error/i.test(document.title)
  );
  if (looksRight && /booking-payments/i.test(page.url())) return page.url();

  log("guessed payments URL did not land; using the left-nav link");
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-summary.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  const navLink = page.locator('a:has-text("Payments")').first();
  if (!(await navLink.count())) {
    throw new Error(
      `Could not find a "Payments" link on booking ${bookingNo}. ` +
        `Run "node probe-payment-page.js ${bookingNo}" and check the navLinks it captures.`
    );
  }
  await navLink.click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(800);
  return page.url();
}

/**
 * Step 3 — the top-right dropdown must read "Creditor Payment" (the page can
 * default to Debtor Receipt), then "Add/Issue Payment".
 */
async function openCreditorPaymentForm(page) {
  // Find whichever select carries a Creditor Payment option and choose it.
  const chose = await page.evaluate(() => {
    for (const sel of document.querySelectorAll("select")) {
      const opt = Array.from(sel.options).find((o) => /creditor\s*payment/i.test(o.text));
      if (opt) {
        if (sel.value !== opt.value) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { id: sel.id || null, option: opt.text.trim() };
      }
    }
    return null;
  });
  if (chose) log("transaction dropdown set to", chose.option);
  await sleep(700);

  const addBtn = page
    .locator(
      'input[value*="Issue Payment" i], input[value*="Add/Issue" i], ' +
      'button:has-text("Add/Issue Payment"), button:has-text("Issue Payment")'
    )
    .first();

  if (!(await addBtn.count())) {
    throw new Error(
      'Could not find the "Add/Issue Payment" button on the Payments page. ' +
        "Run probe-payment-page.js to capture the real button label."
    );
  }
  await addBtn.click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);
  return page.url();
}

/** Find a <select> by the label text sitting next to it. Returns its id, or null. */
async function findSelectByLabel(page, labelPattern) {
  return await page.evaluate((pattern) => {
    const re = new RegExp(pattern, "i");
    const labelFor = (el) => {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && re.test(lab.textContent)) return true;
      }
      const cell = el.closest("td");
      const prev = cell && cell.previousElementSibling;
      if (prev && re.test(prev.textContent)) return true;
      const wrapText = el.parentElement ? el.parentElement.textContent : "";
      return re.test(wrapText || "");
    };
    for (const sel of document.querySelectorAll("select")) {
      if (labelFor(sel)) {
        return {
          id: sel.id || null,
          name: sel.getAttribute("name") || null,
          options: Array.from(sel.options)
            .map((o) => ({ value: o.value, text: o.text.trim() }))
            .filter((o) => o.text && !/^\s*(select|choose|--)/i.test(o.text)),
          value: sel.value,
        };
      }
    }
    return null;
  }, labelPattern);
}

async function setSelectByText(page, selectInfo, matcher) {
  return await page.evaluate(
    ({ id, name, matcher }) => {
      const sel = id ? document.getElementById(id) : document.querySelector(`select[name="${name}"]`);
      if (!sel) return null;
      const re = new RegExp(matcher, "i");
      const opt = Array.from(sel.options).find((o) => re.test(o.text));
      if (!opt) return null;
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return { value: opt.value, text: opt.text.trim() };
    },
    { id: selectInfo.id, name: selectInfo.name, matcher }
  );
}

/**
 * Step 6 — read Segments to Allocate.
 *
 * Located by COLUMN HEADER, not by column index: the guide's screenshot shows
 * Reference / Creditor Sell / Creditor Cost / Creditor Payable / Amounts, but a
 * fixed index would break the first time Tramada adds a column. Reference is the
 * key the payment is identified by (it becomes external_invoice_reference at
 * Mint); Creditor Payable is the amount.
 */
async function readSegmentsToAllocate(page) {
  return await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    // The allocation grid is the table whose headers mention Creditor Payable.
    const tables = Array.from(document.querySelectorAll("table"));
    const table = tables.find((t) =>
      Array.from(t.querySelectorAll("th, thead td")).some((h) => /creditor\s*payable/i.test(h.textContent))
    );
    if (!table) return { found: false, headers: [], rows: [] };

    const headerCells = Array.from(table.querySelectorAll("th, thead td")).map((h) => norm(h.textContent));
    const col = (pattern) => headerCells.findIndex((h) => new RegExp(pattern, "i").test(h));

    const iRef = col("reference");
    const iSell = col("creditor\\s*sell");
    const iCost = col("creditor\\s*cost");
    const iPay = col("creditor\\s*payable");

    const rows = [];
    for (const tr of Array.from(table.querySelectorAll("tr"))) {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length < 3) continue;

      const cells = tds.map((td) => norm(td.textContent));
      const payableText = iPay >= 0 ? cells[iPay] : null;
      if (!payableText || !/[0-9]/.test(payableText)) continue;

      // The "A" column checkbox is what allocates this row on the write-back run.
      const box = tr.querySelector('input[type="checkbox"]');
      const amountInput = tr.querySelector('input[type="text"][id], input[id*="llocation" i]');

      rows.push({
        reference: iRef >= 0 ? cells[iRef] : null,
        creditorSell: iSell >= 0 ? cells[iSell] : null,
        creditorCost: iCost >= 0 ? cells[iCost] : null,
        creditorPayable: payableText,
        checkboxId: box ? box.id || null : null,
        checkboxName: box ? box.getAttribute("name") || null : null,
        amountInputId: amountInput ? amountInput.id || null : null,
        cells,
      });
    }
    return { found: true, headers: headerCells, rows };
  });
}

/**
 * Steps 1–6. Read-only.
 *
 * @param {object} opts
 *   bookingNo  required
 *   supplier   optional — supplier to select in "Payment To". Omit and, when the
 *              booking has more than one, the caller is handed the list to ask
 *              about rather than the agent guessing. Paying the right amount to
 *              the wrong supplier has no automated recovery.
 *   username/password  optional Tramada credentials (a warm CDP session is used
 *              as-is when they are omitted)
 *   callbacks  { onProgress(pct, msg), onNeedLogin() }
 */
async function readCreditorPayment({ bookingNo, supplier, username, password, callbacks = {} } = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo is required.");

  let browser, context, page, launched = false;
  try {
    ({ browser, launched } = await openBrowser(onProgress));
    context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();

    onProgress(12, "Checking Tramada session...");
    await ensureLoggedIn(page, { username, password, onNeedLogin: callbacks.onNeedLogin });

    // Step 1 — open the booking (also gives us the client name, which becomes
    // Payee Name on the write-back and passenger_name at Mint).
    onProgress(25, `Opening booking ${bookingNo}...`);
    const details = await getBookingDetails(page, bookingNo);

    // Step 2
    onProgress(40, "Opening Booking Payments...");
    const paymentsUrl = await openPaymentsPage(page, bookingNo);

    // Step 3
    onProgress(55, "Opening Issue Creditor Payment...");
    const formUrl = await openCreditorPaymentForm(page);

    // Step 4 — Transaction Type = EFT. Set before reading anything else, since
    // Tramada re-renders parts of the form when it changes.
    onProgress(65, "Setting transaction type to EFT...");
    const txnSelect = await findSelectByLabel(page, "transaction\\s*type");
    let transactionType = null;
    if (txnSelect) {
      transactionType = await setSelectByText(page, txnSelect, "eft|electronic");
      await sleep(900);
    }

    // Step 5 — Payment To (the supplier/creditor).
    onProgress(78, "Reading suppliers...");
    const payToSelect = await findSelectByLabel(page, "payment\\s*to|payee|creditor");
    const suppliers = payToSelect ? payToSelect.options : [];
    let selectedSupplier = null;

    if (payToSelect) {
      if (supplier) {
        selectedSupplier = await setSelectByText(page, payToSelect, escapeRe(supplier));
        if (!selectedSupplier) {
          throw new Error(
            `Supplier "${supplier}" is not in the Payment To list for booking ${bookingNo}. ` +
              `Available: ${suppliers.map((s) => s.text).join(", ") || "none"}`
          );
        }
        await sleep(900);
      } else if (suppliers.length === 1) {
        selectedSupplier = await setSelectByText(page, payToSelect, escapeRe(suppliers[0].text));
        await sleep(900);
      }
    }

    // Step 6 — Segments to Allocate.
    onProgress(90, "Reading segments to allocate...");
    const allocation = await readSegmentsToAllocate(page);

    const segments = allocation.rows.map((r) => ({
      ...r,
      creditorPayableAmount: toAmount(r.creditorPayable),
    }));

    onProgress(100, "Read complete.");

    return {
      bookingNo: details.bookingNo || String(bookingNo),
      clientName: details.clientName || details.client || null,
      debtor: details.debtor || null,
      itinerary: details.itinerary || null,
      transactionType: transactionType ? transactionType.text : null,
      suppliers,
      // More than one creditor on a booking means more than one payment — one
      // Mint transaction and one human authorisation each. The caller asks.
      needsSupplierChoice: !selectedSupplier && suppliers.length > 1,
      supplier: selectedSupplier ? selectedSupplier.text : null,
      segments,
      segmentsFound: allocation.found,
      headers: allocation.headers,
      total: segments.reduce((n, s) => n + (s.creditorPayableAmount || 0), 0),
      paymentsUrl,
      formUrl,
    };
  } finally {
    // Leave a CDP-attached Chrome alone — it is the human's browser and their
    // warm Tramada session lives in it.
    await page?.close().catch(() => {});
    if (browser && launched) await browser.close().catch(() => {});
  }
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { readCreditorPayment, toAmount };
