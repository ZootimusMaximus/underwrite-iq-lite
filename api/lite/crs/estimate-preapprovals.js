"use strict";

/**
 * estimate-preapprovals.js — Stage 06: Pre-Approval Estimator
 *
 * Calculates funding estimates for personal cards, personal loans,
 * and business credit using anchor tradelines and 2 personal modifiers (v2).
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
  FULL_FUNDING: 1.0,
  FUNDING_PLUS_REPAIR: 0.6,
  REPAIR_ONLY: 0,
  MANUAL_REVIEW: 0,
  FRAUD_HOLD: 0
};

const _BUREAU_CONFIDENCE_MODIFIER = {
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

const _INQUIRY_PRESSURE_MODIFIER = {
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
  FULL_FUNDING: true,
  FUNDING_PLUS_REPAIR: true,
  REPAIR_ONLY: false,
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

  // v2: Only 2 modifiers (utilization + thin file)
  const outcomeMod = OUTCOME_MODIFIER[outcome] ?? 0;
  const utilMod = UTILIZATION_MODIFIER[cs.utilization.band] ?? 0.8;
  const thinMod = getThinFileModifier(cs.tradelines.thinFile);

  const modifiers = {
    outcome: outcomeMod,
    utilization: utilMod,
    thinFile: thinMod
  };

  const personalModProduct = outcomeMod * utilMod * thinMod;

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

  // Business (v2: utilization-based, hard block on any negative/UCC)
  const businessAvailable = bs?.available === true;
  const bizBlocked =
    !businessAvailable ||
    bs?.hardBlock?.blocked ||
    bs?.bizNegativeItems?.hasNegatives ||
    bs?.ucc?.caution;

  const businessAgeMult = businessAvailable ? getBusinessAgeMultiplier(bs.profile?.ageMonths) : 0;
  const bizUtilMod =
    businessAvailable && bs.bizUtilization?.band
      ? (UTILIZATION_MODIFIER[bs.bizUtilization.band] ?? 0.8)
      : 1.0;
  const businessBase = cardBase * businessAgeMult;
  const businessFinal = bizBlocked ? 0 : Math.floor(businessBase * bizUtilMod * outcomeMod);

  let capReason = "not_applicable";
  if (bizBlocked && bs?.bizNegativeItems?.hasNegatives) capReason = "negative_items_hard_block";
  else if (bizBlocked && bs?.ucc?.caution) capReason = "ucc_hard_block";
  else if (bizBlocked && bs?.hardBlock?.blocked) capReason = "hard_block";
  else if (businessFinal > 0) capReason = "utilization_based";

  const business = {
    base: businessBase,
    multiplier: businessAgeMult,
    modifiers: { bizUtilization: bizUtilMod, outcome: outcomeMod },
    final: businessFinal,
    eligible: businessFinal > 0,
    offerBand: getOfferBand(businessFinal),
    capReason
  };

  const totalPersonal = cardFinal + loanFinal;
  const totalBusiness = businessFinal;
  const suppressedByOutcome = outcomeMod === 0;
  const customerSafe = CUSTOMER_SAFE_OUTCOMES[outcome] ?? false;

  const modifiersApplied = [];
  if (outcomeMod < 1) modifiersApplied.push("outcome");
  if (utilMod < 1) modifiersApplied.push("utilization");
  if (thinMod < 1) modifiersApplied.push("thinFile");

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
