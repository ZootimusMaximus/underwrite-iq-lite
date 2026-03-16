"use strict";

/**
 * airtable-sync.js — Airtable ↔ CRS Integration
 *
 * Syncs CRS engine results back to the FUNDHUB MATRIX Airtable base.
 * Handles two directions:
 *   1. Read: Fetch applicant data from Airtable (trigger CRS pull)
 *   2. Write: Push CRS results back to Airtable records
 *
 * Uses Airtable REST API (no SDK dependency).
 */

const { fetchWithTimeout } = require("../fetch-utils");
const { logInfo, logWarn, logError } = require("../logger");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

// Table names (configurable via env, with sensible defaults)
const TABLE_CLIENTS = process.env.AIRTABLE_TABLE_CLIENTS || "Clients";
const TABLE_SNAPSHOTS = process.env.AIRTABLE_TABLE_SNAPSHOTS || "Credit Snapshots";
const TABLE_APPLICATIONS = process.env.AIRTABLE_TABLE_APPLICATIONS || "Applications";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isConfigured() {
  return !!(AIRTABLE_API_KEY && AIRTABLE_BASE_ID);
}

function apiUrl(table, recordId) {
  const encoded = encodeURIComponent(table);
  return recordId
    ? `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encoded}/${recordId}`
    : `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encoded}`;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${AIRTABLE_API_KEY}`,
    "Content-Type": "application/json"
  };
}

// ---------------------------------------------------------------------------
// Field Mapping: CRS Engine Output → Airtable Fields
// ---------------------------------------------------------------------------
// Field names verified against FUNDHUB MATRIX base (appXsq65yB9VuNup5)
// as of 2026-03-12. Only fields that exist in Airtable are written.

/**
 * Compute per-bureau metrics from normalized tradelines/inquiries.
 */
function derivePerBureauMetrics(normalized) {
  const tradelines = normalized?.tradelines || [];
  const inquiries = normalized?.inquiries || [];

  const bureaus = { transunion: "tu", experian: "ex", equifax: "eq" };
  const metrics = {
    tu: { bal: 0, lim: 0, negs: 0, inqs: 0 },
    ex: { bal: 0, lim: 0, negs: 0, inqs: 0 },
    eq: { bal: 0, lim: 0, negs: 0, inqs: 0 }
  };

  for (const tl of tradelines) {
    const code = bureaus[tl.source];
    if (!code) continue;
    if (tl.accountType === "Revolving" && tl.open) {
      metrics[code].bal += tl.currentBalance || 0;
      metrics[code].lim += tl.effectiveLimit || tl.creditLimit || tl.highBalance || 0;
    }
    if (tl.isDerogatory) metrics[code].negs++;
  }

  for (const inq of inquiries) {
    const code = bureaus[inq.source];
    if (code) metrics[code].inqs++;
  }

  // Calculate utilization percentages
  for (const m of Object.values(metrics)) {
    m.utilPct = m.lim > 0 ? Math.round((m.bal / m.lim) * 100) : null;
  }

  return metrics;
}

/**
 * Maps CRS engine result to FUNDHUB MATRIX client fields.
 * Only writes fields confirmed to exist in the Airtable schema.
 */
function mapClientFields(crsResult) {
  return {
    // Status (confirmed fields in Client Control Panel)
    employee_next_action_calc: getNextAction(crsResult.outcome),
    open_inquiries_count: crsResult.consumerSignals?.inquiries?.total || 0,
    fraud_alert: crsResult.identityGate?.outcome === "FRAUD_HOLD"
  };
}

/**
 * Maps CRS engine result to credit snapshot fields.
 * Field names match Credit Snapshot & Trend view exactly.
 */
function mapSnapshotFields(crsResult, clientRecordId) {
  const cs = crsResult.consumerSignals || {};
  const perBureau = derivePerBureauMetrics(crsResult.normalized);

  return {
    // Core snapshot fields
    snapshot_date: new Date().toISOString(),
    snapshot_source: "CRS",

    // Per-bureau FICO scores
    tu_fico: cs.scores?.perBureau?.tu || null,
    ex_fico: cs.scores?.perBureau?.ex || null,
    eq_fico: cs.scores?.perBureau?.eq || null,

    // Per-bureau utilization
    tu_utilization_pct: perBureau.tu.utilPct,
    ex_utilization_pct: perBureau.ex.utilPct,
    eq_utilization_pct: perBureau.eq.utilPct,

    // Per-bureau negative counts
    tu_neg_count: perBureau.tu.negs,
    ex_neg_count: perBureau.ex.negs,
    eq_neg_count: perBureau.eq.negs,

    // Per-bureau inquiry counts
    inq_tu: perBureau.tu.inqs,
    inq_ex: perBureau.ex.inqs,
    inq_eq: perBureau.eq.inqs,

    // Fraud alert
    fraud_alert: crsResult.identityGate?.outcome === "FRAUD_HOLD",

    // Link to client record
    Client: clientRecordId ? [clientRecordId] : []
  };
}

/**
 * Determine the next action based on outcome.
 */
function getNextAction(outcome) {
  switch (outcome) {
    case "PREMIUM_STACK":
    case "FULL_STACK_APPROVAL":
      return "Submit Applications";
    case "CONDITIONAL_APPROVAL":
      return "Optimization Review";
    case "REPAIR":
      return "Start Repair Plan";
    case "MANUAL_REVIEW":
      return "Manual Review Required";
    case "FRAUD_HOLD":
      return "Identity Verification";
    default:
      return "Review Required";
  }
}

// ---------------------------------------------------------------------------
// Airtable API Operations
// ---------------------------------------------------------------------------

/**
 * getRecord(table, recordId) — Fetch a single record.
 */
async function getRecord(table, recordId) {
  if (!isConfigured()) throw new Error("Airtable not configured");

  const resp = await fetchWithTimeout(apiUrl(table, recordId), {
    method: "GET",
    headers: authHeaders()
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable GET failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  return resp.json();
}

/**
 * findRecords(table, filterFormula, maxRecords) — Search records.
 */
async function findRecords(table, filterFormula, maxRecords = 10) {
  if (!isConfigured()) throw new Error("Airtable not configured");

  const params = new URLSearchParams({
    filterByFormula: filterFormula,
    maxRecords: String(maxRecords)
  });

  const resp = await fetchWithTimeout(`${apiUrl(table)}?${params}`, {
    method: "GET",
    headers: authHeaders()
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable find failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  const data = await resp.json();
  return data.records || [];
}

/**
 * updateRecord(table, recordId, fields) — Update a record.
 */
async function updateRecord(table, recordId, fields) {
  if (!isConfigured()) throw new Error("Airtable not configured");

  const resp = await fetchWithTimeout(apiUrl(table, recordId), {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ fields })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable update failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  return resp.json();
}

/**
 * createRecord(table, fields) — Create a new record.
 */
async function createRecord(table, fields) {
  if (!isConfigured()) throw new Error("Airtable not configured");

  const resp = await fetchWithTimeout(apiUrl(table), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ fields })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable create failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// High-Level Sync Operations
// ---------------------------------------------------------------------------

/**
 * syncCRSResultToAirtable(crsResult, clientRecordId) — Push CRS results back.
 *
 * @param {Object} crsResult - Full CRS engine output
 * @param {string} [clientRecordId] - Airtable record ID for the client
 * @returns {Promise<{ ok: boolean, clientUpdated: boolean, snapshotCreated: boolean }>}
 */
async function syncCRSResultToAirtable(crsResult, clientRecordId) {
  if (!isConfigured()) {
    logWarn("Airtable sync skipped: not configured");
    return { ok: false, error: "not_configured", clientUpdated: false, snapshotCreated: false };
  }

  let clientUpdated = false;
  let snapshotCreated = false;

  try {
    // 1. Update client record
    if (clientRecordId) {
      const clientFields = mapClientFields(crsResult);
      await updateRecord(TABLE_CLIENTS, clientRecordId, clientFields);
      clientUpdated = true;
      logInfo("Airtable client updated", { recordId: clientRecordId, outcome: crsResult.outcome });
    }

    // 2. Create credit snapshot
    try {
      const snapshotFields = mapSnapshotFields(crsResult, clientRecordId);
      await createRecord(TABLE_SNAPSHOTS, snapshotFields);
      snapshotCreated = true;
      logInfo("Airtable snapshot created", { outcome: crsResult.outcome });
    } catch (snapErr) {
      logWarn("Airtable snapshot creation failed", { error: snapErr.message });
    }

    return { ok: true, clientUpdated, snapshotCreated };
  } catch (err) {
    logError("Airtable sync failed", err);
    return { ok: false, error: err.message, clientUpdated, snapshotCreated };
  }
}

/**
 * fetchClientForCRS(recordId) — Fetch client data to trigger a CRS pull.
 *
 * @param {string} recordId - Airtable record ID
 * @returns {Promise<Object>} Client data ready for CRS pull
 */
async function fetchClientForCRS(recordId) {
  if (!isConfigured()) throw new Error("Airtable not configured");

  const record = await getRecord(TABLE_CLIENTS, recordId);
  const f = record.fields || {};

  // Parse full_name into first/last (FUNDHUB MATRIX stores as single field)
  const nameParts = (f.full_name || "").trim().split(/\s+/);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ") || "";

  return {
    applicant: {
      firstName,
      lastName,
      middleName: "",
      ssn: f.ssn || "",
      birthDate: f.birth_date || f.dob || "",
      email: f.email || "",
      address: {
        addressLine1: f.address || "",
        addressLine2: "",
        city: f.city || "",
        state: f.personal_state || f.state || "",
        postalCode: f.zip || f.postal_code || ""
      }
    },
    business: f.business_state
      ? {
          name: f.business_name || "",
          state: f.business_state || ""
        }
      : null,
    formData: {
      email: f.email || "",
      phone: f.phone || "",
      name: f.full_name || "",
      companyName: f.business_name || "",
      hasLLC: !!f.has_llc,
      llcAgeMonths: f.llc_age_months || null,
      ref: recordId
    },
    airtableRecordId: recordId
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  isConfigured,
  mapClientFields,
  mapSnapshotFields,
  derivePerBureauMetrics,
  getNextAction,
  getRecord,
  findRecords,
  updateRecord,
  createRecord,
  syncCRSResultToAirtable,
  fetchClientForCRS,
  // For testing
  TABLE_CLIENTS,
  TABLE_SNAPSHOTS,
  TABLE_APPLICATIONS
};
