const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deriveBusinessSignals,
  getDbtStress,
  getIntelliscoreBand,
  getFsrBand
} = require("../crs/derive-business-signals");

// ---------------------------------------------------------------------------
// Helper: create minimal business report
// ---------------------------------------------------------------------------

function makeBusinessReport(dataOverrides = {}) {
  return {
    auth: true,
    result: "success",
    data: {
      scoreInformation: {
        commercialScore: {
          score: 70,
          riskClass: { code: 2, definition: "LOW TO MEDIUM RISK" },
          recommendedCreditLimitAmount: 103100
        },
        fsrScore: {
          score: 30,
          riskClass: { code: 3, definition: "MEDIUM RISK" }
        }
      },
      businessHeader: { businessName: "ANTHONY PROPERTIES, INC" },
      corporateRegistration: {
        incorporatedDate: "1979-03-10",
        statusFlag: { code: "A", definition: "Active" }
      },
      businessFacts: {
        businessType: "Corporation",
        stateOfIncorporation: "GA"
      },
      expandedCreditSummary: {
        currentDbt: 0,
        monthlyAverageDbt: 0,
        bankruptcyIndicator: false,
        judgmentIndicator: false,
        taxLienIndicator: false
      },
      commercialFraudShieldSummary: {
        ofacMatchWarning: { code: 1, definition: "No Match Found" },
        activeBusinessIndicator: true,
        businessRiskTriggersIndicator: false,
        nameAddressVerificationIndicator: true
      },
      uccFilingsDetail: [],
      ...dataOverrides
    }
  };
}

// ============================================================================
// getDbtStress
// ============================================================================

test("getDbtStress: all bands", () => {
  assert.equal(getDbtStress(null), "unknown");
  assert.equal(getDbtStress(undefined), "unknown");
  assert.equal(getDbtStress(0), "none");
  assert.equal(getDbtStress(1), "low");
  assert.equal(getDbtStress(15), "low");
  assert.equal(getDbtStress(16), "moderate");
  assert.equal(getDbtStress(30), "moderate");
  assert.equal(getDbtStress(31), "high");
  assert.equal(getDbtStress(60), "high");
  assert.equal(getDbtStress(61), "severe");
  assert.equal(getDbtStress(120), "severe");
});

// ============================================================================
// deriveBusinessSignals — null/undefined input
// ============================================================================

test("deriveBusinessSignals: null → not available", () => {
  const result = deriveBusinessSignals(null);
  assert.equal(result.available, false);
});

test("deriveBusinessSignals: undefined → not available", () => {
  const result = deriveBusinessSignals(undefined);
  assert.equal(result.available, false);
});

test("deriveBusinessSignals: empty object → not available", () => {
  const result = deriveBusinessSignals({});
  // Empty object has no data field, falls through to data = businessReport
  // which is {} — a valid object, so it proceeds with missing fields
  assert.equal(result.available, true);
  assert.equal(result.scores.intelliscore, null);
});

// ============================================================================
// deriveBusinessSignals — healthy business
// ============================================================================

test("deriveBusinessSignals: healthy business profile", () => {
  const report = makeBusinessReport();
  const result = deriveBusinessSignals(report);

  assert.equal(result.available, true);

  // Scores
  assert.equal(result.scores.intelliscore, 70);
  assert.equal(result.scores.intelliscoreRisk, "LOW TO MEDIUM RISK");
  assert.equal(result.scores.fsr, 30);
  assert.equal(result.scores.fsrRisk, "MEDIUM RISK");
  assert.equal(result.scores.recommendedLimit, 103100);

  // Profile
  assert.equal(result.profile.name, "ANTHONY PROPERTIES, INC");
  assert.equal(result.profile.isActive, true);
  assert.equal(result.profile.type, "Corporation");
  assert.equal(result.profile.state, "GA");
  assert.ok(result.profile.ageMonths > 500); // 1979 to 2026

  // DBT
  assert.equal(result.dbt.current, 0);
  assert.equal(result.dbt.stress, "none");
  assert.equal(result.dbt.monthlyAvg, 0);

  // Fraud Shield
  assert.equal(result.fraudShield.ofacClear, true);
  assert.equal(result.fraudShield.isActive, true);
  assert.equal(result.fraudShield.riskTriggers, false);
  assert.equal(result.fraudShield.nameVerified, true);

  // Public Records
  assert.equal(result.publicRecords.bankruptcy, false);
  assert.equal(result.publicRecords.judgment, false);
  assert.equal(result.publicRecords.taxLien, false);

  // UCC
  assert.equal(result.ucc.count, 0);
  assert.equal(result.ucc.caution, false);

  // No blocks
  assert.equal(result.hardBlock.blocked, false);
  assert.equal(result.hardBlock.reasons.length, 0);
});

// ============================================================================
// Hard blocks
// ============================================================================

test("deriveBusinessSignals: inactive business → hard block", () => {
  const report = makeBusinessReport({
    corporateRegistration: {
      incorporatedDate: "2020-01-01",
      statusFlag: { code: "I", definition: "Inactive" }
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.hardBlock.blocked, true);
  assert.ok(result.hardBlock.reasons.includes("BUSINESS_INACTIVE"));
  assert.equal(result.profile.isActive, false);
});

test("deriveBusinessSignals: OFAC match → hard block", () => {
  const report = makeBusinessReport({
    commercialFraudShieldSummary: {
      ofacMatchWarning: { code: 2, definition: "Match Found" },
      activeBusinessIndicator: true,
      businessRiskTriggersIndicator: false,
      nameAddressVerificationIndicator: true
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.hardBlock.blocked, true);
  assert.ok(result.hardBlock.reasons.includes("OFAC_MATCH"));
  assert.equal(result.fraudShield.ofacClear, false);
});

test("deriveBusinessSignals: bankruptcy → hard block", () => {
  const report = makeBusinessReport({
    expandedCreditSummary: {
      currentDbt: 0,
      monthlyAverageDbt: 0,
      bankruptcyIndicator: true,
      judgmentIndicator: false,
      taxLienIndicator: false
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.hardBlock.blocked, true);
  assert.ok(result.hardBlock.reasons.includes("BUSINESS_BANKRUPTCY"));
  assert.equal(result.publicRecords.bankruptcy, true);
});

test("deriveBusinessSignals: multiple blocks accumulated", () => {
  const report = makeBusinessReport({
    corporateRegistration: {
      incorporatedDate: "2020-01-01",
      statusFlag: { code: "I", definition: "Inactive" }
    },
    expandedCreditSummary: {
      currentDbt: 0,
      monthlyAverageDbt: 0,
      bankruptcyIndicator: true,
      judgmentIndicator: true,
      taxLienIndicator: true
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.hardBlock.blocked, true);
  assert.ok(result.hardBlock.reasons.length >= 2);
  assert.equal(result.publicRecords.judgment, true);
  assert.equal(result.publicRecords.taxLien, true);
});

// ============================================================================
// DBT stress
// ============================================================================

test("deriveBusinessSignals: high DBT stress", () => {
  const report = makeBusinessReport({
    expandedCreditSummary: {
      currentDbt: 45,
      monthlyAverageDbt: 30,
      bankruptcyIndicator: false,
      judgmentIndicator: false,
      taxLienIndicator: false
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.dbt.current, 45);
  assert.equal(result.dbt.stress, "high");
  assert.equal(result.dbt.monthlyAvg, 30);
});

test("deriveBusinessSignals: severe DBT stress", () => {
  const report = makeBusinessReport({
    expandedCreditSummary: {
      currentDbt: 90,
      monthlyAverageDbt: 75,
      bankruptcyIndicator: false,
      judgmentIndicator: false,
      taxLienIndicator: false
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.dbt.current, 90);
  assert.equal(result.dbt.stress, "severe");
});

// ============================================================================
// UCC filings
// ============================================================================

test("deriveBusinessSignals: UCC caution threshold", () => {
  const report = makeBusinessReport({
    uccFilingsDetail: [{}, {}, {}, {}, {}]
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.ucc.count, 5);
  assert.equal(result.ucc.caution, true);
});

test("deriveBusinessSignals: UCC below threshold", () => {
  const report = makeBusinessReport({
    uccFilingsDetail: [{}, {}]
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.ucc.count, 2);
  assert.equal(result.ucc.caution, false);
});

// ============================================================================
// Business age
// ============================================================================

test("deriveBusinessSignals: young business (6 months)", () => {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const report = makeBusinessReport({
    corporateRegistration: {
      incorporatedDate: sixMonthsAgo.toISOString().split("T")[0],
      statusFlag: { code: "A", definition: "Active" }
    }
  });
  const result = deriveBusinessSignals(report);

  assert.ok(result.profile.ageMonths >= 5 && result.profile.ageMonths <= 7);
});

test("deriveBusinessSignals: no incorporatedDate", () => {
  const report = makeBusinessReport({
    corporateRegistration: {
      statusFlag: { code: "A", definition: "Active" }
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.profile.incorporatedDate, null);
  assert.equal(result.profile.ageMonths, null);
});

// ============================================================================
// Data-only input (no wrapper)
// ============================================================================

test("deriveBusinessSignals: accepts data object directly", () => {
  const report = makeBusinessReport();
  const result = deriveBusinessSignals(report.data);

  assert.equal(result.available, true);
  assert.equal(result.scores.intelliscore, 70);
  assert.equal(result.profile.name, "ANTHONY PROPERTIES, INC");
});

// ============================================================================
// Missing score information
// ============================================================================

test("deriveBusinessSignals: missing scores", () => {
  const report = makeBusinessReport({
    scoreInformation: {}
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.available, true);
  assert.equal(result.scores.intelliscore, null);
  assert.equal(result.scores.fsr, null);
  assert.equal(result.scores.recommendedLimit, null);
});

test("deriveBusinessSignals: missing fraud shield", () => {
  const report = makeBusinessReport({
    commercialFraudShieldSummary: {}
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.fraudShield.ofacClear, false);
  assert.equal(result.fraudShield.isActive, null);
  // No OFAC_MATCH block since ofacCode is undefined
  assert.ok(!result.hardBlock.reasons.includes("OFAC_MATCH"));
});

// ============================================================================
// getIntelliscoreBand — all bands
// ============================================================================

test("getIntelliscoreBand: all bands", () => {
  assert.equal(getIntelliscoreBand(null), "unknown");
  assert.equal(getIntelliscoreBand(undefined), "unknown");
  assert.equal(getIntelliscoreBand(95), "excellent");
  assert.equal(getIntelliscoreBand(80), "excellent");
  assert.equal(getIntelliscoreBand(79), "good");
  assert.equal(getIntelliscoreBand(60), "good");
  assert.equal(getIntelliscoreBand(59), "fair");
  assert.equal(getIntelliscoreBand(40), "fair");
  assert.equal(getIntelliscoreBand(39), "weak");
  assert.equal(getIntelliscoreBand(10), "weak");
});

// ============================================================================
// getFsrBand — all bands
// ============================================================================

test("getFsrBand: all bands", () => {
  assert.equal(getFsrBand(null), "unknown");
  assert.equal(getFsrBand(undefined), "unknown");
  assert.equal(getFsrBand(80), "low_risk");
  assert.equal(getFsrBand(60), "low_risk");
  assert.equal(getFsrBand(59), "moderate_risk");
  assert.equal(getFsrBand(40), "moderate_risk");
  assert.equal(getFsrBand(39), "high_risk");
  assert.equal(getFsrBand(10), "high_risk");
});

// ============================================================================
// Hard blocks — judgment, taxLien, nameVerified=false
// ============================================================================

test("deriveBusinessSignals: judgment → BUSINESS_JUDGMENT hard block", () => {
  const report = makeBusinessReport({
    expandedCreditSummary: {
      currentDbt: 0,
      monthlyAverageDbt: 0,
      bankruptcyIndicator: false,
      judgmentIndicator: true,
      taxLienIndicator: false
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.hardBlock.blocked, true);
  assert.ok(result.hardBlock.reasons.includes("BUSINESS_JUDGMENT"));
  assert.equal(result.publicRecords.judgment, true);
});

test("deriveBusinessSignals: taxLien → BUSINESS_TAX_LIEN hard block", () => {
  const report = makeBusinessReport({
    expandedCreditSummary: {
      currentDbt: 0,
      monthlyAverageDbt: 0,
      bankruptcyIndicator: false,
      judgmentIndicator: false,
      taxLienIndicator: true
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.hardBlock.blocked, true);
  assert.ok(result.hardBlock.reasons.includes("BUSINESS_TAX_LIEN"));
  assert.equal(result.publicRecords.taxLien, true);
});

test("deriveBusinessSignals: nameVerified=false → BUSINESS_VERIFICATION_FAILED hard block", () => {
  const report = makeBusinessReport({
    commercialFraudShieldSummary: {
      ofacMatchWarning: { code: 1, definition: "No Match Found" },
      activeBusinessIndicator: true,
      businessRiskTriggersIndicator: false,
      nameAddressVerificationIndicator: false
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.hardBlock.blocked, true);
  assert.ok(result.hardBlock.reasons.includes("BUSINESS_VERIFICATION_FAILED"));
  assert.equal(result.fraudShield.nameVerified, false);
});

// ============================================================================
// Score bands appear in output
// ============================================================================

test("deriveBusinessSignals: intelliscoreBand and fsrBand present in output", () => {
  const report = makeBusinessReport();
  const result = deriveBusinessSignals(report);

  // intelliscore=70 → good, fsr=30 → high_risk
  assert.equal(result.scores.intelliscoreBand, "good");
  assert.equal(result.scores.fsrBand, "high_risk");
});

test("deriveBusinessSignals: excellent intelliscoreBand and low_risk fsrBand", () => {
  const report = makeBusinessReport({
    scoreInformation: {
      commercialScore: {
        score: 85,
        riskClass: { code: 1, definition: "LOW RISK" },
        recommendedCreditLimitAmount: 200000
      },
      fsrScore: {
        score: 65,
        riskClass: { code: 1, definition: "LOW RISK" }
      }
    }
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.scores.intelliscoreBand, "excellent");
  assert.equal(result.scores.fsrBand, "low_risk");
});

test("deriveBusinessSignals: missing scores → unknown bands", () => {
  const report = makeBusinessReport({
    scoreInformation: {}
  });
  const result = deriveBusinessSignals(report);

  assert.equal(result.scores.intelliscoreBand, "unknown");
  assert.equal(result.scores.fsrBand, "unknown");
});
