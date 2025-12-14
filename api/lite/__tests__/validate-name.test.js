const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../validate-name");

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
test("validate-name handles OPTIONS request", () => {
  const req = { method: "OPTIONS" };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.ok(res.headers["Access-Control-Allow-Methods"].includes("POST"));
});

test("validate-name rejects non-POST methods", () => {
  const req = { method: "GET" };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.ok, false);
});

// ============================================================================
// Name validation tests
// ============================================================================
test("validate-name accepts valid names", () => {
  const req = {
    method: "POST",
    body: { firstName: "John", lastName: "Doe" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, true);
});

test("validate-name accepts lowercase field names", () => {
  const req = {
    method: "POST",
    body: { firstname: "John", lastname: "Doe" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, true);
});

test("validate-name accepts names with hyphens", () => {
  const req = {
    method: "POST",
    body: { firstName: "Mary-Jane", lastName: "O'Brien" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, true);
});

test("validate-name accepts names with apostrophes", () => {
  const req = {
    method: "POST",
    body: { firstName: "D'Angelo", lastName: "McDonald" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, true);
});

test("validate-name accepts names with spaces", () => {
  const req = {
    method: "POST",
    body: { firstName: "Mary Jane", lastName: "Van Der Berg" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, true);
});

test("validate-name rejects missing firstName", () => {
  const req = {
    method: "POST",
    body: { lastName: "Doe" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, false);
  assert.ok(res.body.error.includes("required"));
});

test("validate-name rejects missing lastName", () => {
  const req = {
    method: "POST",
    body: { firstName: "John" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, false);
  assert.ok(res.body.error.includes("required"));
});

test("validate-name rejects empty firstName", () => {
  const req = {
    method: "POST",
    body: { firstName: "", lastName: "Doe" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, false);
});

test("validate-name rejects names with numbers", () => {
  const req = {
    method: "POST",
    body: { firstName: "John123", lastName: "Doe" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, false);
  assert.ok(res.body.error.includes("letters"));
});

test("validate-name rejects names with special characters", () => {
  const req = {
    method: "POST",
    body: { firstName: "John@", lastName: "Doe" }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, false);
});

test("validate-name handles empty body", () => {
  const req = {
    method: "POST",
    body: {}
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, false);
});

test("validate-name handles null body", () => {
  const req = {
    method: "POST",
    body: null
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, false);
});

test("validate-name handles undefined body", () => {
  const req = {
    method: "POST"
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, false);
});

test("validate-name trims whitespace", () => {
  const req = {
    method: "POST",
    body: { firstName: "  John  ", lastName: "  Doe  " }
  };
  const res = createMockRes();

  handler(req, res);

  assert.equal(res.body.ok, true);
});
