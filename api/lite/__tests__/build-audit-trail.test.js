const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAuditTrail, ENGINE_VERSION } = require("../crs/build-audit-trail");

function makeAuditOptions() {
  return {
    normalized: {
      meta: { bureauCount: 3, availableBureaus: ["transunion", "experian", "equifax"] },
      tradelines: new Array(15)
    },
    identityGate: { passed: true, outcome: null, reasons: [], confidence: "high" },
    consumerSignals: {
      scores: { median: 720, bureauConfidence: "high" },
      tradelines: { thinFile: false, auDominance: 0.1 },
      utilization: { pct: 15, band: "good" },
      inquiries: { pressure: "low", last6Mo: 1 },
      derogatories: { active: 0, chargeoffs: 0, collections: 0 }
    },
    businessSignals: {
      available: true,
      scores: { intelliscore: 75, fsr: 50 },
      hardBlock: { blocked: false }
    },
    outcomeResult: {
      outcome: "FULL_FUNDING",
      reasonCodes: [],
      confidence: "high",
      businessBoostApplied: false,
      businessBoostDetail: null
    },
    preapprovals: {
      totalCombined: 290000,
      personalCard: { final: 150000 },
      personalLoan: { final: 90000 },
      business: { final: 50000 },
      modifiersApplied: [],
      customerSafe: true,
      confidenceBand: "high"
    },
    findings: [{ code: "NO_LLC_YOUNG_LLC" }],
    timings: {
      normalize: 5,
      identityGate: 2,
      consumer: 3,
      business: 1,
      outcome: 1,
      preapprovals: 1,
      findings: 2,
      suggestions: 1,
      output: 1
    }
  };
}

// ============================================================================
// Tests
// ============================================================================

test("buildAuditTrail: structure and version", () => {
  const audit = buildAuditTrail(makeAuditOptions());

  assert.equal(audit.engineVersion, ENGINE_VERSION);
  assert.ok(audit.timestamp);
  assert.equal(audit.pipeline.length, 9);
  assert.ok(audit.decisionsLog.length > 0);
});

test("buildAuditTrail: pipeline stages", () => {
  const audit = buildAuditTrail(makeAuditOptions());
  const stages = audit.pipeline.map(s => s.stage);

  assert.deepEqual(stages, [
    "normalize",
    "identityGate",
    "consumerSignals",
    "businessSignals",
    "routeOutcome",
    "preapprovals",
    "optimizationFindings",
    "suggestions",
    "output"
  ]);
});

test("buildAuditTrail: timings recorded", () => {
  const audit = buildAuditTrail(makeAuditOptions());

  assert.equal(audit.pipeline[0].durationMs, 5);
  assert.equal(audit.pipeline[0].inputBureaus, 3);
  assert.equal(audit.pipeline[0].tradelinesFound, 15);
});

test("buildAuditTrail: decisions log content", () => {
  const audit = buildAuditTrail(makeAuditOptions());

  assert.ok(audit.decisionsLog.some(d => d.includes("medianScore=720")));
  assert.ok(audit.decisionsLog.some(d => d.includes("utilization=15%")));
  assert.ok(audit.decisionsLog.some(d => d.includes("no active derogatories")));
  assert.ok(audit.decisionsLog.some(d => d.includes("FULL_FUNDING")));
  assert.ok(audit.decisionsLog.some(d => d.includes("$290000")));
  // New detailed fields
  assert.ok(audit.decisionsLog.some(d => d.includes("identityGate: PASSED")));
  assert.ok(audit.decisionsLog.some(d => d.includes("customerSafe=true")));
  assert.ok(audit.decisionsLog.some(d => d.includes("confidenceBand=high")));
});

test("buildAuditTrail: business boost logged", () => {
  const opts = makeAuditOptions();
  opts.outcomeResult.businessBoostApplied = true;
  opts.outcomeResult.businessBoostDetail = "Upgraded by strong business credit";
  const audit = buildAuditTrail(opts);

  assert.ok(audit.decisionsLog.some(d => d.includes("businessBoost")));
});

test("buildAuditTrail: active derogatories logged", () => {
  const opts = makeAuditOptions();
  opts.consumerSignals.derogatories.active = 3;
  const audit = buildAuditTrail(opts);

  assert.ok(audit.decisionsLog.some(d => d.includes("activeDerogatories=3")));
});

test("buildAuditTrail: missing timings default to 0", () => {
  const opts = makeAuditOptions();
  opts.timings = {};
  const audit = buildAuditTrail(opts);

  assert.equal(audit.pipeline[0].durationMs, 0);
});
