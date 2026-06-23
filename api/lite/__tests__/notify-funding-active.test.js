"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  sendFundingActiveSms,
  validateAuth,
  getSmsTemplate,
  DEFAULT_SMS_TEMPLATE
} = require("../notify-funding-active");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: null,
    _headers: {},
    body: null,
    ended: false,
    setHeader(k, v) {
      this._headers[k] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
  return res;
}

function makeReq(overrides = {}) {
  return {
    method: "POST",
    headers: {},
    body: {},
    ...overrides
  };
}

/** Build a mock fetch that returns a response with given status + body. */
function mockFetch(status, bodyObj = {}) {
  return async (_url, _opts) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(bodyObj),
    json: async () => bodyObj
  });
}

/** Capture the URL and options the mock was called with. */
function capturingMockFetch(status, bodyObj = {}) {
  let capturedUrl = null;
  let capturedOpts = null;

  const fn = async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(bodyObj),
      json: async () => bodyObj
    };
  };

  fn.getCapture = () => ({ url: capturedUrl, opts: capturedOpts });
  return fn;
}

// ---------------------------------------------------------------------------
// Auth unit tests (validateAuth)
// ---------------------------------------------------------------------------

describe("validateAuth", () => {
  afterEach(() => {
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("allows when CONTEXT_FETCHER_SECRET is not set", () => {
    delete process.env.CONTEXT_FETCHER_SECRET;
    const result = validateAuth(makeReq({ headers: {} }));
    assert.equal(result.ok, true);
  });

  it("rejects when secret is set and Authorization header is absent", () => {
    process.env.CONTEXT_FETCHER_SECRET = "test-secret";
    const result = validateAuth(makeReq({ headers: {} }));
    assert.equal(result.ok, false);
  });

  it("rejects when Bearer token is wrong", () => {
    process.env.CONTEXT_FETCHER_SECRET = "test-secret";
    const result = validateAuth(makeReq({ headers: { authorization: "Bearer wrong" } }));
    assert.equal(result.ok, false);
  });

  it("allows when Bearer token matches secret", () => {
    process.env.CONTEXT_FETCHER_SECRET = "test-secret";
    const result = validateAuth(makeReq({ headers: { authorization: "Bearer test-secret" } }));
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// SMS template
// ---------------------------------------------------------------------------

describe("getSmsTemplate", () => {
  afterEach(() => {
    delete process.env.FUNDING_ACTIVE_SMS_TEMPLATE;
  });

  it("returns DEFAULT_SMS_TEMPLATE when env var is not set", () => {
    delete process.env.FUNDING_ACTIVE_SMS_TEMPLATE;
    assert.equal(getSmsTemplate(), DEFAULT_SMS_TEMPLATE);
  });

  it("returns env override when FUNDING_ACTIVE_SMS_TEMPLATE is set", () => {
    process.env.FUNDING_ACTIVE_SMS_TEMPLATE = "Custom message here";
    assert.equal(getSmsTemplate(), "Custom message here");
  });

  it("DEFAULT_SMS_TEMPLATE mentions funding and verification", () => {
    assert.ok(DEFAULT_SMS_TEMPLATE.includes("funding"));
    assert.ok(DEFAULT_SMS_TEMPLATE.includes("verification"));
  });
});

// ---------------------------------------------------------------------------
// sendFundingActiveSms (injected fetch)
// ---------------------------------------------------------------------------

describe("sendFundingActiveSms", () => {
  beforeEach(() => {
    process.env.GHL_PRIVATE_API_KEY = "ghl-test-key";
    process.env.GHL_API_BASE = "https://services.leadconnectorhq.com";
  });

  afterEach(() => {
    delete process.env.GHL_PRIVATE_API_KEY;
    delete process.env.GHL_API_BASE;
    delete process.env.FUNDING_ACTIVE_SMS_TEMPLATE;
  });

  it("returns ok:true and sent:true on GHL success", async () => {
    const result = await sendFundingActiveSms(
      "contact123",
      {},
      mockFetch(200, { messageId: "msg_abc" })
    );
    assert.equal(result.ok, true);
    assert.equal(result.sent, true);
  });

  it("POSTs to the correct GHL Conversations API URL", async () => {
    const mock = capturingMockFetch(200, { messageId: "msg_abc" });
    await sendFundingActiveSms("contact123", {}, mock);
    const { url } = mock.getCapture();
    assert.equal(url, "https://services.leadconnectorhq.com/conversations/messages");
  });

  it("sends correct SMS body to GHL (type, contactId, message)", async () => {
    const mock = capturingMockFetch(200, {});
    await sendFundingActiveSms("contact123", {}, mock);
    const { opts } = mock.getCapture();
    const body = JSON.parse(opts.body);
    assert.equal(body.type, "SMS");
    assert.equal(body.contactId, "contact123");
    assert.equal(body.message, DEFAULT_SMS_TEMPLATE);
  });

  it("sends correct GHL auth headers (Bearer + Version)", async () => {
    const mock = capturingMockFetch(200, {});
    await sendFundingActiveSms("contact123", {}, mock);
    const { opts } = mock.getCapture();
    assert.equal(opts.headers["Authorization"], "Bearer ghl-test-key");
    assert.equal(opts.headers["Version"], "2021-07-28");
  });

  it("uses custom message from opts.message", async () => {
    const mock = capturingMockFetch(200, {});
    await sendFundingActiveSms("contact123", { message: "Custom SMS here" }, mock);
    const { opts } = mock.getCapture();
    const body = JSON.parse(opts.body);
    assert.equal(body.message, "Custom SMS here");
  });

  it("uses FUNDING_ACTIVE_SMS_TEMPLATE env override when no opts.message", async () => {
    process.env.FUNDING_ACTIVE_SMS_TEMPLATE = "Env override SMS";
    const mock = capturingMockFetch(200, {});
    await sendFundingActiveSms("contact123", {}, mock);
    const { opts } = mock.getCapture();
    const body = JSON.parse(opts.body);
    assert.equal(body.message, "Env override SMS");
  });

  it("returns ok:false on GHL 4xx failure", async () => {
    const result = await sendFundingActiveSms(
      "contact123",
      {},
      mockFetch(404, { message: "Contact not found" })
    );
    assert.equal(result.ok, false);
    assert.ok(result.error, "Should have error message");
    assert.ok(result.error.includes("404"));
  });

  it("returns ok:false on GHL 5xx failure", async () => {
    const result = await sendFundingActiveSms(
      "contact123",
      {},
      mockFetch(500, { message: "Internal Server Error" })
    );
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("500"));
  });

  it("returns ok:false when fetch throws (network error)", async () => {
    const throwingFetch = async () => {
      throw new Error("Network timeout");
    };
    const result = await sendFundingActiveSms("contact123", {}, throwingFetch);
    assert.equal(result.ok, false);
    assert.equal(result.error, "Network timeout");
  });

  it("returns ok:false when GHL API key is not configured", async () => {
    delete process.env.GHL_PRIVATE_API_KEY;
    delete process.env.GHL_API_KEY;
    const result = await sendFundingActiveSms("contact123", {}, mockFetch(200, {}));
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("API key"));
  });

  it("logs dedupeKey when provided (does not affect send in v1)", async () => {
    // v1 dedupeKey is logging-only — ensure the call still succeeds
    const result = await sendFundingActiveSms(
      "contact123",
      { dedupeKey: "round-2-2026-06-23" },
      mockFetch(200, {})
    );
    assert.equal(result.ok, true);
    assert.equal(result.sent, true);
  });
});

// ---------------------------------------------------------------------------
// Handler integration tests (full HTTP request/response cycle)
// ---------------------------------------------------------------------------

describe("handler (HTTP integration)", () => {
  // We need to require the handler fresh each test since env vars differ.
  // Re-require from the module — env changes affect config reads at call time.
  const handler = require("../notify-funding-active");

  beforeEach(() => {
    process.env.GHL_PRIVATE_API_KEY = "ghl-test-key";
    process.env.GHL_API_BASE = "https://services.leadconnectorhq.com";
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  afterEach(() => {
    delete process.env.GHL_PRIVATE_API_KEY;
    delete process.env.GHL_API_BASE;
    delete process.env.CONTEXT_FETCHER_SECRET;
    delete process.env.FUNDING_ACTIVE_SMS_TEMPLATE;
  });

  it("returns 405 for non-POST methods", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.body.ok, false);
  });

  it("returns 200 for OPTIONS preflight", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
  });

  it("returns 401 when secret is set but Authorization header is missing", async () => {
    process.env.CONTEXT_FETCHER_SECRET = "my-secret";
    const req = makeReq({ headers: {}, body: { contactId: "abc123" } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "Unauthorized");
  });

  it("returns 401 when Bearer token is wrong", async () => {
    process.env.CONTEXT_FETCHER_SECRET = "my-secret";
    const req = makeReq({
      headers: { authorization: "Bearer wrong-token" },
      body: { contactId: "abc123" }
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
  });

  it("returns 400 when contactId is missing", async () => {
    const req = makeReq({ headers: {}, body: {} });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.error.includes("contactId"));
  });

  it("returns 400 when contactId contains invalid characters", async () => {
    const req = makeReq({ headers: {}, body: { contactId: "../../etc/passwd" } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Invalid contactId");
  });

  it("returns 400 when contactId exceeds 64 characters", async () => {
    const longId = "a".repeat(65);
    const req = makeReq({ headers: {}, body: { contactId: longId } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "Invalid contactId");
  });

  it("returns 400 when contactId is empty string", async () => {
    const req = makeReq({ headers: {}, body: { contactId: "" } });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
  });

  // For GHL-hitting tests we monkey-patch global fetch in this process.
  // This avoids real network calls in tests.

  it("returns 200 { ok:true, sent:true } on GHL success (unauthenticated dev mode)", async () => {
    const saved = global.fetch;
    global.fetch = mockFetch(200, { messageId: "msg_test" });

    const req = makeReq({ headers: {}, body: { contactId: "validContact123" } });
    const res = makeRes();
    await handler(req, res);

    global.fetch = saved;
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.sent, true);
  });

  it("returns 200 when Bearer token is correct and GHL succeeds", async () => {
    process.env.CONTEXT_FETCHER_SECRET = "my-secret";
    const saved = global.fetch;
    global.fetch = mockFetch(200, { messageId: "msg_test" });

    const req = makeReq({
      headers: { authorization: "Bearer my-secret" },
      body: { contactId: "validContact123" }
    });
    const res = makeRes();
    await handler(req, res);

    global.fetch = saved;
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  });

  it("returns 502 { ok:false, error } when GHL returns error", async () => {
    const saved = global.fetch;
    global.fetch = mockFetch(503, { message: "GHL unavailable" });

    const req = makeReq({ headers: {}, body: { contactId: "validContact123" } });
    const res = makeRes();
    await handler(req, res);

    global.fetch = saved;
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.ok, false);
    assert.ok(res.body.error, "Should include error details");
  });

  it("returns 502 when GHL throws (network error)", async () => {
    const saved = global.fetch;
    global.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const req = makeReq({ headers: {}, body: { contactId: "validContact123" } });
    const res = makeRes();
    await handler(req, res);

    global.fetch = saved;
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.ok, false);
  });

  it("accepts dedupeKey in body without error (v1: logged only)", async () => {
    const saved = global.fetch;
    global.fetch = mockFetch(200, {});

    const req = makeReq({
      headers: {},
      body: { contactId: "validContact123", dedupeKey: "airtable-run-2026-06-23" }
    });
    const res = makeRes();
    await handler(req, res);

    global.fetch = saved;
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  });
});
