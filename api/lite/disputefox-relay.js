"use strict";

/**
 * POST /api/lite/disputefox-relay
 *
 * Universal webhook relay for DisputeFox events → GHL.
 *
 * Default: Routes directly to GHL webhook (no Zapier needed).
 * Optional: Set DISPUTEFOX_RELAY_MODE=zapier + ZAPIER_WEBHOOK_URL to
 *           route through Zapier instead.
 *
 * Replaces 6 Zapier zaps (DF-01 through DF-06):
 *   DF-01: New Client Added → GHL Repair Intake/Link
 *   DF-02: Client Updated → GHL Repair Client Sync
 *   DF-03: New Task Added → GHL Client Portal Task
 *   DF-04: Task Updated → GHL Task Status Sync
 *   DF-05: New Lead Added → GHL Repair Lead Created
 *   DF-06: Lead Updated → GHL Lead Sync
 *
 * Config (env vars):
 *   DISPUTEFOX_RELAY_MODE  = "direct" (default) | "zapier"
 *   DISPUTEFOX_API_KEY     = optional auth for inbound requests
 *   ZAPIER_WEBHOOK_URL     = Zapier catch hook URL (only if mode=zapier)
 *
 * GHL receiver: R-WH-01 — DisputeFox Event Intake + Round Router
 */

const { logInfo, logWarn, logError } = require("./logger");

// ---------------------------------------------------------------------------
// Destination config
// ---------------------------------------------------------------------------

// Original GHL R-WH-01 stub (no action steps — kept for reference)
// const GHL_WEBHOOK_URL_LEGACY =
//   "https://services.leadconnectorhq.com/hooks/ORh91GeY4acceSASSnLR/webhook-trigger/193227ed-46ff-4cab-be7f-0d482e3571e4";

// Code-based R-WH-01 replacement — handles contact lookup, field writes, pipeline routing
const GHL_WEBHOOK_URL =
  process.env.DISPUTEFOX_INTAKE_URL ||
  "https://underwrite-iq-lite.vercel.app/api/lite/disputefox-intake";

function getDestination() {
  const mode = (process.env.DISPUTEFOX_RELAY_MODE || "direct").toLowerCase();
  if (mode === "zapier" && process.env.ZAPIER_WEBHOOK_URL) {
    return { mode: "zapier", url: process.env.ZAPIER_WEBHOOK_URL, label: "Zapier" };
  }
  return { mode: "direct", url: GHL_WEBHOOK_URL, label: "GHL R-WH-01" };
}

// ---------------------------------------------------------------------------
// Event mapping — maps DisputeFox events to the original Zapier zap names
// ---------------------------------------------------------------------------

const EVENT_MAP = {
  client_added: { zap: "DF-01", ghl_event: "client_added" },
  new_client_added: { zap: "DF-01", ghl_event: "client_added" },
  client_updated: { zap: "DF-02", ghl_event: "client_updated" },
  task_added: { zap: "DF-03", ghl_event: "task_added" },
  new_task_added: { zap: "DF-03", ghl_event: "task_added" },
  task_updated: { zap: "DF-04", ghl_event: "task_updated" },
  lead_added: { zap: "DF-05", ghl_event: "lead_added" },
  new_lead_added: { zap: "DF-05", ghl_event: "lead_added" },
  lead_updated: { zap: "DF-06", ghl_event: "lead_updated" },
  disputefox_event: { zap: "DF-XX", ghl_event: "disputefox_event" }
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  // CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Optional auth
  const foxApiKey = process.env.DISPUTEFOX_API_KEY;
  if (foxApiKey) {
    const authHeader = req.headers["authorization"] || "";
    const provided = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : req.headers["x-api-key"] || "";
    if (provided !== foxApiKey) {
      logWarn("DisputeFox relay: unauthorized request");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  const body = req.body;
  if (!body) {
    return res.status(400).json({ ok: false, error: "Request body is required" });
  }

  const rawEvent = body.df_event || body.event || body.trigger || "unknown";
  const mapped = EVENT_MAP[rawEvent] || { zap: "DF-XX", ghl_event: rawEvent };
  const dest = getDestination();

  logInfo("DisputeFox relay received", {
    event: rawEvent,
    mapped_zap: mapped.zap,
    mode: dest.mode,
    email: body.email || body.df_email || ""
  });

  // Build payload — pass through all DisputeFox fields + add routing metadata
  const payload = {
    ...body,
    source: "disputefox",
    df_event: mapped.ghl_event,
    df_original_event: rawEvent,
    df_zap_equivalent: mapped.zap,
    relay_mode: dest.mode,
    relay_timestamp: new Date().toISOString(),
    relay_source: "underwriteiq-disputefox-relay"
  };

  try {
    const headers = { "Content-Type": "application/json" };
    // Pass shared secret to intake endpoint (direct mode only — don't leak to Zapier)
    if (dest.mode === "direct" && process.env.DISPUTEFOX_INTAKE_SECRET) {
      headers["X-Intake-Secret"] = process.env.DISPUTEFOX_INTAKE_SECRET;
    }

    const resp = await fetch(dest.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logError(`DisputeFox relay: ${dest.label} failed`, {
        status: resp.status,
        body: text.substring(0, 200),
        mode: dest.mode
      });
      return res.status(502).json({
        ok: false,
        error: `${dest.label} webhook failed`,
        status: resp.status,
        mode: dest.mode
      });
    }

    logInfo(`DisputeFox relay: forwarded to ${dest.label}`, {
      event: rawEvent,
      zap: mapped.zap,
      mode: dest.mode,
      status: resp.status
    });

    return res.status(200).json({
      ok: true,
      event: rawEvent,
      mapped_zap: mapped.zap,
      forwarded_to: dest.label,
      mode: dest.mode,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logError("DisputeFox relay: fetch error", { error: err.message, mode: dest.mode });
    return res.status(500).json({
      ok: false,
      error: "Internal server error",
      message: err.message
    });
  }
};
