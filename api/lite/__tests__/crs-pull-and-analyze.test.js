"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const handler = require("../crs-pull-and-analyze");

// ---------------------------------------------------------------------------
// Mock req/res
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
    url: "/api/lite/crs-pull-and-analyze",
    headers: { "x-forwarded-for": "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

// ============================================================================
// Validation Tests (no real API calls)
// ============================================================================

test("crs-pull-and-analyze: OPTIONS → 200 CORS", async () => {
  const res = mockRes();
  await handler(mockReq("OPTIONS"), res);
  assert.equal(res._status, 200);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "*");
});

test("crs-pull-and-analyze: GET → 405", async () => {
  const res = mockRes();
  await handler(mockReq("GET"), res);
  assert.equal(res._status, 405);
});

test("crs-pull-and-analyze: missing body → 400", async () => {
  const res = mockRes();
  await handler(mockReq("POST", null), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "MISSING_BODY");
});

test("crs-pull-and-analyze: missing applicant → 400", async () => {
  const res = mockRes();
  await handler(mockReq("POST", {}), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "MISSING_APPLICANT");
});

test("crs-pull-and-analyze: incomplete applicant → 400", async () => {
  const res = mockRes();
  await handler(
    mockReq("POST", {
      applicant: { firstName: "JOHN" }
    }),
    res
  );
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "INCOMPLETE_APPLICANT");
  assert.ok(res._body.message.includes("lastName"));
  assert.ok(res._body.message.includes("ssn"));
  assert.ok(res._body.message.includes("birthDate"));
});

test("crs-pull-and-analyze: missing address → 400", async () => {
  const res = mockRes();
  await handler(
    mockReq("POST", {
      applicant: {
        firstName: "JOHN",
        lastName: "DOE",
        ssn: "666111222",
        birthDate: "1980-01-01"
      }
    }),
    res
  );
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "INCOMPLETE_ADDRESS");
});

test("crs-pull-and-analyze: invalid SSN → 400", async () => {
  const res = mockRes();
  await handler(
    mockReq("POST", {
      applicant: {
        firstName: "JOHN",
        lastName: "DOE",
        ssn: "123",
        birthDate: "1980-01-01",
        address: { addressLine1: "123 MAIN ST", city: "DALLAS", state: "TX", postalCode: "75201" }
      }
    }),
    res
  );
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "INVALID_SSN");
});

test("crs-pull-and-analyze: SSN with dashes cleaned to 9 digits", async () => {
  const res = mockRes();
  // This will fail at the pull stage (no Stitch Credit creds) but should pass validation
  await handler(
    mockReq("POST", {
      applicant: {
        firstName: "JOHN",
        lastName: "DOE",
        ssn: "666-11-1222",
        birthDate: "1980-01-01",
        address: { addressLine1: "123 MAIN ST", city: "DALLAS", state: "TX", postalCode: "75201" }
      }
    }),
    res
  );
  // Should get past validation (status 200 with pull error, not 400)
  assert.equal(res._status, 200);
  assert.notEqual(res._body.error, "INVALID_SSN");
});
