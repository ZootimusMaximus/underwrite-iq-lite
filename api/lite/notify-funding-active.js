"use strict";

/**
 * POST /api/lite/notify-funding-active
 *
 * Sends an SMS to a GHL contact informing them that the FundHub team is
 * actively working their file and they may receive verification calls from
 * lenders. Intended to be triggered by an Airtable automation when an
 * employee begins running a client's applications.
 *
 * Request body: { contactId: string, dedupeKey?: string }
 *   contactId  — GHL contact ID (strict alphanumeric allowlist)
 *   dedupeKey  — optional caller-provided idempotency key (logged; v1 does not
 *                enforce server-side dedup — see SKIP_IF_RECENTLY_SENT note below)
 *
 * Auth: Authorization: Bearer <CONTEXT_FETCHER_SECRET>
 *   If CONTEXT_FETCHER_SECRET is not set, auth is skipped (dev/local mode).
 *
 * v1 idempotency note:
 *   Full dedup (skipIfRecentlySent) is NOT implemented in v1. If you need to
 *   prevent double-texting within a time window, a future implementation could:
 *   1. Check Upstash Redis for a key like `funding-active-sms:<contactId>`
 *      with a short TTL (e.g. 24h) and return { ok:true, sent:false, skipped:true }
 *      when found.
 *   2. Set that key after a successful GHL send.
 *   For now, every call sends. Pass dedupeKey for logging/audit only.
 */

const { logInfo, logWarn, logError } = require("./logger");

// ---------------------------------------------------------------------------
// SMS template — overridable via env for easy copy tuning without redeploy
// ---------------------------------------------------------------------------

const DEFAULT_SMS_TEMPLATE =
  "Good news — our team is actively working on funding your file right now. " +
  "You may get verification calls or texts from lenders over the next few days; " +
  "that's expected and a good sign. Reply here if you have any questions.";

function getSmsTemplate() {
  return process.env.FUNDING_ACTIVE_SMS_TEMPLATE || DEFAULT_SMS_TEMPLATE;
}

// ---------------------------------------------------------------------------
// GHL config — mirrors ghl-contact-service.js conventions exactly
// ---------------------------------------------------------------------------

const DEFAULT_GHL_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

function getApiBase() {
  return process.env.GHL_API_BASE || DEFAULT_GHL_BASE;
}

function getApiKey() {
  return process.env.GHL_PRIVATE_API_KEY || process.env.GHL_API_KEY || null;
}

// ---------------------------------------------------------------------------
// Auth — same pattern as context-fetcher.js
// ---------------------------------------------------------------------------

function validateAuth(req) {
  const secret = process.env.CONTEXT_FETCHER_SECRET;

  if (!secret) {
    logWarn(
      "notify-funding-active: CONTEXT_FETCHER_SECRET is not set — running unauthenticated (dev mode)"
    );
    return { ok: true };
  }

  const bearerHeader = req.headers["authorization"] || "";
  const token = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7).trim() : null;

  if (token && token === secret) {
    return { ok: true };
  }

  return { ok: false };
}

// ---------------------------------------------------------------------------
// Core send function — injectable fetch for unit testing
// ---------------------------------------------------------------------------

/**
 * Send the "actively funding" SMS via GHL Conversations API.
 *
 * @param {string} contactId   - GHL contact ID (pre-validated by caller)
 * @param {object} [opts]      - Optional overrides
 * @param {string} [opts.message]   - SMS text (defaults to template)
 * @param {string} [opts.dedupeKey] - Caller idempotency key (logged only in v1)
 * @param {Function} [fetchImpl]    - Injected fetch (defaults to global fetch)
 * @returns {Promise<{ok:boolean, sent?:boolean, error?:string}>}
 */
async function sendFundingActiveSms(contactId, opts = {}, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const key = getApiKey();

  if (!key) {
    logWarn("notify-funding-active: GHL API key not configured");
    return { ok: false, error: "GHL API key not configured" };
  }

  const message = opts.message || getSmsTemplate();
  const base = getApiBase();
  const url = `${base}/conversations/messages`;

  const payload = {
    type: "SMS",
    contactId,
    message
  };

  logInfo("notify-funding-active: sending SMS", {
    contactId,
    dedupeKey: opts.dedupeKey || null,
    messageLength: message.length
  });

  try {
    const resp = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Version: API_VERSION
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const errMsg = `GHL API error: ${resp.status} ${text.substring(0, 200)}`;
      logError("notify-funding-active: GHL send failed", new Error(errMsg), {
        contactId,
        status: resp.status
      });
      return { ok: false, error: errMsg };
    }

    logInfo("notify-funding-active: SMS sent", { contactId });
    return { ok: true, sent: true };
  } catch (err) {
    logError("notify-funding-active: GHL send threw", err, { contactId });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Vercel serverless handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Auth
  const authResult = validateAuth(req);
  if (!authResult.ok) {
    logWarn("notify-funding-active: unauthorized request");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // Body validation
  const body = req.body;
  if (!body || !body.contactId) {
    return res.status(400).json({ ok: false, error: "contactId is required" });
  }

  const { contactId, dedupeKey } = body;

  // Strict allowlist — same regex as context-fetcher.js
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(contactId)) {
    return res.status(400).json({ ok: false, error: "Invalid contactId" });
  }

  logInfo("notify-funding-active: request received", { contactId, dedupeKey: dedupeKey || null });

  const result = await sendFundingActiveSms(contactId, { dedupeKey });

  if (!result.ok) {
    return res.status(502).json({ ok: false, error: result.error });
  }

  return res.status(200).json({ ok: true, sent: true });
};

// Export internals for testing
module.exports.sendFundingActiveSms = sendFundingActiveSms;
module.exports.validateAuth = validateAuth;
module.exports.getSmsTemplate = getSmsTemplate;
module.exports.DEFAULT_SMS_TEMPLATE = DEFAULT_SMS_TEMPLATE;
