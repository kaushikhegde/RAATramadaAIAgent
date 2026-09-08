/**
 * payment-views.js — what each payment flow shows the consultant.
 * ================================================================
 * Pure functions over the object tramada-payment.js hands back. No browser, no
 * socket, no side effects — so the business rules that matter most (DVC's
 * cumulative limit and 2-year validity window, TravelPay's passenger-name
 * format, IPSI's amount cross-check) can be tested without Tramada in front of
 * them, which is the only way they ever get tested at all.
 *
 * Three views, per flow:
 *
 *   summaryView(result)          what came out of Tramada
 *   planView(result, answers)    what the consultant is about to key in
 *   handoverView(result, ...)    the field-by-field mapping, and the full stop
 *
 * The full stop is the point. Every one of the four guides ends the agent's
 * involvement before money moves — Mint BR02, TravelPay BR02, DVC BR07/BR10,
 * IPSI BR07 — so handoverView's job is to make a human's next five minutes
 * unambiguous, not to shorten them.
 */

const money = (n) => (n == null ? null : "$" + Number(n).toFixed(2));

/**
 * Escape a value on its way into a hand-off field.
 *
 * These strings are rendered as HTML — a field mapping is unreadable without
 * <b>, and the <i> placeholders carry the "this is missing" meaning — so the
 * markup below is deliberate and stays. That makes everything read out of
 * Tramada, and everything the consultant typed at the chat, something that has
 * to be escaped first: a supplier called "Smith & Sons <AU>" is a value, not a
 * tag, and an IPSI cardholder name is free text a human just typed.
 */
function h(v) {
  return String(v == null ? "" : v).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Dates
 * ──────────────────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, "0");

/** DD/MM/YYYY — how dates read everywhere in the Westpac and Tramada UIs. */
function fmtDate(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** DD.MM.YYYY — DVC BR06 requires dots for the Card Request Date field. */
function fmtDotted(d) {
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function addDays(d, n) {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + n);
  return out;
}

function addYears(d, n) {
  const out = new Date(d.getTime());
  out.setFullYear(out.getFullYear() + n);
  return out;
}

/**
 * Accepts what a consultant actually types for a check-in date: 25/12/2026,
 * 25-12-2026, 25.12.2026, 2026-12-25. Day-first, because that is how dates are
 * written in the guides and in Australia — 03/04/2026 is 3 April, never 4 March.
 * Returns null on anything ambiguous or impossible, and the caller re-asks.
 */
function parseDate(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  let y, m, d;
  let match = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    [, y, m, d] = match;
  } else {
    match = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (!match) return null;
    [, d, m, y] = match;
    if (String(y).length === 2) y = `20${y}`;
  }

  const date = new Date(Number(y), Number(m) - 1, Number(d));
  // Rejects 31/02 and friends, which Date would otherwise roll into March.
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(m) - 1 ||
    date.getDate() !== Number(d)
  ) {
    return null;
  }
  return date;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Small readers over the segment rows
 * ──────────────────────────────────────────────────────────────────────── */

/** Client last name — Mint step 9, TravelPay BR03, DVC "Member/Pax Name". */
function lastName(clientName) {
  const parts = String(clientName || "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * The booking reference the external system wants.
 *
 * TravelPay step 8 asks for "the alphanumeric characters found in the Reference
 * column", which is the reference token rather than the whole cell — a cell
 * reading "RRC - MG752045" carries a prefix that is Tramada's, not the
 * supplier's. Take the longest alphanumeric run and leave the decoration.
 */
function referenceToken(cell) {
  const runs = String(cell || "").match(/[A-Za-z0-9]+/g);
  if (!runs || !runs.length) return null;
  return runs.reduce((best, r) => (r.length > best.length ? r : best), "");
}

/** First reference across the allocated segments, or null. BR01 on 3 guides. */
function firstReference(result) {
  return (result.segments || []).map((s) => s.reference).filter(Boolean)[0] || null;
}

/** Distinct Seg. Types on the booking — DVC step 12's "Segment Type" field. */
function segmentTypes(result) {
  const seen = [];
  for (const s of result.segments || []) {
    if (s.segType && !seen.includes(s.segType)) seen.push(s.segType);
  }
  return seen;
}

/* ─────────────────────────────────────────────────────────────────────────
 * View 1 — what came out of Tramada
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The card drawn right after the read. Same shape for all four flows so the UI
 * stays one renderer, but the rows and the money column are the flow's own:
 * a DVC read shows Creditor Due and the branch, an IPSI read shows the pinned
 * Receipt Overview fields and no supplier at all.
 */
function summaryView(result) {
  const rows = [];
  const notes = [];

  rows.push(["Client", result.clientName]);

  if (result.flowKind === "supplier") {
    rows.push(["Supplier", result.supplier]);
  } else {
    rows.push(["Debtor", result.debtor]);
  }

  if (result.transactionType) rows.push(["Transaction type", result.transactionType]);

  // IPSI BR03 — show that the two pinned fields really did get set, because
  // "the form is on Credit Card Swipe against the Trust account" is exactly
  // the sort of thing that is assumed and then found wrong at Issue.
  for (const [key, label] of [["bankAccount", "Bank account"], ["receivedFrom", "Received from"]]) {
    const preset = result.presets && result.presets[key];
    if (preset) rows.push([label, preset.text]);
    else if (result.presets && key in result.presets) {
      notes.push(`Could not set <b>${label}</b> on the form — set it by hand before issuing.`);
    }
  }

  if (result.flow === "dvc") {
    rows.push(["Consultant", result.consultant]);
    rows.push(["Branch (Level 1)", result.level1Branch]);
  }

  rows.push(["Segments", String((result.segments || []).length)]);
  rows.push([
    result.amountHeader ? `Total ${result.amountHeader.toLowerCase()}` : "Total",
    money(result.total),
  ]);

  // DVC only: the guide contradicts itself about which column to pay from, so
  // say so rather than quietly picking one.
  if (result.amountColumnConflict) {
    notes.push(
      `Creditor Due (<b>${money(result.amountColumnConflict.due)}</b>) and Creditor Payable ` +
        `(<b>${money(result.amountColumnConflict.payable)}</b>) differ on this booking. ` +
        `Step 16 of the DVC guide says pay from <b>Creditor Due</b>, so that is what I have used — ` +
        `check it before you request the card.`
    );
  }

  return {
    flow: result.flow,
    title: `Booking ${result.bookingNo} — ${result.flowLabel} ${
      result.flowKind === "supplier" ? "supplier payment" : "customer receipt"
    }`,
    rows: rows.filter(([, v]) => v != null && v !== ""),
    segmentColumns: [
      { key: "reference", label: "Reference" },
      ...(result.flow === "dvc" ? [{ key: "segType", label: "Seg. type" }] : []),
      { key: "amountText", label: result.amountHeader || "Amount", align: "right" },
    ],
    segments: result.segments || [],
    notes,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * View 2 — the DVC card request (Westpac steps 8–12)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Everything the consultant is about to type into Westpac's Create Single
 * Request page, with the arithmetic done and the gaps named.
 *
 * @param answers { validity: "standard" | "custom", checkInDate: Date|null }
 * @param today   injectable so the tests aren't a different answer tomorrow
 */
function dvcPlanView(result, answers = {}, today = new Date()) {
  const warnings = [];
  const startDefault = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let start = startDefault;
  let end;

  if (answers.validity === "custom" && answers.checkInDate) {
    // BR03 — a custom period runs to the check-in date.
    end = answers.checkInDate;
    const latestEnd = addYears(start, 2);
    if (end > latestEnd) {
      // BR03's tail: the end date must stay within 2 years of the start, so it
      // is the START that moves, not the check-in date. Flagged, never silent —
      // a card that starts months from now is not a card the consultant can use
      // today, and they have to decide whether that is what they want.
      start = addYears(end, -2);
      warnings.push(
        `Check-in is more than 2 years out, so the end date cannot sit within 2 years of today. ` +
          `BR03 says the start date moves: I have set it to <b>${fmtDate(start)}</b> so the ` +
          `${fmtDate(end)} end date is legal. <b>The card will not work before that start date</b> — ` +
          `confirm that is what you want, or shorten the validity period.`
      );
    }
  } else {
    // BR03 — standard is 7 days from the start date.
    end = addDays(start, 7);
  }

  // BR04 — amount owed plus a $5 buffer for card fees, rounded UP to the dollar.
  const owed = Number(result.total || 0);
  const cumulativeLimit = Math.ceil(owed + 5);
  if (cumulativeLimit > 20000) {
    warnings.push(
      `The cumulative limit is <b>$${cumulativeLimit}</b>, over the $20,000 threshold — BR04 means ` +
        `this card needs approval from another authorised person before it can be used.`
    );
  }

  const ref = firstReference(result);
  const types = segmentTypes(result);

  // Step 12. `missing` drives the "what I could not find" prompt: the guide
  // says flag them and let the consultant fix the booking or supply the value,
  // rather than submitting a half-filled request.
  const customFields = [
    { label: "Agent Initials", value: result.agentInitials, source: "Cons1, top left of the booking" },
    { label: "Store Code", value: result.level1Branch, source: "Booking Profile → Level 1 Branch" },
    { label: "Supplier Name", value: result.supplier, source: "Creditor field" },
    {
      label: "Supplier Reference",
      value: ref ? referenceToken(ref) : null,
      source: "Segments to Allocate → Reference",
      // BR06 — only entered if Tramada already has it. Absent is allowed here.
      optional: true,
    },
    {
      // BR06 — numbers only; letters are rejected by the portal.
      label: "Tramada Booking Number",
      value: String(result.bookingNo || "").replace(/\D/g, "") || null,
      source: "top left of the booking",
    },
    { label: "Member/Pax Name", value: result.clientName, source: "Client Name" },
    {
      label: "Segment Type",
      value: types.length ? types.join(", ") : null,
      source: "Segments to Allocate → Seg. Type",
    },
    // BR06 — dots, not slashes.
    { label: "Card Request Date", value: fmtDotted(startDefault), source: "today" },
  ];

  const missing = customFields.filter((f) => !f.optional && !f.value).map((f) => f.label);
  if (missing.length) {
    warnings.push(
      `Missing from the Tramada booking: <b>${missing.join(", ")}</b>. Step 12 says fix the booking ` +
        `or give me the values here — don't submit the request with them blank.`
    );
  }
  if (!ref) {
    warnings.push(
      `No reference on the segment. BR06 says Supplier Reference is only entered when Tramada ` +
        `already has it, so leave that field blank — but raise it with a human.`
    );
  }

  return {
    title: `Westpac — Create Single Request for booking ${result.bookingNo}`,
    rows: [
      ["Purchase Template", "RAA – DVC Supplier Payments Template"],
      ["Start Date", fmtDate(start)],
      [
        "End Date",
        `${fmtDate(end)}  (${answers.validity === "custom" ? "custom — check-in date" : "standard — 7 days"})`,
      ],
      ["Cumulative Limit", `$${cumulativeLimit}  (${money(owed)} owed + $5 buffer, rounded up)`],
      ["Maximum Number of Transactions", "0  (BR05 — always unlimited)"],
      ["Supplier (branch/store)", result.level1Branch],
      ["Supplier Emails", "prepopulated from the branch"],
      ["User Defined Emails", "the consultant's own RAA email address"],
    ].filter(([, v]) => v != null && v !== ""),
    customFields,
    warnings,
    startDate: start,
    endDate: end,
    cumulativeLimit,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * View 3 — the hand-off
 * ──────────────────────────────────────────────────────────────────────── */

const MISSING_REF =
  "<i>no reference on the segment — raise it with a human, and fill in the rest</i>";

/**
 * Mint step 9 — the MintEFT New Payment form.
 *
 * BR02: the agent never makes the payment; a human does. What it can do is name
 * which box each Tramada value goes in, which is the one thing MintEFT's own
 * screen cannot show — over there the consultant is looking at empty fields
 * with nothing to say what Tramada called any of them.
 */
function mintHandover(result) {
  const ref = firstReference(result);
  return {
    system: "MintEFT",
    title: `Booking ${result.bookingNo} → MintEFT "Create New Payment"`,
    where: 'Log in to MintEFT and click "New Payment" in the left nav.',
    fields: [
      ["Recipient Reference", ref ? h(ref) : MISSING_REF],
      ["Sender Reference", h(result.bookingNo)],
      ["Passenger Name", h(lastName(result.clientName))],
      ["Total Amount", money(result.total)],
      ["Payment Date", "today"],
      ["Payee Name or Number", h(result.supplier)],
    ],
    stop:
      `Click <b>Proceed with Payment</b> and stop. <b>The payment is yours to make</b> — I don't ` +
      `touch Mint. Check the Confirm Payment page and press <b>Confirm</b> yourself.`,
    back:
      `Mint gives back a transaction id in the format <b>M00XXXXXX</b> (M-zero-zero and six digits — ` +
      `not a Payee Customer Number, which is <b>MXXXXXX</b>). That id goes into Tramada's ` +
      `<b>Reference</b> field on the Issue Creditor Payment page (step 12).`,
  };
}

/** TravelPay step 8 — b2b.travelpay.com.au, "Make A Payment". */
function travelpayHandover(result) {
  const ref = firstReference(result);
  const token = ref ? referenceToken(ref) : null;
  const surname = lastName(result.clientName);
  return {
    system: "TravelPay",
    title: `Booking ${result.bookingNo} → TravelPay "Make A Payment"`,
    where:
      'Log in to TravelPay (b2b.travelpay.com.au) and click "Make A Payment" in the left nav.',
    fields: [
      ["Supplier", h(result.supplier)],
      ["Pay", "Pay Now"],
      ["Supplier Booking Reference", token ? h(token) : MISSING_REF],
      // BR03 — LAST NAME + booking number, e.g. "GRAY 123456".
      ["Passenger Name", surname ? h(`${surname.toUpperCase()} ${result.bookingNo}`) : MISSING_REF],
      ["Payment Amount", money(result.total)],
      ["Payment Account", "leave as is (Existing Account – Bank…)"],
    ],
    stop:
      `Stop there. <b>The payment is yours to make</b> — BR02 says I must never process a payment ` +
      `on TravelPay. Tick the confirmation checkbox and click <b>Pay Now</b> yourself.`,
    back:
      `TravelPay gives back an <b>8-digit transaction id</b> (also under "My Payment History"). ` +
      `That id goes into Tramada's <b>Reference</b> field on the Issue Creditor Payment page (step 11).`,
    notes: token
      ? []
      : [
          `Couldn't read a Supplier Booking Reference. It is also in the booking under ` +
            `<b>Costing → the supplier segment → Status Details → Creditor Inv. No.</b>`,
        ],
  };
}

/**
 * DVC steps 13–18 — what happens after Westpac hands over a card.
 *
 * Three separate human actions, in order, and the agent is barred from all
 * three: Submit in Westpac (BR07), paying the supplier (BR10), and the card
 * details never passing through the agent at all (BR09 / the LastPass note).
 */
function dvcHandover(result, plan) {
  const ref = firstReference(result);
  const token = ref ? referenceToken(ref) : null;
  return {
    system: "Westpac Commercial Cards",
    title: `Booking ${result.bookingNo} → Westpac DVC, then back into Tramada`,
    where:
      "In the Westpac portal: Payment Control → Purchase Requests → Create Single Request, " +
      "filled in as above.",
    fields: [
      ["1. Submit in Westpac", "<b>you click Submit</b>, not me (BR07) — the card, expiry and CVV show once"],
      ["2. Copy the card into Tramada", "booking Summary → Booking notes: card number, expiry, CVC (BR09)"],
      ["3. Pay the supplier", "on their own portal with the DVC, and keep the payment reference (BR10)"],
      ["4. Back on Issue Agency Credit Card Transaction", ""],
      ["  Credit Card", "Westpac DVC"],
      ["  Authorisation Number", "XX6780"],
      ["  Payer Name", result.consultant ? h(result.consultant) : "<i>the consultant — Cons1</i>"],
      ["  Amount Received", money(result.total)],
      // BR11 — the prefix is not optional.
      ["  Reference", token ? `RRC - ${h(token)}` : `<b>RRC - </b>${MISSING_REF}`],
      ["5. Segments to Allocate", "tick the A column, then Issue"],
    ],
    stop:
      `<b>Submit is yours</b> (BR07), and so is the payment on the supplier's portal (BR10). ` +
      `One card per supplier per booking — paying a second supplier means running this again (BR08).`,
    back:
      `The reference from the supplier's portal goes into Tramada's <b>Reference</b> field with the ` +
      `<b>RRC - </b> prefix (BR11) — e.g. <b>RRC - MG752045</b>.`,
    notes: [
      `Cross-check the amount owed on the supplier's portal against Tramada's ` +
        `<b>${money(result.total)}</b> before you pay. If they differ, BR02 says confirm the ` +
        `supplier booking number and flag the discrepancy rather than paying either figure.`,
      ...(plan && plan.cumulativeLimit > 20000
        ? [`This card needs a second authoriser before it will work (BR04).`]
        : []),
    ],
  };
}

/**
 * IPSI steps 4–9 — a debtor receipt against a charge a human already took.
 *
 * Unlike the other three there is no external form to fill: the payment has
 * already happened in IPSI and everything here is Tramada data entry. The
 * customer's real card number never appears — BR04 — so the mapping names the
 * dummy card instead, which is the part most likely to be got wrong by hand.
 */
function ipsiHandover(result, ipsi) {
  const mismatch =
    ipsi.amount != null &&
    result.total != null &&
    Math.abs(Number(ipsi.amount) - Number(result.total)) > 0.005;

  return {
    system: "Tramada",
    title: `Booking ${result.bookingNo} → Issue Debtor Payment Receipt`,
    where: "On the receipt form already open in Tramada:",
    fields: [
      ["Transaction Type", "Credit Card Swipe (BR03)"],
      ["Bank Account", "[TRUST] Trust Account (BR03)"],
      ["Received From", "RAA of SA Limited (Retail) (BR03)"],
      ["Credit Card → Add", ""],
      ["  Category", "Personal"],
      // BR04 — never the customer's real number.
      ["  Card Number", `RAA Dummy Card for ${ipsi.cardType ? h(ipsi.cardType) : "<i>the card type they used</i>"} (BR04)`],
      ["  Card Type", ipsi.cardType ? h(ipsi.cardType) : "<i>confirm with the customer (BR02)</i>"],
      // BR05 — overwrite the dummy card's default holder name.
      ["  Card Holder", ipsi.cardholderName ? h(ipsi.cardholderName) : "<i>the paying customer's name (BR05)</i>"],
      ["Payer Name", ipsi.cardholderName ? h(ipsi.cardholderName) : "<i>the paying customer's name</i>"],
      ["Amount Received", money(ipsi.amount)],
      ["Reference", ipsi.transactionRef ? h(ipsi.transactionRef) : MISSING_REF],
      ["Segments to Allocate", "tick the A column — amounts must match (BR06)"],
    ],
    stop:
      `Check it and click <b>Issue</b> yourself. I never process the card charge in IPSI (BR07) and ` +
      `I stop before receipting so a human confirms the customer's name first.`,
    back: null,
    notes: [
      ...(mismatch
        ? [
            `<b>The amounts don't match.</b> IPSI took <b>${money(ipsi.amount)}</b>, Tramada shows ` +
              `<b>${money(result.total)}</b> to allocate. BR06 says these must agree before you tick ` +
              `the A column — sort out which is right before issuing.`,
          ]
        : []),
      `Confirm the payer is the customer on the booking; if not, capture their first and last ` +
        `name and use that (BR01).`,
    ],
  };
}

function handoverView(result, extra = {}) {
  switch (result.flow) {
    case "travelpay":
      return travelpayHandover(result);
    case "dvc":
      return dvcHandover(result, extra.plan);
    case "ipsi":
      return ipsiHandover(result, extra.ipsi || {});
    default:
      return mintHandover(result);
  }
}

module.exports = {
  summaryView,
  dvcPlanView,
  handoverView,
  // exported for the tests and the chat's own formatting
  parseDate,
  fmtDate,
  fmtDotted,
  addDays,
  addYears,
  lastName,
  referenceToken,
  firstReference,
  segmentTypes,
  money,
  h,
};
