const test = require("node:test");
const assert = require("node:assert/strict");
const { getIdentifier, setRateLimitHeaders, checkRateLimit } = require("../rate-limiter");

// ============================================================================
// getIdentifier tests
// ============================================================================
test("getIdentifier extracts cf-connecting-ip header first", () => {
  const req = {
    headers: {
      "cf-connecting-ip": "1.2.3.4",
      "x-real-ip": "5.6.7.8",
      "x-forwarded-for": "9.10.11.12",
      "user-agent": "TestAgent"
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(getIdentifier(req), "1.2.3.4");
});

test("getIdentifier extracts x-real-ip when cf-connecting-ip missing", () => {
  const req = {
    headers: {
      "x-real-ip": "5.6.7.8",
      "x-forwarded-for": "9.10.11.12",
      "user-agent": "TestAgent"
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(getIdentifier(req), "5.6.7.8");
});

test("getIdentifier extracts first IP from x-forwarded-for", () => {
  const req = {
    headers: {
      "x-forwarded-for": "9.10.11.12, 13.14.15.16",
      "user-agent": "TestAgent"
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
  assert.equal(getIdentifier(req), "9.10.11.12");
});

test("getIdentifier uses socket remoteAddress as fallback", () => {
  const req = {
    headers: { "user-agent": "TestAgent" },
    socket: { remoteAddress: "192.168.1.1" }
  };
  assert.equal(getIdentifier(req), "192.168.1.1");
});

test("getIdentifier uses connection remoteAddress as fallback", () => {
  const req = {
    headers: { "user-agent": "TestAgent" },
    connection: { remoteAddress: "192.168.1.2" }
  };
  assert.equal(getIdentifier(req), "192.168.1.2");
});

test("getIdentifier uses user-agent as last resort", () => {
  const req = {
    headers: { "user-agent": "Mozilla/5.0" }
  };
  assert.equal(getIdentifier(req), "ua:Mozilla/5.0");
});

test("getIdentifier handles missing user-agent", () => {
  const req = { headers: {} };
  assert.equal(getIdentifier(req), "ua:unknown");
});

test("getIdentifier trims whitespace from x-forwarded-for", () => {
  const req = {
    headers: {
      "x-forwarded-for": "  10.0.0.1  , 10.0.0.2"
    }
  };
  assert.equal(getIdentifier(req), "10.0.0.1");
});

// ============================================================================
// setRateLimitHeaders tests
// ============================================================================
test("setRateLimitHeaders sets headers when limit > 0", () => {
  const headers = {};
  const res = {
    setHeader: (name, value) => {
      headers[name] = value;
    }
  };
  const result = { limit: 10, remaining: 5, reset: 1234567890 };

  setRateLimitHeaders(res, result);

  assert.equal(headers["X-RateLimit-Limit"], 10);
  assert.equal(headers["X-RateLimit-Remaining"], 5);
  assert.equal(headers["X-RateLimit-Reset"], 1234567890);
});

test("setRateLimitHeaders does not set headers when limit is 0", () => {
  const headers = {};
  const res = {
    setHeader: (name, value) => {
      headers[name] = value;
    }
  };
  const result = { limit: 0, remaining: 0, reset: 0 };

  setRateLimitHeaders(res, result);

  assert.equal(Object.keys(headers).length, 0);
});

// ============================================================================
// checkRateLimit tests (without Redis)
// ============================================================================
test("checkRateLimit returns success when rate limiting is disabled", async () => {
  // Without Redis configured, rate limiting should be disabled
  const req = {
    headers: { "x-forwarded-for": "1.2.3.4" }
  };

  const result = await checkRateLimit(req);

  assert.equal(result.success, true);
  assert.equal(result.identifier, "disabled");
});

test("checkRateLimit returns correct structure", async () => {
  const req = { headers: {} };
  const result = await checkRateLimit(req);

  assert.ok("success" in result);
  assert.ok("limit" in result);
  assert.ok("remaining" in result);
  assert.ok("reset" in result);
  assert.ok("identifier" in result);
});
