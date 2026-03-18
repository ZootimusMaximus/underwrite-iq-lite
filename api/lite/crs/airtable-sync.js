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
function mapClientFields(_crsResult) {
  // Most CLIENTS fields are computed (formulas/rollups) and auto-update when
  // a linked SNAPSHOTS record is created. The only writable field we need to
  // set after a CRS pull is refresh_in_progress = false.
  //
  // Computed (NOT writable): employee_next_action_calc, open_inquiries_count,
  //   snapshot_age_days, ready_for_next_round, round_hold_reason_calc,
  //   has_applications, has_rounds, link_integrity_flag
  //
  // Schema verified against FUNDHUB MATRIX 2026-03-17.
  return {
    refresh_in_progress: false
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

    // Link to client record (field name matches table name in Airtable)
    CLIENTS: clientRecordId ? [clientRecordId] : []
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
 * findClientByEmail(email) — Look up a client record by email address.
 *
 * @param {string} email - Client email
 * @returns {Promise<string|null>} Airtable record ID, or null if not found
 */
async function findClientByEmail(email) {
  if (!isConfigured() || !email) return null;

  try {
    const formula = `{email} = "${email.replace(/"/g, '\\"')}"`;
    const records = await findRecords(TABLE_CLIENTS, formula, 1);
    if (records.length > 0) {
      logInfo("Airtable client found by email", { recordId: records[0].id });
      return records[0].id;
    }
    return null;
  } catch (err) {
    logWarn("Airtable client lookup by email failed", { error: err.message });
    return null;
  }
}

/**
 * syncCRSResultToAirtable(crsResult, clientRecordId, email) — Push CRS results back.
 *
 * If clientRecordId is not provided but email is, attempts to find the client
 * by email in Airtable before syncing.
 *
 * @param {Object} crsResult - Full CRS engine output
 * @param {string} [clientRecordId] - Airtable record ID for the client
 * @param {string} [email] - Client email (fallback lookup when no record ID)
 * @returns {Promise<{ ok: boolean, clientUpdated: boolean, snapshotCreated: boolean }>}
 */
async function syncCRSResultToAirtable(crsResult, clientRecordId, email) {
  if (!isConfigured()) {
    logWarn("Airtable sync skipped: not configured");
    return { ok: false, error: "not_configured", clientUpdated: false, snapshotCreated: false };
  }

  let resolvedRecordId = clientRecordId;
  let clientUpdated = false;
  let snapshotCreated = false;

  try {
    // If no record ID provided, try email lookup
    if (!resolvedRecordId && email) {
      resolvedRecordId = await findClientByEmail(email);
    }

    // 1. Update client record
    if (resolvedRecordId) {
      const clientFields = mapClientFields(crsResult);
      await updateRecord(TABLE_CLIENTS, resolvedRecordId, clientFields);
      clientUpdated = true;
      logInfo("Airtable client updated", {
        recordId: resolvedRecordId,
        outcome: crsResult.outcome
      });
    } else {
      logWarn("Airtable sync: no client record found", {
        hasRecordId: !!clientRecordId,
        hasEmail: !!email
      });
    }

    // 2. Create credit snapshot (linked to client if we found one)
    try {
      const snapshotFields = mapSnapshotFields(crsResult, resolvedRecordId);
      await createRecord(TABLE_SNAPSHOTS, snapshotFields);
      snapshotCreated = true;
      logInfo("Airtable snapshot created", {
        outcome: crsResult.outcome,
        linked: !!resolvedRecordId
      });
    } catch (snapErr) {
      logError("Airtable snapshot creation failed", { error: snapErr.message });
      return { ok: false, error: snapErr.message, clientUpdated, snapshotCreated };
    }

    return { ok: true, clientUpdated, snapshotCreated };
  } catch (err) {
    logError("Airtable sync failed", err);
    return { ok: false, error: err.message, clientUpdated, snapshotCreated };
  }
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
  findClientByEmail,
  syncCRSResultToAirtable,
  // For testing
  TABLE_CLIENTS,
  TABLE_SNAPSHOTS,
  TABLE_APPLICATIONS
};
