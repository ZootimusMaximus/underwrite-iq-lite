"use strict";

/**
 * POST /api/lite/conversation-sync
 *
 * Incremental GHL → Airtable conversation message sync.
 *
 * Auth: same shared secret as context-fetcher.
 *   Authorization: Bearer <CONTEXT_FETCHER_SECRET>
 *   OR x-context-fetcher-secret: <CONTEXT_FETCHER_SECRET>
 *
 * Mode 1 — single contact:
 *   { contactId: "ghl_contact_id" }
 *   Fetches all conversations for that contact, upserts net-new messages.
 *
 * Mode 2 — sweep:
 *   { sweep: true, since?: "ISO-8601" }
 *   Iterates recent conversations (optionally filtered by `since`) and
 *   upserts net-new messages. Designed for cron / nightly catch-up.
 *
 * Both modes are idempotent — dedupe is on message_id.
 */

const { logInfo, logWarn, logError } = require("./logger");
const {
  getConversations,
  getContactConversations,
  syncConversation
} = require("./conversation-archive");

const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "";

// ---------------------------------------------------------------------------
// Auth (mirrors context-fetcher pattern)
// ---------------------------------------------------------------------------

function validateAuth(req) {
  const secret = process.env.CONTEXT_FETCHER_SECRET;

  if (!secret) {
    logWarn(
      "conversation-sync: CONTEXT_FETCHER_SECRET is not set — running unauthenticated (dev mode)"
    );
    return { ok: true };
  }

  const bearerHeader = req.headers["authorization"] || "";
  const token = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7).trim() : null;
  const headerSecret = req.headers["x-context-fetcher-secret"] || null;

  if ((token && token === secret) || (headerSecret && headerSecret === secret)) {
    return { ok: true };
  }

  return { ok: false };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-context-fetcher-secret"
    );
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const authResult = validateAuth(req);
  if (!authResult.ok) {
    logWarn("conversation-sync: unauthorized request");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  if (!body || typeof body !== "object") {
    return res.status(400).json({ ok: false, error: "Request body required" });
  }

  if (!GHL_LOCATION_ID) {
    logError("conversation-sync: GHL_LOCATION_ID is not configured");
    return res.status(500).json({ ok: false, error: "GHL_LOCATION_ID not configured" });
  }

  const { contactId, sweep, since } = body;

  // Validate: must be one of the two modes
  if (!contactId && !sweep) {
    return res.status(400).json({ ok: false, error: "Body must include contactId or sweep:true" });
  }

  // Strict allowlist on contactId (single-contact mode) — GHL ids are
  // alphanumeric. Blocks injection into the downstream Airtable formulas.
  if (contactId && !/^[A-Za-z0-9_-]{1,64}$/.test(contactId)) {
    return res.status(400).json({ ok: false, error: "Invalid contactId" });
  }

  // Use native fetch (available in Node 18+). In tests, req._fetchFn can
  // override to allow mocking without patching globals.
  const fetchFn = req._fetchFn || fetch;

  const stats = { inserted: 0, skipped: 0, errors: 0, conversations: 0 };

  try {
    if (contactId) {
      // ── Mode 1: single contact ──────────────────────────────────────────
      logInfo("conversation-sync: single-contact mode", { contactId });

      let conversations;
      try {
        conversations = await getContactConversations(fetchFn, contactId, GHL_LOCATION_ID);
      } catch (e) {
        logError("conversation-sync: failed to fetch contact conversations", {
          contactId,
          error: e.message
        });
        return res.status(502).json({ ok: false, error: "Failed to fetch conversations from GHL" });
      }

      for (const conv of conversations) {
        await syncConversation({ fetchFn, conv, stats });
        stats.conversations++;
      }
    } else {
      // ── Mode 2: sweep ───────────────────────────────────────────────────
      logInfo("conversation-sync: sweep mode", { since: since || "all" });

      let conversations;
      try {
        conversations = await getConversations(fetchFn, GHL_LOCATION_ID, since || null);
      } catch (e) {
        logError("conversation-sync: failed to fetch conversations", { error: e.message });
        return res.status(502).json({ ok: false, error: "Failed to fetch conversations from GHL" });
      }

      for (const conv of conversations) {
        await syncConversation({ fetchFn, conv, stats });
        stats.conversations++;
      }
    }

    logInfo("conversation-sync: complete", stats);
    return res.status(200).json({ ok: true, stats });
  } catch (err) {
    logError("conversation-sync: unhandled error", { error: err.message });
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
};

// Export for testing
module.exports.validateAuth = validateAuth;
