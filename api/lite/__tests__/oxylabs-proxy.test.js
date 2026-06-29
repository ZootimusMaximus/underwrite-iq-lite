"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeCity, buildProxyForCity } = require("../oxylabs-proxy");

const PW = "test_pw_123";

describe("sanitizeCity", () => {
  it("lowercases + keeps single-word cities", () => {
    assert.equal(sanitizeCity("Mesa"), "mesa");
  });
  it("collapses spaces/separators to single underscores", () => {
    assert.equal(sanitizeCity("Los Angeles"), "los_angeles");
    assert.equal(sanitizeCity("Winston-Salem"), "winston_salem");
    assert.equal(sanitizeCity("St. Petersburg"), "st_petersburg");
  });
  it("trims leading/trailing separators", () => {
    assert.equal(sanitizeCity("  Phoenix  "), "phoenix");
    assert.equal(sanitizeCity("-Mesa-"), "mesa");
  });
  it("returns '' for empty/invalid input", () => {
    assert.equal(sanitizeCity(""), "");
    assert.equal(sanitizeCity(null), "");
    assert.equal(sanitizeCity(undefined), "");
    assert.equal(sanitizeCity(42), "");
  });
});

describe("buildProxyForCity", () => {
  it("encodes city + country into the username", () => {
    const p = buildProxyForCity("Mesa", { password: PW });
    assert.equal(p.username, "customer-fundhub_uiyg4-cc-US-city-mesa");
    assert.equal(p.cityTargeted, true);
    assert.equal(p.city, "mesa");
    assert.equal(p.host, "pr.oxylabs.io");
    assert.equal(p.port, "7777");
  });

  it("falls back to country-only when no city", () => {
    const p = buildProxyForCity("", { password: PW });
    assert.equal(p.username, "customer-fundhub_uiyg4-cc-US");
    assert.equal(p.cityTargeted, false);
    assert.equal(p.city, null);
  });

  it("honors a non-US country", () => {
    const p = buildProxyForCity("toronto", { country: "ca", password: PW });
    assert.equal(p.username, "customer-fundhub_uiyg4-cc-CA-city-toronto");
    assert.equal(p.country, "CA");
  });

  it("builds a usable proxy URL with auth", () => {
    const p = buildProxyForCity("Mesa", { password: PW });
    assert.equal(
      p.proxyUrl,
      `http://customer-fundhub_uiyg4-cc-US-city-mesa:${PW}@pr.oxylabs.io:7777`
    );
  });

  it("URL-encodes special chars in the proxy URL (real password has '+')", () => {
    const p = buildProxyForCity("Mesa", { password: "Millionaire95+" });
    // raw forms preserved for the -U / separate-auth path
    assert.equal(p.password, "Millionaire95+");
    assert.equal(p.authString, "customer-fundhub_uiyg4-cc-US-city-mesa:Millionaire95+");
    // but the URL userinfo is percent-encoded so '+' can't be read as a space
    assert.ok(p.proxyUrl.includes("Millionaire95%2B"), "password should be %-encoded in URL");
    assert.ok(!/Millionaire95\+@/.test(p.proxyUrl), "raw '+' must not appear in URL userinfo");
  });

  it("throws when no password is configured", () => {
    const orig = process.env.OXYLABS_PROXY_PASSWORD;
    delete process.env.OXYLABS_PROXY_PASSWORD;
    try {
      assert.throws(() => buildProxyForCity("Mesa"), /OXYLABS_PROXY_PASSWORD/);
    } finally {
      if (orig !== undefined) process.env.OXYLABS_PROXY_PASSWORD = orig;
    }
  });
});
