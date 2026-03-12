"use strict";

/**
 * build-cards.js — Stage 09: Tag Card Builder
 *
 * Maps outcome + signals + findings into a flat array of tag strings
 * for CRM tagging and workflow routing.
 */

/**
 * buildCards(outcome, consumerSignals, businessSignals, findings)
 *
 * @returns {string[]} Array of tag strings
 */
function buildCards(outcome, consumerSignals, businessSignals, findings) {
  const cs = consumerSignals;
  const bs = businessSignals;
  const tags = [];

  // Outcome-based tags
  switch (outcome) {
    case "FRAUD_HOLD":
      tags.push("fraud_hold");
      break;
    case "MANUAL_REVIEW":
      tags.push("manual_review");
      break;
    case "REPAIR":
      break; // repair tags added via signals below
    case "CONDITIONAL_APPROVAL":
      tags.push("conditional");
      break;
    case "FULL_STACK_APPROVAL":
      tags.push("full_stack");
      break;
    case "PREMIUM_STACK":
      tags.push("premium_stack");
      tags.push("full_stack");
      break;
  }

  // Utilization tags
  if (cs.utilization.band === "high") tags.push("util_high");
  if (cs.utilization.band === "critical") tags.push("util_critical");

  // Tradeline quality tags
  if (cs.tradelines.thinFile) tags.push("thin_file");
  if (cs.tradelines.auDominance > 0.6) tags.push("au_dominant");
  if (!cs.anchors.revolving) tags.push("needs_revolving");

  // Derogatory tags
  if (
    cs.derogatories.chargeoffs > 0 ||
    cs.derogatories.collections > 0 ||
    cs.derogatories.active > 0
  ) {
    tags.push("needs_negative_cleanup");
  }

  // Inquiry tags
  if (cs.inquiries.pressure === "high" || cs.inquiries.pressure === "storm") {
    tags.push("needs_inquiry_cleanup");
    tags.push("inquiries"); // spec alias
  }

  // File buildout
  if (cs.tradelines.thinFile || cs.tradelines.auDominance > 0.6) {
    tags.push("needs_file_buildout");
    tags.push("file_buildout"); // spec alias
  }

  // Derogatory spec alias
  if (
    cs.derogatories.chargeoffs > 0 ||
    cs.derogatories.collections > 0 ||
    cs.derogatories.active > 0
  ) {
    tags.push("negatives"); // spec alias
  }

  // Bankruptcy tags
  if (cs.derogatories.activeBankruptcy) tags.push("bankruptcy_active");
  if (cs.derogatories.dischargedBankruptcy) tags.push("bankruptcy_discharged");

  // Public record spec alias
  if (cs.derogatories.activeBankruptcy || cs.derogatories.dischargedBankruptcy) {
    tags.push("public_record"); // spec alias
  }

  // Near approval (conditional with few blockers)
  if (outcome === "CONDITIONAL_APPROVAL") {
    const criticalFindings = findings.filter(f => f.severity === "critical");
    if (criticalFindings.length === 0) tags.push("near_approval");
  }

  // Business tags
  if (bs?.available && !bs.hardBlock?.blocked) {
    tags.push("business_boost_available");
  }
  if (bs?.available && bs.hardBlock?.blocked) {
    tags.push("business_blocked");
  }

  return [...new Set(tags)]; // deduplicate
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildCards };
