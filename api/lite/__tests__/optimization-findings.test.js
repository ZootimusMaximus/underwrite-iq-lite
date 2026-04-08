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
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
  const util = findings.find(f => f.code === "UTIL_OVERALL_HIGH");
  assert.ok(util);
  assert.equal(util.severity, "high");
  assert.ok(util.plainEnglishProblem.includes("70%"));
});

test("critical utilization → UTIL_OVERALL_HIGH critical", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 9000, totalLimit: 10000, pct: 90, band: "critical" }
  });
  const findings = buildOptimizationFindings(cs, null, "REPAIR_ONLY", {});
  const util = findings.find(f => f.code === "UTIL_OVERALL_HIGH");
  assert.ok(util);
  assert.equal(util.severity, "critical");
});

test("utilization 10-30% → UTIL_MODERATE", () => {
  const cs = makeConsumerSignals({
    utilization: { totalBalance: 4000, totalLimit: 20000, pct: 20, band: "good" }
  });
  const findings = buildOptimizationFindings(cs, null, "FULL_FUNDING", {});
  assert.ok(findings.find(f => f.code === "UTIL_MODERATE"));
});

test("per-card utilization → UTIL_CARD_OVER_10", () => {
  const tradelines = [
    makeTradeline({ creditorName: "Chase", currentBalance: 8700, effectiveLimit: 10000 }),
    makeTradeline({ creditorName: "Discover", currentBalance: 200, effectiveLimit: 5000 })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FUNDING_PLUS_REPAIR",
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

test("AU card high util → AU_HIGH_UTIL (>30% threshold)", () => {
  const tradelines = [
    makeTradeline({ creditorName: "Citi", isAU: true, currentBalance: 8500, effectiveLimit: 10000 })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FUNDING_PLUS_REPAIR",
    {},
    { tradelines }
  );
  assert.ok(findings.find(f => f.code === "AU_HIGH_UTIL"));
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
    "REPAIR_ONLY",
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
    "REPAIR_ONLY",
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
    "REPAIR_ONLY",
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

test("late payments → LATE_PAYMENT_RECENT or LATE_PAYMENT_OLD per account", () => {
  // openedDate within 12 months → LATE_PAYMENT_RECENT
  const recentDate = new Date();
  recentDate.setMonth(recentDate.getMonth() - 6);
  // openedDate older than 12 months → LATE_PAYMENT_OLD
  const oldDate = new Date();
  oldDate.setMonth(oldDate.getMonth() - 18);
  const tradelines = [
    makeTradeline({
      creditorName: "Capital One",
      openedDate: recentDate.toISOString().substring(0, 10),
      latePayments: { _30: 2, _60: 0, _90: 0 }
    }),
    makeTradeline({
      creditorName: "Discover",
      openedDate: oldDate.toISOString().substring(0, 10),
      latePayments: { _30: 0, _60: 1, _90: 1 }
    })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "REPAIR_ONLY",
    {},
    { tradelines }
  );
  const recent = findings.filter(f => f.code === "LATE_PAYMENT_RECENT");
  const old = findings.filter(f => f.code === "LATE_PAYMENT_OLD");
  assert.equal(recent.length, 1, "Should emit LATE_PAYMENT_RECENT for recent account");
  assert.ok(recent[0].plainEnglishProblem.includes("Capital One"));
  assert.equal(old.length, 1, "Should emit LATE_PAYMENT_OLD for old account");
  assert.ok(old[0].plainEnglishProblem.includes("Discover"));
});

test("active bankruptcy → BANKRUPTCY_ACTIVE", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      ...makeConsumerSignals().derogatories,
      activeBankruptcy: true,
      bankruptcyAge: 6
    }
  });
  const findings = buildOptimizationFindings(cs, null, "REPAIR_ONLY", {});
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
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
  assert.ok(findings.find(f => f.code === "BANKRUPTCY_DISCHARGED"));
});

// ============================================================================
// Tradeline Depth
// ============================================================================

test("no revolving anchor → NO_REVOLVING_ANCHOR", () => {
  const cs = makeConsumerSignals({ anchors: { revolving: null, installment: null } });
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
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
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
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
  const findings = buildOptimizationFindings(cs, null, "FULL_FUNDING", {});
  assert.ok(findings.find(f => f.code === "NO_INSTALLMENT"));
});

// ============================================================================
// AU Management
// ============================================================================

test("AU with lates/derogs → AU_NEGATIVE_MARKS (severity high)", () => {
  const tradelines = [
    makeTradeline({
      creditorName: "Citi",
      isAU: true,
      currentBalance: 500,
      effectiveLimit: 5000,
      latePayments: { _30: 1, _60: 0, _90: 0 }
    })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FUNDING_PLUS_REPAIR",
    {},
    { tradelines }
  );
  const f = findings.find(f => f.code === "AU_NEGATIVE_MARKS");
  assert.ok(f);
  assert.equal(f.severity, "high");
});

test("good AU (util <10%) → AU_GOOD_KEEP", () => {
  const oldDate = new Date();
  oldDate.setMonth(oldDate.getMonth() - 48);
  const tradelines = [
    makeTradeline({
      creditorName: "Chase",
      isAU: true,
      currentBalance: 50,
      effectiveLimit: 10000,
      openedDate: oldDate.toISOString().substring(0, 10),
      latePayments: { _30: 0, _60: 0, _90: 0 }
    })
  ];
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FULL_FUNDING",
    {},
    { tradelines }
  );
  assert.ok(findings.find(f => f.code === "AU_GOOD_KEEP"));
});

// ============================================================================
// Inquiries
// ============================================================================

test("any inquiries → INQUIRY_REMOVAL (severity medium)", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 1, last6Mo: 1, last12Mo: 1, pressure: "low" }
  });
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
  const inq = findings.find(f => f.code === "INQUIRY_REMOVAL");
  assert.ok(inq);
  assert.equal(inq.severity, "medium");
});

test("INQUIRY_REMOVAL says does not affect funding", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 5, last6Mo: 5, last12Mo: 5, pressure: "high" }
  });
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
  const inq = findings.find(f => f.code === "INQUIRY_REMOVAL");
  assert.ok(inq);
  assert.ok(
    inq.whyItMatters.toLowerCase().includes("does not affect funding"),
    "Should state inquiries do not affect funding"
  );
});

test("many inquiries → still single INQUIRY_REMOVAL finding", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 15, last6Mo: 12, last12Mo: 15, pressure: "storm" }
  });
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
  const inqFindings = findings.filter(f => f.code === "INQUIRY_REMOVAL");
  assert.equal(inqFindings.length, 1, "Should only emit one INQUIRY_REMOVAL regardless of count");
});

test("no inquiries → no INQUIRY_REMOVAL", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 0, last6Mo: 0, last12Mo: 0, pressure: "none" }
  });
  const findings = buildOptimizationFindings(cs, null, "FULL_FUNDING", {});
  assert.equal(
    findings.find(f => f.code === "INQUIRY_REMOVAL"),
    undefined
  );
});

// ============================================================================
// Strategic
// ============================================================================

test("fundable outcome → FUNDING_FIRST", () => {
  const findings = buildOptimizationFindings(makeConsumerSignals(), null, "FULL_FUNDING", {});
  assert.ok(findings.find(f => f.code === "FUNDING_FIRST"));
});

test("FUNDING_PLUS_REPAIR with mixed bureaus → MIXED_BUREAU_STATUS", () => {
  const cs = makeConsumerSignals({
    bureauNegatives: {
      experian: { pulled: true, clean: true },
      equifax: { pulled: true, clean: false },
      transunion: { pulled: false, clean: false }
    }
  });
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
  const mixed = findings.find(f => f.code === "MIXED_BUREAU_STATUS");
  assert.ok(mixed);
  assert.equal(mixed.severity, "high");
});

test("REPAIR_ONLY → ALL_BUREAUS_DIRTY (critical)", () => {
  const findings = buildOptimizationFindings(makeConsumerSignals(), null, "REPAIR_ONLY", {});
  const dirty = findings.find(f => f.code === "ALL_BUREAUS_DIRTY");
  assert.ok(dirty);
  assert.equal(dirty.severity, "critical");
});

test("premium stack → PREMIUM_MAINTENANCE", () => {
  const findings = buildOptimizationFindings(makeConsumerSignals(), null, "PREMIUM_STACK", {});
  assert.ok(findings.find(f => f.code === "PREMIUM_MAINTENANCE"));
});

test("strong anchor → STRONG_ANCHOR", () => {
  const findings = buildOptimizationFindings(makeConsumerSignals(), null, "FULL_FUNDING", {});
  assert.ok(findings.find(f => f.code === "STRONG_ANCHOR"));
});

// ============================================================================
// System / Identity
// ============================================================================

test("FRAUD_HOLD → no IDENTITY_FRAUD finding (handled by tier, not findings)", () => {
  // IDENTITY_FRAUD removed in v4 — handled by FRAUD_HOLD outcome tier
  const findings = buildOptimizationFindings(makeConsumerSignals(), null, "FRAUD_HOLD", {});
  assert.equal(
    findings.find(f => f.code === "IDENTITY_FRAUD"),
    undefined
  );
});

test("STALE_REPORT removed in v4", () => {
  // STALE_REPORT removed in v4 — handled upstream
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
  assert.equal(
    findings.find(f => f.code === "STALE_REPORT"),
    undefined
  );
});

// ============================================================================
// Business
// ============================================================================

test("business with negative items → BIZ_NEGATIVE_ITEMS", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 30, fsr: 20 },
    profile: { ageMonths: 36, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: { judgment: true }
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "FUNDING_PLUS_REPAIR", {});
  assert.ok(findings.find(f => f.code === "BIZ_NEGATIVE_ITEMS"));
});

test("business util high → BIZ_UTIL_HIGH", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 70, fsr: 50 },
    profile: { ageMonths: 36, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: {},
    bizUtilization: { pct: 45, band: "high" }
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "FULL_FUNDING", {});
  const f = findings.find(f => f.code === "BIZ_UTIL_HIGH");
  assert.ok(f);
  assert.equal(f.severity, "medium");
});

test("young business → LLC_YOUNG", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 70, fsr: 50 },
    profile: { ageMonths: 6, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: {}
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "FULL_FUNDING", {});
  const llc = findings.find(f => f.code === "LLC_YOUNG");
  assert.ok(llc);
  assert.ok(llc.plainEnglishProblem.includes("6 months"));
});

test("UCC caution → BIZ_UCC_LIEN (customerSafe: true)", () => {
  const bs = {
    available: true,
    scores: { intelliscore: 70, fsr: 50 },
    profile: { ageMonths: 36, isActive: true },
    hardBlock: { blocked: false, reasons: [] },
    publicRecords: {},
    ucc: { caution: true }
  };
  const findings = buildOptimizationFindings(makeConsumerSignals(), bs, "FUNDING_PLUS_REPAIR", {});
  const ucc = findings.find(f => f.code === "BIZ_UCC_LIEN");
  assert.ok(ucc);
  assert.equal(ucc.severity, "medium");
  assert.equal(ucc.customerSafe, true);
});

test("no LLC data → NO_BUSINESS_ENTITY emitted", () => {
  const findings = buildOptimizationFindings(makeConsumerSignals(), null, "FULL_FUNDING", {});
  const nbe = findings.find(f => f.code === "NO_BUSINESS_ENTITY");
  assert.ok(nbe, "Should emit NO_BUSINESS_ENTITY when no LLC data");
  assert.equal(nbe.severity, "low");
  assert.equal(nbe.category, "business");
});

test("formData young LLC → LLC_YOUNG", () => {
  const findings = buildOptimizationFindings(
    makeConsumerSignals(),
    null,
    "FUNDING_PLUS_REPAIR",
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
    "FUNDING_PLUS_REPAIR",
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
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
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
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
  const util = findings.find(f => f.code === "UTIL_OVERALL_HIGH");
  assert.ok(util);
  assert.ok(util.documentTriggers.includes("balance_reduction_guidance"));
});

test("INQUIRY_REMOVAL has docs=[inquiry_removal_letter]", () => {
  const cs = makeConsumerSignals({
    inquiries: { total: 3, last6Mo: 3, last12Mo: 3, pressure: "medium" }
  });
  const findings = buildOptimizationFindings(cs, null, "FUNDING_PLUS_REPAIR", {});
  const inq = findings.find(f => f.code === "INQUIRY_REMOVAL");
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
      worstSeverity: 1,
      activeBankruptcy: true
    }
  });
  const tradelines = [
    makeTradeline({
      creditorName: "Capital One",
      currentRatingType: "ChargeOff",
      currentBalance: 1500,
      openedDate: "2021-01-01"
    })
  ];
  const identityGate = {
    passed: false,
    outcome: "MANUAL_REVIEW",
    reasons: ["ALL_REPORTS_STALE"],
    confidence: "medium"
  };

  const findings = buildOptimizationFindings(
    cs,
    null,
    "REPAIR_ONLY",
    {},
    { tradelines, identityGate }
  );

  // tradelines passed → CHARGEOFF_ITEM should fire
  const chargeoff = findings.find(f => f.code === "CHARGEOFF_ITEM");
  assert.ok(chargeoff, "CHARGEOFF_ITEM via options.tradelines");

  // activeBankruptcy → BANKRUPTCY_ACTIVE should fire
  const bk = findings.find(f => f.code === "BANKRUPTCY_ACTIVE");
  assert.ok(bk, "BANKRUPTCY_ACTIVE via consumerSignals");
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
    "FULL_FUNDING",
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
    "FULL_FUNDING",
    {},
    { identity }
  );
  assert.ok(findings.find(f => f.code === "NAME_VARIATIONS"));
});
