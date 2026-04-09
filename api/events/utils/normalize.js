"use strict";

// ============================================================================
// Normalize — Payload normalization and validation for event envelopes
//
// Normalizes contact fields (email, phone) into canonical formats and
// validates that each event type has its required minimum payload fields.
//
// Required minimums per event come from the spec's Canonical Events table
// (section 5 of the Developer Handoff).
//
// See: FundHub Modular Event System Developer Handoff, section 5.
// ============================================================================

const { logWarn } = require("../../lite/logger");

// ---------------------------------------------------------------------------
// Contact Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an email address: lowercase, trim whitespace.
 * Returns null if the input is empty or not a string.
 *
 * @param {string} email
 * @returns {string|null}
 */
function normalizeEmail(email) {
  if (!email || typeof email !== "string") return null;
  const cleaned = email.trim().toLowerCase();
  return cleaned || null;
}

/**
 * Normalize a phone number: strip non-digit characters, ensure +1 prefix.
 * Returns null if the result has fewer than 10 digits.
 *
 * Handles:
 *   - (555) 555-0123 → +15555550123
 *   - 15555550123    → +15555550123
 *   - +15555550123   → +15555550123
 *   - 5555550123     → +15555550123
 *
 * @param {string} phone
 * @returns {string|null}
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== "string") return null;

  const digits = phone.replace(/\D/g, "");
  if (!digits || digits.length < 10) return null;

  // If 11 digits starting with 1, use as-is
  if (digits.length === 11 && digits.startsWith("1")) {
    return "+" + digits;
  }

  // If exactly 10 digits, prepend +1
  if (digits.length === 10) {
    return "+1" + digits;
  }

  // If already has country code (11+ digits starting with 1)
  if (digits.length >= 11 && digits.startsWith("1")) {
    return "+" + digits;
  }

  // Fallback: prepend +1 if 10 digits after stripping leading 1
  logWarn("Unusual phone number length", { original: phone, digits: digits.length });
  return "+" + digits;
}

/**
 * Normalize the contact block of an event envelope in-place.
 * Returns the normalized contact object.
 *
 * @param {object} contact
 * @returns {object} The same contact object, mutated with normalized values
 */
function normalizeContact(contact) {
  if (!contact || typeof contact !== "object") return contact;

  if (contact.email) {
    contact.email = normalizeEmail(contact.email) || contact.email;
  }

  if (contact.phone) {
    contact.phone = normalizePhone(contact.phone) || contact.phone;
  }

  return contact;
}

// ---------------------------------------------------------------------------
// Event Payload Validation
// ---------------------------------------------------------------------------

/**
 * Required minimum payload fields per canonical event.
 * Each entry maps event_name → array of required field names in the payload object.
 *
 * From the spec:
 *   fundhub.entry.captured       → entry_mode, offer_family
 *   fundhub.deposit.paid         → transaction_id, gross_amount, credit_amount
 *   fundhub.analysis.requested   → analysis_request_id, method
 *   fundhub.analysis.completed   → recommendation, letters_ready
 *   fundhub.booking.lane.decided → booking_lane, reason
 *   fundhub.call.booked          → booking_id, appointment_start
 *   fundhub.decision.recorded    → decision_status
 *   fundhub.sale.closed          → service_selected, contract_value, deposit_credit_applied
 */
const REQUIRED_PAYLOAD_FIELDS = {
  "fundhub.entry.captured": ["entry_mode", "offer_family"],
  "fundhub.deposit.paid": ["transaction_id", "gross_amount", "credit_amount"],
  "fundhub.analysis.requested": ["analysis_request_id", "method"],
  "fundhub.analysis.completed": ["recommendation", "letters_ready"],
  "fundhub.booking.lane.decided": ["booking_lane", "reason"],
  "fundhub.call.booked": ["booking_id", "appointment_start"],
  "fundhub.decision.recorded": ["decision_status"],
  "fundhub.sale.closed": ["service_selected", "contract_value", "deposit_credit_applied"]
};

/**
 * Validate that the event payload contains all required fields for its event type.
 *
 * @param {string} eventName - Canonical event name
 * @param {object} payload - The payload object from the event envelope
 * @returns {{ ok: boolean, error?: string, message?: string, details?: object }}
 */
function validateEventPayload(eventName, payload) {
  const requiredFields = REQUIRED_PAYLOAD_FIELDS[eventName];

  // If we don't know the required fields for this event, skip validation
  // (unknown events are caught by envelope validation in router.js)
  if (!requiredFields) {
    return { ok: true };
  }

  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      error: "MISSING_PAYLOAD",
      message: `Event ${eventName} requires a payload object`,
      details: { required: requiredFields }
    };
  }

  const missing = requiredFields.filter(field => {
    const val = payload[field];
    return val === undefined || val === null || val === "";
  });

  if (missing.length > 0) {
    return {
      ok: false,
      error: "MISSING_PAYLOAD_FIELDS",
      message: `Event ${eventName} is missing required payload fields: ${missing.join(", ")}`,
      details: { event_name: eventName, missing, required: requiredFields }
    };
  }

  return { ok: true };
}

/**
 * Validate that at least one contact identifier is present.
 * Events need at least one of: ghl_contact_id, email, or phone.
 *
 * @param {object} contact
 * @returns {{ ok: boolean, error?: string }}
 */
function validateContactIdentity(contact) {
  if (!contact || typeof contact !== "object") {
    return { ok: false, error: "MISSING_CONTACT", message: "contact object is required" };
  }

  const hasId = !!contact.ghl_contact_id;
  const hasEmail = !!contact.email;
  const hasPhone = !!contact.phone;

  if (!hasId && !hasEmail && !hasPhone) {
    return {
      ok: false,
      error: "NO_CONTACT_IDENTITY",
      message: "contact must include at least one of: ghl_contact_id, email, phone"
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  normalizeEmail,
  normalizePhone,
  normalizeContact,
  validateEventPayload,
  validateContactIdentity,
  REQUIRED_PAYLOAD_FIELDS
};
