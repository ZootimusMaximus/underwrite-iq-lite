"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveServiceFamily,
  SALES_OUTCOME_BY_FAMILY
} = require("../../events/handlers/sale-closed");

// QA finding (2026-06-23): resolveServiceFamily (lane classification in
// sale-closed.js) had no module-level test, so drift went uncaught. Placed
// under api/lite/__tests__ because the repo's `npm test` glob only covers that
// dir (the api/events/__tests__ folder is NOT run by the default test command).
describe("resolveServiceFamily", () => {
  it("returns 'unknown' for empty/nullish input", () => {
    assert.equal(resolveServiceFamily(""), "unknown");
    assert.equal(resolveServiceFamily(null), "unknown");
    assert.equal(resolveServiceFamily(undefined), "unknown");
  });

  it("classifies funding variants", () => {
    assert.equal(resolveServiceFamily("funding"), "funding");
    assert.equal(resolveServiceFamily("Funding Engagement"), "funding");
    assert.equal(resolveServiceFamily("funding_engagement"), "funding");
    assert.equal(resolveServiceFamily("FUND"), "funding");
  });

  it("classifies repair variants", () => {
    assert.equal(resolveServiceFamily("repair"), "repair");
    assert.equal(resolveServiceFamily("Credit Repair"), "repair");
    assert.equal(resolveServiceFamily("credit_repair"), "repair");
    assert.equal(resolveServiceFamily("repair_program"), "repair");
  });

  it("is case-insensitive", () => {
    assert.equal(resolveServiceFamily("FUNDING"), "funding");
    assert.equal(resolveServiceFamily("REPAIR"), "repair");
  });

  it("returns 'unknown' for unrecognized services", () => {
    assert.equal(resolveServiceFamily("inquiry_removal"), "unknown");
    assert.equal(resolveServiceFamily("something_else"), "unknown");
  });
});

// sale.closed writes `sales_outcome` — the master trigger for GHL S-06 (funding
// close) / S-07 (repair close). These strings MUST match the GHL Single-Options
// picklist exactly; GHL silently drops a mismatch, so the close would fire
// nothing. Verified against the live GHL field 2026-06-28.
describe("SALES_OUTCOME_BY_FAMILY (GHL picklist exact-match guard)", () => {
  it("maps funding → exact GHL value", () => {
    assert.equal(SALES_OUTCOME_BY_FAMILY.funding, "Funding Purchased");
  });
  it("maps repair → exact GHL value", () => {
    assert.equal(SALES_OUTCOME_BY_FAMILY.repair, "Repair Purchased");
  });
  it("does not map 'unknown' (no sales_outcome written → no spurious trigger)", () => {
    assert.equal(SALES_OUTCOME_BY_FAMILY.unknown, undefined);
  });
});
