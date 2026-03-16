const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCrmPayload, REDIRECT_PATHS } = require("../crs/build-crm-payload");

function makeOptions(overrides = {}) {
  return {
    normalized: {
      meta: { bureauCount: 3, availableBureaus: ["transunion", "experian", "equifax"] }
    },
    consumerSignals: {
      scores: { median: 720, bureauConfidence: "high", perBureau: { tu: 725, ex: 710, eq: 720 } },
      utilization: { pct: 15, band: "good" }
    },
    businessSignals: { available: true },
    outcomeResult: { outcome: "FULL_STACK_APPROVAL", reasonCodes: [], businessBoostApplied: false },
    preapprovals: {
      personalCard: { final: 80000 },
      personalLoan: { final: 60000 },
      business: { final: 150000 },
      totalCombined: 290000
    },
    cards: ["full_stack", "business_boost_available"],
    documents: { letters: [{ type: "inquiry_removal" }] },
    formData: {
      email: "test@test.com",
      phone: "5551234567",
      name: "John Smith",
      companyName: "Test LLC"
    },
    ...overrides
  };
}

// ============================================================================
// Tests
// ============================================================================

test("buildCrmPayload: full stack structure", () => {
  const payload = buildCrmPayload(makeOptions());

  assert.equal(payload.contact.email, "test@test.com");
  assert.equal(payload.outcome, "FULL_STACK_APPROVAL");
  assert.equal(payload.scores.median, 720);
  assert.equal(payload.preapprovals.total, 290000);
  assert.deepEqual(payload.tags, ["full_stack", "business_boost_available"]);
  assert.equal(payload.letterStatus, "pending");
  assert.equal(payload.redirect.path, "funding");
  assert.equal(payload.customFields.analyzer_path, "funding");
  assert.equal(payload.customFields.analyzer_status, "complete");
  assert.equal(payload.customFields.outcome_tier, "FULL_STACK_APPROVAL");
});

test("buildCrmPayload: repair path", () => {
  const opts = makeOptions({
    outcomeResult: {
      outcome: "REPAIR",
      reasonCodes: ["ACTIVE_CHARGEOFF"],
      businessBoostApplied: false
    }
  });
  const payload = buildCrmPayload(opts);

  assert.equal(payload.redirect.path, "repair");
  assert.equal(payload.customFields.analyzer_path, "repair");
});

test("buildCrmPayload: fraud hold → no redirect", () => {
  const opts = makeOptions({
    outcomeResult: {
      outcome: "FRAUD_HOLD",
      reasonCodes: ["IDENTITY_FLAG"],
      businessBoostApplied: false
    },
    documents: { letters: [] }
  });
  const payload = buildCrmPayload(opts);

  assert.equal(payload.redirect.path, null);
  assert.equal(payload.redirect.url, null);
  assert.equal(payload.letterStatus, "none");
  assert.equal(payload.customFields.analyzer_path, "hold");
});

test("buildCrmPayload: no form data handled", () => {
  const opts = makeOptions({ formData: null });
  const payload = buildCrmPayload(opts);

  assert.equal(payload.contact.email, null);
  assert.equal(payload.contact.name, null);
});

test("buildCrmPayload: scores populated", () => {
  const payload = buildCrmPayload(makeOptions());

  assert.equal(payload.scores.tu, 725);
  assert.equal(payload.scores.ex, 710);
  assert.equal(payload.scores.eq, 720);
  assert.equal(payload.scores.median, 720);
});

test("buildCrmPayload: custom fields include business flag", () => {
  const payload = buildCrmPayload(makeOptions());
  assert.equal(payload.customFields.business_available, true);
  assert.equal(payload.customFields.bureau_count, 3);
});

test("REDIRECT_PATHS: correct mapping", () => {
  assert.equal(REDIRECT_PATHS.REPAIR, "repair");
  assert.equal(REDIRECT_PATHS.FULL_STACK_APPROVAL, "funding");
  assert.equal(REDIRECT_PATHS.FRAUD_HOLD, null);
  assert.equal(REDIRECT_PATHS.MANUAL_REVIEW, null);
});

// ============================================================================
// Second audit fix pass — resultType, suggestionSummary, refId
// ============================================================================

test("buildCrmPayload: resultType, suggestionSummary, refId fields present", () => {
  const opts = makeOptions({
    formData: {
      email: "test@test.com",
      phone: "5551234567",
      name: "John Smith",
      companyName: "Test LLC",
      ref: "ref-abc-123"
    },
    suggestions: {
      topMoves: [
        { title: "Pay down balances" },
        { title: "Remove inquiries" },
        { title: "Dispute collections" }
      ],
      flatList: [],
      layers: []
    }
  });
  const payload = buildCrmPayload(opts);

  assert.ok("resultType" in payload, "resultType should be present");
  assert.equal(typeof payload.resultType, "string");
  assert.equal(payload.resultType, "funding"); // FULL_STACK_APPROVAL → funding path

  assert.ok("suggestionSummary" in payload, "suggestionSummary should be present");
  assert.equal(typeof payload.suggestionSummary, "string");
  assert.ok(
    payload.suggestionSummary.includes("Pay down balances"),
    "suggestionSummary should include top move titles"
  );

  assert.ok("refId" in payload, "refId should be present");
  assert.equal(payload.refId, "ref-abc-123");
});

test('buildCrmPayload: resultType is "repair" for REPAIR outcome', () => {
  const opts = makeOptions({
    outcomeResult: { outcome: "REPAIR", reasonCodes: [], businessBoostApplied: false }
  });
  const payload = buildCrmPayload(opts);
  assert.equal(payload.resultType, "repair");
});

test('buildCrmPayload: resultType is "hold" for FRAUD_HOLD outcome', () => {
  const opts = makeOptions({
    outcomeResult: { outcome: "FRAUD_HOLD", reasonCodes: [], businessBoostApplied: false },
    documents: { letters: [] }
  });
  const payload = buildCrmPayload(opts);
  assert.equal(payload.resultType, "hold");
});

test("buildCrmPayload: refId is null when ref not provided in formData", () => {
  const payload = buildCrmPayload(makeOptions());
  assert.equal(payload.refId, null);
});

test("buildCrmPayload: suggestionSummary is null when no suggestions", () => {
  const opts = makeOptions({ suggestions: null });
  const payload = buildCrmPayload(opts);
  assert.equal(payload.suggestionSummary, null);
});
