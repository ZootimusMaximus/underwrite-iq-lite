"use strict";

/**
 * route-outcome.js — Stage 05: 6-Tier Outcome Router
 *
 * Waterfall decision engine that routes applicants to one of 6 tiers
 * based on consumer signals, business signals, and identity gate results.
 *
 * Tiers (most restrictive first):
 *   FRAUD_HOLD → MANUAL_REVIEW → REPAIR_ONLY → FUNDING_PLUS_REPAIR →
 *   FULL_FUNDING → PREMIUM_STACK
 */

const OUTCOMES = {
  FRAUD_HOLD: "FRAUD_HOLD",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  REPAIR_ONLY: "REPAIR_ONLY",
  FUNDING_PLUS_REPAIR: "FUNDING_PLUS_REPAIR",
  FULL_FUNDING: "FULL_FUNDING",
  PREMIUM_STACK: "PREMIUM_STACK"
};

// ---------------------------------------------------------------------------
// Reason Code Collector
// ---------------------------------------------------------------------------

function collectReasonCodes(cs, bs, gate) {
  const reasons = [];
  const gateReasons = gate?.reasons || [];

  // ── Identity / Fraud ──────────────────────────────────────────────
  if (gateReasons.includes("NAME_MISMATCH") || gateReasons.includes("NAME_NOT_PROVIDED")) {
    reasons.push("ID_MISMATCH");
  }
  if (gateReasons.includes("ALL_REPORTS_STALE")) {
    reasons.push("REPORT_STALE");
  }
  if (gateReasons.includes("NO_REPORT_DATES")) {
    reasons.push("REPORT_FRESHNESS_UNKNOWN");
  }
  if (gateReasons.includes("HIGH_FRAUD_RISK_SCORE") || gateReasons.includes("TUMBLING_RISK")) {
    reasons.push("FRAUD_HIGH_RISK");
  }
  if (
    gateReasons.length > 0 &&
    !reasons.includes("FRAUD_HIGH_RISK") &&
    gateReasons.some(r => r.startsWith("POSTAL_") || r === "EMAIL_INVALID")
  ) {
    reasons.push("FRAUD_UNKNOWN");
  }

  // ── Consumer Derogatories ─────────────────────────────────────────
  if (cs.derogatories.chargeoffs > 0) reasons.push("ACTIVE_CHARGEOFF");
  if (cs.derogatories.collections > 0) reasons.push("ACTIVE_COLLECTION");
  if (
    cs.derogatories.active60 > 0 ||
    cs.derogatories.active90 > 0 ||
    cs.derogatories.active120Plus > 0
  ) {
    reasons.push("ACTIVE_60_PLUS");
  }
  if (cs.derogatories.active120Plus > 0) reasons.push("ACTIVE_120_PLUS");
  if (cs.derogatories.activeBankruptcy) reasons.push("RECENT_BANKRUPTCY");
  if (cs.derogatories.dischargedBankruptcy) {
    if (cs.derogatories.bankruptcyAge != null && cs.derogatories.bankruptcyAge >= 24) {
      reasons.push("AGED_BANKRUPTCY");
    } else {
      reasons.push("RECENT_BANKRUPTCY");
    }
  }
  if (bs?.available && (bs.publicRecords?.judgment || bs.publicRecords?.taxLien)) {
    reasons.push("RECENT_JUDGMENT_OR_LIEN");
  }

  // ── File Strength ─────────────────────────────────────────────────
  if (cs.utilization.band === "high") reasons.push("HIGH_UTILIZATION");
  if (cs.utilization.band === "critical") reasons.push("VERY_HIGH_UTILIZATION");
  if (cs.tradelines.thinFile) reasons.push("THIN_FILE");
  if (cs.tradelines.revolvingDepth < 2) reasons.push("LOW_PRIMARY_REVOLVING_DEPTH");
  if (!cs.allBureausClean && cs.anyBureauClean) reasons.push("MIXED_BUREAU_STATUS");
  if (!cs.anyBureauClean) reasons.push("ALL_BUREAUS_DIRTY");

  // ── Business ──────────────────────────────────────────────────────
  if (bs?.available && bs.hardBlock?.blocked) {
    reasons.push("BUSINESS_HARD_BLOCK");
  }
  if (
    bs?.available &&
    !bs.hardBlock?.blocked &&
    (bs.publicRecords?.bankruptcy || bs.publicRecords?.judgment || bs.publicRecords?.taxLien)
  ) {
    reasons.push("BUSINESS_DEROG_CAPPED");
  }

  // ── Confidence / Routing ──────────────────────────────────────────
  if (cs.scores.bureauConfidence === "low") reasons.push("SINGLE_BUREAU_LOW_CONFIDENCE");

  return reasons;
}

// ---------------------------------------------------------------------------
// Tier Checks
// ---------------------------------------------------------------------------

function isFraudHold(gate, bs) {
  if (gate?.outcome === OUTCOMES.FRAUD_HOLD) return true;
  if (bs?.available && bs.hardBlock?.reasons?.includes("OFAC_MATCH")) return true;
  return false;
}

function isManualReview(gate, cs) {
  if (gate?.outcome === OUTCOMES.MANUAL_REVIEW) return true;
  if (cs.scores.median === null) return true;
  if (cs.scores.bureauConfidence === "low" && cs.scores.median === null) return true;
  return false;
}

function isRepairOnly(cs) {
  const hasActiveNegs =
    cs.derogatories.chargeoffs > 0 ||
    cs.derogatories.collections > 0 ||
    cs.derogatories.activeBankruptcy ||
    cs.derogatories.active90 > 0 ||
    cs.derogatories.active120Plus > 0 ||
    cs.derogatories.worstSeverity >= 5;
  if (!hasActiveNegs) return false;
  // All bureaus must be dirty for REPAIR_ONLY
  return !cs.anyBureauClean;
}

function isFundingPlusRepair(cs) {
  const hasActiveNegs =
    cs.derogatories.chargeoffs > 0 ||
    cs.derogatories.collections > 0 ||
    cs.derogatories.activeBankruptcy ||
    cs.derogatories.active90 > 0 ||
    cs.derogatories.active120Plus > 0 ||
    cs.derogatories.worstSeverity >= 5;
  if (!hasActiveNegs) return false;
  // At least one bureau is clean — can fund on clean, repair dirty
  return cs.anyBureauClean;
}

function isFullFunding(cs) {
  return (
    cs.allBureausClean &&
    (cs.utilization.band === "excellent" || cs.utilization.band === "good") &&
    cs.derogatories.active === 0 &&
    !cs.tradelines.thinFile
  );
}

function isPremiumStack(cs) {
  return (
    cs.scores.median != null &&
    cs.scores.median >= 760 &&
    cs.utilization.pct != null &&
    cs.utilization.pct <= 10 &&
    cs.anchors.revolving != null &&
    cs.anchors.revolving.limit >= 10000 &&
    cs.tradelines.revolvingDepth >= 3
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * routeOutcome(consumerSignals, businessSignals, identityGate)
 *
 * @param {Object} consumerSignals - Output of deriveConsumerSignals (Module 2)
 * @param {Object|null} businessSignals - Output of deriveBusinessSignals (Module 3)
 * @param {Object|null} identityGate - Output of runIdentityAndFraudGate (Module 4)
 * @returns {{ outcome, reasonCodes[], confidence }}
 */
function routeOutcome(consumerSignals, businessSignals, identityGate) {
  const cs = consumerSignals;
  const bs = businessSignals;
  const gate = identityGate;
  const reasonCodes = collectReasonCodes(cs, bs, gate);

  if (isFraudHold(gate, bs)) {
    return { outcome: OUTCOMES.FRAUD_HOLD, reasonCodes, confidence: "high" };
  }

  if (isManualReview(gate, cs)) {
    const conf = gate?.confidence === "low" ? "low" : "medium";
    return { outcome: OUTCOMES.MANUAL_REVIEW, reasonCodes, confidence: conf };
  }

  if (isRepairOnly(cs)) {
    return { outcome: OUTCOMES.REPAIR_ONLY, reasonCodes, confidence: "high" };
  }

  if (isFundingPlusRepair(cs)) {
    return { outcome: OUTCOMES.FUNDING_PLUS_REPAIR, reasonCodes, confidence: "high" };
  }

  if (isFullFunding(cs)) {
    const outcome = isPremiumStack(cs) ? OUTCOMES.PREMIUM_STACK : OUTCOMES.FULL_FUNDING;
    const conf = cs.scores.bureauConfidence === "high" ? "high" : "medium";
    return { outcome, reasonCodes, confidence: conf };
  }

  // Default: FUNDING_PLUS_REPAIR (has no negs but doesn't meet full funding criteria)
  return { outcome: OUTCOMES.FUNDING_PLUS_REPAIR, reasonCodes, confidence: "medium" };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  routeOutcome,
  OUTCOMES,
  // Exported for testing
  collectReasonCodes,
  isFraudHold,
  isManualReview,
  isRepairOnly,
  isFundingPlusRepair,
  isFullFunding,
  isPremiumStack
};
