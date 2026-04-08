"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------
let mockContacts = []; // findContactByEmail / phone results
let mockFetchCalls = []; // all fetch calls
let mockFetchResponses = {}; // url-pattern → response
const _mockEnv = {};

// Mock ghl-contact-service
const mockFindContactByEmail = mock.fn(async email => {
  return mockContacts.find(c => c.email === email) || null;
});

const mockUpdateContactCustomFields = mock.fn(async () => {
  return { ok: true, updatedFields: 3 };
});

// Mock logger (no-ops)
const mockLogger = {
  logInfo: mock.fn(),
  logWarn: mock.fn(),
  logError: mock.fn()
};

// Mock fetch for phone lookup + opportunity calls
const _originalFetch = global.fetch;

global.fetch = async (url, opts) => {
  mockFetchCalls.push({ url, opts });

  // Check for pattern-based mocks
  for (const [pattern, response] of Object.entries(mockFetchResponses)) {
    if (url.includes(pattern)) {
      return response;
    }
  }

  // Default: 200 with empty result
  return {
    ok: true,
    status: 200,
    json: async () => ({ contacts: [], opportunities: [] }),
    text: async () => "{}"
  };
};

// ---------------------------------------------------------------------------
// Require handler with mocked deps
// ---------------------------------------------------------------------------
// We need to mock the require calls. Use a fresh require for each test.
let handler;

function loadHandler() {
  // Clear module cache
  const modPath = require.resolve("../disputefox-intake");
  const ghlPath = require.resolve("../ghl-contact-service");
  const logPath = require.resolve("../logger");
  delete require.cache[modPath];
  delete require.cache[ghlPath];
  delete require.cache[logPath];

  // Pre-populate cache with mocks
  require.cache[ghlPath] = {
    id: ghlPath,
    filename: ghlPath,
    loaded: true,
    exports: {
      findContactByEmail: mockFindContactByEmail,
      updateContactCustomFields: mockUpdateContactCustomFields
    }
  };
  require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: mockLogger
  };

  handler = require("../disputefox-intake");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeReq(body, method = "POST", headers = {}) {
  return {
    method,
    body,
    headers: { "content-type": "application/json", ...headers }
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
    end() {
      return res;
    },
    setHeader(k, v) {
      res.headers[k] = v;
    }
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("DisputeFox Intake (R-WH-01 replacement)", () => {
  beforeEach(() => {
    mockContacts = [];
    mockFetchCalls = [];
    mockFetchResponses = {};
    mockFindContactByEmail.mock.resetCalls();
    mockUpdateContactCustomFields.mock.resetCalls();
    mockLogger.logInfo.mock.resetCalls();
    mockLogger.logWarn.mock.resetCalls();
    mockLogger.logError.mock.resetCalls();

    // Set required env
    process.env.GHL_PRIVATE_API_KEY = "test-pit-key";
    process.env.GHL_LOCATION_ID = "test-location-id";
    delete process.env.DISPUTEFOX_INTAKE_SECRET;
    delete process.env.GHL_API_BASE;

    loadHandler();
  });

  afterEach(() => {
    delete process.env.GHL_PRIVATE_API_KEY;
    delete process.env.GHL_LOCATION_ID;
    delete process.env.DISPUTEFOX_INTAKE_SECRET;
    delete process.env.GHL_API_BASE;
  });

  // -------------------------------------------------------------------------
  // Basic request validation
  // -------------------------------------------------------------------------

  it("rejects non-POST", async () => {
    const res = makeRes();
    await handler(makeReq(null, "GET"), res);
    assert.equal(res.statusCode, 405);
  });

  it("handles CORS preflight", async () => {
    const res = makeRes();
    await handler(makeReq(null, "OPTIONS"), res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers["Access-Control-Allow-Origin"]);
  });

  it("rejects empty body", async () => {
    const res = makeRes();
    await handler(makeReq(null), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
  });

  it("rejects unauthorized when secret is configured", async () => {
    process.env.DISPUTEFOX_INTAKE_SECRET = "my-secret";
    loadHandler();
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added", email: "a@b.com" }), res);
    assert.equal(res.statusCode, 401);
  });

  it("accepts valid secret", async () => {
    process.env.DISPUTEFOX_INTAKE_SECRET = "my-secret";
    loadHandler();
    mockContacts = [{ id: "c1", email: "a@b.com" }];
    const res = makeRes();
    await handler(
      makeReq({ df_event: "client_added", email: "a@b.com" }, "POST", {
        "x-intake-secret": "my-secret"
      }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  });

  it("returns 500 when GHL API key missing", async () => {
    delete process.env.GHL_PRIVATE_API_KEY;
    loadHandler();
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added" }), res);
    assert.equal(res.statusCode, 500);
  });

  // -------------------------------------------------------------------------
  // Contact lookup
  // -------------------------------------------------------------------------

  it("skips gracefully when no contact found", async () => {
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added", email: "nobody@x.com" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.action, "skipped");
    assert.equal(res.body.reason, "no_contact_found");
  });

  it("finds contact by email", async () => {
    mockContacts = [{ id: "contact-123", email: "test@fundhub.ai" }];
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added", email: "test@fundhub.ai" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.action, "processed");
    assert.equal(res.body.contact_id, "contact-123");
  });

  it("falls back to phone lookup when email not found", async () => {
    // No email match in mockContacts, but set up phone match via fetch
    mockFetchResponses["contacts/?locationId"] = {
      ok: true,
      status: 200,
      json: async () => ({
        contacts: [{ id: "phone-contact", phone: "+16616180865" }]
      }),
      text: async () => "{}"
    };

    const res = makeRes();
    await handler(makeReq({ df_event: "client_added", phone: "+16616180865" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.action, "processed");
    assert.equal(res.body.contact_id, "phone-contact");
  });

  // -------------------------------------------------------------------------
  // Custom field writes
  // -------------------------------------------------------------------------

  it("writes df_* custom fields to contact", async () => {
    mockContacts = [{ id: "c1", email: "test@x.com" }];
    const res = makeRes();
    await handler(
      makeReq({
        df_event: "client_updated",
        email: "test@x.com",
        df_client_id: "df-999",
        df_status_id: "5",
        df_case_id: "case-42"
      }),
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.fields_written, true);

    // Verify updateContactCustomFields was called with correct fields
    const call = mockUpdateContactCustomFields.mock.calls[0];
    assert.equal(call.arguments[0], "c1"); // contactId
    const fields = call.arguments[1];
    assert.equal(fields.df_event, "client_updated");
    assert.equal(fields.df_client_id, "df-999");
    assert.equal(fields.df_status, "5");
    assert.equal(fields.df_case_id, "case-42");
    assert.ok(fields.df_raw); // raw payload logged
  });

  it("handles field write failure gracefully", async () => {
    mockContacts = [{ id: "c1", email: "test@x.com" }];
    mockUpdateContactCustomFields.mock.mockImplementation(async () => ({
      ok: false,
      error: "API error"
    }));
    loadHandler(); // reload to pick up new mock

    // Re-setup the mock since loadHandler replaces it
    // Actually loadHandler sets up the mock from cache, let's just set it
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added", email: "test@x.com" }), res);
    // Should still return 200 — field write failure is non-fatal
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.action, "processed");
  });

  // -------------------------------------------------------------------------
  // Pipeline stage routing
  // -------------------------------------------------------------------------

  it("does not route non-client events to pipeline", async () => {
    mockContacts = [{ id: "c1", email: "test@x.com" }];
    const res = makeRes();
    await handler(
      makeReq({
        df_event: "task_added",
        email: "test@x.com",
        df_status_id: "1"
      }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stage_action, "none");
  });

  it("logs unmapped df_status_id for discovery", async () => {
    mockContacts = [{ id: "c1", email: "test@x.com" }];
    const res = makeRes();
    await handler(
      makeReq({
        df_event: "client_updated",
        email: "test@x.com",
        df_status_id: "999"
      }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stage_action, "unknown_status");

    // Verify the discovery log was emitted
    const infoCalls = mockLogger.logInfo.mock.calls;
    const discoveryLog = infoCalls.find(
      c => c.arguments[0] === "DisputeFox intake: UNMAPPED df_status_id — add to STATUS_TO_STAGE"
    );
    assert.ok(discoveryLog, "Should log unmapped status for discovery");
    assert.equal(discoveryLog.arguments[1].df_status_id, "999");
  });

  it("skips stage routing when no df_status_id present", async () => {
    mockContacts = [{ id: "c1", email: "test@x.com" }];
    const res = makeRes();
    await handler(makeReq({ df_event: "client_added", email: "test@x.com" }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stage_action, "none");
  });

  // -------------------------------------------------------------------------
  // Full payload logging
  // -------------------------------------------------------------------------

  it("logs all incoming payload keys for debugging", async () => {
    mockContacts = [{ id: "c1", email: "test@x.com" }];
    const res = makeRes();
    await handler(
      makeReq({
        df_event: "client_added",
        email: "test@x.com",
        df_status_id: "3",
        df_folder_id: "77",
        df_workflow_id: "12",
        custom_field: "hello"
      }),
      res
    );

    const infoCalls = mockLogger.logInfo.mock.calls;
    const receiveLog = infoCalls.find(c => c.arguments[0] === "DisputeFox intake received");
    assert.ok(receiveLog);
    assert.equal(receiveLog.arguments[1].df_status_id, "3");
    assert.equal(receiveLog.arguments[1].df_folder_id, "77");
    assert.equal(receiveLog.arguments[1].df_workflow_id, "12");
    assert.ok(receiveLog.arguments[1].raw_keys.includes("custom_field"));
  });

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  it("exports pipeline constants for external use", () => {
    assert.ok(handler.REPAIR_PIPELINE_ID);
    assert.ok(handler.REPAIR_STAGES);
    assert.ok(handler.REPAIR_STAGES.R1);
    assert.equal(Object.keys(handler.REPAIR_STAGES).length, 13);
  });

  it("exports STATUS_TO_STAGE mapping (currently empty placeholder)", () => {
    assert.ok(handler.STATUS_TO_STAGE !== undefined);
    assert.equal(typeof handler.STATUS_TO_STAGE, "object");
  });

  // -------------------------------------------------------------------------
  // All 6 event types processed
  // -------------------------------------------------------------------------

  for (const event of [
    "client_added",
    "client_updated",
    "task_added",
    "task_updated",
    "lead_added",
    "lead_updated"
  ]) {
    it(`processes ${event} event`, async () => {
      mockContacts = [{ id: "c1", email: "test@x.com" }];
      // Need to reload for each since mockUpdateCustomFields may have changed
      mockUpdateContactCustomFields.mock.mockImplementation(async () => ({
        ok: true,
        updatedFields: 2
      }));

      const res = makeRes();
      await handler(makeReq({ df_event: event, email: "test@x.com" }), res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.action, "processed");
      assert.equal(res.body.event, event);
    });
  }
});
