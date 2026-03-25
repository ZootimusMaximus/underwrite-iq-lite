"use strict";

/**
 * extract-tradelines.js — Tradeline Extraction from CRS Results
 *
 * Parses personal tradelines from the normalized CRS payload and
 * business tradelines from the raw Experian business report.
 * Generates dedup keys for Airtable upsert.
 */

// ---------------------------------------------------------------------------
// Personal Tradeline Extraction
// ---------------------------------------------------------------------------

/**
 * Map normalized account type to Airtable select value.
 */
const ACCOUNT_TYPE_LABELS = {
  revolving: "Revolving",
  installment: "Installment",
  mortgage: "Mortgage",
  open: "Open",
  unknown: "Other"
};

/**
 * Map normalized status to Airtable select value.
 */
const STATUS_LABELS = {
  open: "Open",
  closed: "Closed",
  paid: "Paid",
  transferred: "Other",
  unknown: "Other"
};

/**
 * Map normalized bureau source to Airtable select value.
 */
const BUREAU_LABELS = {
  transunion: "TU",
  experian: "EX",
  equifax: "EQ",
  unknown: "EX" // fallback — most single-bureau pulls are Experian
};

/**
 * Generate a dedup key for a personal tradeline.
 * Format: {bureau}:{creditor}:{account_type}:{date_opened}
 */
function personalTradelineKey(tl) {
  const bureau = tl.source || "unknown";
  const creditor = (tl.creditorName || "unknown").toUpperCase().trim();
  const acctType = tl.accountType || "unknown";
  const opened = tl.openedDate || "unknown";
  return `${bureau}:${creditor}:${acctType}:${opened}`;
}

/**
 * Derive payment status from rating and late payment counts.
 */
function derivePaymentStatus(tl) {
  if (tl.isDerogatory) return "Derogatory";
  const rating = tl.currentRatingType || "";
  if (rating === "ChargeOff" || rating === "CollectionOrChargeOff") return "Charge-Off";
  if (rating === "BankruptcyOrWageEarnerPlan") return "Bankruptcy";
  if (rating === "LateOver120Days") return "120+ Days Late";
  if (rating === "Late90Days") return "90 Days Late";
  if (rating === "Late60Days") return "60 Days Late";
  if (rating === "Late30Days") return "30 Days Late";
  if (rating === "AsAgreed") return "Current";
  if (rating === "TooNew") return "Too New";
  return "Unknown";
}

/**
 * Calculate utilization percentage for a single tradeline.
 * Only meaningful for revolving accounts.
 */
function calcUtilization(tl) {
  if (tl.accountType !== "revolving") return null;
  const limit = tl.effectiveLimit || tl.creditLimit || tl.highBalance || 0;
  if (limit <= 0) return null;
  const balance = tl.currentBalance || 0;
  return Math.round((balance / limit) * 100) / 100; // decimal for Airtable percent
}

/**
 * Collect comment/remark text from a tradeline.
 */
function collectRemarks(tl) {
  if (!tl.comments || tl.comments.length === 0) return null;
  return (
    tl.comments
      .map(c => c.text)
      .filter(Boolean)
      .join("; ") || null
  );
}

/**
 * Extract personal tradelines from normalized CRS output.
 *
 * @param {Object} normalized - Output of normalizeSoftPullPayload()
 * @returns {Array<Object>} Array of personal tradeline records
 */
function extractPersonalTradelines(normalized) {
  if (!normalized?.tradelines?.length) return [];

  return normalized.tradelines.map(tl => {
    const lates = tl.latePayments || {};
    return {
      tradeline_key: personalTradelineKey(tl),
      creditor_name: tl.creditorName || "Unknown",
      account_type: ACCOUNT_TYPE_LABELS[tl.accountType] || "Unknown",
      account_status: STATUS_LABELS[tl.status] || "Unknown",
      bureau: BUREAU_LABELS[tl.source] || "Unknown",
      credit_limit: tl.creditLimit,
      current_balance: tl.currentBalance,
      monthly_payment: tl.monthlyPayment,
      high_balance: tl.highBalance,
      date_opened: tl.openedDate || null,
      date_reported: tl.reportedDate || null,
      payment_status: derivePaymentStatus(tl),
      late_30_count: lates._30 ?? 0,
      late_60_count: lates._60 ?? 0,
      late_90_count: lates._90 ?? 0,
      utilization_pct: calcUtilization(tl),
      remarks: collectRemarks(tl)
    };
  });
}

// ---------------------------------------------------------------------------
// Business Tradeline Extraction
// ---------------------------------------------------------------------------

/**
 * Generate a dedup key for a business tradeline.
 * Format: business:{creditor}:{date_opened}
 */
function businessTradelineKey(bt) {
  const creditor = (bt.businessName || "unknown").toUpperCase().trim();
  const opened = bt.dateReported || "unknown";
  return `business:${creditor}:${opened}`;
}

/**
 * Map Experian business trade payment to business tradeline.
 */
function mapBusinessTrade(trade) {
  const dbt30 = trade.dbt30 ?? null;
  const dbt60 = trade.dbt60 ?? null;
  const dbt90 = trade.dbt90 ?? null;

  // Derive payment status from DBT
  let paymentStatus = "Current";
  if (dbt90 > 0) paymentStatus = "90+ Days Beyond Terms";
  else if (dbt60 > 0) paymentStatus = "60 Days Beyond Terms";
  else if (dbt30 > 0) paymentStatus = "30 Days Beyond Terms";

  const remarks = trade.comments?.join("; ") || null;

  return {
    tradeline_key: businessTradelineKey(trade),
    creditor_name: trade.businessName || "Unknown",
    account_type: trade.accountType || "Other",
    account_status: trade.accountStatus || "Other",
    bureau: "EX",
    credit_limit: trade.creditLimitAmount ?? null,
    current_balance: trade.recentHighCredit ?? trade.currentBalance ?? null,
    monthly_payment: trade.termsAmount ?? null,
    high_balance: trade.highCreditAmount ?? null,
    date_opened: trade.dateOpened || null,
    date_reported: trade.dateReported || null,
    payment_status: paymentStatus,
    dbt_30: dbt30,
    dbt_60: dbt60,
    dbt_90: dbt90,
    remarks
  };
}

/**
 * Extract business tradelines from the raw Experian business report.
 *
 * @param {Object|null} businessReport - Raw Experian Business Premier Profile response
 * @returns {Array<Object>} Array of business tradeline records
 */
function extractBusinessTradelines(businessReport) {
  if (!businessReport) return [];

  const data = businessReport.data || businessReport;
  if (!data || typeof data !== "object") return [];

  // Experian business reports may have tradePaymentTotals, tradePaymentExperiences,
  // or tradePaymentTrends. We look for the detail array.
  const trades = data.tradePaymentExperiences || data.tradeLines || [];
  if (!Array.isArray(trades) || trades.length === 0) return [];

  return trades.map(mapBusinessTrade);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  extractPersonalTradelines,
  extractBusinessTradelines,
  personalTradelineKey,
  businessTradelineKey,
  derivePaymentStatus,
  calcUtilization,
  collectRemarks,
  mapBusinessTrade,
  // Constants for testing
  ACCOUNT_TYPE_LABELS,
  STATUS_LABELS,
  BUREAU_LABELS
};
