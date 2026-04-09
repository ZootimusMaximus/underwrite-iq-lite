"use strict";

// ============================================================================
// Handler: fundhub.analysis.completed
//
// Fires when UnderwriteIQ Lite finishes analysis and has a recommendation.
// This is the analyzer authority event. Before this event, no sales logic
// should run (enforced by GHL DPC-01 checking cf_analyzer_recommendation).
//
// Required payload: recommendation, letters_ready
// Optional payload: analysis_request_id, outcome_tier, score, utilization,
//                   negatives, inquiries, letter_urls
//
// Actions:
//   1. Upsert client
//   2. Set cf_analyzer_recommendation, letters_ready, analyzer_status = complete
//   3. Set cf_last_canonical_event + cf_last_canonical_event_ts
//   4. Emit fundhub.booking.lane.decided based on recommendation
//      (funding lane = CONDITIONAL_APPROVAL or higher;
//       repair lane = REPAIR or MANUAL_REVIEW)
//
// Spec rule: No sales, persuasion, or decision flow may run before
//   cf_analyzer_recommendation exists.
//
// See: FundHub Modular Event System Developer Handoff, sections 5 & 10.
// ============================================================================

const { logInfo, logWarn } = require("../../lite/logger");
const { upsertClient } = require("./client-upsert");
const { updateContactCustomFields } = require("../../lite/ghl-contact-service");
const { emitEvent } = require("../utils/emit");

// ---------------------------------------------------------------------------
// Booking lane resolution
//
// Maps analyzer recommendation to a booking lane.
// Outcomes from the 6-tier ladder: FRAUD_HOLD, MANUAL_REVIEW, REPAIR_ONLY,
//   FUNDING_PLUS_REPAIR, FULL_FUNDING, PREMIUM_STACK
// ---------------------------------------------------------------------------

const FUNDING_OUTCOMES = new Set([
  "FUNDING_PLUS_REPAIR",
  "FULL_FUNDING",
  "PREMIUM_STACK",
  // Legacy names (backward compat)
  "CONDITIONAL_APPROVAL",
  "FULL_STACK_APPROVAL",
  "fundable",
  "FUNDABLE"
]);

const REPAIR_OUTCOMES = new Set([
  "REPAIR_ONLY",
  "MANUAL_REVIEW",
  "FRAUD_HOLD",
  // Legacy names
  "REPAIR",
  "repair",
  "not_fundable",
  "NOT_FUNDABLE"
]);

function resolveBookingLane(recommendation) {
  if (FUNDING_OUTCOMES.has(recommendation)) return "funding";
  if (REPAIR_OUTCOMES.has(recommendation)) return "repair";
  // Unknown recommendation — default to repair (conservative)
  logWarn("analysis-completed: unknown recommendation, defaulting to repair lane", {
    recommendation
  });
  return "repair";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} event - Full event envelope
 * @returns {Promise<{ ok: boolean, action: string, ghlContactId: string, booking_lane: string }>}
 */
async function handle(event) {
  const { contact, payload, adapter, event_id, correlation_id } = event;

  const {
    recommendation,
    letters_ready,
    analysis_request_id,
    outcome_tier,
    score,
    utilization,
    negatives,
    inquiries,
    letter_urls
  } = payload;

  logInfo("analysis-completed: processing", {
    event_id,
    recommendation,
    letters_ready,
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
    cf_analyzer_recommendation: recommendation,
    letters_ready: String(letters_ready === true || letters_ready === "true"),
    analyzer_status: "complete",
    cf_last_canonical_event: "fundhub.analysis.completed",
    cf_last_canonical_event_ts: now
  };

  if (analysis_request_id) customFields.cf_analysis_request_id = analysis_request_id;
  if (outcome_tier) customFields.cf_outcome_tier = outcome_tier;
  if (score !== undefined) customFields.credit_score = String(score);
  if (utilization !== undefined) customFields.cf_credit_utilization = String(utilization);
  if (negatives !== undefined) customFields.cf_negative_count = String(negatives);
  if (inquiries !== undefined) customFields.cf_inquiry_count = String(inquiries);

  // If letter URLs were passed in the event payload, write them out now.
  // This handles the case where switchboard emits this event instead of
  // calling updateLetterUrls directly.
  if (letter_urls && typeof letter_urls === "object") {
    for (const [key, value] of Object.entries(letter_urls)) {
      if (value) customFields[key] = String(value);
    }
  }

  const updateResult = await updateContactCustomFields(ghlContactId, customFields);
  if (!updateResult.ok) {
    logWarn("analysis-completed: GHL field update failed", {
      ghlContactId,
      error: updateResult.error
    });
  }

  // ---- 3. Resolve booking lane and emit downstream event ----
  const bookingLane = resolveBookingLane(recommendation);
  const laneReason = `analyzer_recommendation:${recommendation}`;

  const emitResult = await emitEvent({
    event_name: "fundhub.booking.lane.decided",
    source_system: "analysis_completed_handler",
    correlation_id: correlation_id || null,
    entity_id: ghlContactId,
    contact: {
      ghl_contact_id: ghlContactId,
      airtable_client_record_id: airtableClientRecordId,
      email: contact.email,
      phone: contact.phone
    },
    payload: {
      booking_lane: bookingLane,
      reason: laneReason,
      recommendation,
      analysis_request_id: analysis_request_id || ""
    },
    adapter: adapter || undefined
  });

  if (!emitResult.ok && emitResult.status !== "duplicate") {
    logWarn("analysis-completed: booking.lane.decided emit failed", {
      ghlContactId,
      error: emitResult.error,
      booking_lane: bookingLane
    });
    // Not fatal — the booking lane can be triggered manually if needed
  } else {
    logInfo("analysis-completed: booking.lane.decided emitted", {
      ghlContactId,
      booking_lane: bookingLane,
      emit_event_id: emitResult.event_id
    });
  }

  logInfo("analysis-completed: complete", {
    event_id,
    ghlContactId,
    recommendation,
    booking_lane: bookingLane
  });

  return {
    ok: true,
    action: "analysis_completed",
    ghlContactId,
    airtableClientRecordId,
    clientMasterKey,
    recommendation,
    letters_ready: letters_ready === true || letters_ready === "true",
    booking_lane: bookingLane,
    lane_event_id: emitResult.event_id || null
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { handle };
