const test = require("node:test");
const assert = require("node:assert/strict");
const { computeUnderwrite, getNumberField, normalizeBureau } = require("../underwriter");

// ============================================================================
// normalizeBureau tests
// ============================================================================
test("normalizeBureau returns unavailable for null input", () => {
  const result = normalizeBureau(null);
  assert.equal(result.available, false);
  assert.equal(result.score, null);
  assert.deepEqual(result.tradelines, []);
});

test("normalizeBureau returns unavailable for undefined input", () => {
  const result = normalizeBureau(undefined);
  assert.equal(result.available, false);
});

test("normalizeBureau returns unavailable for non-object input", () => {
  const result = normalizeBureau("string");
  assert.equal(result.available, false);
});

test("normalizeBureau extracts bureau data correctly", () => {
  const input = {
    score: 750,
    utilization_pct: 25,
    inquiries: 3,
    negatives: 0,
    late_payment_events: 1,
    names: ["John Doe"],
    addresses: ["123 Main St"],
    employers: ["Acme Corp"],
    tradelines: [{ creditor: "Chase" }]
  };
  const result = normalizeBureau(input);
  assert.equal(result.available, true);
  assert.equal(result.score, 750);
  assert.equal(result.utilization_pct, 25);
  assert.equal(result.inquiries, 3);
  assert.equal(result.negatives, 0);
  assert.deepEqual(result.names, ["John Doe"]);
  assert.deepEqual(result.tradelines, [{ creditor: "Chase" }]);
});

test("normalizeBureau handles missing arrays", () => {
  const input = { score: 700 };
  const result = normalizeBureau(input);
  assert.deepEqual(result.names, []);
  assert.deepEqual(result.addresses, []);
  assert.deepEqual(result.employers, []);
  assert.deepEqual(result.tradelines, []);
});

// ============================================================================
// getNumberField tests
// ============================================================================
test("getNumberField extracts number from fields object", () => {
  const fields = { age: "25" };
  assert.equal(getNumberField(fields, "age"), 25);
});

test("getNumberField handles array values", () => {
  const fields = { age: ["30", "ignored"] };
  assert.equal(getNumberField(fields, "age"), 30);
});

test("getNumberField returns null for missing key", () => {
  const fields = { other: "value" };
  assert.equal(getNumberField(fields, "age"), null);
});

test("getNumberField returns null for non-numeric value", () => {
  const fields = { age: "not-a-number" };
  assert.equal(getNumberField(fields, "age"), null);
});

test("getNumberField returns null for null fields", () => {
  assert.equal(getNumberField(null, "age"), null);
});

// ============================================================================
// computeUnderwrite - Score sanitization tests
// ============================================================================
test("computeUnderwrite sanitizes score > 9000 by dividing by 10", () => {
  const bureaus = { experian: { score: 8516 } };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.metrics.score, 850);
});

test("computeUnderwrite caps score at 850", () => {
  const bureaus = { experian: { score: 900 } };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.metrics.score, 850);
});

test("computeUnderwrite returns 0 for score < 300", () => {
  const bureaus = { experian: { score: 250 } };
  const result = computeUnderwrite(bureaus, null);
  // Score below 300 is sanitized to null, but metrics.score shows 0 (from ?? 0)
  assert.equal(result.metrics.score, 0);
});

test("computeUnderwrite handles valid score", () => {
  const bureaus = { experian: { score: 720 } };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.metrics.score, 720);
});

// ============================================================================
// computeUnderwrite - Fundability tests
// ============================================================================
test("computeUnderwrite marks fundable when score >= 700, util <= 30, neg = 0", () => {
  const bureaus = {
    experian: {
      score: 720,
      utilization_pct: 25,
      negatives: 0
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.fundable, true);
});

test("computeUnderwrite marks not fundable when score < 700", () => {
  const bureaus = {
    experian: {
      score: 680,
      utilization_pct: 25,
      negatives: 0
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.fundable, false);
});

test("computeUnderwrite marks not fundable when util > 30", () => {
  const bureaus = {
    experian: {
      score: 750,
      utilization_pct: 45,
      negatives: 0
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.fundable, false);
});

test("computeUnderwrite marks not fundable when negatives > 0", () => {
  const bureaus = {
    experian: {
      score: 750,
      utilization_pct: 20,
      negatives: 2
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.fundable, false);
});

test("computeUnderwrite is fundable when util is null", () => {
  const bureaus = {
    experian: {
      score: 720,
      utilization_pct: null,
      negatives: 0
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.fundable, true);
});

// ============================================================================
// computeUnderwrite - Tradeline analysis tests
// ============================================================================
test("computeUnderwrite detects card stacking eligibility", () => {
  const bureaus = {
    experian: {
      score: 750,
      negatives: 0,
      tradelines: [
        {
          type: "revolving",
          status: "open",
          limit: 10000,
          opened: "2020-01-01"
        }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.personal.can_card_stack, true);
  assert.equal(result.personal.highest_revolving_limit, 10000);
});

test("computeUnderwrite detects loan stacking eligibility", () => {
  const bureaus = {
    experian: {
      score: 750,
      negatives: 0,
      late_payment_events: 0,
      tradelines: [
        {
          type: "installment",
          status: "open",
          limit: 15000,
          balance: 10000,
          opened: "2020-01-01"
        }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.personal.can_loan_stack, true);
  assert.equal(result.personal.highest_installment_amount, 15000);
});

test("computeUnderwrite rejects loan stacking with late payments", () => {
  const bureaus = {
    experian: {
      score: 750,
      negatives: 0,
      late_payment_events: 2,
      tradelines: [
        {
          type: "installment",
          status: "open",
          limit: 15000,
          opened: "2020-01-01"
        }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.personal.can_loan_stack, false);
});

test("computeUnderwrite requires 24 month seasoning for tradelines", () => {
  const recentDate = new Date();
  recentDate.setMonth(recentDate.getMonth() - 12);
  const bureaus = {
    experian: {
      score: 750,
      negatives: 0,
      tradelines: [
        {
          type: "revolving",
          status: "open",
          limit: 10000,
          opened: recentDate.toISOString().slice(0, 10)
        }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.personal.highest_revolving_limit, 0);
});

test("computeUnderwrite detects thin file", () => {
  const bureaus = {
    experian: {
      score: 720,
      negatives: 0,
      tradelines: [{ creditor: "One", status: "open" }]
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.optimization.thin_file, true);
});

test("computeUnderwrite detects file all negative", () => {
  const bureaus = {
    experian: {
      score: 600,
      negatives: 3,
      tradelines: [
        { creditor: "Bad1", status: "chargeoff" },
        { creditor: "Bad2", status: "collection" }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.optimization.file_all_negative, true);
});

test("computeUnderwrite excludes derogatory tradelines from positive count", () => {
  const bureaus = {
    experian: {
      score: 700,
      negatives: 1,
      tradelines: [
        { creditor: "Good1", status: "open" },
        { creditor: "Good2", status: "open" },
        { creditor: "Good3", status: "open" },
        { creditor: "Bad", status: "charge-off" }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.optimization.thin_file, false);
});

// ============================================================================
// computeUnderwrite - Business funding tests
// ============================================================================
test("computeUnderwrite calculates business funding with 24+ month LLC", () => {
  const bureaus = {
    experian: {
      score: 750,
      negatives: 0,
      tradelines: [
        {
          type: "revolving",
          status: "open",
          limit: 10000,
          opened: "2020-01-01"
        }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, 36);
  assert.equal(result.business.business_multiplier, 2.0);
  assert.equal(result.business.can_business_fund, true);
});

test("computeUnderwrite calculates business funding with 12-24 month LLC", () => {
  const bureaus = {
    experian: {
      score: 750,
      negatives: 0,
      tradelines: [
        {
          type: "revolving",
          status: "open",
          limit: 10000,
          opened: "2020-01-01"
        }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, 18);
  assert.equal(result.business.business_multiplier, 1.0);
});

test("computeUnderwrite calculates business funding with < 12 month LLC", () => {
  const bureaus = {
    experian: {
      score: 750,
      negatives: 0,
      tradelines: [
        {
          type: "revolving",
          status: "open",
          limit: 10000,
          opened: "2020-01-01"
        }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, 6);
  assert.equal(result.business.business_multiplier, 0.5);
});

test("computeUnderwrite has no business funding without card funding", () => {
  const bureaus = { experian: { score: 720, negatives: 0 } };
  const result = computeUnderwrite(bureaus, 36);
  assert.equal(result.business.business_multiplier, 0);
  assert.equal(result.business.can_business_fund, false);
});

// ============================================================================
// computeUnderwrite - Multi-bureau tests
// ============================================================================
test("computeUnderwrite selects highest score bureau as primary", () => {
  const bureaus = {
    experian: { score: 700 },
    equifax: { score: 750 },
    transunion: { score: 720 }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.primary_bureau, "equifax");
  assert.equal(result.metrics.score, 750);
});

test("computeUnderwrite sums inquiries across bureaus", () => {
  const bureaus = {
    experian: { score: 720, inquiries: 2 },
    equifax: { score: 720, inquiries: 3 },
    transunion: { score: 720, inquiries: 1 }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.metrics.inquiries.total, 6);
  assert.equal(result.metrics.inquiries.ex, 2);
  assert.equal(result.metrics.inquiries.eq, 3);
  assert.equal(result.metrics.inquiries.tu, 1);
});

test("computeUnderwrite scales funding when only one bureau is fundable", () => {
  const bureaus = {
    experian: {
      score: 750,
      negatives: 0,
      tradelines: [{ type: "revolving", status: "open", limit: 10000, opened: "2020-01-01" }]
    },
    equifax: { score: 600, negatives: 3 },
    transunion: { score: 600, negatives: 2 }
  };
  const result = computeUnderwrite(bureaus, null);
  // Card funding = 10000 * 5.5 = 55000, scaled by 1/3 = 18333.33
  assert.ok(result.personal.card_funding < 55000);
});

// ============================================================================
// computeUnderwrite - Optimization flags tests
// ============================================================================
test("computeUnderwrite flags util reduction needed", () => {
  const bureaus = {
    experian: { score: 720, utilization_pct: 45, negatives: 0 }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.optimization.needs_util_reduction, true);
  assert.equal(result.optimization.target_util_pct, 30);
});

test("computeUnderwrite flags inquiry cleanup needed", () => {
  const bureaus = {
    experian: { score: 720, negatives: 0, inquiries: 5 }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.optimization.needs_inquiry_cleanup, true);
});

test("computeUnderwrite flags negative cleanup needed", () => {
  const bureaus = {
    experian: { score: 650, negatives: 2 }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.optimization.needs_negative_cleanup, true);
});

test("computeUnderwrite flags new primary revolving needed", () => {
  const bureaus = {
    experian: { score: 720, negatives: 0 }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.optimization.needs_new_primary_revolving, true);
});

// ============================================================================
// computeUnderwrite - Edge cases
// ============================================================================
test("computeUnderwrite handles null bureaus", () => {
  const result = computeUnderwrite(null, null);
  assert.equal(result.fundable, false);
  assert.equal(result.primary_bureau, "experian");
});

test("computeUnderwrite handles empty bureaus", () => {
  const result = computeUnderwrite({}, null);
  assert.equal(result.fundable, false);
});

test("computeUnderwrite handles null tradeline in array", () => {
  const bureaus = {
    experian: {
      score: 720,
      negatives: 0,
      tradelines: [null, { creditor: "Valid" }]
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.ok(result);
});

test("computeUnderwrite provides default lite_banner_funding", () => {
  const bureaus = { experian: { score: 600, negatives: 0 } };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.lite_banner_funding, 15000);
});

test("computeUnderwrite handles auto and mortgage tradelines", () => {
  const bureaus = {
    experian: {
      score: 750,
      negatives: 0,
      late_payment_events: 0,
      tradelines: [
        { type: "auto", status: "open", limit: 20000, opened: "2020-01-01" },
        { type: "mortgage", status: "open", limit: 300000, opened: "2020-01-01" }
      ]
    }
  };
  const result = computeUnderwrite(bureaus, null);
  assert.equal(result.personal.highest_installment_amount, 300000);
});

test("computeUnderwrite handles string 'null' in tradeline values", () => {
  const bureaus = {
    experian: {
      score: "null",
      utilization_pct: "null",
      negatives: 0
    }
  };
  const result = computeUnderwrite(bureaus, null);
  // String "null" converts to NaN, sanitized to null, metrics shows 0
  assert.equal(result.metrics.score, 0);
});
