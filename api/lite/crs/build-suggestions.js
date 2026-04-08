"use strict";

/**
 * build-suggestions.js — Stage 08: Suggestion Builder (v4)
 *
 * Takes optimization findings and organizes them into 4 prioritized layers.
 * topMoves capped at 5 for CRM compatibility.
 * Includes projected pre-approval when provided.
 * Includes getCTA(outcome) for outcome-specific call-to-action text.
 */

const LAYER_CONFIG = [
  {
    name: "Primary Blockers",
    severities: ["critical", "high"],
    description: "Fix these first before applying"
  },
  {
    name: "Next Best Moves",
    severities: ["medium"],
    description: "These will improve your approval odds"
  },
  {
    name: "Buildout Moves",
    severities: ["low"],
    description: "These will raise your limits over time"
  },
  {
    name: "Business Prep",
    categories: ["business"],
    description: "Prepare your business profile"
  }
];

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/**
 * getCTA(outcome) — Returns outcome-specific call-to-action text.
 *
 * @param {string} outcome
 * @returns {string}
 */
function getCTA(outcome) {
  switch (outcome) {
    case "PREMIUM_STACK":
      return "Your profile is in the top tier. Apply now to lock in maximum funding before anything changes.";
    case "FULL_FUNDING":
      return "You qualify for full funding. Start your application today while your file is in great shape.";
    case "FUNDING_PLUS_REPAIR":
      return "You have clean bureaus ready for funding now. Apply on those while we repair the rest in parallel.";
    case "REPAIR_ONLY":
      return "Your dispute letters are ready. Send them out — most clients see results in 30-90 days, then funding opens up.";
    case "MANUAL_REVIEW":
      return "Your file needs a manual review. Our team will reach out within 1 business day.";
    case "FRAUD_HOLD":
      return "Your application is on hold pending identity verification. Contact our team to resolve this quickly.";
    default:
      return "Review the suggestions above and contact our team to discuss next steps.";
  }
}

/**
 * buildSuggestions(findings, outcome, consumerSignals, businessSignals, projectedPreapproval)
 *
 * @returns {{ layers[], topMoves[], fullSuggestions[], flatList[], projectedPreapproval, cta }}
 */
function buildSuggestions(
  findings,
  outcome,
  _consumerSignals,
  _businessSignals,
  projectedPreapproval
) {
  const layers = LAYER_CONFIG.map(config => {
    let items;
    if (config.categories) {
      items = findings.filter(f => config.categories.includes(f.category)).map(mapFindingToItem);
    } else {
      items = findings
        .filter(f => config.severities.includes(f.severity) && f.category !== "business")
        .map(mapFindingToItem);
    }
    return { name: config.name, description: config.description, items };
  });

  // Top 5 items sorted by severity — capped at 5 for CRM compatibility
  const allItems = layers.flatMap(l => l.items);
  const topMoves = [...allItems]
    .sort((a, b) => (SEVERITY_ORDER[a.priority] ?? 4) - (SEVERITY_ORDER[b.priority] ?? 4))
    .slice(0, 5);

  // Full suggestions: every customer-safe finding with all detail
  const fullSuggestions = findings
    .filter(f => f.customerSafe)
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4))
    .map(f => ({
      code: f.code,
      category: f.category,
      severity: f.severity,
      problem: f.plainEnglishProblem,
      whyItMatters: f.whyItMatters,
      action: f.whatToDoNext,
      target: f.targetState,
      accountData: f.accountData || null
    }));

  // Flat list for backward compatibility
  const flatList = findings.filter(f => f.customerSafe).map(f => f.whatToDoNext);

  return {
    layers,
    topMoves,
    fullSuggestions,
    flatList,
    projectedPreapproval: projectedPreapproval || null,
    cta: getCTA(outcome)
  };
}

function mapFindingToItem(f) {
  return {
    code: f.code,
    title: f.plainEnglishProblem,
    description: f.whatToDoNext,
    priority: f.severity,
    customerSafe: f.customerSafe
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildSuggestions, getCTA, LAYER_CONFIG };
