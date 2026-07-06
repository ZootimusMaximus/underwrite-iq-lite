"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeJaccardSimilarity,
  checkCROSimilarity,
  CRO_SIMILARITY_THRESHOLD
} = require("../crs/cro-similarity-checker");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A realistic dispute letter with distinct sentences about a Capital One account.
const LETTER_A = `
I am writing to dispute an inaccuracy on my credit report regarding my Capital One account.
The balance reported is incorrect and does not reflect my actual payment history.
I have enclosed supporting documentation showing that the account was paid in full.
This error is causing significant harm to my credit standing.
I request that you investigate this matter and correct the balance immediately.
The late payment notation is inaccurate and should be removed from my record.
Please provide a written response confirming the deletion of this item.
`;

// A different letter about a Midland Funding collection account.
const LETTER_B = `
I am disputing the collection account listed under Midland Funding on my report.
This debt is time-barred under the applicable statute of limitations for my state.
The date of first delinquency shown is incorrect and has been re-aged improperly.
I have attached evidence from my original creditor showing the true origination date.
Reporting this account beyond the seven-year window violates the Fair Credit Reporting Act.
I demand immediate deletion and written confirmation within thirty days.
`;

// Very similar to LETTER_A — same core text with just one extra closing sentence.
// Appending a short sentence still keeps the majority of trigrams shared,
// yielding Jaccard > 0.75 (measured: ~0.89).
const LETTER_A_NEAR_COPY =
  LETTER_A.trim() + "\nThank you for your attention to this important matter.";

// Very short texts — fewer than 3 words per sentence — produce no trigrams.
const SHORT_TEXT_A = "Hello world.";
const SHORT_TEXT_B = "Hi there.";

// Texts with punctuation differences only (no alphanumeric changes).
const PUNCTUATED = "The balance is incorrect; please correct it now.";
const SAME_NO_PUNCT = "The balance is incorrect please correct it now";

// ---------------------------------------------------------------------------
// computeJaccardSimilarity
// ---------------------------------------------------------------------------

test("computeJaccardSimilarity: identical texts → score close to 1.0", () => {
  const score = computeJaccardSimilarity(LETTER_A, LETTER_A);
  assert.ok(score >= 0.99, `expected ≥ 0.99, got ${score}`);
});

test("computeJaccardSimilarity: completely different texts → score close to 0.0", () => {
  const score = computeJaccardSimilarity(LETTER_A, LETTER_B);
  assert.ok(score < 0.3, `expected < 0.3, got ${score}`);
});

test("computeJaccardSimilarity: near-copy texts → score between 0 and 1", () => {
  const score = computeJaccardSimilarity(LETTER_A, LETTER_A_NEAR_COPY);
  assert.ok(score > 0.0 && score <= 1.0, `expected in (0, 1], got ${score}`);
});

test("computeJaccardSimilarity: empty string inputs → 0", () => {
  assert.equal(computeJaccardSimilarity("", ""), 0);
  assert.equal(computeJaccardSimilarity("", LETTER_A), 0);
  assert.equal(computeJaccardSimilarity(LETTER_A, ""), 0);
});

test("computeJaccardSimilarity: null inputs → 0", () => {
  assert.equal(computeJaccardSimilarity(null, null), 0);
  assert.equal(computeJaccardSimilarity(null, LETTER_A), 0);
  assert.equal(computeJaccardSimilarity(LETTER_A, null), 0);
});

test("computeJaccardSimilarity: undefined inputs → 0", () => {
  assert.equal(computeJaccardSimilarity(undefined, undefined), 0);
  assert.equal(computeJaccardSimilarity(undefined, LETTER_A), 0);
});

test("computeJaccardSimilarity: very short texts produce no trigrams → 0", () => {
  // Texts with fewer than 3 words per sentence yield empty trigram sets → 0
  const score = computeJaccardSimilarity(SHORT_TEXT_A, SHORT_TEXT_B);
  assert.equal(score, 0);
});

test("computeJaccardSimilarity: texts with only punctuation differences → same score as clean versions", () => {
  // After normalization punctuation becomes spaces, so both texts should produce
  // the same trigrams and yield a score of 1.
  const score = computeJaccardSimilarity(PUNCTUATED, SAME_NO_PUNCT);
  assert.ok(score > 0.9, `expected > 0.9, got ${score}`);
});

test("computeJaccardSimilarity: returns value in [0, 1]", () => {
  const score = computeJaccardSimilarity(LETTER_A, LETTER_B);
  assert.ok(score >= 0 && score <= 1, `out-of-range: ${score}`);
});

// ---------------------------------------------------------------------------
// checkCROSimilarity
// ---------------------------------------------------------------------------

test("checkCROSimilarity: new letter similar to one in batch → similar: true, score > threshold, matchedIndex is a number", () => {
  const result = checkCROSimilarity(LETTER_A_NEAR_COPY, [LETTER_A]);
  assert.equal(result.similar, true, "expected similar: true");
  assert.ok(
    result.score > CRO_SIMILARITY_THRESHOLD,
    `score ${result.score} should exceed threshold ${CRO_SIMILARITY_THRESHOLD}`
  );
  assert.equal(typeof result.matchedIndex, "number");
  assert.equal(result.matchedIndex, 0);
});

test("checkCROSimilarity: new letter different from all in batch → similar: false", () => {
  const result = checkCROSimilarity(LETTER_B, [LETTER_A]);
  assert.equal(result.similar, false);
});

test("checkCROSimilarity: empty recentLetters array → similar: false, score: 0", () => {
  const result = checkCROSimilarity(LETTER_A, []);
  assert.equal(result.similar, false);
  assert.equal(result.score, 0);
  assert.equal(result.matchedIndex, null);
});

test("checkCROSimilarity: null newLetter → similar: false", () => {
  const result = checkCROSimilarity(null, [LETTER_A]);
  assert.equal(result.similar, false);
  assert.equal(result.score, 0);
});

test("checkCROSimilarity: undefined newLetter → similar: false", () => {
  const result = checkCROSimilarity(undefined, [LETTER_A]);
  assert.equal(result.similar, false);
});

test("checkCROSimilarity: single letter in batch that is very similar → triggers similarity flag", () => {
  const result = checkCROSimilarity(LETTER_A_NEAR_COPY, [LETTER_A]);
  assert.equal(result.similar, true);
  assert.ok(result.score > 0.75);
});

test("checkCROSimilarity: multiple letters in batch, one similar → returns correct matchedIndex", () => {
  // LETTER_B is at index 0, LETTER_A is at index 1 — the near-copy should match index 1
  const result = checkCROSimilarity(LETTER_A_NEAR_COPY, [LETTER_B, LETTER_A]);
  assert.equal(result.similar, true);
  assert.equal(result.matchedIndex, 1, "should match LETTER_A at index 1");
});

test("checkCROSimilarity: non-array recentLetters → similar: false", () => {
  const result = checkCROSimilarity(LETTER_A, "not-an-array");
  assert.equal(result.similar, false);
});

test("checkCROSimilarity: batch with null/invalid entries → skips them gracefully", () => {
  const result = checkCROSimilarity(LETTER_A, [null, undefined, 42]);
  assert.equal(result.similar, false);
  assert.equal(result.score, 0);
});

test("checkCROSimilarity: identical new letter to batch entry → score of 1.0 exceeds threshold", () => {
  const result = checkCROSimilarity(LETTER_A, [LETTER_A]);
  assert.equal(result.similar, true);
  assert.ok(result.score >= 0.99);
  assert.equal(result.matchedIndex, 0);
});

test("checkCROSimilarity: result has similar, score, matchedIndex fields", () => {
  const result = checkCROSimilarity(LETTER_B, [LETTER_A]);
  assert.ok("similar" in result, "missing: similar");
  assert.ok("score" in result, "missing: score");
  assert.ok("matchedIndex" in result, "missing: matchedIndex");
});

// ---------------------------------------------------------------------------
// CRO_SIMILARITY_THRESHOLD constant
// ---------------------------------------------------------------------------

test("CRO_SIMILARITY_THRESHOLD is exported and equals 0.75", () => {
  assert.equal(typeof CRO_SIMILARITY_THRESHOLD, "number");
  assert.equal(CRO_SIMILARITY_THRESHOLD, 0.75);
});
