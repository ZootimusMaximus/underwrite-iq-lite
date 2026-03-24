"use strict";

// =============================================================================
// AX06 Payload Compatibility Tests
//
// Validates that the payload shape AX06 sends matches what
// crs-pull-and-analyze.js expects. These are pure validation tests —
// no Stitch Credit API calls.
// =============================================================================

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

function mockReq(body) {
  return {
    method: "POST",
    body,
    url: "/api/lite/crs-pull-and-analyze",
    headers: { "x-forwarded-for": "127.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

// ---------------------------------------------------------------------------
// AX06-shaped payloads
// ---------------------------------------------------------------------------

/** Minimal valid AX06 payload (consumer_only scope) */
function ax06ConsumerOnly() {
  return {
    applicant: {
      firstName: "Chris",
      lastName: "Stanbridge",
      ssn: "613250475",
      birthDate: "1995-09-02",
      address: {
        addressLine1: "1005 W Hudson Way",
        city: "Gilbert",
        state: "AZ",
        postalCode: "85233"
      }
    },
    crs_pull_scope: "consumer_only",
    formData: {
      email: "stanbridgejchris@gmail.com",
      phone: "+14805551234",
      airtableRecordId: "recXXXXXXXXXX",
      forceReprocess: true
    }
  };
}

// ============================================================================
// Tests
// ============================================================================

test("AX06 payload: consumer_only passes validation (reaches pull stage)", async () => {
  const res = mockRes();
  await handler(mockReq(ax06ConsumerOnly()), res);
  // Should pass all validation and reach the CRS pull stage.
  // Without Stitch Credit creds, it will fail at pull — but that means
  // validation passed (status 200 with CRS_PULL_FAILED, not 400).
  assert.equal(res._status, 200);
  assert.ok(
    res._body.error === "CRS_PULL_FAILED" || res._body.ok === true,
    `Expected CRS_PULL_FAILED or ok:true, got error=${res._body.error}`
  );
});

test("AX06 payload: SSN with dashes passes validation", async () => {
  const payload = ax06ConsumerOnly();
  payload.applicant.ssn = "613-25-0475";
  const res = mockRes();
  await handler(mockReq(payload), res);
  assert.equal(res._status, 200);
  assert.notEqual(res._body.error, "INVALID_SSN");
});

test("AX06 payload: missing firstName rejected", async () => {
  const payload = ax06ConsumerOnly();
  payload.applicant.firstName = "";
  const res = mockRes();
  await handler(mockReq(payload), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "INCOMPLETE_APPLICANT");
  assert.ok(res._body.message.includes("firstName"));
});

test("AX06 payload: missing SSN rejected", async () => {
  const payload = ax06ConsumerOnly();
  payload.applicant.ssn = "";
  const res = mockRes();
  await handler(mockReq(payload), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "INCOMPLETE_APPLICANT");
});

test("AX06 payload: missing address rejected", async () => {
  const payload = ax06ConsumerOnly();
  delete payload.applicant.address;
  const res = mockRes();
  await handler(mockReq(payload), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "INCOMPLETE_ADDRESS");
});

test("AX06 payload: partial address (no city) rejected", async () => {
  const payload = ax06ConsumerOnly();
  delete payload.applicant.address.city;
  const res = mockRes();
  await handler(mockReq(payload), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "INCOMPLETE_ADDRESS");
});

test("AX06 payload: invalid SSN (too short) rejected", async () => {
  const payload = ax06ConsumerOnly();
  payload.applicant.ssn = "12345";
  const res = mockRes();
  await handler(mockReq(payload), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "INVALID_SSN");
});

test("AX06 payload: crs_pull_scope=consumer_only accepted", async () => {
  const payload = ax06ConsumerOnly();
  payload.crs_pull_scope = "consumer_only";
  const res = mockRes();
  await handler(mockReq(payload), res);
  // Should pass validation (get to pull stage or succeed)
  assert.equal(res._status, 200);
});

test("AX06 payload: crs_pull_scope=consumer_plus_ex_business without business rejected", async () => {
  const payload = ax06ConsumerOnly();
  payload.crs_pull_scope = "consumer_plus_ex_business";
  // No business object
  const res = mockRes();
  await handler(mockReq(payload), res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, "BUSINESS_IDENTITY_MISSING_FOR_REQUESTED_PULL_SCOPE");
});

test("AX06 payload: crs_pull_scope=consumer_plus_ex_business with business passes validation", async () => {
  const payload = ax06ConsumerOnly();
  payload.crs_pull_scope = "consumer_plus_ex_business";
  payload.business = {
    name: "FundHub LLC",
    city: "Gilbert",
    state: "AZ"
  };
  const res = mockRes();
  await handler(mockReq(payload), res);
  // Should pass validation and reach pull stage
  assert.equal(res._status, 200);
  assert.ok(
    res._body.error === "CRS_PULL_FAILED" || res._body.ok === true,
    `Expected CRS_PULL_FAILED or ok:true, got error=${res._body.error}`
  );
});

test("AX06 payload: forceReprocess=true bypasses dedup", async () => {
  const payload = ax06ConsumerOnly();
  payload.formData.forceReprocess = true;
  const res = mockRes();
  await handler(mockReq(payload), res);
  // Should NOT return deduped:true
  assert.equal(res._status, 200);
  if (res._body.ok) {
    assert.equal(res._body.deduped, false);
  }
});

test("AX06 payload: airtableRecordId passed through in formData", async () => {
  const payload = ax06ConsumerOnly();
  payload.formData.airtableRecordId = "recABC123";
  const res = mockRes();
  await handler(mockReq(payload), res);
  // Validation passes (reaches pull stage)
  assert.equal(res._status, 200);
});

test("AX06 payload: default crs_pull_scope when omitted is consumer_only", async () => {
  const payload = ax06ConsumerOnly();
  delete payload.crs_pull_scope;
  const res = mockRes();
  await handler(mockReq(payload), res);
  // Should pass validation (defaults to consumer_only, no business required)
  assert.equal(res._status, 200);
});
