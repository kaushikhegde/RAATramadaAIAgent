/**
 * test-payment-flows.js — the payments tab conversation, end to end.
 *
 *   node test-payment-flows.js
 *
 * Drives a real WebSocket against a real server, with only the Tramada read
 * stubbed out. That is the seam worth stubbing and the only one: everything
 * this exercises — which flow gets chosen, which questions each one asks, what
 * the cards come back holding, and where the agent stops — is server code that
 * otherwise cannot be run without a live booking and a logged-in Chrome.
 *
 * The stub is installed in the require cache BEFORE server.js loads, because
 * server.js destructures readPaymentBooking at import time.
 */

const assert = require("assert");
const path = require("path");

/* ── Stub the Tramada read ───────────────────────────────────────── */

const BOOKINGS = {
  // Single supplier — the ordinary case.
  13061: (flow) => ({
    flow,
    flowLabel: { mint: "Mint", travelpay: "TravelPay", dvc: "Westpac DVC", ipsi: "IPSI" }[flow],
    flowKind: flow === "ipsi" ? "customer" : "supplier",
    bookingNo: "13061",
    clientName: "MEGAN GRAY",
    debtor: "RAA of SA Limited",
    consultant: "Bryan Chiam",
    agentInitials: "BC",
    level1Branch: "MIL",
    supplier: flow === "ipsi" ? null : "Room-Res",
    suppliers: flow === "ipsi" ? [] : [{ value: "1", text: "Room-Res" }],
    needsSupplierChoice: false,
    transactionType: flow === "ipsi" ? "Credit Card Swipe" : flow === "dvc" ? null : "EFT",
    presets:
      flow === "ipsi"
        ? { bankAccount: { text: "[TRUST] Trust Account" }, receivedFrom: { text: "RAA of SA Limited (Retail)" } }
        : {},
    segments: [
      {
        reference: "MG752045",
        segType: "Hotel",
        creditorPayable: "374.29",
        creditorDue: flow === "dvc" ? "374.29" : null,
        amountText: "374.29",
        amount: 374.29,
      },
    ],
    segmentsFound: true,
    amountHeader: flow === "dvc" ? "Creditor Due" : flow === "ipsi" ? "Amount Due" : "Creditor Payable",
    amountColumnConflict: null,
    total: 374.29,
  }),

  // Two creditors — must ask which one.
  13062: (flow) => ({
    ...BOOKINGS[13061](flow),
    bookingNo: "13062",
    supplier: null,
    suppliers: [
      { value: "1", text: "Room-Res" },
      { value: "2", text: "Jetstar" },
    ],
    needsSupplierChoice: true,
  }),

  // Nothing to allocate.
  13063: (flow) => ({ ...BOOKINGS[13061](flow), bookingNo: "13063", segments: [], total: 0 }),
};

let lastReadArgs = null;

const stub = {
  readPaymentBooking: async (opts) => {
    lastReadArgs = opts;
    const make = BOOKINGS[opts.bookingNo];
    if (!make) {
      const err = new Error(`Booking ${opts.bookingNo} could not be found in Tramada.`);
      err.code = "BOOKING_NOT_FOUND";
      throw err;
    }
    const result = make(opts.flow);
    // A supplier named explicitly settles the choice, as the real read does.
    if (opts.supplier) {
      result.supplier = opts.supplier;
      result.needsSupplierChoice = false;
    }
    return result;
  },
  readCreditorPayment: (o) => stub.readPaymentBooking({ ...o, flow: o.flow || "mint" }),
  toAmount: (t) => Number(String(t).replace(/[^0-9.]/g, "")) || null,
};

const stubPath = require.resolve("./tramada-payment");
require.cache[stubPath] = {
  id: stubPath,
  filename: stubPath,
  path: path.dirname(stubPath),
  loaded: true,
  exports: stub,
};

/* ── Boot the server ─────────────────────────────────────────────── */

const PORT = process.env.TEST_PORT || 4123;
process.env.PORT = String(PORT);
process.env.CDP_MODE = "external";
require("./server.js");

const WebSocket = require("ws");

/**
 * Play a script of user messages at the payments tab and collect what the
 * server sends back. Each step waits for the server to go quiet rather than
 * for a fixed count, so a flow that answers with two messages does not
 * desynchronise the rest of the script.
 */
function converse(inputs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?mode=payments`);
    const messages = [];
    let i = 0;
    let quiet = null;

    const settle = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        if (i >= inputs.length) {
          ws.close();
          resolve(messages);
          return;
        }
        ws.send(JSON.stringify({ type: "user_message", text: inputs[i++] }));
        settle();
      }, 260);
    };

    ws.on("open", settle);
    ws.on("message", (raw) => {
      const d = JSON.parse(raw.toString());
      if (d.type !== "typing") messages.push(d);
      settle();
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("conversation timed out")), 20000);
  });
}

/* ── Assertions ──────────────────────────────────────────────────── */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

const texts = (ms) => ms.filter((m) => m.type === "bot_message").map((m) => m.text);
const joined = (ms) => texts(ms).join("\n");
const one = (ms, type) => ms.find((m) => m.type === type);
const plain = (s) => String(s).replace(/<[^>]+>/g, "");

(async () => {
  console.log("\nstep 0 — the transaction type");

  await test("a fresh payments tab asks the type before anything else", async () => {
    const ms = await converse([]);
    assert.strictEqual(ms.length, 1);
    assert.match(ms[0].text, /What kind of transaction do you want me to pay\?/);
    assert.deepStrictEqual(ms[0].quickReplies, ["Westpac DVC", "Mint", "TravelPay", "IPSI"]);
  });

  await test("IPSI is introduced as a customer receipt, not a supplier payment", async () => {
    const ms = await converse(["IPSI"]);
    assert.match(joined(ms), /customer receipt/i);
    assert.match(joined(ms), /IPSI approved page/i);
  });

  console.log("\nthe read is made against the chosen flow");

  await test("each choice reaches Tramada as its own flow", async () => {
    for (const [reply, flow] of [
      ["Westpac DVC", "dvc"],
      ["Mint", "mint"],
      ["TravelPay", "travelpay"],
      ["IPSI", "ipsi"],
    ]) {
      await converse([reply, "13061"]);
      assert.strictEqual(lastReadArgs.flow, flow, `${reply} should read as ${flow}`);
    }
  });

  console.log("\nMint — unchanged");

  await test("read → confirm → the MintEFT mapping", async () => {
    const ms = await converse(["Mint", "13061", "Yes"]);
    const summary = one(ms, "payment_summary");
    assert.ok(summary, "a summary card");
    assert.match(summary.view.title, /Mint supplier payment/);

    const h = one(ms, "payment_handover");
    assert.ok(h, "a handover card");
    assert.strictEqual(h.handover.system, "MintEFT");
    const by = (l) => h.handover.fields.find(([k]) => k.trim() === l)[1];
    assert.strictEqual(by("Recipient Reference"), "MG752045");
    assert.strictEqual(by("Sender Reference"), "13061");
    assert.strictEqual(by("Passenger Name"), "GRAY");
    assert.strictEqual(by("Total Amount"), "$374.29");
    assert.match(h.handover.back, /M00XXXXXX/);
  });

  await test('"No" stops without a handover, and names the system', async () => {
    const ms = await converse(["Mint", "13061", "No"]);
    assert.ok(!one(ms, "payment_handover"), "nothing should be handed over");
    assert.match(joined(ms), /nothing went to Mint/);
  });

  await test("an unclear answer at the gate re-asks rather than proceeding", async () => {
    const ms = await converse(["Mint", "13061", "why?"]);
    assert.ok(!one(ms, "payment_handover"));
    assert.match(joined(ms), /I need a yes or a no/);
  });

  console.log("\nTravelPay");

  await test("the passenger name is LAST NAME + booking number (BR03)", async () => {
    const ms = await converse(["TravelPay", "13061", "Yes"]);
    const h = one(ms, "payment_handover").handover;
    assert.strictEqual(h.system, "TravelPay");
    assert.strictEqual(h.fields.find(([k]) => k === "Passenger Name")[1], "GRAY 13061");
    assert.strictEqual(h.fields.find(([k]) => k === "Pay")[1], "Pay Now");
    assert.match(h.back, /8-digit/);
  });

  console.log("\nWestpac DVC");

  await test("asks the validity period before anything is computed", async () => {
    const ms = await converse(["Westpac DVC", "13061"]);
    assert.ok(!one(ms, "payment_plan"), "no plan until the period is answered");
    const ask = texts(ms).find((t) => /How long should the card be valid/.test(t));
    assert.ok(ask, "should ask the validity period");
    assert.deepStrictEqual(
      ms.find((m) => /How long should the card/.test(m.text || "")).quickReplies,
      ["Standard (7 days)", "Custom check-in date"]
    );
  });

  await test("standard 7 days → a Westpac plan with the limit worked out", async () => {
    const ms = await converse(["Westpac DVC", "13061", "Standard (7 days)"]);
    const plan = one(ms, "payment_plan").plan;
    assert.match(plan.title, /Create Single Request for booking 13061/);
    const row = (l) => plan.rows.find(([k]) => k === l)[1];
    // BR04 — 374.29 + 5, rounded up.
    assert.match(row("Cumulative Limit"), /^\$380\b/);
    assert.match(row("End Date"), /standard — 7 days/);
    assert.strictEqual(row("Maximum Number of Transactions"), "0  (BR05 — always unlimited)");
    const field = (l) => plan.customFields.find((f) => f.label === l).value;
    assert.strictEqual(field("Agent Initials"), "BC");
    assert.strictEqual(field("Store Code"), "MIL");
    assert.strictEqual(field("Segment Type"), "Hotel");
  });

  await test("a custom period asks for the check-in date and uses it", async () => {
    const ms = await converse(["Westpac DVC", "13061", "Custom check-in date", "25/12/2027"]);
    assert.match(joined(ms), /check-in date/i);
    const plan = one(ms, "payment_plan").plan;
    assert.match(plan.rows.find(([k]) => k === "End Date")[1], /25\/12\/2027.*custom/);
  });

  await test("a date typed straight at the question is taken as the custom period", async () => {
    const ms = await converse(["Westpac DVC", "13061", "25/12/2027"]);
    const plan = one(ms, "payment_plan").plan;
    assert.match(plan.rows.find(([k]) => k === "End Date")[1], /25\/12\/2027/);
  });

  await test("an unreadable check-in date re-asks instead of guessing", async () => {
    const ms = await converse(["Westpac DVC", "13061", "Custom check-in date", "sometime in May"]);
    assert.ok(!one(ms, "payment_plan"));
    assert.match(joined(ms), /couldn't read that as a date/i);
  });

  await test("confirming the plan gives the Westpac → Tramada hand-off", async () => {
    const ms = await converse(["Westpac DVC", "13061", "Standard (7 days)", "Yes"]);
    const h = one(ms, "payment_handover").handover;
    assert.strictEqual(h.system, "Westpac Commercial Cards");
    const by = (l) => h.fields.find(([k]) => k.trim() === l)[1];
    assert.strictEqual(by("Credit Card"), "Westpac DVC");
    assert.strictEqual(by("Authorisation Number"), "XX6780");
    assert.strictEqual(by("Reference"), "RRC - MG752045"); // BR11
    assert.match(by("1. Submit in Westpac"), /you click Submit/); // BR07
    assert.ok(h.notes.some((n) => /Cross-check the amount owed/i.test(n))); // BR02
  });

  console.log("\nIPSI");

  await test("asks the four approved-page values, one at a time", async () => {
    const ms = await converse(["IPSI", "13061"]);
    assert.match(joined(ms), /IPSI transaction reference number/);
    assert.ok(!one(ms, "payment_handover"));
    // The read still happened first, so the consultant can see the booking.
    assert.ok(one(ms, "payment_summary"), "the booking is read before the questions");
  });

  await test("the summary shows the pinned Receipt Overview fields (BR03)", async () => {
    const ms = await converse(["IPSI", "13061"]);
    const rows = one(ms, "payment_summary").view.rows;
    const by = (l) => (rows.find(([k]) => k === l) || [])[1];
    assert.strictEqual(by("Transaction type"), "Credit Card Swipe");
    assert.strictEqual(by("Bank account"), "[TRUST] Trust Account");
    assert.strictEqual(by("Received from"), "RAA of SA Limited (Retail)");
    assert.ok(!rows.some(([k]) => k === "Supplier"), "a customer receipt has no supplier");
  });

  await test("all four answers → the Tramada receipt mapping, on the dummy card", async () => {
    const ms = await converse([
      "IPSI", "13061", "IPSI-88213311", "MEGAN GRAY", "374.29", "Visa", "Yes",
    ]);
    const h = one(ms, "payment_handover").handover;
    const by = (l) => h.fields.find(([k]) => k.trim() === l)[1];
    assert.strictEqual(by("Reference"), "IPSI-88213311");
    assert.strictEqual(by("Card Holder"), "MEGAN GRAY"); // BR05
    assert.strictEqual(by("Card Type"), "Visa");
    assert.match(by("Card Number"), /RAA Dummy Card for Visa/); // BR04
    assert.strictEqual(by("Amount Received"), "$374.29");
    assert.match(h.stop, /never process the card charge in IPSI/); // BR07
  });

  await test("an amount that disagrees with Tramada is flagged both times (BR06)", async () => {
    const ms = await converse([
      "IPSI", "13061", "IPSI-88213311", "MEGAN GRAY", "400", "Visa", "Yes",
    ]);
    assert.match(joined(ms), /doesn't match Tramada/i);
    const h = one(ms, "payment_handover").handover;
    assert.ok(h.notes.some((n) => /amounts don't match/i.test(n)));
  });

  await test("a card type it does not know re-asks rather than inventing one", async () => {
    const ms = await converse(["IPSI", "13061", "REF1", "MEGAN GRAY", "374.29", "gift card"]);
    assert.match(joined(ms), /Visa.*Mastercard.*Amex/s);
    assert.ok(!one(ms, "payment_handover"));
  });

  await test("a non-numeric amount re-asks", async () => {
    const ms = await converse(["IPSI", "13061", "REF1", "MEGAN GRAY", "lots"]);
    assert.match(joined(ms), /as a number/);
  });

  console.log("\nshared behaviour");

  await test("a multi-creditor booking asks which supplier, and DVC cites BR08", async () => {
    const mint = await converse(["Mint", "13062"]);
    assert.match(joined(mint), /2 creditors/);
    assert.ok(!/BR08/.test(joined(mint)));

    const dvc = await converse(["Westpac DVC", "13062"]);
    assert.match(joined(dvc), /its own card \(BR08\)/);
  });

  await test("picking a supplier by number carries on with that one", async () => {
    const ms = await converse(["Mint", "13062", "2", "Yes"]);
    const h = one(ms, "payment_handover").handover;
    assert.strictEqual(h.fields.find(([k]) => k === "Payee Name or Number")[1], "Jetstar");
  });

  await test("an empty allocation table stops, in the flow's own words", async () => {
    const supplier = await converse(["Mint", "13063"]);
    assert.match(joined(supplier), /no creditor payable here/);
    const customer = await converse(["IPSI", "13063"]);
    assert.match(joined(customer), /no outstanding amount here/);
  });

  await test("a booking that isn't there reads as an answer, not a crash", async () => {
    const ms = await converse(["Mint", "99999"]);
    assert.ok(!ms.some((m) => m.type === "error"));
    assert.match(joined(ms), /could not be found in Tramada/);
  });

  await test("reset returns to the type question mid-flow", async () => {
    const ms = await converse(["Westpac DVC", "13061", "reset"]);
    assert.match(plain(texts(ms).pop()), /What kind of transaction do you want me to pay\?/);
  });

  await test("switching type mid-booking re-asks for the number", async () => {
    const ms = await converse(["Mint", "TravelPay"]);
    assert.match(joined(ms), /Switched to <b>TravelPay<\/b>/);
  });

  await test("a booking number sent before the type is picked up afterwards", async () => {
    const ms = await converse(["13061", "Mint"]);
    assert.match(joined(ms), /Got booking <b>13061<\/b>/);
    assert.ok(one(ms, "payment_summary"), "the held booking is read once the type lands");
  });

  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
