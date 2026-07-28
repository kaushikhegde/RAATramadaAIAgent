/**
 * roomres-chat.js — the "create a quote" conversation.
 *
 * This is the chat option the whole Room-Res feature hangs off. It is written as
 * an explicit state machine rather than left to the language model, because the
 * steps have real consequences (a draft itinerary on the live portal, a segment
 * in Tramada, a receipt) and the order they happen in was agreed deliberately:
 *
 *   booking → [LOOKUP] → track → trip → hotel → [guests] → DRAFT → price
 *           → QUOTE → target → [client] → TRAMADA → receipt?
 *
 * Two ordering points worth knowing:
 *   • The existing-booking question comes FIRST, not after the quote, and a
 *     booking number is followed immediately by a client lookup. Guest names are
 *     meant to come from the Tramada client when there is one, and Room-Res wants
 *     those names before it will create the draft — so both the booking and its
 *     client have to be known before the draft, not after. The post-quote step
 *     then just CONFIRMS where the segment goes.
 *   • The sell price is asked between the two browser phases. That's the whole
 *     reason room-res-quote.js splits draft and quote: the margin is a human
 *     decision on every single quote, so the run has to stop and wait.
 *
 * Everything here is pure — it takes the current state plus what the user typed
 * and returns messages, the next state, and optionally the name of a browser
 * action for the caller to run. The caller (server.js) owns the browser and
 * feeds results back via `resume()`. That split is what makes the conversation
 * testable without Chrome.
 */

const { describeDraft } = require("./room-res-quote");
const { guestsForDraft, planTramadaFromQuote } = require("./room-res-tramada");

/* ── little parsers ─────────────────────────────────────────────────────── */

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// What counts as "start the quote flow" when typed into the chat. Lives here
// rather than in server.js so the phrasing is covered by the offline tests —
// it's the only door into the flow for anyone not using the button.
const START = /\b(create|make|new|start|build)\b.{0,20}\b(quote|hotel quote|room ?-?res)\b|\broom ?-?res\b.{0,20}\bquote\b/i;

const YES = /^\s*(y|yes|yep|yeah|ok|okay|sure|go|do it|please|confirm|correct|right)\b/i;
const NO = /^\s*(n|no|nope|nah|skip|not now|later|don'?t)\b/i;
const CANCEL = /^\s*(cancel|stop|quit|abort|exit|nvm|never ?mind)\b/i;

function isYes(t) { return YES.test(String(t || "")); }
function isNo(t) { return NO.test(String(t || "")); }
function isCancel(t) { return CANCEL.test(String(t || "")); }
function isStart(t) { return START.test(String(t || "")); }

/** Any date shape a person is likely to type → ISO. Returns "" when unsure. */
function parseOneDate(raw, fallbackYear) {
  const s = String(raw || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  // 1 Aug 2026 / 1-Aug-26 / 1 August
  m = s.match(/^(\d{1,2})[\s\-/]*([A-Za-z]{3,})[\s\-/]*(\d{2,4})?$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mon) return "";
    let y = m[3] || String(fallbackYear || new Date().getFullYear());
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mon}-${m[1].padStart(2, "0")}`;
  }
  // Aug 1 2026
  m = s.match(/^([A-Za-z]{3,})[\s\-/]*(\d{1,2})[\s,\-/]*(\d{2,4})?$/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (!mon) return "";
    let y = m[3] || String(fallbackYear || new Date().getFullYear());
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mon}-${m[2].padStart(2, "0")}`;
  }
  // 01/08/2026 — day first, matching how dates are written here
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return "";
}

/**
 * Pull destination, dates and party size out of one free-text line, e.g.
 * "Sydney 1 Aug 2026 to 3 Aug 2026, 2 adults 1 child".
 * Returns what it found plus `missing`, so the chat asks for the gap rather than
 * inventing a default for something as consequential as a travel date.
 */
function parseTripText(text) {
  const raw = String(text || "").trim();
  const out = { destination: "", dateFrom: "", dateTo: "", adults: 0, children: 0, rooms: 1, missing: [] };

  const adultsM = raw.match(/(\d+)\s*(?:adults?|pax|guests?|people)/i);
  if (adultsM) out.adults = parseInt(adultsM[1], 10);
  const childM = raw.match(/(\d+)\s*(?:child|children|kids?)/i);
  if (childM) out.children = parseInt(childM[1], 10);
  const roomsM = raw.match(/(\d+)\s*rooms?/i);
  if (roomsM) out.rooms = parseInt(roomsM[1], 10);

  // Strip the party-size phrases so they can't be mistaken for dates. Longest
  // alternative first — "child" before "children" leaves a stray "ren" behind.
  let rest = raw
    .replace(/(\d+)\s*(?:adults?|pax|guests?|people|children|child|kids?|kid|rooms?)/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const DATE = "(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[\\s\\-/]*[A-Za-z]{3,}[\\s\\-/]*\\d{0,4}|[A-Za-z]{3,}[\\s\\-/]*\\d{1,2}[\\s,\\-/]*\\d{0,4}|\\d{1,2}/\\d{1,2}/\\d{2,4})";
  const rangeRe = new RegExp(`${DATE}\\s*(?:to|-|–|—|until|till|through|→)\\s*${DATE}`, "i");
  const rm = rest.match(rangeRe);
  if (rm) {
    out.dateFrom = parseOneDate(rm[1]);
    // A year written only once ("1 Aug to 3 Aug 2026") belongs to both dates.
    const yr = (out.dateFrom || "").slice(0, 4) || undefined;
    out.dateTo = parseOneDate(rm[2], yr);
    if (out.dateFrom && !/\d{4}/.test(rm[1])) {
      const y2 = (out.dateTo || "").slice(0, 4);
      if (y2) out.dateFrom = parseOneDate(rm[1], y2);
    }
    rest = rest.replace(rm[0], " ").replace(/\s{2,}/g, " ").trim();
  }

  out.destination = rest.replace(/^[\s,;:-]+|[\s,;:-]+$/g, "").replace(/\b(in|at|for|from|hotel|hotels)\b/gi, " ").replace(/\s{2,}/g, " ").trim();

  if (!out.destination) out.missing.push("destination");
  if (!out.dateFrom || !out.dateTo) out.missing.push("dates");
  if (!out.adults) out.adults = 0; // asked separately rather than assumed
  if (!out.adults) out.missing.push("guests");
  return out;
}

function parseMoney(text) {
  const m = String(text || "").replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * The payment method, when the agent names one. Tramada's own resolveTxnType
 * accepts these spellings, so this only has to recognise them.
 *
 * Longest first — "credit card swipe" has to win over "credit card". "cc" is
 * deliberately NOT an alias: references like `CC-1234` are real, and mistaking
 * one for a payment type would file the reference as the method and lose it.
 */
const PAY_TYPES = [
  [/\bcredit\s*card\s*swipe\b|\bswipe\b/i, "Credit Card Swipe"],
  [/\bcredit\s*card\b|\bcard\b|\bvisa\b|\bmastercard\b|\bamex\b/i, "Credit Card"],
  [/\bcheque\b|\bcheck\b/i, "Cheque"],
  [/\bcash\b/i, "Cash"],
  [/\beft\b|\bbank\s*transfer\b|\btransfer\b|\bdirect\s*deposit\b/i, "EFT"],
];

function parsePayType(text) {
  const s = String(text || "");
  for (const [re, name] of PAY_TYPES) if (re.test(s)) return name;
  return null;
}

/** Split "John Smith, Jane Smith" / "John Smith and Jane Smith" into names. */
function parseNames(text) {
  return String(text || "")
    .split(/[,;]|\s+(?:and|&|\+)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s && /[A-Za-z]/.test(s) && s.split(/\s+/).length >= 2);
}

/* ── the conversation ───────────────────────────────────────────────────── */

const PROMPTS = {
  booking:
    "Let's build a Room-Res quote.\n\n" +
    "**1 of 5 — booking.** If this is going onto an existing Tramada booking, give me the booking number now " +
    "(I'll take the guest names off that client). If it's a brand-new booking, say **new**.",
  track:
    "**2 of 5 — rates.** Which rates? Reply **net** for RAA Net Rates (our cost) or **online** for Online Prices.",
  trip:
    "**3 of 5 — the stay.** Destination, dates and party size in one line — e.g.\n" +
    "`Sydney 1 Aug 2026 to 3 Aug 2026, 2 adults`",
  hotel:
    "**4 of 5 — hotel.** Name the hotel if you know which one, or say **cheapest** and I'll take the lowest-priced option.",
};

function startQuoteFlow() {
  return {
    state: { step: "booking", data: { rooms: 1, children: 0 } },
    messages: [PROMPTS.booking],
  };
}

function cancelled() {
  return { state: null, messages: ["Cancelled — nothing was created."], run: null };
}

/**
 * Advance the conversation one user message.
 * @returns {{state: object|null, messages: string[], run: string|null, payload?: object}}
 *   `run` names a browser action for the caller: "draft" | "quote" | "clients" |
 *   "tramada" | "receipt". The caller runs it and calls resume() with the result.
 */
function advance(state, text) {
  const t = String(text || "").trim();
  if (isCancel(t)) return cancelled();
  const d = state.data;

  switch (state.step) {
    /* 1 — existing booking or new */
    case "booking": {
      if (/^new\b/i.test(t)) {
        d.existingBookingNo = null;
      } else {
        const m = t.match(/(\d{4,6})/);
        if (!m) {
          return { state, messages: ["I need a booking number (4–6 digits), or **new** for a brand-new booking."], run: null };
        }
        d.existingBookingNo = m[1];
        // Answer 3: guest names come from the Tramada client when there is one.
        // Room-Res wants those names before it will build the draft, so the
        // lookup has to happen here — at the top — not after the quote.
        return {
          state: { ...state, step: "lookup", data: d },
          messages: [`Looking up booking ${d.existingBookingNo} in Tramada…`],
          run: "bookingClient",
        };
      }
      return { state: { ...state, step: "track", data: d }, messages: [PROMPTS.track], run: null };
    }

    /* 2 — rate track */
    case "track": {
      if (/^net\b|raa|cost/i.test(t)) d.rateTrack = "net";
      else if (/^online\b|retail|public/i.test(t)) d.rateTrack = "online";
      else return { state, messages: ["Reply **net** (RAA Net Rates) or **online** (Online Prices)."], run: null };
      return { state: { ...state, step: "trip", data: d }, messages: [PROMPTS.trip], run: null };
    }

    /* 3 — destination / dates / party */
    case "trip": {
      const trip = parseTripText(t);
      if (trip.missing.length) {
        return {
          state,
          messages: [
            `I couldn't pick out the ${trip.missing.join(" and ")}. Give it to me like ` +
              "`Sydney 1 Aug 2026 to 3 Aug 2026, 2 adults`.",
          ],
          run: null,
        };
      }
      if (trip.dateTo <= trip.dateFrom) {
        return { state, messages: ["The check-out date needs to be after the check-in date — try again?"], run: null };
      }
      Object.assign(d, {
        destination: trip.destination,
        dateFrom: trip.dateFrom,
        dateTo: trip.dateTo,
        adults: trip.adults,
        children: trip.children,
        rooms: trip.rooms,
      });
      return { state: { ...state, step: "hotel", data: d }, messages: [PROMPTS.hotel], run: null };
    }

    /* 4 — hotel choice */
    case "hotel": {
      d.hotelName = /^(cheapest|any|whatever|lowest|you (pick|choose))\b/i.test(t) ? null : t;

      // Guests: from the Tramada client when we have a booking, else ask.
      const need = (d.adults || 1) + (d.children || 0);
      const g = guestsForDraft({ clientName: d.clientName, chatGuests: d.chatGuests || [], guestCount: need });
      d.guests = g.guests;
      if (g.missing > 0) {
        return {
          state: { ...state, step: "guests", data: d },
          messages: [
            `**5 of 5 — guests.** I need ${g.missing} more guest name${g.missing === 1 ? "" : "s"} ` +
              `(${need} total for this room). Full names, comma-separated.`,
          ],
          run: null,
        };
      }
      return {
        state: { ...state, step: "draft", data: d },
        messages: [`Searching Room-Res for ${d.destination}, ${d.dateFrom} → ${d.dateTo}…`],
        run: "draft",
      };
    }

    /* 5 — guest names */
    case "guests": {
      const need = (d.adults || 1) + (d.children || 0);
      const names = parseNames(t);
      if (!names.length) {
        return { state, messages: ["I need full names (first and last), comma-separated — e.g. `Megan Gray, Sam Gray`."], run: null };
      }
      d.chatGuests = [...(d.chatGuests || []), ...names];
      const g = guestsForDraft({ clientName: d.clientName, chatGuests: d.chatGuests, guestCount: need });
      d.guests = g.guests;
      if (g.missing > 0) {
        return { state, messages: [`Still ${g.missing} short — ${need} names in total, please.`], run: null };
      }
      return {
        state: { ...state, step: "draft", data: d },
        messages: [`Searching Room-Res for ${d.destination}, ${d.dateFrom} → ${d.dateTo}…`],
        run: "draft",
      };
    }

    /* 6 — the sell price (the human decision this whole split exists for) */
    case "price": {
      const price = parseMoney(t);
      if (price == null || price <= 0) {
        return { state, messages: ["Give me the price the client pays, as a number — e.g. `780` or `780.00`."], run: null };
      }
      if (d.netCost != null && price < d.netCost) {
        // Selling under cost is legitimate occasionally, but never by accident.
        if (!d.underCostConfirmed) {
          d.underCostConfirmed = true;
          return {
            state,
            messages: [
              `That's **below** our cost of $${Number(d.netCost).toFixed(2)} — a loss of ` +
                `$${(d.netCost - price).toFixed(2)}. Send the same number again to go ahead, or a different one.`,
            ],
            run: null,
          };
        }
      }
      d.quotedPrice = price;
      const margin = d.netCost != null ? price - d.netCost : null;
      return {
        state: { ...state, step: "quote", data: d },
        messages: [
          `Quoting $${price.toFixed(2)}` +
            (margin != null ? ` (margin $${margin.toFixed(2)})` : "") +
            " — generating the customer quote page…",
        ],
        run: "quote",
      };
    }

    /* 7 — where the segment goes */
    case "target": {
      if (isNo(t)) {
        return {
          state: { ...state, step: "done", data: d },
          messages: [`Left it there. Quote ${d.quoteNumber || ""} is on Room-Res; nothing was written to Tramada.`],
          run: null,
        };
      }
      if (!isYes(t)) {
        const m = t.match(/(\d{4,6})/);
        if (m) d.existingBookingNo = m[1];
        else if (/^new\b/i.test(t)) d.existingBookingNo = null;
        else return { state, messages: ["Reply **yes** to go ahead, a booking number to use a different booking, **new** for a new one, or **no** to stop here."], run: null };
      }
      if (d.existingBookingNo) {
        return {
          state: { ...state, step: "tramada", data: d },
          messages: [`Adding the hotel segment to booking ${d.existingBookingNo}…`],
          run: "tramada",
        };
      }
      return {
        state: { ...state, step: "client", data: d },
        messages: ["New booking then — what's the client's surname? I'll show you what Tramada has."],
        run: null,
      };
    }

    /* 8 — pick the Tramada client */
    case "client": {
      // Choosing from the list we last showed.
      if (d.clientMatches && d.clientMatches.length) {
        const n = parseInt(t, 10);
        if (n >= 1 && n <= d.clientMatches.length) {
          d.clientCode = d.clientMatches[n - 1].clientCode;
          d.clientName = d.clientMatches[n - 1].label;
          d.clientMatches = null;
          return {
            state: { ...state, step: "tramada", data: d },
            messages: [`Creating a new booking for ${d.clientCode}…`],
            run: "tramada",
          };
        }
        const exact = d.clientMatches.find((c) => c.clientCode.toUpperCase() === t.toUpperCase());
        if (exact) {
          d.clientCode = exact.clientCode;
          d.clientName = exact.label;
          d.clientMatches = null;
          return { state: { ...state, step: "tramada", data: d }, messages: [`Creating a new booking for ${d.clientCode}…`], run: "tramada" };
        }
      }
      d.surname = t;
      return { state: { ...state, step: "client", data: d }, messages: [`Searching Tramada clients for "${t}"…`], run: "clients" };
    }

    /* 9 — receipt (asked every time, by agreement) */
    case "receipt": {
      if (isNo(t)) {
        return { state: { ...state, step: "done", data: d }, messages: ["No receipt then — all done. ✅"], run: null };
      }
      if (isYes(t)) {
        return {
          state: { ...state, step: "receiptDetails", data: d },
          messages: [
            `Receipt details, please: amount, reference and how it was paid — e.g. ` +
              `\`${Number(d.quotedPrice || 0).toFixed(2)} REF12345 Cash\`. ` +
              "(Cash, EFT, Cheque or Credit Card — I'll assume EFT if you don't say.) " +
              "I'll stage it for you to check before anything is issued.",
          ],
          run: null,
        };
      }
      return { state, messages: ["Create a receipt for this booking — **yes** or **no**?"], run: null };
    }

    case "receiptDetails": {
      // The payment method is pulled out FIRST and removed from the words the
      // reference is chosen from. The reference is "the first word with a letter
      // in it", so "Cash 110 REF123" would otherwise file "Cash" as the
      // reference and lose it — and the method was hard-coded to EFT regardless
      // of what was typed, so "110.00, JHJ-12806, Cash" staged an EFT receipt.
      const payType = parsePayType(t);
      // Split on commas as well as spaces: "110.00, JHJ-12806, Cash" is how a
      // person actually writes this.
      const parts = t.split(/[\s,]+/).filter(Boolean).filter((p) => !parsePayType(p));
      const amount = parseMoney(parts.find((p) => /^\$?\d[\d.,]*$/.test(p)) || "");
      // Digits are NOT stripped — a reference is very often mostly digits
      // ("RR788851"), so stripping them mangles it.
      const ref = (parts.find((p) => /[A-Za-z]/.test(p)) || "").replace(/[^\w-]/g, "");
      if (amount == null || !ref) {
        return { state, messages: ["I need both an amount and a reference — e.g. `780.00 RR788851`."], run: null };
      }
      const transactionType = payType || "EFT";
      d.receipt = { transactionType, amount, reference: ref, allocation: "ALL" };
      d.dryRunReceipt = true;
      return {
        state: { ...state, step: "receiptConfirm", data: d },
        messages: [
          `Staging a ${transactionType} receipt of $${amount.toFixed(2)} (ref ${ref})` +
            (payType ? "" : " — defaulted to EFT, say the method if it's something else") +
            " — not issuing it yet…",
        ],
        run: "receipt",
      };
    }

    case "receiptConfirm": {
      if (isYes(t)) {
        d.dryRunReceipt = false;
        return { state: { ...state, step: "receiptIssue", data: d }, messages: ["Issuing the receipt…"], run: "receipt" };
      }
      return { state: { ...state, step: "done", data: d }, messages: ["Left the receipt unissued. The booking and segment are in. ✅"], run: null };
    }

    /* Waiting on a browser action — a stray message shouldn't derail it. */
    case "lookup":
    case "draft":
    case "quote":
    case "tramada":
    case "receiptIssue":
      return { state, messages: ["Still working on that one — give me a moment."], run: null };

    default:
      return { state: null, messages: ["That flow has finished. Say **create quote** to start another."], run: null };
  }
}

/**
 * Feed a completed browser action back in.
 * @param {string} action  the `run` value that was executed
 * @param {object} result  what it returned (or `{ error }`)
 */
function resume(state, action, result) {
  const d = state.data;

  // A failed client lookup is a nuisance, not a dead end — the flow simply asks
  // for the guest names later, which is exactly what it does for a new booking.
  if (action === "bookingClient" && result && result.error) {
    return {
      state: { ...state, step: "track", data: d },
      messages: [
        `I couldn't read the client off booking ${d.existingBookingNo} (${result.error}) — ` +
          "I'll ask you for the guest names instead.",
        PROMPTS.track,
      ],
      run: null,
    };
  }

  // A failed action has to land the conversation back on the step that can RETRY
  // it. Leaving it on the step it failed at bricked the flow: "quote", "tramada"
  // and friends are the waiting-on-the-browser steps, and advance() answers those
  // with "Still working on that one" forever — so after one quote failure every
  // further message got that reply and the run could never be resumed or retried.
  const RETRY_STEP = {
    draft: "hotel",
    quote: "price",
    tramada: "target",
    clients: "client",
    receipt: "receiptDetails",
  };
  const RETRY_HINT = {
    draft: "Tell me what to change, or say **cancel** to stop.",
    quote: "Send the price again to retry the quote — the draft itinerary is still there — or say **cancel** to stop.",
    tramada: "Reply **yes** to try Tramada again, a different booking number, or **no** to stop here.",
    clients: "Try another surname, or say **cancel** to stop.",
    receipt: "Send the amount and reference again to retry, or say **cancel** to stop.",
  };
  if (result && result.error) {
    return {
      state: { ...state, step: RETRY_STEP[action] || state.step, data: d },
      messages: [
        `That didn't work: ${result.error}`,
        RETRY_HINT[action] || "Tell me what to change, or say **cancel** to stop.",
      ],
      run: null,
    };
  }

  switch (action) {
    case "bookingClient": {
      d.clientCode = result.clientCode || d.clientCode || null;
      d.clientName = result.clientName || null;
      // The traveller's own mobile — some Room-Res providers require a guest
      // contact number on the booking form (roomres-field-map.md §6c).
      d.contactPhone = result.contactPhone || null;
      return {
        state: { ...state, step: "track", data: d },
        messages: [
          d.clientName
            ? `Booking ${d.existingBookingNo} is for **${d.clientName}** — I'll use that as the lead guest.`
            : `Booking ${d.existingBookingNo} found, but it has no client name on it — I'll ask you for the guests.`,
          PROMPTS.track,
        ],
        run: null,
      };
    }

    case "draft": {
      d.draft = result;
      d.netCost = result.netCost;
      d.itineraryId = result.itineraryId;
      d.itineraryCode = result.itineraryCode;
      const alts = (result.selection && result.selection.alternatives) || [];
      const msgs = [
        `Draft itinerary created.\n\n${describeDraft(result)}`,
        `**Our cost is $${Number(result.netCost).toFixed(2)}.** What should I quote the client? (Reply with the number.)`,
      ];
      // chooseHotel returns alternatives as plain NAME STRINGS, not cards —
      // mapping .hotelName over them produced "Other options were: .".
      const altNames = alts.map((a) => (typeof a === "string" ? a : a && a.hotelName)).filter(Boolean);
      if (altNames.length) msgs.splice(1, 0, `Other options were: ${altNames.slice(0, 4).join(", ")}.`);
      return { state: { ...state, step: "price", data: d }, messages: msgs, run: null };
    }

    case "quote": {
      d.quote = result;
      d.quoteNumber = result.quoteNumber;
      const where = d.existingBookingNo
        ? `booking ${d.existingBookingNo}`
        : "a new booking";
      return {
        state: { ...state, step: "target", data: d },
        messages: [
          `Quote ${result.quoteNumber || "(number pending)"} is live` +
            (result.publicUrl ? `: ${result.publicUrl}` : "") + ".",
          `Now the Tramada side — segment on **${where}**, reference \`${[result.quoteNumber, d.itineraryCode].filter(Boolean).join(" / ")}\`. ` +
            "Reply **yes** to go ahead, a different booking number, **new**, or **no** to stop here.",
        ],
        run: null,
      };
    }

    case "clients": {
      const matches = Array.isArray(result) ? result : [];
      if (!matches.length) {
        return {
          state: { ...state, step: "client", data: d },
          messages: [`Tramada had no client matching "${d.surname}". Try another surname, or say **cancel**.`],
          run: null,
        };
      }
      d.clientMatches = matches;
      return {
        state: { ...state, step: "client", data: d },
        messages: [
          `Tramada clients matching "${d.surname}":\n` +
            matches.map((c, i) => `${i + 1}. ${c.label}`).join("\n") +
            "\n\nReply with the number of the one you want.",
        ],
        run: null,
      };
    }

    case "tramada": {
      d.tramada = result;
      d.bookingNo = result.bookingNo;
      const warn = result.confirmationField
        ? ""
        : "\n\n⚠️ I couldn't find a confirmation/reference box on the hotel segment form, so the quote reference isn't recorded on it — worth adding by hand.";
      return {
        state: { ...state, step: "receipt", data: d },
        messages: [
          `Hotel segment added to booking ${result.bookingNo}.${warn}`,
          "Create a receipt for it — **yes** or **no**?",
        ],
        run: null,
      };
    }

    case "receipt": {
      d.receiptResult = result;
      if (state.step === "receiptIssue" || d.dryRunReceipt === false) {
        return { state: { ...state, step: "done", data: d }, messages: [`Receipt issued against booking ${d.bookingNo}. All done. ✅`], run: null };
      }
      return {
        state: { ...state, step: "receiptConfirm", data: d },
        messages: [
          `Receipt staged (not issued): $${Number(d.receipt.amount).toFixed(2)} ${d.receipt.transactionType || "EFT"}, ` +
            `ref ${d.receipt.reference}, allocated across the booking.`,
          "Issue it? **yes** / **no**.",
        ],
        run: null,
      };
    }

    default:
      return { state, messages: [], run: null };
  }
}

/** Arguments for runRoomResDraft, straight off the collected answers. */
function draftArgs(state) {
  const d = state.data;
  return {
    destination: d.destination,
    dateFrom: d.dateFrom,
    dateTo: d.dateTo,
    adults: d.adults,
    children: d.children,
    rooms: d.rooms || 1,
    rateTrack: d.rateTrack || "net",
    hotelName: d.hotelName || undefined,
    guests: d.guests || [],
    // Guest contact number for providers that demand one (§6c) — the
    // traveller's own, read off the Tramada passenger record.
    phone: d.contactPhone || undefined,
  };
}

/** Arguments for runRoomResToTramada, including the creditor when we have one. */
function tramadaArgs(state, extra = {}) {
  const d = state.data;
  return {
    draft: d.draft,
    quote: d.quote,
    existingBookingNo: d.existingBookingNo || undefined,
    clientCode: d.clientCode || undefined,
    creditor: d.creditor || undefined,
    // Answered by the user when Tramada rejects every city we could derive from
    // the Room-Res suburb — same stop-and-ask contract as the creditor.
    cityCode: d.cityCode || undefined,
    ...extra,
  };
}

/** What the chat is about to do, for a confirmation card. */
function previewPlan(state) {
  const d = state.data;
  if (!d.draft || !d.quote) return null;
  return planTramadaFromQuote(d.draft, d.quote, {
    existingBookingNo: d.existingBookingNo || undefined,
    clientCode: d.clientCode || undefined,
    creditor: d.creditor || undefined,
  });
}

module.exports = {
  startQuoteFlow,
  advance,
  resume,
  draftArgs,
  tramadaArgs,
  previewPlan,
  // parsers — exported for the offline tests
  parseTripText,
  parseOneDate,
  parseNames,
  parseMoney,
  isYes,
  isNo,
  isCancel,
  isStart,
  START,
};
