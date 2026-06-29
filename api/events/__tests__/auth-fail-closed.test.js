"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Regression: the event bus auth must FAIL CLOSED in production when neither
// API_SECRET nor EVENT_ROUTER_TOKEN is configured. Before the fix it returned
// ok:true (open) — any unauthenticated POST could drive deposits/decisions/sales.

const indexPath = require.resolve("../index");

function load() {
  delete require.cache[indexPath];
  return require("../index").validateAuth;
}

describe("event bus validateAuth — fail closed in production", () => {
  let origEnv, origSecret, origToken;
  beforeEach(() => {
    origEnv = process.env.NODE_ENV;
    origSecret = process.env.API_SECRET;
    origToken = process.env.EVENT_ROUTER_TOKEN;
    delete process.env.API_SECRET;
    delete process.env.EVENT_ROUTER_TOKEN;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
    if (origSecret === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = origSecret;
    if (origToken === undefined) delete process.env.EVENT_ROUTER_TOKEN;
    else process.env.EVENT_ROUTER_TOKEN = origToken;
    delete require.cache[indexPath];
  });

  it("rejects (ok:false) in production when no secret is configured", () => {
    process.env.NODE_ENV = "production";
    const validateAuth = load();
    const result = validateAuth(undefined);
    assert.equal(result.ok, false);
  });

  it("allows the open path in non-production (dev/test convenience)", () => {
    process.env.NODE_ENV = "test";
    const validateAuth = load();
    const result = validateAuth(undefined);
    assert.equal(result.ok, true);
  });

  it("still validates a real token when a secret IS configured (prod)", () => {
    process.env.NODE_ENV = "production";
    process.env.API_SECRET = "s3cret";
    const validateAuth = load();
    assert.equal(validateAuth("Bearer s3cret").ok, true);
    assert.equal(validateAuth("Bearer wrong").ok, false);
    assert.equal(validateAuth(undefined).ok, false);
  });
});
