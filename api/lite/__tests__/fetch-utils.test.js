const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fetchWithTimeout,
  fetchOpenAI,
  DEFAULT_TIMEOUT_MS,
  OPENAI_TIMEOUT_MS
} = require("../fetch-utils");

// ============================================================================
// Constants tests
// ============================================================================
test("DEFAULT_TIMEOUT_MS is 30 seconds", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30000);
});

test("OPENAI_TIMEOUT_MS is 60 seconds", () => {
  assert.equal(OPENAI_TIMEOUT_MS, 60000);
});

// ============================================================================
// fetchWithTimeout tests
// ============================================================================
test("fetchWithTimeout returns response for successful request", async () => {
  // Use a real endpoint that responds quickly
  const response = await fetchWithTimeout("https://httpbin.org/get", {}, 10000);
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
});

test("fetchWithTimeout throws on timeout", async () => {
  // Use a delay endpoint with very short timeout
  await assert.rejects(
    async () => {
      await fetchWithTimeout("https://httpbin.org/delay/10", {}, 100);
    },
    err => err.message.includes("timed out")
  );
});

test("fetchWithTimeout passes options to fetch", async () => {
  const response = await fetchWithTimeout(
    "https://httpbin.org/post",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true })
    },
    10000
  );
  assert.equal(response.ok, true);
});

test("fetchWithTimeout uses default timeout when not specified", async () => {
  // Just verify it doesn't throw with default timeout
  const response = await fetchWithTimeout("https://httpbin.org/get");
  assert.equal(response.ok, true);
});

// ============================================================================
// fetchOpenAI tests
// ============================================================================
test("fetchOpenAI uses longer timeout", async () => {
  // This just verifies the function works with the longer timeout
  const response = await fetchOpenAI("https://httpbin.org/get", {});
  assert.equal(response.ok, true);
});

test("fetchOpenAI passes options correctly", async () => {
  const response = await fetchOpenAI("https://httpbin.org/post", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test" })
  });
  assert.equal(response.ok, true);
});

// ============================================================================
// Error handling tests
// ============================================================================
test("fetchWithTimeout propagates network errors", async () => {
  await assert.rejects(
    async () => {
      await fetchWithTimeout("https://invalid-domain-that-does-not-exist-12345.com", {}, 5000);
    },
    err => err.name === "TypeError" || err.code === "ENOTFOUND" || err.message.includes("fetch")
  );
});
