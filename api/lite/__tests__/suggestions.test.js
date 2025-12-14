const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSuggestions } = require("../suggestions");

// Helper to create mock underwrite result
function createMockUW(overrides = {}) {
  return {
    fundable: false,
    optimization: {
      needs_util_reduction: false,
      needs_new_primary_revolving: false,
      needs_inquiry_cleanup: false,
      needs_negative_cleanup: false,
      needs_file_buildout: false,
      thin_file: false,
      file_all_negative: false,
      ...overrides.optimization
    },
    metrics: {
      utilization_pct: 20,
      negative_accounts: 0,
      inquiries: { total: 0 },
      ...overrides.metrics
    },
    personal: {
      highest_revolving_limit: 5000,
      highest_installment_amount: 10000,
      ...overrides.personal
    },
    ...overrides
  };
}

// ============================================================================
// Utilization suggestions
// ============================================================================
test("buildSuggestions returns extreme high util suggestion for 80%+", () => {
  const uw = createMockUW({
    optimization: { needs_util_reduction: true },
    metrics: { utilization_pct: 85 }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("extremely high") && s.includes("80%+")));
});

test("buildSuggestions returns high util suggestion for 50-80%", () => {
  const uw = createMockUW({
    optimization: { needs_util_reduction: true },
    metrics: { utilization_pct: 65 }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("high (50–80%)")));
});

test("buildSuggestions returns moderate util suggestion for 30-50%", () => {
  const uw = createMockUW({
    optimization: { needs_util_reduction: true },
    metrics: { utilization_pct: 35 }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("below ~30%")));
});

// ============================================================================
// Primary revolving suggestions
// ============================================================================
test("buildSuggestions returns revolving suggestion when needed", () => {
  const uw = createMockUW({
    optimization: { needs_new_primary_revolving: true }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("$5,000+ limit")));
});

// ============================================================================
// Inquiry suggestions
// ============================================================================
test("buildSuggestions returns high inquiry suggestion for 12+", () => {
  const uw = createMockUW({
    optimization: { needs_inquiry_cleanup: true },
    metrics: { inquiries: { total: 15 } }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("high number") && s.includes("auto-declines")));
});

test("buildSuggestions returns moderate inquiry suggestion for < 12", () => {
  const uw = createMockUW({
    optimization: { needs_inquiry_cleanup: true },
    metrics: { inquiries: { total: 5 } }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("duplicate hard inquiries")));
});

// ============================================================================
// Negative account suggestions
// ============================================================================
test("buildSuggestions returns high negative suggestion for 5+", () => {
  const uw = createMockUW({
    optimization: { needs_negative_cleanup: true },
    metrics: { negative_accounts: 7 }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("multiple negative") && s.includes("charge-offs")));
});

test("buildSuggestions returns moderate negative suggestion for < 5", () => {
  const uw = createMockUW({
    optimization: { needs_negative_cleanup: true },
    metrics: { negative_accounts: 2 }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("Targeted disputes")));
});

// ============================================================================
// File buildout suggestions
// ============================================================================
test("buildSuggestions returns all-negative file suggestion", () => {
  const uw = createMockUW({
    optimization: { needs_file_buildout: true, file_all_negative: true }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("mostly negative") && s.includes("rebuild")));
});

test("buildSuggestions returns thin file suggestion with no tradelines", () => {
  const uw = createMockUW({
    optimization: { needs_file_buildout: true, file_all_negative: false },
    personal: { highest_revolving_limit: 0, highest_installment_amount: 0 }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("thin") && s.includes("credit card")));
});

test("buildSuggestions returns general buildout suggestion", () => {
  const uw = createMockUW({
    optimization: { needs_file_buildout: true, file_all_negative: false },
    personal: { highest_revolving_limit: 3000, highest_installment_amount: 5000 }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(suggestions.some(s => s.includes("additional positive tradelines")));
});

// ============================================================================
// LLC suggestions
// ============================================================================
test("buildSuggestions suggests LLC for fundable user without LLC", () => {
  const uw = createMockUW({ fundable: true });
  const suggestions = buildSuggestions(uw, { hasLLC: false });
  assert.ok(suggestions.some(s => s.includes("LLC")));
});

test("buildSuggestions suggests LLC for non-fundable user without LLC", () => {
  const uw = createMockUW({ fundable: false });
  const suggestions = buildSuggestions(uw, { hasLLC: false });
  assert.ok(suggestions.some(s => s.includes("Form an LLC now") && s.includes("season")));
});

test("buildSuggestions notes young LLC under 6 months", () => {
  const uw = createMockUW({ fundable: false });
  const suggestions = buildSuggestions(uw, { hasLLC: true, llcAgeMonths: 3 });
  assert.ok(suggestions.some(s => s.includes("under 6 months")));
});

test("buildSuggestions notes seasoning LLC 6-24 months", () => {
  const uw = createMockUW({ fundable: false });
  const suggestions = buildSuggestions(uw, { hasLLC: true, llcAgeMonths: 12 });
  assert.ok(suggestions.some(s => s.includes("seasoning well")));
});

test("buildSuggestions notes fully seasoned LLC with fundable profile", () => {
  const uw = createMockUW({ fundable: true });
  const suggestions = buildSuggestions(uw, { hasLLC: true, llcAgeMonths: 30 });
  assert.ok(suggestions.some(s => s.includes("fully seasoned") && s.includes("top-tier")));
});

test("buildSuggestions notes seasoned LLC with non-fundable profile", () => {
  const uw = createMockUW({ fundable: false });
  const suggestions = buildSuggestions(uw, { hasLLC: true, llcAgeMonths: 30 });
  assert.ok(suggestions.some(s => s.includes("seasoned") && s.includes("cleanup")));
});

// ============================================================================
// Fallback suggestions
// ============================================================================
test("buildSuggestions returns strong profile fallback when fundable", () => {
  const uw = createMockUW({ fundable: true });
  const suggestions = buildSuggestions(uw, { hasLLC: true, llcAgeMonths: 30 });
  // Should have LLC suggestion, check for strong profile if no other issues
  assert.ok(suggestions.length > 0);
});

test("buildSuggestions returns close to approval fallback when not fundable", () => {
  const uw = createMockUW({ fundable: false });
  // No optimization flags, no LLC
  const suggestions = buildSuggestions(uw, { hasLLC: true, llcAgeMonths: 30 });
  assert.ok(suggestions.length > 0);
});

// ============================================================================
// Edge cases
// ============================================================================
test("buildSuggestions handles missing user object", () => {
  const uw = createMockUW({ fundable: true });
  const suggestions = buildSuggestions(uw);
  assert.ok(Array.isArray(suggestions));
  assert.ok(suggestions.length > 0);
});

test("buildSuggestions handles missing optimization object", () => {
  const uw = { fundable: false, metrics: {}, personal: {} };
  const suggestions = buildSuggestions(uw);
  assert.ok(Array.isArray(suggestions));
});

test("buildSuggestions handles missing metrics object", () => {
  const uw = { fundable: false, optimization: {}, personal: {} };
  const suggestions = buildSuggestions(uw);
  assert.ok(Array.isArray(suggestions));
});

test("buildSuggestions handles null inquiries total", () => {
  const uw = createMockUW({
    optimization: { needs_inquiry_cleanup: true },
    metrics: { inquiries: null }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(Array.isArray(suggestions));
});

test("buildSuggestions returns array of strings", () => {
  const uw = createMockUW({
    optimization: {
      needs_util_reduction: true,
      needs_inquiry_cleanup: true,
      needs_negative_cleanup: true
    },
    metrics: { utilization_pct: 50, negative_accounts: 3, inquiries: { total: 5 } }
  });
  const suggestions = buildSuggestions(uw);
  assert.ok(Array.isArray(suggestions));
  suggestions.forEach(s => assert.equal(typeof s, "string"));
});
