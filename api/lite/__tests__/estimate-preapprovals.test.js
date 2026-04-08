const test = require("node:test");
const assert = require("node:assert/strict");
const {
  estimatePreapprovals,
  getBusinessAgeMultiplier,
  getAuDominanceModifier,
  getThinFileModifier,
  getBusinessOverlayModifier,
  getOverlayStrength,
  getOfferBand,
  getConfidenceBand,
  PERSONAL_CARD_MULTIPLIER,
  PERSONAL_CARD_FLOOR
} = require("../crs/estimate-preapprovals");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConsumerSignals(overrides = {}) {
  return {
    scores: { median: 720, bureauConfidence: "high", spread: 20, perBureau: {} },
    tradelines: {
      total: 10,
      primary: 8,
      au: 2,
      auDominance: 0.2,
      revolvingDepth: 4,
      installmentDepth: 2,
      mortgagePresent: false,
      depth: 8,
      thinFile: false
    },
    anchors: {
      revolving: { creditor: "BIG BANK", limit: 15000, openedDate: "2020-01-01", months: 72 },
      installment: { creditor: "AUTO LOAN", amount: 25000, openedDate: "2020-01-01", months: 72 }
    },
    utilization: { totalBalance: 2000, totalLimit: 20000, pct: 10, band: "good" },
    inquiries: { total: 2, last6Mo: 1, last12Mo: 2, pressure: "low" },
    derogatories: {
      active: 0,
      chargeoffs: 0,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 0,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    },
    paymentHistory: { late30: 0, late60: 0, late90: 0, totalEvents: 0, recentActivity: false },
    ...overrides
  };
}

function makeBusinessSignals(overrides = {}) {
  return {
    available: true,
    scores: {
      intelliscore: 80,
      intelliscoreRisk: "LOW RISK",
      fsr: 40,
      fsrRisk: "MEDIUM RISK"
    },
    profile: {
      name: "TEST CO",
      incorporatedDate: "2020-01-01",
      ageMonths: 72,
      type: "LLC",
      state: "TX",
      isActive: true
    },
    hardBlock: { blocked: false, reasons: [] },
    bizNegativeItems: { hasNegatives: false },
    ucc: { caution: false },
    bizUtilization: { band: "good" },
    ...overrides
  };
}

// ============================================================================
// Helper functions
// ============================================================================

test("getBusinessAgeMultiplier: all brackets", () => {
  assert.equal(getBusinessAgeMultiplier(null), 0);
  assert.equal(getBusinessAgeMultiplier(6), 0.5);
  assert.equal(getBusinessAgeMultiplier(11), 0.5);
  assert.equal(getBusinessAgeMultiplier(12), 1.0);
  assert.equal(getBusinessAgeMultiplier(23), 1.0);
  assert.equal(getBusinessAgeMultiplier(24), 2.0);
  assert.equal(getBusinessAgeMultiplier(60), 2.0);
});

test("getAuDominanceModifier: all brackets", () => {
  assert.equal(getAuDominanceModifier(0), 1.0);
  assert.equal(getAuDominanceModifier(0.2), 1.0);
  assert.equal(getAuDominanceModifier(0.3), 0.9);
  assert.equal(getAuDominanceModifier(0.4), 0.9);
  assert.equal(getAuDominanceModifier(0.5), 0.75);
  assert.equal(getAuDominanceModifier(0.6), 0.75);
  assert.equal(getAuDominanceModifier(0.7), 0.5);
  assert.equal(getAuDominanceModifier(0.9), 0.5);
});

test("getThinFileModifier", () => {
  assert.equal(getThinFileModifier(false), 1.0);
  assert.equal(getThinFileModifier(true), 0.6);
});

test("getBusinessOverlayModifier: all brackets", () => {
  assert.equal(getBusinessOverlayModifier(null), 0);
  assert.equal(getBusinessOverlayModifier(90), 1.15);
  assert.equal(getBusinessOverlayModifier(80), 1.15);
  assert.equal(getBusinessOverlayModifier(70), 1.0);
  assert.equal(getBusinessOverlayModifier(60), 1.0);
  assert.equal(getBusinessOverlayModifier(50), 0.8);
  assert.equal(getBusinessOverlayModifier(40), 0.8);
  assert.equal(getBusinessOverlayModifier(30), 0.5);
});

// ============================================================================
// estimatePreapprovals: full stack, all modifiers 1.0
// ============================================================================

test("estimatePreapprovals: full stack, clean modifiers", () => {
  const cs = makeConsumerSignals();
  // v2: outcomeMod=1.0, utilMod=0.95 (good), thinMod=1.0
  // Card: 15000 * 5.5 = 82500, 82500 * 1.0 * 0.95 * 1.0 = 78375
  const result = estimatePreapprovals(cs, null, "FULL_FUNDING");

  assert.equal(result.personalCard.base, 82500);
  assert.equal(result.personalCard.final, 78375);
  assert.equal(result.personalCard.eligible, true);

  // Loan: 25000 * 3.0 = 75000, 75000 * 0.95 = 71250
  assert.equal(result.personalLoan.base, 75000);
  assert.equal(result.personalLoan.final, 71250);
  assert.equal(result.personalLoan.eligible, true);

  assert.equal(result.suppressedByOutcome, false);
  assert.equal(result.totalPersonal, 78375 + 71250);
});

// ============================================================================
// estimatePreapprovals: suppressed by outcome
// ============================================================================

test("estimatePreapprovals: REPAIR_ONLY → all suppressed", () => {
  const cs = makeConsumerSignals();
  const result = estimatePreapprovals(cs, null, "REPAIR_ONLY");

  assert.equal(result.personalCard.final, 0);
  assert.equal(result.personalLoan.final, 0);
  assert.equal(result.business.final, 0);
  assert.equal(result.suppressedByOutcome, true);
  assert.equal(result.totalCombined, 0);
});

test("estimatePreapprovals: FRAUD_HOLD → all suppressed", () => {
  const cs = makeConsumerSignals();
  const result = estimatePreapprovals(cs, null, "FRAUD_HOLD");
  assert.equal(result.suppressedByOutcome, true);
  assert.equal(result.totalCombined, 0);
});

// ============================================================================
// estimatePreapprovals: no anchors
// ============================================================================

test("estimatePreapprovals: no revolving anchor → card = 0", () => {
  const cs = makeConsumerSignals({
    anchors: {
      revolving: null,
      installment: { creditor: "AUTO", amount: 20000, openedDate: "2020-01-01", months: 72 }
    }
  });
  const result = estimatePreapprovals(cs, null, "FULL_FUNDING");

  assert.equal(result.personalCard.base, 0);
  assert.equal(result.personalCard.final, 0);
  assert.equal(result.personalCard.eligible, false);
  assert.ok(result.personalLoan.final > 0);
});

test("estimatePreapprovals: no installment anchor → loan = 0", () => {
  const cs = makeConsumerSignals({
    anchors: {
      revolving: { creditor: "BANK", limit: 10000, openedDate: "2020-01-01", months: 72 },
      installment: null
    }
  });
  const result = estimatePreapprovals(cs, null, "FULL_FUNDING");

  assert.equal(result.personalLoan.base, 0);
  assert.equal(result.personalLoan.final, 0);
  assert.equal(result.personalLoan.eligible, false);
  assert.ok(result.personalCard.final > 0);
});

// ============================================================================
// estimatePreapprovals: floor enforcement
// ============================================================================

test("estimatePreapprovals: small anchor uses floor", () => {
  const cs = makeConsumerSignals({
    anchors: {
      revolving: { creditor: "TINY", limit: 500, openedDate: "2020-01-01", months: 72 },
      installment: { creditor: "TINY", amount: 2000, openedDate: "2020-01-01", months: 72 }
    }
  });
  const result = estimatePreapprovals(cs, null, "FULL_FUNDING");

  // Card: 500 * 5.5 = 2750, floor 5000 → base = 5000
  assert.equal(result.personalCard.base, PERSONAL_CARD_FLOOR);
  // Loan: 2000 * 3.0 = 6000, floor 10000 → base = 10000
  assert.equal(result.personalLoan.base, 10000);
});

// ============================================================================
// estimatePreapprovals: business calculations (v2)
// ============================================================================

test("estimatePreapprovals: business with mature company", () => {
  const cs = makeConsumerSignals();
  const bs = makeBusinessSignals();
  // v2: cardBase=82500, ageMult=2.0, businessBase=165000
  // bizUtilMod=0.95 (good), outcomeMod=1.0 → final = floor(165000 * 0.95 * 1.0) = 156750
  const result = estimatePreapprovals(cs, bs, "FULL_FUNDING");

  assert.equal(result.business.base, 165000);
  assert.equal(result.business.multiplier, 2.0);
  assert.equal(result.business.final, Math.floor(165000 * 0.95 * 1.0));
  assert.equal(result.business.capReason, "utilization_based");
  assert.equal(result.business.eligible, true);
  assert.ok(result.totalBusiness > 0);
});

test("estimatePreapprovals: business blocked by hardBlock → 0", () => {
  const cs = makeConsumerSignals();
  const bs = makeBusinessSignals({ hardBlock: { blocked: true, reasons: ["BUSINESS_INACTIVE"] } });
  const result = estimatePreapprovals(cs, bs, "FULL_FUNDING");

  assert.equal(result.business.final, 0);
  assert.equal(result.business.eligible, false);
  assert.equal(result.business.capReason, "hard_block");
});

test("estimatePreapprovals: business blocked by negatives → 0", () => {
  const cs = makeConsumerSignals();
  const bs = makeBusinessSignals({ bizNegativeItems: { hasNegatives: true } });
  const result = estimatePreapprovals(cs, bs, "FULL_FUNDING");

  assert.equal(result.business.final, 0);
  assert.equal(result.business.eligible, false);
  assert.equal(result.business.capReason, "negative_items_hard_block");
});

test("estimatePreapprovals: business blocked by UCC caution → 0", () => {
  const cs = makeConsumerSignals();
  const bs = makeBusinessSignals({ ucc: { caution: true } });
  const result = estimatePreapprovals(cs, bs, "FULL_FUNDING");

  assert.equal(result.business.final, 0);
  assert.equal(result.business.eligible, false);
  assert.equal(result.business.capReason, "ucc_hard_block");
});

test("estimatePreapprovals: no business → 0", () => {
  const cs = makeConsumerSignals();
  const result = estimatePreapprovals(cs, null, "FULL_FUNDING");

  assert.equal(result.business.final, 0);
  assert.equal(result.business.eligible, false);
});

test("estimatePreapprovals: young business (6mo) → 0.5x multiplier", () => {
  const cs = makeConsumerSignals();
  const bs = makeBusinessSignals({
    profile: {
      name: "NEW CO",
      incorporatedDate: "2025-09-01",
      ageMonths: 6,
      type: "LLC",
      state: "TX",
      isActive: true
    }
  });
  const result = estimatePreapprovals(cs, bs, "FULL_FUNDING");

  assert.equal(result.business.multiplier, 0.5);
  // Base = cardBase * 0.5 = 82500 * 0.5 = 41250
  // final = floor(41250 * bizUtilMod * outcomeMod)
  assert.ok(result.business.final > 0);
  assert.ok(
    result.business.base <
      makeConsumerSignals().anchors.revolving.limit * PERSONAL_CARD_MULTIPLIER * 2.0
  );
});

test("estimatePreapprovals: business unavailable → capReason not_applicable", () => {
  const cs = makeConsumerSignals();
  const bs = makeBusinessSignals({ available: false });
  const result = estimatePreapprovals(cs, bs, "FULL_FUNDING");

  assert.equal(result.business.final, 0);
  assert.equal(result.business.capReason, "not_applicable");
});

// ============================================================================
// estimatePreapprovals: FUNDING_PLUS_REPAIR modifier (v2 replacement for CONDITIONAL)
// ============================================================================

test("estimatePreapprovals: FUNDING_PLUS_REPAIR → 0.6x outcome modifier", () => {
  const cs = makeConsumerSignals();
  const resultFull = estimatePreapprovals(cs, null, "FULL_FUNDING");
  const resultPartial = estimatePreapprovals(cs, null, "FUNDING_PLUS_REPAIR");

  // FUNDING_PLUS_REPAIR card should be ~60% of FULL_FUNDING card
  const ratio = resultPartial.personalCard.final / resultFull.personalCard.final;
  assert.ok(ratio > 0.59 && ratio < 0.61, `Expected ~0.6 ratio, got ${ratio}`);
});

// ============================================================================
// estimatePreapprovals: modifier stacking (v2: outcome + utilization + thinFile only)
// ============================================================================

test("estimatePreapprovals: multiple modifiers stack", () => {
  const cs = makeConsumerSignals({
    tradelines: {
      total: 10,
      primary: 8,
      au: 2,
      auDominance: 0.2,
      revolvingDepth: 4,
      installmentDepth: 2,
      mortgagePresent: false,
      depth: 8,
      thinFile: true
    },
    utilization: { totalBalance: 6000, totalLimit: 10000, pct: 60, band: "high" }
  });
  const result = estimatePreapprovals(cs, null, "FUNDING_PLUS_REPAIR");

  // outcome=0.6, util=0.6 (high), thinFile=0.6 → product = 0.216
  // final should be well below base
  assert.ok(result.personalCard.final < result.personalCard.base * 0.3);
  assert.ok(result.modifiersApplied.includes("outcome"));
  assert.ok(result.modifiersApplied.includes("utilization"));
  assert.ok(result.modifiersApplied.includes("thinFile"));
  // v2: these modifiers no longer exist
  assert.ok(!result.modifiersApplied.includes("bureauConfidence"));
  assert.ok(!result.modifiersApplied.includes("inquiryPressure"));
  assert.ok(!result.modifiersApplied.includes("auDominance"));
});

// ============================================================================
// estimatePreapprovals: totalCombined
// ============================================================================

test("estimatePreapprovals: totalCombined includes all", () => {
  const cs = makeConsumerSignals();
  const bs = makeBusinessSignals();
  const result = estimatePreapprovals(cs, bs, "FULL_FUNDING");

  assert.equal(result.totalCombined, result.totalPersonal + result.totalBusiness);
  assert.equal(result.totalPersonal, result.personalCard.final + result.personalLoan.final);
});

// ============================================================================
// getOverlayStrength — all bands (still exported for tests)
// ============================================================================

test("getOverlayStrength: all bands", () => {
  assert.equal(getOverlayStrength(null), "none");
  assert.equal(getOverlayStrength(undefined), "none");
  assert.equal(getOverlayStrength(90), "strong");
  assert.equal(getOverlayStrength(80), "strong");
  assert.equal(getOverlayStrength(79), "moderate");
  assert.equal(getOverlayStrength(60), "moderate");
  assert.equal(getOverlayStrength(59), "fair");
  assert.equal(getOverlayStrength(40), "fair");
  assert.equal(getOverlayStrength(39), "weak");
  assert.equal(getOverlayStrength(10), "weak");
});

// ============================================================================
// getOfferBand — all bands
// ============================================================================

test("getOfferBand: all bands", () => {
  assert.equal(getOfferBand(0), "none");
  assert.equal(getOfferBand(-100), "none");
  assert.equal(getOfferBand(1), "starter");
  assert.equal(getOfferBand(24999), "starter");
  assert.equal(getOfferBand(25000), "moderate");
  assert.equal(getOfferBand(74999), "moderate");
  assert.equal(getOfferBand(75000), "strong");
  assert.equal(getOfferBand(149999), "strong");
  assert.equal(getOfferBand(150000), "premium");
  assert.equal(getOfferBand(500000), "premium");
});

// ============================================================================
// getConfidenceBand — all bands
// ============================================================================

test("getConfidenceBand: low bureau confidence → low", () => {
  assert.equal(getConfidenceBand(0.9, "low"), "low");
  assert.equal(getConfidenceBand(0.5, "low"), "low");
});

test("getConfidenceBand: high modProduct → high", () => {
  assert.equal(getConfidenceBand(0.8, "high"), "high");
  assert.equal(getConfidenceBand(0.95, "medium"), "high");
});

test("getConfidenceBand: mid modProduct → medium", () => {
  assert.equal(getConfidenceBand(0.5, "high"), "medium");
  assert.equal(getConfidenceBand(0.79, "medium"), "medium");
});

test("getConfidenceBand: low modProduct → low", () => {
  assert.equal(getConfidenceBand(0.3, "high"), "low");
  assert.equal(getConfidenceBand(0.49, "medium"), "low");
});

// ============================================================================
// customerSafe — outcome-based (v2 key names)
// ============================================================================

test("customerSafe: FULL_FUNDING → true", () => {
  const cs = makeConsumerSignals();
  const result = estimatePreapprovals(cs, null, "FULL_FUNDING");
  assert.equal(result.customerSafe, true);
});

test("customerSafe: FUNDING_PLUS_REPAIR → true", () => {
  const cs = makeConsumerSignals();
  const result = estimatePreapprovals(cs, null, "FUNDING_PLUS_REPAIR");
  assert.equal(result.customerSafe, true);
});

test("customerSafe: REPAIR_ONLY → false", () => {
  const cs = makeConsumerSignals();
  const result = estimatePreapprovals(cs, null, "REPAIR_ONLY");
  assert.equal(result.customerSafe, false);
});

test("customerSafe: FRAUD_HOLD → false", () => {
  const cs = makeConsumerSignals();
  const result = estimatePreapprovals(cs, null, "FRAUD_HOLD");
  assert.equal(result.customerSafe, false);
});

// ============================================================================
// Business output fields: offerBand, capReason (v2 — overlayStrength removed)
// ============================================================================

test("estimatePreapprovals: business output has offerBand, capReason", () => {
  const cs = makeConsumerSignals();
  const bs = makeBusinessSignals();
  const result = estimatePreapprovals(cs, bs, "FULL_FUNDING");

  assert.ok("offerBand" in result.business);
  assert.ok("capReason" in result.business);
  // v2: overlayStrength removed from business output
  assert.ok(!("overlayStrength" in result.business));

  assert.notEqual(result.business.offerBand, "none");
  assert.equal(result.business.capReason, "utilization_based");
});

test("estimatePreapprovals: suppressed business → none offerBand", () => {
  const cs = makeConsumerSignals();
  const bs = makeBusinessSignals({ hardBlock: { blocked: true, reasons: ["BUSINESS_INACTIVE"] } });
  const result = estimatePreapprovals(cs, bs, "FULL_FUNDING");

  assert.equal(result.business.offerBand, "none");
});

// ============================================================================
// confidenceBand present in output
// ============================================================================

test("estimatePreapprovals: confidenceBand present in output", () => {
  const cs = makeConsumerSignals();
  // v2: personalModProduct = 1.0 * 0.95 * 1.0 = 0.95 → "high"
  const result = estimatePreapprovals(cs, null, "FULL_FUNDING");

  assert.ok("confidenceBand" in result);
  assert.equal(result.confidenceBand, "high");
});

test("estimatePreapprovals: low bureauConfidence → low confidenceBand", () => {
  const cs = makeConsumerSignals({
    scores: { median: 720, bureauConfidence: "low", spread: 20, perBureau: {} }
  });
  const result = estimatePreapprovals(cs, null, "FULL_FUNDING");

  assert.equal(result.confidenceBand, "low");
});

// ============================================================================
// Business biz utilization modifier
// ============================================================================

test("estimatePreapprovals: business with critical utilization → lower final", () => {
  const cs = makeConsumerSignals();
  const bsGood = makeBusinessSignals({ bizUtilization: { band: "excellent" } });
  const bsBad = makeBusinessSignals({ bizUtilization: { band: "critical" } });

  const resultGood = estimatePreapprovals(cs, bsGood, "FULL_FUNDING");
  const resultBad = estimatePreapprovals(cs, bsBad, "FULL_FUNDING");

  assert.ok(resultBad.business.final < resultGood.business.final);
  // critical = 0.4x vs excellent = 1.0x
  const ratio = resultBad.business.final / resultGood.business.final;
  assert.ok(ratio > 0.39 && ratio < 0.41, `Expected ~0.4 ratio, got ${ratio}`);
});
