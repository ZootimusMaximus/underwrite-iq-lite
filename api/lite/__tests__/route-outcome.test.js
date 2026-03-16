const test = require("node:test");
const assert = require("node:assert/strict");
const {
  routeOutcome,
  OUTCOMES,
  collectReasonCodes,
  isFraudHold,
  isManualReview,
  isRepair,
  isFullStack,
  isPremiumStack,
  canApplyBusinessBoost
} = require("../crs/route-outcome");

// ---------------------------------------------------------------------------
// Helpers: build minimal signal objects
// ---------------------------------------------------------------------------

function makeConsumerSignals(overrides = {}) {
  return {
    scores: {
      median: 720,
      bureauConfidence: "high",
      spread: 20,
      perBureau: { tu: 720, ex: 710, eq: 730 }
    },
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
      installment: null
    },
    utilization: { totalBalance: 2000, totalLimit: 20000, pct: 10, band: "good" },
    inquiries: { total: 5, last6Mo: 2, last12Mo: 4, pressure: "low" },
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
      intelliscore: 70,
      intelliscoreRisk: "LOW TO MEDIUM RISK",
      fsr: 30,
      fsrRisk: "MEDIUM RISK",
      recommendedLimit: 100000
    },
    profile: {
      name: "TEST CO",
      incorporatedDate: "2020-01-01",
      ageMonths: 72,
      type: "LLC",
      state: "TX",
      isActive: true
    },
    dbt: { current: 0, stress: "none", monthlyAvg: 0 },
    fraudShield: { ofacClear: true, isActive: true, riskTriggers: false, nameVerified: true },
    publicRecords: { bankruptcy: false, judgment: false, taxLien: false },
    ucc: { count: 0, caution: false },
    hardBlock: { blocked: false, reasons: [] },
    ...overrides
  };
}

function makeGate(overrides = {}) {
  return { passed: true, outcome: null, reasons: [], confidence: "high", ...overrides };
}

// ============================================================================
// Tier check functions
// ============================================================================

test("isFraudHold: gate fraud → true", () => {
  assert.equal(isFraudHold({ outcome: "FRAUD_HOLD" }, null), true);
});

test("isFraudHold: OFAC match → true", () => {
  const bs = makeBusinessSignals({ hardBlock: { blocked: true, reasons: ["OFAC_MATCH"] } });
  assert.equal(isFraudHold(null, bs), true);
});

test("isFraudHold: clean → false", () => {
  assert.equal(isFraudHold(makeGate(), makeBusinessSignals()), false);
});

test("isManualReview: gate manual → true", () => {
  assert.equal(isManualReview({ outcome: "MANUAL_REVIEW" }, makeConsumerSignals()), true);
});

test("isManualReview: null median → true", () => {
  const cs = makeConsumerSignals({
    scores: { median: null, bureauConfidence: "low", spread: 0, perBureau: {} }
  });
  assert.equal(isManualReview(makeGate(), cs), true);
});

test("isRepair: chargeoff severity → true", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      active: 1,
      chargeoffs: 1,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 5,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    }
  });
  assert.equal(isRepair(cs), true);
});

test("isRepair: active bankruptcy → true", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      active: 0,
      chargeoffs: 0,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 0,
      activeBankruptcy: true,
      dischargedBankruptcy: false,
      bankruptcyAge: 6
    }
  });
  assert.equal(isRepair(cs), true);
});

test("isRepair: low score → true", () => {
  const cs = makeConsumerSignals({
    scores: { median: 540, bureauConfidence: "low", spread: 0, perBureau: {} }
  });
  assert.equal(isRepair(cs), true);
});

test("isRepair: active 90+ → true", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      active: 1,
      chargeoffs: 0,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: 1,
      active120Plus: 0,
      worstSeverity: 3,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    }
  });
  assert.equal(isRepair(cs), true);
});

test("isRepair: critical util + active derog → true", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 9000, totalLimit: 10000, pct: 90, band: "critical" },
    derogatories: {
      active: 1,
      chargeoffs: 0,
      collections: 0,
      active30: 1,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 1,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    }
  });
  assert.equal(isRepair(cs), true);
});

test("isRepair: clean file → false", () => {
  assert.equal(isRepair(makeConsumerSignals()), false);
});

test("isFullStack: all conditions met → true", () => {
  assert.equal(isFullStack(makeConsumerSignals()), true);
});

test("isFullStack: score below 700 → false", () => {
  const cs = makeConsumerSignals({
    scores: { median: 690, bureauConfidence: "high", spread: 0, perBureau: {} }
  });
  assert.equal(isFullStack(cs), false);
});

test("isFullStack: high utilization → false", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 6000, totalLimit: 10000, pct: 60, band: "high" }
  });
  assert.equal(isFullStack(cs), false);
});

test("isFullStack: active derogatories → false", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      active: 1,
      chargeoffs: 0,
      collections: 0,
      active30: 1,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 1,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    }
  });
  assert.equal(isFullStack(cs), false);
});

test("isFullStack: thin file → false", () => {
  const cs = makeConsumerSignals({
    tradelines: {
      total: 2,
      primary: 2,
      au: 0,
      auDominance: 0,
      revolvingDepth: 1,
      installmentDepth: 0,
      mortgagePresent: false,
      depth: 2,
      thinFile: true
    }
  });
  assert.equal(isFullStack(cs), false);
});

test("isFullStack: AU dominant → false", () => {
  const cs = makeConsumerSignals({
    tradelines: {
      total: 10,
      primary: 3,
      au: 7,
      auDominance: 0.7,
      revolvingDepth: 2,
      installmentDepth: 0,
      mortgagePresent: false,
      depth: 3,
      thinFile: false
    }
  });
  assert.equal(isFullStack(cs), false);
});

test("isPremiumStack: all conditions met → true", () => {
  const cs = makeConsumerSignals({
    scores: { median: 780, bureauConfidence: "high", spread: 10, perBureau: {} },
    utilization: { totalBalance: 500, totalLimit: 20000, pct: 3, band: "excellent" },
    anchors: {
      revolving: { creditor: "AMEX", limit: 25000, openedDate: "2018-01-01", months: 96 },
      installment: null
    },
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
    inquiries: { total: 1, last6Mo: 0, last12Mo: 1, pressure: "low" }
  });
  assert.equal(isPremiumStack(cs), true);
});

test("isPremiumStack: score 740 → false", () => {
  const cs = makeConsumerSignals({
    scores: { median: 740, bureauConfidence: "high", spread: 10, perBureau: {} },
    utilization: { totalBalance: 500, totalLimit: 20000, pct: 3, band: "excellent" }
  });
  assert.equal(isPremiumStack(cs), false);
});

test("isPremiumStack: no revolving anchor → false", () => {
  const cs = makeConsumerSignals({
    scores: { median: 780, bureauConfidence: "high", spread: 10, perBureau: {} },
    utilization: { totalBalance: 500, totalLimit: 20000, pct: 3, band: "excellent" },
    anchors: { revolving: null, installment: null }
  });
  assert.equal(isPremiumStack(cs), false);
});

// ============================================================================
// Business boost
// ============================================================================

test("canApplyBusinessBoost: borderline score + strong business → true", () => {
  const cs = makeConsumerSignals({
    scores: { median: 690, bureauConfidence: "high", spread: 0, perBureau: {} }
  });
  const bs = makeBusinessSignals();
  assert.equal(canApplyBusinessBoost(cs, bs), true);
});

test("canApplyBusinessBoost: borderline util + strong business → true", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 3200, totalLimit: 10000, pct: 32, band: "moderate" }
  });
  const bs = makeBusinessSignals();
  assert.equal(canApplyBusinessBoost(cs, bs), true);
});

test("canApplyBusinessBoost: not borderline → false", () => {
  const cs = makeConsumerSignals({
    scores: { median: 650, bureauConfidence: "high", spread: 0, perBureau: {} }
  });
  const bs = makeBusinessSignals();
  assert.equal(canApplyBusinessBoost(cs, bs), false);
});

test("canApplyBusinessBoost: business blocked → false", () => {
  const cs = makeConsumerSignals({
    scores: { median: 690, bureauConfidence: "high", spread: 0, perBureau: {} }
  });
  const bs = makeBusinessSignals({ hardBlock: { blocked: true, reasons: ["BUSINESS_INACTIVE"] } });
  assert.equal(canApplyBusinessBoost(cs, bs), false);
});

test("canApplyBusinessBoost: weak intelliscore → false", () => {
  const cs = makeConsumerSignals({
    scores: { median: 690, bureauConfidence: "high", spread: 0, perBureau: {} }
  });
  const bs = makeBusinessSignals({
    scores: {
      intelliscore: 40,
      intelliscoreRisk: "HIGH RISK",
      fsr: 20,
      fsrRisk: "HIGH RISK",
      recommendedLimit: 10000
    }
  });
  assert.equal(canApplyBusinessBoost(cs, bs), false);
});

test("canApplyBusinessBoost: no business → false", () => {
  const cs = makeConsumerSignals({
    scores: { median: 690, bureauConfidence: "high", spread: 0, perBureau: {} }
  });
  assert.equal(canApplyBusinessBoost(cs, null), false);
  assert.equal(canApplyBusinessBoost(cs, { available: false }), false);
});

// ============================================================================
// Reason code collection
// ============================================================================

test("collectReasonCodes: clean file → SCORE_FULL_STACK_BAND only", () => {
  const reasons = collectReasonCodes(makeConsumerSignals(), makeBusinessSignals(), makeGate());
  // Score 720 emits SCORE_FULL_STACK_BAND (informational)
  assert.deepEqual(reasons, ["SCORE_FULL_STACK_BAND"]);
});

test("collectReasonCodes: accumulates multiple reasons", () => {
  const cs = makeConsumerSignals({
    scores: { median: 540, bureauConfidence: "low", spread: 0, perBureau: {} },
    tradelines: {
      total: 2,
      primary: 2,
      au: 0,
      auDominance: 0,
      revolvingDepth: 0,
      installmentDepth: 0,
      mortgagePresent: false,
      depth: 2,
      thinFile: true
    },
    derogatories: {
      active: 1,
      chargeoffs: 1,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: 1,
      active120Plus: 0,
      worstSeverity: 5,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    },
    utilization: { totalBalance: 9000, totalLimit: 10000, pct: 90, band: "critical" }
  });
  const reasons = collectReasonCodes(cs, makeBusinessSignals(), makeGate());
  assert.ok(reasons.includes("ACTIVE_CHARGEOFF"));
  assert.ok(reasons.includes("ACTIVE_60_PLUS"));
  assert.ok(reasons.includes("VERY_HIGH_UTILIZATION"));
  assert.ok(reasons.includes("SCORE_BELOW_FLOOR"));
  assert.ok(reasons.includes("THIN_FILE"));
  assert.ok(reasons.includes("LOW_PRIMARY_REVOLVING_DEPTH"));
  assert.ok(reasons.includes("SINGLE_BUREAU_LOW_CONFIDENCE"));
});

test("collectReasonCodes: identity flag from gate", () => {
  const reasons = collectReasonCodes(makeConsumerSignals(), null, {
    outcome: "MANUAL_REVIEW",
    reasons: ["NAME_MISMATCH"]
  });
  assert.ok(reasons.includes("ID_MISMATCH"));
});

test("collectReasonCodes: business hard block", () => {
  const bs = makeBusinessSignals({
    hardBlock: { blocked: true, reasons: ["BUSINESS_INACTIVE", "OFAC_MATCH"] }
  });
  const reasons = collectReasonCodes(makeConsumerSignals(), bs, makeGate());
  assert.ok(reasons.includes("BUSINESS_HARD_BLOCK"));
});

// ============================================================================
// routeOutcome — full integration
// ============================================================================

test("routeOutcome: clean file → FULL_STACK_APPROVAL", () => {
  const result = routeOutcome(makeConsumerSignals(), makeBusinessSignals(), makeGate());
  assert.equal(result.outcome, OUTCOMES.FULL_STACK_APPROVAL);
  assert.equal(result.confidence, "high");
  assert.equal(result.businessBoostApplied, false);
});

test("routeOutcome: premium file → PREMIUM_STACK", () => {
  const cs = makeConsumerSignals({
    scores: { median: 780, bureauConfidence: "high", spread: 10, perBureau: {} },
    utilization: { totalBalance: 500, totalLimit: 20000, pct: 3, band: "excellent" },
    anchors: {
      revolving: { creditor: "AMEX", limit: 25000, openedDate: "2018-01-01", months: 96 },
      installment: null
    },
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
    inquiries: { total: 1, last6Mo: 0, last12Mo: 1, pressure: "low" },
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
    }
  });
  const result = routeOutcome(cs, makeBusinessSignals(), makeGate());
  assert.equal(result.outcome, OUTCOMES.PREMIUM_STACK);
});

test("routeOutcome: fraud gate → FRAUD_HOLD", () => {
  const result = routeOutcome(makeConsumerSignals(), makeBusinessSignals(), {
    passed: false,
    outcome: "FRAUD_HOLD",
    reasons: ["HIGH_FRAUD_RISK_SCORE", "TUMBLING_RISK"],
    confidence: "high"
  });
  assert.equal(result.outcome, OUTCOMES.FRAUD_HOLD);
  assert.ok(result.reasonCodes.includes("FRAUD_HIGH_RISK"));
});

test("routeOutcome: OFAC match → FRAUD_HOLD", () => {
  const bs = makeBusinessSignals({ hardBlock: { blocked: true, reasons: ["OFAC_MATCH"] } });
  const result = routeOutcome(makeConsumerSignals(), bs, makeGate());
  assert.equal(result.outcome, OUTCOMES.FRAUD_HOLD);
});

test("routeOutcome: name mismatch → MANUAL_REVIEW", () => {
  const result = routeOutcome(makeConsumerSignals(), null, {
    passed: false,
    outcome: "MANUAL_REVIEW",
    reasons: ["NAME_MISMATCH"],
    confidence: "medium"
  });
  assert.equal(result.outcome, OUTCOMES.MANUAL_REVIEW);
});

test("routeOutcome: null score → MANUAL_REVIEW", () => {
  const cs = makeConsumerSignals({
    scores: { median: null, bureauConfidence: "low", spread: 0, perBureau: {} }
  });
  const result = routeOutcome(cs, null, makeGate());
  assert.equal(result.outcome, OUTCOMES.MANUAL_REVIEW);
});

test("routeOutcome: chargeoff → REPAIR", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      active: 0,
      chargeoffs: 1,
      collections: 1,
      active30: 0,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 5,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    }
  });
  const result = routeOutcome(cs, null, makeGate());
  assert.equal(result.outcome, OUTCOMES.REPAIR);
  assert.ok(result.reasonCodes.includes("ACTIVE_CHARGEOFF"));
});

test("routeOutcome: score 650, no derogs → CONDITIONAL_APPROVAL", () => {
  const cs = makeConsumerSignals({
    scores: { median: 650, bureauConfidence: "medium", spread: 30, perBureau: {} },
    utilization: { totalBalance: 3000, totalLimit: 10000, pct: 30, band: "moderate" }
  });
  const result = routeOutcome(cs, null, makeGate());
  assert.equal(result.outcome, OUTCOMES.CONDITIONAL_APPROVAL);
  assert.equal(result.confidence, "medium");
});

test("routeOutcome: business boost upgrades CONDITIONAL → FULL_STACK", () => {
  const cs = makeConsumerSignals({
    scores: { median: 690, bureauConfidence: "high", spread: 10, perBureau: {} },
    utilization: { totalBalance: 3000, totalLimit: 10000, pct: 30, band: "moderate" }
  });
  const bs = makeBusinessSignals();
  const result = routeOutcome(cs, bs, makeGate());
  assert.equal(result.outcome, OUTCOMES.FULL_STACK_APPROVAL);
  assert.equal(result.businessBoostApplied, true);
  assert.ok(result.businessBoostDetail.includes("intelliscore"));
});

test("routeOutcome: thin file → CONDITIONAL (not full stack)", () => {
  const cs = makeConsumerSignals({
    tradelines: {
      total: 2,
      primary: 2,
      au: 0,
      auDominance: 0,
      revolvingDepth: 1,
      installmentDepth: 0,
      mortgagePresent: false,
      depth: 2,
      thinFile: true
    }
  });
  const result = routeOutcome(cs, null, makeGate());
  assert.equal(result.outcome, OUTCOMES.CONDITIONAL_APPROVAL);
  assert.ok(result.reasonCodes.includes("THIN_FILE"));
});

test("routeOutcome: AU dominant → CONDITIONAL", () => {
  const cs = makeConsumerSignals({
    tradelines: {
      total: 10,
      primary: 3,
      au: 7,
      auDominance: 0.7,
      revolvingDepth: 2,
      installmentDepth: 0,
      mortgagePresent: false,
      depth: 3,
      thinFile: false
    }
  });
  const result = routeOutcome(cs, null, makeGate());
  assert.equal(result.outcome, OUTCOMES.CONDITIONAL_APPROVAL);
  assert.ok(result.reasonCodes.includes("AU_DOMINANT_FILE"));
});

test("routeOutcome: fraud takes precedence over repair", () => {
  const cs = makeConsumerSignals({
    scores: { median: 500, bureauConfidence: "low", spread: 0, perBureau: {} },
    derogatories: {
      active: 3,
      chargeoffs: 2,
      collections: 1,
      active30: 0,
      active60: 0,
      active90: 1,
      active120Plus: 0,
      worstSeverity: 5,
      activeBankruptcy: true,
      dischargedBankruptcy: false,
      bankruptcyAge: 3
    }
  });
  const gate = {
    passed: false,
    outcome: "FRAUD_HOLD",
    reasons: ["HIGH_FRAUD_RISK_SCORE", "TUMBLING_RISK"],
    confidence: "high"
  };
  const result = routeOutcome(cs, null, gate);
  assert.equal(result.outcome, OUTCOMES.FRAUD_HOLD); // fraud > repair
});

test("routeOutcome: null gate handled gracefully", () => {
  const result = routeOutcome(makeConsumerSignals(), null, null);
  assert.equal(result.outcome, OUTCOMES.FULL_STACK_APPROVAL);
});

// ============================================================================
// New reason codes — gap fix coverage
// ============================================================================

test("collectReasonCodes: REPORT_STALE when gate has ALL_REPORTS_STALE", () => {
  const gate = makeGate({ reasons: ["ALL_REPORTS_STALE"] });
  const reasons = collectReasonCodes(makeConsumerSignals(), null, gate);
  assert.ok(reasons.includes("REPORT_STALE"));
});

test("collectReasonCodes: FRAUD_UNKNOWN for postal/email flags without high fraud risk", () => {
  const gate = makeGate({ reasons: ["POSTAL_INVALID"] });
  const reasons = collectReasonCodes(makeConsumerSignals(), null, gate);
  assert.ok(reasons.includes("FRAUD_UNKNOWN"));
  assert.ok(!reasons.includes("FRAUD_HIGH_RISK"));
});

test("collectReasonCodes: FRAUD_UNKNOWN for EMAIL_INVALID without high fraud risk", () => {
  const gate = makeGate({ reasons: ["EMAIL_INVALID"] });
  const reasons = collectReasonCodes(makeConsumerSignals(), null, gate);
  assert.ok(reasons.includes("FRAUD_UNKNOWN"));
});

test("collectReasonCodes: FRAUD_UNKNOWN suppressed when FRAUD_HIGH_RISK present", () => {
  const gate = makeGate({ reasons: ["HIGH_FRAUD_RISK_SCORE", "POSTAL_INVALID"] });
  const reasons = collectReasonCodes(makeConsumerSignals(), null, gate);
  assert.ok(reasons.includes("FRAUD_HIGH_RISK"));
  assert.ok(!reasons.includes("FRAUD_UNKNOWN"));
});

test("collectReasonCodes: AGED_BANKRUPTCY for discharged bankruptcy age >= 24", () => {
  const cs = makeConsumerSignals({
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
      dischargedBankruptcy: true,
      bankruptcyAge: 30
    }
  });
  const reasons = collectReasonCodes(cs, null, makeGate());
  assert.ok(reasons.includes("AGED_BANKRUPTCY"));
  assert.ok(!reasons.includes("RECENT_BANKRUPTCY"));
});

test("collectReasonCodes: discharged bankruptcy < 24 months → RECENT_BANKRUPTCY", () => {
  const cs = makeConsumerSignals({
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
      dischargedBankruptcy: true,
      bankruptcyAge: 12
    }
  });
  const reasons = collectReasonCodes(cs, null, makeGate());
  assert.ok(reasons.includes("RECENT_BANKRUPTCY"));
  assert.ok(!reasons.includes("AGED_BANKRUPTCY"));
});

test("collectReasonCodes: RECENT_JUDGMENT_OR_LIEN when business has judgment/taxLien", () => {
  const bs = makeBusinessSignals({
    publicRecords: { bankruptcy: false, judgment: true, taxLien: false }
  });
  const reasons = collectReasonCodes(makeConsumerSignals(), bs, makeGate());
  assert.ok(reasons.includes("RECENT_JUDGMENT_OR_LIEN"));
});

test("collectReasonCodes: RECENT_JUDGMENT_OR_LIEN when business has taxLien", () => {
  const bs = makeBusinessSignals({
    publicRecords: { bankruptcy: false, judgment: false, taxLien: true }
  });
  const reasons = collectReasonCodes(makeConsumerSignals(), bs, makeGate());
  assert.ok(reasons.includes("RECENT_JUDGMENT_OR_LIEN"));
});

test("collectReasonCodes: INQUIRY_PRESSURE emitted for high pressure (not storm)", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 8, last6Mo: 7, last12Mo: 8, pressure: "high" }
  });
  const reasons = collectReasonCodes(cs, null, makeGate());
  assert.ok(reasons.includes("INQUIRY_PRESSURE"));
  assert.ok(!reasons.includes("INQUIRY_STORM"));
});

test("collectReasonCodes: INQUIRY_STORM emitted for storm pressure", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 15, last6Mo: 12, last12Mo: 15, pressure: "storm" }
  });
  const reasons = collectReasonCodes(cs, null, makeGate());
  assert.ok(reasons.includes("INQUIRY_STORM"));
});

test("collectReasonCodes: SCORE_CONDITIONAL_BAND for score 690", () => {
  const cs = makeConsumerSignals({
    scores: { median: 690, bureauConfidence: "high", spread: 10, perBureau: {} }
  });
  const reasons = collectReasonCodes(cs, null, makeGate());
  assert.ok(reasons.includes("SCORE_CONDITIONAL_BAND"));
  assert.ok(!reasons.includes("SCORE_FULL_STACK_BAND"));
});

test("collectReasonCodes: LOW_PRIMARY_REVOLVING_DEPTH for revolvingDepth < 2", () => {
  const cs = makeConsumerSignals({
    tradelines: {
      total: 5,
      primary: 5,
      au: 0,
      auDominance: 0,
      revolvingDepth: 1,
      installmentDepth: 2,
      mortgagePresent: false,
      depth: 5,
      thinFile: false
    }
  });
  const reasons = collectReasonCodes(cs, null, makeGate());
  assert.ok(reasons.includes("LOW_PRIMARY_REVOLVING_DEPTH"));
});

test("routeOutcome: BUSINESS_MODERATE_BOOST when business boost applied with intelliscore 70-79", () => {
  const cs = makeConsumerSignals({
    scores: { median: 690, bureauConfidence: "high", spread: 10, perBureau: {} },
    utilization: { totalBalance: 3000, totalLimit: 10000, pct: 30, band: "moderate" }
  });
  const bs = makeBusinessSignals({
    scores: {
      intelliscore: 75,
      intelliscoreRisk: "LOW TO MEDIUM RISK",
      fsr: 40,
      fsrRisk: "MEDIUM RISK",
      recommendedLimit: 100000
    }
  });
  const result = routeOutcome(cs, bs, makeGate());
  assert.equal(result.outcome, OUTCOMES.FULL_STACK_APPROVAL);
  assert.equal(result.businessBoostApplied, true);
  assert.ok(result.reasonCodes.includes("BUSINESS_MODERATE_BOOST"));
  assert.ok(!result.reasonCodes.includes("BUSINESS_STRONG_BOOST"));
});

test("routeOutcome: BUSINESS_STRONG_BOOST when business boost applied with intelliscore >= 80", () => {
  const cs = makeConsumerSignals({
    scores: { median: 690, bureauConfidence: "high", spread: 10, perBureau: {} },
    utilization: { totalBalance: 3000, totalLimit: 10000, pct: 30, band: "moderate" }
  });
  const bs = makeBusinessSignals({
    scores: {
      intelliscore: 85,
      intelliscoreRisk: "LOW RISK",
      fsr: 50,
      fsrRisk: "LOW RISK",
      recommendedLimit: 200000
    }
  });
  const result = routeOutcome(cs, bs, makeGate());
  assert.equal(result.outcome, OUTCOMES.FULL_STACK_APPROVAL);
  assert.equal(result.businessBoostApplied, true);
  assert.ok(result.reasonCodes.includes("BUSINESS_STRONG_BOOST"));
  assert.ok(!result.reasonCodes.includes("BUSINESS_MODERATE_BOOST"));
});
