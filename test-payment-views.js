/**
 * test-payment-views.js — the payment business rules, without a browser.
 *
 *   node test-payment-views.js
 *
 * These are the rules that cost money when they are wrong: DVC's cumulative
 * limit and its 2-year validity window, TravelPay's passenger-name format,
 * IPSI's amount cross-check. All of them are arithmetic or string shaping over
 * a Tramada read, so none of them needs Tramada — which is the only reason
 * they get tested at all.
 */

const assert = require("assert");
const V = require("./payment-views");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

/** A read result shaped like the one tramada-payment.js returns. */
function booking(over = {}) {
  return {
    flow: "mint",
    flowLabel: "Mint",
    flowKind: "supplier",
    bookingNo: "13061",
    clientName: "MEGAN GRAY",
    debtor: "RAA of SA Limited",
    consultant: "Bryan Chiam",
    agentInitials: "BC",
    level1Branch: "MIL",
    supplier: "Room-Res",
    transactionType: "EFT",
    presets: {},
    segments: [
      { reference: "MG752045", segType: "Hotel", creditorPayable: "374.29", amountText: "374.29", amount: 374.29 },
    ],
    segmentsFound: true,
    amountHeader: "Creditor Payable",
    amountColumnConflict: null,
    total: 374.29,
    ...over,
  };
}

const JULY_23 = new Date(2026, 6, 23); // 23 July 2026, matching the guide's screenshot

console.log("\ndates");

test("parseDate reads day-first, not month-first", () => {
  const d = V.parseDate("03/04/2026");
  assert.strictEqual(d.getDate(), 3);
  assert.strictEqual(d.getMonth(), 3, "April");
});

test("parseDate accepts dots, dashes and ISO", () => {
  for (const s of ["25.12.2026", "25-12-2026", "2026-12-25"]) {
    const d = V.parseDate(s);
    assert.ok(d, `${s} should parse`);
    assert.strictEqual(d.getDate(), 25);
    assert.strictEqual(d.getMonth(), 11);
  }
});

test("parseDate rejects an impossible date rather than rolling it over", () => {
  assert.strictEqual(V.parseDate("31/02/2026"), null);
  assert.strictEqual(V.parseDate("tomorrow"), null);
  assert.strictEqual(V.parseDate(""), null);
});

console.log("\nDVC — BR04 cumulative limit");

test("BR04 the guide's own example: $246.75 owed → $252", () => {
  const plan = V.dvcPlanView(booking({ total: 246.75 }), { validity: "standard" }, JULY_23);
  assert.strictEqual(plan.cumulativeLimit, 252);
});

test("BR04 rounds UP to the dollar, never down", () => {
  assert.strictEqual(V.dvcPlanView(booking({ total: 100.01 }), {}, JULY_23).cumulativeLimit, 106);
  assert.strictEqual(V.dvcPlanView(booking({ total: 100 }), {}, JULY_23).cumulativeLimit, 105);
});

test("BR04 flags a limit over $20,000 as needing a second authoriser", () => {
  const plan = V.dvcPlanView(booking({ total: 25000 }), {}, JULY_23);
  assert.strictEqual(plan.cumulativeLimit, 25005);
  assert.ok(plan.warnings.some((w) => /another authorised person/i.test(w)));
});

test("BR04 does not flag a limit under the threshold", () => {
  const plan = V.dvcPlanView(booking({ total: 374.29 }), {}, JULY_23);
  assert.ok(!plan.warnings.some((w) => /20,000/.test(w)));
});

console.log("\nDVC — BR03 validity period");

test("BR03 standard is 7 days from today", () => {
  const plan = V.dvcPlanView(booking(), { validity: "standard" }, JULY_23);
  assert.strictEqual(V.fmtDate(plan.startDate), "23/07/2026");
  assert.strictEqual(V.fmtDate(plan.endDate), "30/07/2026");
});

test("BR03 custom runs to the check-in date", () => {
  const plan = V.dvcPlanView(
    booking(),
    { validity: "custom", checkInDate: new Date(2026, 11, 25) },
    JULY_23
  );
  assert.strictEqual(V.fmtDate(plan.endDate), "25/12/2026");
  assert.strictEqual(V.fmtDate(plan.startDate), "23/07/2026", "start stays today when it fits");
  assert.ok(!plan.warnings.some((w) => /2 years/i.test(w)));
});

test("BR03 a check-in beyond 2 years moves the START date and says so", () => {
  const checkIn = new Date(2029, 5, 1); // ~3 years out
  const plan = V.dvcPlanView(booking(), { validity: "custom", checkInDate: checkIn }, JULY_23);
  assert.strictEqual(V.fmtDate(plan.endDate), "01/06/2029", "end stays the check-in date");
  assert.strictEqual(V.fmtDate(plan.startDate), "01/06/2027", "start pulled to 2 years before it");
  assert.ok(
    plan.warnings.some((w) => /will not work before that start date/i.test(w)),
    "the consultant must be told the card is not usable today"
  );
});

test("BR03 exactly 2 years out is still legal, start unmoved", () => {
  const plan = V.dvcPlanView(
    booking(),
    { validity: "custom", checkInDate: new Date(2028, 6, 23) },
    JULY_23
  );
  assert.strictEqual(V.fmtDate(plan.startDate), "23/07/2026");
  assert.ok(!plan.warnings.some((w) => /2 years/i.test(w)));
});

console.log("\nDVC — step 12 custom data fields");

test("BR06 Tramada Booking Number is digits only", () => {
  const plan = V.dvcPlanView(booking({ bookingNo: "B13061" }), {}, JULY_23);
  const f = plan.customFields.find((f) => f.label === "Tramada Booking Number");
  assert.strictEqual(f.value, "13061");
});

test("BR06 Card Request Date is DD.MM.YYYY", () => {
  const plan = V.dvcPlanView(booking(), {}, JULY_23);
  const f = plan.customFields.find((f) => f.label === "Card Request Date");
  assert.strictEqual(f.value, "23.07.2026");
});

test("step 12 fields come off the booking", () => {
  const plan = V.dvcPlanView(booking(), {}, JULY_23);
  const by = (l) => plan.customFields.find((f) => f.label === l).value;
  assert.strictEqual(by("Agent Initials"), "BC");
  assert.strictEqual(by("Store Code"), "MIL");
  assert.strictEqual(by("Supplier Name"), "Room-Res");
  assert.strictEqual(by("Supplier Reference"), "MG752045");
  assert.strictEqual(by("Member/Pax Name"), "MEGAN GRAY");
  assert.strictEqual(by("Segment Type"), "Hotel");
});

test("step 12 names what the booking is missing, and does not count optional ones", () => {
  const plan = V.dvcPlanView(
    booking({ level1Branch: null, agentInitials: null, segments: [{ reference: "", amountText: "10.00" }] }),
    {},
    JULY_23
  );
  const warning = plan.warnings.find((w) => /Missing from the Tramada booking/.test(w));
  assert.ok(warning, "should flag the gaps");
  assert.ok(/Store Code/.test(warning) && /Agent Initials/.test(warning));
  assert.ok(!/Supplier Reference/.test(warning), "BR06 makes that one optional");
  assert.ok(plan.warnings.some((w) => /No reference on the segment/i.test(w)));
});

console.log("\nTravelPay — step 8");

test("BR03 passenger name is LAST NAME + booking number", () => {
  const h = V.handoverView(booking({ flow: "travelpay", flowLabel: "TravelPay" }));
  const [, value] = h.fields.find(([k]) => k === "Passenger Name");
  assert.strictEqual(value, "GRAY 13061");
});

test("Supplier Booking Reference is the token, not the decorated cell", () => {
  assert.strictEqual(V.referenceToken("RRC - MG752045"), "MG752045");
  assert.strictEqual(V.referenceToken("MG752045"), "MG752045");
  assert.strictEqual(V.referenceToken(""), null);
});

test("BR04 names the 8-digit id, and BR02 keeps the agent off the button", () => {
  const h = V.handoverView(booking({ flow: "travelpay" }));
  assert.ok(/8-digit/.test(h.back));
  assert.ok(/never process a payment/i.test(h.stop));
});

test("a missing reference points at Costing → Creditor Inv. No.", () => {
  const h = V.handoverView(booking({ flow: "travelpay", segments: [{ reference: "", amountText: "10" }] }));
  assert.ok(h.notes.some((n) => /Creditor Inv\. No\./.test(n)));
});

console.log("\nMint — step 9");

test("BR03 spells out M00 vs the payee number, and BR01 survives a missing ref", () => {
  const h = V.handoverView(booking());
  assert.ok(/M00XXXXXX/.test(h.back) && /MXXXXXX/.test(h.back));
  const bare = V.handoverView(booking({ segments: [{ reference: "", amountText: "10" }] }));
  const [, ref] = bare.fields.find(([k]) => k === "Recipient Reference");
  assert.ok(/raise it with a human/.test(ref));
});

test("passenger name is the client's last name only", () => {
  const [, v] = V.handoverView(booking()).fields.find(([k]) => k === "Passenger Name");
  assert.strictEqual(v, "GRAY");
});

console.log("\nDVC — hand-off");

test("BR11 puts the RRC - prefix on the Tramada reference", () => {
  const r = booking({ flow: "dvc", flowLabel: "Westpac DVC" });
  const h = V.handoverView(r, { plan: V.dvcPlanView(r, {}, JULY_23) });
  const [, v] = h.fields.find(([k]) => /Reference$/.test(k.trim()));
  assert.strictEqual(v, "RRC - MG752045");
});

test("step 16's fixed values are carried through", () => {
  const r = booking({ flow: "dvc" });
  const h = V.handoverView(r, { plan: V.dvcPlanView(r, {}, JULY_23) });
  const by = (l) => h.fields.find(([k]) => k.trim() === l)[1];
  assert.strictEqual(by("Credit Card"), "Westpac DVC");
  assert.strictEqual(by("Authorisation Number"), "XX6780");
  assert.strictEqual(by("Payer Name"), "Bryan Chiam", "Cons1, not the client");
});

test("BR02 asks for the supplier-portal cross-check", () => {
  const r = booking({ flow: "dvc" });
  const h = V.handoverView(r, { plan: V.dvcPlanView(r, {}, JULY_23) });
  assert.ok(h.notes.some((n) => /Cross-check the amount owed/i.test(n)));
});

console.log("\nIPSI");

test("BR06 flags an IPSI amount that disagrees with Tramada", () => {
  const r = booking({ flow: "ipsi", flowKind: "customer", total: 374.29 });
  const h = V.handoverView(r, { ipsi: { amount: 400, transactionRef: "IPSI123", cardholderName: "M GRAY" } });
  assert.ok(h.notes.some((n) => /amounts don't match/i.test(n)));
});

test("matching amounts raise no mismatch note", () => {
  const r = booking({ flow: "ipsi", flowKind: "customer", total: 374.29 });
  const h = V.handoverView(r, { ipsi: { amount: 374.29, transactionRef: "IPSI123" } });
  assert.ok(!h.notes.some((n) => /amounts don't match/i.test(n)));
});

test("BR04 never asks for the customer's real card number", () => {
  const r = booking({ flow: "ipsi", flowKind: "customer" });
  const h = V.handoverView(r, { ipsi: { cardType: "Visa", cardholderName: "MEGAN GRAY", amount: 374.29 } });
  const [, card] = h.fields.find(([k]) => k.trim() === "Card Number");
  assert.ok(/Dummy Card/.test(card), "must be the dummy card");
  assert.ok(!/\d{4}\s?\d{4}/.test(card), "no real card number anywhere near this");
});

test("BR05 the cardholder is the payer, not the dummy card's default", () => {
  const r = booking({ flow: "ipsi", flowKind: "customer" });
  const h = V.handoverView(r, { ipsi: { cardholderName: "JOHN SMITH", amount: 1 } });
  const [, holder] = h.fields.find(([k]) => k.trim() === "Card Holder");
  assert.strictEqual(holder, "JOHN SMITH");
});

console.log("\nsummary card");

test("a supplier flow shows the supplier; IPSI shows the debtor instead", () => {
  const s = V.summaryView(booking());
  assert.ok(s.rows.some(([k, v]) => k === "Supplier" && v === "Room-Res"));

  const i = V.summaryView(booking({ flow: "ipsi", flowKind: "customer", supplier: null }));
  assert.ok(i.rows.some(([k]) => k === "Debtor"));
  assert.ok(!i.rows.some(([k]) => k === "Supplier"));
});

test("the money column is labelled with whatever Tramada called it", () => {
  const s = V.summaryView(booking({ flow: "dvc", amountHeader: "Creditor Due" }));
  assert.ok(s.segmentColumns.some((c) => c.label === "Creditor Due"));
  assert.ok(s.segmentColumns.some((c) => c.label === "Seg. type"), "DVC needs Seg. Type");
});

test("DVC's Creditor Due / Creditor Payable disagreement is surfaced, not hidden", () => {
  const s = V.summaryView(
    booking({ flow: "dvc", amountColumnConflict: { due: 380, payable: 374.29 } })
  );
  assert.ok(s.notes.some((n) => /Step 16 of the DVC guide says pay from <b>Creditor Due<\/b>/.test(n)));
});

test("IPSI's pinned Receipt Overview fields show on the card", () => {
  const s = V.summaryView(
    booking({
      flow: "ipsi",
      flowKind: "customer",
      transactionType: "Credit Card Swipe",
      presets: { bankAccount: { text: "[TRUST] Trust Account" }, receivedFrom: { text: "RAA of SA Limited (Retail)" } },
    })
  );
  assert.ok(s.rows.some(([k, v]) => k === "Bank account" && /Trust/.test(v)));
  assert.ok(s.rows.some(([k, v]) => k === "Received from" && /RAA of SA/.test(v)));
});

test("a preset Tramada would not accept is called out", () => {
  const s = V.summaryView(
    booking({ flow: "ipsi", flowKind: "customer", presets: { bankAccount: null, receivedFrom: null } })
  );
  assert.ok(s.notes.some((n) => /Could not set <b>Bank account<\/b>/.test(n)));
});

console.log(
  `\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed\n`
);
process.exit(failures.length ? 1 : 0);
