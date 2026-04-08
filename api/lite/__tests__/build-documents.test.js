const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDocuments } = require("../crs/build-documents");

function makeNormalized(bureaus = ["transunion", "experian", "equifax"]) {
  return {
    meta: { availableBureaus: bureaus },
    inquiries: [
      { source: "transunion", creditorName: "TEST", date: "2026-01-01" },
      { source: "experian", creditorName: "TEST", date: "2026-01-01" }
    ]
  };
}

// ============================================================================
// Tests
// ============================================================================

test("buildDocuments: FRAUD_HOLD → hold package", () => {
  const result = buildDocuments("FRAUD_HOLD", [], makeNormalized(), {});
  assert.equal(result.package, "hold");
  assert.equal(result.letters.length, 0);
});

test("buildDocuments: MANUAL_REVIEW → hold package", () => {
  const result = buildDocuments("MANUAL_REVIEW", [], makeNormalized(), {});
  assert.equal(result.package, "hold");
  assert.equal(result.letters.length, 0);
});

test("buildDocuments: REPAIR → repair package with 3 rounds", () => {
  const result = buildDocuments("REPAIR_ONLY", [], makeNormalized(), {});
  assert.equal(result.package, "repair");

  const disputes = result.letters.filter(l => l.type === "dispute");
  const personal = result.letters.filter(l => l.type === "personal_info");

  // 3 rounds × 3 bureaus = 9 dispute letters
  assert.equal(disputes.length, 9);
  // 3 personal info letters
  assert.equal(personal.length, 3);

  // Check field key format
  assert.ok(disputes[0].fieldKey.startsWith("repair_letter_url__round_"));
  assert.ok(personal[0].fieldKey.startsWith("repair_letter_url__personal_info_dispute__"));
});

test("buildDocuments: REPAIR with 2 bureaus", () => {
  const result = buildDocuments("REPAIR_ONLY", [], makeNormalized(["transunion", "experian"]), {});
  const disputes = result.letters.filter(l => l.type === "dispute");
  assert.equal(disputes.length, 6); // 3 rounds × 2 bureaus
});

test("buildDocuments: FULL_STACK → funding package", () => {
  const result = buildDocuments("FULL_FUNDING", [], makeNormalized(), {});
  assert.equal(result.package, "funding");

  const inquiryLetters = result.letters.filter(l => l.type === "inquiry_removal");
  const personal = result.letters.filter(l => l.type === "personal_info");

  // Only TU and EXP have inquiries in our fixture
  assert.equal(inquiryLetters.length, 2);
  assert.equal(personal.length, 3);

  assert.ok(inquiryLetters[0].fieldKey.startsWith("funding_letter_url__inquiry_cleanup__"));
  assert.ok(personal[0].fieldKey.startsWith("funding_letter_url__personal_info_cleanup__"));
});

test("buildDocuments: PREMIUM_STACK → funding package", () => {
  const result = buildDocuments("PREMIUM_STACK", [], makeNormalized(), {});
  assert.equal(result.package, "funding");
});

test("buildDocuments: CONDITIONAL → funding package", () => {
  const result = buildDocuments("FUNDING_PLUS_REPAIR", [], makeNormalized(), {});
  assert.equal(result.package, "funding");
});

test("buildDocuments: summary describes letter counts", () => {
  const result = buildDocuments("REPAIR_ONLY", [], makeNormalized(), {});
  assert.ok(result.summary.includes("9 dispute"));
  assert.ok(result.summary.includes("3 personal"));
});

test("buildDocuments: bureau key abbreviations correct", () => {
  const result = buildDocuments("REPAIR_ONLY", [], makeNormalized(), {});
  const keys = result.letters.map(l => l.fieldKey);
  assert.ok(keys.some(k => k.includes("_ex")));
  assert.ok(keys.some(k => k.includes("_eq")));
  assert.ok(keys.some(k => k.includes("_tr")));
});

// ============================================================================
// Second audit fix pass — summaryDocuments present in all packages
// ============================================================================

test("buildDocuments: summaryDocuments present in hold package", () => {
  const result = buildDocuments("FRAUD_HOLD", [], makeNormalized(), {});
  assert.ok(Array.isArray(result.summaryDocuments), "summaryDocuments should be an array");
  assert.ok(
    result.summaryDocuments.length > 0,
    "hold package should have at least one summaryDocument"
  );
  assert.ok(
    result.summaryDocuments.every(d => d.type && d.description),
    "each summaryDocument should have type and description"
  );
});

test("buildDocuments: summaryDocuments present in repair package", () => {
  const result = buildDocuments("REPAIR_ONLY", [], makeNormalized(), {});
  assert.ok(Array.isArray(result.summaryDocuments), "summaryDocuments should be an array");
  assert.ok(
    result.summaryDocuments.length > 0,
    "repair package should have at least one summaryDocument"
  );
  assert.ok(
    result.summaryDocuments.every(d => d.type && d.description),
    "each summaryDocument should have type and description"
  );
});

test("buildDocuments: summaryDocuments present in funding package", () => {
  const result = buildDocuments("FULL_FUNDING", [], makeNormalized(), {});
  assert.ok(Array.isArray(result.summaryDocuments), "summaryDocuments should be an array");
  assert.ok(
    result.summaryDocuments.length > 0,
    "funding package should have at least one summaryDocument"
  );
  assert.ok(
    result.summaryDocuments.every(d => d.type && d.description),
    "each summaryDocument should have type and description"
  );
});
