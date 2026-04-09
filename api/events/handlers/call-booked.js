"use strict";

// ============================================================================
// Handler: fundhub.call.booked
//
// Fires when a lead books a sales call on the calendar (GHL Calendly,
// or any future calendar system). The sales call is always required
// regardless of booking lane.
//
// Required payload: booking_id, appointment_start
// Optional payload: calendar_id, calendar_type, appointment_end, timezone
//
// Actions:
//   1. Upsert client
//   2. Set cf_call_outcome = booked
//   3. Set cf_last_progress_action = call_booked
//   4. Set cf_last_progress_timestamp = now
//   5. Set cf_last_canonical_event + cf_last_canonical_event_ts
//
// These fields mirror what GHL S-04 was updated to write (spec section 8).
// Writing them here ensures the backend event path stays in sync even if
// the GHL workflow fires independently.
//
// Note: cf_booking_id and cf_appointment_start are also stored so DPC-02
// has the data it needs to detect no-shows after the appointment ends.
//
// See: FundHub Modular Event System Developer Handoff, sections 5 & 8.
// ============================================================================

const { logInfo, logWarn } = require("../../lite/logger");
const { upsertClient } = require("./client-upsert");
const { updateContactCustomFields } = require("../../lite/ghl-contact-service");

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} event - Full event envelope
 * @returns {Promise<{ ok: boolean, action: string, ghlContactId: string }>}
 */
async function handle(event) {
  const { contact, payload, adapter, event_id } = event;

  const { booking_id, appointment_start, appointment_end, calendar_id, calendar_type, timezone } =
    payload;

  logInfo("call-booked: processing", {
    event_id,
    booking_id,
    appointment_start,
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
  // These fields align with spec section 8 S-04 requirements:
  // "Add cf_call_outcome = booked, cf_last_progress_action = call_booked,
  //  cf_last_progress_timestamp = now"
  const customFields = {
    cf_call_outcome: "booked",
    cf_last_progress_action: "call_booked",
    cf_last_progress_timestamp: now,
    cf_last_canonical_event: "fundhub.call.booked",
    cf_last_canonical_event_ts: now,
    cf_booking_id: booking_id
  };

  if (appointment_start) {
    customFields.cf_appointment_start = appointment_start;
  }

  if (appointment_end) {
    customFields.cf_appointment_end = appointment_end;
  }

  if (calendar_id) {
    customFields.cf_calendar_id = calendar_id;
  }

  if (calendar_type) {
    customFields.cf_calendar_type = calendar_type;
  }

  if (timezone) {
    customFields.cf_appointment_timezone = timezone;
  }

  const updateResult = await updateContactCustomFields(ghlContactId, customFields);
  if (!updateResult.ok) {
    logWarn("call-booked: GHL field update failed", {
      ghlContactId,
      error: updateResult.error
    });
  }

  logInfo("call-booked: complete", {
    event_id,
    ghlContactId,
    booking_id,
    appointment_start
  });

  return {
    ok: true,
    action: "call_booked",
    ghlContactId,
    airtableClientRecordId,
    clientMasterKey,
    booking_id,
    appointment_start,
    call_outcome: "booked"
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { handle };
