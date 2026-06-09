/**
 * parsePdf.js — PDF Flight Plan Parser & Validator
 * ==================================================
 * Reads a booking PDF, extracts all travel details, and validates
 * that every required field is present before automation begins.
 *
 * Required fields for Jetstar booking:
 *   ✅ Origin airport (From)
 *   ✅ Destination airport (To)
 *   ✅ Departure date
 *   ✅ Trip type (one-way / return) — inferred from presence of return date
 *   ✅ Return date (if return trip)
 *   ✅ Number of adults (must be ≥ 1)
 *   ✅ Number of children (0+) — if > 0, each child's age is REQUIRED
 *   ✅ Number of infants (0+) — if > 0, each infant's age is REQUIRED
 *   ✅ Budget (optional but used for fare selection)
 *
 * Child age rules (Jetstar):
 *   - Child:  2–11 years old
 *   - Infant: under 2 years old (lap / seat)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Try to load pdf-parse (npm). If not installed, we fall back to other methods.
let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
} catch {
  // pdf-parse not installed — will use fallbacks
}

// ─── Known Airport Codes ─────────────────────────────────────────
const AIRPORT_CODES = {
  ADL: "Adelaide",
  SYD: "Sydney",
  MEL: "Melbourne (Tullamarine)",
  BNE: "Brisbane",
  PER: "Perth",
  OOL: "Gold Coast",
  CNS: "Cairns",
  HBA: "Hobart",
  LST: "Launceston",
  DRW: "Darwin",
  CBR: "Canberra",
  NTL: "Newcastle",
  MCY: "Sunshine Coast",
  TSV: "Townsville",
  MKY: "Mackay",
  HVB: "Hervey Bay",
  AVV: "Melbourne (Avalon)",
  AYQ: "Uluru (Ayers Rock)",
  PPP: "Whitsunday Coast (Proserpine)",
  BNK: "Ballina Byron",
  BQB: "Busselton Margaret River",
  DPS: "Bali (Denpasar)",
  NAN: "Nadi",
  HNL: "Honolulu",
};

// Reverse map: lowercase city name (without parenthesised qualifier) → IATA code.
const CITY_TO_CODE = Object.fromEntries(
  Object.entries(AIRPORT_CODES).map(([code, city]) => [
    city.split(" (")[0].trim().toLowerCase(),
    code,
  ])
);

function lookupAirportByCity(name) {
  if (!name) return null;
  const code = CITY_TO_CODE[name.trim().toLowerCase()];
  return code ? { code, city: AIRPORT_CODES[code] } : null;
}

// ─── Parse the PDF ───────────────────────────────────────────────
// Extraction priority:
//   1. pdf-parse (npm)            — pure JS, works everywhere Node runs
//   2. Python pdfplumber          — excellent extraction, needs Python
//   3. System pdftotext           — needs poppler-utils installed
//   4. Raw byte extraction        — last resort, unreliable
async function parsePdf(pdfPath) {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }

  let text = "";

  // ── Method 1: pdf-parse (npm) ──────────────────────────────
  if (pdfParse) {
    try {
      const dataBuffer = fs.readFileSync(pdfPath);
      const pdfData = await pdfParse(dataBuffer);
      text = pdfData.text;
      if (text && text.trim().length > 0) {
        console.log("📦 PDF extracted via: pdf-parse (npm)");
      }
    } catch (err) {
      console.warn(`⚠️  pdf-parse failed: ${err.message}`);
      text = "";
    }
  }

  // ── Method 2: Python pdfplumber ────────────────────────────
  if (!text || text.trim().length === 0) {
    const pythonScript = path.join(__dirname, "extractPdfText.py");
    try {
      text = execSync(`python3 "${pythonScript}" "${pdfPath}"`, {
        encoding: "utf-8",
        timeout: 15000,
      });
      if (text && text.trim().length > 0) {
        console.log("🐍 PDF extracted via: Python pdfplumber");
      }
    } catch {
      console.warn("⚠️  Python pdfplumber not available.");
    }
  }

  // ── Method 3: System pdftotext ─────────────────────────────
  if (!text || text.trim().length === 0) {
    try {
      text = execSync(`pdftotext -layout "${pdfPath}" -`, { encoding: "utf-8" });
      if (text && text.trim().length > 0) {
        console.log("🔧 PDF extracted via: pdftotext (poppler)");
      }
    } catch {
      try {
        text = execSync(`pdftotext "${pdfPath}" -`, { encoding: "utf-8" });
      } catch {
        console.warn("⚠️  pdftotext not available.");
      }
    }
  }

  // ── Method 4: Raw byte extraction (last resort) ────────────
  if (!text || text.trim().length === 0) {
    console.warn("⚠️  All PDF parsers failed. Attempting raw byte extraction...");
    const raw = fs.readFileSync(pdfPath, "latin1");
    const matches = raw.match(/\(([^)]+)\)/g) || [];
    text = matches.map((m) => m.slice(1, -1)).join(" ");
  }

  if (!text || text.trim().length === 0) {
    throw new Error(
      "Could not extract any text from the PDF.\n" +
      "Please install one of these:\n" +
      "  • npm install pdf-parse     (recommended — pure JS)\n" +
      "  • pip install pdfplumber    (Python alternative)\n" +
      "  • brew install poppler      (for pdftotext CLI)"
    );
  }

  console.log("\n📄 Raw PDF text:\n" + "─".repeat(50));
  console.log(text);
  console.log("─".repeat(50) + "\n");

  return extractBookingDetails(text);
}

// ─── Extract Booking Details from Text ───────────────────────────
function extractBookingDetails(text) {
  const details = {
    origin: null,
    originCode: null,
    destination: null,
    destinationCode: null,
    departureDate: null,
    returnDate: null,
    tripType: null, // "return" or "one-way"
    adults: null,
    children: null,
    infants: null,
    childAges: [],   // REQUIRED if children > 0
    infantAges: [],   // REQUIRED if infants > 0
    budget: null,
    budgetCurrency: null,
  };

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const fullText = lines.join(" ");

  // ─── 1. Origin / From ──────────────────────────────────────
  // Try, in order: "City - CODE", airport code anywhere after "From:",
  // and finally a known city name (handles run-on text like "AdelaideTo:").
  const fromMatch = fullText.match(/From[:\s]+([A-Za-z\s()]+?)\s*[-–]\s*([A-Z]{3})/i);
  if (fromMatch) {
    details.origin = `${fromMatch[1].trim()} - ${fromMatch[2]}`;
    details.originCode = fromMatch[2];
  } else {
    const fromCode = fullText.match(/From[:\s]+.*?([A-Z]{3})/i);
    if (fromCode && AIRPORT_CODES[fromCode[1]]) {
      details.originCode = fromCode[1];
      details.origin = `${AIRPORT_CODES[fromCode[1]]} - ${fromCode[1]}`;
    } else {
      const fromCity = fullText.match(/From[:\s]+([A-Za-z][A-Za-z ]*?)(?=\s*(?:To[:\s]|Departure[:\s]|Return[:\s]|Budget[:\s]|Passengers?\b|$))/i);
      const hit = fromCity && lookupAirportByCity(fromCity[1]);
      if (hit) {
        details.originCode = hit.code;
        details.origin = `${hit.city} - ${hit.code}`;
      }
    }
  }

  // ─── 2. Destination / To ───────────────────────────────────
  const toMatch = fullText.match(/To[:\s]+([A-Za-z\s()]+?)\s*[-–]\s*([A-Z]{3})/i);
  if (toMatch) {
    details.destination = `${toMatch[1].trim()} - ${toMatch[2]}`;
    details.destinationCode = toMatch[2];
  } else {
    const toCode = fullText.match(/To[:\s]+.*?([A-Z]{3})/i);
    if (toCode && AIRPORT_CODES[toCode[1]]) {
      details.destinationCode = toCode[1];
      details.destination = `${AIRPORT_CODES[toCode[1]]} - ${toCode[1]}`;
    } else {
      const toCity = fullText.match(/To[:\s]+([A-Za-z][A-Za-z ]*?)(?=\s*(?:Departure[:\s]|Return[:\s]|Budget[:\s]|Passengers?\b|$))/i);
      const hit = toCity && lookupAirportByCity(toCity[1]);
      if (hit) {
        details.destinationCode = hit.code;
        details.destination = `${hit.city} - ${hit.code}`;
      }
    }
  }

  // ─── 3. Departure Date ─────────────────────────────────────
  const depMatch = fullText.match(/Departure[:\s]+(\d{4}[-/]\d{2}[-/]\d{2})/i)
    || fullText.match(/Depart[:\s]+(\d{2}[-/]\d{2}[-/]\d{4})/i)
    || fullText.match(/Departure[:\s]+(\d{1,2}\s+\w+\s+\d{4})/i);
  if (depMatch) {
    details.departureDate = normalizeDate(depMatch[1]);
  }

  // ─── 4. Return Date ────────────────────────────────────────
  const retMatch = fullText.match(/Return[:\s]+(\d{4}[-/]\d{2}[-/]\d{2})/i)
    || fullText.match(/Return[:\s]+(\d{2}[-/]\d{2}[-/]\d{4})/i)
    || fullText.match(/Return[:\s]+(\d{1,2}\s+\w+\s+\d{4})/i);
  if (retMatch) {
    details.returnDate = normalizeDate(retMatch[1]);
  }

  // ─── 5. Trip Type ──────────────────────────────────────────
  const tripTypeMatch = fullText.match(/trip\s*type[:\s]+(one[- ]?way|return|round[- ]?trip)/i)
    || fullText.match(/(one[- ]?way|return\s*trip|round[- ]?trip)/i);
  if (tripTypeMatch) {
    const raw = tripTypeMatch[1].toLowerCase();
    details.tripType = raw.includes("one") ? "one-way" : "return";
  } else {
    // Infer from return date presence
    details.tripType = details.returnDate ? "return" : null;
  }

  // ─── 6. Adults ─────────────────────────────────────────────
  const adultMatch = fullText.match(/(\d+)\s*Adult/i);
  if (adultMatch) {
    details.adults = parseInt(adultMatch[1], 10);
  }

  // ─── 7. Children ───────────────────────────────────────────
  const childMatch = fullText.match(/(\d+)\s*Child/i);
  if (childMatch) {
    details.children = parseInt(childMatch[1], 10);
  } else {
    // Default to 0 if passengers are mentioned but no children
    if (details.adults !== null) details.children = 0;
  }

  // ─── 8. Infants ────────────────────────────────────────────
  const infantMatch = fullText.match(/(\d+)\s*Infant/i);
  if (infantMatch) {
    details.infants = parseInt(infantMatch[1], 10);
  } else {
    if (details.adults !== null) details.infants = 0;
  }

  // ─── 9. Child Ages ─────────────────────────────────────────
  // Handles a wide variety of formats:
  //   "1 Child Age - 5"         "Child age: 5"
  //   "Child (age 5)"           "Child aged 5"
  //   "Child 5 years"           "Child: 5 yrs"
  //   "Children ages: 3, 7"     "Child 1 age 3, Child 2 age 7"
  //   "1 Child (5)"             "Child - 5 years old"
  //   "1 Child Age-5"           "child age 5, 8"
  const childAgePatterns = [
    // "Child Age - 5" / "Child Age-5" / "Child Age: 5" / "Child Age 5"
    /Child(?:ren)?(?:\s*\d*)?\s*Age\s*[-–:=\s]\s*(\d+(?:\s*[,;&and]+\s*\d+)*)/gi,
    // "Child aged 5" / "Child age 5"
    /Child(?:ren)?(?:\s*\d*)?\s*(?:aged?)\s*[:=\s]\s*(\d+(?:\s*[,;&and]+\s*\d+)*)/gi,
    // "Child (age 5)" / "Child (5)"
    /Child\s*\(\s*(?:age\s*)?(\d+)\s*\)/gi,
    // "Child: 5 years" / "Child - 5 years" / "Child 5 yrs"
    /Child(?:\s*\d*)?\s*[-–:]\s*(\d+)\s*(?:years?|yrs?|y\.?o\.?)?/gi,
    // "Child 5 years old"
    /Child\s+(\d+)\s*(?:years?\s*old|years?|yrs?|y\.?o\.?)/gi,
    // "ages: 3, 7, 11" or "ages 3 and 7" (general ages line)
    /(?:child(?:ren)?\s+)?ages?\s*[:=\s-]\s*(\d+(?:\s*[,;&and]+\s*\d+)*)/gi,
  ];
  for (const pattern of childAgePatterns) {
    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      const ages = match[1].match(/\d+/g);
      if (ages) {
        for (const a of ages.map(Number)) {
          // Only add ages in valid child range (2-11) and avoid duplicates
          if (!details.childAges.includes(a)) {
            details.childAges.push(a);
          }
        }
      }
    }
    if (details.childAges.length > 0) break; // Stop once we found ages
  }

  // ─── 10. Infant Ages ──────────────────────────────────────
  // Handles: "Infant Age - 8 months", "Infant (age 1)", "Infant aged 6 months"
  const infantAgePatterns = [
    /Infant(?:s)?(?:\s*\d*)?\s*Age\s*[-–:=\s]\s*(\d+(?:\s*months?)?(?:\s*[,;&and]+\s*\d+(?:\s*months?)?)*)/gi,
    /Infant(?:s)?(?:\s*\d*)?\s*(?:aged?)\s*[:=\s]\s*(\d+(?:\s*months?)?(?:\s*[,;&and]+\s*\d+(?:\s*months?)?)*)/gi,
    /Infant\s*\(\s*(?:age\s*)?(\d+\s*(?:months?)?)\s*\)/gi,
    /Infant(?:\s*\d*)?\s*[-–:]\s*(\d+)\s*(?:months?|mo\.?)/gi,
  ];
  for (const pattern of infantAgePatterns) {
    let match;
    while ((match = pattern.exec(fullText)) !== null) {
      const ages = match[1].match(/\d+/g);
      if (ages) {
        for (const a of ages.map(Number)) {
          if (!details.infantAges.includes(a)) {
            details.infantAges.push(a);
          }
        }
      }
    }
    if (details.infantAges.length > 0) break;
  }

  // ─── 11. Budget ────────────────────────────────────────────
  const budgetMatch = fullText.match(/Budget[:\s]*[₹$AUD\s]*(\d[\d,]*(?:\.\d{2})?)\s*(AUD|USD|INR)?/i)
    || fullText.match(/(\d[\d,]+(?:\.\d{2})?)\s*(AUD|USD)/i);
  if (budgetMatch) {
    details.budget = parseFloat(budgetMatch[1].replace(/,/g, ""));
    details.budgetCurrency = budgetMatch[2] || "AUD";
  }

  return details;
}

// ─── Normalize Date to YYYY-MM-DD ────────────────────────────────
function normalizeDate(raw) {
  // Already YYYY-MM-DD
  if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(raw)) {
    return raw.replace(/\//g, "-");
  }
  // DD/MM/YYYY or DD-MM-YYYY
  if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(raw)) {
    const parts = raw.split(/[-/]/);
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  // "15 March 2026" format
  const months = {
    january: "01", february: "02", march: "03", april: "04",
    may: "05", june: "06", july: "07", august: "08",
    september: "09", october: "10", november: "11", december: "12",
  };
  const namedMatch = raw.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (namedMatch) {
    const month = months[namedMatch[2].toLowerCase()];
    if (month) {
      return `${namedMatch[3]}-${month}-${namedMatch[1].padStart(2, "0")}`;
    }
  }
  return raw;
}

// ─── Validate All Required Fields ────────────────────────────────
function validateBooking(details) {
  const errors = [];
  const warnings = [];

  // ── CRITICAL: Must-haves ──────────────────────────────────
  if (!details.originCode) {
    errors.push("❌ MISSING: Origin airport (From). PDF must contain 'From: City - CODE'");
  }

  if (!details.destinationCode) {
    errors.push("❌ MISSING: Destination airport (To). PDF must contain 'To: City - CODE'");
  }

  if (!details.departureDate) {
    errors.push("❌ MISSING: Departure date. PDF must contain 'Departure: YYYY-MM-DD'");
  } else if (!isValidFutureDate(details.departureDate)) {
    errors.push(`❌ INVALID: Departure date '${details.departureDate}' is in the past or invalid`);
  }

  // ── Trip Type / Return Date ───────────────────────────────
  if (!details.tripType) {
    errors.push(
      "❌ MISSING: Trip type could not be determined. " +
      "PDF must contain either a 'Return: YYYY-MM-DD' date (for round trip) " +
      "or explicitly state 'Trip Type: One-way' or 'Trip Type: Return'"
    );
  }

  if (details.tripType === "return" && !details.returnDate) {
    errors.push("❌ MISSING: Return date. Trip is marked as 'return' but no return date found");
  }

  if (details.returnDate && details.departureDate) {
    if (new Date(details.returnDate) <= new Date(details.departureDate)) {
      errors.push(`❌ INVALID: Return date (${details.returnDate}) must be after departure date (${details.departureDate})`);
    }
  }

  // ── Passengers ────────────────────────────────────────────
  if (details.adults === null || details.adults === undefined) {
    errors.push("❌ MISSING: Number of adult passengers. PDF must contain e.g. '2 Adult'");
  } else if (details.adults < 1) {
    errors.push("❌ INVALID: At least 1 adult passenger is required");
  }

  if (details.children === null || details.children === undefined) {
    errors.push("❌ MISSING: Number of children. PDF must specify e.g. '1 Child' or '0 Children'");
  }

  // ── Child Ages (CRITICAL if children > 0) ─────────────────
  if (details.children > 0) {
    if (details.childAges.length === 0) {
      errors.push(
        `❌ MISSING: Ages for ${details.children} child passenger(s). ` +
        `Jetstar REQUIRES child ages (2-11 years) for booking. ` +
        `PDF must contain e.g. 'Child age: 5' or 'Child 1 (age 3), Child 2 (age 7)'`
      );
    } else if (details.childAges.length < details.children) {
      errors.push(
        `❌ INCOMPLETE: Found ${details.childAges.length} child age(s) but ${details.children} child(ren) declared. ` +
        `Every child must have an age specified.`
      );
    }

    // Validate each child age is 2–11
    for (let i = 0; i < details.childAges.length; i++) {
      const age = details.childAges[i];
      if (age < 2 || age > 11) {
        errors.push(
          `❌ INVALID: Child ${i + 1} age is ${age}. ` +
          `Jetstar defines children as 2–11 years. ` +
          (age < 2 ? "Passengers under 2 must be booked as infants." : "Passengers 12+ must be booked as adults.")
        );
      }
    }
  }

  // ── Infant Ages (CRITICAL if infants > 0) ─────────────────
  if (details.infants > 0) {
    if (details.infantAges.length === 0) {
      errors.push(
        `❌ MISSING: Ages for ${details.infants} infant passenger(s). ` +
        `Jetstar REQUIRES infant ages (under 2 years) for booking. ` +
        `PDF must contain e.g. 'Infant age: 8 months' or 'Infant (age 1)'`
      );
    } else if (details.infantAges.length < details.infants) {
      errors.push(
        `❌ INCOMPLETE: Found ${details.infantAges.length} infant age(s) but ${details.infants} infant(s) declared.`
      );
    }
  }

  // ── Infant-to-Adult ratio ─────────────────────────────────
  if (details.infants > 0 && details.adults > 0 && details.infants > details.adults) {
    errors.push(
      `❌ INVALID: ${details.infants} infant(s) but only ${details.adults} adult(s). ` +
      `Each infant must be accompanied by an adult (max 1 infant per adult).`
    );
  }

  // ── Total passenger limit (Jetstar allows max 9) ──────────
  const totalPax = (details.adults || 0) + (details.children || 0) + (details.infants || 0);
  if (totalPax > 9) {
    errors.push(`❌ INVALID: Total passengers (${totalPax}) exceeds Jetstar limit of 9 per booking.`);
  }

  // ── Warnings (non-blocking) ───────────────────────────────
  if (!details.budget) {
    warnings.push("⚠️  No budget found in PDF. Will select cheapest available fares.");
  }

  if (details.originCode === details.destinationCode) {
    errors.push(`❌ INVALID: Origin and destination are the same (${details.originCode}).`);
  }

  return { errors, warnings, isValid: errors.length === 0 };
}

// ─── Check if date is valid and in the future ────────────────────
function isValidFutureDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d >= today;
}

// ─── Pretty-print Booking Details ────────────────────────────────
function printBookingSummary(details, validation) {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║         JETSTAR BOOKING — PARSED PDF DETAILS        ║");
  console.log("╠══════════════════════════════════════════════════════╣");
  console.log(`║  From:        ${(details.origin || "NOT FOUND").padEnd(38)}║`);
  console.log(`║  To:          ${(details.destination || "NOT FOUND").padEnd(38)}║`);
  console.log(`║  Trip Type:   ${(details.tripType || "NOT DETERMINED").padEnd(38)}║`);
  console.log(`║  Departure:   ${(details.departureDate || "NOT FOUND").padEnd(38)}║`);
  console.log(`║  Return:      ${(details.returnDate || (details.tripType === "one-way" ? "N/A (one-way)" : "NOT FOUND")).padEnd(38)}║`);
  console.log("╠──────────────────────────────────────────────────────╣");
  console.log(`║  Adults:      ${String(details.adults ?? "NOT FOUND").padEnd(38)}║`);
  console.log(`║  Children:    ${String(details.children ?? "NOT FOUND").padEnd(38)}║`);
  if (details.children > 0) {
    const agesStr = details.childAges.length > 0
      ? details.childAges.map((a, i) => `Child ${i+1}: ${a}yrs`).join(", ")
      : "⛔ AGES NOT PROVIDED";
    console.log(`║    Ages:      ${agesStr.padEnd(38)}║`);
  }
  console.log(`║  Infants:     ${String(details.infants ?? "NOT FOUND").padEnd(38)}║`);
  if (details.infants > 0) {
    const agesStr = details.infantAges.length > 0
      ? details.infantAges.map((a, i) => `Infant ${i+1}: ${a}`).join(", ")
      : "⛔ AGES NOT PROVIDED";
    console.log(`║    Ages:      ${agesStr.padEnd(38)}║`);
  }
  console.log("╠──────────────────────────────────────────────────────╣");
  console.log(`║  Budget:      ${details.budget ? `$${details.budget} ${details.budgetCurrency}` : "Not specified".padEnd(38)}║`);
  console.log("╚══════════════════════════════════════════════════════╝\n");

  // Print validation results
  if (validation.warnings.length > 0) {
    console.log("WARNINGS:");
    validation.warnings.forEach((w) => console.log(`  ${w}`));
    console.log();
  }

  if (validation.errors.length > 0) {
    console.log("ERRORS — Cannot proceed with booking:");
    validation.errors.forEach((e) => console.log(`  ${e}`));
    console.log();
    console.log("═══════════════════════════════════════════════════");
    console.log("  🛑 BOOKING ABORTED — Please fix the PDF and re-run.");
    console.log("═══════════════════════════════════════════════════\n");
  } else {
    console.log("✅ ALL VALIDATIONS PASSED — Ready to book!\n");
  }
}

module.exports = { parsePdf, validateBooking, printBookingSummary };
