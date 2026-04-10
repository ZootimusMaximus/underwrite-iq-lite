"use strict";
/* global AbortSignal */

// ============================================================================
// Handler: fundhub.analysis.requested
//
// Fires when identity + consent are ready and analysis should begin.
// Both the SLO deposit funnel and the call funnel emit this event after
// capture — the downstream path is the same from this point forward.
//
// Required payload: analysis_request_id, method
// Optional payload: analysis_components_requested (e.g. ['personal_credit', 'business_credit'])
//
// Actions:
//   1. Upsert client
//   2. Set cf_analysis_required = true, cf_analysis_method, cf_analysis_request_id
//   3. Set cf_analysis_components_requested if provided
//   4. Write record to Airtable ANALYSIS_REQUESTS
//   5. Set cf_last_canonical_event + cf_last_canonical_event_ts
//
// See: FundHub Modular Event System Developer Handoff, sections 5 & 7.
// ============================================================================

const { logInfo, logWarn, logError } = require("../../lite/logger");
const { upsertClient } = require("./client-upsert");
const { updateContactCustomFields } = require("../../lite/ghl-contact-service");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const TABLE_ANALYSIS_REQUESTS = process.env.AIRTABLE_TABLE_ANALYSIS_REQUESTS || "Analysis Requests";

// ---------------------------------------------------------------------------
// Airtable: Write ANALYSIS_REQUESTS record
// ---------------------------------------------------------------------------

async function writeAnalysisRequest(fields) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    logWarn("analysis-requested: Airtable not configured, skipping ANALYSIS_REQUESTS write");
    return { ok: false, error: "Airtable not configured" };
  }

  try {
    const url = `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_ANALYSIS_REQUESTS)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(15000)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logWarn("analysis-requested: ANALYSIS_REQUESTS write failed", {
        status: resp.status,
        body: text.slice(0, 200)
      });
      return { ok: false, error: `Airtable error: ${resp.status}` };
    }

    const data = await resp.json();
    logInfo("analysis-requested: ANALYSIS_REQUESTS record created", { recordId: data.id });
    return { ok: true, recordId: data.id };
  } catch (err) {
    logError("analysis-requested: ANALYSIS_REQUESTS write exception", err);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} event - Full event envelope
 * @returns {Promise<{ ok: boolean, action: string, ghlContactId: string, analysisRequestRecordId: string }>}
 */
async function handle(event) {
  const { contact, payload, adapter, event_id, correlation_id } = event;

  const {
    analysis_request_id,
    method,
    analysis_components_requested,
    consent_confirmed,
    requested_at: _requested_at
  } = payload;

  logInfo("analysis-requested: processing", {
    event_id,
    analysis_request_id,
    method,
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
    cf_analysis_required: "true",
    cf_analysis_method: method,
    cf_analysis_request_id: analysis_request_id,
    cf_last_canonical_event: "fundhub.analysis.requested",
    cf_last_canonical_event_ts: now
  };

  // Only write components if provided — omitting is valid (defaults to personal_credit only)
  if (analysis_components_requested) {
    const components = Array.isArray(analysis_components_requested)
      ? analysis_components_requested.join(",")
      : String(analysis_components_requested);
    customFields.cf_analysis_components_requested = components;
  }

  const updateResult = await updateContactCustomFields(ghlContactId, customFields);
  if (!updateResult.ok) {
    logWarn("analysis-requested: GHL field update failed", {
      ghlContactId,
      error: updateResult.error
    });
  }

  // ---- 3. Write ANALYSIS_REQUESTS record ----
  const analysisFields = {
    analysis_request_id: analysis_request_id || "",
    method: method || "",
    analysis_components_requested: Array.isArray(analysis_components_requested)
      ? analysis_components_requested.join(",")
      : analysis_components_requested || "personal_credit",
    consent_confirmed: consent_confirmed === true || consent_confirmed === "true",
    ghl_contact_id: ghlContactId,
    client_master_key: clientMasterKey || "",
    event_id: event_id || "",
    correlation_id: correlation_id || "",
    occurred_at: event.occurred_at || now,
    recorded_at: now,
    funnel_family: adapter?.funnel_family || "",
    status: "requested"
  };

  // Link to CLIENTS record if available
  if (airtableClientRecordId) {
    analysisFields["Client"] = [airtableClientRecordId];
  }

  const atResult = await writeAnalysisRequest(analysisFields);

  logInfo("analysis-requested: complete", {
    event_id,
    ghlContactId,
    analysis_request_id,
    method,
    analysisRequestRecordId: atResult.recordId || null
  });

  return {
    ok: true,
    action: "analysis_requested",
    ghlContactId,
    airtableClientRecordId,
    clientMasterKey,
    analysis_request_id,
    method,
    analysisRequestRecordId: atResult.recordId || null
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { handle };
