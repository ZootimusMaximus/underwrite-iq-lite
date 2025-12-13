const test = require("node:test");
const assert = require("node:assert/strict");

// Store original env
const originalEnv = { ...process.env };

function resetEnv() {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
}

function restoreEnv() {
  Object.assign(process.env, originalEnv);
}

// Mock response object
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    end() {
      return this;
    }
  };
  return res;
}

// ============================================================================
// CORS / OPTIONS tests
// ============================================================================
test("validate-phone handles OPTIONS request", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = { method: "OPTIONS" };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");

  restoreEnv();
});

test("validate-phone rejects non-POST methods", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = { method: "GET" };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.ok, false);

  restoreEnv();
});

// ============================================================================
// Phone validation tests
// ============================================================================
test("validate-phone rejects phone number too short", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = {
    method: "POST",
    body: { phone: "12345" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);
  assert.ok(res.body.error.includes("valid phone"));

  restoreEnv();
});

test("validate-phone rejects phone number too long", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = {
    method: "POST",
    body: { phone: "1234567890123456" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});

test("validate-phone accepts valid 10 digit phone without Twilio", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = {
    method: "POST",
    body: { phone: "5551234567" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.normalized, "5551234567");
  assert.ok(res.body.warning);

  restoreEnv();
});

test("validate-phone strips non-digit characters", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = {
    method: "POST",
    body: { phone: "(555) 123-4567" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.normalized, "5551234567");

  restoreEnv();
});

test("validate-phone handles international format", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = {
    method: "POST",
    body: { phone: "+1-555-123-4567" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.normalized, "15551234567");

  restoreEnv();
});

test("validate-phone handles empty phone", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = {
    method: "POST",
    body: { phone: "" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});

test("validate-phone handles missing phone field", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = {
    method: "POST",
    body: {}
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});

test("validate-phone handles null body", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-phone")];
  const handler = require("../validate-phone");

  const req = {
    method: "POST",
    body: null
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});
