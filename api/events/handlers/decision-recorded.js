"use strict";

/**
 * decision-recorded.js — Handler for fundhub.decision.recorded
 *
 * Fired after the sales call when a rep or customer records a decision.
 * Drives close, reschedule, or close-file flows.
 *
 * Required payload: decision_status
 * Optional: decision_source, decision_notes, reschedule_date
 */

const { logInfo, logWarn } = require("../../lite/logger");
const { updateContactCustomFields } = require("../../lite/ghl-contact-service");

// Import client upsert — try both export shapes
let upsertClient;
try {
  const mod = require("./client-upsert");
  upsertClient = mod.upsertClient || mod.handleClientUpsert;
} catch (_e) {
  upsertClient = null;
}

/**
 * Valid decision statuses and their downstream effects
 */
const DECISION_EFFECTS = {
  funded: { cf_decision_status: "funded", cf_lifecycle_status: "Funded Client", tag: "decision:funded" },
  repair_purchased: { cf_decision_status: "repair_purchased", cf_lifecycle_status: "Repair Client", tag: "decision:repair" },
  reschedule: { cf_decision_status: "reschedule", tag: "decision:reschedule" },
  no_show: { cf_decision_status: "no_show", tag: "decision:no_show" },
  declined: { cf_decision_status: "declined", tag: "decision:declined" },
  close_file: { cf_decision_status: "close_file", cf_lifecycle_status: "Closed", tag: "decision:closed" },
};

async function handle(event) {
  const { contact, payload, adapter } = event;
  const {
    decision_status,
    decision_source,
    decision_notes,
    reschedule_date,
  } = payload || {};

  // Ensure client exists
  let identity = null;
  if (upsertClient) {
    identity = await upsertClient(contact, adapter);
    if (!identity?.ok) {
      return { ok: false, error: "CLIENT_UPSERT_FAILED", detail: identity?.error };
    }
  }

  const ghlContactId = identity?.ghl_contact_id || contact.ghl_contact_id;
  if (!ghlContactId) {
    return { ok: false, error: "NO_GHL_CONTACT_ID" };
  }

  const effect = DECISION_EFFECTS[decision_status];
  if (!effect) {
    logWarn("decision-recorded: unknown decision_status", { decision_status });
    return { ok: false, error: "UNKNOWN_DECISION_STATUS", decision_status };
  }

  // Write decision fields to GHL
  const fields = {
    cf_decision_status: effect.cf_decision_status,
    cf_decision_source: decision_source || "sales_call",
    cf_decision_timestamp: new Date().toISOString(),
    cf_last_canonical_event: "fundhub.decision.recorded",
    cf_last_canonical_event_ts: new Date().toISOString(),
    cf_last_progress_action: `decision_${decision_status}`,
    cf_last_progress_timestamp: new Date().toISOString(),
  };

  if (effect.cf_lifecycle_status) {
    fields.lifecycle_status = effect.cf_lifecycle_status;
  }

  if (decision_notes) {
    fields.cf_decision_notes = decision_notes;
  }

  if (decision_status === "reschedule" && reschedule_date) {
    fields.cf_reschedule_date = reschedule_date;
  }

  try {
    await updateContactCustomFields(ghlContactId, fields);
  } catch (err) {
    logWarn("decision-recorded: GHL field write failed", { error: err.message, ghlContactId });
  }

  logInfo("decision-recorded: processed", {
    ghlContactId,
    decision_status,
    decision_source: decision_source || "sales_call",
  });

  return {
    ok: true,
    action: `decision_${decision_status}`,
    ghl_contact_id: ghlContactId,
    effect: effect.cf_decision_status,
  };
}

module.exports = { handle };
