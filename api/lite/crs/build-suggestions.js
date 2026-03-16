"use strict";

/**
 * build-suggestions.js — Stage 08: Suggestion Builder
 *
 * Takes optimization findings and organizes them into 4 prioritized layers
 * for customer-facing display.
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
  { name: "Business Prep", categories: ["business"], description: "Prepare your business profile" }
];

/**
 * buildSuggestions(findings, outcome, consumerSignals, businessSignals)
 *
 * @returns {{ layers[], topMoves[], flatList[] }}
 */
function buildSuggestions(findings, _outcome, _consumerSignals, _businessSignals) {
  const layers = LAYER_CONFIG.map(config => {
    let items;
    if (config.categories) {
      // Business layer: match by category
      items = findings
        .filter(f => config.categories.includes(f.category))
        .map(f => ({
          code: f.code,
          title: f.plainEnglishProblem,
          description: f.whatToDoNext,
          priority: f.severity,
          customerSafe: f.customerSafe
        }));
    } else {
      // Severity-based layers: exclude business findings (they go in layer 4)
      items = findings
        .filter(f => config.severities.includes(f.severity) && f.category !== "business")
        .map(f => ({
          code: f.code,
          title: f.plainEnglishProblem,
          description: f.whatToDoNext,
          priority: f.severity,
          customerSafe: f.customerSafe
        }));
    }
    return { name: config.name, description: config.description, items };
  });

  // Top moves: top 5 across all layers (severity order: critical > high > medium > low)
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const allItems = layers.flatMap(l => l.items);
  const topMoves = [...allItems]
    .sort((a, b) => (severityOrder[a.priority] ?? 4) - (severityOrder[b.priority] ?? 4))
    .slice(0, 5);

  // Flat list for backward compatibility
  const flatList = findings.filter(f => f.customerSafe).map(f => f.whatToDoNext);

  return { layers, topMoves, flatList };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildSuggestions, LAYER_CONFIG };
