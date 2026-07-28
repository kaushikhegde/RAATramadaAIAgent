/**
 * room-res-tramada.js — pushes a finished Room-Res quote into Tramada.
 *
 * This is the join between the two halves of the job. room-res-quote.js creates
 * the draft itinerary and the customer quote on room-res.com; this module turns
 * that pair into a Tramada hotel segment, on either a brand-new booking or one
 * the user already has, and optionally receipts it.
 *
 * The agreed rules it enforces (the nine answers, in code):
 *   • Creditor is the REAL HOTEL, never a blanket "Room-Res" creditor. We try
 *     the remembered alias first (creditor-aliases.js); a miss falls through to
 *     the EXISTING stop-and-ask flow rather than a guess, and the user's answer
 *     is remembered so the same hotel runs straight through next time.
 *   • The confirmation field carries BOTH references — "Q422380 / AQ788851".
 *   • The receipt is asked for every time: it only runs when `receipt` is
 *     passed, and even then it defaults to a dry run so the user confirms
 *     before anything is committed.
 *   • Guest names come from the Tramada client when there is one; otherwise the
 *     caller (chat) has already asked for them.
 *
 * Nothing here decides a price. The sell price arrives from the chat, because
 * the margin is a human call on every quote.
 */

const { quoteToTramadaHotelSegment, tramadaClientToGuest } = require("./room-res-quote");
const { resolveCreditor, rememberCreditor } = require("./creditor-aliases");
const {
  runFullBooking,
  runAddSegments,
  runAddPassenger,
  runSearchClients,
  runReadBookingClient,
} = require("./tramada-segments");

/* ── Booking-header helpers ─────────────────────────────────────────────── */

// Tramada's #destinationCityCode wants a city code. This covers the cities that
// actually come up; anything else is left BLANK rather than guessed — a blank
// optional field is harmless, a wrong destination code is a reporting error that
// nobody notices for months.
const CITY_CODES = {
  sydney: "SYD", melbourne: "MEL", brisbane: "BNE", "gold coast": "OOL",
  perth: "PER", adelaide: "ADL", cairns: "CNS", hobart: "HBA", darwin: "DRW",
  canberra: "CBR", newcastle: "NTL", townsville: "TSV", launceston: "LST",
  auckland: "AKL", wellington: "WLG", christchurch: "CHC", queenstown: "ZQN",
  singapore: "SIN", "kuala lumpur": "KUL", bangkok: "BKK", bali: "DPS",
  denpasar: "DPS", tokyo: "TYO", london: "LON", "los angeles": "LAX",
};

function cityCodeFor(city) {
  return CITY_CODES[String(city || "").trim().toLowerCase()] || "";
}

/**
 * Is this stay in Australia? Room-Res puts the country code at the end of the
 * address ("5 York Street, Sydney, AU"), which is the site's own data rather
 * than an inference, so that's what we read. Falls back to the city table.
 */
function isDomesticStay(draft) {
  const addr = String(draft.address || "").trim();
  const m = addr.match(/,\s*([A-Z]{2})\s*$/);
  if (m) return m[1] === "AU";
  const code = cityCodeFor(draft.city);
  return !!code && ["SYD", "MEL", "BNE", "OOL", "PER", "ADL", "CNS", "HBA", "DRW", "CBR", "NTL", "TSV", "LST"].includes(code);
}

/**
 * Build the Add-Booking header for a hotel-only booking.
 *
 * Returns `{ booking, missing }`. `missing` is non-empty when a field can only
 * come from the user — today that is just the region for an overseas stay,
 * because Tramada has no generic "international" option and picking the wrong
 * region misfiles the booking.
 */
function buildBookingHeader(draft, opts = {}) {
  const domestic = isDomesticStay(draft);
  const missing = [];
  let region = opts.destinationRegion || null;
  if (!domestic && !region) missing.push("destinationRegion");

  const summary = [
    draft.hotelName,
    draft.city,
    `${draft.checkIn} → ${draft.checkOut}`,
    `${draft.nights} night${draft.nights === 1 ? "" : "s"}`,
    `${draft.rooms || 1} room${(draft.rooms || 1) === 1 ? "" : "s"}, ${draft.guestCount || 1} guest${(draft.guestCount || 1) === 1 ? "" : "s"}`,
    draft.itineraryCode ? `Room-Res ${draft.itineraryCode}` : "",
  ].filter(Boolean).join(" • ").slice(0, 250);

  return {
    missing,
    booking: {
      // Consumed by mapJetstarToTramada for the fields it can derive...
      departureDate: draft.checkIn,
      returnDate: draft.checkOut,
      tripType: "return",
      adults: draft.guestCount || 1,
      children: 0,
      infants: 0,
      passengerSource: opts.passengerSource || "This Client",
      // ...and overridden for everything a hotel stay states differently.
      tramadaOverrides: {
        destination: domestic ? "DOM" : region,
        domInt: domestic ? "DOMESTIC" : "INTERNATIONAL",
        cabinClass: "",              // no cabin on a hotel-only booking
        itinerary: summary,
        primaryDest: opts.destinationCityCode || cityCodeFor(draft.city),
      },
    },
  };
}

/* ── Guests ─────────────────────────────────────────────────────────────── */

/**
 * Work out the guest names for the Room-Res book form.
 *
 * Agreed order: copy the Tramada client when the user gave us an existing
 * booking (or picked a client), otherwise use what the chat collected. Returns
 * `{ guests, source, missing }` — `missing` counts the slots still unnamed, so
 * the chat can ask for exactly that many instead of silently padding. Room-Res
 * itself refuses a half-filled form, and a wrong guest name on a hotel booking
 * is a real-world problem, not a cosmetic one.
 */
function guestsForDraft({ clientName, chatGuests = [], guestCount = 1 } = {}) {
  const guests = [];
  let source = "chat";

  const fromClient = clientName ? tramadaClientToGuest(clientName) : null;
  if (fromClient && fromClient.firstName) {
    guests.push(fromClient);
    source = "tramada-client";
  }
  for (const g of chatGuests) {
    if (!g) continue;
    const norm = typeof g === "string" ? tramadaClientToGuest(g) : g;
    if (!norm || !norm.firstName) continue;
    const dupe = guests.some(
      (x) =>
        x.firstName.toLowerCase() === String(norm.firstName).toLowerCase() &&
        String(x.lastName || "").toLowerCase() === String(norm.lastName || "").toLowerCase()
    );
    if (!dupe) guests.push(norm);
  }
  return { guests: guests.slice(0, guestCount), source, missing: Math.max(0, guestCount - guests.length) };
}

/* ── Creditor ───────────────────────────────────────────────────────────── */

/**
 * Decide the creditor for this hotel: an explicit answer wins, then the
 * remembered alias, then null — and null is DELIBERATE, because it makes
 * addHotelSegment throw `needsCreditor`, which is the existing pause-and-ask the
 * server already knows how to drive. Guessing here would put a booking against
 * the wrong supplier's account.
 */
function resolveCreditorFor(hotelName, explicit) {
  if (explicit) return { creditor: String(explicit).trim(), source: "user" };
  const cached = resolveCreditor(hotelName);
  if (cached) return { creditor: cached, source: "alias-cache" };
  return { creditor: null, source: "unresolved" };
}

/* ── Plan (pure) ────────────────────────────────────────────────────────── */

/**
 * Turn a draft + quote into everything Tramada needs, WITHOUT touching a
 * browser. Split out so the chat can show the user exactly what is about to be
 * created, and so it's testable offline.
 */
function planTramadaFromQuote(draft, quote, opts = {}) {
  if (!draft || !draft.itineraryCode) throw new Error("A Room-Res draft is required.");

  const { creditor, source: creditorSource } = resolveCreditorFor(draft.hotelName, opts.creditor);
  const segment = quoteToTramadaHotelSegment(draft, quote, {
    creditor,
    rateBasis: opts.rateBasis || "sell",
    hotelSupplier: opts.hotelSupplier || draft.hotelName,
    cityCode: opts.cityCode,
    roomTypeCode: opts.roomTypeCode,
    status: opts.status,
  });

  const mode = opts.existingBookingNo ? "existing" : "new";
  const header = mode === "new" ? buildBookingHeader(draft, opts) : { booking: null, missing: [] };

  const missing = [...header.missing];
  if (mode === "new" && !opts.clientCode) missing.push("clientCode");

  return {
    mode,
    bookingNo: opts.existingBookingNo || null,
    clientCode: opts.clientCode || null,
    booking: header.booking,
    segment,
    creditorSource,
    missing,
    // What the chat should show before it commits anything.
    summary: [
      `${draft.hotelName} — ${draft.city}`,
      `${draft.checkIn} → ${draft.checkOut} (${draft.nights} night${draft.nights === 1 ? "" : "s"})`,
      `cost $${Number(segment.cost || 0).toFixed(2)} · sell $${Number(segment.sell || 0).toFixed(2)}` +
        (segment.margin != null ? ` · margin $${segment.margin.toFixed(2)}` : ""),
      `ref ${segment.confirmationNumber}`,
      mode === "existing" ? `booking ${opts.existingBookingNo}` : `new booking for ${opts.clientCode || "(client not chosen)"}`,
      creditor ? `creditor ${creditor}` : "creditor: will ask",
    ].join(" · "),
  };
}

/* ── Run ────────────────────────────────────────────────────────────────── */

/**
 * Create the Tramada side of a Room-Res quote.
 *
 * @param {object}  o
 * @param {object}  o.draft                 from runRoomResDraft
 * @param {object}  o.quote                 from runRoomResQuote
 * @param {string}  [o.existingBookingNo]   add to this booking instead of creating one
 * @param {string}  [o.clientCode]          required when creating a new booking
 * @param {string}  [o.creditor]            the user's answer to a previous needsCreditor
 * @param {string}  [o.rateBasis]           "sell" (default) | "cost"
 * @param {object}  [o.receipt]             omit = no receipt (the user is asked every time)
 * @param {boolean} [o.dryRunReceipt=true]  stage the receipt, don't commit it
 * @param {object}  [o.callbacks]           { onProgress, onStage, onError, onNeedLogin }
 */
async function runRoomResToTramada(o = {}) {
  const cb = o.callbacks || {};
  const onProgress = cb.onProgress || (() => {});
  const onStage = cb.onStage || (() => {});
  const onError = cb.onError || (() => {});

  const plan = planTramadaFromQuote(o.draft, o.quote, o);
  onStage("plan", plan);

  if (plan.missing.length) {
    // Stop before opening a browser: these can only come from the user, and a
    // half-specified booking header is rejected by Tramada anyway.
    const e = new Error(`Can't create the Tramada booking yet — still need: ${plan.missing.join(", ")}.`);
    e.needsInput = plan.missing;
    onError(e.message);
    throw e;
  }

  const auth = { username: o.username, password: o.password };
  const receiptWanted = !!(o.receipt && o.receipt.reference);

  // receiptOnly: the segment is ALREADY on the booking and we are here purely to
  // stage or issue its receipt.
  //
  // Without this the receipt step re-entered the whole "existing booking" path —
  // passenger, then runAddSegments — and put a SECOND identical hotel segment on
  // the booking. The flow calls this action twice (stage, then issue), so
  // confirming the receipt would have added a third.
  const receiptOnly = !!o.receiptOnly;
  if (receiptOnly && !receiptWanted) throw new Error("receiptOnly was set but no receipt details were supplied.");
  if (receiptOnly && plan.mode !== "existing") {
    throw new Error("receiptOnly needs the number of the booking the segment already went onto.");
  }

  try {
    let result;
    if (plan.mode === "existing") {
      const bookingNo = String(plan.bookingNo);
      let segments = [];

      if (receiptOnly) {
        onProgress(10, `Booking ${bookingNo} already has the hotel segment — going straight to the receipt...`);
      } else {
        onProgress(10, `Adding the hotel segment to booking ${bookingNo}...`);

        // A hotel segment fails with "Passenger is required." on a booking with no
        // passenger. runAddPassenger is idempotent, so this is cheap insurance
        // rather than a second thing that can go wrong.
        await runAddPassenger({
          ...auth, bookingNo,
          source: o.passengerSource || "This Client",
          callbacks: { onNeedLogin: cb.onNeedLogin, onProgress: (p, m) => onProgress(10 + Math.round(p * 0.1), m) },
        });

        segments = await runAddSegments({
          ...auth, bookingNo, segments: [plan.segment],
          callbacks: { onNeedLogin: cb.onNeedLogin, onProgress: (p, m) => onProgress(20 + Math.round(p * 0.5), m) },
        });
        onStage("segments", segments);
      }
      result = { bookingNo, segments, booking: null, receipt: null, receiptOnly };

      if (receiptWanted) {
        const { runTramadaReceipt } = require("./tramada-receipt");
        onProgress(75, o.dryRunReceipt === false ? "Issuing receipt..." : "Building receipt preview...");
        result.receipt = await runTramadaReceipt({
          ...auth, bookingNo, receipt: o.receipt,
          dryRun: o.dryRunReceipt !== false,
          callbacks: { onNeedLogin: cb.onNeedLogin, onProgress: (p, m) => onProgress(75 + Math.round(p * 0.24), m) },
        });
        onStage("receipt", result.receipt);
      }
    } else {
      onProgress(5, `Creating a new Tramada booking for ${plan.clientCode}...`);
      result = await runFullBooking({
        ...auth,
        clientCode: plan.clientCode,
        booking: plan.booking,
        segments: [plan.segment],
        receipt: receiptWanted ? o.receipt : undefined,
        dryRunReceipt: o.dryRunReceipt !== false,
        callbacks: cb,
      });
    }

    // The run got past addHotelSegment, so this creditor is a CONFIRMED good
    // match for this hotel — worth remembering only now, not when it was typed.
    // A receipt-only pass never went near addHotelSegment and proves nothing.
    if (!receiptOnly && plan.segment.creditor && plan.creditorSource === "user") {
      rememberCreditor(o.draft.hotelName, plan.segment.creditor);
      onProgress(99, `Remembered "${o.draft.hotelName}" → creditor "${plan.segment.creditor}".`);
    }

    const seg = (Array.isArray(result.segments) ? result.segments : []).find((s) => s && s.type === "HTL");
    if (seg && plan.segment.confirmationNumber && !seg.confirmationField) {
      onProgress(99, `⚠️ Segment saved, but no confirmation/reference field was found on the form — "${plan.segment.confirmationNumber}" wasn't recorded.`);
    }

    onProgress(100, `Tramada booking ${result.bookingNo} updated.`);
    return { ...result, plan, confirmationField: seg ? seg.confirmationField : null };
  } catch (err) {
    // needsCreditor / needsInput travel up untouched — the server pauses on them
    // and re-calls this function with the user's answer.
    onError(err.message);
    throw err;
  }
}

/** Surname → Tramada client matches, for the "new booking" branch (answer 8). */
async function findTramadaClients({ username, password, surname, callbacks = {} }) {
  if (!String(surname || "").trim()) throw new Error("A surname is required to search Tramada clients.");
  return await runSearchClients({ username, password, surname, callbacks });
}

/**
 * The client on an existing booking — this is what makes answer 3 ("copy the
 * guest names from the Tramada client when that client already exists") real.
 * Room-Res wants guest names before it will build the draft, so this has to
 * happen at the very start of the flow, right after the booking number.
 */
async function lookupBookingClient({ username, password, bookingNo, callbacks = {} }) {
  if (!String(bookingNo || "").trim()) throw new Error("A booking number is required.");
  return await runReadBookingClient({ username, password, bookingNo, callbacks });
}

module.exports = {
  runRoomResToTramada,
  findTramadaClients,
  lookupBookingClient,
  // pure — used by the chat to preview, and by the tests
  planTramadaFromQuote,
  buildBookingHeader,
  guestsForDraft,
  resolveCreditorFor,
  isDomesticStay,
  cityCodeFor,
};
