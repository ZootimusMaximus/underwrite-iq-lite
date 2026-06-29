"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const ghlPath = require.resolve("../ghl-contact-service");
let updateCalls = [];
let updateResult = { ok: true };

function loadHandler() {
  const modPath = require.resolve("../contract-signed");
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
  return require("../contract-signed");
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

describe("contract-signed handler", () => {
  beforeEach(() => {
    updateCalls = [];
    updateResult = { ok: true };
    delete process.env.CONTRACT_SIGNED_SECRET;
    delete process.env.CONTEXT_FETCHER_SECRET;
  });
  afterEach(() => {
    delete require.cache[require.resolve("../contract-signed")];
    delete require.cache[ghlPath];
  });

  it("405 on non-POST", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({}, "GET"), res);
    assert.equal(res.statusCode, 405);
  });

  it("200 on OPTIONS", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({}, "OPTIONS"), res);
    assert.equal(res.statusCode, 200);
  });

  it("401 when secret set and token wrong", async () => {
    process.env.CONTRACT_SIGNED_SECRET = "s3cret";
    const res = makeRes();
    await loadHandler()(
      makeReq({ contactId: "abc" }, "POST", { authorization: "Bearer nope" }),
      res
    );
    assert.equal(res.statusCode, 401);
  });

  it("400 when contactId missing", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({}), res);
    assert.equal(res.statusCode, 400);
  });

  it("400 when contactId invalid", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "bad id!" }), res);
    assert.equal(res.statusCode, 400);
  });

  it("flips contract_funding_signed as checkbox array on a valid call", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "contact_123" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].contactId, "contact_123");
    assert.deepEqual(updateCalls[0].fields.contract_funding_signed, ["Contract Funding Signed"]);
  });

  it("accepts GHL nested customData.contactId", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({ customData: { contactId: "c2" } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(updateCalls[0].contactId, "c2");
  });

  it("502 when GHL update fails", async () => {
    updateResult = { ok: false, error: "boom" };
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "c3" }), res);
    assert.equal(res.statusCode, 502);
  });
});
