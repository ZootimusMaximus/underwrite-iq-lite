"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    statusCode: null,
    _headers: {},
    body: null,
    ended: false,
    setHeader(k, v) {
      this._headers[k] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
  return res;
}

function makeReq(body, method = "POST", headers = {}) {
  return { method, body, headers };
}

// ---------------------------------------------------------------------------
// Module loading with injected mocks
// ---------------------------------------------------------------------------

const mockLogger = {
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {}
};

function loadSyncHandler() {
  const modPath = require.resolve("../conversation-sync");
  const logPath = require.resolve("../logger");

  delete require.cache[modPath];
  delete require.cache[logPath];

  require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: mockLogger
  };

  // DO NOT mock conversation-archive — we will inject fetchFn via req._fetchFn

  return require("../conversation-sync");
}

// ---------------------------------------------------------------------------
// GHL + Airtable fetch mock factory
// ---------------------------------------------------------------------------

/**
 * Builds a mock fetchFn that responds to GHL and Airtable URLs.
 *
 * @param {object} opts
 * @param {object[]} opts.conversations - GHL conversation list
 * @param {object}   opts.messagesByConvId - { [convId]: message[] }
 * @param {string[]} opts.existingMessageIds - message_ids already in Airtable
 * @param {function} [opts.onInsert] - called with records array when AT insert fires
 */
function makeFetchFn({
  conversations = [],
  messagesByConvId = {},
  existingMessageIds = [],
  onInsert
} = {}) {
  const insertedBatches = [];

  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || "GET";

    // --- GHL: conversation search ---
    if (url.includes("/conversations/search")) {
      return {
        ok: true,
        text: async () => "",
        json: async () => ({ conversations })
      };
    }

    // --- GHL: messages for a conversation ---
    const msgMatch = url.match(/\/conversations\/([^/]+)\/messages/);
    if (msgMatch) {
      const convId = msgMatch[1];
      const msgs = messagesByConvId[convId] || [];
      return {
        ok: true,
        text: async () => "",
        json: async () => ({ messages: msgs })
      };
    }

    // --- Airtable: dedupe query (GET with filterByFormula) ---
    if (url.includes("api.airtable.com") && method === "GET") {
      const existing = existingMessageIds
        .filter(id => url.includes(encodeURIComponent(id)) || url.includes(id))
        .map(id => ({ fields: { message_id: id } }));
      return {
        ok: true,
        text: async () => "",
        json: async () => ({ records: existing })
      };
    }

    // --- Airtable: batch insert (POST) ---
    if (url.includes("api.airtable.com") && method === "POST") {
      const body = opts.body ? JSON.parse(opts.body) : { records: [] };
      insertedBatches.push(body.records.map(r => r.fields));
      if (onInsert) onInsert(body.records.map(r => r.fields));
      return {
        ok: true,
        text: async () => "",
        json: async () => ({ records: body.records })
      };
    }

    throw new Error(`Unhandled fetch: ${method} ${url}`);
  };

  fetchFn.getInserted = () => insertedBatches.flat();
  return fetchFn;
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe("conversation-sync auth", () => {
  beforeEach(() => {
    delete process.env.CONTEXT_FETCHER_SECRET;
    process.env.GHL_LOCATION_ID = "test-location";
  });

  it("returns 401 when secret set and no Authorization header", async () => {
    process.env.CONTEXT_FETCHER_SECRET = "my-secret";
    const handler = loadSyncHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: "abc" }, "POST", {}), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /unauthorized/i);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("returns 401 when secret set and wrong token", async () => {
    process.env.CONTEXT_FETCHER_SECRET = "my-secret";
    const handler = loadSyncHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: "abc" }, "POST", { authorization: "Bearer wrong" }), res);
    assert.equal(res.statusCode, 401);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("allows when CONTEXT_FETCHER_SECRET is not set (dev mode)", async () => {
    delete process.env.CONTEXT_FETCHER_SECRET;
    const handler = loadSyncHandler();
    const res = makeRes();
    const fetchFn = makeFetchFn({ conversations: [] });
    const req = { method: "POST", body: { sweep: true }, headers: {}, _fetchFn: fetchFn };
    await handler(req, res);
    assert.equal(res.statusCode, 200);
  });

  it("returns 200 when correct Bearer token supplied", async () => {
    process.env.CONTEXT_FETCHER_SECRET = "my-secret";
    const handler = loadSyncHandler();
    const fetchFn = makeFetchFn({ conversations: [] });
    const req = {
      method: "POST",
      body: { sweep: true },
      headers: { authorization: "Bearer my-secret" },
      _fetchFn: fetchFn
    };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("conversation-sync input validation", () => {
  beforeEach(() => {
    delete process.env.CONTEXT_FETCHER_SECRET;
    process.env.GHL_LOCATION_ID = "test-location";
  });

  it("returns 405 for GET", async () => {
    const handler = loadSyncHandler();
    const res = makeRes();
    await handler(makeReq({}, "GET"), res);
    assert.equal(res.statusCode, 405);
  });

  it("returns 200 for OPTIONS", async () => {
    const handler = loadSyncHandler();
    const res = makeRes();
    await handler(makeReq({}, "OPTIONS"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.ended, true);
  });

  it("returns 400 when body has neither contactId nor sweep", async () => {
    const handler = loadSyncHandler();
    const res = makeRes();
    const req = { method: "POST", body: {}, headers: {}, _fetchFn: makeFetchFn() };
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /contactId|sweep/i);
  });

  it("returns 500 when GHL_LOCATION_ID is not configured", async () => {
    delete process.env.GHL_LOCATION_ID;
    const handler = loadSyncHandler();
    const res = makeRes();
    const req = { method: "POST", body: { sweep: true }, headers: {}, _fetchFn: makeFetchFn() };
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /GHL_LOCATION_ID/);
    process.env.GHL_LOCATION_ID = "test-location";
  });
});

// ---------------------------------------------------------------------------
// Mode 1: single-contact sync
// ---------------------------------------------------------------------------

describe("conversation-sync single-contact mode", () => {
  const CONTACT_ID = "ghl_contact_abc";
  const CONV_ID = "conv_001";

  beforeEach(() => {
    delete process.env.CONTEXT_FETCHER_SECRET;
    process.env.GHL_LOCATION_ID = "test-location";
    process.env.AIRTABLE_API_KEY = "at-key";
    process.env.GHL_PRIVATE_API_KEY = "ghl-key";
  });

  it("inserts net-new messages for a single contact", async () => {
    const messages = [
      {
        id: "msg_001",
        messageType: "TYPE_SMS",
        direction: "inbound",
        body: "Hello",
        dateAdded: "2026-06-01T10:00:00Z"
      },
      {
        id: "msg_002",
        messageType: "TYPE_SMS",
        direction: "outbound",
        body: "Hi back",
        dateAdded: "2026-06-01T10:01:00Z"
      }
    ];
    const conversations = [{ id: CONV_ID, contactId: CONTACT_ID }];
    const fetchFn = makeFetchFn({
      conversations,
      messagesByConvId: { [CONV_ID]: messages },
      existingMessageIds: []
    });

    const handler = loadSyncHandler();
    const res = makeRes();
    const req = { method: "POST", body: { contactId: CONTACT_ID }, headers: {}, _fetchFn: fetchFn };
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.stats.inserted, 2);
    assert.equal(res.body.stats.skipped, 0);

    const inserted = fetchFn.getInserted();
    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].message_id, "msg_001");
    assert.equal(inserted[0].channel, "sms");
    assert.equal(inserted[0].direction, "inbound");
    assert.equal(inserted[0].contact_id, CONTACT_ID);
    assert.equal(inserted[0].conversation_id, CONV_ID);
  });

  it("skips messages already in Airtable (dedupe)", async () => {
    const messages = [
      {
        id: "msg_001",
        messageType: "TYPE_SMS",
        direction: "inbound",
        body: "Already stored",
        dateAdded: "2026-06-01T10:00:00Z"
      },
      {
        id: "msg_002",
        messageType: "TYPE_SMS",
        direction: "outbound",
        body: "New message",
        dateAdded: "2026-06-01T10:01:00Z"
      }
    ];
    const conversations = [{ id: CONV_ID, contactId: CONTACT_ID }];
    const fetchFn = makeFetchFn({
      conversations,
      messagesByConvId: { [CONV_ID]: messages },
      existingMessageIds: ["msg_001"] // msg_001 already in Airtable
    });

    const handler = loadSyncHandler();
    const res = makeRes();
    const req = { method: "POST", body: { contactId: CONTACT_ID }, headers: {}, _fetchFn: fetchFn };
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    const inserted = fetchFn.getInserted();
    // Only msg_002 should have been inserted
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].message_id, "msg_002");
  });

  it("returns ok:true with 0 stats when contact has no conversations", async () => {
    const fetchFn = makeFetchFn({ conversations: [] });

    const handler = loadSyncHandler();
    const res = makeRes();
    const req = { method: "POST", body: { contactId: CONTACT_ID }, headers: {}, _fetchFn: fetchFn };
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stats.inserted, 0);
    assert.equal(res.body.stats.conversations, 0);
  });
});

// ---------------------------------------------------------------------------
// Mode 2: sweep
// ---------------------------------------------------------------------------

describe("conversation-sync sweep mode", () => {
  beforeEach(() => {
    delete process.env.CONTEXT_FETCHER_SECRET;
    process.env.GHL_LOCATION_ID = "test-location";
    process.env.AIRTABLE_API_KEY = "at-key";
    process.env.GHL_PRIVATE_API_KEY = "ghl-key";
  });

  it("sweeps multiple conversations and upserts net-new", async () => {
    const conversations = [
      { id: "conv_A", contactId: "contact_A" },
      { id: "conv_B", contactId: "contact_B" }
    ];
    const messagesByConvId = {
      conv_A: [
        {
          id: "msgA1",
          messageType: "TYPE_EMAIL",
          direction: "inbound",
          body: "Email A",
          dateAdded: "2026-06-01T09:00:00Z"
        }
      ],
      conv_B: [
        {
          id: "msgB1",
          messageType: "TYPE_SMS",
          direction: "outbound",
          body: "SMS B",
          dateAdded: "2026-06-01T09:05:00Z"
        }
      ]
    };
    const fetchFn = makeFetchFn({ conversations, messagesByConvId, existingMessageIds: [] });

    const handler = loadSyncHandler();
    const res = makeRes();
    const req = { method: "POST", body: { sweep: true }, headers: {}, _fetchFn: fetchFn };
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stats.inserted, 2);
    assert.equal(res.body.stats.conversations, 2);
  });

  it("accepts a since param without error", async () => {
    const fetchFn = makeFetchFn({ conversations: [] });

    const handler = loadSyncHandler();
    const res = makeRes();
    const req = {
      method: "POST",
      body: { sweep: true, since: "2026-06-01T00:00:00Z" },
      headers: {},
      _fetchFn: fetchFn
    };
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  });

  it("handles empty sweep (no conversations) gracefully", async () => {
    const fetchFn = makeFetchFn({ conversations: [] });

    const handler = loadSyncHandler();
    const res = makeRes();
    const req = { method: "POST", body: { sweep: true }, headers: {}, _fetchFn: fetchFn };
    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stats.inserted, 0);
    assert.equal(res.body.stats.conversations, 0);
  });
});
