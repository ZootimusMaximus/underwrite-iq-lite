const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { normalizeSoftPullPayload } = require("../crs/normalize-soft-pull");
const {
  runIdentityAndFraudGate,
  normalizeName,
  extractNameParts,
  nameMatchesCRS,
  checkNameMatch,
  checkReportFreshness,
  checkAddressConflicts,
  checkFraudSignals,
  checkFileIntegrity
} = require("../crs/identity-fraud-gate");

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

// Fixtures were pulled on 2026-03-11. Use a reference date within the 30-day freshness window
// so these tests remain stable regardless of wall-clock date.
const FIXTURE_REFERENCE_DATE = new Date("2026-03-25T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNormalized(overrides = {}) {
  return {
    identity: { names: [], ssns: [], dobs: [], addresses: [], employers: [] },
    bureaus: {
      transunion: {
        available: true,
        score: 700,
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
    meta: {
      requestDate: new Date().toISOString().split("T")[0],
      requestingParty: "test",
      bureauCount: 1,
      availableBureaus: ["transunion"]
    },
    ...overrides
  };
}

// ============================================================================
// normalizeName / extractNameParts
// ============================================================================

test("normalizeName: removes special chars and lowercases", () => {
  assert.equal(normalizeName("JOHN Q. DOE-SMITH"), "john q doesmith");
  assert.equal(normalizeName("  Mary   Jane  "), "mary jane");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName(""), "");
});

test("extractNameParts: splits first and last", () => {
  const parts = extractNameParts("John Michael Smith");
  assert.equal(parts.first, "john");
  assert.equal(parts.last, "smith");
});

test("extractNameParts: single name", () => {
  const parts = extractNameParts("Madonna");
  assert.equal(parts.first, "madonna");
  assert.equal(parts.last, "");
});

// ============================================================================
// nameMatchesCRS
// ============================================================================

test("nameMatchesCRS: exact match", () => {
  assert.equal(
    nameMatchesCRS("Barbara Doty", { first: "BARBARA", last: "DOTY", source: "transunion" }),
    true
  );
});

test("nameMatchesCRS: initial match", () => {
  assert.equal(
    nameMatchesCRS("B Doty", { first: "BARBARA", last: "DOTY", source: "transunion" }),
    true
  );
});

test("nameMatchesCRS: middle name ignored", () => {
  assert.equal(
    nameMatchesCRS("Barbara Doty", {
      first: "BARBARA",
      middle: "M",
      last: "DOTY",
      source: "transunion"
    }),
    true
  );
});

test("nameMatchesCRS: different first name", () => {
  assert.equal(
    nameMatchesCRS("Sarah Doty", { first: "BARBARA", last: "DOTY", source: "transunion" }),
    false
  );
});

test("nameMatchesCRS: different last name", () => {
  assert.equal(
    nameMatchesCRS("Barbara Smith", { first: "BARBARA", last: "DOTY", source: "transunion" }),
    false
  );
});

// ============================================================================
// checkNameMatch
// ============================================================================

test("checkNameMatch: no name provided", () => {
  const result = checkNameMatch(null, []);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NAME_NOT_PROVIDED");
});

test("checkNameMatch: no names on file → warning, not fail", () => {
  const result = checkNameMatch("John Smith", []);
  assert.equal(result.ok, true);
  assert.equal(result.warning, "NO_NAMES_ON_FILE");
});

test("checkNameMatch: match found", () => {
  const names = [{ first: "BARBARA", middle: "M", last: "DOTY", source: "transunion" }];
  const result = checkNameMatch("Barbara Doty", names);
  assert.equal(result.ok, true);
  assert.ok(result.matchedName);
});

test("checkNameMatch: no match", () => {
  const names = [{ first: "BARBARA", middle: "M", last: "DOTY", source: "transunion" }];
  const result = checkNameMatch("John Smith", names);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NAME_MISMATCH");
});

// ============================================================================
// checkReportFreshness
// ============================================================================

test("checkReportFreshness: fresh reports", () => {
  const today = new Date().toISOString().split("T")[0];
  const bureaus = {
    transunion: { available: true, reportDate: today }
  };
  const result = checkReportFreshness(bureaus);
  assert.equal(result.ok, true);
});

test("checkReportFreshness: stale reports", () => {
  const old = new Date();
  old.setDate(old.getDate() - 60);
  const bureaus = {
    transunion: { available: true, reportDate: old.toISOString().split("T")[0] }
  };
  const result = checkReportFreshness(bureaus);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ALL_REPORTS_STALE");
});

test("checkReportFreshness: no report dates → warning", () => {
  const bureaus = {
    transunion: { available: true }
  };
  const result = checkReportFreshness(bureaus);
  assert.equal(result.ok, true);
  assert.equal(result.warning, "NO_REPORT_DATES");
});

test("checkReportFreshness: mixed fresh and stale", () => {
  const today = new Date().toISOString().split("T")[0];
  const old = new Date();
  old.setDate(old.getDate() - 60);
  const bureaus = {
    transunion: { available: true, reportDate: today },
    experian: { available: true, reportDate: old.toISOString().split("T")[0] }
  };
  const result = checkReportFreshness(bureaus);
  assert.equal(result.ok, true); // at least one fresh
});

// ============================================================================
// checkAddressConflicts
// ============================================================================

test("checkAddressConflicts: same zip across bureaus", () => {
  const addresses = [
    { line1: "123 Main St", zip: "75201", source: "transunion" },
    { line1: "123 Main Street", zip: "75201", source: "experian" }
  ];
  const result = checkAddressConflicts(addresses);
  assert.equal(result.ok, true);
});

test("checkAddressConflicts: different zips → conflict", () => {
  const addresses = [
    { line1: "123 Main St", zip: "75201", source: "transunion" },
    { line1: "456 Oak Ave", zip: "90210", source: "experian" }
  ];
  const result = checkAddressConflicts(addresses);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ADDRESS_CONFLICT");
  assert.equal(result.conflicts.length, 1);
});

test("checkAddressConflicts: single bureau → ok", () => {
  const addresses = [
    { line1: "123 Main St", zip: "75201", source: "transunion" },
    { line1: "456 Old St", zip: "75201", source: "transunion" }
  ];
  const result = checkAddressConflicts(addresses);
  assert.equal(result.ok, true);
});

// ============================================================================
// checkFraudSignals
// ============================================================================

test("checkFraudSignals: no fraudFinders → ok", () => {
  const result = checkFraudSignals(null);
  assert.equal(result.ok, true);
  assert.equal(result.available, false);
});

test("checkFraudSignals: clean signals", () => {
  const result = checkFraudSignals({
    risk: {
      score: 20,
      tumblingRisk: 0,
      postalMatch: { lastName: "match", street: "match", zip: "match" }
    },
    emailValidation: { status: "valid" }
  });
  assert.equal(result.ok, true);
  assert.equal(result.flags.length, 0);
});

test("checkFraudSignals: high risk score", () => {
  const result = checkFraudSignals({
    risk: { score: 75, tumblingRisk: 0 },
    emailValidation: null
  });
  assert.equal(result.ok, false);
  assert.ok(result.flags.includes("HIGH_FRAUD_RISK_SCORE"));
});

test("checkFraudSignals: tumbling risk", () => {
  const result = checkFraudSignals({
    risk: { score: 30, tumblingRisk: 1 },
    emailValidation: null
  });
  assert.equal(result.ok, false);
  assert.ok(result.flags.includes("TUMBLING_RISK"));
});

test("checkFraudSignals: invalid email", () => {
  const result = checkFraudSignals({
    risk: null,
    emailValidation: { status: "invalid" }
  });
  assert.equal(result.ok, false);
  assert.ok(result.flags.includes("EMAIL_INVALID"));
});

test("checkFraudSignals: postal mismatches", () => {
  const result = checkFraudSignals({
    risk: {
      score: 30,
      tumblingRisk: 0,
      postalMatch: { lastName: "no_match", street: "no_match", zip: "match" }
    },
    emailValidation: null
  });
  assert.equal(result.ok, false);
  assert.ok(result.flags.includes("POSTAL_LASTNAME_MISMATCH"));
  assert.ok(result.flags.includes("POSTAL_STREET_MISMATCH"));
});

// ============================================================================
// checkFileIntegrity
// ============================================================================

test("checkFileIntegrity: has scores", () => {
  const result = checkFileIntegrity({
    transunion: { available: true, score: 725 }
  });
  assert.equal(result.ok, true);
});

test("checkFileIntegrity: no bureaus", () => {
  const result = checkFileIntegrity({
    transunion: { available: false, score: null },
    experian: { available: false, score: null },
    equifax: { available: false, score: null }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_BUREAUS_AVAILABLE");
});

test("checkFileIntegrity: bureau available but no score", () => {
  const result = checkFileIntegrity({
    transunion: { available: true, score: null }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_SCORES_RETURNED");
});

// ============================================================================
// runIdentityAndFraudGate — synthetic scenarios
// ============================================================================

test("runIdentityAndFraudGate: clean pass", () => {
  const normalized = makeNormalized({
    identity: {
      names: [{ first: "JOHN", last: "SMITH", source: "transunion" }],
      ssns: [],
      dobs: [],
      addresses: [{ line1: "123 Main", zip: "75201", source: "transunion" }],
      employers: []
    }
  });
  const result = runIdentityAndFraudGate(normalized, "John Smith");
  assert.equal(result.passed, true);
  assert.equal(result.outcome, null);
  assert.equal(result.confidence, "high");
});

test("runIdentityAndFraudGate: name mismatch → MANUAL_REVIEW", () => {
  const normalized = makeNormalized({
    identity: {
      names: [{ first: "BARBARA", last: "DOTY", source: "transunion" }],
      ssns: [],
      dobs: [],
      addresses: [],
      employers: []
    }
  });
  const result = runIdentityAndFraudGate(normalized, "John Smith");
  assert.equal(result.passed, false);
  assert.equal(result.outcome, "MANUAL_REVIEW");
  assert.ok(result.reasons.includes("NAME_MISMATCH"));
});

test("runIdentityAndFraudGate: no bureaus → MANUAL_REVIEW", () => {
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: false, score: null },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    identity: {
      names: [{ first: "JOHN", last: "SMITH", source: "transunion" }],
      ssns: [],
      dobs: [],
      addresses: [],
      employers: []
    }
  });
  const result = runIdentityAndFraudGate(normalized, "John Smith");
  assert.equal(result.passed, false);
  assert.equal(result.outcome, "MANUAL_REVIEW");
  assert.ok(result.reasons.includes("NO_BUREAUS_AVAILABLE"));
});

test("runIdentityAndFraudGate: strong fraud signals → FRAUD_HOLD", () => {
  const normalized = makeNormalized({
    identity: {
      names: [{ first: "JOHN", last: "SMITH", source: "transunion" }],
      ssns: [],
      dobs: [],
      addresses: [],
      employers: []
    },
    fraudFinders: {
      risk: { score: 80, tumblingRisk: 1, postalMatch: null },
      emailValidation: null
    }
  });
  const result = runIdentityAndFraudGate(normalized, "John Smith");
  assert.equal(result.passed, false);
  assert.equal(result.outcome, "FRAUD_HOLD");
  assert.equal(result.confidence, "high");
});

test("runIdentityAndFraudGate: single fraud flag → pass with reduced confidence", () => {
  const normalized = makeNormalized({
    identity: {
      names: [{ first: "JOHN", last: "SMITH", source: "transunion" }],
      ssns: [],
      dobs: [],
      addresses: [],
      employers: []
    },
    fraudFinders: {
      risk: null,
      emailValidation: { status: "invalid" }
    }
  });
  const result = runIdentityAndFraudGate(normalized, "John Smith");
  assert.equal(result.passed, true);
  assert.equal(result.outcome, null);
  assert.ok(result.reasons.includes("EMAIL_INVALID"));
});

test("runIdentityAndFraudGate: stale reports → MANUAL_REVIEW", () => {
  const old = new Date();
  old.setDate(old.getDate() - 60);
  const normalized = makeNormalized({
    bureaus: {
      transunion: { available: true, score: 700, reportDate: old.toISOString().split("T")[0] },
      experian: { available: false, score: null },
      equifax: { available: false, score: null }
    },
    identity: {
      names: [{ first: "JOHN", last: "SMITH", source: "transunion" }],
      ssns: [],
      dobs: [],
      addresses: [],
      employers: []
    }
  });
  const result = runIdentityAndFraudGate(normalized, "John Smith");
  assert.equal(result.passed, false);
  assert.equal(result.outcome, "MANUAL_REVIEW");
  assert.ok(result.reasons.includes("ALL_REPORTS_STALE"));
});

// ============================================================================
// runIdentityAndFraudGate — live sandbox data
// ============================================================================

test("runIdentityAndFraudGate: TU — BARBARA DOTY matches", { skip: !tuRaw }, () => {
  const normalized = normalizeSoftPullPayload([tuRaw]);
  const result = runIdentityAndFraudGate(normalized, "Barbara Doty", undefined, FIXTURE_REFERENCE_DATE);
  assert.equal(result.passed, true);
  assert.equal(result.outcome, null);
});

test('runIdentityAndFraudGate: TU — initial match "B Doty"', { skip: !tuRaw }, () => {
  const normalized = normalizeSoftPullPayload([tuRaw]);
  const result = runIdentityAndFraudGate(normalized, "B Doty", undefined, FIXTURE_REFERENCE_DATE);
  assert.equal(result.passed, true);
});

test("runIdentityAndFraudGate: TU — wrong name", { skip: !tuRaw }, () => {
  const normalized = normalizeSoftPullPayload([tuRaw]);
  const result = runIdentityAndFraudGate(normalized, "John Smith", undefined, FIXTURE_REFERENCE_DATE);
  assert.equal(result.passed, false);
  assert.equal(result.outcome, "MANUAL_REVIEW");
});

test("runIdentityAndFraudGate: EXP — WILLIE BOOZE matches", { skip: !expRaw }, () => {
  const normalized = normalizeSoftPullPayload([expRaw]);
  const result = runIdentityAndFraudGate(normalized, "Willie Booze", undefined, FIXTURE_REFERENCE_DATE);
  assert.equal(result.passed, true);
});

test(
  "runIdentityAndFraudGate: all 3 bureaus — has fraud data",
  { skip: !tuRaw || !expRaw || !efxRaw },
  () => {
    const normalized = normalizeSoftPullPayload([tuRaw, expRaw, efxRaw]);
    // Use a name that exists in TU data
    const result = runIdentityAndFraudGate(normalized, "Barbara Doty", undefined, FIXTURE_REFERENCE_DATE);
    // Should pass or review, but fraud data should be processed
    assert.ok(typeof result.passed === "boolean");
    assert.ok(Array.isArray(result.reasons));
    assert.ok(["high", "medium", "low"].includes(result.confidence));
  }
);
