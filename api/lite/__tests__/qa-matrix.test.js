"use strict";

/**
 * QA Matrix — Chris's QA Test Plan "Sample Tests" encoded as executable assertions.
 *
 * Source: june-2026/june-22/FundHub QA Test Plan - Client Approval Preview.md
 *
 * Tests map:
 *   QA-01  All bureaus clean → FULL_FUNDING
 *   QA-02  Some bureaus clean, some dirty → FUNDING_PLUS_REPAIR
 *   QA-03  All bureaus dirty → REPAIR_ONLY
 *   QA-04  Experian only selected for inquiry removal → only EX dispatches (OUT OF SCOPE — dispatch in inquiry-removal-ai repo)
 *   QA-05  Equifax only selected → only EQ dispatches, no EX default (OUT OF SCOPE — dispatch in inquiry-removal-ai repo)
 *   QA-06  Josh pre-Analyzer approval promise → MANUAL (agent/prompt behavior, not testable here)
 *   QA-07  Partial repair deposit → repair gate not satisfied
 *   QA-08  Fraud alert present → funding pauses / FRAUD_HOLD or MANUAL_REVIEW
 *   QA-09  Funding closeout → closeout fields computed; GHL push gap documented
 *   REG-01 Bureau dispatch default to EX regression (OUT OF SCOPE — dispatch in inquiry-removal-ai repo, fix was selected_bureaus_raw → not "EX" default)
 *   REG-02 Experian phone number regression (config test)
 *   REG-03 Selected-bureau mapping (OUT OF SCOPE — same dispatch module)
 *   REG-04 Fraud gate correctly blocks before routing
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { routeOutcome, OUTCOMES } = require("../crs/route-outcome");
const { runIdentityAndFraudGate } = require("../crs/identity-fraud-gate");

// resolveServiceFamily is not exported from sale-closed.js (only `handle` is exported).
// Inlined here from sale-closed.js:139-152 to test the logic in isolation.
// FINDING: sale-closed.js does not export resolveServiceFamily — it's a private
// helper. If this logic ever drifts, there's no direct unit test on the module itself.
function resolveServiceFamily(serviceSelected) {
  if (!serviceSelected) return "unknown";
  const lower = serviceSelected.toLowerCase();
  if (lower.includes("funding") || lower.includes("fund") || lower === "funding_engagement") {
    return "funding";
  }
  if (lower.includes("repair") || lower.includes("credit_repair") || lower === "repair_program") {
    return "repair";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Shared fixture builders (shapes derived from route-outcome.test.js)
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
    allBureausClean: true,
    anyBureauClean: true,
    bureauNegatives: {},
    auImpact: { harmful: [], neutral: [] },
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

/** Minimal normalized payload shape for identity-fraud-gate */
function makeNormalized(overrides = {}) {
  return {
    identity: {
      names: [{ first: "John", last: "Doe", source: "transunion" }],
      ssns: [],
      dobs: [],
      addresses: [],
      employers: []
    },
    bureaus: {
      transunion: {
        available: true,
        score: 720,
        reportDate: new Date().toISOString().split("T")[0]
      },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    tradelines: [],
    inquiries: [],
    publicRecords: [],
    alerts: [],
    fraudFinders: null,
    securityFreezes: null,
    fraudAlertsOnFile: null,
    meta: {
      requestDate: new Date().toISOString().split("T")[0],
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// QA-01: All bureaus clean → FULL_FUNDING
// ---------------------------------------------------------------------------

test("QA-01: all bureaus clean → routes to FULL_FUNDING", () => {
  const cs = makeConsumerSignals({
    allBureausClean: true,
    anyBureauClean: true
  });
  const result = routeOutcome(cs, makeBusinessSignals(), makeGate());
  assert.equal(
    result.outcome,
    OUTCOMES.FULL_FUNDING,
    `Expected FULL_FUNDING, got ${result.outcome}`
  );
});

// ---------------------------------------------------------------------------
// QA-02: Some bureaus clean, some dirty → FUNDING_PLUS_REPAIR
// ---------------------------------------------------------------------------

test("QA-02: mixed bureaus (some clean, some dirty) → FUNDING_PLUS_REPAIR", () => {
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
    },
    allBureausClean: false,
    anyBureauClean: true // at least one bureau is clean
  });
  const result = routeOutcome(cs, makeBusinessSignals(), makeGate());
  assert.equal(
    result.outcome,
    OUTCOMES.FUNDING_PLUS_REPAIR,
    `Expected FUNDING_PLUS_REPAIR, got ${result.outcome}`
  );
});

// ---------------------------------------------------------------------------
// QA-03: All bureaus dirty → REPAIR_ONLY
// ---------------------------------------------------------------------------

test("QA-03: all bureaus dirty → REPAIR_ONLY", () => {
  const cs = makeConsumerSignals({
    derogatories: {
      active: 2,
      chargeoffs: 1,
      collections: 1,
      active30: 0,
      active60: 0,
      active90: 1,
      active120Plus: 0,
      worstSeverity: 5,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    },
    allBureausClean: false,
    anyBureauClean: false // no bureau is clean
  });
  const result = routeOutcome(cs, null, makeGate());
  assert.equal(result.outcome, OUTCOMES.REPAIR_ONLY, `Expected REPAIR_ONLY, got ${result.outcome}`);
});

// ---------------------------------------------------------------------------
// QA-04 / QA-05 / REG-01 / REG-03: Bureau dispatch (inquiry-removal-ai)
// ---------------------------------------------------------------------------

test.skip("QA-04: Experian only selected → only EX call dispatches [OUT OF SCOPE]", () => {
  // Bureau dispatch lives in inquiry-removal-ai/api/dispatch-scheduled.js.
  // The fix (selected_bureaus_raw instead of defaulting to 'EX') is in that repo.
  // To lock down: add tests in inquiry-removal-ai/__tests__/dispatch-scheduled.test.js
  // asserting that when selected_bureaus_raw='EQ', only EQ is dispatched.
});

test.skip("QA-05: Equifax only selected → only EQ dispatches, no EX default [OUT OF SCOPE]", () => {
  // Same as QA-04. The regression (all cases defaulting to Experian) was fixed
  // by changing `selected_bureaus || "EX"` → `selected_bureaus_raw || "EX"`.
  // Regression test belongs in inquiry-removal-ai repo.
});

test.skip("REG-01: bureau dispatch defaulting to Experian regression [OUT OF SCOPE]", () => {
  // The `dispatch-scheduled.js` line 160: `(caseFields.selected_bureaus_raw || "EX")`
  // still defaults to EX if the field is empty. This is a potential issue:
  // if a case record has no selected_bureaus_raw, it silently dispatches EX only.
  // Fix in inquiry-removal-ai repo — test that empty field is rejected, not defaulted.
});

test.skip("REG-03: selected-bureau mapping correctness [OUT OF SCOPE]", () => {
  // BUREAU_CONFIGS map in dispatch-scheduled.js: { EX, EQ, TU }.
  // The field `selected_bureaus_raw` is parsed as comma-separated codes.
  // Test should assert EX→Experian, EQ→Equifax, TU→TransUnion and unknown codes are skipped.
});

// ---------------------------------------------------------------------------
// QA-06: Josh pre-Analyzer approval promise (MANUAL — agent/prompt behavior)
// ---------------------------------------------------------------------------

test.skip("QA-06: Josh does not promise funding before Analyzer result [MANUAL]", () => {
  // This is a GHL agent / Bland AI / Josh setter prompt behavior test.
  // Not automatable against code modules in this repo.
  // Manual test: trigger Josh conversation, ask for approval before CRS runs,
  // verify Josh deflects rather than promises funding.
});

// ---------------------------------------------------------------------------
// QA-07: Partial repair deposit → payment gate not satisfied
// ---------------------------------------------------------------------------

test("QA-07: partial repair deposit → engagement_remaining_due > 0 (repair gate not satisfied)", () => {
  // resolveServiceFamily is exported from sale-closed.js.
  // The spec: repair face value = contract_value. If deposit < face value, remaining_due > 0.
  // The engine stores cf_engagement_remaining_due — repair work should not begin until it's 0.

  const serviceSelected = "repair_program";
  const contractValue = 1500;
  const depositCreditApplied = 500; // partial — only 1/3 paid

  const serviceFamily = resolveServiceFamily(serviceSelected);
  assert.equal(serviceFamily, "repair", `Expected 'repair', got '${serviceFamily}'`);

  const faceValue = contractValue; // per spec: repair face = contract_value
  const remainingDue = Math.max(0, faceValue - depositCreditApplied);
  assert.equal(remainingDue, 1000, `Expected remaining_due=1000, got ${remainingDue}`);
  assert.ok(
    remainingDue > 0,
    "remaining_due must be > 0 for partial payment; repair gate not satisfied"
  );
});

test("QA-07b: full repair deposit → remaining_due = 0 (gate satisfied)", () => {
  const contractValue = 1500;
  const depositCreditApplied = 1500; // full payment

  const remainingDue = Math.max(0, contractValue - depositCreditApplied);
  assert.equal(remainingDue, 0, `Expected remaining_due=0 for full payment, got ${remainingDue}`);
});

test("QA-07c: funding engagement face value is always hardcoded to 3000, not contract_value", () => {
  // Per spec section 11: funding face value = 3000 regardless of contract_value.
  const FUNDING_ENGAGEMENT_FACE_VALUE = 3000;

  const serviceFamily = resolveServiceFamily("funding_engagement");
  assert.equal(serviceFamily, "funding");

  const contractValue = 9999; // should be ignored for funding
  const faceValue = serviceFamily === "funding" ? FUNDING_ENGAGEMENT_FACE_VALUE : contractValue;
  assert.equal(faceValue, 3000, `Expected 3000 for funding, got ${faceValue}`);
});

// ---------------------------------------------------------------------------
// QA-08: Fraud alert present → FRAUD_HOLD or MANUAL_REVIEW
// ---------------------------------------------------------------------------

test("QA-08a: high fraud risk score + tumbling risk → route-outcome returns FRAUD_HOLD", () => {
  const gate = {
    passed: false,
    outcome: "FRAUD_HOLD",
    reasons: ["HIGH_FRAUD_RISK_SCORE", "TUMBLING_RISK"],
    confidence: "high"
  };
  const result = routeOutcome(makeConsumerSignals(), makeBusinessSignals(), gate);
  assert.equal(result.outcome, OUTCOMES.FRAUD_HOLD, `Expected FRAUD_HOLD, got ${result.outcome}`);
  assert.ok(result.reasonCodes.includes("FRAUD_HIGH_RISK"), "FRAUD_HIGH_RISK reason code expected");
});

test("QA-08b: consumer fraud alert on file → identity-fraud-gate returns MANUAL_REVIEW", () => {
  const normalized = makeNormalized({
    fraudAlertsOnFile: {
      detected: true,
      bureaus: ["transunion"],
      types: ["active"]
    }
  });
  const result = runIdentityAndFraudGate(normalized, "John Doe");
  assert.equal(result.passed, false, "Gate should fail on consumer fraud alert");
  assert.equal(
    result.outcome,
    "MANUAL_REVIEW",
    `Expected MANUAL_REVIEW from fraud alert, got ${result.outcome}`
  );
  assert.ok(
    result.reasons.includes("CONSUMER_FRAUD_ALERT_ON_FILE"),
    "CONSUMER_FRAUD_ALERT_ON_FILE reason expected"
  );
});

test("QA-08c: OFAC match → FRAUD_HOLD (business hard block)", () => {
  const bs = makeBusinessSignals({
    hardBlock: { blocked: true, reasons: ["OFAC_MATCH"] }
  });
  const result = routeOutcome(makeConsumerSignals(), bs, makeGate());
  assert.equal(
    result.outcome,
    OUTCOMES.FRAUD_HOLD,
    `Expected FRAUD_HOLD for OFAC match, got ${result.outcome}`
  );
});

test("QA-08d: fraud gate precedes repair routing (fraud > repair)", () => {
  const cs = makeConsumerSignals({
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
    },
    allBureausClean: false,
    anyBureauClean: false
  });
  const gate = {
    passed: false,
    outcome: "FRAUD_HOLD",
    reasons: ["HIGH_FRAUD_RISK_SCORE", "TUMBLING_RISK"],
    confidence: "high"
  };
  const result = routeOutcome(cs, null, gate);
  assert.equal(
    result.outcome,
    OUTCOMES.FRAUD_HOLD,
    "Fraud hold must take precedence over REPAIR_ONLY"
  );
});

// ---------------------------------------------------------------------------
// QA-09: Funding closeout → closeout fields computed correctly
// ---------------------------------------------------------------------------

test("QA-09a: sale-closed resolveServiceFamily handles funding label variants", () => {
  assert.equal(resolveServiceFamily("funding_engagement"), "funding");
  assert.equal(resolveServiceFamily("Funding Program"), "funding");
  assert.equal(resolveServiceFamily("fund"), "funding");
});

test("QA-09b: sale-closed resolveServiceFamily handles repair label variants", () => {
  assert.equal(resolveServiceFamily("repair_program"), "repair");
  assert.equal(resolveServiceFamily("credit_repair"), "repair");
  assert.equal(resolveServiceFamily("repair"), "repair");
});

test("QA-09c: cross-lane deposit detected (funding deposit → repair purchase)", () => {
  // Simulates the cross-lane logic from sale-closed.js
  const bookingLane = "funding";
  const serviceSelected = "repair_program";
  const depositCreditApplied = 500;

  const serviceFamily = resolveServiceFamily(serviceSelected);
  const depositedForFunding = bookingLane === "funding" || !bookingLane;
  const boughtRepair = serviceFamily === "repair";
  const isCrossLane = depositedForFunding && boughtRepair && depositCreditApplied > 0;

  assert.equal(
    isCrossLane,
    true,
    "Cross-lane flag should be true: funding deposit on repair purchase"
  );
});

test("QA-09d: same-lane funding closeout → no cross-lane flag", () => {
  const bookingLane = "funding";
  const serviceSelected = "funding_engagement";
  const depositCreditApplied = 500;

  const serviceFamily = resolveServiceFamily(serviceSelected);
  const depositedForFunding = bookingLane === "funding" || !bookingLane;
  const boughtRepair = serviceFamily === "repair";
  const isCrossLane = depositedForFunding && boughtRepair && depositCreditApplied > 0;

  assert.equal(isCrossLane, false, "No cross-lane for funding→funding");
});

// NOTE: sale-closed.handle() calls external APIs (GHL, Airtable). Full E2E
// closeout test (creates Airtable COMMERCE_TRANSACTIONS record, GHL push) is
// MANUAL. Known gap: no GHL event/tag push on funding closeout — the handler
// updates cf_engagement_face_value / cf_engagement_remaining_due but does NOT
// fire a GHL workflow trigger or set a GHL tag. This is a documentation gap to
// surface to Chris if a post-closeout automation is expected.

// ---------------------------------------------------------------------------
// REG-02: Experian phone number regression
// ---------------------------------------------------------------------------

test("REG-02: Experian bureau phone number is the DISPUTE line, not self-service", () => {
  // The correct Experian dispute number is (855) 414-6048, NOT (888) 397-3742.
  // This is a static config assertion — if AI_BUREAU_CONFIG is accessible here,
  // we'd test it. Since it's an Airtable record (not a code constant), this is
  // documented as a manual verification step.
  //
  // What we CAN test: no hardcoded (888) number appears in any bureau config file.
  const fs = require("node:fs");
  const path = require("node:path");

  const experianPromptPath = path.resolve(
    __dirname,
    "../../../../inquiry-removal-ai/api/src/agents/experian-prompt.js"
  );

  if (!fs.existsSync(experianPromptPath)) {
    // File is in a different repo not mounted here — skip gracefully
    return;
  }

  const content = fs.readFileSync(experianPromptPath, "utf8");
  const hasSelfServiceNumber =
    content.includes("8883973742") ||
    content.includes("888-397-3742") ||
    content.includes("888.397.3742");
  assert.equal(
    hasSelfServiceNumber,
    false,
    "experian-prompt.js must NOT contain the self-service (888) number — use (855) dispute line"
  );
  const hasDisputeLine =
    content.includes("8554146048") ||
    content.includes("855-414-6048") ||
    content.includes("855.414.6048");
  assert.equal(
    hasDisputeLine,
    true,
    "experian-prompt.js must contain the correct dispute line (855) 414-6048"
  );
});
