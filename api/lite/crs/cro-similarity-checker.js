"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CRO_SIMILARITY_THRESHOLD = 0.75;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize text: lowercase, strip non-alphanumeric chars (keep spaces),
 * collapse runs of whitespace into a single space, trim.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split normalized text into sentences. Splits on ". ", ".\n", "? ", "! ".
 * Filters out empty strings produced by consecutive delimiters.
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return text.split(/\.\s+|\.\n|\?\s+|!\s+/).filter(s => s.length > 0);
}

/**
 * Generate all consecutive word trigrams from a sentence.
 * Returns an empty array for sentences with fewer than 3 words.
 * @param {string} sentence
 * @returns {string[]}
 */
function trigramsFromSentence(sentence) {
  const words = sentence.split(" ").filter(w => w.length > 0);
  if (words.length < 3) return [];
  const trigrams = [];
  for (let i = 0; i <= words.length - 3; i++) {
    trigrams.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  return trigrams;
}

/**
 * Build a Set of trigrams for a block of text.
 * Normalizes → splits sentences → generates trigrams from each sentence.
 * @param {string} text
 * @returns {Set<string>}
 */
function buildTrigramSet(text) {
  const normed = normalize(text);
  const sentences = splitSentences(normed);
  const set = new Set();
  for (const sentence of sentences) {
    for (const trigram of trigramsFromSentence(sentence)) {
      set.add(trigram);
    }
  }
  return set;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Compute raw Jaccard similarity between two texts using sentence-level trigrams.
 *
 * Jaccard = |intersection| / |union|
 * Returns 0 when either input is missing or produces no trigrams.
 *
 * @param {string} textA
 * @param {string} textB
 * @returns {number} — value in [0, 1]
 */
function computeJaccardSimilarity(textA, textB) {
  if (!textA || !textB || typeof textA !== "string" || typeof textB !== "string") {
    return 0;
  }

  const setA = buildTrigramSet(textA);
  const setB = buildTrigramSet(textB);

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersectionSize = 0;
  // Iterate the smaller set for O(min(|A|,|B|)) intersection
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const trigram of smaller) {
    if (larger.has(trigram)) intersectionSize++;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Check whether a newly generated dispute letter is too similar to any letter
 * already produced in the same batch.
 *
 * Uses Jaccard similarity over sentence-level trigrams. If any pair exceeds
 * CRO_SIMILARITY_THRESHOLD (0.75), the letter is flagged as templated — which
 * gives furnishers grounds to legally ignore it under 12 CFR 1022.43.
 *
 * @param {string}   newLetter     — The newly generated letter text
 * @param {string[]} recentLetters — Previously generated letters in the same batch
 * @returns {{ similar: boolean, score: number, matchedIndex: number|null }}
 */
function checkCROSimilarity(newLetter, recentLetters) {
  const empty = { similar: false, score: 0, matchedIndex: null };

  if (!newLetter || typeof newLetter !== "string") return empty;
  if (!Array.isArray(recentLetters) || recentLetters.length === 0) return empty;

  let highestScore = 0;
  let matchedIndex = null;

  for (let i = 0; i < recentLetters.length; i++) {
    const candidate = recentLetters[i];
    if (!candidate || typeof candidate !== "string") continue;

    const score = computeJaccardSimilarity(newLetter, candidate);

    if (score > highestScore) {
      highestScore = score;
      matchedIndex = i;
    }
  }

  if (highestScore > CRO_SIMILARITY_THRESHOLD) {
    return { similar: true, score: highestScore, matchedIndex };
  }

  // matchedIndex is null when no comparisons ran (all candidates invalid);
  // otherwise keep the index of the closest letter even though it didn't
  // exceed the threshold — callers may want it for logging.
  return {
    similar: false,
    score: highestScore,
    matchedIndex: highestScore > 0 ? matchedIndex : null
  };
}

module.exports = {
  checkCROSimilarity,
  computeJaccardSimilarity,
  CRO_SIMILARITY_THRESHOLD
};
