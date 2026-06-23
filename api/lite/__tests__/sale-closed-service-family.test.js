"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { resolveServiceFamily } = require("../../events/handlers/sale-closed");

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
