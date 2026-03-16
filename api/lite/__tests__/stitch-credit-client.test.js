"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildConsumerPayload,
  BUREAU_ENDPOINTS,
  BUSINESS_ENDPOINTS,
  invalidateToken
} = require("../crs/stitch-credit-client");

// ============================================================================
// buildConsumerPayload
// ============================================================================

test("buildConsumerPayload: full applicant", () => {
  const payload = buildConsumerPayload({
    firstName: "BARBARA",
    middleName: "M",
    lastName: "DOTY",
    suffix: "",
    ssn: "666321120",
    birthDate: "1966-01-04",
    address: {
      addressLine1: "123 MAIN ST",
      addressLine2: "APT 4",
      city: "DENTON",
      state: "TX",
      postalCode: "76201"
    }
  });

  assert.equal(payload.firstName, "BARBARA");
  assert.equal(payload.middleName, "M");
  assert.equal(payload.lastName, "DOTY");
  assert.equal(payload.ssn, "666321120");
  assert.equal(payload.birthDate, "1966-01-04");
  assert.equal(payload.addresses.length, 1);
  assert.equal(payload.addresses[0].borrowerResidencyType, "Current");
  assert.equal(payload.addresses[0].addressLine1, "123 MAIN ST");
  assert.equal(payload.addresses[0].city, "DENTON");
  assert.equal(payload.addresses[0].state, "TX");
  assert.equal(payload.addresses[0].postalCode, "76201");
});

test("buildConsumerPayload: minimal applicant (no middleName, no suffix)", () => {
  const payload = buildConsumerPayload({
    firstName: "JOHN",
    lastName: "DOE",
    ssn: "666111222",
    birthDate: "1980-05-15",
    address: {
      addressLine1: "456 OAK AVE",
      city: "DALLAS",
      state: "TX",
      postalCode: "75201"
    }
  });

  assert.equal(payload.middleName, "");
  assert.equal(payload.suffix, "");
  assert.equal(payload.addresses[0].addressLine2, "");
});

// ============================================================================
// Bureau endpoints configured
// ============================================================================

test("BUREAU_ENDPOINTS: all 3 bureaus defined", () => {
  assert.ok(BUREAU_ENDPOINTS.transunion);
  assert.ok(BUREAU_ENDPOINTS.experian);
  assert.ok(BUREAU_ENDPOINTS.equifax);
  assert.ok(BUREAU_ENDPOINTS.transunion.includes("tu-prequal-fico9"));
  assert.ok(BUREAU_ENDPOINTS.experian.includes("exp-prequal-fico9"));
  assert.ok(BUREAU_ENDPOINTS.equifax.includes("efx-prequal-fico9"));
});

test("BUSINESS_ENDPOINTS: search and report defined", () => {
  assert.ok(BUSINESS_ENDPOINTS.search);
  assert.ok(BUSINESS_ENDPOINTS.report);
});

// ============================================================================
// invalidateToken
// ============================================================================

test("invalidateToken: does not throw", () => {
  assert.doesNotThrow(() => invalidateToken());
});
