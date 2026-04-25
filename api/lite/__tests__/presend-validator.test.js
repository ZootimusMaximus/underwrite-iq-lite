"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validatePreSend,
  checkGate1,
  checkGate2,
  checkGate3,
  checkGate4,
  checkGate5,
  checkGate6,
  checkGate7,
  checkGate8,
  GATE_NAMES,
} = require("../crs/presend-validator");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides = {}) {
  return {
    violations: [],
    round: 1,
    furnisher: "Capital One",
    bureau: "experian",
    accountIdentifier: "1234",
    furnisherAddress: null,
    priorRoundText: null,
    ...overrides,
  };
}

function makeViolation(overrides = {}) {
  return {
    code: "BALANCE_ON_CLOSED",
    field: "currentBalance",
    expected: "0",
    actual: "500",
    severity: "high",
    statute: "FCRA § 623",
    explanation: "Closed account should not carry a balance.",
    ...overrides,
  };
}

// A letter that passes all 8 gates. Used as a valid baseline.
const GOOD_LETTER = `
I am writing to dispute an inaccuracy on my credit report regarding my Capital One account ending in 1234.
The currentBalance reported is incorrect because the account was closed and paid in full.
I have enclosed supporting documentation as evidence of this error.
Please investigate this matter and correct it accordingly.
`;

// ---------------------------------------------------------------------------
// Gate 1: Dispute Subject Matter Covered
// ---------------------------------------------------------------------------

test("checkGate1: letter with balance keyword → pass", () => {
  const result = checkGate1("The balance reported is incorrect.", makeContext());
  assert.equal(result.pass, true);
});

test("checkGate1: letter with payment history keyword → pass", () => {
  const result = checkGate1("My payment history is being misreported.", makeContext());
  assert.equal(result.pass, true);
});

test("checkGate1: letter with account status keyword → pass", () => {
  const result = checkGate1("The account status shows charged off incorrectly.", makeContext());
  assert.equal(result.pass, true);
});

test("checkGate1: letter with terms keyword → pass", () => {
  const result = checkGate1("The interest rate shown does not match my terms.", makeContext());
  assert.equal(result.pass, true);
});

test("checkGate1: letter without any category keywords → fail", () => {
  const result = checkGate1("Please look into this matter for me.", makeContext());
  assert.equal(result.pass, false);
  assert.ok(result.reason.length > 0);
});

// ---------------------------------------------------------------------------
// Gate 2: Not an Excepted Dispute Type
// ---------------------------------------------------------------------------

test("checkGate2: violations with account data codes → pass", () => {
  const ctx = makeContext({
    violations: [makeViolation({ code: "BALANCE_ON_CLOSED" })],
  });
  const result = checkGate2("", ctx);
  assert.equal(result.pass, true);
});

test("checkGate2: only SSN violation → fail", () => {
  const ctx = makeContext({
    violations: [makeViolation({ code: "SSN_MISMATCH" })],
  });
  const result = checkGate2("", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("excepted"));
});

test("checkGate2: only INQUIRY violation → fail", () => {
  const ctx = makeContext({
    violations: [makeViolation({ code: "INQUIRY_TOO_OLD" })],
  });
  const result = checkGate2("", ctx);
  assert.equal(result.pass, false);
});

test("checkGate2: only DECEASED violation → fail", () => {
  const ctx = makeContext({
    violations: [makeViolation({ code: "DECEASED_FLAG_ALIVE" })],
  });
  const result = checkGate2("", ctx);
  assert.equal(result.pass, false);
});

test("checkGate2: empty violations → pass (inconclusive)", () => {
  const ctx = makeContext({ violations: [] });
  const result = checkGate2("", ctx);
  assert.equal(result.pass, true);
});

test("checkGate2: mixed account data + SSN violations → pass (not all excepted)", () => {
  const ctx = makeContext({
    violations: [
      makeViolation({ code: "BALANCE_ON_CLOSED" }),
      makeViolation({ code: "SSN_MISMATCH" }),
    ],
  });
  const result = checkGate2("", ctx);
  assert.equal(result.pass, true);
});

// ---------------------------------------------------------------------------
// Gate 3: Furnisher Address Present
// ---------------------------------------------------------------------------

test("checkGate3: round 1 → always pass", () => {
  const ctx = makeContext({ round: 1, furnisherAddress: null });
  const result = checkGate3("No address here.", ctx);
  assert.equal(result.pass, true);
});

test("checkGate3: round 2 without address → fail", () => {
  const ctx = makeContext({ round: 2, furnisherAddress: null });
  const result = checkGate3("Please investigate this dispute.", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("Round 2"));
});

test("checkGate3: round 2 with furnisherAddress in context → pass", () => {
  const ctx = makeContext({ round: 2, furnisherAddress: "123 Main St, Suite 100, New York NY 10001" });
  const result = checkGate3("Please investigate.", ctx);
  assert.equal(result.pass, true);
});

test("checkGate3: round 2 with address block in letter text → pass", () => {
  const ctx = makeContext({ round: 2, furnisherAddress: null });
  const letterWithAddress = "Capital One, 123 Main Street, Richmond VA 23236. I dispute the account.";
  const result = checkGate3(letterWithAddress, ctx);
  assert.equal(result.pass, true);
});

test("checkGate3: round 3 without address → fail", () => {
  const ctx = makeContext({ round: 3, furnisherAddress: null });
  const result = checkGate3("This letter demands immediate correction.", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("Round 3"));
});

// ---------------------------------------------------------------------------
// Gate 4: Required Notice Elements
// ---------------------------------------------------------------------------

test("checkGate4: letter with all 4 required elements → pass", () => {
  const ctx = makeContext({
    violations: [makeViolation({ field: "currentBalance" })],
    accountIdentifier: "1234",
  });
  const result = checkGate4(GOOD_LETTER, ctx);
  assert.equal(result.pass, true);
});

test("checkGate4: letter missing account identification → fail", () => {
  const ctx = makeContext({
    violations: [makeViolation({ field: "currentBalance" })],
    accountIdentifier: null,
  });
  const letter = "The currentBalance is incorrect because the data is inaccurate. I have enclosed documentation.";
  const result = checkGate4(letter, ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("account identification"));
});

test("checkGate4: letter missing basis for dispute → fail", () => {
  const ctx = makeContext({
    violations: [makeViolation({ field: "currentBalance" })],
    accountIdentifier: "1234",
  });
  // Remove 'because', 'reason', 'inaccurate', 'incorrect', 'violation'
  const letter = "My account ending in 1234 has a problem with currentBalance. I have enclosed documentation.";
  const result = checkGate4(letter, ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("basis"));
});

// ---------------------------------------------------------------------------
// Gate 5: CRO Safe Harbor (Consumer Voice)
// ---------------------------------------------------------------------------

test("checkGate5: consumer voice letter with 'I am writing' → pass", () => {
  const ctx = makeContext();
  const result = checkGate5("I am writing to dispute this balance on my account.", ctx);
  assert.equal(result.pass, true);
});

test("checkGate5: 'on behalf of our client' → fail (CRO fingerprint)", () => {
  const ctx = makeContext();
  const result = checkGate5("We are writing on behalf of our client to dispute this account.", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.toLowerCase().includes("cro"));
});

test("checkGate5: 'Pursuant to' opener → fail", () => {
  const ctx = makeContext();
  // Use a letter that starts with the legalistic opener but has no CRO fingerprints,
  // so the opener check fires (not the fingerprint check).
  const result = checkGate5(
    "Pursuant to the Fair Credit Reporting Act, this account should be corrected immediately.",
    ctx
  );
  assert.equal(result.pass, false);
  assert.ok(result.reason.toLowerCase().includes("pursuant to"), `reason: ${result.reason}`);
});

test("checkGate5: 'credit repair' phrase → fail", () => {
  const ctx = makeContext();
  const result = checkGate5("I am writing about my credit repair situation regarding my account.", ctx);
  assert.equal(result.pass, false);
});

test("checkGate5: 'I dispute' with no CRO markers → pass", () => {
  const ctx = makeContext();
  const result = checkGate5("I dispute the inaccurate balance on my credit report.", ctx);
  assert.equal(result.pass, true);
});

test("checkGate5: no consumer voice pattern at all → fail", () => {
  const ctx = makeContext();
  const result = checkGate5("This account has incorrect data. Please fix it now.", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("first-person consumer voice"));
});

// ---------------------------------------------------------------------------
// Gate 6: Not Frivolous or Duplicative
// ---------------------------------------------------------------------------

test("checkGate6: specific furnisher + field reference → pass", () => {
  const ctx = makeContext({
    furnisher: "Capital One",
    violations: [makeViolation({ field: "currentBalance" })],
  });
  const letter = "I am disputing the currentBalance on my Capital One account because it is incorrect.";
  const result = checkGate6(letter, ctx);
  assert.equal(result.pass, true);
});

test("checkGate6: 'I dispute everything' → fail (frivolous)", () => {
  const ctx = makeContext({
    furnisher: "Capital One",
    violations: [makeViolation({ field: "currentBalance" })],
  });
  const result = checkGate6("I dispute everything on my report regarding Capital One currentBalance.", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("frivolous"));
});

test("checkGate6: missing furnisher name in letter → fail", () => {
  const ctx = makeContext({
    furnisher: "Capital One",
    violations: [makeViolation({ field: "currentBalance" })],
  });
  const letter = "I dispute the currentBalance listed on my credit report. It is incorrect.";
  const result = checkGate6(letter, ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("furnisher name"));
});

test("checkGate6: no violation field referenced → fail", () => {
  const ctx = makeContext({
    furnisher: "Capital One",
    violations: [makeViolation({ field: "currentBalance" })],
  });
  const letter = "I dispute the Capital One account because something is wrong.";
  const result = checkGate6(letter, ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("violation field"));
});

// ---------------------------------------------------------------------------
// Gate 7: Round 2/3 Contains New Information
// ---------------------------------------------------------------------------

test("checkGate7: round 1 → always pass", () => {
  const ctx = makeContext({ round: 1 });
  const result = checkGate7("No new information language needed.", ctx);
  assert.equal(result.pass, true);
});

test("checkGate7: round 2 with MOV language → pass", () => {
  const ctx = makeContext({ round: 2 });
  const result = checkGate7("I am requesting your method of verification for this account.", ctx);
  assert.equal(result.pass, true);
});

test("checkGate7: round 2 without new info keyword → fail", () => {
  const ctx = makeContext({ round: 2 });
  const result = checkGate7("I am writing again to dispute this account balance.", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("Round 2"));
});

test("checkGate7: round 3 with damages language → pass", () => {
  const ctx = makeContext({ round: 3 });
  const result = checkGate7("I am seeking damages for willful noncompliance with the FCRA.", ctx);
  assert.equal(result.pass, true);
});

test("checkGate7: round 3 with CFPB reference → pass", () => {
  const ctx = makeContext({ round: 3 });
  const result = checkGate7("I will file a complaint with the CFPB if this is not resolved.", ctx);
  assert.equal(result.pass, true);
});

test("checkGate7: round 3 without round 3 keywords → fail", () => {
  const ctx = makeContext({ round: 3 });
  const result = checkGate7("I am writing again about this account inaccuracy.", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("Round 3"));
});

test("checkGate7: round 2 with MOV keyword but >80% similar to prior → fail", () => {
  const priorText = "I am requesting your method of verification for this account balance on my Capital One credit report.";
  const ctx = makeContext({
    round: 2,
    priorRoundText: priorText,
  });
  // Nearly identical letter
  const sameText = "I am requesting your method of verification for this account balance on my Capital One credit report again.";
  const result = checkGate7(sameText, ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("similar"));
});

// ---------------------------------------------------------------------------
// Gate 8: No Prohibited CROA Language
// ---------------------------------------------------------------------------

test("checkGate8: no prohibited phrases → pass", () => {
  const ctx = makeContext();
  const result = checkGate8("I am writing to dispute this account balance on my credit report.", ctx);
  assert.equal(result.pass, true);
});

test("checkGate8: 'guarantee removal' → fail", () => {
  const ctx = makeContext();
  const result = checkGate8("This service guarantees removal of all negative items.", ctx);
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("Credit Repair Organizations Act"));
});

test("checkGate8: 'improve your credit score' → fail", () => {
  const ctx = makeContext();
  const result = checkGate8("We will improve your credit score by 100 points.", ctx);
  assert.equal(result.pass, false);
});

test("checkGate8: 'raise your credit score' → fail", () => {
  const ctx = makeContext();
  const result = checkGate8("Disputing this item will raise your credit score.", ctx);
  assert.equal(result.pass, false);
});

test("checkGate8: 'guaranteed results' → fail", () => {
  const ctx = makeContext();
  const result = checkGate8("We offer guaranteed results for all clients.", ctx);
  assert.equal(result.pass, false);
});

test("checkGate8: 'we will remove' → fail", () => {
  const ctx = makeContext();
  const result = checkGate8("We will remove this item from your report.", ctx);
  assert.equal(result.pass, false);
});

// ---------------------------------------------------------------------------
// validatePreSend — integration
// ---------------------------------------------------------------------------

test("validatePreSend: good letter passes all 8 gates → valid: true, failures: []", () => {
  const ctx = makeContext({
    round: 1,
    furnisher: "Capital One",
    violations: [makeViolation({ field: "currentBalance" })],
    accountIdentifier: "1234",
  });
  const result = validatePreSend(GOOD_LETTER, ctx);
  assert.equal(result.valid, true);
  assert.deepEqual(result.failures, []);
});

test("validatePreSend: null letterText → all 8 gates fail", () => {
  const ctx = makeContext();
  const result = validatePreSend(null, ctx);
  assert.equal(result.valid, false);
  assert.equal(result.failures.length, 8);
});

test("validatePreSend: empty string letterText → all 8 gates fail", () => {
  const ctx = makeContext();
  const result = validatePreSend("", ctx);
  assert.equal(result.valid, false);
  assert.equal(result.failures.length, 8);
});

test("validatePreSend: whitespace-only letterText → all 8 gates fail", () => {
  const ctx = makeContext();
  const result = validatePreSend("   \n\t  ", ctx);
  assert.equal(result.valid, false);
  assert.equal(result.failures.length, 8);
});

test("validatePreSend: bad letter fails multiple gates → returns ALL failures listed", () => {
  const ctx = makeContext({
    round: 1,
    furnisher: "Capital One",
    violations: [],
  });
  // Letter with no category keywords, no consumer voice, CROA language
  const badLetter = "Pursuant to our services, we guarantee removal of this item to improve your credit score.";
  const result = validatePreSend(badLetter, ctx);
  assert.equal(result.valid, false);
  assert.ok(result.failures.length >= 3, `expected ≥3 failures, got ${result.failures.length}`);
  // Verify each failure has the required shape
  for (const f of result.failures) {
    assert.ok(typeof f.gate === "number", "failure.gate must be number");
    assert.ok(typeof f.name === "string" && f.name.length > 0, "failure.name must be non-empty string");
    assert.ok(typeof f.reason === "string" && f.reason.length > 0, "failure.reason must be non-empty string");
  }
});

test("validatePreSend: all gates run even if early ones fail", () => {
  // Use a letter that triggers gate 5 (CRO fingerprint: 'on behalf of our client')
  // AND gate 8 (CROA: 'guarantee removal'). Both must appear in failures, proving
  // the runner didn't short-circuit after the first failure.
  const ctx = makeContext({
    round: 1,
    furnisher: "Capital One",
    violations: [makeViolation({ field: "currentBalance" })],
    accountIdentifier: "1234",
  });
  const multiFailLetter =
    "We are writing on behalf of our client about Capital One account ending in 1234. " +
    "The currentBalance is wrong because it is inaccurate. " +
    "I have enclosed documentation. " +
    "We guarantee removal of this item.";

  const result = validatePreSend(multiFailLetter, ctx);
  const gateCodes = result.failures.map((f) => f.gate);
  assert.ok(gateCodes.includes(5), `gate 5 should fail (CRO fingerprint); failures: ${gateCodes}`);
  assert.ok(gateCodes.includes(8), `gate 8 should fail (guarantee removal); failures: ${gateCodes}`);
  assert.ok(result.failures.length >= 2, `expected ≥2 failures, got ${result.failures.length}`);
});

test("validatePreSend: failure objects have gate, name, reason fields", () => {
  const ctx = makeContext({ violations: [] });
  const result = validatePreSend("Something wrong here.", ctx);
  assert.ok(result.failures.length > 0);
  const f = result.failures[0];
  assert.ok("gate" in f, "missing: gate");
  assert.ok("name" in f, "missing: name");
  assert.ok("reason" in f, "missing: reason");
});

// ---------------------------------------------------------------------------
// GATE_NAMES
// ---------------------------------------------------------------------------

test("GATE_NAMES is exported and has 8 entries", () => {
  assert.equal(typeof GATE_NAMES, "object");
  assert.equal(Object.keys(GATE_NAMES).length, 8);
});

test("GATE_NAMES keys are numbers 1 through 8", () => {
  for (let i = 1; i <= 8; i++) {
    assert.ok(i in GATE_NAMES, `GATE_NAMES missing key ${i}`);
    assert.equal(typeof GATE_NAMES[i], "string");
    assert.ok(GATE_NAMES[i].length > 0, `GATE_NAMES[${i}] should be non-empty`);
  }
});

test("GATE_NAMES values match expected gate names", () => {
  assert.equal(GATE_NAMES[1], "Dispute Subject Matter Covered");
  assert.equal(GATE_NAMES[2], "Not an Excepted Dispute Type");
  assert.equal(GATE_NAMES[3], "Furnisher Address Present");
  assert.equal(GATE_NAMES[4], "Required Notice Elements");
  assert.equal(GATE_NAMES[5], "CRO Safe Harbor (Consumer Voice)");
  assert.equal(GATE_NAMES[6], "Not Frivolous or Duplicative");
  assert.equal(GATE_NAMES[7], "Round 2/3 Contains New Information");
  assert.equal(GATE_NAMES[8], "No Prohibited CROA Language");
});
