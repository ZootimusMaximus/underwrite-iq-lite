"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const handlerPath = require.resolve("../deliver-letters");
const ghlPath = require.resolve("../ghl-contact-service");
const ldPath = require.resolve("../letter-delivery");

let ghlResult;
let deliverResult;
let deliverCalledWith;

function loadHandler() {
  delete require.cache[handlerPath];
  delete require.cache[ghlPath];
  delete require.cache[ldPath];
  require.cache[ghlPath] = {
    id: ghlPath,
    filename: ghlPath,
    loaded: true,
    exports: { getGHLContact: async () => ghlResult }
  };
  require.cache[ldPath] = {
    id: ldPath,
    filename: ldPath,
    loaded: true,
    exports: {
      deliverLetters: async params => {
        deliverCalledWith = params;
        return deliverResult;
      }
    }
  };
  return require("../deliver-letters");
}

function makeReq(body, method = "POST", headers = {}) {
  return { method, headers, body };
}
function makeRes() {
  return {
    statusCode: 0,
    body: null,
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
      return this;
    }
  };
}

describe("deliver-letters handler", () => {
  beforeEach(() => {
    ghlResult = {
      ok: true,
      contact: {
        firstName: "Chris",
        lastName: "S",
        city: "Gilbert",
        state: "AZ",
        postalCode: "85233",
        address1: "1005 W Hudson Way"
      }
    };
    deliverResult = { ok: true, letters: { generated: 6, uploaded: 6 }, ghlUpdated: true };
    deliverCalledWith = null;
    delete process.env.DELIVER_LETTERS_SECRET;
    delete process.env.CONTEXT_FETCHER_SECRET;
  });
  afterEach(() => {
    delete require.cache[handlerPath];
    delete require.cache[ghlPath];
    delete require.cache[ldPath];
  });

  it("405 on non-POST", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({}, "GET"), res);
    assert.equal(res.statusCode, 405);
  });

  it("400 when contactId missing", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({}), res);
    assert.equal(res.statusCode, 400);
  });

  it("FAILS CLOSED (401) in production with no secret", async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const res = makeRes();
    try {
      await loadHandler()(makeReq({ contactId: "c1" }), res);
      assert.equal(res.statusCode, 401);
    } finally {
      if (orig === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = orig;
    }
  });

  it("delivers repair letters and writes GHL (default = repair, all 3 bureaus)", async () => {
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "GrpVLpkbfK0SxVuSYWMT" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.type, "repair");
    assert.equal(res.body.ghlUpdated, true);
    // deliverLetters got a CRS repair documents package + the GHL-derived personal.
    assert.ok(deliverCalledWith);
    assert.equal(deliverCalledWith.contactId, "GrpVLpkbfK0SxVuSYWMT");
    assert.equal(deliverCalledWith.personal.name, "Chris S");
    assert.equal(deliverCalledWith.crsDocuments.package, "repair");
    assert.ok(deliverCalledWith.crsDocuments.letters.length > 0);
    // TransUnion must map to the "tu" suffix (bug #51) in the generated specs.
    assert.ok(deliverCalledWith.crsDocuments.letters.some(l => l.fieldKey.endsWith("__tu")));
  });

  it("502 when GHL lookup fails", async () => {
    ghlResult = { ok: false, error: "nope" };
    const res = makeRes();
    await loadHandler()(makeReq({ contactId: "c1" }), res);
    assert.equal(res.statusCode, 502);
  });
});
