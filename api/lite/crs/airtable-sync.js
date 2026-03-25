"use strict";

/**
 * airtable-sync.js — Airtable <-> CRS Integration
 *
 * Syncs CRS engine results back to the FUNDHUB MATRIX Airtable base.
 * Handles two directions:
 *   1. Read: Fetch applicant data from Airtable (trigger CRS pull)
 *   2. Write: Push CRS results back to Airtable records
 *
 * Also syncs tradeline-level data to PERSONAL_TRADELINES and
 * BUSINESS_TRADELINES tables for granular credit analysis.
 *
 * Uses Airtable REST API (no SDK dependency).
 */

const { fetchWithTimeout } = require("../fetch-utils");
const { logInfo, logWarn, logError } = require("../logger");
const { extractPersonalTradelines, extractBusinessTradelines } = require("./extract-tradelines");

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
const TABLE_PERSONAL_TRADELINES =
  process.env.AIRTABLE_TABLE_PERSONAL_TRADELINES || "Personal Tradelines";
const TABLE_BUSINESS_TRADELINES =
  process.env.AIRTABLE_TABLE_BUSINESS_TRADELINES || "Business Tradelines";

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
// Field Mapping: CRS Engine Output -> Airtable Fields
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
 *
 * @param {Object} crsResult - Full CRS engine output
 * @param {string} [clientRecordId] - Airtable client record ID for linking
 * @param {Object} [opts] - Additional options
 * @param {string} [opts.crs_pull_scope] - "consumer_only" or "consumer_plus_ex_business"
 * @param {boolean} [opts.businessPullFailed] - Whether business pull was requested but failed
 */
function mapSnapshotFields(crsResult, clientRecordId, opts) {
  const cs = crsResult.consumerSignals || {};
  const perBureau = derivePerBureauMetrics(crsResult.normalized);
  const pullScope = opts?.crs_pull_scope || "consumer_only";
  const _businessPullFailed = opts?.businessPullFailed || false;

  const fields = {
    // Core snapshot fields
    snapshot_date: new Date().toISOString(),
    snapshot_source: "CRS",
    crs_pull_scope: pullScope,

    // Per-bureau FICO scores
    "TU FICO": cs.scores?.perBureau?.tu || null,
    "EX FICO": cs.scores?.perBureau?.ex || null,
    "EQ FICO": cs.scores?.perBureau?.eq || null,

    // Per-bureau utilization
    "TU Util": perBureau.tu.utilPct != null ? perBureau.tu.utilPct / 100 : null,
    "EX Util": perBureau.ex.utilPct != null ? perBureau.ex.utilPct / 100 : null,
    "EQ Util": perBureau.eq.utilPct != null ? perBureau.eq.utilPct / 100 : null,

    // Per-bureau negative counts
    tu_neg_count: perBureau.tu.negs,
    ex_neg_count: perBureau.ex.negs,
    eq_neg_count: perBureau.eq.negs,

    // Per-bureau inquiry counts
    "TU inq": perBureau.tu.inqs,
    "EX inq": perBureau.ex.inqs,
    "EQ inq": perBureau.eq.inqs,

    // Fraud & security flags
    fraud_alert: crsResult.identityGate?.outcome === "FRAUD_HOLD",
    security_freeze: !!crsResult.identityGate?.securityFreeze?.detected,
    fraud_alert_on_file: !!crsResult.identityGate?.fraudAlertOnFile?.detected,

    // Link to client record (field name matches table name in Airtable)
    CLIENTS: clientRecordId ? [clientRecordId] : []
  };

  // Only populate business-related snapshot fields when a business pull
  // actually ran AND returned data
  const hasBusinessData = !!crsResult.businessSignals;
  if (pullScope === "consumer_plus_ex_business") {
    fields.business_pull_requested = true;
    if (hasBusinessData) {
      fields.business_pull_success = true;
      // Business signals from the engine (if available)
      const bs = crsResult.businessSignals || {};
      if (bs.intelliscore != null) fields.biz_intelliscore = bs.intelliscore;
      if (bs.fsr != null) fields.biz_fsr = bs.fsr;
      if (bs.daysBeyondTerms != null) fields.biz_dbt = bs.daysBeyondTerms;
      if (bs.yearsOnFile != null) fields.biz_years_on_file = bs.yearsOnFile;
    } else {
      // Business was requested but failed -- mark clearly
      fields.business_pull_success = false;
      fields.business_pull_failed = true;
    }
  } else {
    // consumer_only -- business was never requested, do not mark as successful
    fields.business_pull_requested = false;
    fields.business_pull_success = false;
  }

  return fields;
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
 * getRecord(table, recordId) -- Fetch a single record.
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
 * findRecords(table, filterFormula, maxRecords) -- Search records.
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
 * updateRecord(table, recordId, fields) -- Update a record.
 */
async function updateRecord(table, recordId, fields) {
  if (!isConfigured()) throw new Error("Airtable not configured");

  const resp = await fetchWithTimeout(apiUrl(table, recordId), {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ fields, typecast: true })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable update failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  return resp.json();
}

/**
 * createRecord(table, fields) -- Create a new record.
 */
async function createRecord(table, fields) {
  if (!isConfigured()) throw new Error("Airtable not configured");

  const resp = await fetchWithTimeout(apiUrl(table), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ fields, typecast: true })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable create failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  return resp.json();
}

/**
 * upsertRecord(table, keyField, keyValue, fields) -- Find by key, update or create.
 *
 * @param {string} table - Airtable table name
 * @param {string} keyField - Field name to match on (e.g., "tradeline_key")
 * @param {string} keyValue - Value to match
 * @param {Object} fields - Fields to write
 * @returns {Promise<{ id: string, created: boolean }>}
 */
async function upsertRecord(table, keyField, keyValue, fields) {
  if (!isConfigured()) throw new Error("Airtable not configured");

  // Search for existing record by key
  const escapedValue = keyValue.replace(/"/g, '\\"');
  const formula = `{${keyField}} = "${escapedValue}"`;
  const existing = await findRecords(table, formula, 1);

  if (existing.length > 0) {
    // Update existing
    const record = await updateRecord(table, existing[0].id, fields);
    return { id: record.id, created: false };
  }

  // Create new
  const record = await createRecord(table, { ...fields, [keyField]: keyValue });
  return { id: record.id, created: true };
}

// ---------------------------------------------------------------------------
// High-Level Sync Operations
// ---------------------------------------------------------------------------

/**
 * findClientByEmail(email) -- Look up a client record by email address.
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
 * syncTradelines(crsResult, clientRecordId, snapshotRecordId, opts)
 *
 * Extracts personal and business tradelines from CRS results and
 * upserts them into the corresponding Airtable tables.
 *
 * @param {Object} crsResult - Full CRS engine output
 * @param {string|null} clientRecordId - Airtable client record ID
 * @param {string|null} snapshotRecordId - Airtable snapshot record ID
 * @param {Object} [opts] - Additional options
 * @param {Object} [opts.businessReport] - Raw Experian business report (for business tradelines)
 * @param {string|null} [opts.businessRecordId] - Airtable business record ID (for linking)
 * @returns {Promise<{ personal: number, business: number, errors: number }>}
 */
async function syncTradelines(crsResult, clientRecordId, snapshotRecordId, opts) {
  const stats = { personal: 0, business: 0, errors: 0 };

  if (!isConfigured()) {
    logWarn("Tradeline sync skipped: Airtable not configured");
    return stats;
  }

  // 1. Personal tradelines
  const personalTradelines = extractPersonalTradelines(crsResult.normalized);
  for (const tl of personalTradelines) {
    try {
      const fields = {
        creditor_name: tl.creditor_name,
        account_type: tl.account_type,
        account_status: tl.account_status,
        bureau: tl.bureau,
        credit_limit: tl.credit_limit,
        current_balance: tl.current_balance,
        monthly_payment: tl.monthly_payment,
        high_balance: tl.high_balance,
        date_opened: tl.date_opened,
        date_reported: tl.date_reported,
        payment_status: tl.payment_status,
        late_30_count: tl.late_30_count,
        late_60_count: tl.late_60_count,
        late_90_count: tl.late_90_count,
        utilization_pct: tl.utilization_pct,
        remarks: tl.remarks
      };

      // Link to client and snapshot
      if (clientRecordId) fields.client = [clientRecordId];
      if (snapshotRecordId) fields.snapshot = [snapshotRecordId];

      await upsertRecord(TABLE_PERSONAL_TRADELINES, "tradeline_key", tl.tradeline_key, fields);
      stats.personal++;
    } catch (err) {
      logError("Personal tradeline upsert failed", {
        key: tl.tradeline_key,
        error: err.message
      });
      stats.errors++;
    }
  }

  // 2. Business tradelines
  const businessReport = opts?.businessReport || null;
  const businessTradelines = extractBusinessTradelines(businessReport);
  for (const bt of businessTradelines) {
    try {
      const fields = {
        creditor_name: bt.creditor_name,
        account_type: bt.account_type,
        account_status: bt.account_status,
        bureau: bt.bureau,
        credit_limit: bt.credit_limit,
        current_balance: bt.current_balance,
        monthly_payment: bt.monthly_payment,
        high_balance: bt.high_balance,
        date_opened: bt.date_opened,
        date_reported: bt.date_reported,
        payment_status: bt.payment_status,
        dbt_30: bt.dbt_30,
        dbt_60: bt.dbt_60,
        dbt_90: bt.dbt_90,
        remarks: bt.remarks
      };

      // Link to client, snapshot, and business
      if (clientRecordId) fields.client = [clientRecordId];
      if (snapshotRecordId) fields.snapshot = [snapshotRecordId];
      if (opts?.businessRecordId) fields.business = [opts.businessRecordId];

      await upsertRecord(TABLE_BUSINESS_TRADELINES, "tradeline_key", bt.tradeline_key, fields);
      stats.business++;
    } catch (err) {
      logError("Business tradeline upsert failed", {
        key: bt.tradeline_key,
        error: err.message
      });
      stats.errors++;
    }
  }

  logInfo("Tradeline sync complete", stats);
  return stats;
}

/**
 * syncCRSResultToAirtable(crsResult, clientRecordId, email, opts) -- Push CRS results back.
 *
 * If clientRecordId is not provided but email is, attempts to find the client
 * by email in Airtable before syncing.
 *
 * @param {Object} crsResult - Full CRS engine output
 * @param {string} [clientRecordId] - Airtable record ID for the client
 * @param {string} [email] - Client email (fallback lookup when no record ID)
 * @param {Object} [opts] - Additional options
 * @param {string} [opts.crs_pull_scope] - "consumer_only" or "consumer_plus_ex_business"
 * @param {boolean} [opts.businessPullFailed] - Whether business pull was requested but failed
 * @param {Object} [opts.businessReport] - Raw Experian business report (for tradeline extraction)
 * @param {string} [opts.businessRecordId] - Airtable business record ID (for linking)
 * @returns {Promise<{ ok: boolean, clientUpdated: boolean, snapshotCreated: boolean, tradelines?: Object }>}
 */
async function syncCRSResultToAirtable(crsResult, clientRecordId, email, opts) {
  if (!isConfigured()) {
    logWarn("Airtable sync skipped: not configured");
    return { ok: false, error: "not_configured", clientUpdated: false, snapshotCreated: false };
  }

  let resolvedRecordId = clientRecordId;
  let clientUpdated = false;
  let snapshotCreated = false;
  let snapshotRecordId = null;

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
      const snapshotFields = mapSnapshotFields(crsResult, resolvedRecordId, opts);
      const snapshotRecord = await createRecord(TABLE_SNAPSHOTS, snapshotFields);
      snapshotCreated = true;
      snapshotRecordId = snapshotRecord.id;
      logInfo("Airtable snapshot created", {
        snapshotRecordId,
        outcome: crsResult.outcome,
        linked: !!resolvedRecordId,
        crs_pull_scope: opts?.crs_pull_scope || "consumer_only",
        businessPullFailed: opts?.businessPullFailed || false
      });
    } catch (snapErr) {
      logError("Airtable snapshot creation failed", { error: snapErr.message });
      return { ok: false, error: snapErr.message, clientUpdated, snapshotCreated };
    }

    // 3. Sync tradelines (linked to client + snapshot)
    let tradelineStats = null;
    try {
      tradelineStats = await syncTradelines(crsResult, resolvedRecordId, snapshotRecordId, opts);
    } catch (tlErr) {
      // Tradeline sync failure is non-fatal -- snapshot was already created
      logError("Tradeline sync failed (non-fatal)", { error: tlErr.message });
      tradelineStats = { personal: 0, business: 0, errors: 1 };
    }

    return { ok: true, clientUpdated, snapshotCreated, tradelines: tradelineStats };
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
  upsertRecord,
  findClientByEmail,
  syncTradelines,
  syncCRSResultToAirtable,
  // For testing
  TABLE_CLIENTS,
  TABLE_SNAPSHOTS,
  TABLE_APPLICATIONS,
  TABLE_PERSONAL_TRADELINES,
  TABLE_BUSINESS_TRADELINES
};
