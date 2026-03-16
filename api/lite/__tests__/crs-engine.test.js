const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { runCRSEngine } = require("../crs/engine");

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

// ============================================================================
// Integration tests — full pipeline
// ============================================================================

test("runCRSEngine: single bureau (TU) — full pipeline", { skip: !tuRaw }, () => {
  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: null,
    submittedName: "Barbara Doty",
    formData: { email: "barbara@test.com", phone: "5551234567", name: "Barbara Doty" }
  });

  assert.equal(result.ok, true);
  assert.ok(result.outcome);
  assert.ok(result.normalized);
  assert.ok(result.consumerSignals);
  assert.ok(result.outcomeResult);
  assert.ok(result.preapprovals);
  assert.ok(result.findings);
  assert.ok(result.suggestions);
  assert.ok(result.cards);
  assert.ok(result.documents);
  assert.ok(result.crmPayload);
  assert.ok(result.audit);

  // TU score
  assert.equal(result.consumerSignals.scores.median, 725);
  assert.equal(result.consumerSignals.scores.bureauConfidence, "low");

  // Identity gate passed (name matches)
  assert.equal(result.identityGate.passed, true);

  // Audit trail
  assert.equal(result.audit.pipeline.length, 9);
  assert.ok(result.audit.decisionsLog.length > 0);
});

test("runCRSEngine: all 3 bureaus — full pipeline", { skip: !tuRaw || !expRaw || !efxRaw }, () => {
  const result = runCRSEngine({
    rawResponses: [tuRaw, expRaw, efxRaw],
    businessReport: null,
    submittedName: "Barbara Doty",
    formData: { email: "test@test.com", phone: "5551234567", name: "Barbara Doty" }
  });

  assert.equal(result.ok, true);

  // Median of [725, 630, 636] = 636
  assert.equal(result.consumerSignals.scores.median, 636);
  assert.equal(result.consumerSignals.scores.bureauConfidence, "high");

  // Has chargeoffs from EXP → likely REPAIR
  assert.ok(result.consumerSignals.derogatories.chargeoffs >= 1);

  // Outcome should reflect the derogatory data
  assert.ok(["REPAIR", "CONDITIONAL_APPROVAL", "MANUAL_REVIEW"].includes(result.outcome));

  // CRM payload populated
  assert.equal(result.crmPayload.scores.median, 636);
  assert.ok(result.crmPayload.customFields.analyzer_status === "complete");

  // Documents generated based on outcome
  assert.ok(result.documents.package);
  assert.ok(result.documents.letters.length >= 0);
});

test("runCRSEngine: wrong name → MANUAL_REVIEW", { skip: !tuRaw }, () => {
  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: null,
    submittedName: "John Smith",
    formData: { email: "test@test.com", name: "John Smith" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.identityGate.passed, false);
  assert.equal(result.identityGate.outcome, "MANUAL_REVIEW");
  assert.equal(result.outcome, "MANUAL_REVIEW");
  assert.equal(result.documents.package, "hold");
});

test("runCRSEngine: with business report", { skip: !tuRaw }, () => {
  const mockBusinessReport = {
    data: {
      scoreInformation: {
        commercialScore: {
          score: 75,
          riskClass: { definition: "LOW RISK" },
          recommendedCreditLimitAmount: 200000
        },
        fsrScore: { score: 50, riskClass: { definition: "LOW TO MEDIUM RISK" } }
      },
      businessHeader: { businessName: "DOTY ENTERPRISES LLC" },
      corporateRegistration: { incorporatedDate: "2020-01-01", statusFlag: { code: "A" } },
      businessFacts: { businessType: "LLC", stateOfIncorporation: "TX" },
      expandedCreditSummary: {
        currentDbt: 0,
        monthlyAverageDbt: 0,
        bankruptcyIndicator: false,
        judgmentIndicator: false,
        taxLienIndicator: false
      },
      commercialFraudShieldSummary: {
        ofacMatchWarning: { code: 1 },
        activeBusinessIndicator: true,
        businessRiskTriggersIndicator: false,
        nameAddressVerificationIndicator: true
      },
      uccFilingsDetail: []
    }
  };

  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: mockBusinessReport,
    submittedName: "Barbara Doty",
    formData: { email: "test@test.com", name: "Barbara Doty", companyName: "Doty Enterprises LLC" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.businessSignals.available, true);
  assert.equal(result.businessSignals.scores.intelliscore, 75);
  assert.ok(result.crmPayload.customFields.business_available === true);
});

test("runCRSEngine: output structure complete", { skip: !tuRaw }, () => {
  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: null,
    submittedName: "Barbara Doty"
  });

  // Verify all expected keys present
  const expectedKeys = [
    "ok",
    "outcome",
    "normalized",
    "identityGate",
    "consumerSignals",
    "businessSignals",
    "outcomeResult",
    "preapprovals",
    "findings",
    "suggestions",
    "cards",
    "documents",
    "crmPayload",
    "audit"
  ];
  for (const key of expectedKeys) {
    assert.ok(key in result, `Missing key: ${key}`);
  }

  // Suggestions structure
  assert.ok(Array.isArray(result.suggestions.layers));
  assert.equal(result.suggestions.layers.length, 4);
  assert.ok(Array.isArray(result.suggestions.topMoves));
  assert.ok(Array.isArray(result.suggestions.flatList));

  // Cards are string array
  assert.ok(Array.isArray(result.cards));
  result.cards.forEach(c => assert.equal(typeof c, "string"));
});

test("runCRSEngine: timing captured in audit", { skip: !tuRaw }, () => {
  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: null,
    submittedName: "Barbara Doty"
  });

  // All pipeline stages should have timing
  for (const stage of result.audit.pipeline) {
    assert.ok(typeof stage.durationMs === "number", `Stage ${stage.stage} missing timing`);
  }
});

// ============================================================================
// Gap fix coverage — canonical output fields
// ============================================================================

test(
  "runCRSEngine: top-level output has reason_codes, confidence, consumer_summary, business_summary, redirect",
  { skip: !tuRaw },
  () => {
    const result = runCRSEngine({
      rawResponses: [tuRaw],
      businessReport: null,
      submittedName: "Barbara Doty"
    });

    assert.ok("reason_codes" in result, "Missing reason_codes");
    assert.ok(Array.isArray(result.reason_codes));
    assert.ok("confidence" in result, "Missing confidence");
    assert.ok(typeof result.confidence === "string");
    assert.ok("consumer_summary" in result, "Missing consumer_summary");
    assert.ok("business_summary" in result, "Missing business_summary");
    assert.ok("redirect" in result, "Missing redirect");
    assert.ok(typeof result.redirect === "object");
  }
);

test("runCRSEngine: consumer_summary is a non-empty string", { skip: !tuRaw }, () => {
  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: null,
    submittedName: "Barbara Doty"
  });

  assert.equal(typeof result.consumer_summary, "string");
  assert.ok(result.consumer_summary.length > 0, "consumer_summary should not be empty");
  // Should contain score info
  assert.ok(
    result.consumer_summary.includes("Credit score"),
    "consumer_summary should mention credit score"
  );
});

test("runCRSEngine: business_summary is a non-empty string", { skip: !tuRaw }, () => {
  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: null,
    submittedName: "Barbara Doty"
  });

  assert.equal(typeof result.business_summary, "string");
  assert.ok(result.business_summary.length > 0, "business_summary should not be empty");
});

test("runCRSEngine: business_summary with business report is descriptive", { skip: !tuRaw }, () => {
  const mockBusinessReport = {
    data: {
      scoreInformation: {
        commercialScore: {
          score: 75,
          riskClass: { definition: "LOW RISK" },
          recommendedCreditLimitAmount: 200000
        },
        fsrScore: { score: 50, riskClass: { definition: "LOW TO MEDIUM RISK" } }
      },
      businessHeader: { businessName: "DOTY ENTERPRISES LLC" },
      corporateRegistration: { incorporatedDate: "2020-01-01", statusFlag: { code: "A" } },
      businessFacts: { businessType: "LLC", stateOfIncorporation: "TX" },
      expandedCreditSummary: {
        currentDbt: 0,
        monthlyAverageDbt: 0,
        bankruptcyIndicator: false,
        judgmentIndicator: false,
        taxLienIndicator: false
      },
      commercialFraudShieldSummary: {
        ofacMatchWarning: { code: 1 },
        activeBusinessIndicator: true,
        businessRiskTriggersIndicator: false,
        nameAddressVerificationIndicator: true
      },
      uccFilingsDetail: []
    }
  };

  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: mockBusinessReport,
    submittedName: "Barbara Doty",
    formData: { email: "test@test.com", name: "Barbara Doty", companyName: "Doty Enterprises LLC" }
  });

  assert.equal(typeof result.business_summary, "string");
  assert.ok(
    result.business_summary.includes("DOTY ENTERPRISES LLC"),
    "business_summary should include business name"
  );
  assert.ok(
    result.business_summary.includes("Intelliscore"),
    "business_summary should include intelliscore"
  );
});

test("runCRSEngine: redirect.path is set for funding outcomes", { skip: !tuRaw }, () => {
  // TU-only with name match → likely CONDITIONAL or FULL_STACK (funding path)
  // We test that redirect is structured correctly regardless of outcome
  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: null,
    submittedName: "Barbara Doty"
  });

  assert.ok(result.redirect !== null && typeof result.redirect === "object");
  assert.ok("path" in result.redirect);
  assert.ok("url" in result.redirect);

  // For funding outcomes (FULL_STACK, CONDITIONAL, PREMIUM), path should be 'funding'
  // For non-funding (REPAIR), path should be 'repair'
  // For holds (FRAUD_HOLD, MANUAL_REVIEW), path should be null
  const fundingOutcomes = ["FULL_STACK_APPROVAL", "CONDITIONAL_APPROVAL", "PREMIUM_STACK"];
  if (fundingOutcomes.includes(result.outcome)) {
    assert.equal(result.redirect.path, "funding");
  } else if (result.outcome === "REPAIR") {
    assert.equal(result.redirect.path, "repair");
  } else {
    assert.equal(result.redirect.path, null);
  }
});

// ============================================================================
// Second audit fix pass — decision_label and decision_explanation
// ============================================================================

test(
  "runCRSEngine: decision_label and decision_explanation present in output",
  { skip: !tuRaw },
  () => {
    const result = runCRSEngine({
      rawResponses: [tuRaw],
      businessReport: null,
      submittedName: "Barbara Doty"
    });

    assert.ok("decision_label" in result, "decision_label should be present in output");
    assert.equal(typeof result.decision_label, "string");
    assert.ok(result.decision_label.length > 0, "decision_label should not be empty");

    assert.ok("decision_explanation" in result, "decision_explanation should be present in output");
    assert.equal(typeof result.decision_explanation, "string");
    assert.ok(result.decision_explanation.length > 0, "decision_explanation should not be empty");
  }
);

test("runCRSEngine: decision_label matches known outcome labels", { skip: !tuRaw }, () => {
  const result = runCRSEngine({
    rawResponses: [tuRaw],
    businessReport: null,
    submittedName: "Barbara Doty"
  });

  const knownLabels = [
    "Application On Hold",
    "Under Review",
    "Credit Repair Recommended",
    "Conditionally Approved",
    "Approved for Funding",
    "Premium Funding Approved"
  ];
  assert.ok(
    knownLabels.includes(result.decision_label),
    `decision_label "${result.decision_label}" should be one of the known labels`
  );
});
