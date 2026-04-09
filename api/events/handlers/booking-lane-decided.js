"use strict";

// ============================================================================
// Handler: fundhub.booking.lane.decided
//
// Fires after analysis completes. Determines which calendar/calendar type
// the lead should book — funding or repair. The sales call is always
// required regardless of lane.
//
// Required payload: booking_lane, reason
//
// Actions:
//   1. Upsert client
//   2. Set cf_booking_lane = "funding" | "repair"
//   3. Set cf_call_required = true (sales call always required per spec)
//   4. Set cf_last_canonical_event + cf_last_canonical_event_ts
//
// This event is typically emitted by the analysis-completed handler, but
// can also be sent directly by a manual trigger (e.g., rep override).
//
// Spec rule: "A sales call still happens. The funnel is pre-call
//   infrastructure, not a replacement for the call."
//
// See: FundHub Modular Event System Developer Handoff, sections 3 & 5.
// ============================================================================

const { logInfo, logWarn } = require("../../lite/logger");
const { upsertClient } = require("./client-upsert");
const { updateContactCustomFields } = require("../../lite/ghl-contact-service");

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} event - Full event envelope
 * @returns {Promise<{ ok: boolean, action: string, ghlContactId: string, booking_lane: string }>}
 */
async function handle(event) {
  const { contact, payload, adapter, event_id } = event;

  const { booking_lane, reason, recommendation, analysis_request_id } = payload;

  // Validate lane value
  if (booking_lane !== "funding" && booking_lane !== "repair") {
    throw new Error(`Invalid booking_lane "${booking_lane}" — must be "funding" or "repair"`);
  }

  logInfo("booking-lane-decided: processing", {
    event_id,
    booking_lane,
    reason,
    email: contact?.email
  });

  // ---- 1. Upsert client ----
  const identity = await upsertClient(contact, adapter);
  if (!identity.ok) {
    throw new Error(`client-upsert failed: ${identity.error}`);
  }

  const { ghlContactId, airtableClientRecordId, clientMasterKey } = identity;
  const now = new Date().toISOString();

  // ---- 2. Build GHL field writes ----
  const customFields = {
    cf_booking_lane: booking_lane,
    // Sales call is always required per spec section 3.
    // cf_precall_backend_active controls optional pre-call selling (feature flag).
    cf_call_required: "true",
    cf_last_canonical_event: "fundhub.booking.lane.decided",
    cf_last_canonical_event_ts: now
  };

  // Write reason for analytics/audit — useful if rep later overrides lane
  customFields.cf_booking_lane_reason = reason;

  // Pass through recommendation if present (set by analysis-completed handler)
  if (recommendation) {
    customFields.cf_analyzer_recommendation = recommendation;
  }

  if (analysis_request_id) {
    customFields.cf_analysis_request_id = analysis_request_id;
  }

  const updateResult = await updateContactCustomFields(ghlContactId, customFields);
  if (!updateResult.ok) {
    logWarn("booking-lane-decided: GHL field update failed", {
      ghlContactId,
      error: updateResult.error
    });
  }

  logInfo("booking-lane-decided: complete", {
    event_id,
    ghlContactId,
    booking_lane,
    reason
  });

  return {
    ok: true,
    action: "booking_lane_decided",
    ghlContactId,
    airtableClientRecordId,
    clientMasterKey,
    booking_lane,
    call_required: true,
    reason
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { handle };
