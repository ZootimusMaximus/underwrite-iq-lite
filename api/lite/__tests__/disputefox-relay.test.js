"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Mock fetch globally
let lastFetchUrl = null;
let lastFetchBody = null;
let mockFetchResponse = { ok: true, status: 200, text: async () => "{}" };

global.fetch = async (url, opts) => {
  lastFetchUrl = url;
  lastFetchBody = opts?.body ? JSON.parse(opts.body) : null;
  return mockFetchResponse;
};

const handler = require("../disputefox-relay");

function makeReq(body, method = "POST", headers = {}) {
  return { method, body, headers: { "content-type": "application/json", ...headers } };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
    end() {
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
    }
  };
  return res;
}

describe("DisputeFox Relay", () => {
  beforeEach(() => {
    lastFetchUrl = null;
    lastFetchBody = null;
    mockFetchResponse = { ok: true, status: 200, text: async () => "{}" };
    // logger doesn't need mocking — it's a side effect
    delete process.env.DISPUTEFOX_RELAY_MODE;
    delete process.env.ZAPIER_WEBHOOK_URL;
    delete process.env.DISPUTEFOX_API_KEY;
  });

  it("rejects non-POST", async () => {
    const res = makeRes();
    await handler(makeReq(null, "GET"), res);
    assert.equal(res.statusCode, 405);
  });

  it("rejects empty body", async () => {
    const res = makeRes();
    await handler(makeReq(null, "POST"), res);
    assert.equal(res.statusCode, 400);
  });

  it("forwards client_added to GHL (direct mode)", async () => {
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added", email: "a@b.com" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.mapped_zap, "DF-01");
    assert.equal(res.body.mode, "direct");
    assert.equal(res.body.forwarded_to, "GHL R-WH-01");
    assert.ok(lastFetchUrl.includes("disputefox-intake"));
    assert.equal(lastFetchBody.df_event, "client_added");
    assert.equal(lastFetchBody.source, "disputefox");
  });

  it("maps all 6 event types correctly", async () => {
    const events = [
      ["client_added", "DF-01"],
      ["client_updated", "DF-02"],
      ["task_added", "DF-03"],
      ["task_updated", "DF-04"],
      ["lead_added", "DF-05"],
      ["lead_updated", "DF-06"]
    ];
    for (const [event, expectedZap] of events) {
      const res = makeRes();
      await handler(makeReq({ df_event: event }), res);
      assert.equal(res.body.mapped_zap, expectedZap, `${event} should map to ${expectedZap}`);
    }
  });

  it("routes to Zapier when mode=zapier", async () => {
    process.env.DISPUTEFOX_RELAY_MODE = "zapier";
    process.env.ZAPIER_WEBHOOK_URL = "https://hooks.zapier.com/test";
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added" }), res);
    assert.equal(res.body.mode, "zapier");
    assert.equal(res.body.forwarded_to, "Zapier");
    assert.equal(lastFetchUrl, "https://hooks.zapier.com/test");
  });

  it("falls back to direct if zapier mode but no URL", async () => {
    process.env.DISPUTEFOX_RELAY_MODE = "zapier";
    // No ZAPIER_WEBHOOK_URL set
    const res = makeRes();
    await handler(makeReq({ df_event: "task_updated" }), res);
    assert.equal(res.body.mode, "direct");
    assert.ok(lastFetchUrl.includes("disputefox-intake"));
  });

  it("enforces auth when DISPUTEFOX_API_KEY is set", async () => {
    process.env.DISPUTEFOX_API_KEY = "secret123";
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added" }, "POST", {}), res);
    assert.equal(res.statusCode, 401);
  });

  it("allows auth via Bearer token", async () => {
    process.env.DISPUTEFOX_API_KEY = "secret123";
    const res = makeRes();
    await handler(
      makeReq({ df_event: "client_added" }, "POST", { authorization: "Bearer secret123" }),
      res
    );
    assert.equal(res.statusCode, 200);
  });

  it("allows auth via x-api-key header", async () => {
    process.env.DISPUTEFOX_API_KEY = "secret123";
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added" }, "POST", { "x-api-key": "secret123" }), res);
    assert.equal(res.statusCode, 200);
  });

  it("returns 502 when GHL webhook fails", async () => {
    mockFetchResponse = { ok: false, status: 500, text: async () => "Internal Server Error" };
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added" }), res);
    assert.equal(res.statusCode, 502);
  });

  it("handles unknown events gracefully", async () => {
    const res = makeRes();
    await handler(makeReq({ df_event: "unknown_event" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.mapped_zap, "DF-XX");
  });

  it("handles CORS preflight", async () => {
    const res = makeRes();
    await handler(makeReq(null, "OPTIONS"), res);
    assert.equal(res.statusCode, 200);
  });
});
