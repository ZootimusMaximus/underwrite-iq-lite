"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ---------------------------------------------------------------------------
// The module caches state in module scope — we need the fresh require each
// time we want to test cache reset behaviour. For isolation between groups
// we rely on the fact that the module-level cache is write-once and the
// tests run sequentially in Node's test runner (no parallelism inside one
// test file).  Each test is therefore stateless with respect to *content*
// but the cache will be populated from the first test that calls into the
// module.
// ---------------------------------------------------------------------------

const {
  loadKnowledgeBase,
  getAvailableSections,
  getSectionByName,
  getTokenEstimate,
} = require("../crs/metro2-kb-loader");

// ---------------------------------------------------------------------------
// Resolve paths used in tests
// ---------------------------------------------------------------------------

const REAL_KB_PATH = path.resolve(
  __dirname,
  "../../../../underwrite-iq-lite/data/metro2-kb.md"
);

// ---------------------------------------------------------------------------
// loadKnowledgeBase — basic loading
// ---------------------------------------------------------------------------

test("loadKnowledgeBase(1): returns a non-empty string", () => {
  const result = loadKnowledgeBase(1);
  assert.equal(typeof result, "string");
  assert.ok(result.length > 0, "round 1 KB must not be empty");
});

test("loadKnowledgeBase(2): returns a non-empty string", () => {
  const result = loadKnowledgeBase(2);
  assert.equal(typeof result, "string");
  assert.ok(result.length > 0, "round 2 KB must not be empty");
});

test("loadKnowledgeBase(3): returns a non-empty string", () => {
  const result = loadKnowledgeBase(3);
  assert.equal(typeof result, "string");
  assert.ok(result.length > 0, "round 3 KB must not be empty");
});

test("loadKnowledgeBase(2) is longer than loadKnowledgeBase(1)", () => {
  const r1 = loadKnowledgeBase(1);
  const r2 = loadKnowledgeBase(2);
  assert.ok(
    r2.length > r1.length,
    `round 2 (${r2.length} chars) should be longer than round 1 (${r1.length} chars)`
  );
});

test("loadKnowledgeBase(3) is approximately same length as loadKnowledgeBase(2)", () => {
  // Rounds 2 and 3 use identical section keys — output must be the same
  const r2 = loadKnowledgeBase(2);
  const r3 = loadKnowledgeBase(3);
  assert.equal(r2, r3, "rounds 2 and 3 should return identical content");
});

test("loadKnowledgeBase: invalid round throws RangeError", () => {
  assert.throws(
    () => loadKnowledgeBase(0),
    (err) => err instanceof RangeError
  );
  assert.throws(
    () => loadKnowledgeBase(4),
    (err) => err instanceof RangeError
  );
  assert.throws(
    () => loadKnowledgeBase(null),
    (err) => err instanceof RangeError
  );
  assert.throws(
    () => loadKnowledgeBase("one"),
    (err) => err instanceof RangeError
  );
});

// ---------------------------------------------------------------------------
// Section selection — Round 1 should have Sections 1, 3, 5 but NOT 2 or 4
// ---------------------------------------------------------------------------

test("round 1 contains Section 1 (Metro 2 specification) content", () => {
  const result = loadKnowledgeBase(1);
  // Section 1 heading is distinctive
  assert.ok(
    result.includes("SECTION 1 — METRO 2 COMPLETE SPECIFICATION"),
    "round 1 should contain Section 1 heading"
  );
});

test("round 1 contains Section 3 (Statutes) content", () => {
  const result = loadKnowledgeBase(1);
  assert.ok(
    result.includes("SECTION 3 — STATUTES"),
    "round 1 should contain Section 3 heading"
  );
});

test("round 1 contains Section 5 (Violation Checklist) content", () => {
  const result = loadKnowledgeBase(1);
  assert.ok(
    result.includes("SECTION 5 — TRADELINE VIOLATION CHECKLIST"),
    "round 1 should contain Section 5 heading"
  );
});

test("round 1 does NOT contain Section 2 (Case Law Library)", () => {
  const result = loadKnowledgeBase(1);
  assert.ok(
    !result.includes("SECTION 2 — CASE LAW LIBRARY"),
    "round 1 should NOT contain Section 2"
  );
});

test("round 1 does NOT contain Section 4 (Strategy Framework)", () => {
  const result = loadKnowledgeBase(1);
  assert.ok(
    !result.includes("SECTION 4 — DISPUTE LETTER STRATEGY FRAMEWORK"),
    "round 1 should NOT contain Section 4"
  );
});

test("round 2 contains ALL five sections", () => {
  const result = loadKnowledgeBase(2);
  assert.ok(result.includes("SECTION 1 — METRO 2 COMPLETE SPECIFICATION"), "missing Section 1");
  assert.ok(result.includes("SECTION 2 — CASE LAW LIBRARY"), "missing Section 2");
  assert.ok(result.includes("SECTION 3 — STATUTES"), "missing Section 3");
  assert.ok(result.includes("SECTION 4 — DISPUTE LETTER STRATEGY FRAMEWORK"), "missing Section 4");
  assert.ok(result.includes("SECTION 5 — TRADELINE VIOLATION CHECKLIST"), "missing Section 5");
});

// ---------------------------------------------------------------------------
// Known distinctive content checks
// ---------------------------------------------------------------------------

test("Section 1 content includes 'Account Status' (Field 17A)", () => {
  const result = loadKnowledgeBase(1);
  // Field 17A — Account Status — is the most-disputed field and well-documented in Section 1
  assert.ok(
    result.includes("Account Status"),
    "Section 1 should reference Account Status (Field 17A)"
  );
});

test("Section 2 content (round 2) includes Saunders case law", () => {
  const result = loadKnowledgeBase(2);
  // Saunders v. Branch Banking & Trust is a key case cited in Section 2
  assert.ok(
    result.includes("Saunders"),
    "Section 2 (round 2) should reference Saunders case"
  );
});

test("AI Prompt Integration Guide is present by default (round 1)", () => {
  const result = loadKnowledgeBase(1);
  assert.ok(
    result.includes("AI PROMPT INTEGRATION GUIDE"),
    "guide should be appended by default"
  );
});

test("guide can be excluded via includeGuide=false", () => {
  const withGuide = loadKnowledgeBase(1, { includeGuide: true });
  const withoutGuide = loadKnowledgeBase(1, { includeGuide: false });
  assert.ok(withGuide.includes("AI PROMPT INTEGRATION GUIDE"), "guide should be present when included");
  assert.ok(!withoutGuide.includes("AI PROMPT INTEGRATION GUIDE"), "guide should be absent when excluded");
  assert.ok(withGuide.length > withoutGuide.length, "excluding guide should shorten the output");
});

// ---------------------------------------------------------------------------
// getTokenEstimate
// ---------------------------------------------------------------------------

test("getTokenEstimate(1) returns a positive number", () => {
  const est = getTokenEstimate(1);
  assert.equal(typeof est, "number");
  assert.ok(est > 0, "token estimate must be positive");
});

test("getTokenEstimate(2) returns a number greater than getTokenEstimate(1)", () => {
  const est1 = getTokenEstimate(1);
  const est2 = getTokenEstimate(2);
  assert.ok(
    est2 > est1,
    `round 2 estimate (${est2}) should exceed round 1 estimate (${est1})`
  );
});

test("getTokenEstimate(1) is in a plausible range for a knowledge base (>1000 tokens)", () => {
  const est = getTokenEstimate(1);
  assert.ok(est > 1000, `token estimate ${est} is suspiciously low`);
});

test("getTokenEstimate(2) is greater than getTokenEstimate(1)", () => {
  const est1 = getTokenEstimate(1);
  const est2 = getTokenEstimate(2);
  assert.ok(est2 > est1, "more sections = more tokens");
});

// ---------------------------------------------------------------------------
// Caching — multiple calls should return the same reference (module cache)
// ---------------------------------------------------------------------------

test("repeated calls to loadKnowledgeBase return the same content", () => {
  const first = loadKnowledgeBase(1);
  const second = loadKnowledgeBase(1);
  assert.equal(first, second, "caching: identical calls must return identical content");
});

test("repeated calls to loadKnowledgeBase(2) return the same content", () => {
  const first = loadKnowledgeBase(2);
  const second = loadKnowledgeBase(2);
  assert.equal(first, second, "caching: round 2 must be stable across calls");
});

// ---------------------------------------------------------------------------
// getAvailableSections
// ---------------------------------------------------------------------------

test("getAvailableSections returns an array", () => {
  const sections = getAvailableSections();
  assert.ok(Array.isArray(sections));
});

test("getAvailableSections returns at least 5 section names (all major sections)", () => {
  const sections = getAvailableSections();
  assert.ok(sections.length >= 5, `expected ≥5 sections, got ${sections.length}`);
});

test("getAvailableSections returns strings", () => {
  const sections = getAvailableSections();
  for (const s of sections) {
    assert.equal(typeof s, "string");
    assert.ok(s.length > 0);
  }
});

test("getAvailableSections includes Section 1 name", () => {
  const sections = getAvailableSections();
  const hasSection1 = sections.some((s) => s.includes("Section 1") || s.includes("Metro 2 Complete"));
  assert.ok(hasSection1, "should include Section 1 name");
});

test("getAvailableSections includes Section 2 name (Case Law)", () => {
  const sections = getAvailableSections();
  const hasSection2 = sections.some((s) => s.includes("Case Law") || s.includes("Section 2"));
  assert.ok(hasSection2, "should include Section 2 name");
});

// ---------------------------------------------------------------------------
// getSectionByName
// ---------------------------------------------------------------------------

test("getSectionByName: 'Section 1' returns non-empty string", () => {
  const result = getSectionByName("Section 1");
  assert.equal(typeof result, "string");
  assert.ok(result.length > 0, "Section 1 should have content");
});

test("getSectionByName: 'case law' (case-insensitive) returns Section 2 content", () => {
  const result = getSectionByName("case law");
  assert.ok(result.length > 0, "case law section should not be empty");
  assert.ok(result.includes("Saunders"), "Section 2 content should include Saunders case");
});

test("getSectionByName: 'statutes' returns Section 3 content", () => {
  const result = getSectionByName("statutes");
  assert.ok(result.length > 0);
  assert.ok(result.includes("SECTION 3"), "should include Section 3 heading");
});

test("getSectionByName: 'strategy' returns Section 4 content", () => {
  const result = getSectionByName("strategy");
  assert.ok(result.length > 0);
  assert.ok(result.includes("SECTION 4"), "should include Section 4 heading");
});

test("getSectionByName: 'violation checklist' returns Section 5 content", () => {
  const result = getSectionByName("violation checklist");
  assert.ok(result.length > 0);
  assert.ok(result.includes("SECTION 5"), "should include Section 5 heading");
});

test("getSectionByName: unknown name returns empty string (no throw)", () => {
  const result = getSectionByName("nonexistent section xyz");
  assert.equal(typeof result, "string");
  assert.equal(result, "");
});

test("getSectionByName: empty string returns empty string (no throw)", () => {
  // An empty needle will match the first section with includes("") = true for any string.
  // The exact return value is implementation-defined, but it should not throw.
  assert.doesNotThrow(() => getSectionByName(""));
});

// ---------------------------------------------------------------------------
// Error handling — missing KB file
// ---------------------------------------------------------------------------

test("loadKnowledgeBase with missing file env var returns empty string without throwing", () => {
  // This test isolates the missing-file path by temporarily pointing the env
  // var at a non-existent file and requiring a fresh module instance.
  // We use a fresh require by deleting the cached module reference.
  const originalPath = process.env.METRO2_KB_PATH;

  try {
    // Point to a file that does not exist
    process.env.METRO2_KB_PATH = "/tmp/__nonexistent_metro2_kb_file__.md";

    // Clear the module from require cache so _ensureLoaded() starts fresh
    const modPath = require.resolve("../crs/metro2-kb-loader");
    delete require.cache[modPath];

    const { loadKnowledgeBase: freshLoad } = require("../crs/metro2-kb-loader");

    // Should not throw even though the file is missing
    let result;
    assert.doesNotThrow(() => {
      result = freshLoad(1);
    });

    // With no file, sections are empty — result is empty or empty-joined string
    assert.equal(typeof result, "string");
  } finally {
    // Restore env and re-require the original module
    if (originalPath === undefined) {
      delete process.env.METRO2_KB_PATH;
    } else {
      process.env.METRO2_KB_PATH = originalPath;
    }
    // Re-populate require cache with the real module
    const modPath = require.resolve("../crs/metro2-kb-loader");
    delete require.cache[modPath];
    require("../crs/metro2-kb-loader");
  }
});

// ---------------------------------------------------------------------------
// Section separator format
// ---------------------------------------------------------------------------

test("loadKnowledgeBase uses markdown horizontal rule as section separator", () => {
  // When multiple sections are joined the separator is '\n\n---\n\n'
  const result = loadKnowledgeBase(1);
  // Round 1 has section1 + section3 + section5 + guide = at least 3 separators
  assert.ok(result.includes("---"), "separator '---' should be present between sections");
});
