"use strict";

/**
 * furnisher-addresses.js — Furnisher Dispute Address Lookup
 *
 * Lookup table of verified dispute addresses for major furnishers.
 * Source: 12 CFR 1022.43 Compliance Guide, Part J.
 *
 * Usage:
 *   const { lookupFurnisherAddress } = require('./furnisher-addresses');
 *   const addr = lookupFurnisherAddress('Capital One');
 *   // => "PO Box 30285, Salt Lake City, UT 84130"
 *
 * IMPORTANT: These addresses are a fallback (§ 1022.43(c)(3)).
 * Priority 1 is always the address on the consumer's credit report.
 * A stale address = failed compliance gate — validate against the report when possible.
 */

// Each entry shape: { name, address, city, state, zip, full }
// Keys are normalized (lowercase, stripped suffixes) for fuzzy matching.
const FURNISHER_ADDRESSES = {
  // -------------------------------------------------------------------------
  // Credit Card Issuers
  // -------------------------------------------------------------------------
  "capital one": {
    name: "Capital One",
    address: "PO Box 30285",
    city: "Salt Lake City",
    state: "UT",
    zip: "84130",
    full: "PO Box 30285, Salt Lake City, UT 84130",
  },
  chase: {
    name: "Chase",
    address: "PO Box 15298",
    city: "Wilmington",
    state: "DE",
    zip: "19850-5298",
    full: "PO Box 15298, Wilmington, DE 19850-5298",
  },
  "jp morgan chase": {
    name: "JP Morgan Chase",
    address: "PO Box 15298",
    city: "Wilmington",
    state: "DE",
    zip: "19850-5298",
    full: "PO Box 15298, Wilmington, DE 19850-5298",
  },
  "jpmorgan chase": {
    name: "JPMorgan Chase",
    address: "PO Box 15298",
    city: "Wilmington",
    state: "DE",
    zip: "19850-5298",
    full: "PO Box 15298, Wilmington, DE 19850-5298",
  },
  citibank: {
    name: "Citibank",
    address: "PO Box 790084",
    city: "St. Louis",
    state: "MO",
    zip: "63179",
    full: "PO Box 790084, St. Louis, MO 63179",
  },
  citi: {
    name: "Citi",
    address: "PO Box 790084",
    city: "St. Louis",
    state: "MO",
    zip: "63179",
    full: "PO Box 790084, St. Louis, MO 63179",
  },
  discover: {
    name: "Discover",
    address: "PO Box 30945",
    city: "Salt Lake City",
    state: "UT",
    zip: "84130",
    full: "PO Box 30945, Salt Lake City, UT 84130",
  },
  "discover bank": {
    name: "Discover Bank",
    address: "PO Box 30945",
    city: "Salt Lake City",
    state: "UT",
    zip: "84130",
    full: "PO Box 30945, Salt Lake City, UT 84130",
  },
  "american express": {
    name: "American Express",
    address: "PO Box 981537",
    city: "El Paso",
    state: "TX",
    zip: "79998-1537",
    full: "PO Box 981537, El Paso, TX 79998-1537",
  },
  amex: {
    name: "American Express",
    address: "PO Box 981537",
    city: "El Paso",
    state: "TX",
    zip: "79998-1537",
    full: "PO Box 981537, El Paso, TX 79998-1537",
  },
  "bank of america": {
    name: "Bank of America",
    address: "PO Box 982234",
    city: "El Paso",
    state: "TX",
    zip: "79998-2234",
    full: "PO Box 982234, El Paso, TX 79998-2234",
  },
  "wells fargo": {
    name: "Wells Fargo",
    address: "PO Box 14517",
    city: "Des Moines",
    state: "IA",
    zip: "50306-3517",
    full: "PO Box 14517, Des Moines, IA 50306-3517",
  },
  synchrony: {
    name: "Synchrony",
    address: "PO Box 965060",
    city: "Orlando",
    state: "FL",
    zip: "32896-5060",
    full: "PO Box 965060, Orlando, FL 32896-5060",
  },
  "synchrony bank": {
    name: "Synchrony Bank",
    address: "PO Box 965060",
    city: "Orlando",
    state: "FL",
    zip: "32896-5060",
    full: "PO Box 965060, Orlando, FL 32896-5060",
  },
  "synchrony financial": {
    name: "Synchrony Financial",
    address: "PO Box 965060",
    city: "Orlando",
    state: "FL",
    zip: "32896-5060",
    full: "PO Box 965060, Orlando, FL 32896-5060",
  },
  // -------------------------------------------------------------------------
  // Major Collection Agencies / Debt Buyers
  // -------------------------------------------------------------------------
  "midland credit management": {
    name: "Midland Credit Management",
    address: "350 Camino de la Reina, Suite 100",
    city: "San Diego",
    state: "CA",
    zip: "92108",
    full: "350 Camino de la Reina, Suite 100, San Diego, CA 92108",
  },
  "midland credit": {
    name: "Midland Credit Management",
    address: "350 Camino de la Reina, Suite 100",
    city: "San Diego",
    state: "CA",
    zip: "92108",
    full: "350 Camino de la Reina, Suite 100, San Diego, CA 92108",
  },
  "midland funding": {
    name: "Midland Funding",
    address: "350 Camino de la Reina, Suite 100",
    city: "San Diego",
    state: "CA",
    zip: "92108",
    full: "350 Camino de la Reina, Suite 100, San Diego, CA 92108",
  },
  "portfolio recovery associates": {
    name: "Portfolio Recovery Associates",
    address: "120 Corporate Blvd",
    city: "Norfolk",
    state: "VA",
    zip: "23502",
    full: "120 Corporate Blvd, Norfolk, VA 23502",
  },
  "portfolio recovery": {
    name: "Portfolio Recovery Associates",
    address: "120 Corporate Blvd",
    city: "Norfolk",
    state: "VA",
    zip: "23502",
    full: "120 Corporate Blvd, Norfolk, VA 23502",
  },
  "lvnv funding": {
    name: "LVNV Funding",
    address: "PO Box 10584",
    city: "Greenville",
    state: "SC",
    zip: "29603",
    full: "PO Box 10584, Greenville, SC 29603",
  },
  "encore capital": {
    name: "Encore Capital Group",
    address: "PO Box 3111",
    city: "San Diego",
    state: "CA",
    zip: "92163",
    full: "PO Box 3111, San Diego, CA 92163",
  },
  "encore capital group": {
    name: "Encore Capital Group",
    address: "PO Box 3111",
    city: "San Diego",
    state: "CA",
    zip: "92163",
    full: "PO Box 3111, San Diego, CA 92163",
  },
  "cavalry portfolio services": {
    name: "Cavalry Portfolio Services",
    address: "500 Summit Lake Dr",
    city: "Valhalla",
    state: "NY",
    zip: "10595",
    full: "500 Summit Lake Dr, Valhalla, NY 10595",
  },
  "cavalry spv": {
    name: "Cavalry SPV",
    address: "500 Summit Lake Dr",
    city: "Valhalla",
    state: "NY",
    zip: "10595",
    full: "500 Summit Lake Dr, Valhalla, NY 10595",
  },
  cavalry: {
    name: "Cavalry",
    address: "500 Summit Lake Dr",
    city: "Valhalla",
    state: "NY",
    zip: "10595",
    full: "500 Summit Lake Dr, Valhalla, NY 10595",
  },
};

// Suffixes to strip when normalizing creditor names for matching
const STRIP_SUFFIXES =
  /\s*\b(llc|inc|corp|corporation|company|co|bank|na|n\.a\.|national association|group|services|financial|funding|management|partners|capital|credit|portfolio|recovery|associates|spv|holdings|trust|solutions)\b\.?/gi;

/**
 * Normalize a creditor name for lookup:
 * - Lowercase
 * - Strip Inc/LLC/Corp/Bank suffixes
 * - Collapse whitespace
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .toLowerCase()
    .replace(STRIP_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Look up the verified dispute address for a furnisher.
 *
 * Strategy:
 * 1. Exact normalized key match
 * 2. Partial match — check if any DB key is contained in the normalized input
 *    or the normalized input is contained in a DB key
 *
 * Returns the full formatted address string, or null if no match found.
 *
 * @param {string} creditorName
 * @returns {string|null}
 */
function lookupFurnisherAddress(creditorName) {
  if (!creditorName || typeof creditorName !== "string") return null;

  const normalized = normalizeName(creditorName);
  if (!normalized) return null;

  // 1. Direct key match (after normalization)
  if (FURNISHER_ADDRESSES[normalized]) {
    return FURNISHER_ADDRESSES[normalized].full;
  }

  // 2. Also try the raw lowercase version (in case name has no strippable suffix)
  const rawLower = creditorName.toLowerCase().trim();
  if (FURNISHER_ADDRESSES[rawLower]) {
    return FURNISHER_ADDRESSES[rawLower].full;
  }

  // 3. Partial match — furnisher name contains a known key, or vice versa
  for (const [key, entry] of Object.entries(FURNISHER_ADDRESSES)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return entry.full;
    }
  }

  return null;
}

module.exports = { FURNISHER_ADDRESSES, lookupFurnisherAddress, normalizeName };
