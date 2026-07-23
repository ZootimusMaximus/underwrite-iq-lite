"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// ============================================================================
// Tests for getCF helper and SURVEY_BEHAVIOR_FIELDS integration in
// handleClientUpsert. All HTTP calls are intercepted via global.fetch mock.
// ============================================================================

const upsertPath = require.resolve("../handlers/client-upsert");
const logPath = require.resolve("../../lite/logger");
const normPath = require.resolve("../utils/normalize");
const fetchUtilsPath = require.resolve("../../lite/fetch-utils");

const mockLogger = {
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {}
};

// -----------------------------------------------------------------------
// getCF + SURVEY_BEHAVIOR_FIELDS — pure unit tests (no HTTP)
// -----------------------------------------------------------------------

describe("getCF helper", () => {
  let getCF;

  beforeEach(() => {
    delete require.cache[upsertPath];
    delete require.cache[logPath];
    delete require.cache[normPath];
    require.cache[logPath] = {
      id: logPath,
      filename: logPath,
      loaded: true,
      exports: mockLogger
    };
    ({ getCF } = require("../handlers/client-upsert"));
  });

  afterEach(() => {
    delete require.cache[upsertPath];
    delete require.cache[logPath];
    delete require.cache[normPath];
  });

  it("prefers ghlContact.customFields over contact property", () => {
    const ghlContact = {
      customFields: [{ key: "cf_svy_planned_use", field_value: "buy equipment" }]
    };
    const contact = { cf_svy_planned_use: "old value" };
    assert.equal(getCF(ghlContact, contact, "cf_svy_planned_use"), "buy equipment");
  });

  it("falls back to contact property when key absent from ghlContact.customFields", () => {
    const ghlContact = { customFields: [] };
    const contact = { primary_motivation: "speed" };
    assert.equal(getCF(ghlContact, contact, "primary_motivation"), "speed");
  });

  it("returns null when key is absent from both sources", () => {
    const ghlContact = { customFields: [] };
    const contact = {};
    assert.equal(getCF(ghlContact, contact, "cf_svy_your_why"), null);
  });

  it("returns null for empty string in ghlContact, also checks contact fallback", () => {
    const ghlContact = {
      customFields: [{ key: "cf_svy_has_negatives", field_value: "" }]
    };
    const contact = {};
    assert.equal(getCF(ghlContact, contact, "cf_svy_has_negatives"), null);
  });

  it("falls back to contact when ghlContact customField is empty string", () => {
    const ghlContact = {
      customFields: [{ key: "cf_svy_has_negatives", field_value: "" }]
    };
    const contact = { cf_svy_has_negatives: "yes" };
    assert.equal(getCF(ghlContact, contact, "cf_svy_has_negatives"), "yes");
  });

  it("returns null when contact property is empty string", () => {
    const ghlContact = { customFields: [] };
    const contact = { customer_responsiveness: "" };
    assert.equal(getCF(ghlContact, contact, "customer_responsiveness"), null);
  });

  it("handles null ghlContact gracefully", () => {
    const contact = { primary_motivation: "growth" };
    assert.equal(getCF(null, contact, "primary_motivation"), "growth");
  });

  it("handles undefined ghlContact.customFields gracefully", () => {
    const ghlContact = {};
    const contact = { customer_friction_level: "low" };
    assert.equal(getCF(ghlContact, contact, "customer_friction_level"), "low");
  });

  it("coerces numeric-like values to string", () => {
    const ghlContact = {
      customFields: [{ key: "cf_svy_self_reported_fico", field_value: 720 }]
    };
    assert.equal(getCF(ghlContact, {}, "cf_svy_self_reported_fico"), "720");
  });
});

describe("SURVEY_BEHAVIOR_FIELDS map", () => {
  let SURVEY_BEHAVIOR_FIELDS;

  beforeEach(() => {
    delete require.cache[upsertPath];
    delete require.cache[logPath];
    require.cache[logPath] = {
      id: logPath,
      filename: logPath,
      loaded: true,
      exports: mockLogger
    };
    ({ SURVEY_BEHAVIOR_FIELDS } = require("../handlers/client-upsert"));
  });

  afterEach(() => {
    delete require.cache[upsertPath];
    delete require.cache[logPath];
  });

  it("contains all 13 expected GHL source keys", () => {
    const keys = Object.keys(SURVEY_BEHAVIOR_FIELDS);
    const expected = [
      "cf_svy_funding_target_amount",
      "cf_svy_planned_use",
      "cf_svy_your_why",
      "cf_svy_self_reported_fico",
      "cf_svy_has_negatives",
      "cf_svy_annual_income_range",
      "cf_svy_income_verifiable",
      "cf_svy_money_change_now",
      "cf_svy_clarity_first",
      "cf_svy_what_matters_most",
      "customer_responsiveness",
      "customer_friction_level",
      "primary_motivation"
    ];
    for (const k of expected) {
      assert.ok(keys.includes(k), `Missing key: ${k}`);
    }
    assert.equal(keys.length, 13);
  });

  it("maps cf_svy_funding_target_amount to 'Survey: Target Amount' by default", () => {
    assert.equal(SURVEY_BEHAVIOR_FIELDS["cf_svy_funding_target_amount"], "Survey: Target Amount");
  });

  it("maps primary_motivation to 'Primary Motivation' by default", () => {
    assert.equal(SURVEY_BEHAVIOR_FIELDS["primary_motivation"], "Primary Motivation");
  });

  it("maps customer_responsiveness to 'Customer Responsiveness' by default", () => {
    assert.equal(SURVEY_BEHAVIOR_FIELDS["customer_responsiveness"], "Customer Responsiveness");
  });

  it("maps customer_friction_level to 'Customer Friction Level' by default", () => {
    assert.equal(SURVEY_BEHAVIOR_FIELDS["customer_friction_level"], "Customer Friction Level");
  });
});

// -----------------------------------------------------------------------
// Integration: handleClientUpsert writes survey/behavior fields to Airtable
// -----------------------------------------------------------------------

describe("handleClientUpsert — survey and behavior fields in Airtable payload", () => {
  let capturedAtFields;
  let handleClientUpsert;

  const ghlContactId = "ghl_test_123";
  const airtableRecordId = "recABC";

  // fetch mock intercepts GHL + Airtable HTTP calls
  const originalFetch = global.fetch;

  function setupFetchMock() {
    global.fetch = async (url, opts) => {
      // GHL contact lookup by ID
      if (url.includes(`/contacts/${ghlContactId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            contact: {
              id: ghlContactId,
              firstName: "Test",
              lastName: "User",
              email: "test@example.com",
              customFields: [
                { key: "cf_client_master_key", field_value: "cmk_existing_001" },
                { key: "cf_svy_funding_target_amount", field_value: "150000" },
                { key: "cf_svy_planned_use", field_value: "buy equipment" },
                { key: "cf_svy_your_why", field_value: "expand my business" },
                { key: "cf_svy_self_reported_fico", field_value: "720" },
                { key: "cf_svy_has_negatives", field_value: "no" },
                { key: "cf_svy_annual_income_range", field_value: "100k-150k" },
                { key: "cf_svy_income_verifiable", field_value: "yes" },
                { key: "cf_svy_money_change_now", field_value: "within 30 days" },
                { key: "cf_svy_clarity_first", field_value: "clarity" },
                { key: "cf_svy_what_matters_most", field_value: "speed" },
                { key: "customer_responsiveness", field_value: "high" },
                { key: "customer_friction_level", field_value: "low" },
                { key: "primary_motivation", field_value: "growth" }
              ]
            }
          }),
          text: async () => ""
        };
      }

      // Airtable search (find by ghl_contact_id)
      if (url.includes("api.airtable.com") && url.includes("filterByFormula")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            records: [{ id: airtableRecordId, fields: { ghl_contact_id: ghlContactId } }]
          }),
          text: async () => ""
        };
      }

      // Airtable PATCH (update)
      if (url.includes("api.airtable.com") && url.includes(airtableRecordId)) {
        const body = JSON.parse(opts?.body || "{}");
        capturedAtFields = body.fields;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: airtableRecordId, fields: body.fields }),
          text: async () => ""
        };
      }

      // GHL update (write-back of Airtable IDs) — return ok
      if (url.includes("/contacts/") && opts?.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ contact: { id: ghlContactId } }),
          text: async () => ""
        };
      }

      // Catch-all
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "{}"
      };
    };
  }

  beforeEach(() => {
    capturedAtFields = null;
    setupFetchMock();

    delete require.cache[upsertPath];
    delete require.cache[logPath];
    delete require.cache[normPath];
    delete require.cache[fetchUtilsPath];

    require.cache[logPath] = {
      id: logPath,
      filename: logPath,
      loaded: true,
      exports: mockLogger
    };

    process.env.AIRTABLE_API_KEY = "test_at_key";
    process.env.AIRTABLE_BASE_ID = "appTestBase";
    process.env.GHL_PRIVATE_API_KEY = "test_ghl_key";
    process.env.GHL_LOCATION_ID = "loc_test";

    ({ handleClientUpsert } = require("../handlers/client-upsert"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete require.cache[upsertPath];
    delete require.cache[logPath];
    delete require.cache[normPath];
    delete require.cache[fetchUtilsPath];
    delete process.env.AIRTABLE_API_KEY;
    delete process.env.AIRTABLE_BASE_ID;
    delete process.env.GHL_PRIVATE_API_KEY;
    delete process.env.GHL_LOCATION_ID;
  });

  it("includes all survey and behavior fields in the Airtable PATCH when GHL contact has them", async () => {
    const event = {
      event_id: "evt_survey_test_1",
      contact: { ghl_contact_id: ghlContactId, email: "test@example.com" }
    };

    const result = await handleClientUpsert(event);
    assert.ok(result.ok, `Expected ok:true, got: ${result.error || result.message}`);
    assert.ok(capturedAtFields, "Airtable PATCH was not called");

    assert.equal(capturedAtFields["Survey: Target Amount"], "150000");
    assert.equal(capturedAtFields["Survey: Planned Use"], "buy equipment");
    assert.equal(capturedAtFields["Survey: Your Why"], "expand my business");
    assert.equal(capturedAtFields["Survey: Self-Reported FICO"], "720");
    assert.equal(capturedAtFields["Survey: Has Negatives"], "no");
    assert.equal(capturedAtFields["Survey: Annual Income Range"], "100k-150k");
    assert.equal(capturedAtFields["Survey: Income Verifiable"], "yes");
    assert.equal(capturedAtFields["Survey: Money Change Now"], "within 30 days");
    assert.equal(capturedAtFields["Survey: Clarity First"], "clarity");
    assert.equal(capturedAtFields["Survey: What Matters Most"], "speed");
    assert.equal(capturedAtFields["Customer Responsiveness"], "high");
    assert.equal(capturedAtFields["Customer Friction Level"], "low");
    assert.equal(capturedAtFields["Primary Motivation"], "growth");
  });

  it("omits survey fields when the GHL contact has none", async () => {
    // Override fetch to return a contact with NO survey custom fields
    global.fetch = async (url, opts) => {
      if (url.includes(`/contacts/${ghlContactId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            contact: {
              id: ghlContactId,
              firstName: "Test",
              lastName: "User",
              email: "test@example.com",
              customFields: [{ key: "cf_client_master_key", field_value: "cmk_existing_001" }]
            }
          }),
          text: async () => ""
        };
      }
      if (url.includes("api.airtable.com") && url.includes("filterByFormula")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            records: [{ id: airtableRecordId, fields: {} }]
          }),
          text: async () => ""
        };
      }
      if (url.includes("api.airtable.com") && url.includes(airtableRecordId)) {
        const body = JSON.parse(opts?.body || "{}");
        capturedAtFields = body.fields;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: airtableRecordId }),
          text: async () => ""
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    };

    const event = {
      event_id: "evt_survey_test_2",
      contact: { ghl_contact_id: ghlContactId, email: "test@example.com" }
    };

    await handleClientUpsert(event);
    assert.ok(capturedAtFields, "Airtable PATCH was not called");

    // None of the survey/behavior columns should be present
    assert.equal(capturedAtFields["Survey: Target Amount"], undefined);
    assert.equal(capturedAtFields["Survey: Planned Use"], undefined);
    assert.equal(capturedAtFields["Primary Motivation"], undefined);
    assert.equal(capturedAtFields["Customer Responsiveness"], undefined);
  });

  it("omits individual fields with empty string values from GHL", async () => {
    global.fetch = async (url, opts) => {
      if (url.includes(`/contacts/${ghlContactId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            contact: {
              id: ghlContactId,
              firstName: "Test",
              lastName: "User",
              email: "test@example.com",
              customFields: [
                { key: "cf_client_master_key", field_value: "cmk_existing_001" },
                { key: "cf_svy_planned_use", field_value: "" }, // empty — should be omitted
                { key: "primary_motivation", field_value: "relief" } // non-empty — should be included
              ]
            }
          }),
          text: async () => ""
        };
      }
      if (url.includes("api.airtable.com") && url.includes("filterByFormula")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ records: [{ id: airtableRecordId, fields: {} }] }),
          text: async () => ""
        };
      }
      if (url.includes("api.airtable.com") && url.includes(airtableRecordId)) {
        const body = JSON.parse(opts?.body || "{}");
        capturedAtFields = body.fields;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: airtableRecordId }),
          text: async () => ""
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    };

    const event = {
      event_id: "evt_survey_test_3",
      contact: { ghl_contact_id: ghlContactId, email: "test@example.com" }
    };

    await handleClientUpsert(event);
    assert.ok(capturedAtFields, "Airtable PATCH was not called");

    assert.equal(
      capturedAtFields["Survey: Planned Use"],
      undefined,
      "empty string field should be omitted"
    );
    assert.equal(
      capturedAtFields["Primary Motivation"],
      "relief",
      "non-empty field should be present"
    );
  });

  it("falls back to contact event property when GHL contact doesn't have the key", async () => {
    // GHL contact has no survey fields; contact object on the event has some
    global.fetch = async (url, opts) => {
      if (url.includes(`/contacts/${ghlContactId}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            contact: {
              id: ghlContactId,
              firstName: "Test",
              lastName: "User",
              email: "test@example.com",
              customFields: [{ key: "cf_client_master_key", field_value: "cmk_existing_001" }]
            }
          }),
          text: async () => ""
        };
      }
      if (url.includes("api.airtable.com") && url.includes("filterByFormula")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ records: [{ id: airtableRecordId, fields: {} }] }),
          text: async () => ""
        };
      }
      if (url.includes("api.airtable.com") && url.includes(airtableRecordId)) {
        const body = JSON.parse(opts?.body || "{}");
        capturedAtFields = body.fields;
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: airtableRecordId }),
          text: async () => ""
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    };

    const event = {
      event_id: "evt_survey_test_4",
      contact: {
        ghl_contact_id: ghlContactId,
        email: "test@example.com",
        // Fallback values on the contact object
        primary_motivation: "certainty",
        customer_responsiveness: "medium"
      }
    };

    await handleClientUpsert(event);
    assert.ok(capturedAtFields, "Airtable PATCH was not called");

    assert.equal(capturedAtFields["Primary Motivation"], "certainty");
    assert.equal(capturedAtFields["Customer Responsiveness"], "medium");
  });

  it("does not clobber identity fields already set", async () => {
    const event = {
      event_id: "evt_survey_test_5",
      contact: { ghl_contact_id: ghlContactId, email: "test@example.com" }
    };

    await handleClientUpsert(event);
    assert.ok(capturedAtFields, "Airtable PATCH was not called");

    // Identity fields should still be present alongside survey fields
    assert.equal(capturedAtFields.ghl_contact_id, ghlContactId);
    assert.equal(capturedAtFields.email, "test@example.com");
    assert.ok(capturedAtFields.client_master_key, "client_master_key should be set");
  });
});
