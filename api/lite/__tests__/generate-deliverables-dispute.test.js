"use strict";

/**
 * Tests for generate-deliverables.js — per-furnisher dispute letter loop.
 *
 * callClaude is destructured at require-time in generate-deliverables.js, so we
 * cannot patch it after the fact via mock.method. Instead we inject a fake
 * claude-client entry into the require cache (keyed on the EXACT .js path that
 * Node resolves internally) before requiring generate-deliverables, then clean
 * up after each test.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Exact paths (with .js extension) as Node's module resolver stores them.
const CLAUDE_CLIENT_PATH = path.resolve(__dirname, "../crs/claude-client.js");
const GD_PATH = path.resolve(__dirname, "../crs/generate-deliverables.js");

// buildEngineDataPayload is synchronous (no Claude calls) — safe to load once.
const { buildEngineDataPayload } = require(GD_PATH);

// ---------------------------------------------------------------------------
// Stub infrastructure
// ---------------------------------------------------------------------------

/**
 * A valid dispute letter — passes all 8 pre-send gates.
 * Includes violation field names that the test tradeline produces via detectViolations:
 *   - Field 24 (Date Reported / Account Status Date)  → STALE_REPORTING
 *   - Field 25 (Date of First Delinquency)             → REAGED_DOFD
 * Gate 4 requires at least one violation field to appear in the letter text.
 */
const VALID_DISPUTE_LETTER = [
  "I am writing to dispute inaccuracies on my credit report regarding my Capital One account ending in 1234.",
  "The Field 24 (Date Reported / Account Status Date) and Field 25 (Date of First Delinquency) are incorrectly reported.",
  "The balance and payment history shown is inaccurate because the account data does not match my records.",
  "I have enclosed supporting documentation as evidence of these violations.",
  "Please investigate this matter and correct all inaccurate information immediately."
].join(" ");

const VALID_PI_LETTER =
  "I am writing to ensure my personal information is accurate on my credit report. " +
  "I have enclosed identification documents for your reference.";

/**
 * Make a stub function that returns appropriate letter text.
 *
 * Detection strategy: dispute calls have a JSON user payload containing a
 * "furnisher" key. PI/inquiry removal calls have a user payload with a "client"
 * key but no "furnisher". We detect via the user JSON rather than the system
 * prompt because the system prompt is enriched with the Metro 2 knowledge base
 * which contains the words "personal" and "inquiry".
 */
function makeLetterStub(overrideFn) {
  return async opts => {
    if (overrideFn) return overrideFn(opts);
    try {
      const payload = JSON.parse(opts.user || "{}");
      if (payload.furnisher) return VALID_DISPUTE_LETTER;
      // No furnisher key → PI or inquiry removal call
      return VALID_PI_LETTER;
    } catch {
      return VALID_PI_LETTER;
    }
  };
}

/**
 * Execute testFn({ generateDisputeLetters }) with callClaude replaced by stub.
 * Re-requires generate-deliverables fresh so it destructures our stub.
 * Restores original require cache entries after the test.
 */
async function withStub(stub, testFn) {
  // Save originals
  const origCC = require.cache[CLAUDE_CLIENT_PATH];
  const origGD = require.cache[GD_PATH];

  // Inject fake claude-client
  require.cache[CLAUDE_CLIENT_PATH] = {
    id: CLAUDE_CLIENT_PATH,
    filename: CLAUDE_CLIENT_PATH,
    loaded: true,
    exports: { callClaude: stub }
  };

  // Bust generate-deliverables so it re-captures our stub
  delete require.cache[GD_PATH];
  const freshModule = require(GD_PATH);

  try {
    await testFn(freshModule);
  } finally {
    // Restore originals
    if (origCC) {
      require.cache[CLAUDE_CLIENT_PATH] = origCC;
    } else {
      delete require.cache[CLAUDE_CLIENT_PATH];
    }
    if (origGD) {
      require.cache[GD_PATH] = origGD;
    } else {
      delete require.cache[GD_PATH];
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDerogTradeline(overrides = {}) {
  return {
    creditorName: "Capital One",
    accountIdentifier: "ACCT-1234",
    source: "experian",
    accountType: "revolving",
    loanType: "CreditCard",
    ownership: "individual",
    isAU: false,
    status: "chargeoff",
    openedDate: "2020-01-01",
    closedDate: "2022-06-01",
    reportedDate: "2026-01-01",
    lastActivityDate: "2022-06-01",
    creditLimit: 5000,
    highBalance: 5000,
    currentBalance: 3200,
    effectiveLimit: 5000,
    pastDue: 3200,
    monthlyPayment: null,
    chargeOffAmount: 3200,
    termsMonths: null,
    monthsReviewed: 48,
    latePayments: { _30: 2, _60: 1, _90: 1 },
    currentRatingCode: "97",
    currentRatingType: "ChargeOff",
    ratingSeverity: 5,
    isDerogatory: true,
    paymentPattern: null,
    adverseRatings: {
      highest: { date: "2021-06-01", type: "ChargeOff" },
      mostRecent: { date: "2022-01-01", type: "ChargeOff" },
      prior: []
    },
    comments: [],
    ...overrides
  };
}

function makeCRSResult(overrides = {}) {
  return {
    outcome: "REPAIR_ONLY",
    bureaus: {
      experian: { clean: false },
      equifax: { clean: true },
      transunion: { clean: true }
    },
    normalized: {
      tradelines: [makeDerogTradeline()],
      inquiries: [],
      identity: {}
    },
    consumerSignals: {
      scores: { median: 590 },
      utilization: { overall: 64 },
      bureauNegatives: {},
      auImpact: null
    },
    businessSignals: { available: false },
    preapprovals: { totalPersonal: 0, totalBusiness: 0, totalCombined: 0 },
    projectedPreapproval: null,
    suggestions: { fullSuggestions: [] },
    ...overrides
  };
}

function makePersonal() {
  return {
    name: "Barbara Doty",
    address: "123 Main St, Denton TX 76201",
    firstName: "Barbara",
    lastName: "Doty"
  };
}

// ---------------------------------------------------------------------------
// buildEngineDataPayload — synchronous, no Claude call
// ---------------------------------------------------------------------------

test("buildEngineDataPayload: returns valid JSON string", () => {
  const crs = makeCRSResult();
  const personal = makePersonal();
  const lenderMatches = { totalMatched: 0, matches: [] };
  const payload = buildEngineDataPayload(crs, personal, lenderMatches);
  assert.equal(typeof payload, "string");
  const parsed = JSON.parse(payload); // throws on invalid JSON
  assert.equal(parsed.client.name, "Barbara Doty");
  assert.ok("outcome" in parsed);
  assert.ok("preapprovals" in parsed);
});

test("buildEngineDataPayload: includes lenderMatches in output", () => {
  const crs = makeCRSResult();
  const personal = makePersonal();
  const lenderMatches = { totalMatched: 2, matches: [{ name: "Chase" }, { name: "BoA" }] };
  const payload = JSON.parse(buildEngineDataPayload(crs, personal, lenderMatches));
  assert.equal(payload.lenderMatches.totalMatched, 2);
});

test("buildEngineDataPayload: includes cta field with bookingUrl", () => {
  const crs = makeCRSResult();
  const personal = makePersonal();
  const payload = JSON.parse(buildEngineDataPayload(crs, personal, {}));
  assert.ok("cta" in payload, "expected cta key in payload");
  assert.ok("bookingUrl" in payload.cta, "expected bookingUrl in cta");
});

// ---------------------------------------------------------------------------
// generateDisputeLetters — stubbed Claude
// ---------------------------------------------------------------------------

test("generateDisputeLetters: dirty experian bureau → generates dispute letter for that bureau", async () => {
  await withStub(makeLetterStub(), async ({ generateDisputeLetters }) => {
    const result = await generateDisputeLetters(makeCRSResult(), makePersonal());
    const disputeLetters = result.filter(l => l.type === "dispute");
    assert.ok(disputeLetters.length >= 1, "expected at least 1 dispute letter for dirty experian");
    assert.equal(disputeLetters[0].bureau, "experian");
    assert.equal(disputeLetters[0].round, 1);
    assert.ok(typeof disputeLetters[0].text === "string");
    assert.ok(Array.isArray(disputeLetters[0].violations));
  });
});

test("generateDisputeLetters: clean bureaus → no dispute letters", async () => {
  await withStub(makeLetterStub(), async ({ generateDisputeLetters }) => {
    const crs = makeCRSResult({
      bureaus: {
        experian: { clean: true },
        equifax: { clean: true },
        transunion: { clean: true }
      }
    });
    const result = await generateDisputeLetters(crs, makePersonal());
    const disputeLetters = result.filter(l => l.type === "dispute");
    assert.equal(disputeLetters.length, 0, "no dispute letters when all bureaus are clean");
  });
});

test("generateDisputeLetters: tradeline with null creditorName → no throw", async () => {
  await withStub(makeLetterStub(), async ({ generateDisputeLetters }) => {
    const tlNullCreditor = makeDerogTradeline({ creditorName: null });
    const crs = makeCRSResult({
      normalized: { tradelines: [tlNullCreditor], inquiries: [], identity: {} }
    });
    let threw = false;
    try {
      await generateDisputeLetters(crs, makePersonal());
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "should not throw for tradeline with null creditorName");
  });
});

test("generateDisputeLetters: always generates personal info letters for all 3 bureaus", async () => {
  await withStub(makeLetterStub(), async ({ generateDisputeLetters }) => {
    // All clean — no dispute letters, but PI letters still generated
    const crs = makeCRSResult({
      bureaus: {
        experian: { clean: true },
        equifax: { clean: true },
        transunion: { clean: true }
      },
      normalized: { tradelines: [], inquiries: [], identity: {} }
    });
    const result = await generateDisputeLetters(crs, makePersonal());
    const piLetters = result.filter(l => l.type === "personal_info");
    assert.equal(piLetters.length, 3, "expected 1 PI letter per bureau = 3 total");
  });
});

test("generateDisputeLetters: callClaude returning null → gracefully skips all letters", async () => {
  await withStub(
    async () => null,
    async ({ generateDisputeLetters }) => {
      const result = await generateDisputeLetters(makeCRSResult(), makePersonal());
      assert.ok(Array.isArray(result));
      assert.equal(result.length, 0, "all letters skipped when Claude returns null");
    }
  );
});

test("generateDisputeLetters: multiple derogatory tradelines from same furnisher → single letter", async () => {
  await withStub(makeLetterStub(), async ({ generateDisputeLetters }) => {
    const tl1 = makeDerogTradeline({ accountIdentifier: "ACCT-0001" });
    const tl2 = makeDerogTradeline({ accountIdentifier: "ACCT-0002" }); // same creditorName: Capital One
    const crs = makeCRSResult({
      normalized: { tradelines: [tl1, tl2], inquiries: [], identity: {} }
    });
    const result = await generateDisputeLetters(crs, makePersonal());
    const disputeLetters = result.filter(l => l.type === "dispute" && l.bureau === "experian");
    assert.equal(disputeLetters.length, 1, "two tradelines from same furnisher → 1 letter");
  });
});

test("generateDisputeLetters: tradelines from different furnishers → one letter each", async () => {
  // Build furnisher-specific stubs that include the correct creditor name in the letter text.
  const tl1 = makeDerogTradeline({ creditorName: "Capital One", accountIdentifier: "ACCT-A" });
  const tl2 = makeDerogTradeline({ creditorName: "Midland Funding", accountIdentifier: "ACCT-B" });

  function buildLetterFor(furnisher) {
    return [
      `I am writing to dispute inaccuracies on my credit report regarding my ${furnisher} account ending in ACCT.`,
      "The Field 24 (Date Reported / Account Status Date) and Field 25 (Date of First Delinquency) are incorrectly reported.",
      "The balance and payment history shown is inaccurate because the account data does not match my records.",
      "I have enclosed supporting documentation as evidence of these violations.",
      "Please investigate this matter and correct all inaccurate information immediately."
    ].join(" ");
  }

  const stub = makeLetterStub(opts => {
    try {
      const payload = JSON.parse(opts.user || "{}");
      if (!payload.furnisher) return VALID_PI_LETTER;
      return buildLetterFor(payload.furnisher);
    } catch {
      return VALID_PI_LETTER;
    }
  });

  await withStub(stub, async ({ generateDisputeLetters }) => {
    const crs = makeCRSResult({
      normalized: { tradelines: [tl1, tl2], inquiries: [], identity: {} }
    });
    const result = await generateDisputeLetters(crs, makePersonal());
    const disputeLetters = result.filter(l => l.type === "dispute" && l.bureau === "experian");
    assert.equal(disputeLetters.length, 2, "two different furnishers → 2 letters");
  });
});

test("generateDisputeLetters: higher severity furnisher is processed before lower severity", async () => {
  const callOrder = [];

  // Build a letter that references the fields Midland Funding's tradeline will produce.
  // Midland uses loanType: CollectionAccount → violations include SEVEN_YEAR_EXPIRED,
  // COLLECTION_MISSING_ORIGINAL, CHARGEOFF_NO_AMOUNT (score 12).
  // Acme Bank uses AsAgreed + isDerogatory → score 7.
  const MIDLAND_LETTER = [
    "I am writing to dispute violations in my Midland Funding account ending in ACCT.",
    "The Field 25 (Date of First Delinquency) shows an expired seven-year reporting window.",
    "The balance and payment history for this collection account is inaccurate because the data violates the FCRA.",
    "I have enclosed supporting documentation as evidence of these violations.",
    "Please investigate this matter and correct all inaccurate information immediately."
  ].join(" ");

  const ACME_LETTER = VALID_DISPUTE_LETTER.replace("Capital One", "Acme Bank");

  const stub = makeLetterStub(opts => {
    try {
      const payload = JSON.parse(opts.user || "{}");
      if (!payload.furnisher) return VALID_PI_LETTER; // PI or inquiry call
      callOrder.push(payload.furnisher);
      if (payload.furnisher === "Midland Funding") return MIDLAND_LETTER;
      return ACME_LETTER;
    } catch {
      return VALID_PI_LETTER;
    }
  });

  await withStub(stub, async ({ generateDisputeLetters }) => {
    // Midland Funding: collection/chargeoff with 7-year expired DOFD — score 12
    const highTL = makeDerogTradeline({
      creditorName: "Midland Funding",
      accountIdentifier: "ACCT-H",
      loanType: "CollectionAccount",
      status: "collection",
      currentRatingType: "ChargeOff",
      chargeOffAmount: null,
      pastDue: 3200,
      adverseRatings: {
        highest: { date: "2014-01-01", type: "ChargeOff" },
        mostRecent: { date: "2014-01-01", type: "ChargeOff" },
        prior: []
      },
      comments: []
    });

    // Acme Bank: AsAgreed + isDerogatory — score 7
    const lowTL = makeDerogTradeline({
      creditorName: "Acme Bank",
      accountIdentifier: "ACCT-L",
      currentRatingType: "AsAgreed",
      isDerogatory: true,
      status: "open",
      chargeOffAmount: null,
      pastDue: null,
      adverseRatings: null,
      reportedDate: "2024-06-01"
    });

    callOrder.length = 0;
    // Put lowTL first — prioritizeFurnishers should reorder by severity
    const crs = makeCRSResult({
      normalized: { tradelines: [lowTL, highTL], inquiries: [], identity: {} }
    });
    await generateDisputeLetters(crs, makePersonal());

    const disputeCalls = callOrder.filter(n => n === "Midland Funding" || n === "Acme Bank");
    if (disputeCalls.length >= 2) {
      assert.equal(
        disputeCalls[0],
        "Midland Funding",
        `higher severity furnisher should be processed first; order was: ${disputeCalls.join(", ")}`
      );
    }
  });
});

test("generateDisputeLetters: returned dispute letter objects have required shape", async () => {
  await withStub(makeLetterStub(), async ({ generateDisputeLetters }) => {
    const result = await generateDisputeLetters(makeCRSResult(), makePersonal());
    const disputeLetters = result.filter(l => l.type === "dispute");
    assert.ok(disputeLetters.length > 0, "expected at least 1 dispute letter");
    const letter = disputeLetters[0];
    assert.ok("type" in letter, "missing: type");
    assert.ok("bureau" in letter, "missing: bureau");
    assert.ok("round" in letter, "missing: round");
    assert.ok("furnisher" in letter, "missing: furnisher");
    assert.ok("violations" in letter, "missing: violations");
    assert.ok("text" in letter, "missing: text");
  });
});

test("generateDisputeLetters: tradeline with no violations → no dispute letter generated", async () => {
  await withStub(makeLetterStub(), async ({ generateDisputeLetters }) => {
    const cleanTL = makeDerogTradeline({
      status: "open",
      currentRatingType: "AsAgreed",
      isDerogatory: false,
      chargeOffAmount: null,
      pastDue: null,
      adverseRatings: null,
      currentBalance: 1000,
      creditLimit: 5000,
      reportedDate: "2026-03-01"
    });
    const crs = makeCRSResult({
      normalized: { tradelines: [cleanTL], inquiries: [], identity: {} }
    });
    const result = await generateDisputeLetters(crs, makePersonal());
    const disputeLetters = result.filter(l => l.type === "dispute");
    assert.equal(disputeLetters.length, 0, "no violations → no letters");
  });
});

// Note: generateDeliverables (the full orchestrator) requires a live ANTHROPIC_API_KEY
// and is not tested here. These tests cover buildEngineDataPayload (synchronous) and
// generateDisputeLetters (async, per-furnisher loop) via require-cache stub injection.
