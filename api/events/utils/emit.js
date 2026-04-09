"use strict";

// ============================================================================
// Emit — Event emitter utility for internal use
//
// Provides a helper to emit events from within handlers or other system
// components. Builds the standard event envelope per the permanent contract,
// generates event_id and idempotency_key, and dispatches the event either
// by calling the router directly (in-process) or by POSTing to self.
//
// Usage from a handler:
//   const { emitEvent } = require("../utils/emit");
//   await emitEvent({
//     event_name: "fundhub.analysis.completed",
//     source_system: "underwrite_iq_lite",
//     contact: { email: "john@example.com", phone: "+15555550123" },
//     payload: { recommendation: "FULL_STACK_APPROVAL", letters_ready: true },
//     correlation_id: "journey_01JXYZ789",
//     adapter: { entry_mode: "slo_deposit", funnel_family: "slo" }
//   });
//
// See: FundHub Modular Event System Developer Handoff, section 5.
// ============================================================================

const crypto = require("crypto");
const { logInfo, logWarn, logError } = require("../../lite/logger");

// ---------------------------------------------------------------------------
// Event ID Generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique event ID with the evt_ prefix.
 * Uses a timestamp-based approach for rough ordering + random suffix for uniqueness.
 *
 * Format: evt_{timestamp_base36}_{random_hex}
 * Example: evt_m2k5x9q0_a3f7b2c1d9e4
 *
 * This is simpler than ULID (no extra dependency) but still provides:
 *   - Rough chronological ordering from the timestamp prefix
 *   - Collision resistance from 48 bits of randomness
 *   - Easy visual identification via the evt_ prefix
 *
 * @returns {string}
 */
function generateEventId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString("hex");
  return `evt_${ts}_${rand}`;
}

/**
 * Generate a stable idempotency key from the event name and an entity identifier.
 *
 * The key must be deterministic so that retries produce the same key.
 * Format: {event_short_name}:{entityId}
 *
 * Examples:
 *   - "analysis.completed:ANL_123"
 *   - "deposit.paid:TXN_456"
 *   - "entry.captured:john@example.com"
 *
 * @param {string} eventName - Full canonical event name (e.g. "fundhub.analysis.completed")
 * @param {string} entityId - Stable entity identifier (analysis ID, transaction ID, email, etc.)
 * @returns {string}
 */
function generateIdempotencyKey(eventName, entityId) {
  // Strip the "fundhub." prefix for brevity
  const shortName = eventName.startsWith("fundhub.") ? eventName.slice(8) : eventName;
  return `${shortName}:${entityId}`;
}

// ---------------------------------------------------------------------------
// Envelope Builder
// ---------------------------------------------------------------------------

/**
 * Build a complete event envelope from partial inputs.
 * Fills in event_id, idempotency_key, occurred_at, and event_version if not provided.
 *
 * @param {object} options
 * @param {string} options.event_name - Required canonical event name
 * @param {string} options.source_system - Required source system identifier
 * @param {object} options.contact - Required contact block
 * @param {object} options.payload - Required event payload
 * @param {string} [options.event_id] - Optional (auto-generated if omitted)
 * @param {string} [options.idempotency_key] - Optional (auto-generated from event_name + entity_id)
 * @param {string} [options.entity_id] - Used to generate idempotency_key if not provided
 * @param {number} [options.event_version] - Defaults to 1
 * @param {string} [options.occurred_at] - Defaults to now
 * @param {string} [options.correlation_id] - Optional journey correlation ID
 * @param {object} [options.adapter] - Optional adapter metadata
 * @returns {object} Complete event envelope
 */
function buildEnvelope(options) {
  const {
    event_name,
    source_system,
    contact,
    payload,
    event_id,
    idempotency_key,
    entity_id,
    event_version,
    occurred_at,
    correlation_id,
    adapter
  } = options;

  if (!event_name) throw new Error("event_name is required to build an event envelope");
  if (!source_system) throw new Error("source_system is required to build an event envelope");

  // Derive idempotency key if not explicitly provided
  const resolvedEntityId =
    entity_id ||
    contact?.ghl_contact_id ||
    contact?.email ||
    contact?.phone ||
    crypto.randomBytes(8).toString("hex");

  const envelope = {
    event_name,
    event_version: event_version || 1,
    event_id: event_id || generateEventId(),
    idempotency_key: idempotency_key || generateIdempotencyKey(event_name, resolvedEntityId),
    occurred_at: occurred_at || new Date().toISOString(),
    source_system,
    correlation_id: correlation_id || null,
    contact: contact || {},
    payload: payload || {}
  };

  if (adapter && typeof adapter === "object") {
    envelope.adapter = adapter;
  }

  return envelope;
}

// ---------------------------------------------------------------------------
// Emit (in-process dispatch)
// ---------------------------------------------------------------------------

/**
 * Emit an event by calling the router directly (in-process).
 * This is the preferred method when emitting from within a handler or system component,
 * as it avoids the overhead of an HTTP round-trip.
 *
 * @param {object} options - Same options as buildEnvelope
 * @returns {Promise<{ ok: boolean, event_id: string, event_name: string, [key: string]: any }>}
 */
async function emitEvent(options) {
  const envelope = buildEnvelope(options);

  logInfo("Emitting event (in-process)", {
    event_name: envelope.event_name,
    event_id: envelope.event_id,
    source_system: envelope.source_system
  });

  try {
    // Lazy-require router to avoid circular dependency at module load time.
    // The router requires handlers, and handlers may require emit.
    const { routeEvent } = require("../router");
    const result = await routeEvent(envelope);
    return result;
  } catch (err) {
    logError("emitEvent failed", err, envelope.event_name);
    return {
      ok: false,
      error: "EMIT_FAILED",
      message: err.message,
      event_id: envelope.event_id,
      event_name: envelope.event_name
    };
  }
}

// ---------------------------------------------------------------------------
// Emit (HTTP POST to self)
// ---------------------------------------------------------------------------

/**
 * Emit an event by POSTing to the /api/events endpoint.
 * Use this when you need fire-and-forget semantics or when the emit should
 * be treated as a fully independent request (e.g., from switchboard.js or
 * external adapters).
 *
 * @param {object} options - Same options as buildEnvelope
 * @param {object} [httpOptions] - Optional HTTP overrides
 * @param {string} [httpOptions.baseUrl] - Override the target URL (defaults to self via VERCEL_URL)
 * @param {string} [httpOptions.token] - Bearer token (defaults to API_SECRET or EVENT_ROUTER_TOKEN)
 * @param {number} [httpOptions.timeoutMs] - Fetch timeout in ms (default 15000)
 * @returns {Promise<{ ok: boolean, event_id: string, event_name: string, [key: string]: any }>}
 */
async function emitEventHTTP(options, httpOptions = {}) {
  const envelope = buildEnvelope(options);

  const baseUrl =
    httpOptions.baseUrl ||
    (process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.EVENT_ROUTER_URL || "http://localhost:3000");

  const url = `${baseUrl}/api/events`;
  const token = httpOptions.token || process.env.API_SECRET || process.env.EVENT_ROUTER_TOKEN;
  const timeoutMs = httpOptions.timeoutMs || 15000;

  logInfo("Emitting event (HTTP)", {
    event_name: envelope.event_name,
    event_id: envelope.event_id,
    url
  });

  try {
    const headers = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(timeoutMs)
    });

    const body = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      logWarn("emitEventHTTP received error response", {
        event_id: envelope.event_id,
        status: resp.status,
        body
      });
      return {
        ok: false,
        error: body.error || "HTTP_ERROR",
        message: body.message || `HTTP ${resp.status}`,
        event_id: envelope.event_id,
        event_name: envelope.event_name,
        http_status: resp.status
      };
    }

    return {
      ok: true,
      ...body,
      event_id: envelope.event_id,
      event_name: envelope.event_name
    };
  } catch (err) {
    logError("emitEventHTTP failed", err, envelope.event_name);
    return {
      ok: false,
      error: "EMIT_HTTP_FAILED",
      message: err.message,
      event_id: envelope.event_id,
      event_name: envelope.event_name
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  generateEventId,
  generateIdempotencyKey,
  buildEnvelope,
  emitEvent,
  emitEventHTTP
};
