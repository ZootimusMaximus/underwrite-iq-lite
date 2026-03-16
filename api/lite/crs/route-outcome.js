"use strict";

/**
 * route-outcome.js — Stage 05: 6-Tier Outcome Router
 *
 * Waterfall decision engine that routes applicants to one of 6 tiers
 * based on consumer signals, business signals, and identity gate results.
 *
 * Tiers (most restrictive first):
 *   FRAUD_HOLD → MANUAL_REVIEW → REPAIR → CONDITIONAL_APPROVAL →
 *   FULL_STACK_APPROVAL → PREMIUM_STACK
 */

const OUTCOMES = {
  FRAUD_HOLD: "FRAUD_HOLD",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  REPAIR: "REPAIR",
  CONDITIONAL_APPROVAL: "CONDITIONAL_APPROVAL",
  FULL_STACK_APPROVAL: "FULL_STACK_APPROVAL",
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
  if (cs.inquiries.pressure === "high") reasons.push("INQUIRY_PRESSURE");
  if (cs.inquiries.pressure === "storm") reasons.push("INQUIRY_STORM");
  if (cs.tradelines.thinFile) reasons.push("THIN_FILE");
  if (cs.tradelines.auDominance > 0.6) reasons.push("AU_DOMINANT_FILE");
  if (cs.tradelines.revolvingDepth < 2) reasons.push("LOW_PRIMARY_REVOLVING_DEPTH");
  if (cs.scores.median !== null) {
    if (cs.scores.median < 580) reasons.push("SCORE_BELOW_FLOOR");
    else if (cs.scores.median >= 680 && cs.scores.median < 700)
      reasons.push("SCORE_CONDITIONAL_BAND");
    else if (cs.scores.median >= 700) reasons.push("SCORE_FULL_STACK_BAND");
  }

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

function isRepair(cs) {
  if (cs.derogatories.worstSeverity >= 5) return true;
  if (cs.derogatories.activeBankruptcy) return true;
  if (cs.scores.median !== null && cs.scores.median < 580) return true;
  if (cs.derogatories.active90 > 0 || cs.derogatories.active120Plus > 0) return true;
  if (cs.derogatories.chargeoffs > 0) return true;
  if (cs.derogatories.collections > 0) return true;
  if (cs.utilization.band === "critical" && cs.derogatories.active > 0) return true;
  return false;
}

function isFullStack(cs) {
  return (
    cs.scores.median !== null &&
    cs.scores.median >= 700 &&
    (cs.utilization.band === "excellent" || cs.utilization.band === "good") &&
    cs.derogatories.active === 0 &&
    cs.tradelines.thinFile === false &&
    cs.tradelines.auDominance <= 0.4
  );
}

function isPremiumStack(cs) {
  return (
    cs.scores.median >= 760 &&
    cs.utilization.pct !== null &&
    cs.utilization.pct <= 10 &&
    cs.anchors.revolving != null &&
    cs.anchors.revolving.limit >= 10000 &&
    cs.tradelines.revolvingDepth >= 3 &&
    cs.inquiries.pressure === "low"
  );
}

function canApplyBusinessBoost(cs, bs) {
  if (!bs?.available || bs.hardBlock?.blocked) return false;
  if (bs.scores.intelliscore == null || bs.scores.intelliscore < 70) return false;

  // Consumer must be borderline: score 680-699 OR utilization 30-35%
  const borderlineScore =
    cs.scores.median != null && cs.scores.median >= 680 && cs.scores.median < 700;
  const borderlineUtil =
    cs.utilization.pct != null && cs.utilization.pct >= 30 && cs.utilization.pct <= 35;

  return borderlineScore || borderlineUtil;
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
 * @returns {{ outcome, reasonCodes[], confidence, businessBoostApplied, businessBoostDetail }}
 */
function routeOutcome(consumerSignals, businessSignals, identityGate) {
  const cs = consumerSignals;
  const bs = businessSignals;
  const gate = identityGate;
  const reasonCodes = collectReasonCodes(cs, bs, gate);

  // 1. FRAUD_HOLD — hardest block
  if (isFraudHold(gate, bs)) {
    return {
      outcome: OUTCOMES.FRAUD_HOLD,
      reasonCodes,
      confidence: "high",
      businessBoostApplied: false,
      businessBoostDetail: null
    };
  }

  // 2. MANUAL_REVIEW — incomplete/contradictory data
  if (isManualReview(gate, cs)) {
    const mrConfidence = gate?.confidence === "low" ? "low" : "medium";
    if (mrConfidence === "low") reasonCodes.push("MANUAL_REVIEW_LOW_CONFIDENCE");
    return {
      outcome: OUTCOMES.MANUAL_REVIEW,
      reasonCodes,
      confidence: mrConfidence,
      businessBoostApplied: false,
      businessBoostDetail: null
    };
  }

  // 3. REPAIR — active derogatories, weak score
  if (isRepair(cs)) {
    return {
      outcome: OUTCOMES.REPAIR,
      reasonCodes,
      confidence: "high",
      businessBoostApplied: false,
      businessBoostDetail: null
    };
  }

  // 4. FULL_STACK / PREMIUM — strong file
  if (isFullStack(cs)) {
    const outcome = isPremiumStack(cs) ? OUTCOMES.PREMIUM_STACK : OUTCOMES.FULL_STACK_APPROVAL;
    const confidence = cs.scores.bureauConfidence === "high" ? "high" : "medium";
    return {
      outcome,
      reasonCodes,
      confidence,
      businessBoostApplied: false,
      businessBoostDetail: null
    };
  }

  // 5. CONDITIONAL — default good path, check for business boost
  let outcome = OUTCOMES.CONDITIONAL_APPROVAL;
  let businessBoostApplied = false;
  let businessBoostDetail = null;

  if (canApplyBusinessBoost(cs, bs)) {
    outcome = OUTCOMES.FULL_STACK_APPROVAL;
    businessBoostApplied = true;
    businessBoostDetail = `Borderline consumer (score=${cs.scores.median}, util=${cs.utilization.pct}%) upgraded by strong business credit (intelliscore=${bs.scores.intelliscore})`;
    if (bs.scores.intelliscore >= 80) {
      reasonCodes.push("BUSINESS_STRONG_BOOST");
    } else {
      reasonCodes.push("BUSINESS_MODERATE_BOOST");
    }
  }

  return {
    outcome,
    reasonCodes,
    confidence: "medium",
    businessBoostApplied,
    businessBoostDetail
  };
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
  isRepair,
  isFullStack,
  isPremiumStack,
  canApplyBusinessBoost
};
