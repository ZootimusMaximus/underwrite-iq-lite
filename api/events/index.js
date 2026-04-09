"use strict";

// ============================================================================
// POST /api/events — FundHub Modular Event System Entry Point
//
// Vercel serverless function that receives all event envelope POSTs.
// Handles auth, body parsing, and delegates to the event router.
//
// Auth: Bearer token via Authorization header.
//   - Accepts API_SECRET (global) or EVENT_ROUTER_TOKEN (event-specific).
//   - At least one must be configured for auth to be enforced.
//
// See: FundHub Modular Event System Developer Handoff, sections 5 & 10.
// ============================================================================

const { routeEvent } = require("./router");
const { logInfo, logWarn, logError } = require("../lite/logger");

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * Validate the bearer token from the Authorization header.
 * Accepts either the global API_SECRET or the event-specific EVENT_ROUTER_TOKEN.
 * If neither env var is set, auth is skipped (development mode).
 *
 * @param {string|undefined} authHeader - Raw Authorization header value
 * @returns {{ ok: boolean, error?: string }}
 */
function validateAuth(authHeader) {
  const globalSecret = process.env.API_SECRET;
  const eventToken = process.env.EVENT_ROUTER_TOKEN;

  // If neither secret is configured, skip auth (log warning once)
  if (!globalSecret && !eventToken) {
    logWarn("Event router auth not configured — API_SECRET and EVENT_ROUTER_TOKEN both missing");
    return { ok: true };
  }

  if (!authHeader) {
    return { ok: false, error: "Missing Authorization header" };
  }

  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  if (!token) {
    return { ok: false, error: "Authorization header must use Bearer scheme" };
  }

  const valid = (globalSecret && token === globalSecret) || (eventToken && token === eventToken);

  if (!valid) {
    return { ok: false, error: "Invalid token" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  // ----- CORS preflight -----
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Event-Token");
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  // ----- Method check -----
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  // ----- Auth check -----
  const authResult = validateAuth(req.headers["authorization"]);
  if (!authResult.ok) {
    logWarn("Event router auth failed", { error: authResult.error });
    return res.status(401).json({ ok: false, error: "UNAUTHORIZED", message: authResult.error });
  }

  // ----- Parse body -----
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (err) {
    logWarn("Event router received unparseable body", { error: err.message });
    return res
      .status(400)
      .json({ ok: false, error: "INVALID_JSON", message: "Request body must be valid JSON" });
  }

  if (!body || typeof body !== "object") {
    return res
      .status(400)
      .json({ ok: false, error: "EMPTY_BODY", message: "Request body is required" });
  }

  // ----- Route event -----
  try {
    logInfo("Event received", {
      event_name: body.event_name,
      event_id: body.event_id,
      source_system: body.source_system
    });

    const result = await routeEvent(body);

    const statusCode = result.ok ? 200 : result.status || 400;
    return res.status(statusCode).json(result);
  } catch (err) {
    logError("Event router unhandled error", err, body.event_name || "unknown");
    return res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred while processing the event"
    });
  }
};
