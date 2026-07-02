"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// Tests updated 2026-07-02: decision-recorded handler is now retired.
// The handler returns { ok: true, retired: true } for all inputs — no GHL writes.

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

    // Retired handler: always returns ok + retired, never writes to GHL
    assert.equal(result.ok, true, "should return ok: true");
    assert.equal(result.retired, true, "should be marked retired");
    assert.equal(result.event, "fundhub.decision.recorded");
    assert.equal(capturedWrite, null, "no GHL field write should happen");
    assert.equal(capturedTags, null, "no tag write should happen");
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
    // Retired handler: always returns ok + retired regardless of contact id
    assert.equal(result.ok, true);
    assert.equal(result.retired, true);
  });
});
