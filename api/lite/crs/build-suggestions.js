"use strict";

/**
 * build-suggestions.js — Stage 08: Suggestion Builder (v3)
 *
 * Takes optimization findings and organizes them into 4 prioritized layers.
 * No cap on findings — outputs everything.
 * Includes projected pre-approval when provided.
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
 * buildSuggestions(findings, outcome, consumerSignals, businessSignals, projectedPreapproval)
 *
 * @returns {{ layers[], topMoves[], fullSuggestions[], flatList[], projectedPreapproval }}
 */
function buildSuggestions(
  findings,
  _outcome,
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

  // All items sorted by severity (no cap)
  const allItems = layers.flatMap(l => l.items);
  const topMoves = [...allItems].sort(
    (a, b) => (SEVERITY_ORDER[a.priority] ?? 4) - (SEVERITY_ORDER[b.priority] ?? 4)
  );

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
    projectedPreapproval: projectedPreapproval || null
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

module.exports = { buildSuggestions, LAYER_CONFIG };
