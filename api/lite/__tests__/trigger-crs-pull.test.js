"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const handler = require("../trigger-crs-pull");
const { mapPIIToApplicant } = require("../trigger-crs-pull");

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
    url: "/api/lite/trigger-crs-pull",
    headers: { "x-forwarded-for": "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

// ============================================================================
// HTTP Method Tests
// ============================================================================

test("trigger-crs-pull: OPTIONS returns 200 CORS", async () => {
  const res = mockRes();
  await handler(mockReq("OPTIONS"), res);
  assert.equal(res._status, 200);
  assert.equal(res._headers["Access-Control-Allow-Origin"], "*");
  assert.equal(res._headers["Access-Control-Allow-Methods"], "POST, OPTIONS");
});

test("trigger-crs-pull: GET returns 405", async () => {
  const res = mockRes();
  await handler(mockReq("GET"), res);
  assert.equal(res._status, 405);
  assert.equal(res._body.error, "METHOD_NOT_ALLOWED");
});

test("trigger-crs-pull: PUT returns 405", async () => {
  const res = mockRes();
  await handler(mockReq("PUT"), res);
  assert.equal(res._status, 405);
});

// ============================================================================
// Validation Tests
// ============================================================================

test("trigger-crs-pull: missing body returns 400", async () => {
  const res = mockRes();
  await handler(mockReq("POST", null), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "MISSING_BODY");
});

test("trigger-crs-pull: missing client_id returns 400", async () => {
  const res = mockRes();
  await handler(mockReq("POST", {}), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "MISSING_CLIENT_ID");
});

test("trigger-crs-pull: empty client_id returns 400", async () => {
  const res = mockRes();
  await handler(mockReq("POST", { client_id: "" }), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "MISSING_CLIENT_ID");
});

test("trigger-crs-pull: invalid pull_type returns 400", async () => {
  const res = mockRes();
  await handler(mockReq("POST", { client_id: "recABC123", pull_type: "full_monty" }), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "INVALID_PULL_TYPE");
  assert.ok(res._body.message.includes("consumer_only"));
  assert.ok(res._body.message.includes("consumer_plus_ex_business"));
});

test("trigger-crs-pull: missing Airtable config returns 500", async () => {
  // With no AIRTABLE_API_KEY / AIRTABLE_BASE_ID set in env, should hit config check
  const res = mockRes();
  await handler(mockReq("POST", { client_id: "recABC123" }), res);
  assert.equal(res._status, 500);
  assert.equal(res._body.error, "AIRTABLE_NOT_CONFIGURED");
});

// ============================================================================
// mapPIIToApplicant Unit Tests
// ============================================================================

test("mapPIIToApplicant: valid PII returns applicant object", () => {
  const result = mapPIIToApplicant({
    owner_first_name: "John",
    owner_last_name: "Doe",
    ssn_full: "666-11-1234",
    dob: "1985-06-15",
    phone: "2145551234",
    street1: "123 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75201"
  });

  assert.equal(result.ok, true);
  assert.equal(result.applicant.firstName, "John");
  assert.equal(result.applicant.lastName, "Doe");
  assert.equal(result.applicant.ssn, "666111234");
  assert.equal(result.applicant.birthDate, "1985-06-15");
  assert.equal(result.applicant.address.addressLine1, "123 Main St");
  assert.equal(result.applicant.address.city, "Dallas");
  assert.equal(result.applicant.address.state, "TX");
  assert.equal(result.applicant.address.postalCode, "75201");
});

test("mapPIIToApplicant: strips non-digit chars from SSN", () => {
  const result = mapPIIToApplicant({
    owner_first_name: "Jane",
    owner_last_name: "Smith",
    ssn_full: "666-22-3456",
    dob: "1990-01-01",
    street1: "456 Oak Ave",
    city: "Houston",
    state: "TX",
    zip: "77001"
  });

  assert.equal(result.ok, true);
  assert.equal(result.applicant.ssn, "666223456");
});

test("mapPIIToApplicant: missing first name returns error", () => {
  const result = mapPIIToApplicant({
    owner_last_name: "Doe",
    ssn_full: "666111234",
    dob: "1985-06-15",
    street1: "123 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75201"
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("owner_first_name"));
});

test("mapPIIToApplicant: short SSN returns error", () => {
  const result = mapPIIToApplicant({
    owner_first_name: "John",
    owner_last_name: "Doe",
    ssn_full: "1234",
    dob: "1985-06-15",
    street1: "123 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75201"
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes("ssn_full")));
});

test("mapPIIToApplicant: missing multiple fields returns all errors", () => {
  const result = mapPIIToApplicant({});

  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 8);
  assert.ok(result.errors.includes("owner_first_name"));
  assert.ok(result.errors.includes("owner_last_name"));
  assert.ok(result.errors.includes("dob"));
  assert.ok(result.errors.includes("street1"));
  assert.ok(result.errors.includes("city"));
  assert.ok(result.errors.includes("state"));
  assert.ok(result.errors.includes("zip"));
});

test("mapPIIToApplicant: trims whitespace from fields", () => {
  const result = mapPIIToApplicant({
    owner_first_name: "  John  ",
    owner_last_name: "  Doe  ",
    ssn_full: "666111234",
    dob: "  1985-06-15  ",
    street1: "  123 Main St  ",
    city: "  Dallas  ",
    state: "  TX  ",
    zip: "  75201  "
  });

  assert.equal(result.ok, true);
  assert.equal(result.applicant.firstName, "John");
  assert.equal(result.applicant.lastName, "Doe");
  assert.equal(result.applicant.address.city, "Dallas");
});

test("mapPIIToApplicant: missing address fields returns errors", () => {
  const result = mapPIIToApplicant({
    owner_first_name: "John",
    owner_last_name: "Doe",
    ssn_full: "666111234",
    dob: "1985-06-15"
    // No address fields
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("street1"));
  assert.ok(result.errors.includes("city"));
  assert.ok(result.errors.includes("state"));
  assert.ok(result.errors.includes("zip"));
});

test("mapPIIToApplicant: empty SSN returns error", () => {
  const result = mapPIIToApplicant({
    owner_first_name: "John",
    owner_last_name: "Doe",
    ssn_full: "",
    dob: "1985-06-15",
    street1: "123 Main St",
    city: "Dallas",
    state: "TX",
    zip: "75201"
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes("ssn_full")));
});
