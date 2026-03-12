"use strict";

/**
 * build-crm-payload.js — Stage 11: CRM Payload Builder
 *
 * Assembles all module outputs into a GHL-compatible payload.
 */

const REDIRECT_PATHS = {
  FRAUD_HOLD: null,
  MANUAL_REVIEW: null,
  REPAIR: "repair",
  CONDITIONAL_APPROVAL: "funding",
  FULL_STACK_APPROVAL: "funding",
  PREMIUM_STACK: "funding"
};

/**
 * buildCrmPayload(options)
 *
 * @param {Object} options
 * @param {Object} options.normalized - Module 1 output
 * @param {Object} options.consumerSignals - Module 2 output
 * @param {Object} options.businessSignals - Module 3 output
 * @param {Object} options.outcomeResult - Module 5 output
 * @param {Object} options.preapprovals - Module 6 output
 * @param {string[]} options.cards - Module 9 output
 * @param {Object} options.documents - Module 10 output
 * @param {Array} [options.suggestions] - Module 8 output
 * @param {Object} options.formData - Original form submission { email, phone, name, companyName, ref }
 * @returns {Object} CRM payload
 */
function buildCrmPayload(options) {
  const {
    normalized,
    consumerSignals,
    businessSignals,
    outcomeResult,
    preapprovals,
    cards,
    documents,
    suggestions,
    formData
  } = options;
  const cs = consumerSignals;
  const outcome = outcomeResult.outcome;
  const path = REDIRECT_PATHS[outcome] || null;

  // Result type mapping
  const resultType = path === "funding" ? "funding" : path === "repair" ? "repair" : "hold";

  // Suggestion summary (first 3 top moves, plain text)
  const topMoves = suggestions?.topMoves || suggestions?.flatList || [];
  const suggestionSummary =
    (Array.isArray(topMoves) ? topMoves : [])
      .slice(0, 3)
      .map(s => s.title || s.problem || s.code || "")
      .filter(Boolean)
      .join("; ") || null;

  return {
    contact: {
      email: formData?.email || null,
      phone: formData?.phone || null,
      name: formData?.name || null,
      companyName: formData?.companyName || null
    },
    refId: formData?.ref || null,
    resultType,
    outcome,
    scores: {
      tu: cs.scores.perBureau.tu,
      ex: cs.scores.perBureau.ex,
      eq: cs.scores.perBureau.eq,
      median: cs.scores.median
    },
    preapprovals: {
      personalCard: preapprovals.personalCard.final,
      personalLoan: preapprovals.personalLoan.final,
      business: preapprovals.business.final,
      total: preapprovals.totalCombined
    },
    tags: cards,
    reasonCodes: outcomeResult.reasonCodes,
    letterStatus: documents.letters.length > 0 ? "pending" : "none",
    redirect: {
      url: path ? `${path === "funding" ? "funding-approved" : "fix-my-credit"}` : null,
      path
    },
    suggestionSummary,
    customFields: {
      analyzer_path: path || "hold",
      analyzer_status: "complete",
      credit_score: cs.scores.median,
      total_funding_estimate: preapprovals.totalCombined,
      outcome_tier: outcome,
      bureau_count: normalized.meta.bureauCount,
      utilization_pct: cs.utilization.pct,
      business_available: businessSignals?.available || false,
      letters_ready: "false" // Updated to 'true' after letter-delivery.js runs
    }
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildCrmPayload, REDIRECT_PATHS };
