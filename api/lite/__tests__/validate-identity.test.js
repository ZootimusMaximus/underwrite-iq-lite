const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateIdentity,
  validateNameMatch,
  validateReportRecency,
  normalizeName,
  namesMatch,
  collectReportNames,
  MAX_REPORT_AGE_DAYS
} = require("../validate-identity");

// ============================================================================
// normalizeName tests
// ============================================================================
test("normalizeName removes special characters", () => {
  assert.equal(normalizeName("John O'Brien"), "john obrien");
  assert.equal(normalizeName("Mary-Jane Watson"), "maryjane watson");
});

test("normalizeName handles null and empty", () => {
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName(""), "");
  assert.equal(normalizeName(undefined), "");
});

test("normalizeName collapses whitespace", () => {
  assert.equal(normalizeName("John   Doe"), "john doe");
  assert.equal(normalizeName("  Jane  Smith  "), "jane smith");
});

// ============================================================================
// namesMatch tests
// ============================================================================
test("namesMatch returns true for exact match", () => {
  assert.equal(namesMatch("John Doe", "JOHN DOE"), true);
  assert.equal(namesMatch("jane smith", "Jane Smith"), true);
});

test("namesMatch returns true for initial match", () => {
  assert.equal(namesMatch("J Doe", "JOHN DOE"), true);
  assert.equal(namesMatch("John Doe", "J DOE"), true);
});

test("namesMatch returns false for different first names", () => {
  assert.equal(namesMatch("John Doe", "Jane Doe"), false);
  assert.equal(namesMatch("Robert Smith", "Richard Smith"), false);
});

test("namesMatch returns false for different last names", () => {
  assert.equal(namesMatch("John Doe", "John Smith"), false);
});

test("namesMatch handles middle names", () => {
  // First and last should still match
  assert.equal(namesMatch("John Michael Doe", "JOHN DOE"), true);
  assert.equal(namesMatch("John Doe", "JOHN MICHAEL DOE"), true);
});

// ============================================================================
// collectReportNames tests
// ============================================================================
test("collectReportNames collects from all bureaus", () => {
  const bureaus = {
    experian: { names: ["JOHN DOE", "J DOE"] },
    equifax: { names: ["JOHN M DOE"] },
    transunion: { names: ["JOHN DOE"] }
  };

  const names = collectReportNames(bureaus);
  assert.equal(names.length, 3); // Unique names
  assert.ok(names.includes("JOHN DOE"));
  assert.ok(names.includes("J DOE"));
  assert.ok(names.includes("JOHN M DOE"));
});

test("collectReportNames handles missing bureaus", () => {
  const bureaus = {
    experian: { names: ["JOHN DOE"] },
    equifax: null,
    transunion: {}
  };

  const names = collectReportNames(bureaus);
  assert.equal(names.length, 1);
});

test("collectReportNames handles empty input", () => {
  assert.deepEqual(collectReportNames(null), []);
  assert.deepEqual(collectReportNames({}), []);
});

// ============================================================================
// validateNameMatch tests
// ============================================================================
test("validateNameMatch passes when name matches report", () => {
  const bureaus = {
    experian: { names: ["JOHN DOE", "J DOE"] }
  };

  const result = validateNameMatch("John Doe", bureaus);
  assert.equal(result.ok, true);
  assert.equal(result.matchedName, "JOHN DOE");
});

test("validateNameMatch fails when name does not match", () => {
  const bureaus = {
    experian: { names: ["JANE SMITH"] }
  };

  const result = validateNameMatch("John Doe", bureaus);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("does not match"));
});

test("validateNameMatch passes with warning when no names in report", () => {
  const bureaus = {
    experian: { names: [] }
  };

  const result = validateNameMatch("John Doe", bureaus);
  assert.equal(result.ok, true);
  assert.ok(result.warning);
});

test("validateNameMatch fails when no name provided", () => {
  const result = validateNameMatch("", {});
  assert.equal(result.ok, false);
});

// ============================================================================
// validateReportRecency tests
// ============================================================================
test("validateReportRecency passes for recent report", () => {
  const today = new Date();
  const recentDate = new Date(today);
  recentDate.setDate(recentDate.getDate() - 10); // 10 days ago

  const bureaus = {
    experian: { reportDate: recentDate.toISOString().slice(0, 10) }
  };

  const result = validateReportRecency(bureaus);
  assert.equal(result.ok, true);
  assert.ok(result.ageDays <= 10);
});

test("validateReportRecency fails for old report", () => {
  const today = new Date();
  const oldDate = new Date(today);
  oldDate.setDate(oldDate.getDate() - 45); // 45 days ago

  const bureaus = {
    experian: { reportDate: oldDate.toISOString().slice(0, 10) }
  };

  const result = validateReportRecency(bureaus);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("days old"));
});

test("validateReportRecency passes with warning when no date", () => {
  const bureaus = {
    experian: {}
  };

  const result = validateReportRecency(bureaus);
  assert.equal(result.ok, true);
  assert.ok(result.warning);
});

test("validateReportRecency uses most recent date from multiple bureaus", () => {
  const today = new Date();
  const recent = new Date(today);
  recent.setDate(recent.getDate() - 5);
  const older = new Date(today);
  older.setDate(older.getDate() - 20);

  const bureaus = {
    experian: { reportDate: older.toISOString().slice(0, 10) },
    equifax: { reportDate: recent.toISOString().slice(0, 10) }
  };

  const result = validateReportRecency(bureaus);
  assert.equal(result.ok, true);
  assert.ok(result.ageDays <= 6);
});

// ============================================================================
// validateIdentity (main function) tests
// ============================================================================
test("validateIdentity passes when all checks pass", () => {
  const today = new Date();
  const recentDate = new Date(today);
  recentDate.setDate(recentDate.getDate() - 5);

  const bureaus = {
    experian: {
      names: ["JOHN DOE"],
      reportDate: recentDate.toISOString().slice(0, 10)
    }
  };

  const result = validateIdentity("John Doe", bureaus);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test("validateIdentity fails when name doesn't match", () => {
  const bureaus = {
    experian: { names: ["JANE SMITH"] }
  };

  const result = validateIdentity("John Doe", bureaus);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("does not match"));
});

test("validateIdentity fails when report is too old", () => {
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 45);

  const bureaus = {
    experian: {
      names: ["JOHN DOE"],
      reportDate: oldDate.toISOString().slice(0, 10)
    }
  };

  const result = validateIdentity("John Doe", bureaus);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("days old"));
});

test("validateIdentity can skip name match", () => {
  const bureaus = {
    experian: { names: ["JANE SMITH"] }
  };

  const result = validateIdentity("John Doe", bureaus, { skipNameMatch: true });
  assert.equal(result.ok, true);
});

test("validateIdentity can skip recency check", () => {
  const oldDate = new Date();
  oldDate.setDate(oldDate.getDate() - 45);

  const bureaus = {
    experian: {
      names: ["JOHN DOE"],
      reportDate: oldDate.toISOString().slice(0, 10)
    }
  };

  const result = validateIdentity("John Doe", bureaus, { skipRecencyCheck: true });
  assert.equal(result.ok, true);
});

test("MAX_REPORT_AGE_DAYS is 30", () => {
  assert.equal(MAX_REPORT_AGE_DAYS, 30);
});
