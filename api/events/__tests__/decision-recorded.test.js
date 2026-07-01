"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Regression for the bug where decision-recorded read identity.ghl_contact_id
// (snake_case) but upsertClient returns camelCase ghlContactId. Result: every
// decision for a contact resolved by email/phone (no ghl_contact_id on the
// event) fell through to NO_GHL_CONTACT_ID and wrote nothing to GHL.

const handlerPath = require.resolve("../handlers/decision-recorded");
const upsertPath = require.resolve("../handlers/client-upsert");
const ghlPath = require.resolve("../../lite/ghl-contact-service");

let upsertReturn;
let capturedWrite;
let capturedTags;

function loadHandler() {
  delete require.cache[handlerPath];
  delete require.cache[upsertPath];
  delete require.cache[ghlPath];
  require.cache[upsertPath] = {
    id: upsertPath,
    filename: upsertPath,
    loaded: true,
    exports: { upsertClient: async () => upsertReturn }
  };
  require.cache[ghlPath] = {
    id: ghlPath,
    filename: ghlPath,
    loaded: true,
    exports: {
      updateContactCustomFields: async (contactId, fields) => {
        capturedWrite = { contactId, fields };
        return { ok: true };
      },
      addContactTags: async (contactId, tags) => {
        capturedTags = { contactId, tags };
        return { ok: true };
      }
    }
  };
  return require("../handlers/decision-recorded").handle;
}

describe("decision-recorded handler — ghlContactId resolution", () => {
  beforeEach(() => {
    capturedWrite = null;
    capturedTags = null;
    // upsertClient returns camelCase ghlContactId (its real contract).
    upsertReturn = { ok: true, ghlContactId: "ghl_abc", airtableClientRecordId: "rec1" };
  });
  afterEach(() => {
    delete require.cache[handlerPath];
    delete require.cache[upsertPath];
    delete require.cache[ghlPath];
  });

  it("writes the decision when upsertClient resolves a camelCase ghlContactId (no ghl_contact_id on event)", async () => {
    const handle = loadHandler();
    const result = await handle({
      contact: { email: "x@y.com" }, // NO ghl_contact_id on the event
      payload: { decision_status: "funded" },
      adapter: {},
      event_id: "evt1"
    });

    assert.equal(result.ok, true, "should not fail with NO_GHL_CONTACT_ID");
    assert.equal(result.ghl_contact_id, "ghl_abc");
    assert.ok(capturedWrite, "GHL field write should have happened");
    assert.equal(capturedWrite.contactId, "ghl_abc");
    assert.equal(capturedWrite.fields.cf_decision_status, "funded");
    // Lifecycle (2026-07-01): set the client:funding tag (HX-02 writes the status),
    // and do NOT direct-write lifecycle_status for funded/repair (would fight HX-02).
    assert.equal(capturedWrite.fields.lifecycle_status, undefined);
    assert.ok(capturedTags, "client tag should have been set");
    assert.deepEqual(capturedTags.tags, ["client:funding"]);
  });

  it("still returns NO_GHL_CONTACT_ID when neither source has an id", async () => {
    upsertReturn = { ok: true, ghlContactId: null };
    const handle = loadHandler();
    const result = await handle({
      contact: { email: "x@y.com" },
      payload: { decision_status: "funded" },
      adapter: {},
      event_id: "evt2"
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "NO_GHL_CONTACT_ID");
  });
});
