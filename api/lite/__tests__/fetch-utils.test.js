const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_TIMEOUT_MS, OPENAI_TIMEOUT_MS } = require("../fetch-utils");

// ============================================================================
// Constants tests
// ============================================================================
test("DEFAULT_TIMEOUT_MS is 30 seconds", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30000);
});

test("OPENAI_TIMEOUT_MS is 60 seconds", () => {
  assert.equal(OPENAI_TIMEOUT_MS, 60000);
});

// Note: fetchWithTimeout and fetchOpenAI tests removed as they require
// external HTTP calls which are unreliable in CI environments.
// The functions are simple wrappers around fetch with AbortController timeout.
