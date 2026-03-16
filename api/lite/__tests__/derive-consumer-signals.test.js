const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { normalizeSoftPullPayload } = require("../crs/normalize-soft-pull");
const {
  deriveConsumerSignals,
  median,
  monthsBetween,
  getUtilizationBand,
  getInquiryPressure
} = require("../crs/derive-consumer-signals");

// ---------------------------------------------------------------------------
// Load live sandbox responses
// ---------------------------------------------------------------------------
const FIXTURES_DIR = path.resolve(__dirname, "../../../../mar 2026");
let tuRaw, expRaw, efxRaw;

try {
  tuRaw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "tu-response.json"), "utf8"));
  expRaw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "exp-response.json"), "utf8"));
  efxRaw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "efx-response.json"), "utf8"));
} catch {
  // Tests will be skipped if fixture files are not available
}

// ---------------------------------------------------------------------------
// Synthetic data helpers
// ---------------------------------------------------------------------------

function makeNormalized(overrides = {}) {
  return {
    identity: { names: [], ssns: [], dobs: [], addresses: [], employers: [] },
    bureaus: {
      transunion: { available: false, score: null },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    tradelines: [],
    inquiries: [],
    publicRecords: [],
    alerts: [],
    fraudFinders: null,
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 0,
      availableBureaus: []
    },
    ...overrides
  };
}

function makeTradeline(overrides = {}) {
  return {
    creditorName: "TEST BANK",
    accountIdentifier: "xxx-1234",
    source: "transunion",
    accountType: "revolving",
    loanType: "unknown",
    ownership: "individual",
    isAU: false,
    status: "open",
    openedDate: "2020-01-15",
    closedDate: null,
    reportedDate: "2026-03-01",
    lastActivityDate: "2026-03-01",
    creditLimit: 10000,
    highBalance: 10000,
    currentBalance: 2000,
    effectiveLimit: 10000,
    pastDue: null,
    monthlyPayment: 200,
    chargeOffAmount: null,
    termsMonths: null,
    monthsReviewed: 72,
    latePayments: { _30: 0, _60: 0, _90: 0 },
    currentRatingCode: "-",
    currentRatingType: "AsAgreed",
    ratingSeverity: 0,
    isDerogatory: false,
    paymentPattern: null,
    adverseRatings: null,
    comments: [],
    ...overrides
  };
}

function makeInquiry(overrides = {}) {
  return {
    creditorName: "TEST LENDER",
    date: "2026-01-15",
    businessType: "Finance",
    subscriberCode: "999XX00001",
    source: "transunion",
    ...overrides
  };
}

// ============================================================================
// median
// ============================================================================

test("median: empty array → null", () => {
  assert.equal(median([]), null);
});

test("median: single value", () => {
  assert.equal(median([725]), 725);
});

test("median: two values → average", () => {
  assert.equal(median([630, 725]), 678);
});

test("median: three values → middle", () => {
  assert.equal(median([630, 636, 725]), 636);
});

test("median: even count → average of middle two", () => {
  assert.equal(median([600, 630, 700, 750]), 665);
});

// ============================================================================
// monthsBetween
// ============================================================================

test("monthsBetween: same month → 0", () => {
  assert.equal(monthsBetween("2026-03-01", "2026-03-15"), 0);
});

test("monthsBetween: 24 months apart", () => {
  assert.equal(monthsBetween("2024-03-01", "2026-03-01"), 24);
});

test("monthsBetween: invalid date → 0", () => {
  assert.equal(monthsBetween("invalid", "2026-03-01"), 0);
  assert.equal(monthsBetween("2026-03-01", null), 0);
});

// ============================================================================
// getUtilizationBand
// ============================================================================

test("getUtilizationBand: all bands", () => {
  assert.equal(getUtilizationBand(null), "unknown");
  assert.equal(getUtilizationBand(0), "excellent");
  assert.equal(getUtilizationBand(5), "excellent");
  assert.equal(getUtilizationBand(9), "excellent");
  assert.equal(getUtilizationBand(10), "good");
  assert.equal(getUtilizationBand(29), "good");
  assert.equal(getUtilizationBand(30), "moderate");
  assert.equal(getUtilizationBand(49), "moderate");
  assert.equal(getUtilizationBand(50), "high");
  assert.equal(getUtilizationBand(79), "high");
  assert.equal(getUtilizationBand(80), "critical");
  assert.equal(getUtilizationBand(100), "critical");
});

// ============================================================================
// getInquiryPressure
// ============================================================================

test("getInquiryPressure: all levels", () => {
  assert.equal(getInquiryPressure(0), "low");
  assert.equal(getInquiryPressure(2), "low");
  assert.equal(getInquiryPressure(3), "moderate");
  assert.equal(getInquiryPressure(5), "moderate");
  assert.equal(getInquiryPressure(6), "high");
  assert.equal(getInquiryPressure(9), "high");
  assert.equal(getInquiryPressure(10), "storm");
  assert.equal(getInquiryPressure(15), "storm");
});

// ============================================================================
// deriveConsumerSignals — synthetic data
// ============================================================================

test("deriveConsumerSignals: empty tradelines", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 700, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    }
  });
  const signals = deriveConsumerSignals(normalized);

  assert.equal(signals.scores.median, 700);
  assert.equal(signals.scores.bureauConfidence, "low");
  assert.equal(signals.tradelines.total, 0);
  assert.equal(signals.tradelines.thinFile, true);
  assert.equal(signals.anchors.revolving, null);
  assert.equal(signals.anchors.installment, null);
  assert.equal(signals.utilization.pct, null);
  assert.equal(signals.utilization.band, "unknown");
  assert.equal(signals.derogatories.active, 0);
  assert.equal(signals.paymentHistory.totalEvents, 0);
});

test("deriveConsumerSignals: AU dominance", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 750, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      makeTradeline({ isAU: true, creditorName: "AU CARD 1" }),
      makeTradeline({ isAU: true, creditorName: "AU CARD 2" }),
      makeTradeline({ isAU: true, creditorName: "AU CARD 3" }),
      makeTradeline({ isAU: false, creditorName: "PRIMARY 1" })
    ]
  });
  const signals = deriveConsumerSignals(normalized);

  assert.equal(signals.tradelines.au, 3);
  assert.equal(signals.tradelines.primary, 1);
  assert.equal(signals.tradelines.auDominance, 0.75);
  assert.equal(signals.tradelines.thinFile, true); // only 1 primary
});

test("deriveConsumerSignals: utilization calculation", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 700, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      makeTradeline({ creditLimit: 10000, effectiveLimit: 10000, currentBalance: 3000 }),
      makeTradeline({ creditLimit: 5000, effectiveLimit: 5000, currentBalance: 2000 }),
      makeTradeline({ creditLimit: 15000, effectiveLimit: 15000, currentBalance: 0 })
    ]
  });
  const signals = deriveConsumerSignals(normalized);

  // Total balance = 3000 + 2000 + 0 = 5000
  // Total limit = 10000 + 5000 + 15000 = 30000
  // Utilization = 5000/30000 * 100 = 17%
  assert.equal(signals.utilization.totalBalance, 5000);
  assert.equal(signals.utilization.totalLimit, 30000);
  assert.equal(signals.utilization.pct, 17);
  assert.equal(signals.utilization.band, "good");
});

test("deriveConsumerSignals: AU tradelines excluded from utilization", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 700, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      makeTradeline({ creditLimit: 10000, effectiveLimit: 10000, currentBalance: 8000 }),
      makeTradeline({ isAU: true, creditLimit: 50000, effectiveLimit: 50000, currentBalance: 1000 })
    ]
  });
  const signals = deriveConsumerSignals(normalized);

  // Only the primary card counts: 8000/10000 = 80%
  assert.equal(signals.utilization.totalBalance, 8000);
  assert.equal(signals.utilization.totalLimit, 10000);
  assert.equal(signals.utilization.pct, 80);
  assert.equal(signals.utilization.band, "critical");
});

test("deriveConsumerSignals: revolving anchor selection", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 700, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      // Best candidate: highest limit, seasoned, clean
      makeTradeline({ creditorName: "BIG BANK", effectiveLimit: 25000, openedDate: "2020-01-01" }),
      // Disqualified: too new (less than 24 months)
      makeTradeline({ creditorName: "NEW CARD", effectiveLimit: 50000, openedDate: "2025-06-01" }),
      // Disqualified: derogatory
      makeTradeline({
        creditorName: "BAD CARD",
        effectiveLimit: 30000,
        openedDate: "2020-01-01",
        isDerogatory: true
      }),
      // Disqualified: AU
      makeTradeline({
        creditorName: "AU CARD",
        effectiveLimit: 40000,
        openedDate: "2020-01-01",
        isAU: true
      }),
      // Disqualified: closed
      makeTradeline({
        creditorName: "CLOSED",
        effectiveLimit: 35000,
        openedDate: "2020-01-01",
        status: "closed"
      })
    ]
  });
  const signals = deriveConsumerSignals(normalized);

  assert.equal(signals.anchors.revolving.creditor, "BIG BANK");
  assert.equal(signals.anchors.revolving.limit, 25000);
  assert.ok(signals.anchors.revolving.months >= 72);
});

test("deriveConsumerSignals: installment anchor selection", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 700, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      // Best candidate: highest highBalance, seasoned, no lates
      makeTradeline({
        creditorName: "AUTO LOAN",
        accountType: "installment",
        highBalance: 35000,
        openedDate: "2022-01-01"
      }),
      // Disqualified: has lates
      makeTradeline({
        creditorName: "BAD LOAN",
        accountType: "installment",
        highBalance: 50000,
        openedDate: "2020-01-01",
        latePayments: { _30: 2, _60: 0, _90: 0 }
      })
    ]
  });
  const signals = deriveConsumerSignals(normalized);

  assert.equal(signals.anchors.installment.creditor, "AUTO LOAN");
  assert.equal(signals.anchors.installment.amount, 35000);
});

test("deriveConsumerSignals: inquiry pressure with dates", () => {
  const inquiries = [];
  // 8 inquiries in the last 6 months
  for (let i = 0; i < 8; i++) {
    inquiries.push(makeInquiry({ date: "2026-01-15" }));
  }
  // 4 inquiries older than 6 months but within 12 months
  for (let i = 0; i < 4; i++) {
    inquiries.push(makeInquiry({ date: "2025-06-01" }));
  }
  // 2 inquiries older than 12 months
  for (let i = 0; i < 2; i++) {
    inquiries.push(makeInquiry({ date: "2024-06-01" }));
  }

  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 700, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    inquiries
  });
  const signals = deriveConsumerSignals(normalized);

  assert.equal(signals.inquiries.total, 14);
  assert.equal(signals.inquiries.last6Mo, 8);
  assert.equal(signals.inquiries.last12Mo, 12);
  assert.equal(signals.inquiries.pressure, "high"); // 8 in 6mo = high (6-9)
});

test("deriveConsumerSignals: derogatory counts", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 580, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      // Open derogatory: Late60Days
      makeTradeline({
        creditorName: "DELINQUENT",
        isDerogatory: true,
        currentRatingType: "Late60Days",
        ratingSeverity: 2
      }),
      // Chargeoff (closed, but still counted as chargeoff)
      makeTradeline({
        creditorName: "CHARGEOFF CO",
        status: "closed",
        isDerogatory: true,
        currentRatingType: "ChargeOff",
        ratingSeverity: 5,
        adverseRatings: { highest: { type: "CollectionOrChargeOff" } }
      }),
      // Clean tradeline
      makeTradeline({ creditorName: "CLEAN BANK" })
    ],
    publicRecords: [
      {
        type: "BankruptcyChapter7",
        filedDate: "2022-06-01",
        dispositionType: "Discharged",
        source: "experian"
      }
    ]
  });
  const signals = deriveConsumerSignals(normalized);

  assert.equal(signals.derogatories.active, 1); // only open derog
  assert.equal(signals.derogatories.chargeoffs, 1); // all chargeoffs regardless of status
  assert.equal(signals.derogatories.collections, 1);
  assert.equal(signals.derogatories.active60, 1);
  assert.equal(signals.derogatories.worstSeverity, 2); // worst among OPEN derogs only
  assert.equal(signals.derogatories.activeBankruptcy, false); // discharged
  assert.equal(signals.derogatories.dischargedBankruptcy, true);
  assert.ok(signals.derogatories.bankruptcyAge > 0);
});

test("deriveConsumerSignals: payment history totals", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 650, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      makeTradeline({ latePayments: { _30: 3, _60: 1, _90: 0 } }),
      makeTradeline({ latePayments: { _30: 0, _60: 2, _90: 1 } }),
      makeTradeline({ latePayments: { _30: 0, _60: 0, _90: 0 } })
    ]
  });
  const signals = deriveConsumerSignals(normalized);

  assert.equal(signals.paymentHistory.late30, 3);
  assert.equal(signals.paymentHistory.late60, 3);
  assert.equal(signals.paymentHistory.late90, 1);
  assert.equal(signals.paymentHistory.totalEvents, 7);
});

test("deriveConsumerSignals: recent late activity detection", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 650, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      makeTradeline({
        status: "open",
        currentRatingType: "Late30Days",
        ratingSeverity: 1,
        isDerogatory: true
      })
    ]
  });
  const signals = deriveConsumerSignals(normalized);
  assert.equal(signals.paymentHistory.recentActivity, true);
});

test("deriveConsumerSignals: no recent late activity", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 750, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      makeTradeline({ latePayments: { _30: 5, _60: 0, _90: 0 } }) // historical lates but current is AsAgreed
    ]
  });
  const signals = deriveConsumerSignals(normalized);
  assert.equal(signals.paymentHistory.recentActivity, false);
});

test("deriveConsumerSignals: three-bureau score spread", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 750, reportDate: "2026-03-11" },
      experian: { available: true, score: 680, reportDate: "2026-03-11" },
      equifax: { available: true, score: 720, reportDate: "2026-03-11" }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 3,
      availableBureaus: ["transunion", "experian", "equifax"]
    }
  });
  const signals = deriveConsumerSignals(normalized);

  assert.equal(signals.scores.median, 720);
  assert.equal(signals.scores.bureauConfidence, "high");
  assert.equal(signals.scores.spread, 70); // 750 - 680
  assert.equal(signals.scores.perBureau.tu, 750);
  assert.equal(signals.scores.perBureau.ex, 680);
  assert.equal(signals.scores.perBureau.eq, 720);
});

test("deriveConsumerSignals: mortgage detection", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 700, reportDate: "2026-03-11" },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    meta: {
      requestDate: "2026-03-11",
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    tradelines: [
      makeTradeline({ accountType: "mortgage", creditorName: "HOME LOAN CO" }),
      makeTradeline({ creditorName: "CARD 1" }),
      makeTradeline({ creditorName: "CARD 2" }),
      makeTradeline({ creditorName: "CARD 3" })
    ]
  });
  const signals = deriveConsumerSignals(normalized);

  assert.equal(signals.tradelines.mortgagePresent, true);
  assert.equal(signals.tradelines.thinFile, false); // 4 primary tradelines
});

// ============================================================================
// deriveConsumerSignals — live sandbox data
// ============================================================================

test("deriveConsumerSignals: TU single bureau (BARBARA DOTY)", { skip: !tuRaw }, () => {
  const normalized = normalizeSoftPullPayload([tuRaw]);
  const signals = deriveConsumerSignals(normalized);

  // Score
  assert.equal(signals.scores.median, 725);
  assert.equal(signals.scores.bureauConfidence, "low");
  assert.equal(signals.scores.spread, 0);
  assert.equal(signals.scores.perBureau.tu, 725);
  assert.equal(signals.scores.perBureau.ex, null);

  // Has AU tradeline
  assert.ok(signals.tradelines.au >= 1, "Should have AU tradelines");
  assert.ok(signals.tradelines.total >= 3, "Should have 3+ total tradelines");

  // Structure checks
  assert.ok(typeof signals.utilization.pct === "number" || signals.utilization.pct === null);
  assert.ok(
    ["excellent", "good", "moderate", "high", "critical", "unknown"].includes(
      signals.utilization.band
    )
  );
  assert.ok(["low", "moderate", "high", "storm"].includes(signals.inquiries.pressure));
});

test("deriveConsumerSignals: EXP single bureau (WILLIE BOOZE)", { skip: !expRaw }, () => {
  const normalized = normalizeSoftPullPayload([expRaw]);
  const signals = deriveConsumerSignals(normalized);

  // Score
  assert.equal(signals.scores.median, 630);
  assert.equal(signals.scores.perBureau.ex, 630);

  // Has chargeoff
  assert.ok(signals.derogatories.chargeoffs >= 1, "Should have chargeoffs");

  // Has discharged bankruptcy
  assert.equal(signals.derogatories.dischargedBankruptcy, true);
  assert.ok(signals.derogatories.bankruptcyAge > 0);

  // Inquiries
  assert.ok(signals.inquiries.total >= 10, "Should have 10+ inquiries");

  // EXP tradelines have 0 explicit late counts (chargeoffs tracked via rating, not late counts)
  assert.ok(signals.paymentHistory.totalEvents >= 0);
});

test("deriveConsumerSignals: EFX single bureau (JOHN BIALOGLOW)", { skip: !efxRaw }, () => {
  const normalized = normalizeSoftPullPayload([efxRaw]);
  const signals = deriveConsumerSignals(normalized);

  // Score
  assert.equal(signals.scores.median, 636);
  assert.equal(signals.scores.perBureau.eq, 636);

  // Has active derogatories
  assert.ok(signals.derogatories.active >= 1, "Should have active derogatories");

  // Has late payments
  assert.ok(signals.paymentHistory.totalEvents > 0);
});

test("deriveConsumerSignals: all 3 bureaus merged", { skip: !tuRaw || !expRaw || !efxRaw }, () => {
  const normalized = normalizeSoftPullPayload([tuRaw, expRaw, efxRaw]);
  const signals = deriveConsumerSignals(normalized);

  // Scores: median of [725, 630, 636] = 636
  assert.equal(signals.scores.median, 636);
  assert.equal(signals.scores.bureauConfidence, "high");
  assert.equal(signals.scores.spread, 95); // 725 - 630
  assert.equal(signals.scores.perBureau.tu, 725);
  assert.equal(signals.scores.perBureau.ex, 630);
  assert.equal(signals.scores.perBureau.eq, 636);

  // Tradelines merged from all bureaus
  const tuCount = tuRaw.tradelines.length;
  const expCount = expRaw.tradelines.length;
  const efxCount = efxRaw.tradelines.length;
  assert.equal(signals.tradelines.total, tuCount + expCount + efxCount);

  // Should have both chargeoffs and active derogs
  assert.ok(signals.derogatories.chargeoffs >= 1);
  assert.ok(signals.derogatories.dischargedBankruptcy === true);

  // Inquiries merged from all bureaus
  assert.ok(signals.inquiries.total > 10);
});
