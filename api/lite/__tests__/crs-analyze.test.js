"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// ---------------------------------------------------------------------------
// Load the handler
// ---------------------------------------------------------------------------

// We test the handler by calling it directly with mock req/res objects.
// Dependencies that need external services (Redis, GHL) are tested as no-ops.
const handler = require("../crs-analyze");

// ---------------------------------------------------------------------------
// Load live sandbox responses
// ---------------------------------------------------------------------------
const FIXTURES_DIR = path.resolve(__dirname, "../../../../mar 2026");
let tuRaw;

try {
  tuRaw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "tu-response.json"), "utf8"));
} catch {
  // Tests will be skipped if fixture files are not available
}

// ---------------------------------------------------------------------------
// Mock req/res helpers
// ---------------------------------------------------------------------------

function mockRes() {
  const res = {
    _status: null,
    _body: null,
    _headers: {},
    setHeader(k, v) {
      res._headers[k] = v;
      return res;
    },
    status(code) {
      res._status = code;
      return res;
    },
    json(data) {
      res._body = data;
      return res;
    },
    end() {
      return res;
    }
  };
  return res;
}

function mockReq(method, body) {
  return {
    method,
    body,
    url: "/api/lite/crs-analyze",
    headers: { "x-forwarded-for": "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

// ============================================================================
// Tests
// ============================================================================

test("crs-analyze: OPTIONS → 200 CORS", async () => {
  const res = mockRes();
  await handler(mockReq("OPTIONS"), res);
  assert.equal(res._status, 200);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "*");
});

test("crs-analyze: GET → 405", async () => {
  const res = mockRes();
  await handler(mockReq("GET"), res);
  assert.equal(res._status, 405);
  assert.equal(res._body.error, "METHOD_NOT_ALLOWED");
});

test("crs-analyze: missing body → 400", async () => {
  const res = mockRes();
  await handler(mockReq("POST", null), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "MISSING_BODY");
});

test("crs-analyze: empty rawResponses → 400", async () => {
  const res = mockRes();
  await handler(mockReq("POST", { rawResponses: [] }), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "MISSING_RAW_RESPONSES");
});

test("crs-analyze: too many responses → 400", async () => {
  const res = mockRes();
  await handler(mockReq("POST", { rawResponses: [1, 2, 3, 4] }), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "TOO_MANY_RESPONSES");
});

test("crs-analyze: full pipeline with TU response", { skip: !tuRaw }, async () => {
  const res = mockRes();
  await handler(
    mockReq("POST", {
      rawResponses: [tuRaw],
      formData: {
        name: "BARBARA M DOTY",
        email: "test@example.com",
        phone: "5551234567",
        ref: "test-ref-123"
      }
    }),
    res
  );

  assert.equal(res._status, 200);
  assert.equal(res._body.ok, true);
  assert.equal(res._body.deduped, false);

  // Top-level spec fields present
  assert.ok(res._body.outcome);
  assert.ok(res._body.decision_label);
  assert.ok(res._body.decision_explanation);
  assert.ok(Array.isArray(res._body.reason_codes));
  assert.ok(res._body.confidence);
  assert.ok(typeof res._body.consumer_summary === "string");
  assert.ok(typeof res._body.business_summary === "string");

  // Detail sections present
  assert.ok(res._body.preapprovals);
  assert.ok(Array.isArray(res._body.optimization_findings));
  assert.ok(res._body.suggestions);
  assert.ok(Array.isArray(res._body.cards));
  assert.ok(res._body.documents);
  assert.ok(res._body.redirect);
  assert.ok(res._body.audit);

  // Redirect has required fields
  assert.ok(res._body.redirect.resultType);
  assert.ok(res._body.redirect.refId);
});

test("crs-analyze: formData.ref flows to redirect.refId", { skip: !tuRaw }, async () => {
  const res = mockRes();
  await handler(
    mockReq("POST", {
      rawResponses: [tuRaw],
      formData: { name: "BARBARA M DOTY", ref: "my-custom-ref", forceReprocess: true }
    }),
    res
  );

  assert.equal(res._status, 200);
  assert.ok(res._body, "response body should exist");
  assert.equal(
    res._body.ok,
    true,
    `expected ok=true, got: ${JSON.stringify(res._body?.error || res._body?.message)}`
  );
  assert.ok(res._body.redirect, "redirect should exist");
  assert.equal(res._body.redirect.refId, "my-custom-ref");
});
