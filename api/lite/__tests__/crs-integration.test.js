const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { runCRSEngine } = require("../crs/engine");

// ---------------------------------------------------------------------------
// Load saved sandbox responses
// ---------------------------------------------------------------------------
const SANDBOX_DIR = path.join(__dirname, "../../../../mar 2026");

function loadResponse(filename) {
  const filepath = path.join(SANDBOX_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, "utf8"));
}

const tuResponse = loadResponse("tu-sandbox-response.json");
const expResponse = loadResponse("exp-sandbox-response.json");
const efxResponse = loadResponse("efx-sandbox-response.json");

// Skip all tests if sandbox responses aren't available
const hasResponses = tuResponse && expResponse && efxResponse;

// Fixtures were pulled on 2026-03-11. Use a reference date within the 30-day freshness window
// so these tests remain stable regardless of wall-clock date.
const FIXTURE_REFERENCE_DATE = new Date("2026-03-25T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Helper: run engine with defaults
// ---------------------------------------------------------------------------
function runEngine(rawResponses, opts = {}) {
  return runCRSEngine({
    rawResponses,
    businessReport: opts.businessReport || null,
    submittedName: opts.name || "TEST USER",
    submittedAddress: opts.address || "123 Main St, Somewhere, TX 77001",
    formData: opts.formData || {},
    referenceDate: opts.referenceDate !== undefined ? opts.referenceDate : FIXTURE_REFERENCE_DATE
  });
}

// ============================================================================
// Single Bureau Tests
// ============================================================================

test("integration: TU only (BARBARA DOTY) → CONDITIONAL_APPROVAL", { skip: !hasResponses }, () => {
  const result = runEngine([tuResponse], { name: "BARBARA DOTY" });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "FUNDING_PLUS_REPAIR");
  assert.equal(typeof result.decision_label, "string");
  assert.ok(result.decision_label.length > 0);

  // Score
  assert.equal(result.consumerSignals.scores.median, 725);

  // Should have thin file finding (only 4 tradelines)
  assert.ok(result.reason_codes.includes("SINGLE_BUREAU_LOW_CONFIDENCE"));

  // Should produce documents
  assert.ok(result.documents);
  assert.ok(result.documents.letters.length > 0);

  // Preapprovals should exist
  assert.ok(result.preapprovals);
  assert.equal(typeof result.preapprovals.totalCombined, "number");

  // Audit trail
  assert.ok(result.audit);
  assert.ok(result.audit.pipeline);
});

test("integration: EXP only (WILLIE BOOZE) → REPAIR", { skip: !hasResponses }, () => {
  const result = runEngine([expResponse], { name: "WILLIE BOOZE" });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "REPAIR_ONLY");

  // Score should be 630
  assert.equal(result.consumerSignals.scores.median, 630);

  // Should have utilization issues (106%)
  assert.equal(result.consumerSignals.utilization.band, "critical");
  assert.ok(result.reason_codes.includes("VERY_HIGH_UTILIZATION"));

  // Should have inquiry pressure (23 inquiries)
  assert.ok(result.consumerSignals.inquiries.total > 10);

  // Consumer summary should be a string
  assert.equal(typeof result.consumer_summary, "string");
  assert.ok(result.consumer_summary.length > 20);
});

test("integration: EFX only (JOHN BIALOGLOW) → REPAIR", { skip: !hasResponses }, () => {
  const result = runEngine([efxResponse], { name: "JOHN BIALOGLOW" });

  assert.equal(result.ok, true);
  assert.equal(result.outcome, "REPAIR_ONLY");

  // Score should be 636
  assert.equal(result.consumerSignals.scores.median, 636);

  // Should have active derogatories
  assert.ok(result.consumerSignals.derogatories.active > 0);

  // Should produce repair package
  assert.equal(result.documents.package, "repair");
  assert.ok(result.documents.letters.length > 0);

  // Should have dispute letters
  const disputeLetters = result.documents.letters.filter(l => l.type === "dispute");
  assert.ok(disputeLetters.length > 0);

  // Suggestions should be present (object with layers array)
  assert.ok(result.suggestions);
  assert.equal(typeof result.suggestions, "object");
  assert.ok(Array.isArray(result.suggestions.layers));

  // Cards should include negatives-related tags
  assert.ok(result.cards.length > 0);
});

// ============================================================================
// Multi-Bureau Tests
// ============================================================================

test(
  "integration: all 3 bureaus combined → MANUAL_REVIEW (mixed identities)",
  { skip: !hasResponses },
  () => {
    // NOTE: 3 sandbox responses have 3 different identities (DOTY, BOOZE, BIALOGLOW)
    // so the identity gate correctly flags this as MANUAL_REVIEW
    const result = runEngine([tuResponse, expResponse, efxResponse]);

    assert.equal(result.ok, true);
    assert.equal(result.outcome, "MANUAL_REVIEW");

    // Should use all 3 bureaus
    assert.equal(result.normalized.meta.bureauCount, 3);
    assert.ok(result.normalized.meta.availableBureaus.length === 3);

    // Median score should be middle of 725, 630, 636
    assert.equal(result.consumerSignals.scores.median, 636);

    // Should have worst-case utilization from the combined view
    assert.ok(result.consumerSignals.utilization.pct > 30);

    // MANUAL_REVIEW confidence
    assert.ok(["high", "medium", "low"].includes(result.confidence));

    // MANUAL_REVIEW gets "hold" package with no letters but summary docs
    assert.ok(result.documents);
    assert.equal(result.documents.package, "hold");
    assert.equal(result.documents.letters.length, 0);

    // Summary documents should exist
    assert.ok(result.documents.summaryDocuments);
    assert.ok(result.documents.summaryDocuments.length > 0);
  }
);

test(
  "integration: TU + EXP (2 bureaus) → outcome depends on consensus",
  { skip: !hasResponses },
  () => {
    const result = runEngine([tuResponse, expResponse]);

    assert.equal(result.ok, true);
    assert.equal(result.normalized.meta.bureauCount, 2);

    // With TU=725 and EXP=630, median = 630 or 677 depending on algo
    assert.ok(result.consumerSignals.scores.median > 0);

    // Should still produce a valid output
    assert.ok(result.documents);
    assert.ok(result.preapprovals);
    assert.ok(result.audit);
  }
);

// ============================================================================
// Output Shape Validation (Spec Section 6)
// ============================================================================

test("integration: output matches spec Section 6 canonical shape", { skip: !hasResponses }, () => {
  const result = runEngine([tuResponse], { name: "BARBARA DOTY" });

  // Top-level required fields
  assert.equal(typeof result.ok, "boolean");
  assert.equal(typeof result.outcome, "string");
  assert.equal(typeof result.decision_label, "string");
  assert.equal(typeof result.decision_explanation, "string");
  assert.ok(Array.isArray(result.reason_codes));
  assert.equal(typeof result.confidence, "string");
  assert.equal(typeof result.consumer_summary, "string");
  assert.equal(typeof result.business_summary, "string");

  // Detail sections
  assert.equal(typeof result.preapprovals, "object");
  assert.ok(Array.isArray(result.optimization_findings));
  assert.equal(typeof result.suggestions, "object");
  assert.ok(Array.isArray(result.suggestions.layers));
  assert.ok(Array.isArray(result.cards));
  assert.equal(typeof result.documents, "object");
  assert.equal(typeof result.redirect, "object");
  assert.equal(typeof result.audit, "object");

  // CRM payload
  assert.ok(result.crm_payload);

  // Internal detail
  assert.ok(result.normalized);
  assert.ok(result.identityGate);
  assert.ok(result.consumerSignals);
  assert.ok(result.businessSignals);
  assert.ok(result.outcomeResult);
});

// ============================================================================
// Preapproval Structure
// ============================================================================

test("integration: preapprovals have correct structure", { skip: !hasResponses }, () => {
  const result = runEngine([tuResponse], { name: "BARBARA DOTY" });

  const pa = result.preapprovals;
  assert.equal(typeof pa.totalPersonal, "number");
  assert.equal(typeof pa.totalBusiness, "number");
  assert.equal(typeof pa.totalCombined, "number");
  assert.equal(typeof pa.confidenceBand, "string");
  assert.equal(typeof pa.customerSafe, "boolean");

  // CONDITIONAL_APPROVAL should have customerSafe = true
  assert.equal(pa.customerSafe, true);
});

test("integration: REPAIR preapprovals are not customer-safe", { skip: !hasResponses }, () => {
  const result = runEngine([efxResponse], { name: "JOHN BIALOGLOW" });

  assert.equal(result.outcome, "REPAIR_ONLY");
  assert.equal(result.preapprovals.customerSafe, false);
});

// ============================================================================
// Findings Structure
// ============================================================================

test("integration: findings have correct structure per finding", { skip: !hasResponses }, () => {
  const result = runEngine([efxResponse], { name: "JOHN BIALOGLOW" });

  assert.ok(result.optimization_findings.length > 0);

  for (const finding of result.optimization_findings) {
    assert.equal(typeof finding.code, "string");
    assert.equal(typeof finding.severity, "string");
    assert.ok(["critical", "high", "medium", "low", "info"].includes(finding.severity));
    assert.equal(typeof finding.category, "string");
    assert.equal(typeof finding.plainEnglishProblem, "string");
    assert.equal(typeof finding.whyItMatters, "string");
    assert.equal(typeof finding.whatToDoNext, "string");
    assert.equal(typeof finding.customerSafe, "boolean");
    assert.ok(Array.isArray(finding.documentTriggers));
    assert.ok(Array.isArray(finding.workflowTags));
  }
});

// ============================================================================
// Document Package Validation
// ============================================================================

test("integration: repair package has correct letter specs", { skip: !hasResponses }, () => {
  const result = runEngine([efxResponse], { name: "JOHN BIALOGLOW" });

  assert.equal(result.documents.package, "repair");

  // Each letter should have type, bureau, fieldKey
  for (const letter of result.documents.letters) {
    assert.equal(typeof letter.type, "string");
    assert.ok(["dispute", "personal_info", "inquiry_removal"].includes(letter.type));
    assert.equal(typeof letter.bureau, "string");
    assert.equal(typeof letter.fieldKey, "string");
  }

  // Should have personal info letters
  const personalLetters = result.documents.letters.filter(l => l.type === "personal_info");
  assert.ok(personalLetters.length > 0);
});

test("integration: funding package has inquiry + personal letters", { skip: !hasResponses }, () => {
  const result = runEngine([tuResponse], { name: "BARBARA DOTY" });

  // CONDITIONAL_APPROVAL gets funding package
  assert.equal(result.documents.package, "funding");

  // Should have personal info letters
  const personalLetters = result.documents.letters.filter(l => l.type === "personal_info");
  assert.ok(personalLetters.length > 0);
});

// ============================================================================
// CRM Payload
// ============================================================================

test("integration: CRM payload has required fields", { skip: !hasResponses }, () => {
  const result = runEngine([tuResponse, expResponse, efxResponse], {
    name: "TEST USER",
    formData: { email: "test@fundhub.ai", phone: "5551234567", ref: "ref_test123" }
  });

  const crm = result.crm_payload;
  assert.ok(crm);
  assert.equal(typeof crm.resultType, "string");
  assert.ok(["funding", "repair", "hold"].includes(crm.resultType));
  assert.ok(crm.tags);
  assert.ok(Array.isArray(crm.tags));
});

// ============================================================================
// Edge Cases
// ============================================================================

test("integration: single response array wrapping works", { skip: !hasResponses }, () => {
  // Engine should handle a single response in the array
  const result = runEngine([tuResponse]);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.meta.bureauCount, 1);
});

test(
  "integration: no business report → business summary mentions LLC",
  { skip: !hasResponses },
  () => {
    const result = runEngine([tuResponse], { name: "BARBARA DOTY" });

    assert.ok(result.business_summary);
    assert.ok(
      result.business_summary.toLowerCase().includes("llc") ||
        result.business_summary.toLowerCase().includes("business")
    );
  }
);

test("integration: reason codes are all strings", { skip: !hasResponses }, () => {
  const result = runEngine([tuResponse, expResponse, efxResponse]);

  for (const code of result.reason_codes) {
    assert.equal(typeof code, "string");
    // Should be UPPER_SNAKE_CASE
    assert.ok(/^[A-Z][A-Z0-9_]+$/.test(code), `Invalid reason code format: ${code}`);
  }
});

test("integration: redirect path is consistent with outcome", { skip: !hasResponses }, () => {
  // REPAIR → repair path
  const repairResult = runEngine([efxResponse], { name: "JOHN BIALOGLOW" });
  assert.equal(repairResult.redirect.path, "repair");

  // CONDITIONAL_APPROVAL → funding path
  const condResult = runEngine([tuResponse], { name: "BARBARA DOTY" });
  assert.equal(condResult.redirect.path, "funding");
});

// ============================================================================
// Timing / Performance
// ============================================================================

test("integration: engine completes in under 100ms for 3 bureaus", { skip: !hasResponses }, () => {
  const start = Date.now();
  const result = runEngine([tuResponse, expResponse, efxResponse]);
  const elapsed = Date.now() - start;

  assert.equal(result.ok, true);
  assert.ok(elapsed < 100, `Engine took ${elapsed}ms, expected < 100ms`);
});
