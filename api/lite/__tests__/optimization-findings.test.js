const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOptimizationFindings } = require("../crs/optimization-findings");

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
      revolving: { creditor: "BANK", limit: 15000, openedDate: "2020-01-01", months: 72 },
      installment: null
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

// ============================================================================
// Tests
// ============================================================================

test("buildOptimizationFindings: clean file → minimal findings", () => {
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FULL_STACK_APPROVAL",
    {}
  );
  // Should only find NO_LLC_YOUNG_LLC (no business)
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "NO_LLC_YOUNG_LLC");
  assert.equal(findings[0].severity, "low");
});

test("buildOptimizationFindings: high utilization → UTIL_STRESS", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 7000, totalLimit: 10000, pct: 70, band: "high" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const util = findings.find(f => f.code === "UTIL_STRESS");
  assert.ok(util);
  assert.equal(util.severity, "high");
  assert.ok(util.plainEnglishProblem.includes("70%"));
});

test("buildOptimizationFindings: critical utilization", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 9000, totalLimit: 10000, pct: 90, band: "critical" }
  });
  const findings = buildOptimizationFindings(cs, null, "REPAIR", {});
  const util = findings.find(f => f.code === "UTIL_STRESS");
  assert.ok(util);
  assert.equal(util.severity, "critical");
});

test("buildOptimizationFindings: no revolving anchor", () => {
  const cs = makeConsumerSignals({ anchors: { revolving: null, installment: null } });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "NO_REVOLVING_ANCHOR"));
});

test("buildOptimizationFindings: thin file", () => {
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
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "THIN_FILE"));
});

test("buildOptimizationFindings: inquiry storm", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 15, last6Mo: 12, last12Mo: 15, pressure: "storm" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const inq = findings.find(f => f.code === "INQUIRY_PRESSURE");
  assert.ok(inq);
  assert.equal(inq.severity, "high");
});

test("buildOptimizationFindings: chargeoff + collection", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      active: 0,
      chargeoffs: 2,
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
  const findings = buildOptimizationFindings(cs, null, "REPAIR", {});
  assert.ok(findings.find(f => f.code === "ACTIVE_CHARGEOFF"));
  assert.ok(findings.find(f => f.code === "ACTIVE_COLLECTION"));
});

test("buildOptimizationFindings: active 90+ days late", () => {
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
  const findings = buildOptimizationFindings(cs, null, "REPAIR", {});
  assert.ok(findings.find(f => f.code === "ACTIVE_60_90_120"));
});

test("buildOptimizationFindings: active bankruptcy", () => {
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
  const findings = buildOptimizationFindings(cs, null, "REPAIR", {});
  const bk = findings.find(f => f.code === "BANKRUPTCY_LIEN_JUDGMENT");
  assert.ok(bk);
  assert.equal(bk.severity, "critical");
});

test("buildOptimizationFindings: AU dominant", () => {
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
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "AU_DOMINANT"));
});

test("buildOptimizationFindings: fraud hold → IDENTITY_FRAUD", () => {
  const findings = buildOptimizationFindings(makeConsumerSignals(), null, "FRAUD_HOLD", {});
  assert.ok(findings.find(f => f.code === "IDENTITY_FRAUD"));
});

test("buildOptimizationFindings: weak business", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 30, fsr: 20 },
    profile: { ageMonths: 36, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: {}
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "CONDITIONAL_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "WEAK_BUSINESS"));
});

test("buildOptimizationFindings: young business", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 70, fsr: 50 },
    profile: { ageMonths: 6, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: {}
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "FULL_STACK_APPROVAL", {});
  const llc = findings.find(f => f.code === "NO_LLC_YOUNG_LLC");
  assert.ok(llc);
  assert.ok(llc.plainEnglishProblem.includes("6 months"));
});

test("buildOptimizationFindings: finding structure complete", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 7000, totalLimit: 10000, pct: 70, band: "high" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const util = findings.find(f => f.code === "UTIL_STRESS");

  assert.ok(util.code);
  assert.ok(util.severity);
  assert.ok(util.category);
  assert.ok(util.plainEnglishProblem);
  assert.ok(util.whyItMatters);
  assert.ok(util.whatToDoNext);
  assert.equal(typeof util.customerSafe, "boolean");
  assert.ok(Array.isArray(util.workflowTags));
});

// ============================================================================
// STALE_REPORT via 5th param options.identityGate
// ============================================================================

test("buildOptimizationFindings: STALE_REPORT when identityGate has ALL_REPORTS_STALE", () => {
  const cs = makeConsumerSignals();
  const identityGate = {
    passed: false,
    outcome: "MANUAL_REVIEW",
    reasons: ["ALL_REPORTS_STALE"],
    confidence: "medium"
  };
  const findings = buildOptimizationFindings(cs, null, "MANUAL_REVIEW", {}, { identityGate });
  const stale = findings.find(f => f.code === "STALE_REPORT");
  assert.ok(stale, "STALE_REPORT finding should be generated");
  assert.equal(stale.severity, "high");
  assert.equal(stale.category, "data_quality");
});

// ============================================================================
// Document triggers populated
// ============================================================================

test("buildOptimizationFindings: UTIL_STRESS has docs=[balance_reduction_guidance]", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 7000, totalLimit: 10000, pct: 70, band: "high" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const util = findings.find(f => f.code === "UTIL_STRESS");
  assert.ok(util);
  assert.ok(Array.isArray(util.documentTriggers));
  assert.ok(util.documentTriggers.includes("balance_reduction_guidance"));
});

test("buildOptimizationFindings: INQUIRY_PRESSURE has docs=[inquiry_removal_letter]", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 15, last6Mo: 12, last12Mo: 15, pressure: "storm" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const inq = findings.find(f => f.code === "INQUIRY_PRESSURE");
  assert.ok(inq);
  assert.ok(Array.isArray(inq.documentTriggers));
  assert.ok(inq.documentTriggers.includes("inquiry_removal_letter"));
});

// ============================================================================
// 5th param (options) works with tradelines and identityGate
// ============================================================================

test("buildOptimizationFindings: 5th param options passes tradelines and identityGate", () => {
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
  const tradelines = [{ creditorName: "CHILD SUPPORT ENFORCEMENT", balance: 5000 }];
  const identityGate = {
    passed: false,
    outcome: "MANUAL_REVIEW",
    reasons: ["ALL_REPORTS_STALE"],
    confidence: "medium"
  };

  const findings = buildOptimizationFindings(cs, null, "REPAIR", {}, { tradelines, identityGate });

  // Should find SUPPORT_DELINQUENCY from tradelines
  const support = findings.find(f => f.code === "SUPPORT_DELINQUENCY");
  assert.ok(support, "SUPPORT_DELINQUENCY finding should be generated via options.tradelines");

  // Should find STALE_REPORT from identityGate
  const stale = findings.find(f => f.code === "STALE_REPORT");
  assert.ok(stale, "STALE_REPORT finding should be generated via options.identityGate");
});

// ============================================================================
// Second audit fix pass — new feature tests
// ============================================================================

test("buildOptimizationFindings: BUSINESS_UCC_CAUTION when bs.ucc.caution is true", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 70, fsr: 50 },
    profile: { ageMonths: 36, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: {},
    ucc: { caution: true }
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "CONDITIONAL_APPROVAL", {});
  const ucc = findings.find(f => f.code === "BUSINESS_UCC_CAUTION");
  assert.ok(ucc, "BUSINESS_UCC_CAUTION finding should be generated");
  assert.equal(ucc.severity, "medium");
  assert.equal(ucc.category, "business");
  assert.equal(ucc.customerSafe, false);
});

test("buildOptimizationFindings: formData fallback for NO_LLC_YOUNG_LLC — young LLC (< 12 months)", () => {
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "CONDITIONAL_APPROVAL",
    {},
    { formData: { hasLLC: true, llcAgeMonths: 8 } }
  );
  const llc = findings.find(f => f.code === "NO_LLC_YOUNG_LLC");
  assert.ok(llc, "NO_LLC_YOUNG_LLC finding should be generated for young LLC via formData");
  assert.equal(llc.severity, "low");
  assert.ok(
    llc.plainEnglishProblem.includes("8 months"),
    "Problem text should include LLC age from formData"
  );
});

test("buildOptimizationFindings: formData fallback for NO_LLC_YOUNG_LLC — mature LLC (≥ 12 months) → no finding", () => {
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "CONDITIONAL_APPROVAL",
    {},
    { formData: { hasLLC: true, llcAgeMonths: 24 } }
  );
  const llc = findings.find(f => f.code === "NO_LLC_YOUNG_LLC");
  assert.equal(llc, undefined, "NO_LLC_YOUNG_LLC should NOT be generated for mature LLC");
});
