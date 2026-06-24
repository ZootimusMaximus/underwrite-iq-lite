"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { getActiveConsumerBureaus, ALL_CONSUMER_BUREAUS } = require("../crs/stitch-credit-client");

// Launch reality (2026-06-24): CRS production has Experian + Equifax, NOT
// TransUnion. CRS_ACTIVE_BUREAUS lets us skip the unavailable bureau without a
// code change; defaults to all 3 (unchanged behavior) when unset.
describe("getActiveConsumerBureaus", () => {
  const original = process.env.CRS_ACTIVE_BUREAUS;
  beforeEach(() => {
    delete process.env.CRS_ACTIVE_BUREAUS;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CRS_ACTIVE_BUREAUS;
    else process.env.CRS_ACTIVE_BUREAUS = original;
  });

  it("defaults to all 3 bureaus when env is unset", () => {
    assert.deepEqual(getActiveConsumerBureaus(), ALL_CONSUMER_BUREAUS);
  });

  it("returns the configured subset (EX + EQ, no TU)", () => {
    process.env.CRS_ACTIVE_BUREAUS = "experian,equifax";
    assert.deepEqual(getActiveConsumerBureaus(), ["experian", "equifax"]);
  });

  it("is case-insensitive and trims whitespace", () => {
    process.env.CRS_ACTIVE_BUREAUS = " Experian , EQUIFAX ";
    assert.deepEqual(getActiveConsumerBureaus(), ["experian", "equifax"]);
  });

  it("ignores unknown bureau names", () => {
    process.env.CRS_ACTIVE_BUREAUS = "experian,foobar,equifax";
    assert.deepEqual(getActiveConsumerBureaus(), ["experian", "equifax"]);
  });

  it("falls back to all 3 when the value is empty/invalid", () => {
    process.env.CRS_ACTIVE_BUREAUS = " , , ";
    assert.deepEqual(getActiveConsumerBureaus(), ALL_CONSUMER_BUREAUS);
  });
});
