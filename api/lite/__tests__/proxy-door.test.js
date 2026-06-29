"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const ghlPath = require.resolve("../ghl-contact-service");
let ghlResult = { ok: true, contact: { city: "Mesa" } };

function loadHandler() {
  const modPath = require.resolve("../proxy-door");
  delete require.cache[modPath];
  delete require.cache[ghlPath];
  require.cache[ghlPath] = {
    id: ghlPath,
    filename: ghlPath,
    loaded: true,
    exports: { getGHLContact: async () => ghlResult }
  };
  return require("../proxy-door");
}

function makeReq(body, method = "POST", headers = {}) {
  return { method, headers, body };
}
function makeRes() {
  return {
    statusCode: 0,
    body: null,
    ended: false,
    _headers: {},
    setHeader(k, v) {
      this._headers[k] = v;
    },
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
}

describe("proxy-door handler", () => {
  beforeEach(() => {
    ghlResult = { ok: true, contact: { city: "Mesa" } };
    process.env.OXYLABS_PROXY_PASSWORD = "test_pw";
    delete process.env.PROXY_DOOR_SECRET;
    delete process.env.CONTEXT_FETCHER_SECRET;
  });
  afterEach(() => {
    delete require.cache[require.resolve("../proxy-door")];
    delete require.cache[ghlPath];
    delete process.env.OXYLABS_PROXY_PASSWORD;
  });

  it("405 on non-POST", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({}, "GET"), res);
    assert.equal(res.statusCode, 405);
  });

  it("401 when secret set + token wrong", async () => {
    process.env.PROXY_DOOR_SECRET = "s3cret";
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "abc" }, "POST", { authorization: "Bearer x" }), res);
    assert.equal(res.statusCode, 401);
  });

  it("400 when contactId missing", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({}), res);
    assert.equal(res.statusCode, 400);
  });

  it("500 when proxy password not configured", async () => {
    delete process.env.OXYLABS_PROXY_PASSWORD;
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "c1" }), res);
    assert.equal(res.statusCode, 500);
  });

  it("returns a city-targeted proxy for a contact with a city", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "c1" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cityTargeted, true);
    assert.equal(res.body.city, "mesa");
    assert.match(res.body.proxy.username, /-cc-US-city-mesa$/);
    assert.equal(res.body.proxy.host, "pr.oxylabs.io");
  });

  it("falls back to country-only when contact has no city", async () => {
    ghlResult = { ok: true, contact: { city: "" } };
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "c1" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.cityTargeted, false);
    assert.match(res.body.proxy.username, /-cc-US$/);
  });

  it("502 when GHL lookup fails", async () => {
    ghlResult = { ok: false, error: "nope" };
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "c1" }), res);
    assert.equal(res.statusCode, 502);
  });
});
