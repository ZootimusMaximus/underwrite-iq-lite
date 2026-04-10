"use strict";
/* global AbortSignal */

// ============================================================================
// Handler: fundhub.entry.captured
//
// Fires when any funnel or entry path captures a lead. This is the start
// of a journey — it does not require analysis or a deposit to have happened.
//
// Required payload: entry_mode, offer_family
// Optional payload: funnel_version, offer_variant (from adapter block)
//
// Actions:
//   1. Upsert client (GHL + Airtable)
//   2. Set GHL funnel/entry attribution fields
//   3. Set Lifecycle Status = New Lead if new contact
//   4. Set cf_last_canonical_event + cf_last_canonical_event_ts
//
// See: FundHub Modular Event System Developer Handoff, sections 5 & 7.
// ============================================================================

const { logInfo, logWarn } = require("../../lite/logger");
const { upsertClient } = require("./client-upsert");
const { updateContactCustomFields } = require("../../lite/ghl-contact-service");

// ---------------------------------------------------------------------------
// GHL: Update lifecycle status
// ---------------------------------------------------------------------------

const GHL_API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

async function setLifecycleStatus(ghlContactId, status) {
  const key = process.env.GHL_PRIVATE_API_KEY || process.env.GHL_API_KEY;
  if (!key || !ghlContactId) return;

  try {
    const resp = await fetch(`${GHL_API_BASE}/contacts/${ghlContactId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Version: GHL_API_VERSION
      },
      body: JSON.stringify({ contact: { lifecycleStage: status } }),
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logWarn("entry-captured: lifecycle status update failed", {
        ghlContactId,
        status,
        httpStatus: resp.status,
        body: text.slice(0, 200)
      });
    }
  } catch (err) {
    logWarn("entry-captured: lifecycle status update error", { ghlContactId, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} event - Full event envelope
 * @returns {Promise<{ ok: boolean, action: string, ghlContactId: string, isNew: boolean }>}
 */
async function handle(event) {
  const { contact, payload, adapter, event_id, correlation_id } = event;

  // Required fields are validated by the router before this handler is called.
  // Destructure with confidence.
  const { entry_mode, offer_family } = payload;

  logInfo("entry-captured: processing", {
    event_id,
    entry_mode,
    offer_family,
    email: contact?.email
  });

  // ---- 1. Upsert client ----
  const identity = await upsertClient(contact, adapter);
  if (!identity.ok) {
    throw new Error(`client-upsert failed: ${identity.error}`);
  }

  const { ghlContactId, isNew } = identity;

  // ---- 2. Build GHL field writes ----
  // Attribution fields are write-once per the spec:
  // "Attribution fields must never be overwritten after first touch."
  // We only set them here on new contacts. For existing contacts these
  // are already stamped by S-02 (the GHL write-once attribution workflow).
  // The event fields (entry_mode, offer_family) come from the payload;
  // funnel metadata comes from the adapter block (analytics/troubleshoot only).
  const now = new Date().toISOString();

  const customFields = {
    cf_last_canonical_event: "fundhub.entry.captured",
    cf_last_canonical_event_ts: now,
    cf_entry_mode: entry_mode,
    cf_offer_family: offer_family
  };

  // Adapter fields are for analytics — write them but they are not business logic
  if (adapter) {
    if (adapter.funnel_family) customFields.cf_funnel_family = adapter.funnel_family;
    if (adapter.funnel_version) customFields.cf_funnel_version = adapter.funnel_version;
    if (adapter.offer_variant) customFields.cf_offer_variant = adapter.offer_variant;
  }

  // Set event contract version if present
  if (event.event_version) {
    customFields.cf_event_contract_version = String(event.event_version);
  }

  if (correlation_id) {
    customFields.cf_correlation_id = correlation_id;
  }

  const updateResult = await updateContactCustomFields(ghlContactId, customFields);
  if (!updateResult.ok) {
    logWarn("entry-captured: GHL custom field update failed", {
      ghlContactId,
      error: updateResult.error
    });
  }

  // ---- 3. Set Lifecycle Status = New Lead for new contacts ----
  if (isNew) {
    await setLifecycleStatus(ghlContactId, "lead");
    logInfo("entry-captured: set lifecycle = lead", { ghlContactId });
  }

  logInfo("entry-captured: complete", {
    event_id,
    ghlContactId,
    isNew,
    entry_mode,
    offer_family
  });

  return {
    ok: true,
    action: "entry_captured",
    ghlContactId,
    airtableClientRecordId: identity.airtableClientRecordId,
    clientMasterKey: identity.clientMasterKey,
    isNew,
    entry_mode,
    offer_family
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { handle };
