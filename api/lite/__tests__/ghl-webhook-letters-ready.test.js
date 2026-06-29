"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// notifyLettersReady fires U-02's funding-letter delivery on the CRS path, after
// the letter URLs are written. Env-gated: no-op until GHL_LETTERS_READY_WEBHOOK_URL
// is set (so it's safe to deploy before Chris repoints U-02 to CRS Complete).

describe("notifyLettersReady", () => {
  const originalEnv = process.env.GHL_LETTERS_READY_WEBHOOK_URL;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.GHL_LETTERS_READY_WEBHOOK_URL;
    else process.env.GHL_LETTERS_READY_WEBHOOK_URL = originalEnv;
    // ghl-webhook reads env at module-load for the registry, so reload per test
    delete require.cache[require.resolve("../ghl-webhook")];
  });

  it("is a no-op (skipped) when GHL_LETTERS_READY_WEBHOOK_URL is unset", async () => {
    delete process.env.GHL_LETTERS_READY_WEBHOOK_URL;
    delete require.cache[require.resolve("../ghl-webhook")];
    let called = false;
    global.fetch = async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    };
    const { notifyLettersReady } = require("../ghl-webhook");
    const res = await notifyLettersReady({ contactId: "abc", urls: { x: 1 }, path: "funding" });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, true);
    assert.equal(called, false, "must not fire a webhook when env unset");
  });

  it("fires the webhook with contactId + letter URLs when configured", async () => {
    process.env.GHL_LETTERS_READY_WEBHOOK_URL = "https://example.test/u02-crs-letters";
    delete require.cache[require.resolve("../ghl-webhook")];
    let capturedUrl = null;
    let capturedBody = null;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({}) };
    };
    const { notifyLettersReady } = require("../ghl-webhook");
    const res = await notifyLettersReady({
      contactId: "contact_123",
      email: "client@example.com",
      fullName: "Jane Client",
      urls: { funding_letter_url__inquiry_cleanup__ex: "https://blob/x.pdf" },
      path: "funding",
      creditSuggestions: "Pay down revolving utilization"
    });
    assert.equal(res.ok, true);
    assert.notEqual(res.skipped, true);
    assert.equal(capturedUrl, "https://example.test/u02-crs-letters");
    assert.equal(capturedBody.event, "crs_letters_ready");
    assert.equal(capturedBody.contact_id, "contact_123");
    assert.equal(capturedBody.email, "client@example.com");
    assert.equal(capturedBody.full_name, "Jane Client");
    assert.equal(capturedBody.analyzer_status, "complete");
    assert.equal(capturedBody.analyzer_path, "funding");
    // letter URL fields flattened into the payload (U-02 reads them directly)
    assert.equal(capturedBody.funding_letter_url__inquiry_cleanup__ex, "https://blob/x.pdf");
    // credit_suggestions fills U-02's placeholder
    assert.equal(capturedBody.credit_suggestions, "Pay down revolving utilization");
  });
});
