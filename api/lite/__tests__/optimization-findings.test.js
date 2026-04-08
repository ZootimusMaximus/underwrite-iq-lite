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
      revolving: { creditor: "CHASE", limit: 15000, openedDate: "2020-01-01", months: 72 },
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

function makeTradeline(overrides = {}) {
  return {
    creditorName: "Test Bank",
    accountType: "revolving",
    status: "open",
    isAU: false,
    isDerogatory: false,
    currentBalance: 500,
    effectiveLimit: 10000,
    creditLimit: 10000,
    openedDate: "2020-01-01",
    latePayments: { _30: 0, _60: 0, _90: 0 },
    currentRatingType: "AsAgreed",
    currentRatingCode: "1",
    ratingSeverity: 0,
    adverseRatings: null,
    comments: [],
    source: "experian",
    ...overrides
  };
}

// ============================================================================
// Utilization
// ============================================================================

test("high utilization → UTIL_OVERALL_HIGH", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 7000, totalLimit: 10000, pct: 70, band: "high" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const util = findings.find(f => f.code === "UTIL_OVERALL_HIGH");
  assert.ok(util);
  assert.equal(util.severity, "high");
  assert.ok(util.plainEnglishProblem.includes("70%"));
});

test("critical utilization → UTIL_OVERALL_HIGH critical", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 9000, totalLimit: 10000, pct: 90, band: "critical" }
  });
  const findings = buildOptimizationFindings(cs, null, "REPAIR", {});
  const util = findings.find(f => f.code === "UTIL_OVERALL_HIGH");
  assert.ok(util);
  assert.equal(util.severity, "critical");
});

test("utilization 10-30% → UTIL_GOOD_BUT_NOT_IDEAL", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 4000, totalLimit: 20000, pct: 20, band: "good" }
  });
  const findings = buildOptimizationFindings(cs, null, "FULL_STACK_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "UTIL_GOOD_BUT_NOT_IDEAL"));
});

test("per-card utilization → UTIL_CARD_OVER_10", () => {
  const tradelines = [
    makeTradeline({ creditorName: "Chase", currentBalance: 8700, effectiveLimit: 10000 }),
    makeTradeline({ creditorName: "Discover", currentBalance: 200, effectiveLimit: 5000 })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "CONDITIONAL_APPROVAL",
    {},
    { tradelines }
  );
  const chase = findings.find(
    f => f.code === "UTIL_CARD_OVER_10" && f.accountData?.creditorName === "Chase"
  );
  assert.ok(chase, "Should emit UTIL_CARD_OVER_10 for Chase at 87%");
  const discover = findings.find(
    f => f.code === "UTIL_CARD_OVER_10" && f.accountData?.creditorName === "Discover"
  );
  assert.equal(discover, undefined, "Should NOT emit for Discover at 4%");
});

test("AU card high util → UTIL_AU_DRAGGING", () => {
  const tradelines = [
    makeTradeline({ creditorName: "Citi", isAU: true, currentBalance: 8500, effectiveLimit: 10000 })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "CONDITIONAL_APPROVAL",
    {},
    { tradelines }
  );
  assert.ok(findings.find(f => f.code === "UTIL_AU_DRAGGING"));
});

// ============================================================================
// Negative Items — Per Item
// ============================================================================

test("chargeoff tradelines → CHARGEOFF_ITEM per item", () => {
  const tradelines = [
    makeTradeline({
      creditorName: "Synchrony",
      currentRatingType: "ChargeOff",
      currentBalance: 3400,
      openedDate: "2019-06-01"
    }),
    makeTradeline({
      creditorName: "Capital One",
      currentRatingType: "ChargeOff",
      currentBalance: 1200
    })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals({ derogatories: { ...makeConsumerSignals().derogatories, chargeoffs: 2 } }),
    null,
    "REPAIR",
    {},
    { tradelines }
  );
  const cofs = findings.filter(f => f.code === "CHARGEOFF_ITEM");
  assert.equal(cofs.length, 2, "Should emit one finding per chargeoff");
  assert.ok(cofs[0].plainEnglishProblem.includes("Synchrony"));
  assert.ok(cofs[1].plainEnglishProblem.includes("Capital One"));
});

test("collection tradelines → COLLECTION_ITEM per item", () => {
  const tradelines = [
    makeTradeline({
      creditorName: "Midland Credit",
      currentBalance: 2100,
      adverseRatings: { highest: { type: "CollectionOrChargeOff" } }
    })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "REPAIR",
    {},
    { tradelines }
  );
  assert.ok(findings.find(f => f.code === "COLLECTION_ITEM"));
});

test("medical collection → MEDICAL_COLLECTION", () => {
  const tradelines = [
    makeTradeline({
      creditorName: "Memorial Hospital",
      currentBalance: 1200,
      adverseRatings: { highest: { type: "CollectionOrChargeOff" } }
    })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "REPAIR",
    {},
    { tradelines }
  );
  assert.ok(findings.find(f => f.code === "MEDICAL_COLLECTION"));
  assert.equal(
    findings.find(f => f.code === "COLLECTION_ITEM"),
    undefined,
    "Medical should not also emit COLLECTION_ITEM"
  );
});

test("late payments → LATE_PAYMENT_ITEM per account", () => {
  const tradelines = [
    makeTradeline({ creditorName: "Capital One", latePayments: { _30: 2, _60: 0, _90: 0 } }),
    makeTradeline({ creditorName: "Discover", latePayments: { _30: 0, _60: 1, _90: 1 } })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "REPAIR",
    {},
    { tradelines }
  );
  const lates = findings.filter(f => f.code === "LATE_PAYMENT_ITEM");
  assert.equal(lates.length, 2);
});

test("active bankruptcy → BANKRUPTCY_ACTIVE", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      ...makeConsumerSignals().derogatories,
      activeBankruptcy: true,
      bankruptcyAge: 6
    }
  });
  const findings = buildOptimizationFindings(cs, null, "REPAIR", {});
  const bk = findings.find(f => f.code === "BANKRUPTCY_ACTIVE");
  assert.ok(bk);
  assert.equal(bk.severity, "critical");
});

test("discharged bankruptcy → BANKRUPTCY_DISCHARGED", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      ...makeConsumerSignals().derogatories,
      dischargedBankruptcy: true,
      bankruptcyAge: 36
    }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "BANKRUPTCY_DISCHARGED"));
});

// ============================================================================
// Tradeline Depth
// ============================================================================

test("no revolving anchor → NO_REVOLVING_ANCHOR", () => {
  const cs = makeConsumerSignals({ anchors: { revolving: null, installment: null } });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "NO_REVOLVING_ANCHOR"));
});

test("thin file → THIN_FILE", () => {
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

test("no installment → NO_INSTALLMENT", () => {
  const cs = makeConsumerSignals({
    tradelines: {
      ...makeConsumerSignals().tradelines,
      installmentDepth: 0,
      revolvingDepth: 4
    }
  });
  const findings = buildOptimizationFindings(cs, null, "FULL_STACK_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "NO_INSTALLMENT"));
});

// ============================================================================
// AU Management
// ============================================================================

test("AU dominant (>40%) → AU_DOMINANT", () => {
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

// ============================================================================
// Inquiries
// ============================================================================

test("inquiry storm (10+) → INQUIRY_STORM", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 15, last6Mo: 12, last12Mo: 15, pressure: "storm" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const inq = findings.find(f => f.code === "INQUIRY_STORM");
  assert.ok(inq);
  assert.equal(inq.severity, "high");
});

test("inquiry high (6-9) → INQUIRY_HIGH", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 8, last6Mo: 7, last12Mo: 8, pressure: "high" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "INQUIRY_HIGH"));
});

// ============================================================================
// Strategic
// ============================================================================

test("fundable outcome → FUNDING_FIRST", () => {
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FULL_STACK_APPROVAL",
    {}
  );
  assert.ok(findings.find(f => f.code === "FUNDING_FIRST"));
});

test("score near 700 → SCORE_NEAR_THRESHOLD", () => {
  const cs = makeConsumerSignals({
    scores: { median: 692, bureauConfidence: "high", spread: 10, perBureau: {} }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const near = findings.find(f => f.code === "SCORE_NEAR_THRESHOLD");
  assert.ok(near);
  assert.ok(near.plainEnglishProblem.includes("692"));
});

test("premium stack → PREMIUM_MAINTENANCE", () => {
  const findings = buildOptimizationFindings(makeConsumerSignals(), null, "PREMIUM_STACK", {});
  assert.ok(findings.find(f => f.code === "PREMIUM_MAINTENANCE"));
});

test("strong anchor → STRONG_ANCHOR", () => {
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FULL_STACK_APPROVAL",
    {}
  );
  assert.ok(findings.find(f => f.code === "STRONG_ANCHOR"));
});

// ============================================================================
// System / Identity
// ============================================================================

test("fraud hold → IDENTITY_FRAUD", () => {
  const findings = buildOptimizationFindings(makeConsumerSignals(), null, "FRAUD_HOLD", {});
  assert.ok(findings.find(f => f.code === "IDENTITY_FRAUD"));
});

test("STALE_REPORT via identityGate", () => {
  const identityGate = {
    passed: false,
    outcome: "MANUAL_REVIEW",
    reasons: ["ALL_REPORTS_STALE"],
    confidence: "medium"
  };
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "MANUAL_REVIEW",
    {},
    { identityGate }
  );
  const stale = findings.find(f => f.code === "STALE_REPORT");
  assert.ok(stale);
  assert.equal(stale.severity, "high");
  assert.equal(stale.category, "data_quality");
});

// ============================================================================
// Business
// ============================================================================

test("weak business → WEAK_INTELLISCORE", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 30, fsr: 20 },
    profile: { ageMonths: 36, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: {}
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "CONDITIONAL_APPROVAL", {});
  assert.ok(findings.find(f => f.code === "WEAK_INTELLISCORE"));
});

test("young business → LLC_YOUNG", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 70, fsr: 50 },
    profile: { ageMonths: 6, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: {}
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "FULL_STACK_APPROVAL", {});
  const llc = findings.find(f => f.code === "LLC_YOUNG");
  assert.ok(llc);
  assert.ok(llc.plainEnglishProblem.includes("6 months"));
});

test("UCC caution → BIZ_UCC_FILINGS", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 70, fsr: 50 },
    profile: { ageMonths: 36, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: {},
    ucc: { caution: true }
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "CONDITIONAL_APPROVAL", {});
  const ucc = findings.find(f => f.code === "BIZ_UCC_FILINGS");
  assert.ok(ucc);
  assert.equal(ucc.severity, "medium");
  assert.equal(ucc.customerSafe, false);
});

test("no LLC data → skip business findings", () => {
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FULL_STACK_APPROVAL",
    {}
  );
  const bizFindings = findings.filter(f => f.category === "business");
  assert.equal(bizFindings.length, 0, "No business findings when no LLC data");
});

test("formData young LLC → LLC_YOUNG", () => {
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "CONDITIONAL_APPROVAL",
    {},
    { formData: { hasLLC: true, llcAgeMonths: 8 } }
  );
  const llc = findings.find(f => f.code === "LLC_YOUNG");
  assert.ok(llc);
  assert.ok(llc.plainEnglishProblem.includes("8 months"));
});

test("formData mature LLC → no LLC finding", () => {
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "CONDITIONAL_APPROVAL",
    {},
    { formData: { hasLLC: true, llcAgeMonths: 24 } }
  );
  const llc = findings.find(f => f.code === "LLC_YOUNG");
  assert.equal(llc, undefined);
});

// ============================================================================
// Finding structure
// ============================================================================

test("finding structure complete", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 7000, totalLimit: 10000, pct: 70, band: "high" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const util = findings.find(f => f.code === "UTIL_OVERALL_HIGH");

  assert.ok(util.code);
  assert.ok(util.severity);
  assert.ok(util.category);
  assert.ok(util.plainEnglishProblem);
  assert.ok(util.whyItMatters);
  assert.ok(util.whatToDoNext);
  assert.equal(typeof util.customerSafe, "boolean");
  assert.ok(Array.isArray(util.workflowTags));
  assert.ok(Array.isArray(util.documentTriggers));
});

test("UTIL_OVERALL_HIGH has docs=[balance_reduction_guidance]", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 7000, totalLimit: 10000, pct: 70, band: "high" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const util = findings.find(f => f.code === "UTIL_OVERALL_HIGH");
  assert.ok(util);
  assert.ok(util.documentTriggers.includes("balance_reduction_guidance"));
});

test("INQUIRY_STORM has docs=[inquiry_removal_letter]", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 15, last6Mo: 12, last12Mo: 15, pressure: "storm" }
  });
  const findings = buildOptimizationFindings(cs, null, "CONDITIONAL_APPROVAL", {});
  const inq = findings.find(f => f.code === "INQUIRY_STORM");
  assert.ok(inq);
  assert.ok(inq.documentTriggers.includes("inquiry_removal_letter"));
});

// ============================================================================
// Options param with tradelines + identityGate
// ============================================================================

test("options param passes tradelines and identityGate", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      ...makeConsumerSignals().derogatories,
      active: 1,
      worstSeverity: 1
    }
  });
  const tradelines = [makeTradeline({ creditorName: "CHILD SUPPORT ENFORCEMENT" })];
  const identityGate = {
    passed: false,
    outcome: "MANUAL_REVIEW",
    reasons: ["ALL_REPORTS_STALE"],
    confidence: "medium"
  };

  const findings = buildOptimizationFindings(cs, null, "REPAIR", {}, { tradelines, identityGate });

  const support = findings.find(f => f.code === "SUPPORT_DELINQUENCY");
  assert.ok(support, "SUPPORT_DELINQUENCY via options.tradelines");

  const stale = findings.find(f => f.code === "STALE_REPORT");
  assert.ok(stale, "STALE_REPORT via options.identityGate");
});

// ============================================================================
// Personal data cleanup
// ============================================================================

test("multiple addresses → MULTIPLE_ADDRESSES", () => {
  const identity = {
    addresses: [
      { line1: "123 Main St", zip: "85233" },
      { line1: "456 Oak Ave", zip: "85234" }
    ],
    names: [{ first: "Chris", last: "Smith" }],
    employers: []
  };
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FULL_STACK_APPROVAL",
    {},
    { identity }
  );
  assert.ok(findings.find(f => f.code === "MULTIPLE_ADDRESSES"));
});

test("name variations → NAME_VARIATIONS", () => {
  const identity = {
    addresses: [{ line1: "123 Main St", zip: "85233" }],
    names: [
      { first: "Chris", last: "Smith" },
      { first: "Christopher", last: "Smith" }
    ],
    employers: []
  };
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FULL_STACK_APPROVAL",
    {},
    { identity }
  );
  assert.ok(findings.find(f => f.code === "NAME_VARIATIONS"));
});
