/**
 * creditor-aliases.js — remembers which Tramada creditor a supplier name maps to.
 *
 * Room-Res hotel names and Tramada creditor names rarely match on the nose
 * ("The York by Swiss-Belhotel International" vs "SWISS-BELHOTEL THE YORK"), and
 * the agreed behaviour is to book the REAL HOTEL as the creditor rather than one
 * blanket Room-Res creditor. So the first time a hotel comes up we fall through
 * to the existing stop-and-ask flow, the user types the exact Tramada creditor,
 * and we remember it here — the second booking at that hotel runs straight
 * through.
 *
 * Deliberately a flat JSON file, not a database: it's a handful of rows, it has
 * to survive a server restart, and a human being able to open and correct it in
 * a text editor is a feature.
 */

const fs = require("fs");
const path = require("path");

const FILE = process.env.CREDITOR_ALIAS_FILE || path.join(__dirname, "creditor-aliases.json");

let _cache = null;

// Words that carry no identifying signal in a hotel/creditor name. Dropping them
// is what lets "The York by Swiss-Belhotel International" and "SWISS-BELHOTEL
// THE YORK" reduce to the same thing.
const STOPWORDS = new Set([
  "hotel", "hotels", "resort", "resorts", "the", "by", "and", "of", "at", "inn",
  "suites", "suite", "apartments", "apartment", "international", "pty", "ltd",
  "limited", "group", "collection", "co",
]);

function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

// Word ORDER differs constantly between the two systems ("The York by
// Swiss-Belhotel" vs "Swiss-Belhotel The York"), so the key is the significant
// words SORTED — order-independent by construction.
function normKey(s) {
  return tokens(s).sort().join("");
}

function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!_cache || typeof _cache !== "object") _cache = {};
  } catch {
    _cache = {}; // no file yet, or it got mangled — start clean rather than throw
  }
  return _cache;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(_cache || {}, null, 2) + "\n", "utf8");
    return true;
  } catch (e) {
    // A cache that can't persist is still useful in-process — never kill a run
    // over it.
    console.error("creditor-aliases: could not write", FILE, e.message);
    return false;
  }
}

/**
 * Look up the Tramada creditor for a supplier name.
 * Exact (order-independent) key first; then a token-overlap match so a shorter
 * remembered name still hits — "York Sydney" finds "The York by Swiss-Belhotel".
 * The overlap bar is deliberately high (every word of the shorter name must be
 * present): a wrong creditor is a wrong payment, so a miss that falls through to
 * asking the user is much cheaper than a confident mismatch.
 */
function resolveCreditor(supplierName) {
  const db = load();
  const key = normKey(supplierName);
  if (!key) return null;
  if (db[key]) return db[key].creditor;

  const want = new Set(tokens(supplierName));
  if (!want.size) return null;
  for (const v of Object.values(db)) {
    const have = new Set(tokens(v.supplierName));
    if (!have.size) continue;
    const [small, big] = want.size <= have.size ? [want, have] : [have, want];
    const overlap = [...small].filter((t) => big.has(t)).length;
    if (overlap === small.size && overlap >= 1) return v.creditor;
  }
  return null;
}

/** Remember supplierName → creditor (called after the user answers the ask). */
function rememberCreditor(supplierName, creditor) {
  if (!supplierName || !creditor) return false;
  const db = load();
  const key = normKey(supplierName);
  if (!key) return false;
  db[key] = {
    creditor: String(creditor).trim(),
    supplierName: String(supplierName).trim(),
    // ISO string so the file stays readable; used only for housekeeping.
    updated: new Date().toISOString(),
  };
  return save();
}

function forgetCreditor(supplierName) {
  const db = load();
  const key = normKey(supplierName);
  if (!key || !db[key]) return false;
  delete db[key];
  return save();
}

function listAliases() {
  const db = load();
  return Object.values(db).map((v) => ({ supplierName: v.supplierName, creditor: v.creditor, updated: v.updated }));
}

module.exports = { resolveCreditor, rememberCreditor, forgetCreditor, listAliases, normKey, FILE };
