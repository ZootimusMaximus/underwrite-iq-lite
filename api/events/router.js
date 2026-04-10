"use strict";
/* global AbortSignal */

// ============================================================================
// Event Router — Validates, deduplicates, logs, and dispatches events
//
// Receives a parsed event envelope from the entry point (index.js).
// 1. Validates the envelope shape against the permanent event contract.
// 2. Normalizes the contact payload (email, phone).
// 3. Checks idempotency — skips if this event was already processed.
// 4. Logs the event to the Airtable EVENT_LOG table.
// 5. Dispatches to the correct handler based on event_name.
// 6. Returns the handler result.
//
// See: FundHub Modular Event System Developer Handoff, sections 5 & 10.
// ============================================================================

const { checkIdempotency, markProcessed } = require("./utils/idempotency");
const { normalizeContact, validateEventPayload } = require("./utils/normalize");
const { logInfo, logWarn, logError } = require("../lite/logger");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical event names and their handler module paths */
const EVENT_HANDLERS = {
  "fundhub.entry.captured": "./handlers/entry-captured",
  "fundhub.deposit.paid": "./handlers/deposit-paid",
  "fundhub.analysis.requested": "./handlers/analysis-requested",
  "fundhub.analysis.completed": "./handlers/analysis-completed",
  "fundhub.booking.lane.decided": "./handlers/booking-lane-decided",
  "fundhub.call.booked": "./handlers/call-booked",
  "fundhub.decision.recorded": "./handlers/decision-recorded",
  "fundhub.sale.closed": "./handlers/sale-closed"
};

/** Required top-level envelope fields */
const REQUIRED_ENVELOPE_FIELDS = [
  "event_name",
  "event_version",
  "event_id",
  "idempotency_key",
  "occurred_at",
  "source_system"
];

// ---------------------------------------------------------------------------
// Airtable EVENT_LOG writer
// ---------------------------------------------------------------------------

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const TABLE_EVENT_LOG = process.env.AIRTABLE_TABLE_EVENT_LOG || "Event Log";

/**
 * Write an event record to the Airtable EVENT_LOG table.
 * Fire-and-forget — failures are logged but do not block processing.
 *
 * @param {object} envelope - Full event envelope
 * @param {string} status - "received" | "duplicate" | "dispatched" | "handler_error"
 * @param {string|null} handlerError - Error message if handler failed
 */
async function logEventToAirtable(envelope, status, handlerError = null) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    logWarn("EVENT_LOG skipped — Airtable not configured");
    return;
  }

  try {
    const fields = {
      event_id: envelope.event_id || "",
      event_name: envelope.event_name || "",
      event_version: envelope.event_version || 1,
      idempotency_key: envelope.idempotency_key || "",
      occurred_at: envelope.occurred_at || "",
      source_system: envelope.source_system || "",
      correlation_id: envelope.correlation_id || "",
      contact_email: envelope.contact?.email || "",
      contact_phone: envelope.contact?.phone || "",
      ghl_contact_id: envelope.contact?.ghl_contact_id || "",
      airtable_client_record_id: envelope.contact?.airtable_client_record_id || "",
      status,
      processed_at: new Date().toISOString(),
      entry_mode: envelope.adapter?.entry_mode || "",
      funnel_family: envelope.adapter?.funnel_family || "",
      handler_error: handlerError || ""
    };

    const url = `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_EVENT_LOG)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logWarn("EVENT_LOG write failed", { status: resp.status, body: text.slice(0, 200) });
    }
  } catch (err) {
    logWarn("EVENT_LOG write error", { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Envelope Validation
// ---------------------------------------------------------------------------

/**
 * Validate the event envelope structure.
 * @param {object} envelope
 * @returns {{ ok: boolean, error?: string, details?: object }}
 */
function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, error: "INVALID_ENVELOPE", message: "Event envelope must be an object" };
  }

  // Check required top-level fields
  const missing = REQUIRED_ENVELOPE_FIELDS.filter(f => {
    const val = envelope[f];
    return val === undefined || val === null || val === "";
  });

  if (missing.length > 0) {
    return {
      ok: false,
      error: "MISSING_FIELDS",
      message: `Missing required envelope fields: ${missing.join(", ")}`,
      details: { missing }
    };
  }

  // Validate event_name is a known canonical event
  if (!EVENT_HANDLERS[envelope.event_name]) {
    return {
      ok: false,
      error: "UNKNOWN_EVENT",
      message: `Unknown event_name: ${envelope.event_name}`,
      details: { event_name: envelope.event_name, known_events: Object.keys(EVENT_HANDLERS) }
    };
  }

  // Validate event_version is a positive integer
  if (!Number.isInteger(envelope.event_version) || envelope.event_version < 1) {
    return {
      ok: false,
      error: "INVALID_VERSION",
      message: "event_version must be a positive integer"
    };
  }

  // Validate occurred_at is a valid ISO date
  const ts = new Date(envelope.occurred_at);
  if (Number.isNaN(ts.getTime())) {
    return {
      ok: false,
      error: "INVALID_TIMESTAMP",
      message: "occurred_at must be a valid ISO 8601 timestamp"
    };
  }

  // Contact block is required but individual fields depend on event type
  if (!envelope.contact || typeof envelope.contact !== "object") {
    return {
      ok: false,
      error: "MISSING_CONTACT",
      message: "contact object is required"
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Handler Loader
// ---------------------------------------------------------------------------

/** Cache loaded handler modules to avoid repeated require() calls */
const handlerCache = {};

/**
 * Load a handler module for the given event name.
 * Returns null if the handler file doesn't exist yet (not built).
 *
 * @param {string} eventName
 * @returns {function|null}
 */
function loadHandler(eventName) {
  if (handlerCache[eventName]) return handlerCache[eventName];

  const modulePath = EVENT_HANDLERS[eventName];
  if (!modulePath) return null;

  try {
    const handlerModule = require(modulePath);
    // Handlers export either a function directly or { handle }
    const fn = typeof handlerModule === "function" ? handlerModule : handlerModule.handle;
    if (typeof fn !== "function") {
      logError(
        "Event handler invalid export",
        `Handler for ${eventName} must export a function or { handle }`,
        eventName
      );
      return null;
    }
    handlerCache[eventName] = fn;
    return fn;
  } catch (err) {
    if (err.code === "MODULE_NOT_FOUND") {
      logWarn(`Event handler not yet built: ${eventName}`, { path: modulePath });
      return null;
    }
    logError("Event handler load error", err, eventName);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main Router
// ---------------------------------------------------------------------------

/**
 * Route an event envelope through validation, idempotency, logging, and dispatch.
 *
 * @param {object} envelope - Full event envelope (already parsed from JSON)
 * @returns {Promise<{ ok: boolean, event_id?: string, event_name?: string, status?: string, error?: string }>}
 */
async function routeEvent(envelope) {
  // 1. Validate envelope structure
  const validation = validateEnvelope(envelope);
  if (!validation.ok) {
    return { ok: false, ...validation, status: 400 };
  }

  // 2. Normalize contact fields (email, phone)
  if (envelope.contact) {
    envelope.contact = normalizeContact(envelope.contact);
  }

  // 3. Validate event-specific required payload fields
  const payloadValidation = validateEventPayload(envelope.event_name, envelope.payload);
  if (!payloadValidation.ok) {
    return { ok: false, ...payloadValidation, status: 400 };
  }

  const { event_id, event_name, idempotency_key } = envelope;

  // 4. Idempotency check
  try {
    const alreadyProcessed = await checkIdempotency(idempotency_key);
    if (alreadyProcessed) {
      logInfo("Event duplicate — skipping", { event_id, event_name, idempotency_key });
      // Log duplicate to EVENT_LOG (fire-and-forget)
      logEventToAirtable(envelope, "duplicate").catch(() => {});
      return {
        ok: true,
        event_id,
        event_name,
        status: "duplicate",
        message: "Event already processed (idempotent skip)"
      };
    }
  } catch (err) {
    // Redis down — log warning but continue processing.
    // Better to risk a duplicate than to block all events.
    logWarn("Idempotency check failed — proceeding anyway", {
      event_id,
      error: err.message
    });
  }

  // 5. Log event as received (fire-and-forget)
  logEventToAirtable(envelope, "received").catch(() => {});

  // 6. Load handler
  const handler = loadHandler(event_name);
  if (!handler) {
    logWarn("No handler available for event", { event_name, event_id });
    return {
      ok: false,
      error: "HANDLER_NOT_AVAILABLE",
      message: `Handler for ${event_name} is not yet implemented`,
      event_id,
      event_name,
      status: 501
    };
  }

  // 7. Dispatch to handler
  try {
    logInfo("Dispatching event to handler", { event_name, event_id });
    const result = await handler(envelope);

    // Mark as processed in idempotency store after successful handling
    try {
      await markProcessed(idempotency_key, {
        event_id,
        event_name,
        processed_at: new Date().toISOString()
      });
    } catch (err) {
      logWarn("Failed to mark event as processed in idempotency store", {
        event_id,
        error: err.message
      });
    }

    // Log success (fire-and-forget)
    logEventToAirtable(envelope, "dispatched").catch(() => {});

    return {
      ok: true,
      event_id,
      event_name,
      status: "processed",
      result: result || {}
    };
  } catch (err) {
    logError("Event handler failed", err, `${event_name}:${event_id}`);

    // Log failure (fire-and-forget)
    logEventToAirtable(envelope, "handler_error", err.message).catch(() => {});

    return {
      ok: false,
      error: "HANDLER_ERROR",
      message: err.message || "Handler threw an unexpected error",
      event_id,
      event_name,
      status: 500
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  routeEvent,
  validateEnvelope,
  EVENT_HANDLERS,
  REQUIRED_ENVELOPE_FIELDS,
  // Exposed for testing
  logEventToAirtable,
  loadHandler
};
