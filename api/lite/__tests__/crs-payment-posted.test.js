"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Mock ghl-contact-service.updateContactCustomFields via require.cache.
const ghlPath = require.resolve("../ghl-contact-service");
let updateCalls = [];
let updateResult = { ok: true };

function loadHandler() {
  const modPath = require.resolve("../crs-payment-posted");
  delete require.cache[modPath];
  delete require.cache[ghlPath];
  require.cache[ghlPath] = {
    id: ghlPath,
    filename: ghlPath,
    loaded: true,
    exports: {
      updateContactCustomFields: async (contactId, fields) => {
        updateCalls.push({ contactId, fields });
        return updateResult;
      }
    }
  };
  return require("../crs-payment-posted");
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

describe("crs-payment-posted handler", () => {
  beforeEach(() => {
    updateCalls = [];
    updateResult = { ok: true };
    delete process.env.CRS_PAYMENT_SECRET;
    delete process.env.CONTEXT_FETCHER_SECRET;
  });
  afterEach(() => {
    delete require.cache[require.resolve("../crs-payment-posted")];
    delete require.cache[ghlPath];
  });

  it("405 on non-POST", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({}, "GET"), res);
    assert.equal(res.statusCode, 405);
  });

  it("200 on OPTIONS preflight", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({}, "OPTIONS"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.ended, true);
  });

  it("401 when secret set and token wrong", async () => {
    process.env.CRS_PAYMENT_SECRET = "s3cret";
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: "abc" }, "POST", { authorization: "Bearer nope" }), res);
    assert.equal(res.statusCode, 401);
  });

  it("400 when contactId missing", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({}), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /contactId/);
  });

  it("400 when contactId invalid", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: "bad id!" }), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Invalid/);
  });

  it("flips crs_paid = 'CRS Paid' on a valid call", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: "contact_123" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].contactId, "contact_123");
    assert.equal(updateCalls[0].fields.crs_paid, "CRS Paid");
  });

  it("records charge amount + consent when provided", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: "c1", amount: 49.99, consent: true }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(updateCalls[0].fields.cf_crs_charge_amount, "49.99");
    assert.equal(updateCalls[0].fields.cf_crs_softpull_consent, "Yes");
  });

  it("accepts GHL nested customData.contactId", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ customData: { contactId: "c2" } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(updateCalls[0].contactId, "c2");
  });

  it("502 when GHL update fails", async () => {
    updateResult = { ok: false, error: "boom" };
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: "c3" }), res);
    assert.equal(res.statusCode, 502);
  });
});
