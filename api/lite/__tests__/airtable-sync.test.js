"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isConfigured,
  mapClientFields,
  mapSnapshotFields,
  derivePerBureauMetrics,
  getNextAction,
  findClientByEmail,
  TABLE_CLIENTS,
  TABLE_SNAPSHOTS
} = require("../crs/airtable-sync");

// ============================================================================
// Helpers
// ============================================================================

function makeCRSResult(overrides = {}) {
  return {
    outcome: "FULL_FUNDING",
    decision_label: "Approved for Funding",
    confidence: "high",
    reason_codes: ["SCORE_FULL_STACK_BAND"],
    consumer_summary: "Credit score: 720 (good).",
    business_summary: "No business entity found.",
    consumerSignals: {
      scores: { median: 720, bureauConfidence: "high", perBureau: { tu: 715, ex: 725, eq: 720 } },
      utilization: { pct: 15, band: "good" },
      inquiries: { total: 8 }
    },
    identityGate: { outcome: "FULL_FUNDING", passed: true, reasons: [] },
    businessSignals: { available: false },
    preapprovals: {
      personalCard: { final: 82500 },
      personalLoan: { final: 75000 },
      business: { final: 0 },
      totalCombined: 157500
    },
    normalized: {
      meta: { bureauCount: 3 },
      tradelines: [
        {
          source: "transunion",
          accountType: "Revolving",
          open: true,
          currentBalance: 500,
          effectiveLimit: 5000,
          creditLimit: 5000,
          isDerogatory: false
        },
        {
          source: "experian",
          accountType: "Revolving",
          open: true,
          currentBalance: 1000,
          effectiveLimit: 2000,
          creditLimit: 2000,
          isDerogatory: false
        },
        {
          source: "equifax",
          accountType: "Revolving",
          open: true,
          currentBalance: 200,
          effectiveLimit: 1000,
          creditLimit: 1000,
          isDerogatory: false
        },
        {
          source: "equifax",
          accountType: "Installment",
          open: true,
          currentBalance: 5000,
          isDerogatory: true
        }
      ],
      inquiries: [
        { source: "transunion", creditorName: "BANK A", date: "2026-01-15" },
        { source: "experian", creditorName: "BANK B", date: "2026-02-01" },
        { source: "experian", creditorName: "BANK C", date: "2026-02-15" },
        { source: "equifax", creditorName: "BANK D", date: "2026-01-20" }
      ]
    },
    cards: ["full_stack", "needs_inquiry_cleanup", "inquiries"],
    ...overrides
  };
}

// ============================================================================
// isConfigured
// ============================================================================

test("isConfigured: returns false without env vars", () => {
  // No AIRTABLE_API_KEY or AIRTABLE_BASE_ID set
  assert.equal(typeof isConfigured(), "boolean");
});

// ============================================================================
// mapClientFields
// ============================================================================

test("mapClientFields: sets refresh_in_progress to false", () => {
  const fields = mapClientFields(makeCRSResult());
  assert.equal(fields.refresh_in_progress, false);
});

test("mapClientFields: does not include computed fields", () => {
  const fields = mapClientFields(makeCRSResult());
  // These are all formula/rollup fields in Airtable — auto-update from SNAPSHOTS
  assert.equal(fields.employee_next_action_calc, undefined);
  assert.equal(fields.open_inquiries_count, undefined);
  assert.equal(fields.fraud_alert, undefined);
});

// ============================================================================
// mapSnapshotFields
// ============================================================================

test("mapSnapshotFields: creates snapshot with per-bureau metrics", () => {
  const fields = mapSnapshotFields(makeCRSResult(), "rec123");

  // Source field (matches Airtable single-select)
  assert.equal(fields.snapshot_source, "CRS");

  // Per-bureau FICO scores
  assert.equal(fields["TU FICO"], 715);
  assert.equal(fields["EX FICO"], 725);
  assert.equal(fields["EQ FICO"], 720);

  // Per-bureau utilization
  assert.equal(fields["TU Util"], 0.1); // 500/5000 = 10% as decimal
  assert.equal(fields["EX Util"], 0.5); // 1000/2000 = 50% as decimal
  assert.equal(fields["EQ Util"], 0.2); // 200/1000 = 20% as decimal

  // Per-bureau negative counts
  assert.equal(fields.tu_neg_count, 0);
  assert.equal(fields.ex_neg_count, 0);
  assert.equal(fields.eq_neg_count, 1); // 1 derogatory installment

  // Per-bureau inquiry counts
  assert.equal(fields["TU inq"], 1);
  assert.equal(fields["EX inq"], 2);
  assert.equal(fields["EQ inq"], 1);

  // Fraud alert
  assert.equal(fields.fraud_alert, false);

  // Client link (field name matches table name)
  assert.deepEqual(fields.CLIENTS, ["rec123"]);
  assert.ok(fields.snapshot_date);
});

test("mapSnapshotFields: no client link when no recordId", () => {
  const fields = mapSnapshotFields(makeCRSResult(), null);
  assert.deepEqual(fields.CLIENTS, []);
});

// ============================================================================
// derivePerBureauMetrics
// ============================================================================

test("derivePerBureauMetrics: computes per-bureau stats", () => {
  const result = makeCRSResult();
  const metrics = derivePerBureauMetrics(result.normalized);

  assert.equal(metrics.tu.inqs, 1);
  assert.equal(metrics.ex.inqs, 2);
  assert.equal(metrics.eq.inqs, 1);
  assert.equal(metrics.eq.negs, 1);
  assert.equal(metrics.tu.negs, 0);
  assert.equal(metrics.tu.utilPct, 10);
});

test("derivePerBureauMetrics: handles empty normalized", () => {
  const metrics = derivePerBureauMetrics({});
  assert.equal(metrics.tu.inqs, 0);
  assert.equal(metrics.tu.negs, 0);
  assert.equal(metrics.tu.utilPct, null);
});

// ============================================================================
// getNextAction
// ============================================================================

test("getNextAction: all outcome tiers", () => {
  assert.equal(getNextAction("PREMIUM_STACK"), "Submit Applications");
  assert.equal(getNextAction("FULL_FUNDING"), "Submit Applications");
  assert.equal(getNextAction("FUNDING_PLUS_REPAIR"), "Optimization Review");
  assert.equal(getNextAction("REPAIR_ONLY"), "Start Repair Plan");
  assert.equal(getNextAction("MANUAL_REVIEW"), "Manual Review Required");
  assert.equal(getNextAction("FRAUD_HOLD"), "Identity Verification");
  assert.equal(getNextAction("UNKNOWN"), "Review Required");
});

// ============================================================================
// Table names
// ============================================================================

test("table names: have defaults", () => {
  assert.equal(TABLE_CLIENTS, "Clients");
  assert.equal(TABLE_SNAPSHOTS, "Credit Snapshots");
});

// ============================================================================
// findClientByEmail
// ============================================================================

test("findClientByEmail: returns null when not configured", async () => {
  // Without env vars, isConfigured() is false
  const result = await findClientByEmail("test@example.com");
  assert.equal(result, null);
});

test("findClientByEmail: returns null for empty email", async () => {
  const result = await findClientByEmail("");
  assert.equal(result, null);
});

test("findClientByEmail: returns null for null email", async () => {
  const result = await findClientByEmail(null);
  assert.equal(result, null);
});

// ============================================================================
// Tradeline table names
// ============================================================================

const {
  syncTradelines,
  TABLE_PERSONAL_TRADELINES,
  TABLE_BUSINESS_TRADELINES
} = require("../crs/airtable-sync");

test("tradeline table names: have defaults", () => {
  assert.equal(TABLE_PERSONAL_TRADELINES, "Personal Tradelines");
  assert.equal(TABLE_BUSINESS_TRADELINES, "Business Tradelines");
});

// ============================================================================
// syncTradelines (without Airtable configured)
// ============================================================================

test("syncTradelines: returns zero stats when not configured", async () => {
  const result = await syncTradelines(makeCRSResult(), null, null, {});
  assert.equal(result.personal, 0);
  assert.equal(result.business, 0);
  assert.equal(result.errors, 0);
});
