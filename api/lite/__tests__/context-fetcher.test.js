"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Pure unit tests for derivation helpers (no mocking needed)
// ---------------------------------------------------------------------------

const { deriveClientStatus, deriveAwarenessLevel, splitMultiline } = require("../context-fetcher");

describe("deriveClientStatus", () => {
  it("returns funded when funding_complete is true", () => {
    assert.equal(deriveClientStatus({ funding_complete: true }, false), "funded");
  });

  it("returns repair when Next Action Badge contains repair", () => {
    assert.equal(
      deriveClientStatus({ "Next Action Badge": "Needs Repair", funding_complete: false }, false),
      "repair"
    );
  });

  it("returns repair when latest_underwriteiq_outcome contains repair", () => {
    assert.equal(
      deriveClientStatus(
        { latest_underwriteiq_outcome: "credit_repair_required", funding_complete: false },
        false
      ),
      "repair"
    );
  });

  it("returns funding when outcome contains funding", () => {
    assert.equal(
      deriveClientStatus(
        { latest_underwriteiq_outcome: "FULL_FUNDING", funding_complete: false },
        false
      ),
      "funding"
    );
  });

  it("returns funding when outcome contains approved", () => {
    assert.equal(
      deriveClientStatus(
        { latest_underwriteiq_outcome: "approved_tier_1", funding_complete: false },
        false
      ),
      "funding"
    );
  });

  it("returns funding when hasFundingRounds is true", () => {
    assert.equal(deriveClientStatus({}, true), "funding");
  });

  it("returns lead when no signals present", () => {
    assert.equal(deriveClientStatus({}, false), "lead");
  });

  it("funded takes priority over repair badge", () => {
    assert.equal(
      deriveClientStatus({ "Next Action Badge": "Repair Now", funding_complete: true }, false),
      "funded"
    );
  });
});

describe("deriveAwarenessLevel", () => {
  it("L3 for funded", () => {
    assert.equal(deriveAwarenessLevel("funded", 720, 50000), "L3");
  });

  it("L3 for past", () => {
    assert.equal(deriveAwarenessLevel("past", null, null), "L3");
  });

  it("L2 for funding", () => {
    assert.equal(deriveAwarenessLevel("funding", 720, null), "L2");
  });

  it("L2 for repair", () => {
    assert.equal(deriveAwarenessLevel("repair", 620, null), "L2");
  });

  it("L1 when lead but has FICO", () => {
    assert.equal(deriveAwarenessLevel("lead", 700, null), "L1");
  });

  it("L1 when lead but has prequal", () => {
    assert.equal(deriveAwarenessLevel("lead", null, 75000), "L1");
  });

  it("L0 when lead with no FICO or prequal", () => {
    assert.equal(deriveAwarenessLevel("lead", null, null), "L0");
  });
});

describe("splitMultiline", () => {
  it("splits on newlines", () => {
    assert.deepEqual(splitMultiline("Fix A\nFix B\nFix C"), ["Fix A", "Fix B", "Fix C"]);
  });

  it("trims whitespace and removes empty lines", () => {
    assert.deepEqual(splitMultiline("  Fix A  \n\n  Fix B  \n"), ["Fix A", "Fix B"]);
  });

  it("returns empty array for null", () => {
    assert.deepEqual(splitMultiline(null), []);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(splitMultiline(""), []);
  });

  it("handles CRLF line endings", () => {
    assert.deepEqual(splitMultiline("Fix A\r\nFix B"), ["Fix A", "Fix B"]);
  });
});

// ---------------------------------------------------------------------------
// Auth unit tests
// ---------------------------------------------------------------------------

describe("validateContextFetcherAuth", () => {
  const { validateContextFetcherAuth } = require("../context-fetcher");

  const makeAuthReq = (headers = {}) => ({ headers });

  it("allows when CONTEXT_FETCHER_SECRET is not set", () => {
    delete process.env.CONTEXT_FETCHER_SECRET;
    const result = validateContextFetcherAuth(makeAuthReq({}));
    assert.equal(result.ok, true);
  });

  it("rejects when secret is set but Authorization header is missing", () => {
    process.env.CONTEXT_FETCHER_SECRET = "super-secret";
    const result = validateContextFetcherAuth(makeAuthReq({}));
    assert.equal(result.ok, false);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("rejects when Bearer token is wrong", () => {
    process.env.CONTEXT_FETCHER_SECRET = "super-secret";
    const result = validateContextFetcherAuth(makeAuthReq({ authorization: "Bearer wrong-token" }));
    assert.equal(result.ok, false);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("allows when Bearer token is correct", () => {
    process.env.CONTEXT_FETCHER_SECRET = "super-secret";
    const result = validateContextFetcherAuth(
      makeAuthReq({ authorization: "Bearer super-secret" })
    );
    assert.equal(result.ok, true);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("allows when x-context-fetcher-secret header is correct", () => {
    process.env.CONTEXT_FETCHER_SECRET = "super-secret";
    const result = validateContextFetcherAuth(
      makeAuthReq({ "x-context-fetcher-secret": "super-secret" })
    );
    assert.equal(result.ok, true);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("rejects when x-context-fetcher-secret header is wrong", () => {
    process.env.CONTEXT_FETCHER_SECRET = "super-secret";
    const result = validateContextFetcherAuth(
      makeAuthReq({ "x-context-fetcher-secret": "bad-secret" })
    );
    assert.equal(result.ok, false);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });
});

// ---------------------------------------------------------------------------
// Handler integration tests (Airtable + logger mocked via require.cache)
// ---------------------------------------------------------------------------

const CONTACT_ID = "ghl_test_001";

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

// Mock logger
const mockLogger = {
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {}
};

// ---------------------------------------------------------------------------
// Airtable mock state (mutated per test)
// ---------------------------------------------------------------------------
let mockFindResults = {}; // table → records[]
let mockFetchError = null;

// GHL mock state
let mockGHLContactResult = { ok: true, contact: { customFields: [] } };
let mockGHLContactThrows = false;

// Mock fetchWithTimeout
const mockFetchWithTimeout = async (url, _opts) => {
  if (mockFetchError) throw mockFetchError;

  // Parse table from URL
  // URL format: https://api.airtable.com/v0/{base}/{table}?filterByFormula=...
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.split("/");
  const tableEncoded = pathParts[pathParts.length - 1].split("?")[0];
  const table = decodeURIComponent(tableEncoded);

  const records = mockFindResults[table] || [];
  return {
    ok: true,
    status: 200,
    json: async () => ({ records }),
    text: async () => JSON.stringify({ records })
  };
};

const mockGetGHLContact = async _contactId => {
  if (mockGHLContactThrows) throw new Error("GHL network error");
  return mockGHLContactResult;
};

function loadHandler() {
  const modPath = require.resolve("../context-fetcher");
  const fetchPath = require.resolve("../fetch-utils");
  const logPath = require.resolve("../logger");
  const ghlPath = require.resolve("../ghl-contact-service");

  delete require.cache[modPath];
  delete require.cache[fetchPath];
  delete require.cache[logPath];
  delete require.cache[ghlPath];

  require.cache[fetchPath] = {
    id: fetchPath,
    filename: fetchPath,
    loaded: true,
    exports: { fetchWithTimeout: mockFetchWithTimeout }
  };
  require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: mockLogger
  };
  require.cache[ghlPath] = {
    id: ghlPath,
    filename: ghlPath,
    loaded: true,
    exports: { getGHLContact: mockGetGHLContact }
  };

  return require("../context-fetcher");
}

function makeClientRecord(fields = {}) {
  return {
    id: "recCLIENT001",
    fields: {
      ghl_contact_id: CONTACT_ID,
      "Client Name": "Jane Doe",
      email: "jane@example.com",
      phone: "+15550001234",
      Prequal: 75000,
      latest_underwriteiq_outcome: "FULL_FUNDING",
      latest_top_fixes: "Pay down revolving balances\nDispute old collections",
      "Next Action Badge": "Funding Review",
      funding_complete: false,
      "SNAPSHOTS 2": [],
      "FUNDING_ROUNDS 2": [],
      INQUIRY_LOG: [],
      PERSONAL_TRADELINES: [],
      BUSINESS_TRADELINES: [],
      ...fields
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context-fetcher handler", () => {
  beforeEach(() => {
    mockFindResults = {};
    mockFetchError = null;
    mockGHLContactResult = { ok: true, contact: { customFields: [] } };
    mockGHLContactThrows = false;
    // Set env vars
    process.env.AIRTABLE_API_KEY = "test_key";
    process.env.AIRTABLE_BASE_ID = "appXsq65yB9VuNup5";
  });

  // -------------------------------------------------------------------------
  // Auth handler tests
  // -------------------------------------------------------------------------

  it("returns 401 when secret is set and Authorization header is missing", async () => {
    process.env.CONTEXT_FETCHER_SECRET = "handler-secret";
    const handler = loadHandler();
    const res = makeRes();
    const req = { method: "POST", body: { contactId: CONTACT_ID }, headers: {} };
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /unauthorized/i);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("returns 401 when secret is set and token is wrong", async () => {
    process.env.CONTEXT_FETCHER_SECRET = "handler-secret";
    const handler = loadHandler();
    const res = makeRes();
    const req = {
      method: "POST",
      body: { contactId: CONTACT_ID },
      headers: { authorization: "Bearer wrong" }
    };
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("proceeds past auth when correct Bearer token is supplied (Airtable mock returns contact)", async () => {
    process.env.CONTEXT_FETCHER_SECRET = "handler-secret";
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    const handler = loadHandler();
    const res = makeRes();
    const req = {
      method: "POST",
      body: { contactId: CONTACT_ID },
      headers: { authorization: "Bearer handler-secret" }
    };
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    delete process.env.CONTEXT_FETCHER_SECRET;
  });

  it("allows request when CONTEXT_FETCHER_SECRET is not set (dev mode)", async () => {
    delete process.env.CONTEXT_FETCHER_SECRET;
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    const handler = loadHandler();
    const res = makeRes();
    // No auth header — should still proceed
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 200);
  });

  it("returns 405 for non-POST", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({}, "GET"), res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.body.ok, false);
  });

  it("returns 200 for OPTIONS (CORS preflight)", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({}, "OPTIONS"), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.ended, true);
    assert.equal(res._headers["Access-Control-Allow-Origin"], "*");
  });

  it("returns 400 when contactId is missing", async () => {
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({}), res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /contactId/);
  });

  it("returns 500 when Airtable is not configured", async () => {
    delete process.env.AIRTABLE_API_KEY;
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 500);
    assert.match(res.body.error, /not configured/);
  });

  it("returns 404 when contact is not found", async () => {
    mockFindResults["CLIENTS"] = [];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /not found/i);
  });

  it("returns 200 with chart when contact found", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.chart);
  });

  it("sets contact fields correctly", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    const { contact } = res.body.chart;
    assert.equal(contact.name, "Jane Doe");
    assert.equal(contact.email, "jane@example.com");
    assert.equal(contact.client_status, "funding");
    assert.equal(contact.awareness_level, "L2");
  });

  it("splits optimization_suggestions from latest_top_fixes", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    const { credit } = res.body.chart;
    assert.deepEqual(credit.optimization_suggestions, [
      "Pay down revolving balances",
      "Dispute old collections"
    ]);
    assert.equal(credit.optimization_suggestions_complete, false);
  });

  it("sets behavioral from request payload when provided (payload override wins)", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    const handler = loadHandler();
    const res = makeRes();
    const payloadBehavioral = {
      responsiveness: 80,
      engagement: 70,
      friction: 20,
      intent: 90,
      motivation_label: "speed",
      composite: 75,
      confidence: "high",
      scored: true
    };
    await handler(
      makeReq({
        contactId: CONTACT_ID,
        behavioral: payloadBehavioral
      }),
      res
    );
    // Payload is passed through as-is
    assert.deepEqual(res.body.chart.behavioral, payloadBehavioral);
  });

  it("sets behavioral (legacy shape, scored:false) when GHL has no values", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    // GHL returns empty customFields — no behavior_* fields present → legacy fallback
    mockGHLContactResult = { ok: true, contact: { customFields: [] } };
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.deepEqual(res.body.chart.behavioral, {
      responsiveness: null,
      friction_level: null,
      motivation_label: null,
      scored: false
    });
  });

  it("builds conversation log sorted by ts", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    mockFindResults["tblPL17FxHaZrCxt4"] = [
      {
        id: "recMSG2",
        fields: {
          contact_id: CONTACT_ID,
          body: "Second message",
          direction: "outbound",
          channel: "sms",
          timestamp: "2026-06-21T10:05:00Z"
        }
      },
      {
        id: "recMSG1",
        fields: {
          contact_id: CONTACT_ID,
          body: "First message",
          direction: "inbound",
          channel: "sms",
          timestamp: "2026-06-21T10:00:00Z"
        }
      }
    ];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    const msgs = res.body.chart.conversation;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].text, "First message");
    assert.equal(msgs[0].role, "contact");
    assert.equal(msgs[1].text, "Second message");
    assert.equal(msgs[1].role, "agent");
  });

  it("returns 500 on Airtable fetch error", async () => {
    mockFetchError = new Error("Network failure");
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.ok, false);
  });

  it("builds files list from report URL fields", async () => {
    mockFindResults["CLIENTS"] = [
      makeClientRecord({
        raw_report_url_latest: "https://s3.example.com/raw-latest.pdf",
        latest_raw_personal_report_url: "https://s3.example.com/personal.pdf",
        latest_raw_business_report_url: null
      })
    ];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    const locations = res.body.chart.files.map(f => f.location);
    assert.ok(locations.includes("https://s3.example.com/raw-latest.pdf"));
    assert.ok(locations.includes("https://s3.example.com/personal.pdf"));
    // null URL should not appear
    assert.ok(!locations.includes(null));
  });

  it("derives funded client_status when funding_complete is true", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord({ funding_complete: true })];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.body.chart.contact.client_status, "funded");
    assert.equal(res.body.chart.contact.awareness_level, "L3");
  });

  it("derives lead client_status for unknown new contact", async () => {
    mockFindResults["CLIENTS"] = [
      makeClientRecord({
        latest_underwriteiq_outcome: "",
        "Next Action Badge": "",
        Prequal: null,
        funding_complete: false
      })
    ];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.body.chart.contact.client_status, "lead");
    assert.equal(res.body.chart.contact.awareness_level, "L0");
  });

  // -------------------------------------------------------------------------
  // Behavioral score fallback tests
  // -------------------------------------------------------------------------

  it("uses behavioral from request payload and skips GHL read", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    const handler = loadHandler();
    const res = makeRes();
    const payloadBehavioral = {
      responsiveness: 90,
      engagement: 85,
      friction: 10,
      intent: 95,
      motivation_label: "growth",
      composite: 88,
      confidence: "high",
      scored: true
    };
    await handler(
      makeReq({ contactId: CONTACT_ID, behavioral: payloadBehavioral }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.chart.behavioral, payloadBehavioral);
  });

  // -------------------------------------------------------------------------
  // NEW: Behavior Scoring engine fields (new scorer path, scored: true)
  // -------------------------------------------------------------------------

  it("reads new behavior_* fields from GHL when scorer has run (scored: true)", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    mockGHLContactResult = {
      ok: true,
      contact: {
        customFields: [
          { fieldKey: "behavior_responsiveness", value: 78 },
          { fieldKey: "behavior_engagement", value: 65 },
          { fieldKey: "behavior_friction", value: 30 },
          { fieldKey: "behavior_intent", value: 88 },
          { fieldKey: "behavior_motivation_label", value: "speed" },
          { fieldKey: "behavior_composite", value: 72 },
          { fieldKey: "behavior_confidence", value: "high" }
        ]
      }
    };
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.chart.behavioral, {
      responsiveness: 78,
      engagement: 65,
      friction: 30,
      intent: 88,
      motivation_label: "speed",
      composite: 72,
      confidence: "high",
      scored: true
    });
  });

  it("scored flag is true when any single new behavior_* field is present", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    mockGHLContactResult = {
      ok: true,
      contact: {
        customFields: [
          { fieldKey: "behavior_composite", value: 55 }
          // only one new field present — still scored: true
        ]
      }
    };
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.chart.behavioral.scored, true);
    assert.equal(res.body.chart.behavioral.composite, 55);
  });

  // -------------------------------------------------------------------------
  // LEGACY FALLBACK: old GHL fields, scored: false
  // -------------------------------------------------------------------------

  it("falls back to legacy fields (scored: false) when no new behavior_* fields present", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    mockGHLContactResult = {
      ok: true,
      contact: {
        customFields: [
          { fieldKey: "customer_responsiveness", value: "medium" },
          { fieldKey: "customer_friction_level", value: "high" },
          { fieldKey: "primary_motivation", value: "credit_repair" }
        ]
      }
    };
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.chart.behavioral, {
      responsiveness: "medium",
      friction_level: "high",
      motivation_label: "credit_repair",
      scored: false
    });
  });

  it("legacy fallback returns null fields (scored: false) when legacy fields also absent", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    // No behavior_* AND no legacy fields → scored: false, all null
    mockGHLContactResult = { ok: true, contact: { customFields: [] } };
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.chart.behavioral, {
      responsiveness: null,
      friction_level: null,
      motivation_label: null,
      scored: false
    });
  });

  it("degrades behavioral to null when GHL read fails without throwing", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    mockGHLContactResult = { ok: false, error: "GHL API error: 401" };
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.chart.behavioral, null);
  });

  it("degrades behavioral to null when GHL read throws without failing request", async () => {
    mockFindResults["CLIENTS"] = [makeClientRecord()];
    mockGHLContactThrows = true;
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.chart.behavioral, null);
  });

  // -------------------------------------------------------------------------
  // optimization_suggestions: full findings path
  // -------------------------------------------------------------------------

  it("populates optimization_suggestions from latest_optimization_findings_full when present", async () => {
    const findings = [
      {
        code: "UTIL_CARD_OVER_10",
        plainEnglishProblem: "Your Chase card is at 80% utilization.",
        whatToDoNext: "Pay it down to $500 or less."
      },
      {
        code: "FUNDING_FIRST",
        plainEnglishProblem: "You qualify for funding.",
        whatToDoNext: "Do NOT open new accounts before applying."
      }
    ];
    mockFindResults["CLIENTS"] = [
      makeClientRecord({
        latest_optimization_findings_full: JSON.stringify(findings),
        latest_top_fixes: "This should NOT appear"
      })
    ];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    assert.equal(res.statusCode, 200);
    const { credit } = res.body.chart;
    assert.equal(credit.optimization_suggestions_complete, true);
    assert.equal(credit.optimization_suggestions.length, 2);
    assert.ok(credit.optimization_suggestions[0].includes("UTIL_CARD_OVER_10"));
    assert.ok(
      credit.optimization_suggestions[0].includes("Your Chase card is at 80% utilization.")
    );
    assert.ok(credit.optimization_suggestions[0].includes("Pay it down to $500 or less."));
    assert.ok(credit.optimization_suggestions[1].includes("FUNDING_FIRST"));
  });

  it("falls back to latest_top_fixes when latest_optimization_findings_full is absent", async () => {
    mockFindResults["CLIENTS"] = [
      makeClientRecord({
        latest_optimization_findings_full: undefined,
        latest_top_fixes: "Pay down balances\nDispute collections"
      })
    ];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    const { credit } = res.body.chart;
    assert.equal(credit.optimization_suggestions_complete, false);
    assert.deepEqual(credit.optimization_suggestions, ["Pay down balances", "Dispute collections"]);
  });

  it("falls back to latest_top_fixes when latest_optimization_findings_full is malformed JSON", async () => {
    mockFindResults["CLIENTS"] = [
      makeClientRecord({
        latest_optimization_findings_full: "not-valid-json{{",
        latest_top_fixes: "Fallback fix"
      })
    ];
    const handler = loadHandler();
    const res = makeRes();
    await handler(makeReq({ contactId: CONTACT_ID }), res);
    const { credit } = res.body.chart;
    assert.equal(credit.optimization_suggestions_complete, false);
    assert.deepEqual(credit.optimization_suggestions, ["Fallback fix"]);
  });
});
