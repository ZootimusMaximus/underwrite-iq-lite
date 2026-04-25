'use strict';

/**
 * metro2-kb-loader.js
 *
 * Loads and caches the Metro 2 Master Knowledge Base.
 * Returns section combinations tuned to each dispute round's model + token budget:
 *
 *   Round 1  (Sonnet, ~10-12K tokens): Sections 1 + 3 + 5 + Guide
 *   Round 2  (Opus,   ~18-20K tokens): Sections 1-5 + Guide
 *   Round 3  (Opus,   ~18-20K tokens): Sections 1-5 + Guide
 *
 * File is read once, parsed into sections, then cached in module scope.
 * Safe for concurrent calls — module-level cache is write-once after first parse.
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_KB_PATH = path.resolve(
  __dirname,
  '../../../data/metro2-kb.md'
);

const KB_PATH = process.env.METRO2_KB_PATH || DEFAULT_KB_PATH;

// ~4 chars per token is a standard rough heuristic
const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Section definitions
// Each entry describes a logical section of the KB document.
// `header` is the exact top-level markdown heading that opens the section.
// ---------------------------------------------------------------------------

const SECTION_DEFS = [
  { key: 'quick_reference', name: 'Quick Reference',                          header: '## QUICK REFERENCE' },
  { key: 'section1',        name: 'Section 1 — Metro 2 Complete Specification', header: '# SECTION 1 — METRO 2 COMPLETE SPECIFICATION' },
  { key: 'section2',        name: 'Section 2 — Case Law Library',              header: '# SECTION 2 — CASE LAW LIBRARY' },
  { key: 'section3',        name: 'Section 3 — Statutes Full Text',            header: '# SECTION 3 — STATUTES (FULL TEXT)' },
  { key: 'section4',        name: 'Section 4 — Dispute Letter Strategy Framework', header: '# SECTION 4 — DISPUTE LETTER STRATEGY FRAMEWORK' },
  { key: 'section5',        name: 'Section 5 — Tradeline Violation Checklist', header: '# SECTION 5 — TRADELINE VIOLATION CHECKLIST' },
  { key: 'guide',           name: 'AI Prompt Integration Guide',               header: '# AI PROMPT INTEGRATION GUIDE' },
];

// Round → which section keys to include (guide always appended separately)
const ROUND_SECTIONS = {
  1: ['section1', 'section3', 'section5'],
  2: ['section1', 'section2', 'section3', 'section4', 'section5'],
  3: ['section1', 'section2', 'section3', 'section4', 'section5'],
};

// ---------------------------------------------------------------------------
// Module-level cache (populated on first call)
// ---------------------------------------------------------------------------

/** @type {Map<string, string> | null} */
let _sectionCache = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse the raw KB text into named sections using the markdown headers
 * defined in SECTION_DEFS.  Returns a Map<key, content>.
 *
 * Strategy: scan lines for header matches, record start positions, then
 * slice the raw text between consecutive start positions.
 *
 * @param {string} raw
 * @returns {Map<string, string>}
 */
function _parseSections(raw) {
  const lines = raw.split('\n');

  // Build an ordered list of { key, lineIndex } for each found header
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    for (const def of SECTION_DEFS) {
      // Match exact header (ignore surrounding whitespace / trailing text only if
      // the header is an *exact* line or the line starts with the header text).
      // The KB has headers exactly matching our defs.
      if (trimmed === def.header || trimmed.startsWith(def.header + ' ')) {
        found.push({ key: def.key, lineIndex: i });
        break;
      }
    }
  }

  const map = new Map();

  for (let fi = 0; fi < found.length; fi++) {
    const { key, lineIndex } = found[fi];
    const endLine = fi + 1 < found.length ? found[fi + 1].lineIndex : lines.length;
    const content = lines.slice(lineIndex, endLine).join('\n').trimEnd();
    map.set(key, content);
  }

  // Warn about any expected sections that were not found
  for (const def of SECTION_DEFS) {
    if (!map.has(def.key)) {
      console.warn(`[metro2-kb-loader] WARNING: section "${def.name}" not found in KB file.`);
    }
  }

  return map;
}

/**
 * Load and parse the KB file, populating _sectionCache.
 * If the file is missing, logs a warning and populates the cache with
 * empty strings so callers get a degraded-but-non-crashing result.
 */
function _ensureLoaded() {
  if (_sectionCache !== null) return; // already loaded

  let raw = '';

  try {
    raw = fs.readFileSync(KB_PATH, 'utf8');
  } catch (err) {
    console.warn(
      `[metro2-kb-loader] WARNING: KB file not found at "${KB_PATH}". ` +
      `Dispute letters will be generated without the Metro 2 knowledge base. ` +
      `Error: ${err.message}`
    );
    // Populate cache with empty strings for all known sections so the
    // rest of the module behaves consistently.
    _sectionCache = new Map();
    for (const def of SECTION_DEFS) {
      _sectionCache.set(def.key, '');
    }
    return;
  }

  _sectionCache = _parseSections(raw);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the KB sections appropriate for the given dispute round.
 *
 * @param {1|2|3} round - Dispute round number
 * @param {object} [options]
 * @param {boolean} [options.includeGuide=true] - Whether to append the AI Prompt Integration Guide
 * @param {string}  [options.tradelineType]     - Reserved for future conditional section loading
 * @returns {string} Concatenated KB sections for the round
 */
function loadKnowledgeBase(round, options = {}) {
  const { includeGuide = true } = options;

  _ensureLoaded();

  const sectionKeys = ROUND_SECTIONS[round];
  if (!sectionKeys) {
    throw new RangeError(
      `[metro2-kb-loader] Invalid round "${round}". Must be 1, 2, or 3.`
    );
  }

  const parts = [];

  for (const key of sectionKeys) {
    const content = _sectionCache.get(key);
    if (content) {
      parts.push(content);
    }
  }

  if (includeGuide) {
    const guide = _sectionCache.get('guide');
    if (guide) {
      parts.push(guide);
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Return an array of parsed section names from the cached KB.
 * Returns an empty array if the KB has not yet been loaded (lazy-loads it).
 *
 * @returns {string[]}
 */
function getAvailableSections() {
  _ensureLoaded();

  const names = [];
  for (const def of SECTION_DEFS) {
    if (_sectionCache.has(def.key) && _sectionCache.get(def.key).length > 0) {
      names.push(def.name);
    }
  }
  return names;
}

/**
 * Return a specific section by its human-readable name (case-insensitive match
 * against the beginning of the section name).
 * Returns an empty string if the section is not found.
 *
 * @param {string} name - Partial or full section name, e.g. "Section 1" or "Case Law"
 * @returns {string}
 */
function getSectionByName(name) {
  _ensureLoaded();

  const needle = name.toLowerCase();
  for (const def of SECTION_DEFS) {
    if (def.name.toLowerCase().includes(needle)) {
      return _sectionCache.get(def.key) || '';
    }
  }

  console.warn(`[metro2-kb-loader] getSectionByName: no section matched "${name}"`);
  return '';
}

/**
 * Rough token estimate for the KB content returned for a given round.
 * Uses the ~4 chars/token heuristic.
 *
 * @param {1|2|3} round
 * @returns {number}
 */
function getTokenEstimate(round) {
  const content = loadKnowledgeBase(round, { includeGuide: true });
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  loadKnowledgeBase,
  getAvailableSections,
  getSectionByName,
  getTokenEstimate,
};
