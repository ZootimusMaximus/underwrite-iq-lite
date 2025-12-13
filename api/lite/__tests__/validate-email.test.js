const test = require("node:test");
const assert = require("node:assert/strict");

// Store original env
const originalEnv = { ...process.env };

function resetEnv() {
  delete process.env.CLOUDFLARE_EMAIL_BASE;
  delete process.env.CLOUDFLARE_EMAIL_API_KEY;
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
test("validate-email handles OPTIONS request", async () => {
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = { method: "OPTIONS" };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
});

test("validate-email rejects non-POST methods", async () => {
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = { method: "GET" };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.ok, false);
});

// ============================================================================
// Email validation tests
// ============================================================================
test("validate-email rejects invalid email format", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = {
    method: "POST",
    body: { email: "invalid-email" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);
  assert.ok(res.body.error.includes("valid email"));

  restoreEnv();
});

test("validate-email rejects email without domain", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = {
    method: "POST",
    body: { email: "test@" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});

test("validate-email rejects email without @", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = {
    method: "POST",
    body: { email: "testexample.com" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});

test("validate-email returns error when service unavailable", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = {
    method: "POST",
    body: { email: "test@example.com" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);
  assert.ok(res.body.error.includes("unavailable"));

  restoreEnv();
});

test("validate-email handles empty email", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = {
    method: "POST",
    body: { email: "" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});

test("validate-email handles missing email field", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = {
    method: "POST",
    body: {}
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});

test("validate-email handles null body", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = {
    method: "POST",
    body: null
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});

test("validate-email trims whitespace", async () => {
  resetEnv();
  delete require.cache[require.resolve("../validate-email")];
  const handler = require("../validate-email");

  const req = {
    method: "POST",
    body: { email: "  invalid  " }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  restoreEnv();
});
