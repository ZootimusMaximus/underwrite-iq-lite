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

test("OPENAI_TIMEOUT_MS defaults to 55 seconds (configurable via env)", () => {
  // Default is 55s for production (fits within Vercel's 60s limit)
  // Can be overridden via OPENAI_TIMEOUT env var for local dev
  const expected = parseInt(process.env.OPENAI_TIMEOUT || "55000", 10);
  assert.equal(OPENAI_TIMEOUT_MS, expected);
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
