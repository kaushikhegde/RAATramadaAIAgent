/**
 * tramada-payment.js — Tramada side of the four creditor/debtor payment flows.
 * =============================================================================
 * One module, four flows, from docs/:
 *
 *   mint      Payments_Guide_MINT.md         steps 1–6   supplier, EFT
 *   travelpay Payments_Guide_-_TravelPay.md  steps 1–6   supplier, EFT
 *   dvc       Payments_Guide_-_DVC.md        steps 1–4   supplier, Westpac card
 *   ipsi      Payments_Guide_-_IPSI.md       steps 2–4   CUSTOMER receipt
 *
 * The four are NOT the same read with a different label on the end. Mint and
 * TravelPay share a Tramada path exactly (Payments → Creditor Payment → EFT →
 * Payment To) and diverge only at the external form. DVC goes somewhere else
 * entirely — Receipts → Agency CC Debtor Receipt → Creditor — and reads the
 * "Creditor Due" column plus Seg. Type and the booking's Level 1 Branch, none
 * of which the Mint flow ever looks at. IPSI is not a supplier payment at all:
 * it is money coming IN from a customer who has already been charged in IPSI,
 * so there is no supplier to choose and the amount is dictated by the IPSI
 * approved page rather than read out of Tramada.
 *
 * Those differences live in PAYMENT_FLOWS below. Everything after it is shared.
 *
 * IT DOES NOT ISSUE ANYTHING. There is no Issue click in this file, on any
 * flow. Reading the booking is Phase A; writing the external transaction id
 * back into Tramada is a separate run that only happens after a human has
 * authorised the payment in Mint / TravelPay / Westpac / IPSI. That is BR02 on
 * the Mint and TravelPay guides, BR07 on DVC and BR07 on IPSI — four guides,
 * same rule, and it is the reason this module is read-only.
 *
 * SELECTORS
 * ---------
 * Located by LABEL and BUTTON TEXT rather than by id. That is the same call
 * fillSearchFieldByLabel makes in tramada-receipt.js — "the input ids vary per
 * tenant; the labels don't" — and it matters more here, because unlike the
 * receipt page nobody has ever inspected the creditor payment page, and NOBODY
 * has inspected the Agency Credit Card Transaction or Debtor Payment Receipt
 * pages the DVC and IPSI flows land on. Run probe-payment-page.js against a
 * real booking to confirm the ids; this module is written not to need them, and
 * every flow-specific lookup falls back to something broader rather than
 * throwing on the first miss.
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

/* ─────────────────────────────────────────────────────────────────────────
 * The four flows
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * What differs between the guides, and only what differs.
 *
 *   navText        left-nav link under Booking Transactions (step 2)
 *   urlSlug        the booking sub-page to try before falling back to the link
 *   listOption     the top-right dropdown option (step 3)
 *   addButton      the button next to that dropdown (step 3)
 *   transactionType  what Transaction Type must be set to, or null to leave it
 *   supplierLabel  label of the supplier/creditor select, or null when the flow
 *                  has no supplier (IPSI takes money from a customer)
 *   amountColumns  Segments to Allocate money columns, most specific first —
 *                  the first one present is the amount this flow pays
 *   presets        other selects the guide pins to a fixed value (IPSI's Bank
 *                  Account and Received From), read back for the summary
 *   needsProfile   also read the Booking Profile page (DVC's Level 1 Branch)
 */
const PAYMENT_FLOWS = {
  mint: {
    id: "mint",
    label: "Mint",
    guide: "docs/Payments_Guide_MINT.md",
    kind: "supplier",
    navText: "Payments",
    urlSlug: "booking-payments",
    listOption: "creditor\\s*payment",
    addButton: "Issue Payment|Add/Issue",
    transactionType: "eft|electronic",
    supplierLabel: "payment\\s*to|payee|creditor",
    amountColumns: ["creditor\\s*payable"],
    presets: [],
    needsProfile: false,
  },

  // Identical to Mint on the Tramada side — the guides' steps 1–6 match line
  // for line. They part company at the external form, which is the caller's
  // problem, not this module's.
  travelpay: {
    id: "travelpay",
    label: "TravelPay",
    guide: "docs/Payments_Guide_-_TravelPay.md",
    kind: "supplier",
    navText: "Payments",
    urlSlug: "booking-payments",
    listOption: "creditor\\s*payment",
    addButton: "Issue Payment|Add/Issue",
    transactionType: "eft|electronic",
    supplierLabel: "payment\\s*to|payee|creditor",
    amountColumns: ["creditor\\s*payable"],
    presets: [],
    needsProfile: false,
  },

  // Receipts, not Payments — a DVC is raised as an agency credit card receipt
  // against the booking, and the money leaves via a Westpac virtual card the
  // consultant then uses on the supplier's own portal.
  dvc: {
    id: "dvc",
    label: "Westpac DVC",
    guide: "docs/Payments_Guide_-_DVC.md",
    kind: "supplier",
    navText: "Receipts",
    urlSlug: "booking-receipts",
    listOption: "agency\\s*(cc|credit\\s*card)\\s*debtor\\s*receipt",
    addButton: "Issue Receipt|Add/Issue",
    // No Transaction Type step on this page — step 4 goes straight to Creditor.
    transactionType: null,
    supplierLabel: "creditor",
    // Step 16 reads "Creditor Due"; BR12 says "Creditor Payable". Both are
    // read and Creditor Due wins, because step 16 is the instruction written
    // for THIS page while BR12 reads as carried over from the Mint guide. When
    // the two disagree the caller is told, rather than one being picked
    // silently — see amountColumnConflict on the result.
    amountColumns: ["creditor\\s*due", "creditor\\s*payable"],
    presets: [],
    needsProfile: true,
  },

  // Money IN from a customer who has already been charged in IPSI. No supplier,
  // no creditor column: the amount, the reference and the cardholder all come
  // off the IPSI approved page and are supplied by the consultant.
  ipsi: {
    id: "ipsi",
    label: "IPSI",
    guide: "docs/Payments_Guide_-_IPSI.md",
    kind: "customer",
    navText: "Receipts",
    urlSlug: "booking-receipts",
    listOption: "debtor\\s*(payment\\s*)?receipt",
    addButton: "Issue Receipt|Add/Issue",
    // BR03 — Transaction Type must be Credit Card Swipe.
    transactionType: "credit\\s*card\\s*swipe",
    supplierLabel: null,
    // A debtor receipt allocates against what the customer owes, so the
    // creditor columns are not what is being read here.
    amountColumns: ["debtor\\s*due", "amount\\s*due", "outstanding", "balance", "amount"],
    // BR03 — the other two Receipt Overview fields are fixed too.
    presets: [
      { key: "bankAccount", label: "Bank Account", match: "bank\\s*account", value: "trust" },
      { key: "receivedFrom", label: "Received From", match: "received\\s*from", value: "RAA\\s*of\\s*SA" },
    ],
    needsProfile: false,
  },
};

function getFlow(name) {
  const key = String(name || "mint").toLowerCase();
  // "westpac" is what the chat used to call the DVC flow; accept it so an
  // older session's stored choice still resolves.
  const alias = { westpac: "dvc", "westpac dvc": "dvc", mint_eft: "mint", minteft: "mint" };
  return PAYMENT_FLOWS[alias[key] || key] || PAYMENT_FLOWS.mint;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Shared helpers
 * ──────────────────────────────────────────────────────────────────────── */

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

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Step 2 — the sub-page under Booking Transactions ("Payments" for Mint and
 * TravelPay, "Receipts" for DVC and IPSI).
 *
 * Tries the URL that matches every other booking page first, then falls back to
 * clicking the left-nav link by its text. The fallback is what makes this work
 * without the probe: if the guessed slug is wrong, the nav link is right.
 */
async function openTransactionPage(page, bookingNo, flow) {
  const guessed = `${TRAMADA_BASE_URL}/booking/${flow.urlSlug}.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`;
  await page.goto(guessed, { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(600);

  const slugRe = new RegExp(flow.urlSlug, "i");
  const looksRight = await page.evaluate(
    (word) => new RegExp(word, "i").test(document.body.innerText.slice(0, 4000)) &&
      !/not found|error/i.test(document.title),
    flow.navText
  );
  if (looksRight && slugRe.test(page.url())) return page.url();

  log(`guessed ${flow.urlSlug} URL did not land; using the left-nav link`);
  await page.goto(
    `${TRAMADA_BASE_URL}/booking/booking-summary.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`,
    { waitUntil: "domcontentloaded" }
  );
  const navLink = page.locator(`a:has-text("${flow.navText}")`).first();
  if (!(await navLink.count())) {
    throw new Error(
      `Could not find a "${flow.navText}" link on booking ${bookingNo} (${flow.label} flow). ` +
        `Run "node probe-payment-page.js ${bookingNo} --flow ${flow.id}" and check the navLinks it captures.`
    );
  }
  await navLink.click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(800);
  return page.url();
}

/**
 * Step 3 — set the top-right dropdown to this flow's transaction, then click
 * its Add/Issue button.
 *
 * The dropdown can default to something else entirely, so it is always set
 * rather than assumed. Not finding the option is not fatal on its own: on a
 * tenant that words it differently the button click still lands on the right
 * form, and the form itself is checked afterwards.
 */
async function openIssueForm(page, flow) {
  const chose = await page.evaluate((pattern) => {
    const re = new RegExp(pattern, "i");
    for (const sel of document.querySelectorAll("select")) {
      const opt = Array.from(sel.options).find((o) => re.test(o.text));
      if (opt) {
        if (sel.value !== opt.value) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return { id: sel.id || null, option: opt.text.trim() };
      }
    }
    return null;
  }, flow.listOption);

  if (chose) log("transaction dropdown set to", chose.option);
  else log(`no option matching /${flow.listOption}/ in any dropdown — clicking through anyway`);
  await sleep(700);

  const parts = flow.addButton.split("|");
  const selector = parts
    .flatMap((t) => [`input[value*="${t}" i]`, `button:has-text("${t}")`])
    .join(", ");
  const addBtn = page.locator(selector).first();

  if (!(await addBtn.count())) {
    throw new Error(
      `Could not find the "${parts[0]}" button on the ${flow.navText} page (${flow.label} flow). ` +
        `Run "node probe-payment-page.js <bookingNo> --flow ${flow.id}" to capture the real button label.`
    );
  }
  await addBtn.click();
  await page.waitForLoadState("domcontentloaded");
  await sleep(1200);
  return { url: page.url(), listOption: chose ? chose.option : null };
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
 * Located by COLUMN HEADER, not by column index: a fixed index would break the
 * first time Tramada adds a column, and the four flows do not agree on which
 * columns are even present. Every money column the guides name is read, and
 * the flow says which one is the amount it pays — so a DVC read still carries
 * Creditor Payable alongside Creditor Due, and the caller can see when the two
 * disagree instead of trusting one blind.
 *
 * Seg. Type is read for all flows because DVC step 12 needs it as a Westpac
 * custom data field, and it costs nothing to carry on the others.
 */
async function readSegmentsToAllocate(page, flow) {
  return await page.evaluate(
    ({ amountColumns }) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

      // The allocation grid is the table whose headers carry one of this
      // flow's money columns. Fall back to any table with a Reference column
      // and a checkbox, which is the shape of every allocation grid in Tramada.
      const tables = Array.from(document.querySelectorAll("table"));
      const headersOf = (t) =>
        Array.from(t.querySelectorAll("th, thead td")).map((h) => norm(h.textContent));

      let table = null;
      for (const pattern of amountColumns) {
        const re = new RegExp(pattern, "i");
        table = tables.find((t) => headersOf(t).some((h) => re.test(h)));
        if (table) break;
      }
      if (!table) {
        table = tables.find(
          (t) =>
            headersOf(t).some((h) => /reference/i.test(h)) &&
            t.querySelector('input[type="checkbox"]')
        );
      }
      if (!table) return { found: false, headers: [], rows: [], amountHeader: null };

      const headerCells = headersOf(table);
      const col = (pattern) => headerCells.findIndex((h) => new RegExp(pattern, "i").test(h));

      const iRef = col("reference");
      const iSegType = col("seg\\.?\\s*type|segment\\s*type");
      const iSell = col("creditor\\s*sell");
      const iCost = col("creditor\\s*cost");
      const iPayable = col("creditor\\s*payable");
      const iDue = col("creditor\\s*due");

      // Which column this flow actually pays from.
      let iAmount = -1;
      let amountHeader = null;
      for (const pattern of amountColumns) {
        const idx = col(pattern);
        if (idx >= 0) {
          iAmount = idx;
          amountHeader = headerCells[idx];
          break;
        }
      }

      const rows = [];
      for (const tr of Array.from(table.querySelectorAll("tr"))) {
        const tds = Array.from(tr.querySelectorAll("td"));
        if (tds.length < 3) continue;

        const cells = tds.map((td) => norm(td.textContent));
        const amountText = iAmount >= 0 ? cells[iAmount] : null;
        if (!amountText || !/[0-9]/.test(amountText)) continue;

        // The "A" column checkbox is what allocates this row on the write-back.
        const box = tr.querySelector('input[type="checkbox"]');
        const amountInput = tr.querySelector('input[type="text"][id], input[id*="llocation" i]');

        rows.push({
          reference: iRef >= 0 ? cells[iRef] : null,
          segType: iSegType >= 0 ? cells[iSegType] : null,
          creditorSell: iSell >= 0 ? cells[iSell] : null,
          creditorCost: iCost >= 0 ? cells[iCost] : null,
          creditorPayable: iPayable >= 0 ? cells[iPayable] : null,
          creditorDue: iDue >= 0 ? cells[iDue] : null,
          // What THIS flow pays, whichever column that turned out to be.
          amountText,
          checkboxId: box ? box.id || null : null,
          checkboxName: box ? box.getAttribute("name") || null : null,
          amountInputId: amountInput ? amountInput.id || null : null,
          cells,
        });
      }
      return { found: true, headers: headerCells, rows, amountHeader };
    },
    { amountColumns: flow.amountColumns }
  );
}

/**
 * DVC steps 11–12 — the Booking Profile page's "Level 1 Branch".
 *
 * Westpac wants it twice: as the Supplier (the consultant's own branch/store)
 * and again as the Store Code custom data field. Missing is not fatal — step 12
 * says flag what is missing and let the consultant supply it — so this returns
 * null rather than throwing.
 */
async function readBookingProfile(page, bookingNo) {
  const guessed = `${TRAMADA_BASE_URL}/booking/booking-profile.htm?mode=edit&id=${encodeURIComponent(bookingNo)}`;
  await page.goto(guessed, { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(600);

  let found = await page.evaluate(() => {
    const text = document.body.innerText;
    const grab = (label) => {
      const m = text.match(new RegExp(label + "\\s*:?\\s*([^\\n]+)", "i"));
      return m ? m[1].trim() : "";
    };
    return {
      level1Branch: grab("Level\\s*1\\s*Branch"),
      level2Branch: grab("Level\\s*2\\s*Branch"),
      branchEmail: grab("Branch\\s*Email"),
    };
  });

  if (!found.level1Branch) {
    log("Level 1 Branch not on the guessed profile URL; trying the Profile nav link");
    const link = page.locator('a:has-text("Profile")').first();
    if (await link.count()) {
      await link.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(700);
      found = await page.evaluate(() => {
        const text = document.body.innerText;
        const grab = (label) => {
          const m = text.match(new RegExp(label + "\\s*:?\\s*([^\\n]+)", "i"));
          return m ? m[1].trim() : "";
        };
        return {
          level1Branch: grab("Level\\s*1\\s*Branch"),
          level2Branch: grab("Level\\s*2\\s*Branch"),
          branchEmail: grab("Branch\\s*Email"),
        };
      });
    }
  }

  return {
    level1Branch: found.level1Branch || null,
    level2Branch: found.level2Branch || null,
    branchEmail: found.branchEmail || null,
    profileUrl: page.url(),
  };
}

/**
 * DVC step 12 — "Agent Initials … from top left of booking page".
 *
 * The consultant is the booking's Cons1. Tramada tenants put either a name or
 * an already-abbreviated code in that field, so both are handled: a short
 * all-letters code is taken as the initials it already is, and anything longer
 * is reduced to first-letter-of-first-word + first-letter-of-last-word.
 */
function initialsFrom(consultant) {
  const raw = String(consultant || "").trim();
  if (!raw) return null;
  if (/^[A-Za-z]{2,4}$/.test(raw)) return raw.toUpperCase();
  const words = raw.split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Read Cons1 off the booking summary page we are already standing on. */
async function readConsultant(page) {
  return await page.evaluate(() => {
    const text = document.body.innerText;
    const grab = (label) => {
      const m = text.match(new RegExp(label + "\\s*:?\\s*([^\\n]+)", "i"));
      return m ? m[1].trim() : "";
    };
    return {
      cons1: grab("Cons\\s*1") || grab("Consultant"),
      cons2: grab("Cons\\s*2"),
    };
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * The read
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Open a booking and read everything the chosen flow needs. Read-only.
 *
 * @param {object} opts
 *   flow       "mint" | "travelpay" | "dvc" | "ipsi"  (default "mint")
 *   bookingNo  required
 *   supplier   optional — supplier to select in Payment To / Creditor. Omit
 *              and, when the booking has more than one, the caller is handed
 *              the list to ask about rather than the agent guessing. Paying
 *              the right amount to the wrong supplier has no automated
 *              recovery. Ignored on IPSI, which has no supplier.
 *   username/password  optional Tramada credentials (a warm CDP session is
 *              used as-is when they are omitted)
 *   callbacks  { onProgress(pct, msg), onNeedLogin() }
 */
async function readPaymentBooking({
  flow: flowName,
  bookingNo,
  supplier,
  username,
  password,
  callbacks = {},
} = {}) {
  const onProgress = callbacks.onProgress || (() => {});
  if (!bookingNo) throw new Error("bookingNo is required.");
  const flow = getFlow(flowName);

  let browser, context, page, launched = false;
  try {
    ({ browser, launched } = await openBrowser(onProgress));
    context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();

    onProgress(10, "Checking Tramada session...");
    await ensureLoggedIn(page, { username, password, onNeedLogin: callbacks.onNeedLogin });

    // Step 1 — open the booking. Also gives us the client name, which becomes
    // Payee Name on the write-back, passenger_name at Mint, "Member/Pax Name"
    // at Westpac and the fallback payer on an IPSI receipt.
    onProgress(20, `Opening booking ${bookingNo}...`);
    const details = await getBookingDetails(page, bookingNo);
    // Still on booking-summary here, which is where Cons1 lives.
    const consultant = await readConsultant(page);

    // DVC step 11 — the branch, before we navigate away into the form.
    let profile = null;
    if (flow.needsProfile) {
      onProgress(30, "Reading Booking Profile for the branch...");
      profile = await readBookingProfile(page, bookingNo);
    }

    // Step 2
    onProgress(42, `Opening Booking ${flow.navText}...`);
    const listUrl = await openTransactionPage(page, bookingNo, flow);

    // Step 3
    onProgress(55, `Opening the ${flow.label} form...`);
    const opened = await openIssueForm(page, flow);

    // Step 4 — Transaction Type, where the flow has one. Set before reading
    // anything else, since Tramada re-renders parts of the form when it changes.
    let transactionType = null;
    if (flow.transactionType) {
      onProgress(64, "Setting transaction type...");
      const txnSelect = await findSelectByLabel(page, "transaction\\s*type");
      if (txnSelect) {
        transactionType = await setSelectByText(page, txnSelect, flow.transactionType);
        await sleep(900);
      }
    }

    // IPSI BR03 — Bank Account and Received From are pinned too. Set and read
    // back, so the summary can show the consultant what the form now holds.
    const presets = {};
    for (const preset of flow.presets) {
      const sel = await findSelectByLabel(page, preset.match);
      presets[preset.key] = sel ? await setSelectByText(page, sel, preset.value) : null;
      if (sel) await sleep(400);
    }

    // Step 5 — the supplier/creditor, on the flows that have one.
    let suppliers = [];
    let selectedSupplier = null;
    if (flow.supplierLabel) {
      onProgress(76, "Reading suppliers...");
      const payToSelect = await findSelectByLabel(page, flow.supplierLabel);
      suppliers = payToSelect ? payToSelect.options : [];

      if (payToSelect) {
        if (supplier) {
          selectedSupplier = await setSelectByText(page, payToSelect, escapeRe(supplier));
          if (!selectedSupplier) {
            throw new Error(
              `Supplier "${supplier}" is not in the ${flow.label} creditor list for booking ${bookingNo}. ` +
                `Available: ${suppliers.map((s) => s.text).join(", ") || "none"}`
            );
          }
          await sleep(900);
        } else if (suppliers.length === 1) {
          selectedSupplier = await setSelectByText(page, payToSelect, escapeRe(suppliers[0].text));
          await sleep(900);
        }
      }
    }

    // Step 6 — Segments to Allocate.
    onProgress(90, "Reading segments to allocate...");
    const allocation = await readSegmentsToAllocate(page, flow);

    const segments = allocation.rows.map((r) => ({
      ...r,
      amount: toAmount(r.amountText),
      // Kept under its old name so anything still reading creditorPayableAmount
      // (and the payment summary card) keeps working on the Mint flow.
      creditorPayableAmount: toAmount(r.creditorPayable != null ? r.creditorPayable : r.amountText),
      creditorDueAmount: toAmount(r.creditorDue),
    }));

    // DVC only — step 16 says Creditor Due, BR12 says Creditor Payable. Say so
    // when the booking makes the choice matter, rather than picking silently.
    const sumOf = (key) =>
      segments.reduce((n, s) => n + (toAmount(s[key]) || 0), 0);
    const amountColumnConflict =
      flow.id === "dvc" &&
      segments.some((s) => s.creditorDue != null && s.creditorPayable != null) &&
      Math.abs(sumOf("creditorDue") - sumOf("creditorPayable")) > 0.005
        ? { due: sumOf("creditorDue"), payable: sumOf("creditorPayable") }
        : null;

    onProgress(100, "Read complete.");

    const total = segments.reduce((n, s) => n + (s.amount || 0), 0);

    return {
      flow: flow.id,
      flowLabel: flow.label,
      flowKind: flow.kind,
      guide: flow.guide,

      bookingNo: details.bookingNo || String(bookingNo),
      clientName: details.clientName || details.client || null,
      debtor: details.debtor || null,
      itinerary: details.itinerary || null,
      depDate: details.depDate || null,

      consultant: consultant.cons1 || null,
      agentInitials: initialsFrom(consultant.cons1),

      // DVC step 11/12
      level1Branch: profile ? profile.level1Branch : null,
      branchEmail: profile ? profile.branchEmail : null,
      profileUrl: profile ? profile.profileUrl : null,

      transactionType: transactionType ? transactionType.text : null,
      listOption: opened.listOption,
      presets,

      suppliers,
      // More than one creditor on a booking means more than one payment — one
      // external transaction and one human authorisation each. The caller asks.
      // DVC BR08 makes this explicit: one card per supplier, per booking.
      needsSupplierChoice: !!flow.supplierLabel && !selectedSupplier && suppliers.length > 1,
      supplier: selectedSupplier ? selectedSupplier.text : null,

      segments,
      segmentsFound: allocation.found,
      headers: allocation.headers,
      // What the amount column on this page is actually called, so the UI can
      // label the column it shows rather than hard-coding "Creditor Payable".
      amountHeader: allocation.amountHeader || null,
      amountColumnConflict,
      total,

      listUrl,
      formUrl: opened.url,
      // Kept for callers written against the Mint-only version.
      paymentsUrl: listUrl,
    };
  } finally {
    // Leave a CDP-attached Chrome alone — it is the human's browser and their
    // warm Tramada session lives in it.
    await page?.close().catch(() => {});
    if (browser && launched) await browser.close().catch(() => {});
  }
}

/** The Mint-only entry point this module used to export. */
function readCreditorPayment(opts = {}) {
  return readPaymentBooking({ ...opts, flow: opts.flow || "mint" });
}

module.exports = {
  readPaymentBooking,
  readCreditorPayment,
  toAmount,
  getFlow,
  initialsFrom,
  PAYMENT_FLOWS,
};
