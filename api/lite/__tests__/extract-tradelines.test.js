"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractPersonalTradelines,
  extractBusinessTradelines,
  personalTradelineKey,
  businessTradelineKey,
  derivePaymentStatus,
  calcUtilization,
  collectRemarks,
  mapBusinessTrade,
  ACCOUNT_TYPE_LABELS,
  STATUS_LABELS,
  BUREAU_LABELS
} = require("../crs/extract-tradelines");

// ============================================================================
// Helpers
// ============================================================================

function makeNormalizedTradeline(overrides = {}) {
  return {
    creditorName: "CHASE BANK",
    accountIdentifier: "1234567890",
    source: "experian",
    accountType: "revolving",
    loanType: "CreditCard",
    ownership: "individual",
    isAU: false,
    status: "open",
    openedDate: "2020-01-15",
    closedDate: null,
    reportedDate: "2026-03-01",
    lastActivityDate: "2026-03-01",
    creditLimit: 10000,
    highBalance: 10000,
    currentBalance: 2500,
    effectiveLimit: 10000,
    pastDue: null,
    monthlyPayment: 100,
    chargeOffAmount: null,
    termsMonths: null,
    monthsReviewed: 72,
    latePayments: { _30: 0, _60: 0, _90: 0 },
    currentRatingCode: "1",
    currentRatingType: "AsAgreed",
    ratingSeverity: 0,
    isDerogatory: false,
    paymentPattern: null,
    adverseRatings: null,
    comments: [],
    ...overrides
  };
}

function makeNormalized(tradelines = []) {
  return {
    tradelines,
    inquiries: [],
    publicRecords: [],
    bureaus: {},
    meta: { bureauCount: 1, availableBureaus: ["experian"] }
  };
}

// ============================================================================
// personalTradelineKey
// ============================================================================

test("personalTradelineKey: generates correct key format", () => {
  const tl = makeNormalizedTradeline();
  const key = personalTradelineKey(tl);
  assert.equal(key, "experian:CHASE BANK:revolving:2020-01-15");
});

test("personalTradelineKey: handles missing fields gracefully", () => {
  const key = personalTradelineKey({});
  assert.equal(key, "unknown:UNKNOWN:unknown:unknown");
});

test("personalTradelineKey: normalizes creditor name to uppercase", () => {
  const key = personalTradelineKey({
    creditorName: "chase bank",
    source: "transunion",
    accountType: "revolving",
    openedDate: "2020-01-01"
  });
  assert.equal(key, "transunion:CHASE BANK:revolving:2020-01-01");
});

// ============================================================================
// derivePaymentStatus
// ============================================================================

test("derivePaymentStatus: derogatory tradeline", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: true, currentRatingType: "ChargeOff" }),
    "Derogatory"
  );
});

test("derivePaymentStatus: charge-off (not marked derogatory)", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "ChargeOff" }),
    "Charge-Off"
  );
});

test("derivePaymentStatus: collection or charge-off", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "CollectionOrChargeOff" }),
    "Charge-Off"
  );
});

test("derivePaymentStatus: as agreed", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "AsAgreed" }),
    "Current"
  );
});

test("derivePaymentStatus: late 30 days", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "Late30Days" }),
    "30 Days Late"
  );
});

test("derivePaymentStatus: late 60 days", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "Late60Days" }),
    "60 Days Late"
  );
});

test("derivePaymentStatus: late 90 days", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "Late90Days" }),
    "90 Days Late"
  );
});

test("derivePaymentStatus: late 120+ days", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "LateOver120Days" }),
    "120+ Days Late"
  );
});

test("derivePaymentStatus: bankruptcy", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "BankruptcyOrWageEarnerPlan" }),
    "Bankruptcy"
  );
});

test("derivePaymentStatus: too new", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "TooNew" }),
    "Too New"
  );
});

test("derivePaymentStatus: unknown rating", () => {
  assert.equal(
    derivePaymentStatus({ isDerogatory: false, currentRatingType: "SomethingElse" }),
    "Unknown"
  );
});

test("derivePaymentStatus: missing rating type", () => {
  assert.equal(derivePaymentStatus({ isDerogatory: false }), "Unknown");
});

// ============================================================================
// calcUtilization
// ============================================================================

test("calcUtilization: revolving with balance and limit", () => {
  const result = calcUtilization({
    accountType: "revolving",
    effectiveLimit: 10000,
    currentBalance: 2500
  });
  assert.equal(result, 0.25);
});

test("calcUtilization: revolving with zero balance", () => {
  const result = calcUtilization({
    accountType: "revolving",
    effectiveLimit: 10000,
    currentBalance: 0
  });
  assert.equal(result, 0);
});

test("calcUtilization: revolving with no limit returns null", () => {
  const result = calcUtilization({
    accountType: "revolving",
    effectiveLimit: null,
    creditLimit: null,
    highBalance: null,
    currentBalance: 500
  });
  assert.equal(result, null);
});

test("calcUtilization: installment returns null", () => {
  const result = calcUtilization({
    accountType: "installment",
    effectiveLimit: 10000,
    currentBalance: 5000
  });
  assert.equal(result, null);
});

test("calcUtilization: falls back to creditLimit", () => {
  const result = calcUtilization({
    accountType: "revolving",
    effectiveLimit: null,
    creditLimit: 5000,
    currentBalance: 1000
  });
  assert.equal(result, 0.2);
});

test("calcUtilization: falls back to highBalance", () => {
  const result = calcUtilization({
    accountType: "revolving",
    effectiveLimit: null,
    creditLimit: null,
    highBalance: 4000,
    currentBalance: 1000
  });
  assert.equal(result, 0.25);
});

// ============================================================================
// collectRemarks
// ============================================================================

test("collectRemarks: no comments", () => {
  assert.equal(collectRemarks({ comments: [] }), null);
});

test("collectRemarks: undefined comments", () => {
  assert.equal(collectRemarks({}), null);
});

test("collectRemarks: single comment", () => {
  const result = collectRemarks({ comments: [{ text: "TRANSFERRED TO ANOTHER LENDER" }] });
  assert.equal(result, "TRANSFERRED TO ANOTHER LENDER");
});

test("collectRemarks: multiple comments joined", () => {
  const result = collectRemarks({
    comments: [{ text: "ACCOUNT CLOSED" }, { text: "CONSUMER DISPUTE" }]
  });
  assert.equal(result, "ACCOUNT CLOSED; CONSUMER DISPUTE");
});

test("collectRemarks: filters empty text", () => {
  const result = collectRemarks({
    comments: [{ text: "" }, { text: "VALID REMARK" }]
  });
  assert.equal(result, "VALID REMARK");
});

// ============================================================================
// extractPersonalTradelines
// ============================================================================

test("extractPersonalTradelines: returns empty array for null input", () => {
  assert.deepEqual(extractPersonalTradelines(null), []);
});

test("extractPersonalTradelines: returns empty array for empty tradelines", () => {
  assert.deepEqual(extractPersonalTradelines({ tradelines: [] }), []);
});

test("extractPersonalTradelines: returns empty array for missing tradelines", () => {
  assert.deepEqual(extractPersonalTradelines({}), []);
});

test("extractPersonalTradelines: extracts single tradeline correctly", () => {
  const tl = makeNormalizedTradeline();
  const result = extractPersonalTradelines(makeNormalized([tl]));

  assert.equal(result.length, 1);
  const r = result[0];
  assert.equal(r.tradeline_key, "experian:CHASE BANK:revolving:2020-01-15");
  assert.equal(r.creditor_name, "CHASE BANK");
  assert.equal(r.account_type, "Revolving");
  assert.equal(r.account_status, "Open");
  assert.equal(r.bureau, "Experian");
  assert.equal(r.credit_limit, 10000);
  assert.equal(r.current_balance, 2500);
  assert.equal(r.monthly_payment, 100);
  assert.equal(r.high_balance, 10000);
  assert.equal(r.date_opened, "2020-01-15");
  assert.equal(r.date_reported, "2026-03-01");
  assert.equal(r.payment_status, "Current");
  assert.equal(r.late_30_count, 0);
  assert.equal(r.late_60_count, 0);
  assert.equal(r.late_90_count, 0);
  assert.equal(r.utilization_pct, 0.25);
  assert.equal(r.remarks, null);
});

test("extractPersonalTradelines: maps all account types correctly", () => {
  for (const [key, label] of Object.entries(ACCOUNT_TYPE_LABELS)) {
    const tl = makeNormalizedTradeline({ accountType: key });
    const result = extractPersonalTradelines(makeNormalized([tl]));
    assert.equal(result[0].account_type, label, `accountType ${key} should map to ${label}`);
  }
});

test("extractPersonalTradelines: maps all bureau labels correctly", () => {
  for (const [key, label] of Object.entries(BUREAU_LABELS)) {
    const tl = makeNormalizedTradeline({ source: key });
    const result = extractPersonalTradelines(makeNormalized([tl]));
    assert.equal(result[0].bureau, label, `bureau ${key} should map to ${label}`);
  }
});

test("extractPersonalTradelines: maps all status labels correctly", () => {
  for (const [key, label] of Object.entries(STATUS_LABELS)) {
    const tl = makeNormalizedTradeline({ status: key });
    const result = extractPersonalTradelines(makeNormalized([tl]));
    assert.equal(result[0].account_status, label, `status ${key} should map to ${label}`);
  }
});

test("extractPersonalTradelines: handles derogatory tradeline", () => {
  const tl = makeNormalizedTradeline({
    isDerogatory: true,
    currentRatingType: "ChargeOff",
    status: "closed",
    latePayments: { _30: 3, _60: 2, _90: 1 }
  });
  const result = extractPersonalTradelines(makeNormalized([tl]));

  assert.equal(result[0].payment_status, "Derogatory");
  assert.equal(result[0].late_30_count, 3);
  assert.equal(result[0].late_60_count, 2);
  assert.equal(result[0].late_90_count, 1);
  assert.equal(result[0].account_status, "Closed");
});

test("extractPersonalTradelines: handles multiple tradelines", () => {
  const tl1 = makeNormalizedTradeline({ creditorName: "CHASE", source: "experian" });
  const tl2 = makeNormalizedTradeline({ creditorName: "AMEX", source: "transunion" });
  const tl3 = makeNormalizedTradeline({ creditorName: "WELLS FARGO", source: "equifax" });
  const result = extractPersonalTradelines(makeNormalized([tl1, tl2, tl3]));
  assert.equal(result.length, 3);
  assert.equal(result[0].creditor_name, "CHASE");
  assert.equal(result[1].creditor_name, "AMEX");
  assert.equal(result[2].creditor_name, "WELLS FARGO");
});

test("extractPersonalTradelines: handles tradeline with comments", () => {
  const tl = makeNormalizedTradeline({
    comments: [
      {
        text: "TRANSFERRED TO ANOTHER LENDER",
        code: "31",
        source: "Experian",
        type: "BureauRemarks"
      }
    ]
  });
  const result = extractPersonalTradelines(makeNormalized([tl]));
  assert.equal(result[0].remarks, "TRANSFERRED TO ANOTHER LENDER");
});

test("extractPersonalTradelines: null utilization for non-revolving", () => {
  const tl = makeNormalizedTradeline({ accountType: "installment" });
  const result = extractPersonalTradelines(makeNormalized([tl]));
  assert.equal(result[0].utilization_pct, null);
});

test("extractPersonalTradelines: handles missing latePayments", () => {
  const tl = makeNormalizedTradeline({ latePayments: undefined });
  const result = extractPersonalTradelines(makeNormalized([tl]));
  assert.equal(result[0].late_30_count, 0);
  assert.equal(result[0].late_60_count, 0);
  assert.equal(result[0].late_90_count, 0);
});

// ============================================================================
// businessTradelineKey
// ============================================================================

test("businessTradelineKey: generates correct key format", () => {
  const key = businessTradelineKey({ businessName: "ACME Corp", dateReported: "2026-01-15" });
  assert.equal(key, "business:ACME CORP:2026-01-15");
});

test("businessTradelineKey: handles missing fields", () => {
  const key = businessTradelineKey({});
  assert.equal(key, "business:UNKNOWN:unknown");
});

// ============================================================================
// mapBusinessTrade
// ============================================================================

test("mapBusinessTrade: maps complete trade correctly", () => {
  const trade = {
    businessName: "OFFICE DEPOT",
    accountType: "Trade",
    accountStatus: "Active",
    creditLimitAmount: 50000,
    recentHighCredit: 25000,
    highCreditAmount: 30000,
    termsAmount: 5000,
    dateOpened: "2022-06-01",
    dateReported: "2026-02-15",
    dbt30: 0,
    dbt60: 0,
    dbt90: 0,
    comments: ["Good standing"]
  };

  const result = mapBusinessTrade(trade);
  assert.equal(result.tradeline_key, "business:OFFICE DEPOT:2026-02-15");
  assert.equal(result.creditor_name, "OFFICE DEPOT");
  assert.equal(result.account_type, "Trade");
  assert.equal(result.account_status, "Active");
  assert.equal(result.bureau, "Experian Business");
  assert.equal(result.credit_limit, 50000);
  assert.equal(result.current_balance, 25000);
  assert.equal(result.monthly_payment, 5000);
  assert.equal(result.high_balance, 30000);
  assert.equal(result.date_opened, "2022-06-01");
  assert.equal(result.date_reported, "2026-02-15");
  assert.equal(result.payment_status, "Current");
  assert.equal(result.dbt_30, 0);
  assert.equal(result.dbt_60, 0);
  assert.equal(result.dbt_90, 0);
  assert.equal(result.remarks, "Good standing");
});

test("mapBusinessTrade: derives payment status from dbt90", () => {
  const trade = { businessName: "X", dbt30: 5, dbt60: 3, dbt90: 2 };
  const result = mapBusinessTrade(trade);
  assert.equal(result.payment_status, "90+ Days Beyond Terms");
});

test("mapBusinessTrade: derives payment status from dbt60", () => {
  const trade = { businessName: "X", dbt30: 5, dbt60: 3, dbt90: 0 };
  const result = mapBusinessTrade(trade);
  assert.equal(result.payment_status, "60 Days Beyond Terms");
});

test("mapBusinessTrade: derives payment status from dbt30", () => {
  const trade = { businessName: "X", dbt30: 5, dbt60: 0, dbt90: 0 };
  const result = mapBusinessTrade(trade);
  assert.equal(result.payment_status, "30 Days Beyond Terms");
});

test("mapBusinessTrade: handles null dbt values", () => {
  const trade = { businessName: "X" };
  const result = mapBusinessTrade(trade);
  assert.equal(result.dbt_30, null);
  assert.equal(result.dbt_60, null);
  assert.equal(result.dbt_90, null);
  assert.equal(result.payment_status, "Current");
});

// ============================================================================
// extractBusinessTradelines
// ============================================================================

test("extractBusinessTradelines: returns empty for null input", () => {
  assert.deepEqual(extractBusinessTradelines(null), []);
});

test("extractBusinessTradelines: returns empty for empty data", () => {
  assert.deepEqual(extractBusinessTradelines({}), []);
});

test("extractBusinessTradelines: extracts from tradePaymentExperiences", () => {
  const report = {
    data: {
      tradePaymentExperiences: [
        {
          businessName: "STAPLES",
          accountType: "Trade",
          accountStatus: "Active",
          dbt30: 0,
          dbt60: 0,
          dbt90: 0,
          dateReported: "2026-01-01"
        }
      ]
    }
  };
  const result = extractBusinessTradelines(report);
  assert.equal(result.length, 1);
  assert.equal(result[0].creditor_name, "STAPLES");
});

test("extractBusinessTradelines: extracts from tradeLines fallback", () => {
  const report = {
    data: {
      tradeLines: [
        {
          businessName: "DELL",
          accountType: "Lease",
          accountStatus: "Active",
          dbt30: 0,
          dbt60: 0,
          dbt90: 0,
          dateReported: "2026-02-01"
        }
      ]
    }
  };
  const result = extractBusinessTradelines(report);
  assert.equal(result.length, 1);
  assert.equal(result[0].creditor_name, "DELL");
});

test("extractBusinessTradelines: handles nested data structure", () => {
  const report = {
    data: {
      tradePaymentExperiences: [
        { businessName: "A", dateReported: "2026-01-01" },
        { businessName: "B", dateReported: "2026-02-01" }
      ]
    }
  };
  const result = extractBusinessTradelines(report);
  assert.equal(result.length, 2);
});

test("extractBusinessTradelines: handles flat data (no .data wrapper)", () => {
  const report = {
    tradePaymentExperiences: [{ businessName: "DIRECT", dateReported: "2026-01-01" }]
  };
  const result = extractBusinessTradelines(report);
  assert.equal(result.length, 1);
  assert.equal(result[0].creditor_name, "DIRECT");
});

// ============================================================================
// Constants
// ============================================================================

test("ACCOUNT_TYPE_LABELS: covers all expected types", () => {
  assert.ok(ACCOUNT_TYPE_LABELS.revolving);
  assert.ok(ACCOUNT_TYPE_LABELS.installment);
  assert.ok(ACCOUNT_TYPE_LABELS.mortgage);
  assert.ok(ACCOUNT_TYPE_LABELS.open);
  assert.ok(ACCOUNT_TYPE_LABELS.unknown);
});

test("STATUS_LABELS: covers all expected statuses", () => {
  assert.ok(STATUS_LABELS.open);
  assert.ok(STATUS_LABELS.closed);
  assert.ok(STATUS_LABELS.paid);
  assert.ok(STATUS_LABELS.transferred);
  assert.ok(STATUS_LABELS.unknown);
});

test("BUREAU_LABELS: covers all expected bureaus", () => {
  assert.ok(BUREAU_LABELS.transunion);
  assert.ok(BUREAU_LABELS.experian);
  assert.ok(BUREAU_LABELS.equifax);
  assert.ok(BUREAU_LABELS.unknown);
});
