const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_TIMEOUT_MS,
  OPENAI_TIMEOUT_MS,
  checkCircuitBreaker,
  recordSuccess,
  recordFailure
} = require("../fetch-utils");

// ============================================================================
// Constants tests
// ============================================================================
test("DEFAULT_TIMEOUT_MS is 30 seconds", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30000);
});

test("OPENAI_TIMEOUT_MS is 18 seconds to fit within Vercel limit", () => {
  // 3 sequential passes × 18s = 54s total, leaving buffer for Vercel's 60s limit
  assert.equal(OPENAI_TIMEOUT_MS, 18000);
});

// ============================================================================
// Circuit breaker tests
// ============================================================================
test("circuit breaker allows requests when closed", () => {
  // Reset state by recording success
  recordSuccess();
  const result = checkCircuitBreaker();
  assert.equal(result.allowed, true);
});

test("circuit breaker opens after threshold failures", () => {
  // Reset state
  recordSuccess();

  // Record 3 failures to trip the breaker
  recordFailure();
  recordFailure();
  recordFailure();

  const result = checkCircuitBreaker();
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("temporarily unavailable"));

  // Reset for other tests
  recordSuccess();
});

test("circuit breaker resets on success", () => {
  // Trip the breaker
  recordFailure();
  recordFailure();
  recordFailure();

  // Record success should reset
  recordSuccess();

  const result = checkCircuitBreaker();
  assert.equal(result.allowed, true);
});

// Note: fetchWithTimeout and fetchOpenAI tests removed as they require
// external HTTP calls which are unreliable in CI environments.
// The functions are simple wrappers around fetch with AbortController timeout.
