"use strict";

/**
 * POST /api/lite/disputefox-intake
 *
 * DisputeFox Event Intake + Round Router.
 * Code replacement for GHL R-WH-01 workflow stub.
 *
 * Receives normalized DisputeFox events (from the relay or directly),
 * looks up the GHL contact, writes df_* custom fields, and routes
 * client events to the appropriate Repair + Legal pipeline stage.
 *
 * Config (env vars):
 *   GHL_PRIVATE_API_KEY  — GHL PIT token (required)
 *   GHL_LOCATION_ID      — GHL location (required)
 *   GHL_API_BASE         — defaults to https://services.leadconnectorhq.com
 *   DISPUTEFOX_INTAKE_SECRET — optional shared secret for auth
 */

const { logInfo, logWarn, logError } = require("./logger");
const { findContactByEmail, updateContactCustomFields } = require("./ghl-contact-service");

// ---------------------------------------------------------------------------
// GHL Pipeline + Stage IDs (Repair + Legal)
// ---------------------------------------------------------------------------

const REPAIR_PIPELINE_ID = "4gY3ptHL0Idi6H0cxU9W";

const REPAIR_STAGES = {
  R1: "0d6a2248-dbd7-4ed5-b8ba-14fcf8b8419f", // Repair Intake
  R2: "da4e1ad1-f31f-4964-93e6-604055116ef2", // Round 1 Sent
  R3: "33b60c1b-e5ae-49f9-9a04-84b6fa99f055", // Round 2 Sent
  R4: "bf68ddf7-6907-4d81-ad42-5186eff2016f", // Round 3 Sent
  R5: "dc9dd3a4-5be9-4b8a-8076-d396c3f622ca", // Round 4 Sent
  R6: "ab607c7c-12fe-4ab4-95ba-d2eafdc127e8", // Round 5 Sent
  R7: "bd7a3955-6c6a-463a-b04f-f0e82b2e0b5f", // Round 6 Sent
  R8: "78816fe7-6a80-4663-a947-07d0f547c64b", // Legal Review
  R9: "580d27e9-fdfb-4384-bfa4-eacbea37685a", // Legal Action Active
  R10: "cfa20041-769d-474b-b51e-9401396c61de", // Legal Resolved
  R11: "4d7da083-e2f5-4f24-8420-5512b409688f", // Repair Complete
  R12: "0683dca1-5618-4c4a-b3b3-ae6f7776ac5e", // Upgrade Offer
  R13: "48c7a9c5-0dd2-4c22-9cad-3a4b0355781c" // Upgraded to Funding
};

// ---------------------------------------------------------------------------
// DisputeFox status → Repair stage mapping
// PLACEHOLDER: Fill in once we capture real df_status_id values.
// Keys = df_status_id from DisputeFox, values = stage key (e.g. "R2")
// ---------------------------------------------------------------------------

const STATUS_TO_STAGE = {
  // Example (uncomment + replace when real values known):
  // "1": "R1",   // New client → Repair Intake
  // "2": "R2",   // Round 1 dispatched
  // "3": "R3",   // Round 2 dispatched
};

// ---------------------------------------------------------------------------
// GHL API helpers
// ---------------------------------------------------------------------------

const DEFAULT_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

function ghlHeaders() {
  const key = process.env.GHL_PRIVATE_API_KEY;
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Version: API_VERSION
  };
}

function getLocationId() {
  return process.env.GHL_LOCATION_ID || null;
}

function getApiBase() {
  return process.env.GHL_API_BASE || DEFAULT_BASE;
}

/**
 * Search for a GHL contact by phone number (fallback when email lookup fails).
 */
async function findContactByPhone(phone) {
  if (!phone) return null;
  const key = process.env.GHL_PRIVATE_API_KEY;
  const locationId = getLocationId();
  if (!key || !locationId) return null;

  const base = getApiBase();
  const url = `${base}/contacts/?locationId=${locationId}&query=${encodeURIComponent(phone)}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Version: API_VERSION }
    });
    if (!resp.ok) return null;
    const result = await resp.json();
    const contacts = result.contacts || [];
    // Normalize phone for comparison (strip non-digits)
    const norm = phone.replace(/\D/g, "");
    return contacts.find(c => c.phone?.replace(/\D/g, "") === norm) || null;
  } catch (err) {
    logWarn("GHL phone lookup failed", { phone, error: err.message });
    return null;
  }
}

/**
 * Find the most recent opportunity for a contact in the Repair pipeline.
 */
async function findRepairOpportunity(contactId) {
  const key = process.env.GHL_PRIVATE_API_KEY;
  if (!key) return null;

  const base = getApiBase();
  const url = `${base}/opportunities/search?location_id=${getLocationId()}&contact_id=${contactId}&pipeline_id=${REPAIR_PIPELINE_ID}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Version: API_VERSION }
    });
    if (!resp.ok) return null;
    const result = await resp.json();
    const opps = result.opportunities || [];
    // Return most recent
    return opps.length > 0 ? opps[0] : null;
  } catch (err) {
    logWarn("GHL opportunity lookup failed", { contactId, error: err.message });
    return null;
  }
}

/**
 * Update an opportunity's pipeline stage.
 */
async function updateOpportunityStage(opportunityId, stageId) {
  const key = process.env.GHL_PRIVATE_API_KEY;
  if (!key) return { ok: false, error: "No API key" };

  const base = getApiBase();
  const url = `${base}/opportunities/${opportunityId}`;

  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: ghlHeaders(),
      body: JSON.stringify({ pipelineStageId: stageId })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logError("GHL opportunity stage update failed", {
        status: resp.status,
        body: text.substring(0, 200)
      });
      return { ok: false, error: `Stage update failed: ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    logError("GHL opportunity stage update exception", { error: err.message });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  // CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Intake-Secret");
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  // Optional auth
  const secret = process.env.DISPUTEFOX_INTAKE_SECRET;
  if (secret) {
    const provided = req.headers["x-intake-secret"] || "";
    if (provided !== secret) {
      logWarn("DisputeFox intake: unauthorized request");
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  // Validate config
  if (!process.env.GHL_PRIVATE_API_KEY) {
    logError("DisputeFox intake: GHL_PRIVATE_API_KEY not configured");
    return res.status(500).json({ ok: false, error: "GHL API key not configured" });
  }

  const body = req.body;
  if (!body) {
    return res.status(400).json({ ok: false, error: "Request body is required" });
  }

  const event = body.df_event || body.event || "unknown";
  const email = body.email || body.df_email || "";
  const phone = body.phone || body.df_phone || "";

  // Log the full incoming payload for debugging / status discovery
  logInfo("DisputeFox intake received", {
    event,
    email,
    phone: phone ? phone.slice(-4) : "",
    df_status_id: body.df_status_id || null,
    df_folder_id: body.df_folder_id || null,
    df_workflow_id: body.df_workflow_id || null,
    raw_keys: Object.keys(body).join(",")
  });

  // -------------------------------------------------------------------------
  // Step 1: Find GHL contact (email first, phone fallback)
  // -------------------------------------------------------------------------
  let contact = null;
  if (email) {
    contact = await findContactByEmail(email);
  }
  if (!contact && phone) {
    contact = await findContactByPhone(phone);
  }

  if (!contact) {
    logWarn("DisputeFox intake: no GHL contact found", { email, phone: phone.slice(-4) });
    return res.status(200).json({
      ok: true,
      action: "skipped",
      reason: "no_contact_found",
      event,
      email,
      timestamp: new Date().toISOString()
    });
  }

  const contactId = contact.id;

  // -------------------------------------------------------------------------
  // Step 2: Write df_* custom fields to the contact
  // -------------------------------------------------------------------------
  const customFields = {
    df_event: event,
    df_raw: JSON.stringify(body).substring(0, 5000) // LARGE_TEXT, cap at 5k
  };

  if (body.df_client_id) customFields.df_client_id = body.df_client_id;
  if (body.df_status_id) customFields.df_status = body.df_status_id;
  if (body.df_case_id) customFields.df_case_id = body.df_case_id;

  const fieldResult = await updateContactCustomFields(contactId, customFields);
  if (!fieldResult.ok) {
    logError("DisputeFox intake: field write failed", {
      contactId,
      error: fieldResult.error
    });
    // Non-fatal — continue to pipeline routing
  }

  // -------------------------------------------------------------------------
  // Step 3: Pipeline stage routing (client events only)
  // -------------------------------------------------------------------------
  let stageAction = "none";

  const isClientEvent = event === "client_added" || event === "client_updated";
  const statusId = body.df_status_id ? String(body.df_status_id) : null;

  if (isClientEvent && statusId) {
    const stageKey = STATUS_TO_STAGE[statusId];

    if (stageKey && REPAIR_STAGES[stageKey]) {
      const opp = await findRepairOpportunity(contactId);
      if (opp) {
        const stageResult = await updateOpportunityStage(opp.id, REPAIR_STAGES[stageKey]);
        stageAction = stageResult.ok ? `moved_to_${stageKey}` : "stage_update_failed";
      } else {
        stageAction = "no_opportunity_found";
        logWarn("DisputeFox intake: no Repair opportunity for contact", { contactId });
      }
    } else {
      // Unknown status — log it so we can build the mapping
      stageAction = "unknown_status";
      logInfo("DisputeFox intake: UNMAPPED df_status_id — add to STATUS_TO_STAGE", {
        df_status_id: statusId,
        contactId,
        event
      });
    }
  }

  logInfo("DisputeFox intake complete", {
    contactId,
    event,
    fields_written: fieldResult.ok,
    stage_action: stageAction
  });

  return res.status(200).json({
    ok: true,
    action: "processed",
    contact_id: contactId,
    event,
    fields_written: fieldResult.ok,
    stage_action: stageAction,
    timestamp: new Date().toISOString()
  });
};

// Export internals for testing
module.exports.REPAIR_PIPELINE_ID = REPAIR_PIPELINE_ID;
module.exports.REPAIR_STAGES = REPAIR_STAGES;
module.exports.STATUS_TO_STAGE = STATUS_TO_STAGE;
module.exports._findContactByPhone = findContactByPhone;
module.exports._findRepairOpportunity = findRepairOpportunity;
module.exports._updateOpportunityStage = updateOpportunityStage;
