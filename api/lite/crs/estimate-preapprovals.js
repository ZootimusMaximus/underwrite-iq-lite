"use strict";

/**
 * estimate-preapprovals.js — Stage 06: Pre-Approval Estimator
 *
 * Calculates funding estimates for personal cards, personal loans,
 * and business credit using anchor tradelines and 7 CRS-era modifiers.
 */

// ---------------------------------------------------------------------------
// Base Formulas
// ---------------------------------------------------------------------------

const PERSONAL_CARD_MULTIPLIER = 5.5;
const PERSONAL_CARD_FLOOR = 5000;
const PERSONAL_LOAN_MULTIPLIER = 3.0;
const PERSONAL_LOAN_FLOOR = 10000;

function getBusinessAgeMultiplier(ageMonths) {
  if (ageMonths == null) return 0;
  if (ageMonths < 12) return 0.5;
  if (ageMonths < 24) return 1.0;
  return 2.0;
}

// ---------------------------------------------------------------------------
// CRS-Era Modifiers
// ---------------------------------------------------------------------------

const OUTCOME_MODIFIER = {
  PREMIUM_STACK: 1.0,
  FULL_STACK_APPROVAL: 1.0,
  CONDITIONAL_APPROVAL: 0.6,
  REPAIR: 0,
  MANUAL_REVIEW: 0,
  FRAUD_HOLD: 0
};

const BUREAU_CONFIDENCE_MODIFIER = {
  high: 1.0,
  medium: 0.85,
  low: 0.65
};

const UTILIZATION_MODIFIER = {
  excellent: 1.0,
  good: 0.95,
  moderate: 0.8,
  high: 0.6,
  critical: 0.4,
  unknown: 0.8
};

const INQUIRY_PRESSURE_MODIFIER = {
  low: 1.0,
  moderate: 0.95,
  high: 0.85,
  storm: 0.7
};

function getAuDominanceModifier(auDominance) {
  if (auDominance <= 0.2) return 1.0;
  if (auDominance <= 0.4) return 0.9;
  if (auDominance <= 0.6) return 0.75;
  return 0.5;
}

function getThinFileModifier(isThin) {
  return isThin ? 0.6 : 1.0;
}

function getBusinessOverlayModifier(intelliscore) {
  if (intelliscore == null) return 0;
  if (intelliscore >= 80) return 1.15;
  if (intelliscore >= 60) return 1.0;
  if (intelliscore >= 40) return 0.8;
  return 0.5;
}

function getOverlayStrength(intelliscore) {
  if (intelliscore == null) return "none";
  if (intelliscore >= 80) return "strong";
  if (intelliscore >= 60) return "moderate";
  if (intelliscore >= 40) return "fair";
  return "weak";
}

function getOfferBand(amount) {
  if (amount <= 0) return "none";
  if (amount < 25000) return "starter";
  if (amount < 75000) return "moderate";
  if (amount < 150000) return "strong";
  return "premium";
}

function getConfidenceBand(modProduct, bureauConfidence) {
  if (bureauConfidence === "low") return "low";
  if (modProduct >= 0.8) return "high";
  if (modProduct >= 0.5) return "medium";
  return "low";
}

const CUSTOMER_SAFE_OUTCOMES = {
  PREMIUM_STACK: true,
  FULL_STACK_APPROVAL: true,
  CONDITIONAL_APPROVAL: true,
  REPAIR: false,
  MANUAL_REVIEW: false,
  FRAUD_HOLD: false
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * estimatePreapprovals(consumerSignals, businessSignals, outcome)
 *
 * @param {Object} consumerSignals - Output of deriveConsumerSignals
 * @param {Object|null} businessSignals - Output of deriveBusinessSignals
 * @param {string} outcome - Outcome tier from routeOutcome
 * @returns {Object} Pre-approval estimates with modifier breakdown
 */
function estimatePreapprovals(consumerSignals, businessSignals, outcome) {
  const cs = consumerSignals;
  const bs = businessSignals;

  // Base amounts from anchor tradelines
  const revolvingAnchor = cs.anchors.revolving?.limit || 0;
  const installmentAnchor = cs.anchors.installment?.amount || 0;

  const cardBase =
    revolvingAnchor > 0
      ? Math.max(revolvingAnchor * PERSONAL_CARD_MULTIPLIER, PERSONAL_CARD_FLOOR)
      : 0;
  const loanBase =
    installmentAnchor > 0
      ? Math.max(installmentAnchor * PERSONAL_LOAN_MULTIPLIER, PERSONAL_LOAN_FLOOR)
      : 0;

  // Collect modifiers
  const outcomeMod = OUTCOME_MODIFIER[outcome] ?? 0;
  const bureauMod = BUREAU_CONFIDENCE_MODIFIER[cs.scores.bureauConfidence] ?? 0.65;
  const utilMod = UTILIZATION_MODIFIER[cs.utilization.band] ?? 0.8;
  const inquiryMod = INQUIRY_PRESSURE_MODIFIER[cs.inquiries.pressure] ?? 0.85;
  const auMod = getAuDominanceModifier(cs.tradelines.auDominance);
  const thinMod = getThinFileModifier(cs.tradelines.thinFile);

  const modifiers = {
    outcome: outcomeMod,
    bureauConfidence: bureauMod,
    utilization: utilMod,
    inquiryPressure: inquiryMod,
    auDominance: auMod,
    thinFile: thinMod
  };

  const personalModProduct = outcomeMod * bureauMod * utilMod * inquiryMod * auMod * thinMod;

  // Personal card
  const cardFinal = Math.floor(cardBase * personalModProduct);
  const personalCard = {
    base: cardBase,
    modifiers: { ...modifiers },
    final: cardFinal,
    eligible: cardFinal > 0
  };

  // Personal loan
  const loanFinal = Math.floor(loanBase * personalModProduct);
  const personalLoan = {
    base: loanBase,
    modifiers: { ...modifiers },
    final: loanFinal,
    eligible: loanFinal > 0
  };

  // Business
  const businessAvailable = bs?.available && !bs?.hardBlock?.blocked;
  const businessAgeMult = businessAvailable ? getBusinessAgeMultiplier(bs.profile?.ageMonths) : 0;
  const businessOverlay = businessAvailable
    ? getBusinessOverlayModifier(bs.scores?.intelliscore)
    : 0;
  const businessBase = cardBase * businessAgeMult;
  let businessRaw = businessAvailable ? Math.floor(businessBase * businessOverlay * outcomeMod) : 0;

  // Apply caps per spec Section 12.2
  let capReason = "not_applicable";
  if (businessAvailable && businessRaw > 0) {
    const recLimit = bs.scores?.recommendedLimit;
    if (recLimit != null && recLimit > 0) {
      // Prefer recommended limit from report as cap
      const cappedByLimit = Math.floor(recLimit * outcomeMod);
      if (businessRaw > cappedByLimit) businessRaw = cappedByLimit;
      capReason = "recommended_limit_from_report";
    } else if (bs.scores?.intelliscore != null) {
      capReason = "policy_estimate_from_quality";
    } else {
      capReason = "legacy_compatibility_fallback";
    }

    // UCC caution applies 0.7x cap (spec Section 10.3)
    if (bs.ucc?.caution) {
      businessRaw = Math.floor(businessRaw * 0.7);
      capReason = "ucc_caution_applied";
    }

    // DBT stress reduces business amount (spec Section 10.3)
    const dbtStress = bs.dbt?.stress;
    if (dbtStress === "moderate") businessRaw = Math.floor(businessRaw * 0.8);
    else if (dbtStress === "high") businessRaw = Math.floor(businessRaw * 0.6);
    else if (dbtStress === "severe") businessRaw = Math.floor(businessRaw * 0.3);
  }
  const businessFinal = businessRaw;

  const business = {
    base: businessBase,
    multiplier: businessAgeMult,
    modifiers: { businessOverlay, outcome: outcomeMod },
    final: businessFinal,
    eligible: businessFinal > 0,
    offerBand: getOfferBand(businessFinal),
    overlayStrength: businessAvailable ? getOverlayStrength(bs.scores?.intelliscore) : "none",
    capReason
  };

  const totalPersonal = cardFinal + loanFinal;
  const totalBusiness = businessFinal;
  const suppressedByOutcome = outcomeMod === 0;
  const customerSafe = CUSTOMER_SAFE_OUTCOMES[outcome] ?? false;

  const modifiersApplied = [];
  if (outcomeMod < 1) modifiersApplied.push("outcome");
  if (bureauMod < 1) modifiersApplied.push("bureauConfidence");
  if (utilMod < 1) modifiersApplied.push("utilization");
  if (inquiryMod < 1) modifiersApplied.push("inquiryPressure");
  if (auMod < 1) modifiersApplied.push("auDominance");
  if (thinMod < 1) modifiersApplied.push("thinFile");
  if (businessOverlay > 0 && businessOverlay !== 1) modifiersApplied.push("businessOverlay");

  // Confidence
  const confidenceBand = getConfidenceBand(personalModProduct, cs.scores.bureauConfidence);

  return {
    personalCard,
    personalLoan,
    business,
    totalPersonal,
    totalBusiness,
    totalCombined: totalPersonal + totalBusiness,
    suppressedByOutcome,
    customerSafe,
    confidenceBand,
    modifiersApplied
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  estimatePreapprovals,
  // Exported for testing
  getBusinessAgeMultiplier,
  getAuDominanceModifier,
  getThinFileModifier,
  getBusinessOverlayModifier,
  getOverlayStrength,
  getOfferBand,
  getConfidenceBand,
  PERSONAL_CARD_MULTIPLIER,
  PERSONAL_CARD_FLOOR,
  PERSONAL_LOAN_MULTIPLIER,
  PERSONAL_LOAN_FLOOR,
  OUTCOME_MODIFIER,
  CUSTOMER_SAFE_OUTCOMES
};
