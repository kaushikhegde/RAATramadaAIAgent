/**
 * test-roomres.js — offline checks for the pure parts of room-res-quote.js.
 *
 * No browser, no network: this exercises the parsing/selection/mapping logic
 * against the live page text captured on 28-Jul-2026 (roomres-field-map.md §7,
 * §9a, §12), so a regression in the regexes shows up here rather than halfway
 * through a real run.
 *
 *   node test-roomres.js
 */

const {
  parseItineraryText,
  chooseHotel,
  chooseRate,
  buildSearchUrl,
  toRoomResDate,
  roomResDateToIso,
  nightsBetween,
  quoteToTramadaHotelSegment,
  cityCandidatesFor,
  tramadaClientToGuest,
  describeDraft,
} = require("./room-res-quote");

// Point the alias cache at a throwaway file so the test never touches the real one.
process.env.CREDITOR_ALIAS_FILE = require("path").join(require("os").tmpdir(), `creditor-aliases-test-${process.pid}.json`);
const { normKey, rememberCreditor, resolveCreditor, forgetCreditor, listAliases } = require("./creditor-aliases");

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      got:  ${g}\n      want: ${w}`); }
}
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

/* ── dates ──────────────────────────────────────────────────────────────── */
console.log("\ndates");
check("ISO → Room-Res", toRoomResDate("2026-08-01"), "01-Aug-2026");
check("Room-Res passthrough", toRoomResDate("01-Aug-2026"), "01-Aug-2026");
check("single-digit day normalised", toRoomResDate("1-aug-2026"), "01-Aug-2026");
check("Room-Res → ISO", roomResDateToIso("03-Aug-2026"), "2026-08-03");
check("nights", nightsBetween("2026-08-01", "2026-08-03"), 2);

/* ── itinerary parsing (verbatim live text, §7) ─────────────────────────── */
console.log("\nitinerary parsing");
const ITIN = `Draft Itinerary - AQ788851 for Autotest Quoteone - Not Held or Paid for
Refresh All Rates
Add Another Product
01-Aug-2026 - 03-Aug-2026
The York by Swiss-Belhotel International, Sydney
1 Room, 2 Guests
4.5/5
5 York Street , Sydney, AU
Room Details
Room 1: Studio
Guest 1: Autotest Quoteone
Guest 2: Autotest Quotetwo
Board Type: Room Only
Price Details
Saturday, August 1, 2026 $341.32
Sunday, August 2, 2026 $341.32
Total Price: $682.65AUD
This price is inclusive of 10% GST
Cancellation Policy
FREE Cancellation until 28-Jul-2026 12:00
If you cancel this booking from now until 28-Jul-2026 12:00, cancellation charge=$0.00.`;

const itin = parseItineraryText(ITIN);
check("itinerary code", itin.itineraryCode, "AQ788851");
check("customer name", itin.customerName, "Autotest Quoteone");
check("status", itin.status, "Not Held or Paid for");
check("check-in", itin.checkIn, "2026-08-01");
check("check-out", itin.checkOut, "2026-08-03");
check("nights", itin.nights, 2);
check("hotel name", itin.hotelName, "The York by Swiss-Belhotel International");
check("city", itin.city, "Sydney");
check("address", itin.address, "5 York Street, Sydney, AU");
check("rooms", itin.rooms, 1);
check("guest count", itin.guestCount, 2);
check("room type", itin.roomTypes, ["Studio"]);
check("guest names", itin.guestNames, ["Autotest Quoteone", "Autotest Quotetwo"]);
check("board type", itin.boardType, "Room Only");
check("total price", itin.totalPrice, 682.65);
check("currency", itin.currency, "AUD");
check("nightly rows", itin.nightlyRates.length, 2);
check("nightly amount", itin.nightlyRates[0].amount, 341.32);
check("cancellation deadline", itin.cancellationDeadline, "28-Jul-2026 12:00");

/* ── itinerary parsing: numeric hotel name + the new action rows (§7a) ───── */
// Verbatim live text from itinerary SG788967 (28-Jul-2026). Two things here
// broke the original parser: the hotel is called "83 OSHR" (a name that STARTS
// WITH A DIGIT, which the old skip-rule discarded), and Room-Res now renders
// "Delete this Hotel from Itinerary" and "Hotel Notes" inside the hotel block —
// so the name came back as the delete link and the address as "Hotel Notes".
console.log("\nitinerary parsing — numeric hotel name + action rows");
const ITIN2 = `Draft Itinerary - SG788967 for Spider Gray - Not Held or Paid for
Refresh All Rates
Add Another Product
Change Itinerary Code
Create Template
Create Customer Quote
The Duplicator: Create Another Itinerary Like This
Click here to see a one click customer quote - to see a you can copy the URL and send to your customer.
01-Aug-2026 - 03-Aug-2026
83 OSHR, Bondi Junction
1 Room, 1 Guests
Delete this Hotel from Itinerary
2/5
83 Old South Head Rd , Bondi Junction, AU
Hotel Notes
Room Details
Room 1: Apartment
Guest 1: Spider Gray
Board Type: Room Only
Price Details
Saturday, August 1, 2026 $1778.38
Sunday, August 2, 2026 $1778.38
Total Price: $3556.75AUD
Cancellation Policy
FREE Cancellation until 26-Jul-2026 12:00`;

const itin2 = parseItineraryText(ITIN2);
check("code (SG series)", itin2.itineraryCode, "SG788967");
check("hotel name starting with a digit", itin2.hotelName, "83 OSHR");
check("city", itin2.city, "Bondi Junction");
check("address skips Hotel Notes", itin2.address, "83 Old South Head Rd, Bondi Junction, AU");
check("guest count", itin2.guestCount, 1);
check("room type", itin2.roomTypes, ["Apartment"]);
check("total price", itin2.totalPrice, 3556.75);
ok("hotel name is not the delete link", !/delete/i.test(itin2.hotelName), `got "${itin2.hotelName}"`);

/* ── hotel selection ────────────────────────────────────────────────────── */
console.log("\nhotel selection");
const CARDS = [
  {
    hotelName: "The York by Swiss-Belhotel International",
    fromPrice: 341,
    links: [
      { href: "https://room-res.com/hotelpage/140205?type=net&provider=14", track: "net", label: "RAA Net Rates" },
      { href: "https://room-res.com/hotelpage/140205?provider=3", track: "online", label: "View Online Rates" },
    ],
  },
  {
    hotelName: "Sydney Budget Lodge",
    fromPrice: 129,
    links: [{ href: "https://room-res.com/hotelpage/999?type=net", track: "net", label: "RAA Net Rates" }],
  },
  {
    hotelName: "Harbour Grand Suites",
    fromPrice: 502,
    links: [{ href: "https://room-res.com/hotelpage/555?type=net", track: "net", label: "RAA Net Rates" }],
  },
];

const cheapest = chooseHotel(CARDS, { rateTrack: "net" });
check("no name → cheapest", cheapest.hotel.hotelName, "Sydney Budget Lodge");
ok("cheapest reason mentions price", /cheapest/.test(cheapest.reason), cheapest.reason);

const named = chooseHotel(CARDS, { hotelName: "york", rateTrack: "net" });
check("partial name matches", named.hotel.hotelName, "The York by Swiss-Belhotel International");
ok("named pick uses the net link", /type=net/.test(named.hotel.chosenLink.href), named.hotel.chosenLink.href);

const online = chooseHotel(CARDS, { hotelName: "The York", rateTrack: "online" });
ok("online track picks the online link", /provider=3/.test(online.hotel.chosenLink.href), online.hotel.chosenLink.href);

const missing = chooseHotel(CARDS, { hotelName: "Hilton Melbourne", rateTrack: "net" });
ok("unknown hotel returns no pick", missing.hotel === null, JSON.stringify(missing));
ok("unknown hotel lists alternatives", (missing.alternatives || []).length === 3, JSON.stringify(missing.alternatives));

// "Cheapest" has to compare like with like. The net and online prices on one
// card differ by hundreds of dollars, so ranking a mixed bag ranks nothing.
// These cards are ordered so that the net-cheapest and the online-cheapest are
// DIFFERENT hotels — a track-blind comparison can't get both of these right.
const TRACKED = [
  {
    hotelName: "The Pod Sydney - Hostel",
    netPrice: 55, onlinePrice: 780,
    links: [{ href: "https://room-res.com/hotelpage/1?type=net", track: "net" }, { href: "https://room-res.com/hotelpage/1?type=online", track: "online" }],
  },
  {
    hotelName: "83 OSHR",
    netPrice: 1778, onlinePrice: 2000,
    links: [{ href: "https://room-res.com/hotelpage/2?type=net", track: "net" }, { href: "https://room-res.com/hotelpage/2?type=online", track: "online" }],
  },
  {
    hotelName: "Quest Bella Vista",
    netPrice: 148, onlinePrice: 220,
    links: [{ href: "https://room-res.com/hotelpage/3?type=net", track: "net" }, { href: "https://room-res.com/hotelpage/3?type=online", track: "online" }],
  },
];
check("net track ranks on the net price", chooseHotel(TRACKED, { rateTrack: "net" }).hotel.hotelName, "The Pod Sydney - Hostel");
check("online track ranks on the online price", chooseHotel(TRACKED, { rateTrack: "online" }).hotel.hotelName, "Quest Bella Vista");
const netPick = chooseHotel(TRACKED, { rateTrack: "net" });
ok("the reason names the track and the price", /cheapest net rate .*\$55/.test(netPick.reason), netPick.reason);
ok("full coverage is reported", /priced 3 of 3/.test(netPick.reason), netPick.reason);
ok("full coverage is not flagged partial", netPick.partialPricing === false, String(netPick.partialPricing));

// The regression that put a $1,778/night apartment on a quote: only a rump of
// the results page scraped a price, so "cheapest" was computed over two cards
// out of twenty-five and looked completely normal doing it. A run that can only
// price part of the page has to SAY so.
const PARTIAL = [
  { hotelName: "The York by Swiss-Belhotel International", netPrice: null, onlinePrice: null, links: [{ href: "https://room-res.com/hotelpage/9?type=net", track: "net" }] },
  { hotelName: "83 OSHR", netPrice: 1778, onlinePrice: 2000, links: [{ href: "https://room-res.com/hotelpage/2?type=net", track: "net" }] },
];
const part = chooseHotel(PARTIAL, { rateTrack: "net" });
check("an unpriced card can't win on price", part.hotel.hotelName, "83 OSHR");
ok("partial pricing is flagged", part.partialPricing === true, String(part.partialPricing));
ok("and the coverage is stated out loud", /priced 1 of 2/.test(part.reason), part.reason);

// With nothing priced at all we fall back to the first card, and say why.
const NONE = [{ hotelName: "Somewhere", netPrice: null, onlinePrice: null, links: [{ href: "https://room-res.com/hotelpage/8?type=net", track: "net" }] }];
const none = chooseHotel(NONE, { rateTrack: "net" });
check("no prices → first result", none.hotel.hotelName, "Somewhere");
ok("no-price fallback is explicit", /no prices could be read/.test(none.reason), none.reason);

/* ── star floor ─────────────────────────────────────────────────────────── */
console.log("\nstar floor on \"cheapest\"");
const STARRED = [
  { hotelName: "The Pod Sydney - Hostel", netPrice: 55, stars: 2, links: [{ href: "https://room-res.com/hotelpage/1?type=net", track: "net" }] },
  { hotelName: "83 OSHR", netPrice: 1778, stars: 2, links: [{ href: "https://room-res.com/hotelpage/2?type=net", track: "net" }] },
  { hotelName: "Quest Bella Vista", netPrice: 148, stars: 4, links: [{ href: "https://room-res.com/hotelpage/3?type=net", track: "net" }] },
  { hotelName: "The York", netPrice: 269, stars: 4, links: [{ href: "https://room-res.com/hotelpage/4?type=net", track: "net" }] },
];
check("the 2-star hostel is skipped by default", chooseHotel(STARRED, { rateTrack: "net" }).hotel.hotelName, "Quest Bella Vista");
ok("and the skip is stated", /under 3★ skipped/.test(chooseHotel(STARRED, { rateTrack: "net" }).reason), chooseHotel(STARRED, { rateTrack: "net" }).reason);
check("minStars 0 restores the literal cheapest", chooseHotel(STARRED, { rateTrack: "net", minStars: 0 }).hotel.hotelName, "The Pod Sydney - Hostel");
// A floor nothing can meet (nothing here is 5★) is DROPPED rather than allowed
// to return no hotel — so the pick falls back to the cheapest overall.
check("an unmeetable floor falls back to cheapest", chooseHotel(STARRED, { rateTrack: "net", minStars: 5 }).hotel.hotelName, "The Pod Sydney - Hostel");
ok("dropping an unmeetable floor is stated", /floor was dropped/.test(chooseHotel(STARRED, { rateTrack: "net", minStars: 5 }).reason), chooseHotel(STARRED, { rateTrack: "net", minStars: 5 }).reason);
// A floor that IS meetable moves the pick past the cheap-but-low-rated options.
check("a meetable 4★ floor moves the pick", chooseHotel(STARRED, { rateTrack: "net", minStars: 4 }).hotel.hotelName, "Quest Bella Vista");

// If the star markup ever changes, stars parse as null — and an unknown rating
// must never exclude a hotel, or the floor silently empties the shortlist the
// same way the price scrape did.
const UNSTARRED = STARRED.map((c) => ({ ...c, stars: null }));
check("unknown stars are never excluded", chooseHotel(UNSTARRED, { rateTrack: "net" }).hotel.hotelName, "The Pod Sydney - Hostel");
const MIXED = [
  { hotelName: "Unknown Rating Inn", netPrice: 60, stars: null, links: [{ href: "https://room-res.com/hotelpage/5?type=net", track: "net" }] },
  { hotelName: "Two Star Lodge", netPrice: 70, stars: 2, links: [{ href: "https://room-res.com/hotelpage/6?type=net", track: "net" }] },
  { hotelName: "Four Star Hotel", netPrice: 90, stars: 4, links: [{ href: "https://room-res.com/hotelpage/7?type=net", track: "net" }] },
];
check("unknown beats a known-too-low on price", chooseHotel(MIXED, { rateTrack: "net" }).hotel.hotelName, "Unknown Rating Inn");

/* ── City Code candidates ───────────────────────────────────────────────── */
console.log("\nTramada City Code candidates");
// Room-Res reports the SUBURB. Leading with it left Tramada's City Code blank
// and the segment was rejected with "City Code is invalid" — the searched city
// has to come first.
const POD = {
  city: "Haymarket",
  searchedDestination: "Sydney, NSW, AU",
  address: "1 Sussex Street, Haymarket, New South Wales, AU",
};
check("searched city leads, suburb follows", cityCandidatesFor(POD), ["Sydney", "Haymarket", "New South Wales"]);
ok("the suburb is never first", cityCandidatesFor(POD)[0] !== "Haymarket", cityCandidatesFor(POD)[0]);
check(
  "an explicit override wins outright",
  cityCandidatesFor(POD, "SYD")[0],
  "SYD"
);
check(
  "the outer-suburb case still offers the real city",
  cityCandidatesFor({ city: "Bondi Junction", searchedDestination: "Sydney, NSW, AU", address: "83 Old South Head Rd, Bondi Junction, New South Wales, AU" }),
  ["Sydney", "Bondi Junction", "New South Wales"]
);
check("no duplicates when suburb and search agree", cityCandidatesFor({ city: "Sydney", searchedDestination: "Sydney", address: "1 York St, Sydney, AU" }), ["Sydney"]);
check("nothing to go on yields nothing", cityCandidatesFor({}), []);

// The segment carries the list, so addHotelSegment can try each in turn.
const podSeg = quoteToTramadaHotelSegment(
  { ...POD, itineraryCode: "SG788986", hotelName: "The Pod Sydney - Hostel", netCost: 109.9, checkIn: "01-Aug-2026", checkOut: "03-Aug-2026", nights: 2 },
  { quoteNumber: "Q422391", quotedPrice: 110 }
);
check("the segment carries the candidates", podSeg.cityCandidates, ["Sydney", "Haymarket", "New South Wales"]);

/* ── rate selection ─────────────────────────────────────────────────────── */
console.log("\nrate selection");
const ROWS = [
  { roomName: "Studio", displayPrice: 683, board: "Room Only", refundable: "Non Refundable", href: "/book/1?a" },
  { roomName: "Studio", displayPrice: 745, board: "Bed And Breakfast", refundable: "Flexible Cancellation", href: "/book/1?b" },
  { roomName: "Deluxe King", displayPrice: 899, board: "Room Only", refundable: "Flexible Cancellation", href: "/book/1?c" },
];
check("cheapest rate", chooseRate(ROWS).rate.href, "/book/1?a");
check("refundable only", chooseRate(ROWS, { refundableOnly: true }).rate.href, "/book/1?b");
check("board preference", chooseRate(ROWS, { boardPreference: "Bed And Breakfast" }).rate.href, "/book/1?b");
check("room preference", chooseRate(ROWS, { roomPreference: "Deluxe King" }).rate.href, "/book/1?c");

/* ── search URL ─────────────────────────────────────────────────────────── */
console.log("\nsearch URL");
const url = buildSearchUrl({
  destination: "Sydney, NSW, AU",
  destinationId: 7222,
  dateFrom: "2026-08-01",
  dateTo: "2026-08-03",
  adults: 2,
});
ok("has dateFrom in site format", url.includes("dateFrom=01-Aug-2026"), url);
ok("has destination id", url.includes("id=7222"), url);
ok("has adults param", url.includes("room-0-adults=2"), url);

/* ── Tramada bridge ─────────────────────────────────────────────────────── */
console.log("\nTramada bridge");
const draft = {
  ...itin,
  itineraryId: "788851",
  netCost: 682.65,
  nights: 2,
  roomType: "Studio",
  currency: "AUD",
};
const quote = { quoteNumber: "Q422380", quotedPrice: 780, publicUrl: "https://room-res.com/CustomerQuote/x?id=uuid" };
const seg = quoteToTramadaHotelSegment(draft, quote);

check("segment kind", seg.kind, "hotel");
check("confirmation number format", seg.confirmationNumber, "Q422380 / AQ788851");
check("rate defaults to sell", seg.rate, 780);
check("cost carried through", seg.cost, 682.65);
check("margin", seg.margin, 97.35);
check("creditor left unresolved", seg.creditor, null);
check("dates are ISO for toTramadaDate", [seg.checkInDate, seg.checkOutDate], ["2026-08-01", "2026-08-03"]);
check("cost basis override", quoteToTramadaHotelSegment(draft, quote, { rateBasis: "cost" }).rate, 682.65);
check("explicit creditor sticks", quoteToTramadaHotelSegment(draft, quote, { creditor: "SWISS-BELHOTEL THE YORK" }).creditor, "SWISS-BELHOTEL THE YORK");

console.log("\nclient → guest");
check("slash format", tramadaClientToGuest("GRAY/MEGAN MS"), { firstName: "Megan", lastName: "Gray", title: "Ms" });
check("plain format", tramadaClientToGuest("Autotest Quoteone"), { firstName: "Autotest", lastName: "Quoteone", title: "" });
check("empty → null", tramadaClientToGuest(""), null);

console.log("\ncreditor alias cache");
ok(
  "word order doesn't change the key",
  normKey("The York by Swiss-Belhotel International") === normKey("Swiss-Belhotel The York International"),
  `${normKey("The York by Swiss-Belhotel International")} vs ${normKey("Swiss-Belhotel The York International")}`
);
ok("unknown hotel resolves to null", resolveCreditor("The York by Swiss-Belhotel International") === null);
rememberCreditor("The York by Swiss-Belhotel International", "SWISS-BELHOTEL THE YORK");
check("remembered exactly", resolveCreditor("The York by Swiss-Belhotel International"), "SWISS-BELHOTEL THE YORK");
check("remembered with different word order", resolveCreditor("Swiss-Belhotel The York"), "SWISS-BELHOTEL THE YORK");
check("remembered from a shorter name", resolveCreditor("York Hotel"), "SWISS-BELHOTEL THE YORK");
ok("an unrelated hotel does NOT match", resolveCreditor("Harbour Grand Suites") === null, String(resolveCreditor("Harbour Grand Suites")));
check("alias list", listAliases().length, 1);
forgetCreditor("The York by Swiss-Belhotel International");
ok("forgotten", resolveCreditor("The York by Swiss-Belhotel International") === null);
try { require("fs").unlinkSync(process.env.CREDITOR_ALIAS_FILE); } catch {}

/* ── Tramada orchestration (pure parts) ─────────────────────────────────── */
console.log("\nTramada orchestration");
const {
  planTramadaFromQuote,
  buildBookingHeader,
  guestsForDraft,
  resolveCreditorFor,
  isDomesticStay,
  cityCodeFor,
} = require("./room-res-tramada");

check("AU address → domestic", isDomesticStay(draft), true);
check("overseas address → not domestic", isDomesticStay({ address: "Jl. Raya Kuta, Bali, ID", city: "Bali" }), false);
check("city code lookup", cityCodeFor("Sydney"), "SYD");
check("unknown city stays blank", cityCodeFor("Nowheresville"), "");

const hdr = buildBookingHeader(draft);
check("domestic header needs nothing", hdr.missing, []);
check("domestic codes", [hdr.booking.tramadaOverrides.destination, hdr.booking.tramadaOverrides.domInt], ["DOM", "DOMESTIC"]);
check("header dates are the stay", [hdr.booking.departureDate, hdr.booking.returnDate], ["2026-08-01", "2026-08-03"]);
check("no cabin class on a hotel booking", hdr.booking.tramadaOverrides.cabinClass, "");
ok("summary names the hotel", hdr.booking.tramadaOverrides.itinerary.includes("The York"), hdr.booking.tramadaOverrides.itinerary);
ok("summary carries the Room-Res code", hdr.booking.tramadaOverrides.itinerary.includes("AQ788851"), hdr.booking.tramadaOverrides.itinerary);
ok("summary fits Tramada's field", hdr.booking.tramadaOverrides.itinerary.length <= 250);

const intlDraft = { ...draft, address: "Jl. Raya Kuta, Bali, ID", city: "Bali" };
check("overseas asks for a region", buildBookingHeader(intlDraft).missing, ["destinationRegion"]);
check("region supplied → satisfied", buildBookingHeader(intlDraft, { destinationRegion: "ASIA" }).missing, []);
check("region lands in the header", buildBookingHeader(intlDraft, { destinationRegion: "ASIA" }).booking.tramadaOverrides.destination, "ASIA");

const planExisting = planTramadaFromQuote(draft, quote, { existingBookingNo: "12806" });
check("existing-booking mode", planExisting.mode, "existing");
check("existing needs no client", planExisting.missing, []);
check("segment ref carried into the plan", planExisting.segment.confirmationNumber, "Q422380 / AQ788851");
check("unresolved creditor stays null", planExisting.segment.creditor, null);
check("creditor source reported", planExisting.creditorSource, "unresolved");
ok("summary flags the creditor ask", /creditor: will ask/.test(planExisting.summary), planExisting.summary);

const planNew = planTramadaFromQuote(draft, quote, {});
check("new-booking mode asks for a client", planNew.missing, ["clientCode"]);
check("client supplied → nothing missing", planTramadaFromQuote(draft, quote, { clientCode: "GRAY/MEGAN" }).missing, []);

const planCred = planTramadaFromQuote(draft, quote, { existingBookingNo: "12806", creditor: "SWISS-BELHOTEL THE YORK" });
check("explicit creditor used", planCred.segment.creditor, "SWISS-BELHOTEL THE YORK");
check("explicit creditor source", planCred.creditorSource, "user");
check("cost basis flows through the plan", planTramadaFromQuote(draft, quote, { existingBookingNo: "1", rateBasis: "cost" }).segment.rate, 682.65);

check("resolveCreditorFor prefers the explicit answer", resolveCreditorFor("Anything", "ACME HOTELS"), { creditor: "ACME HOTELS", source: "user" });
check("resolveCreditorFor misses cleanly", resolveCreditorFor("Never Seen Hotel"), { creditor: null, source: "unresolved" });

console.log("\nguest sourcing");
check(
  "client name wins the first slot",
  guestsForDraft({ clientName: "GRAY/MEGAN MS", chatGuests: ["Autotest Quotetwo"], guestCount: 2 }),
  { guests: [{ firstName: "Megan", lastName: "Gray", title: "Ms" }, { firstName: "Autotest", lastName: "Quotetwo", title: "" }], source: "tramada-client", missing: 0 }
);
check(
  "no client → chat names only",
  guestsForDraft({ chatGuests: ["Autotest Quoteone"], guestCount: 1 }).source,
  "chat"
);
check("short-handed run is reported, not padded", guestsForDraft({ clientName: "GRAY/MEGAN MS", guestCount: 2 }).missing, 1);
check("duplicate names collapse", guestsForDraft({ clientName: "GRAY/MEGAN MS", chatGuests: ["Gray/Megan"], guestCount: 2 }).guests.length, 1);

/* ── chat state machine ─────────────────────────────────────────────────── */
console.log("\nchat parsers");
const chat = require("./roomres-chat");

check("ISO date", chat.parseOneDate("2026-08-01"), "2026-08-01");
check("d Mon yyyy", chat.parseOneDate("1 Aug 2026"), "2026-08-01");
check("Mon d yyyy", chat.parseOneDate("Aug 1 2026"), "2026-08-01");
check("dd/mm/yyyy is day-first", chat.parseOneDate("01/08/2026"), "2026-08-01");
check("two-digit year", chat.parseOneDate("1-Aug-26"), "2026-08-01");
check("nonsense → blank", chat.parseOneDate("sometime soon"), "");

const trip = chat.parseTripText("Sydney 1 Aug 2026 to 3 Aug 2026, 2 adults");
check("trip destination", trip.destination, "Sydney");
check("trip dates", [trip.dateFrom, trip.dateTo], ["2026-08-01", "2026-08-03"]);
check("trip adults", trip.adults, 2);
check("trip complete", trip.missing, []);

const trip2 = chat.parseTripText("Gold Coast 2026-09-10 - 2026-09-14 3 adults 2 children 2 rooms");
check("multi-word destination", trip2.destination, "Gold Coast");
check("dash range", [trip2.dateFrom, trip2.dateTo], ["2026-09-10", "2026-09-14"]);
check("children and rooms", [trip2.children, trip2.rooms], [2, 2]);

const trip3 = chat.parseTripText("Melbourne 1 Aug to 3 Aug 2026, 2 adults");
check("year borrowed from the second date", [trip3.dateFrom, trip3.dateTo], ["2026-08-01", "2026-08-03"]);

check("missing dates reported", chat.parseTripText("Sydney 2 adults").missing, ["dates"]);
check("missing guests reported", chat.parseTripText("Sydney 1 Aug 2026 to 3 Aug 2026").missing, ["guests"]);

check("names split on commas", chat.parseNames("Megan Gray, Sam Gray"), ["Megan Gray", "Sam Gray"]);
check("names split on 'and'", chat.parseNames("Megan Gray and Sam Gray"), ["Megan Gray", "Sam Gray"]);
check("single-word name rejected", chat.parseNames("Megan"), []);
check("money", chat.parseMoney("$1,780.50"), 1780.5);

console.log("\nchat flow");
let s = chat.startQuoteFlow().state;
check("starts at the booking question", s.step, "booking");

let r = chat.advance(s, "banana");
check("non-numeric booking is refused", r.state.step, "booking");

r = chat.advance(s, "12806");
check("booking number accepted", r.state.data.existingBookingNo, "12806");
check("looks the booking's client up first", r.run, "bookingClient");

// A booking with no client name on it falls back to asking, same as a new one.
r = chat.resume(r.state, "bookingClient", { bookingNo: "12806", clientCode: "", clientName: "" });
check("moves to the rate track", r.state.step, "track");

r = chat.advance(r.state, "net");
check("net track recorded", r.state.data.rateTrack, "net");
r = chat.advance(r.state, "Sydney 1 Aug 2026 to 3 Aug 2026, 2 adults");
check("trip captured", r.state.step, "hotel");

// No client name, so it must ask for both guests rather than pad the list.
r = chat.advance(r.state, "The York");
check("asks for guests when there's no client", r.state.step, "guests");
ok("asks for the right number", /2 more guest names/.test(r.messages[0]), r.messages[0]);
r = chat.advance(r.state, "Autotest Quoteone, Autotest Quotetwo");
check("guests complete → run the draft", r.run, "draft");
check("guest list built", r.state.data.guests.length, 2);
check("draft args carry the track", chat.draftArgs(r.state).rateTrack, "net");
check("draft args carry the hotel", chat.draftArgs(r.state).hotelName, "The York");

r = chat.resume(r.state, "draft", draft);
check("cost shown, price asked", r.state.step, "price");
ok("cost appears in the message", /682\.65/.test(r.messages.join(" ")), r.messages.join(" "));

// Under-cost quoting must be confirmed twice, never accepted silently.
let under = chat.advance(r.state, "500");
check("under cost pauses", under.state.step, "price");
ok("loss is spelled out", /below/i.test(under.messages[0]), under.messages[0]);
under = chat.advance(under.state, "500");
check("repeat confirms it", under.state.data.quotedPrice, 500);

r = chat.advance(r.state, "780");
check("price recorded", r.state.data.quotedPrice, 780);
check("runs the quote", r.run, "quote");

r = chat.resume(r.state, "quote", quote);
check("asks where the segment goes", r.state.step, "target");
ok("names the existing booking", /12806/.test(r.messages.join(" ")), r.messages.join(" "));
ok("shows the combined reference", /Q422380 \/ AQ788851/.test(r.messages.join(" ")), r.messages.join(" "));

const stopped = chat.advance(r.state, "no");
check("declining stops before Tramada", stopped.state.step, "done");
check("declining runs nothing", stopped.run, null);

r = chat.advance(r.state, "yes");
check("confirming runs the Tramada bridge", r.run, "tramada");
check("tramada args carry the booking", chat.tramadaArgs(r.state).existingBookingNo, "12806");

r = chat.resume(r.state, "tramada", { bookingNo: "12806", confirmationField: "#confirmationNumber" });
check("then asks about the receipt", r.state.step, "receipt");

const noRcpt = chat.advance(r.state, "no");
check("receipt declined ends cleanly", noRcpt.state.step, "done");

r = chat.advance(r.state, "yes");
check("receipt details asked", r.state.step, "receiptDetails");
r = chat.advance(r.state, "780.00 RR788851");
check("receipt staged as a dry run", r.state.data.dryRunReceipt, true);
check("EFT by default", r.state.data.receipt.transactionType, "EFT");
check("reference parsed", r.state.data.receipt.reference, "RR788851");
check("runs the receipt", r.run, "receipt");

r = chat.resume(r.state, "receipt", { staged: true });
check("waits for confirmation before issuing", r.state.step, "receiptConfirm");
r = chat.advance(r.state, "yes");
check("issuing is a second, explicit run", [r.run, r.state.data.dryRunReceipt], ["receipt", false]);
r = chat.resume(r.state, "receipt", { issued: true });
check("done", r.state.step, "done");

console.log("\nchat flow — client copied off an existing booking (answer 3)");
let cc = chat.startQuoteFlow().state;
cc = chat.advance(cc, "12806");
check("existing booking triggers the lookup", cc.run, "bookingClient");
cc = chat.resume(cc.state, "bookingClient", { bookingNo: "12806", clientCode: "GRAY/MEGAN", clientName: "GRAY/MEGAN MS" });
ok("the client is named back", /GRAY\/MEGAN MS/.test(cc.messages[0]), cc.messages[0]);
check("client code kept for later", cc.state.data.clientCode, "GRAY/MEGAN");
cc = chat.advance(cc.state, "net").state;
cc = chat.advance(cc, "Sydney 1 Aug 2026 to 3 Aug 2026, 2 adults").state;
cc = chat.advance(cc, "The York");
check("only the SECOND guest is asked for", cc.state.step, "guests");
ok("and only one is missing", /1 more guest name\b/.test(cc.messages[0]), cc.messages[0]);
check("the client is already guest 1", cc.state.data.guests[0].firstName, "Megan");
check("…surname too", cc.state.data.guests[0].lastName, "Gray");
cc = chat.advance(cc.state, "Sam Gray");
check("second name completes the party", cc.run, "draft");
check("both guests go to Room-Res", chat.draftArgs(cc.state).guests.length, 2);

// A single traveller needs no chat input at all — the client covers it.
let solo = chat.startQuoteFlow().state;
solo = chat.advance(solo, "12806").state;
solo = chat.resume(solo, "bookingClient", { bookingNo: "12806", clientCode: "GRAY/MEGAN", clientName: "GRAY/MEGAN MS" }).state;
solo = chat.advance(solo, "net").state;
solo = chat.advance(solo, "Sydney 1 Aug 2026 to 3 Aug 2026, 1 adult").state;
solo = chat.advance(solo, "The York");
check("one traveller: straight to the draft", solo.run, "draft");
check("no guest question at all", solo.state.step, "draft");

// The lookup failing must not strand the flow.
const lookupFailed = chat.resume(
  { step: "lookup", data: { existingBookingNo: "12806" } },
  "bookingClient",
  { error: "Tramada timed out" }
);
check("a failed lookup carries on", lookupFailed.state.step, "track");
ok("and says why", /timed out/.test(lookupFailed.messages[0]), lookupFailed.messages[0]);
const lookupBusy = chat.advance({ step: "lookup", data: {} }, "hello?");
ok("a stray message during the lookup is harmless", /moment/i.test(lookupBusy.messages[0]), lookupBusy.messages[0]);

console.log("\nchat flow — new booking branch");
let n = chat.startQuoteFlow().state;
n = chat.advance(n, "new").state;
check("new booking has no number", n.data.existingBookingNo, null);
n = chat.advance(n, "online").state;
check("online track", n.data.rateTrack, "online");
n = chat.advance(n, "Sydney 1 Aug 2026 to 3 Aug 2026, 2 adults").state;
n = chat.advance(n, "cheapest");
check("cheapest means no hotel name", n.state.data.hotelName, null);
n = chat.advance(n.state, "Autotest Quoteone, Autotest Quotetwo");
n = chat.resume(n.state, "draft", draft);
n = chat.advance(n.state, "780");
n = chat.resume(n.state, "quote", quote);
n = chat.advance(n.state, "yes");
check("new booking asks for a surname", n.state.step, "client");
n = chat.advance(n.state, "Gray");
check("surname triggers a client search", n.run, "clients");
n = chat.resume(n.state, "clients", [{ label: "GRAY/MEGAN MS", clientCode: "GRAY/MEGAN" }, { label: "GRAY/SAM MR", clientCode: "GRAY/SAM" }]);
ok("matches are numbered", /1\. GRAY\/MEGAN MS/.test(n.messages[0]), n.messages[0]);
n = chat.advance(n.state, "1");
check("picking by number sets the client", n.state.data.clientCode, "GRAY/MEGAN");
check("then runs Tramada", n.run, "tramada");

/* ── receipt details parsing ────────────────────────────────────────────── */
console.log("\nreceipt details");
const recAt = (text) => chat.advance({ step: "receiptDetails", data: { quotedPrice: 110 } }, text);

// The exact line that staged an EFT receipt when Cash was asked for.
const cashRec = recAt("110.00, JHJ-12806, Cash");
check("the payment method is honoured", cashRec.state.data.receipt.transactionType, "Cash");
check("the reference survives the method word", cashRec.state.data.receipt.reference, "JHJ-12806");
check("the amount survives the commas", cashRec.state.data.receipt.amount, 110);
ok("and the staging line says Cash", /Staging a Cash receipt/.test(cashRec.messages[0]), cashRec.messages[0]);

// The method leading the line must not be mistaken for the reference.
const leadRec = recAt("Cash 110 REF123");
check("a leading method isn't taken as the reference", leadRec.state.data.receipt.reference, "REF123");
check("and it's still recognised", leadRec.state.data.receipt.transactionType, "Cash");

check("cheque", recAt("110 REF9 cheque").state.data.receipt.transactionType, "Cheque");
check("credit card", recAt("110 REF9 credit card").state.data.receipt.transactionType, "Credit Card");
check("swipe beats plain card", recAt("110 REF9 credit card swipe").state.data.receipt.transactionType, "Credit Card Swipe");
check("unstated still defaults to EFT", recAt("110 REF9").state.data.receipt.transactionType, "EFT");
ok("and the default is called out", /defaulted to EFT/.test(recAt("110 REF9").messages[0]), recAt("110 REF9").messages[0]);
// A reference that merely LOOKS like a payment word must not be eaten.
check("a CC-style reference is left alone", recAt("110 CC-1234").state.data.receipt.reference, "CC-1234");

console.log("\nchat flow — interruptions");
check("cancel works anywhere", chat.advance(n.state, "cancel").state, null);
const busy = chat.advance({ step: "draft", data: {} }, "hello?");
check("a message mid-run doesn't derail it", [busy.step, busy.run], [undefined, null]);
ok("mid-run reply is reassuring", /moment/i.test(busy.messages[0]), busy.messages[0]);
const failed = chat.resume({ step: "draft", data: {} }, "draft", { error: "no rooms available" });
check("a failed draft returns to the hotel question", failed.state.step, "hotel");
ok("the failure is quoted back", /no rooms available/.test(failed.messages[0]), failed.messages[0]);

// A failed action must land on a step that can RETRY it. Parking on the step it
// failed at is what bricked the flow: "quote"/"tramada" are waiting-on-browser
// steps, so advance() answered every later message with "still working on that
// one" and the run could never be picked back up.
const qFail = chat.resume({ step: "quote", data: { itineraryId: "788967", netCost: 3556.75 } }, "quote", {
  error: "Timed out waiting for #guestTotalPrice",
});
check("a failed quote returns to the price question", qFail.state.step, "price");
const qRetry = chat.advance(qFail.state, "3900");
check("and the price can simply be re-sent", qRetry.run, "quote");
check("the retry keeps the same draft", qRetry.state.data.itineraryId, "788967");
const tFail = chat.resume({ step: "tramada", data: {} }, "tramada", { error: "Tramada timed out" });
check("a failed Tramada write returns to the target question", tFail.state.step, "target");
const rFail = chat.resume({ step: "receiptIssue", data: {} }, "receipt", { error: "receipt refused" });
check("a failed receipt returns to the receipt details", rFail.state.step, "receiptDetails");

console.log("\nstart phrases");
for (const phrase of [
  "create quote",
  "Create a quote",
  "make a new quote",
  "start a hotel quote",
  "create a room-res quote",
  "room res quote please",
]) {
  ok(`"${phrase}" starts the flow`, chat.isStart(phrase), phrase);
}
for (const phrase of [
  "what's the quote number?",
  "send the client that quote",
  "yes",
  "780.00",
  "apply the same pdf to booking 12806",
]) {
  ok(`"${phrase}" does NOT start the flow`, !chat.isStart(phrase), phrase);
}

console.log("\ncreditor pause & resume (the server.js contract)");
// When a run stops on an unmatched creditor the server does NOT advance the
// conversation — it writes the name onto the flow's data and re-runs the SAME
// action. These checks are that contract, minus the browser.
let cr = chat.startQuoteFlow().state;
cr = chat.advance(cr, "12806").state;
cr = chat.resume(cr, "bookingClient", { bookingNo: "12806", clientCode: "", clientName: "" }).state;
cr = chat.advance(cr, "net").state;
cr = chat.advance(cr, "Sydney 1 Aug 2026 to 3 Aug 2026, 2 adults").state;
cr = chat.advance(cr, "The York").state;
cr = chat.advance(cr, "Megan Gray, Sam Gray").state;
cr = chat.resume(cr, "draft", draft).state;
cr = chat.advance(cr, "780").state;
cr = chat.resume(cr, "quote", quote).state;
const crTarget = chat.advance(cr, "yes");
check("existing booking goes straight to Tramada", crTarget.run, "tramada");
check("no creditor stated yet", chat.tramadaArgs(crTarget.state).creditor, undefined);

// …the run throws needsCreditor, the user answers, the server does this:
crTarget.state.data.creditor = "SWISS-BELHOTEL THE YORK";
check(
  "the answer reaches runRoomResToTramada",
  chat.tramadaArgs(crTarget.state).creditor,
  "SWISS-BELHOTEL THE YORK"
);
check("and the conversation hasn't moved on", crTarget.state.step, "tramada");

const crDone = chat.resume(crTarget.state, "tramada", {
  bookingNo: "12806",
  confirmationField: "#itineraryconfirmationOrReferenceNumber",
});
check("re-running the action lands on the receipt question", crDone.state.step, "receipt");
ok("no stray warning when the reference was recorded", !/⚠️/.test(crDone.messages.join(" ")), crDone.messages.join(" "));

const crWarned = chat.resume(crTarget.state, "tramada", { bookingNo: "12806", confirmationField: null });
ok("a missing confirmation field is called out", /⚠️/.test(crWarned.messages.join(" ")), crWarned.messages.join(" "));

console.log("\nsummary line");
console.log("  " + describeDraft(draft));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
