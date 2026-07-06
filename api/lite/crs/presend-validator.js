"use strict";

/**
 * presend-validator.js — Pre-Send Dispute Letter Compliance Validator
 *
 * Validates dispute letters against 8 compliance gates before they can
 * be sent. Any gate failure blocks the letter. Pure pattern matching on
 * generated text — no AI calls, no external dependencies, no throws.
 *
 * Usage:
 *   const { validatePreSend } = require("./presend-validator");
 *   const result = validatePreSend(letterText, context);
 *   // result: { valid: boolean, failures: Array<{ gate, name, reason }> }
 *
 * context shape:
 *   {
 *     violations: Array<{ code, field, statute, explanation }>,
 *     round: 1|2|3,
 *     furnisher: string,
 *     bureau: string,            // "experian"|"equifax"|"transunion"
 *     accountIdentifier: string|null,
 *     furnisherAddress: string|null,
 *     priorRoundText: string|null
 *   }
 *
 * All gates run regardless of earlier failures — all failures are returned.
 */

// ---------------------------------------------------------------------------
// Gate names registry
// ---------------------------------------------------------------------------

const GATE_NAMES = {
  1: "Dispute Subject Matter Covered",
  2: "Not an Excepted Dispute Type",
  3: "Furnisher Address Present",
  4: "Required Notice Elements",
  5: "CRO Safe Harbor (Consumer Voice)",
  6: "Not Frivolous or Duplicative",
  7: "Round 2/3 Contains New Information",
  8: "No Prohibited CROA Language"
};

// ---------------------------------------------------------------------------
// Gate 1: Dispute Subject Matter Covered (§ 1022.43(a))
// ---------------------------------------------------------------------------

const GATE1_CATEGORIES = [
  {
    keywords: ["balance", "credit limit", "amount"],
    label: "balance/credit limit"
  },
  {
    keywords: ["payment", "history", "late", "delinquent", "past due"],
    label: "payment/account history"
  },
  {
    keywords: [
      "status",
      "account status",
      "charged off",
      "charge-off",
      "collection",
      "open",
      "closed"
    ],
    label: "account status"
  },
  {
    keywords: ["terms", "interest", "rate", "fees"],
    label: "account terms"
  }
];

/**
 * @param {string} text
 * @param {object} _ctx  (unused — gate relies only on letter text)
 * @returns {{ pass: boolean, reason: string }}
 */
function checkGate1(text, _ctx) {
  const lower = text.toLowerCase();
  for (const category of GATE1_CATEGORIES) {
    for (const kw of category.keywords) {
      if (lower.includes(kw)) {
        return { pass: true, reason: "" };
      }
    }
  }
  return {
    pass: false,
    reason:
      "Letter does not reference any of the 4 valid dispute categories under § 1022.43(a): " +
      "balance/credit limit, payment history, account status, or account terms."
  };
}

// ---------------------------------------------------------------------------
// Gate 2: Not an Excepted Dispute Type (§ 1022.43(b)(1))
// ---------------------------------------------------------------------------

const EXCEPTED_CODE_PREFIXES = ["SSN_", "DECEASED_", "INQUIRY_"];

/**
 * @param {string} _text  (unused — gate relies on violations array)
 * @param {object} ctx
 * @returns {{ pass: boolean, reason: string }}
 */
function checkGate2(_text, ctx) {
  const violations = Array.isArray(ctx.violations) ? ctx.violations : [];

  // If there are no violations at all, this check is inconclusive — pass
  if (violations.length === 0) {
    return { pass: true, reason: "" };
  }

  const allExcepted = violations.every(v =>
    EXCEPTED_CODE_PREFIXES.some(prefix => String(v.code || "").startsWith(prefix))
  );

  if (allExcepted) {
    return {
      pass: false,
      reason:
        "All violations are about excepted categories (personal identifying information or inquiries) " +
        "that furnishers may legally ignore under § 1022.43(b)(1). At least one violation must concern account data."
    };
  }

  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Gate 3: Furnisher Address Present (Round 2/3 only)
// ---------------------------------------------------------------------------

// Matches a line like "123 Main St" followed eventually by a 2-letter state abbrev
const ADDRESS_BLOCK_RE = /\b\d{1,6}\s+\w[\w\s,.-]{3,}\b[A-Z]{2}\b/;

/**
 * @param {string} text
 * @param {object} ctx
 * @returns {{ pass: boolean, reason: string }}
 */
function checkGate3(text, ctx) {
  // Round 1 goes to bureaus — standard addresses, always pass
  if (ctx.round === 1) {
    return { pass: true, reason: "" };
  }

  if (ctx.furnisherAddress && ctx.furnisherAddress.trim().length > 0) {
    return { pass: true, reason: "" };
  }

  if (ADDRESS_BLOCK_RE.test(text)) {
    return { pass: true, reason: "" };
  }

  return {
    pass: false,
    reason:
      `Round ${ctx.round} letters are sent directly to the furnisher but no furnisher address was ` +
      "provided and no address block was detected in the letter text."
  };
}

// ---------------------------------------------------------------------------
// Gate 4: Required Notice Elements (§ 1022.43(d))
// ---------------------------------------------------------------------------

// Element 1: account identification
const ACCOUNT_ID_RE =
  /\baccount\b.*?\d{4,}|\d{4,}.*?\baccount\b|account\s+(?:number|#|no\.?|ending)/i;

// Element 3: basis for dispute
const DISPUTE_BASIS_RE = /\b(?:because|reason|inaccurate|incorrect|violation)\b/i;

// Element 4: supporting documentation reference
const DOCUMENTATION_RE = /\b(?:enclosed|attached|evidence|documentation|records)\b/i;

/**
 * @param {string} text
 * @param {object} ctx
 * @returns {{ pass: boolean, reason: string }}
 */
function checkGate4(text, ctx) {
  const missing = [];

  // Element 1 — account identification
  const hasAccountRef =
    ACCOUNT_ID_RE.test(text) ||
    (ctx.accountIdentifier &&
      text.toLowerCase().includes(String(ctx.accountIdentifier).toLowerCase()));

  if (!hasAccountRef) {
    missing.push("account identification (account number or reference)");
  }

  // Element 2 — specific information being disputed (not a blanket challenge)
  const BLANKET_DISPUTE_RE = /\b(?:dispute\s+(?:all|everything|all items|every item))\b/i;
  const hasSpecificInfo =
    !BLANKET_DISPUTE_RE.test(text) &&
    Array.isArray(ctx.violations) &&
    ctx.violations.some(v => v.field && text.toLowerCase().includes(v.field.toLowerCase()));

  if (!hasSpecificInfo) {
    missing.push(
      "specific information being disputed (must reference a concrete violation field, not a blanket challenge)"
    );
  }

  // Element 3 — basis for the dispute
  if (!DISPUTE_BASIS_RE.test(text)) {
    missing.push(
      "basis for the dispute (missing: 'because', 'reason', 'inaccurate', 'incorrect', or 'violation')"
    );
  }

  // Element 4 — supporting documentation reference
  if (!DOCUMENTATION_RE.test(text)) {
    missing.push(
      "supporting documentation reference (missing: 'enclosed', 'attached', 'evidence', 'documentation', or 'records')"
    );
  }

  if (missing.length > 0) {
    return {
      pass: false,
      reason:
        "Letter is missing required notice elements per § 1022.43(d): " + missing.join("; ") + "."
    };
  }

  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Gate 5: CRO Safe Harbor (Consumer Voice)
// ---------------------------------------------------------------------------

const CRO_FINGERPRINTS = [
  /\bon behalf of\b/i,
  /\bour client\b/i,
  /\bwe are writing\b/i,
  /\bour firm\b/i,
  /\bcredit repair\b/i,
  /\bcredit restoration\b/i,
  /\bwe request\b/i,
  /\bwe demand\b/i
];

// Overly legalistic openers (only flag at start of letter)
const LEGALISTIC_OPENER_RE = /^\s*(?:pursuant to|in accordance with|under the provisions of)\b/i;

const CONSUMER_VOICE_PATTERNS = [
  /\bi am writing\b/i,
  /\bmy account\b/i,
  /\bi dispute\b/i,
  /\bmy credit report\b/i
];

/**
 * Count occurrences of statute citation patterns (M4 check).
 * Looks for: §, USC, U.S.C., FCRA, FDCPA, CROA, CFR
 * @param {string} text
 * @returns {number} Total count of statute citation occurrences
 */
function countStatuteCitations(text) {
  const patterns = [
    /§/g, // Section symbol
    /\bUSC\b/gi, // US Code (word boundary)
    /U\.S\.C\./gi, // US Code (with dots)
    /\bFCRA\b/gi, // Fair Credit Reporting Act
    /\bFDCPA\b/gi, // Fair Debt Collection Practices Act
    /\bCROA\b/gi, // Credit Repair Organizations Act
    /\bCFR\b/gi // Code of Federal Regulations
  ];

  let totalCount = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      totalCount += matches.length;
    }
  }
  return totalCount;
}

/**
 * @param {string} text
 * @param {object} _ctx
 * @returns {{ pass: boolean, reason: string }}
 */
function checkGate5(text, _ctx) {
  // Check CRO fingerprints
  for (const re of CRO_FINGERPRINTS) {
    if (re.test(text)) {
      return {
        pass: false,
        reason:
          `Letter contains CRO-organization fingerprint pattern ("${re.source.replace(/\\b/g, "")}") ` +
          "that may make it appear to originate from a Credit Repair Organization rather than the consumer directly."
      };
    }
  }

  // Check legalistic opener
  if (LEGALISTIC_OPENER_RE.test(text)) {
    return {
      pass: false,
      reason:
        "Letter opens with overly legalistic language ('Pursuant to', 'In accordance with', or 'Under the provisions of') " +
        "that is a CRO fingerprint. Use first-person consumer voice instead."
    };
  }

  // M4: Check for excessive legal citations (>10 statute citation occurrences)
  const citationCount = countStatuteCitations(text);
  if (citationCount > 10) {
    return {
      pass: false,
      reason:
        `Excessive legal citations (${citationCount} occurrences, threshold is 10) — may trigger CRO classification. ` +
        "Cite only the most relevant statutes; avoid citing every applicable rule."
    };
  }

  // Must have at least one consumer voice indicator
  const hasConsumerVoice = CONSUMER_VOICE_PATTERNS.some(re => re.test(text));
  if (!hasConsumerVoice) {
    return {
      pass: false,
      reason:
        "Letter lacks first-person consumer voice. Must include at least one of: " +
        "'I am writing', 'my account', 'I dispute', 'my credit report'."
    };
  }

  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Gate 6: Not Frivolous or Duplicative
// ---------------------------------------------------------------------------

const FRIVOLOUS_PATTERNS = [
  /\bdispute\s+all\s+items\b/i,
  /\bdispute\s+everything\b/i,
  /\beverything\s+on\s+my\s+report\s+is\s+wrong\b/i,
  /\ball\s+items\s+(?:are|on my report are)\s+(?:inaccurate|incorrect|wrong)\b/i,
  /\bi\s+dispute\s+all\b/i
];

/**
 * @param {string} text
 * @param {object} ctx
 * @returns {{ pass: boolean, reason: string }}
 */
function checkGate6(text, ctx) {
  // Check for blanket/frivolous language
  for (const re of FRIVOLOUS_PATTERNS) {
    if (re.test(text)) {
      return {
        pass: false,
        reason:
          "Letter contains generic/blanket challenge language that qualifies as frivolous " +
          `("${re.source.replace(/\\b/g, "").replace(/\\s\+/g, " ")}"). ` +
          "Must reference specific account data."
      };
    }
  }

  // Must reference the furnisher by name
  const furnisher = String(ctx.furnisher || "").trim();
  if (!furnisher || !text.toLowerCase().includes(furnisher.toLowerCase())) {
    return {
      pass: false,
      reason:
        `Letter does not reference the furnisher name ("${furnisher || "unknown"}"). ` +
        "A dispute must be specific enough to identify the creditor being challenged."
    };
  }

  // Must reference at least one violation field
  const violations = Array.isArray(ctx.violations) ? ctx.violations : [];
  const hasFieldRef =
    violations.length > 0 &&
    violations.some(v => v.field && text.toLowerCase().includes(v.field.toLowerCase()));

  if (!hasFieldRef) {
    return {
      pass: false,
      reason:
        "Letter does not reference any specific violation field. " +
        "Include the exact data field being disputed (e.g., 'payment status', 'date of first delinquency')."
    };
  }

  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Gate 7: Round 2/3 Contains New Information
// ---------------------------------------------------------------------------

const ROUND2_NEW_INFO_PATTERNS = [
  /\bmethod of verification\b/i,
  /\bMOV\b/,
  /\bverify\b/i,
  /\binvestigation\b/i,
  /\bfailed to respond\b/i,
  /\bno response\b/i
];

const ROUND3_NEW_INFO_PATTERNS = [
  /\bwillful\b/i,
  /\bnoncompliance\b/i,
  /\bdamages\b/i,
  /\$100\b/,
  /\$1,000\b/,
  /\bCFPB\b/i,
  /\bAttorney\s+General\b/i,
  /\blegal\b/i
];

/**
 * Compute word-overlap similarity between two strings.
 * Returns a value between 0 (no overlap) and 1 (identical word sets).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function wordOverlapSimilarity(a, b) {
  const tokenize = s =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 2)
    );

  const setA = tokenize(a);
  const setB = tokenize(b);

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  // Jaccard similarity
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * @param {string} text
 * @param {object} ctx
 * @returns {{ pass: boolean, reason: string }}
 */
function checkGate7(text, ctx) {
  // Round 1 always passes
  if (ctx.round === 1) {
    return { pass: true, reason: "" };
  }

  const patterns = ctx.round === 2 ? ROUND2_NEW_INFO_PATTERNS : ROUND3_NEW_INFO_PATTERNS;
  const roundLabel = ctx.round === 2 ? "Round 2" : "Round 3";

  const hasNewInfoKeyword = patterns.some(re => re.test(text));
  if (!hasNewInfoKeyword) {
    const expected =
      ctx.round === 2
        ? "'method of verification', 'MOV', 'verify', 'investigation', 'failed to respond', or 'no response'"
        : "'willful', 'noncompliance', 'damages', '$100', '$1,000', 'CFPB', 'Attorney General', or 'legal'";
    return {
      pass: false,
      reason:
        `${roundLabel} letter must include new information not present in the prior round. ` +
        `Missing required keyword(s): ${expected}.`
    };
  }

  // If prior round text supplied, check for excessive similarity (>80%)
  if (ctx.priorRoundText && ctx.priorRoundText.trim().length > 0) {
    const similarity = wordOverlapSimilarity(text, ctx.priorRoundText);
    if (similarity > 0.8) {
      return {
        pass: false,
        reason:
          `${roundLabel} letter is too similar to the prior round (${Math.round(similarity * 100)}% word overlap — threshold is 80%). ` +
          "Add substantively new arguments, evidence, or escalation language."
      };
    }
  }

  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Gate 8: No Prohibited CROA Language
// ---------------------------------------------------------------------------

const CROA_PROHIBITED = [
  {
    re: /guarantee[sd]?\b[^.!?\n]{0,60}\b(?:removal|deletion)\b/i,
    label: "'guarantee' + 'removal/deletion' in same sentence"
  },
  {
    re: /\bwe will (?:remove|delete)\b/i,
    label: "'we will remove' or 'we will delete'"
  },
  {
    re: /\b100%\b[^.!?\n]{0,40}\b(?:success|removal|guaranteed)\b/i,
    label: "'100%' + 'success/removal/guaranteed'"
  },
  {
    re: /\bimprove your credit score\b/i,
    label: "'improve your credit score' (outcome promise)"
  },
  {
    re: /\b(?:guarantee[sd]?|guaranteed)\s+(?:results?|outcome)\b/i,
    label: "guaranteed results/outcome promise"
  },
  {
    re: /\b(?:raise|boost|increase)\s+your\s+(?:credit\s+)?score\b/i,
    label: "specific score improvement promise"
  }
];

/**
 * @param {string} text
 * @param {object} _ctx
 * @returns {{ pass: boolean, reason: string }}
 */
function checkGate8(text, _ctx) {
  for (const { re, label } of CROA_PROHIBITED) {
    if (re.test(text)) {
      return {
        pass: false,
        reason:
          `Letter contains language prohibited by the Credit Repair Organizations Act: ${label}. ` +
          "Remove all outcome guarantees and score improvement promises."
      };
    }
  }
  return { pass: true, reason: "" };
}

// ---------------------------------------------------------------------------
// Gate runner registry
// ---------------------------------------------------------------------------

const GATE_CHECKS = [
  checkGate1,
  checkGate2,
  checkGate3,
  checkGate4,
  checkGate5,
  checkGate6,
  checkGate7,
  checkGate8
];

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Validate a dispute letter against all 8 compliance gates.
 *
 * Runs every gate even if earlier gates fail.
 *
 * @param {string|null} letterText
 * @param {object} context
 * @param {Array}  context.violations
 * @param {1|2|3} context.round
 * @param {string} context.furnisher
 * @param {string} context.bureau
 * @param {string|null} context.accountIdentifier
 * @param {string|null} context.furnisherAddress
 * @param {string|null} context.priorRoundText
 * @returns {{ valid: boolean, failures: Array<{ gate: number, name: string, reason: string }> }}
 */
function validatePreSend(letterText, context) {
  // Defensive: null / empty letter text — all gates fail
  if (!letterText || typeof letterText !== "string" || letterText.trim() === "") {
    const failures = GATE_CHECKS.map((_, i) => ({
      gate: i + 1,
      name: GATE_NAMES[i + 1],
      reason: "Letter text is null or empty — cannot validate."
    }));
    return { valid: false, failures };
  }

  const ctx = context && typeof context === "object" ? context : {};

  const failures = [];

  GATE_CHECKS.forEach((checkFn, i) => {
    const gateNum = i + 1;
    let result;

    try {
      result = checkFn(letterText, ctx);
    } catch (err) {
      result = {
        pass: false,
        reason: `Gate ${gateNum} threw an unexpected error: ${err.message}`
      };
    }

    if (!result.pass) {
      failures.push({
        gate: gateNum,
        name: GATE_NAMES[gateNum],
        reason: result.reason
      });
    }
  });

  return {
    valid: failures.length === 0,
    failures
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  validatePreSend,
  checkGate1,
  checkGate2,
  checkGate3,
  checkGate4,
  checkGate5,
  checkGate6,
  checkGate7,
  checkGate8,
  GATE_NAMES
};
