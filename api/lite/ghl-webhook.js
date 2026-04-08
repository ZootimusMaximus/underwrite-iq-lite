"use strict";

// ============================================================================
// GHL Webhook Notifier
// ---------------------------------------------------------------------------
// Fires webhook events to GoHighLevel workflow trigger URLs.
// These webhooks activate GHL automation chains (U-series, S-series, etc.)
// that handle contact merging, tagging, email delivery, and downstream logic.
//
// Our direct API calls (ghl-contact-service.js) set fields, but the GHL
// workflows do additional work: merge contacts, apply tags, send emails,
// set Primary Snapshot Source, trigger downstream workflows, etc.
// ============================================================================

const { fetchWithTimeout } = require("./fetch-utils");
const { logInfo, logError, logWarn } = require("./logger");

const GHL_WEBHOOK_BASE =
  "https://services.leadconnectorhq.com/hooks/ORh91GeY4acceSASSnLR/webhook-trigger";

// ---------------------------------------------------------------------------
// Webhook URL Registry (from GHL CRM Source of Truth doc 03/15/2026)
// ---------------------------------------------------------------------------

const WEBHOOK_URLS = {
  analyzer_start: `${GHL_WEBHOOK_BASE}/03f27697-68e1-411a-81e4-6ecff03fb239`,
  analyzer_complete: `${GHL_WEBHOOK_BASE}/330139cd-098d-46f8-9e65-25cd3545a612`,
  crs_snapshot_complete: `${GHL_WEBHOOK_BASE}/faa8c0be-31b0-48a6-97a3-d39eff741665`
};

// Airtable automation webhook URLs
const AIRTABLE_WEBHOOK_URLS = {
  analyzer_complete:
    "https://hooks.airtable.com/workflows/v1/genericWebhook/appXsq65yB9VuNup5/wflPBbRZOHYWeHNIm/wtr1UrDveJfnkpbac"
};

const TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Notify GHL: Analyzer Start (triggers U-01 workflow)
// ---------------------------------------------------------------------------

/**
 * Fire the analyzer_start webhook to GHL.
 * Triggers U-01 which: notifies CRM that analysis is in progress,
 * sets tags (analyzer:processing), enables progress tracking.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} [params.phone]
 * @param {string} [params.contactId] - GHL contact ID if already known
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function notifyAnalyzerStart(params) {
  const payload = {
    event: "underwriteiq_analyzer_start",
    email: params.email,
    phone: params.phone || "",
    contact_id: params.contactId || "",
    analyzer_status: "processing"
  };

  return fireWebhook(WEBHOOK_URLS.analyzer_start, payload, "U-01 analyzer_start");
}

// ---------------------------------------------------------------------------
// Notify GHL: Analyzer Complete (triggers U-02 workflow)
// ---------------------------------------------------------------------------

/**
 * Fire the analyzer_complete webhook to GHL.
 * Triggers U-02 which: merges contact, maps analyzer data, sets tags
 * (analyzer:complete, path:funding/repair), sends delivery emails,
 * sets Primary Snapshot Source.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.phone
 * @param {string} params.fullName
 * @param {string} params.analyzerPath - "funding" | "repair"
 * @param {string} [params.creditSuggestions]
 * @param {number} [params.creditScore]
 * @param {Object} [params.letterUrls] - Letter URL fields
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function notifyAnalyzerComplete(params) {
  const payload = {
    event: "underwriteiq_analyzer_complete",
    email: params.email,
    phone: params.phone,
    full_name: params.fullName,
    analyzer_status: "complete",
    analyzer_path: params.analyzerPath,
    credit_suggestions: params.creditSuggestions || "",
    credit_score: params.creditScore || 0
  };

  // Add letter URLs if provided
  if (params.letterUrls) {
    Object.assign(payload, params.letterUrls);
  }

  return fireWebhook(WEBHOOK_URLS.analyzer_complete, payload, "U-02 analyzer_complete");
}

// ---------------------------------------------------------------------------
// Notify GHL: CRS Snapshot Complete (triggers U-03 workflow)
// ---------------------------------------------------------------------------

/**
 * Fire the crs_snapshot_complete webhook to GHL.
 * Triggers U-03 which: maps CRS metrics, sets CRS Status = Complete,
 * adds crs:snapshot tag, triggers U-04 (promote CRS as Primary Snapshot).
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} [params.firstName]
 * @param {string} [params.lastName]
 * @param {string} params.analyzerPath - "funding" | "repair"
 * @param {number} [params.ficoScore]
 * @param {number} [params.utilizationPct]
 * @param {Object} [params.inquiries] - { ex, eq, tu }
 * @param {Object} [params.negatives] - { ex, eq, tu }
 * @param {Object} [params.lates] - { ex, eq, tu }
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function notifyCRSSnapshotComplete(params) {
  const payload = {
    event: "underwriteiq_crs_snapshot_complete",
    email: params.email,
    first_name: params.firstName || "",
    last_name: params.lastName || "",
    analyzer_path: params.analyzerPath,
    fico_score: params.ficoScore || 0,
    utilization_pct: params.utilizationPct || 0,
    inquiries_ex: params.inquiries?.ex || 0,
    inquiries_eq: params.inquiries?.eq || 0,
    inquiries_tu: params.inquiries?.tu || 0,
    negatives_ex: params.negatives?.ex || 0,
    negatives_eq: params.negatives?.eq || 0,
    negatives_tu: params.negatives?.tu || 0,
    lates_ex: params.lates?.ex || 0,
    lates_eq: params.lates?.eq || 0,
    lates_tu: params.lates?.tu || 0,
    credit_suggestions: params.creditSuggestions || ""
  };

  return fireWebhook(WEBHOOK_URLS.crs_snapshot_complete, payload, "U-03 crs_snapshot_complete");
}

// ---------------------------------------------------------------------------
// Notify Airtable: Analyzer Complete (triggers AX01A automation)
// ---------------------------------------------------------------------------

/**
 * Fire the analyzer_complete webhook to Airtable.
 * Triggers AX01A which: creates/updates CLIENTS record, creates SNAPSHOTS.
 *
 * @param {Object} params
 * @param {string} params.email
 * @param {string} params.fullName
 * @param {string} params.phone
 * @param {string} [params.ghlContactId]
 * @param {string} [params.personalState]
 * @param {string} [params.businessState]
 * @param {string} [params.analyzerReportUrl]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function notifyAirtableAnalyzerComplete(params) {
  const payload = {
    event: "analyzer_complete",
    source: "analyzer",
    email: params.email,
    full_name: params.fullName,
    phone: params.phone || "",
    ghl_contact_id: params.ghlContactId || "",
    personal_state: params.personalState || "",
    business_state: params.businessState || "",
    analyzer_report_url: params.analyzerReportUrl || ""
  };

  return fireWebhook(
    AIRTABLE_WEBHOOK_URLS.analyzer_complete,
    payload,
    "AX01A airtable_analyzer_complete"
  );
}

// ---------------------------------------------------------------------------
// Core webhook sender
// ---------------------------------------------------------------------------

async function fireWebhook(url, payload, label) {
  try {
    logInfo(`Firing webhook: ${label}`, {
      email: payload.email,
      event: payload.event
    });

    const resp = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      },
      TIMEOUT_MS
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logWarn(`Webhook ${label} returned ${resp.status}`, {
        status: resp.status,
        body: text.substring(0, 200)
      });
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    logInfo(`Webhook ${label} fired successfully`);
    return { ok: true };
  } catch (err) {
    logError(`Webhook ${label} failed`, { error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = {
  notifyAnalyzerStart,
  notifyAnalyzerComplete,
  notifyCRSSnapshotComplete,
  notifyAirtableAnalyzerComplete,
  WEBHOOK_URLS,
  AIRTABLE_WEBHOOK_URLS
};
