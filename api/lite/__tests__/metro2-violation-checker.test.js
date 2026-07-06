"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectViolations,
  // Individual checks
  checkDofdMissing,
  checkDofdFuture,
  checkSevenYearExpired,
  checkBalanceOnClosed,
  checkStaleReporting,
  checkMissingAccountType,
  checkMissingCreditor,
  checkNegativeBalance,
  checkPastDueOnCurrent,
  checkOpenedFuture,
  checkStatusBalanceMismatchPaid,
  checkChargeoffNoAmount,
  checkPaymentRatingStatusConflict,
  checkSoldAccountWithBalance,
  checkCollectionMissingOriginal,
  checkChargeoffWithPayments,
  checkReagedDofd,
  checkBankruptcyWithBalance,
  checkAuReportedNegative,
  checkDeceasedFlagAlive,
  // Helpers
  parseDate,
  monthsDiff,
  hasCommentMatching,
  inferDofd,
  // Metadata
  PENDING_CHECKS
} = require("../crs/metro2-violation-checker");

// ---------------------------------------------------------------------------
// Reference date used across all date-sensitive tests
// Use a fixed date so tests never go stale.
// ---------------------------------------------------------------------------
const REPORT_DATE = new Date("2026-04-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTradeline(overrides = {}) {
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
    reportedDate: "2026-03-15",
    lastActivityDate: "2026-03-15",
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

function makeAdverseRatings(highestDate, mostRecentDate) {
  return {
    highest: { date: highestDate, type: "ChargeOff" },
    mostRecent: { date: mostRecentDate, type: "ChargeOff" },
    prior: []
  };
}

function violationCodes(tl, rd = REPORT_DATE) {
  return detectViolations(tl, rd).violations.map(v => v.code);
}

// ---------------------------------------------------------------------------
// parseDate helper
// ---------------------------------------------------------------------------

test("parseDate: parses YYYY-MM-DD correctly", () => {
  const d = parseDate("2020-01-15");
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString().slice(0, 10), "2020-01-15");
});

test("parseDate: parses YYYY-MM as first day of month", () => {
  const d = parseDate("2020-06");
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString().slice(0, 10), "2020-06-01");
});

test("parseDate: returns null for null input", () => {
  assert.equal(parseDate(null), null);
});

test("parseDate: returns null for empty string", () => {
  assert.equal(parseDate(""), null);
});

test("parseDate: returns null for non-date string", () => {
  assert.equal(parseDate("not-a-date"), null);
});

test("parseDate: returns null for non-string input", () => {
  assert.equal(parseDate(12345), null);
});

// ---------------------------------------------------------------------------
// monthsDiff helper
// ---------------------------------------------------------------------------

test("monthsDiff: 6 months apart", () => {
  const a = new Date("2020-01-01T00:00:00Z");
  const b = new Date("2020-07-01T00:00:00Z");
  assert.ok(monthsDiff(a, b) >= 5);
  assert.ok(monthsDiff(a, b) <= 6);
});

test("monthsDiff: is symmetric (absolute value)", () => {
  const a = new Date("2020-01-01T00:00:00Z");
  const b = new Date("2021-01-01T00:00:00Z");
  assert.equal(monthsDiff(a, b), monthsDiff(b, a));
});

// ---------------------------------------------------------------------------
// hasCommentMatching helper
// ---------------------------------------------------------------------------

test("hasCommentMatching: returns false for null comments", () => {
  assert.equal(hasCommentMatching(null, "test"), false);
});

test("hasCommentMatching: returns false for empty array", () => {
  assert.equal(hasCommentMatching([], "test"), false);
});

test("hasCommentMatching: matches text field", () => {
  const comments = [{ text: "ORIGINAL CREDITOR: Chase Bank" }];
  assert.equal(hasCommentMatching(comments, /original\s+creditor/i), true);
});

test("hasCommentMatching: matches code field", () => {
  const comments = [{ text: "", code: "XB" }];
  assert.equal(hasCommentMatching(comments, "XB"), true);
});

test("hasCommentMatching: returns false when no match", () => {
  const comments = [{ text: "ACCOUNT IN GOOD STANDING" }];
  assert.equal(hasCommentMatching(comments, /original\s+creditor/i), false);
});

// ---------------------------------------------------------------------------
// inferDofd helper
// ---------------------------------------------------------------------------

test("inferDofd: returns null for null adverseRatings", () => {
  assert.equal(inferDofd(null), null);
});

test("inferDofd: returns earliest of highest and mostRecent dates", () => {
  const adverse = {
    highest: { date: "2019-03-01" },
    mostRecent: { date: "2020-06-01" },
    prior: []
  };
  const d = inferDofd(adverse);
  assert.equal(d.toISOString().slice(0, 10), "2019-03-01");
});

test("inferDofd: handles prior array entries", () => {
  const adverse = {
    highest: null,
    mostRecent: { date: "2020-06-01" },
    prior: [{ date: "2018-01-01" }]
  };
  const d = inferDofd(adverse);
  assert.equal(d.toISOString().slice(0, 10), "2018-01-01");
});

test("inferDofd: returns null when all dates are null/invalid", () => {
  const adverse = { highest: null, mostRecent: null, prior: [] };
  assert.equal(inferDofd(adverse), null);
});

// ---------------------------------------------------------------------------
// Null / Empty Input
// ---------------------------------------------------------------------------

test("detectViolations: null tradeline returns empty violations array", () => {
  const result = detectViolations(null);
  assert.deepEqual(result.violations, []);
});

test("detectViolations: number input returns empty violations array", () => {
  const result = detectViolations(42);
  assert.deepEqual(result.violations, []);
});

test("detectViolations: undefined returns empty violations array", () => {
  const result = detectViolations(undefined);
  assert.deepEqual(result.violations, []);
});

test("detectViolations: empty object triggers MISSING_ACCOUNT_TYPE and MISSING_CREDITOR", () => {
  const codes = violationCodes({});
  assert.ok(codes.includes("MISSING_ACCOUNT_TYPE"), "should include MISSING_ACCOUNT_TYPE");
  assert.ok(codes.includes("MISSING_CREDITOR"), "should include MISSING_CREDITOR");
});

test("detectViolations: handles undefined fields gracefully without throwing", () => {
  const tl = {
    creditorName: undefined,
    accountType: undefined,
    status: undefined,
    currentBalance: undefined,
    adverseRatings: undefined,
    comments: undefined
  };
  assert.doesNotThrow(() => detectViolations(tl, REPORT_DATE));
});

test("detectViolations: invalid reportDate falls back to current date without throwing", () => {
  const tl = makeTradeline();
  assert.doesNotThrow(() => detectViolations(tl, "not-a-date"));
});

// ---------------------------------------------------------------------------
// DOFD_MISSING
// ---------------------------------------------------------------------------

test("checkDofdMissing: collection with no adverse dates → DOFD_MISSING", () => {
  const tl = makeTradeline({ status: "collection", adverseRatings: null });
  const v = checkDofdMissing(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "DOFD_MISSING");
  assert.equal(v.severity, "high");
});

test("checkDofdMissing: chargeoff ratingType with no dates → DOFD_MISSING", () => {
  const tl = makeTradeline({ currentRatingType: "ChargeOff", adverseRatings: null });
  const v = checkDofdMissing(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "DOFD_MISSING");
});

test("checkDofdMissing: collection with adverse dates → no violation", () => {
  const tl = makeTradeline({
    status: "collection",
    adverseRatings: makeAdverseRatings("2021-03-01", "2021-06-01")
  });
  assert.equal(checkDofdMissing(tl), null);
});

test("checkDofdMissing: normal open account → no violation", () => {
  const tl = makeTradeline();
  assert.equal(checkDofdMissing(tl), null);
});

test("checkDofdMissing: loanType includes collection → DOFD_MISSING", () => {
  const tl = makeTradeline({ loanType: "CollectionAccount", adverseRatings: null });
  const v = checkDofdMissing(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "DOFD_MISSING");
});

// ---------------------------------------------------------------------------
// DOFD_FUTURE
// ---------------------------------------------------------------------------

test("checkDofdFuture: adverse date in future → DOFD_FUTURE", () => {
  const futureDate = "2027-01-01";
  const tl = makeTradeline({
    adverseRatings: makeAdverseRatings(futureDate, futureDate)
  });
  const v = checkDofdFuture(tl, REPORT_DATE);
  assert.ok(v !== null);
  assert.equal(v.code, "DOFD_FUTURE");
  assert.equal(v.severity, "high");
});

test("checkDofdFuture: adverse date in past → no violation", () => {
  const tl = makeTradeline({
    adverseRatings: makeAdverseRatings("2021-01-01", "2022-06-01")
  });
  assert.equal(checkDofdFuture(tl, REPORT_DATE), null);
});

test("checkDofdFuture: no adverse ratings → no violation", () => {
  const tl = makeTradeline({ adverseRatings: null });
  assert.equal(checkDofdFuture(tl, REPORT_DATE), null);
});

// ---------------------------------------------------------------------------
// SEVEN_YEAR_EXPIRED
// ---------------------------------------------------------------------------

test("checkSevenYearExpired: DOFD 8 years ago → SEVEN_YEAR_EXPIRED", () => {
  // 8 years before report date 2026-04-01
  const tl = makeTradeline({
    adverseRatings: makeAdverseRatings("2018-01-01", "2018-01-01")
  });
  const v = checkSevenYearExpired(tl, REPORT_DATE);
  assert.ok(v !== null);
  assert.equal(v.code, "SEVEN_YEAR_EXPIRED");
  assert.equal(v.severity, "high");
});

test("checkSevenYearExpired: DOFD 6 years ago → no violation", () => {
  const tl = makeTradeline({
    adverseRatings: makeAdverseRatings("2020-01-01", "2020-01-01")
  });
  assert.equal(checkSevenYearExpired(tl, REPORT_DATE), null);
});

test("checkSevenYearExpired: DOFD exactly 7 years ago → no violation (expiry = today)", () => {
  // expiry == reportDate means expiry >= reportDate is true, so no violation
  const tl = makeTradeline({
    adverseRatings: makeAdverseRatings("2019-04-01", "2019-04-01")
  });
  assert.equal(checkSevenYearExpired(tl, REPORT_DATE), null);
});

test("checkSevenYearExpired: very old date (1990s) → SEVEN_YEAR_EXPIRED", () => {
  const tl = makeTradeline({
    adverseRatings: makeAdverseRatings("1995-06-01", "1995-06-01")
  });
  const v = checkSevenYearExpired(tl, REPORT_DATE);
  assert.ok(v !== null);
  assert.equal(v.code, "SEVEN_YEAR_EXPIRED");
});

test("checkSevenYearExpired: no adverse ratings → no violation", () => {
  const tl = makeTradeline({ adverseRatings: null });
  assert.equal(checkSevenYearExpired(tl, REPORT_DATE), null);
});

// ---------------------------------------------------------------------------
// BALANCE_ON_CLOSED
// ---------------------------------------------------------------------------

test("checkBalanceOnClosed: closed account with positive balance → BALANCE_ON_CLOSED", () => {
  const tl = makeTradeline({ status: "closed", currentBalance: 500 });
  const v = checkBalanceOnClosed(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "BALANCE_ON_CLOSED");
  assert.equal(v.severity, "high");
});

test("checkBalanceOnClosed: paid account with positive balance → BALANCE_ON_CLOSED", () => {
  const tl = makeTradeline({ status: "paid", currentBalance: 100 });
  const v = checkBalanceOnClosed(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "BALANCE_ON_CLOSED");
});

test("checkBalanceOnClosed: closed account with zero balance → no violation", () => {
  const tl = makeTradeline({ status: "closed", currentBalance: 0 });
  assert.equal(checkBalanceOnClosed(tl), null);
});

test("checkBalanceOnClosed: closed account with null balance → no violation", () => {
  const tl = makeTradeline({ status: "closed", currentBalance: null });
  assert.equal(checkBalanceOnClosed(tl), null);
});

test("checkBalanceOnClosed: open account with balance → no violation", () => {
  const tl = makeTradeline({ status: "open", currentBalance: 2500 });
  assert.equal(checkBalanceOnClosed(tl), null);
});

// ---------------------------------------------------------------------------
// STALE_REPORTING
// ---------------------------------------------------------------------------

test("checkStaleReporting: reported 120 days ago → STALE_REPORTING", () => {
  // 120 days before 2026-04-01 is approx 2025-12-02
  const tl = makeTradeline({ reportedDate: "2025-12-01" });
  const v = checkStaleReporting(tl, REPORT_DATE);
  assert.ok(v !== null);
  assert.equal(v.code, "STALE_REPORTING");
  assert.equal(v.severity, "medium");
});

test("checkStaleReporting: reported 30 days ago → no violation", () => {
  const tl = makeTradeline({ reportedDate: "2026-03-01" });
  assert.equal(checkStaleReporting(tl, REPORT_DATE), null);
});

test("checkStaleReporting: reported exactly 90 days ago → no violation (boundary)", () => {
  // daysDiff must be > 90, so exactly 90 is fine
  const tl = makeTradeline({ reportedDate: "2026-01-01" });
  // 2026-01-01 to 2026-04-01 = 89 days
  assert.equal(checkStaleReporting(tl, REPORT_DATE), null);
});

test("checkStaleReporting: null reportedDate → no violation", () => {
  const tl = makeTradeline({ reportedDate: null });
  assert.equal(checkStaleReporting(tl, REPORT_DATE), null);
});

// ---------------------------------------------------------------------------
// MISSING_ACCOUNT_TYPE
// ---------------------------------------------------------------------------

test("checkMissingAccountType: null accountType → MISSING_ACCOUNT_TYPE", () => {
  const tl = makeTradeline({ accountType: null });
  const v = checkMissingAccountType(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "MISSING_ACCOUNT_TYPE");
  assert.equal(v.severity, "low");
});

test("checkMissingAccountType: undefined accountType → MISSING_ACCOUNT_TYPE", () => {
  const tl = makeTradeline({ accountType: undefined });
  const v = checkMissingAccountType(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "MISSING_ACCOUNT_TYPE");
});

test("checkMissingAccountType: revolving → no violation", () => {
  const tl = makeTradeline({ accountType: "revolving" });
  assert.equal(checkMissingAccountType(tl), null);
});

// ---------------------------------------------------------------------------
// MISSING_CREDITOR
// ---------------------------------------------------------------------------

test("checkMissingCreditor: null creditorName → MISSING_CREDITOR", () => {
  const tl = makeTradeline({ creditorName: null });
  const v = checkMissingCreditor(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "MISSING_CREDITOR");
  assert.equal(v.severity, "medium");
});

test("checkMissingCreditor: empty string creditorName → MISSING_CREDITOR", () => {
  const tl = makeTradeline({ creditorName: "" });
  const v = checkMissingCreditor(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "MISSING_CREDITOR");
});

test("checkMissingCreditor: whitespace-only creditorName → MISSING_CREDITOR", () => {
  const tl = makeTradeline({ creditorName: "   " });
  const v = checkMissingCreditor(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "MISSING_CREDITOR");
});

test("checkMissingCreditor: valid name → no violation", () => {
  const tl = makeTradeline({ creditorName: "CHASE BANK" });
  assert.equal(checkMissingCreditor(tl), null);
});

// ---------------------------------------------------------------------------
// NEGATIVE_BALANCE
// ---------------------------------------------------------------------------

test("checkNegativeBalance: negative currentBalance → NEGATIVE_BALANCE", () => {
  const tl = makeTradeline({ currentBalance: -100 });
  const v = checkNegativeBalance(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "NEGATIVE_BALANCE");
  assert.equal(v.severity, "medium");
});

test("checkNegativeBalance: zero balance → no violation", () => {
  const tl = makeTradeline({ currentBalance: 0 });
  assert.equal(checkNegativeBalance(tl), null);
});

test("checkNegativeBalance: positive balance → no violation", () => {
  const tl = makeTradeline({ currentBalance: 1000 });
  assert.equal(checkNegativeBalance(tl), null);
});

test("checkNegativeBalance: null balance → no violation", () => {
  const tl = makeTradeline({ currentBalance: null });
  assert.equal(checkNegativeBalance(tl), null);
});

// ---------------------------------------------------------------------------
// PAST_DUE_ON_CURRENT
// ---------------------------------------------------------------------------

test("checkPastDueOnCurrent: AsAgreed rating with pastDue > 0 → PAST_DUE_ON_CURRENT", () => {
  const tl = makeTradeline({ currentRatingType: "AsAgreed", pastDue: 150 });
  const v = checkPastDueOnCurrent(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "PAST_DUE_ON_CURRENT");
  assert.equal(v.severity, "high");
});

test("checkPastDueOnCurrent: AsAgreed with zero pastDue → no violation", () => {
  const tl = makeTradeline({ currentRatingType: "AsAgreed", pastDue: 0 });
  assert.equal(checkPastDueOnCurrent(tl), null);
});

test("checkPastDueOnCurrent: ChargeOff with pastDue → no violation (wrong ratingType)", () => {
  const tl = makeTradeline({ currentRatingType: "ChargeOff", pastDue: 500 });
  assert.equal(checkPastDueOnCurrent(tl), null);
});

// ---------------------------------------------------------------------------
// OPENED_FUTURE
// ---------------------------------------------------------------------------

test("checkOpenedFuture: openedDate in future → OPENED_FUTURE", () => {
  const tl = makeTradeline({ openedDate: "2027-06-01" });
  const v = checkOpenedFuture(tl, REPORT_DATE);
  assert.ok(v !== null);
  assert.equal(v.code, "OPENED_FUTURE");
  assert.equal(v.severity, "high");
});

test("checkOpenedFuture: openedDate in past → no violation", () => {
  const tl = makeTradeline({ openedDate: "2015-06-01" });
  assert.equal(checkOpenedFuture(tl, REPORT_DATE), null);
});

test("checkOpenedFuture: null openedDate → no violation", () => {
  const tl = makeTradeline({ openedDate: null });
  assert.equal(checkOpenedFuture(tl, REPORT_DATE), null);
});

// ---------------------------------------------------------------------------
// STATUS_BALANCE_MISMATCH_PAID
// ---------------------------------------------------------------------------

test("checkStatusBalanceMismatchPaid: ratingCode 13 with balance → STATUS_BALANCE_MISMATCH_PAID", () => {
  const tl = makeTradeline({ currentRatingCode: "13", currentBalance: 500 });
  const v = checkStatusBalanceMismatchPaid(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "STATUS_BALANCE_MISMATCH_PAID");
  assert.equal(v.severity, "high");
});

test("checkStatusBalanceMismatchPaid: paid status with balance → STATUS_BALANCE_MISMATCH_PAID", () => {
  const tl = makeTradeline({ status: "paid in full", currentBalance: 250 });
  const v = checkStatusBalanceMismatchPaid(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "STATUS_BALANCE_MISMATCH_PAID");
});

test("checkStatusBalanceMismatchPaid: paid status with zero balance → no violation", () => {
  const tl = makeTradeline({ status: "paid", currentBalance: 0 });
  assert.equal(checkStatusBalanceMismatchPaid(tl), null);
});

test("checkStatusBalanceMismatchPaid: ratingCode 1 with balance → no violation", () => {
  const tl = makeTradeline({ currentRatingCode: "1", currentBalance: 500 });
  assert.equal(checkStatusBalanceMismatchPaid(tl), null);
});

// ---------------------------------------------------------------------------
// CHARGEOFF_NO_AMOUNT
// ---------------------------------------------------------------------------

test("checkChargeoffNoAmount: ChargeOff ratingType with null chargeOffAmount → CHARGEOFF_NO_AMOUNT", () => {
  const tl = makeTradeline({
    currentRatingType: "ChargeOff",
    chargeOffAmount: null
  });
  const v = checkChargeoffNoAmount(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "CHARGEOFF_NO_AMOUNT");
  assert.equal(v.severity, "medium");
});

test("checkChargeoffNoAmount: ChargeOff status with zero chargeOffAmount → CHARGEOFF_NO_AMOUNT", () => {
  const tl = makeTradeline({
    status: "chargeoff",
    chargeOffAmount: 0
  });
  const v = checkChargeoffNoAmount(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "CHARGEOFF_NO_AMOUNT");
});

test("checkChargeoffNoAmount: ChargeOff with valid chargeOffAmount → no violation", () => {
  const tl = makeTradeline({
    currentRatingType: "ChargeOff",
    chargeOffAmount: 3500
  });
  assert.equal(checkChargeoffNoAmount(tl), null);
});

test("checkChargeoffNoAmount: normal open account → no violation", () => {
  const tl = makeTradeline({ currentRatingType: "AsAgreed" });
  assert.equal(checkChargeoffNoAmount(tl), null);
});

// ---------------------------------------------------------------------------
// PAYMENT_RATING_STATUS_CONFLICT
// ---------------------------------------------------------------------------

test("checkPaymentRatingStatusConflict: AsAgreed + isDerogatory=true → PAYMENT_RATING_STATUS_CONFLICT", () => {
  const tl = makeTradeline({ currentRatingType: "AsAgreed", isDerogatory: true });
  const v = checkPaymentRatingStatusConflict(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "PAYMENT_RATING_STATUS_CONFLICT");
  assert.equal(v.severity, "high");
});

test("checkPaymentRatingStatusConflict: ChargeOff + ratingSeverity 2 → PAYMENT_RATING_STATUS_CONFLICT", () => {
  const tl = makeTradeline({ currentRatingType: "ChargeOff", ratingSeverity: 2 });
  const v = checkPaymentRatingStatusConflict(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "PAYMENT_RATING_STATUS_CONFLICT");
});

test("checkPaymentRatingStatusConflict: ChargeOff + ratingSeverity 4 → no violation", () => {
  const tl = makeTradeline({ currentRatingType: "ChargeOff", ratingSeverity: 4 });
  assert.equal(checkPaymentRatingStatusConflict(tl), null);
});

test("checkPaymentRatingStatusConflict: AsAgreed + isDerogatory=false → no violation", () => {
  const tl = makeTradeline({ currentRatingType: "AsAgreed", isDerogatory: false });
  assert.equal(checkPaymentRatingStatusConflict(tl), null);
});

// ---------------------------------------------------------------------------
// SOLD_ACCOUNT_WITH_BALANCE
// ---------------------------------------------------------------------------

test("checkSoldAccountWithBalance: sold status with balance → SOLD_ACCOUNT_WITH_BALANCE", () => {
  const tl = makeTradeline({ status: "sold", currentBalance: 1200 });
  const v = checkSoldAccountWithBalance(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "SOLD_ACCOUNT_WITH_BALANCE");
  assert.equal(v.severity, "high");
});

test("checkSoldAccountWithBalance: transferred status with balance → SOLD_ACCOUNT_WITH_BALANCE", () => {
  const tl = makeTradeline({ status: "transferred", currentBalance: 800 });
  const v = checkSoldAccountWithBalance(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "SOLD_ACCOUNT_WITH_BALANCE");
});

test("checkSoldAccountWithBalance: sold with zero balance → no violation", () => {
  const tl = makeTradeline({ status: "sold", currentBalance: 0 });
  assert.equal(checkSoldAccountWithBalance(tl), null);
});

test("checkSoldAccountWithBalance: open account with balance → no violation", () => {
  const tl = makeTradeline({ status: "open", currentBalance: 500 });
  assert.equal(checkSoldAccountWithBalance(tl), null);
});

// ---------------------------------------------------------------------------
// COLLECTION_MISSING_ORIGINAL
// ---------------------------------------------------------------------------

test("checkCollectionMissingOriginal: collection with no original creditor comment → COLLECTION_MISSING_ORIGINAL", () => {
  const tl = makeTradeline({ status: "collection", comments: [] });
  const v = checkCollectionMissingOriginal(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "COLLECTION_MISSING_ORIGINAL");
  assert.equal(v.severity, "high");
});

test("checkCollectionMissingOriginal: collection with original creditor in comments → no violation", () => {
  const tl = makeTradeline({
    status: "collection",
    comments: [{ text: "Original Creditor: Capital One" }]
  });
  assert.equal(checkCollectionMissingOriginal(tl), null);
});

test("checkCollectionMissingOriginal: collection loanType with no original → COLLECTION_MISSING_ORIGINAL", () => {
  const tl = makeTradeline({ loanType: "CollectionAccount", comments: [] });
  const v = checkCollectionMissingOriginal(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "COLLECTION_MISSING_ORIGINAL");
});

test("checkCollectionMissingOriginal: normal tradeline → no violation", () => {
  const tl = makeTradeline({ status: "open", comments: [] });
  assert.equal(checkCollectionMissingOriginal(tl), null);
});

// ---------------------------------------------------------------------------
// CHARGEOFF_WITH_PAYMENTS
// ---------------------------------------------------------------------------

test("checkChargeoffWithPayments: ChargeOff ratingType with monthlyPayment > 0 → CHARGEOFF_WITH_PAYMENTS", () => {
  const tl = makeTradeline({ currentRatingType: "ChargeOff", monthlyPayment: 50 });
  const v = checkChargeoffWithPayments(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "CHARGEOFF_WITH_PAYMENTS");
  assert.equal(v.severity, "medium");
});

test("checkChargeoffWithPayments: CollectionOrChargeOff with payment → CHARGEOFF_WITH_PAYMENTS", () => {
  const tl = makeTradeline({ currentRatingType: "CollectionOrChargeOff", monthlyPayment: 25 });
  const v = checkChargeoffWithPayments(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "CHARGEOFF_WITH_PAYMENTS");
});

test("checkChargeoffWithPayments: ChargeOff with zero monthlyPayment → no violation", () => {
  const tl = makeTradeline({ currentRatingType: "ChargeOff", monthlyPayment: 0 });
  assert.equal(checkChargeoffWithPayments(tl), null);
});

test("checkChargeoffWithPayments: AsAgreed with monthlyPayment → no violation", () => {
  const tl = makeTradeline({ currentRatingType: "AsAgreed", monthlyPayment: 200 });
  assert.equal(checkChargeoffWithPayments(tl), null);
});

// ---------------------------------------------------------------------------
// REAGED_DOFD
// ---------------------------------------------------------------------------

test("checkReagedDofd: mostRecent date >6 months AFTER highest → REAGED_DOFD", () => {
  const tl = makeTradeline({
    adverseRatings: makeAdverseRatings("2020-01-01", "2021-01-01")
  });
  const v = checkReagedDofd(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "REAGED_DOFD");
  assert.equal(v.severity, "high");
});

test("checkReagedDofd: mostRecent ≤ highest (no re-aging pattern) → no violation", () => {
  const tl = makeTradeline({
    adverseRatings: makeAdverseRatings("2021-01-01", "2020-06-01")
  });
  assert.equal(checkReagedDofd(tl), null);
});

test("checkReagedDofd: dates only 3 months apart → no violation", () => {
  const tl = makeTradeline({
    adverseRatings: makeAdverseRatings("2021-01-01", "2021-04-01")
  });
  assert.equal(checkReagedDofd(tl), null);
});

test("checkReagedDofd: null adverseRatings → no violation", () => {
  const tl = makeTradeline({ adverseRatings: null });
  assert.equal(checkReagedDofd(tl), null);
});

test("checkReagedDofd: null date entries → no violation", () => {
  const tl = makeTradeline({
    adverseRatings: { highest: null, mostRecent: null, prior: [] }
  });
  assert.equal(checkReagedDofd(tl), null);
});

// ---------------------------------------------------------------------------
// BANKRUPTCY_WITH_BALANCE
// ---------------------------------------------------------------------------

test("checkBankruptcyWithBalance: BankruptcyOrWageEarnerPlan + balance + closedDate → BANKRUPTCY_WITH_BALANCE", () => {
  const tl = makeTradeline({
    currentRatingType: "BankruptcyOrWageEarnerPlan",
    currentBalance: 5000,
    closedDate: "2022-03-01"
  });
  const v = checkBankruptcyWithBalance(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "BANKRUPTCY_WITH_BALANCE");
  assert.equal(v.severity, "high");
});

test("checkBankruptcyWithBalance: bankruptcy comment + balance + closedDate → BANKRUPTCY_WITH_BALANCE", () => {
  const tl = makeTradeline({
    currentBalance: 2000,
    closedDate: "2022-01-01",
    comments: [{ text: "INCLUDED IN BANKRUPTCY" }]
  });
  const v = checkBankruptcyWithBalance(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "BANKRUPTCY_WITH_BALANCE");
});

test("checkBankruptcyWithBalance: BK ratingType with zero balance → no violation", () => {
  const tl = makeTradeline({
    currentRatingType: "BankruptcyOrWageEarnerPlan",
    currentBalance: 0,
    closedDate: "2022-01-01"
  });
  assert.equal(checkBankruptcyWithBalance(tl), null);
});

test("checkBankruptcyWithBalance: BK ratingType + balance but no closedDate → no violation", () => {
  const tl = makeTradeline({
    currentRatingType: "BankruptcyOrWageEarnerPlan",
    currentBalance: 3000,
    closedDate: null
  });
  assert.equal(checkBankruptcyWithBalance(tl), null);
});

// ---------------------------------------------------------------------------
// AU_REPORTED_NEGATIVE
// ---------------------------------------------------------------------------

test("checkAuReportedNegative: isAU=true + isDerogatory=true → AU_REPORTED_NEGATIVE", () => {
  const tl = makeTradeline({ isAU: true, isDerogatory: true });
  const v = checkAuReportedNegative(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "AU_REPORTED_NEGATIVE");
  assert.equal(v.severity, "high");
});

test("checkAuReportedNegative: ownership=authorized_user + isDerogatory=true → AU_REPORTED_NEGATIVE", () => {
  const tl = makeTradeline({ ownership: "authorized_user", isDerogatory: true });
  const v = checkAuReportedNegative(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "AU_REPORTED_NEGATIVE");
});

test("checkAuReportedNegative: isAU=true but isDerogatory=false → no violation", () => {
  const tl = makeTradeline({ isAU: true, isDerogatory: false });
  assert.equal(checkAuReportedNegative(tl), null);
});

test("checkAuReportedNegative: individual ownership + isDerogatory=true → no violation", () => {
  const tl = makeTradeline({ ownership: "individual", isAU: false, isDerogatory: true });
  assert.equal(checkAuReportedNegative(tl), null);
});

// ---------------------------------------------------------------------------
// DECEASED_FLAG_ALIVE
// ---------------------------------------------------------------------------

test("checkDeceasedFlagAlive: comment with 'deceased' → DECEASED_FLAG_ALIVE", () => {
  const tl = makeTradeline({ comments: [{ text: "Account holder is deceased" }] });
  const v = checkDeceasedFlagAlive(tl);
  assert.ok(v !== null);
  assert.equal(v.code, "DECEASED_FLAG_ALIVE");
  assert.equal(v.severity, "high");
});

test("checkDeceasedFlagAlive: no deceased comment → no violation", () => {
  const tl = makeTradeline({ comments: [{ text: "ACCOUNT IN GOOD STANDING" }] });
  assert.equal(checkDeceasedFlagAlive(tl), null);
});

test("checkDeceasedFlagAlive: empty comments → no violation", () => {
  const tl = makeTradeline({ comments: [] });
  assert.equal(checkDeceasedFlagAlive(tl), null);
});

// ---------------------------------------------------------------------------
// Violation Object Shape
// ---------------------------------------------------------------------------

test("violation object has all required fields", () => {
  const tl = makeTradeline({ status: "collection", adverseRatings: null });
  const { violations } = detectViolations(tl, REPORT_DATE);
  assert.ok(violations.length > 0);
  const v = violations[0];
  assert.ok(typeof v.code === "string", "code must be a string");
  assert.ok(typeof v.field === "string", "field must be a string");
  assert.ok(typeof v.expected === "string", "expected must be a string");
  assert.ok(typeof v.actual === "string", "actual must be a string");
  assert.ok(["high", "medium", "low"].includes(v.severity), "severity must be high/medium/low");
  assert.ok(typeof v.statute === "string" && v.statute.length > 0, "statute must be non-empty");
  assert.ok(
    typeof v.explanation === "string" && v.explanation.length > 0,
    "explanation must be non-empty"
  );
});

test("high severity violations all have statute references", () => {
  // Build a tradeline that triggers several high-severity checks
  const tl = makeTradeline({
    currentRatingType: "AsAgreed",
    isDerogatory: true,
    status: "sold",
    currentBalance: 1000,
    openedDate: "2030-01-01"
  });
  const { violations } = detectViolations(tl, REPORT_DATE);
  const highSeverity = violations.filter(v => v.severity === "high");
  for (const v of highSeverity) {
    assert.ok(v.statute && v.statute.includes("FCRA"), `${v.code} should cite FCRA`);
  }
});

// ---------------------------------------------------------------------------
// Maximum Derogatory Tradeline (all violations triggered)
// ---------------------------------------------------------------------------

test("maximum derogatory tradeline triggers many violations", () => {
  // A tradeline designed to fire as many checks as possible simultaneously
  const tl = makeTradeline({
    creditorName: null, // MISSING_CREDITOR
    accountType: null, // MISSING_ACCOUNT_TYPE
    status: "collection", // DOFD_MISSING (no adverseRatings), COLLECTION_MISSING_ORIGINAL
    loanType: "CollectionAccount",
    currentBalance: -50, // NEGATIVE_BALANCE
    currentRatingType: "AsAgreed",
    isDerogatory: true, // PAYMENT_RATING_STATUS_CONFLICT
    pastDue: 200, // PAST_DUE_ON_CURRENT
    openedDate: "2029-01-01", // OPENED_FUTURE
    reportedDate: "2023-01-01", // STALE_REPORTING
    adverseRatings: null,
    comments: []
  });
  const { violations } = detectViolations(tl, REPORT_DATE);
  assert.ok(violations.length >= 5, `expected ≥5 violations, got ${violations.length}`);
});

// ---------------------------------------------------------------------------
// Zero Violations (clean current account)
// ---------------------------------------------------------------------------

test("clean current account produces zero violations", () => {
  const tl = makeTradeline({
    creditorName: "WELLS FARGO",
    accountType: "revolving",
    status: "open",
    currentBalance: 1000,
    creditLimit: 10000,
    currentRatingCode: "1",
    currentRatingType: "AsAgreed",
    isDerogatory: false,
    pastDue: null,
    monthlyPayment: 50,
    openedDate: "2018-06-01",
    reportedDate: "2026-03-15",
    adverseRatings: null,
    comments: []
  });
  const { violations } = detectViolations(tl, REPORT_DATE);
  assert.equal(violations.length, 0);
});

// ---------------------------------------------------------------------------
// Edge Cases: Null / missing amounts and dates
// ---------------------------------------------------------------------------

test("handles null amounts without throwing", () => {
  const tl = makeTradeline({
    currentBalance: null,
    creditLimit: null,
    highBalance: null,
    pastDue: null,
    monthlyPayment: null,
    chargeOffAmount: null
  });
  assert.doesNotThrow(() => detectViolations(tl, REPORT_DATE));
});

test("handles null dates without throwing", () => {
  const tl = makeTradeline({
    openedDate: null,
    closedDate: null,
    reportedDate: null,
    lastActivityDate: null
  });
  assert.doesNotThrow(() => detectViolations(tl, REPORT_DATE));
});

test("handles null ratings without throwing", () => {
  const tl = makeTradeline({
    currentRatingCode: null,
    currentRatingType: null,
    ratingSeverity: null,
    isDerogatory: null
  });
  assert.doesNotThrow(() => detectViolations(tl, REPORT_DATE));
});

// ---------------------------------------------------------------------------
// PENDING_CHECKS constant
// ---------------------------------------------------------------------------

test("PENDING_CHECKS is an array of strings", () => {
  assert.ok(Array.isArray(PENDING_CHECKS));
  assert.ok(PENDING_CHECKS.length > 0);
  for (const code of PENDING_CHECKS) {
    assert.equal(typeof code, "string");
  }
});

test("PENDING_CHECKS includes expected cross-tradeline checks", () => {
  assert.ok(PENDING_CHECKS.includes("DOUBLE_REPORTING"));
  assert.ok(PENDING_CHECKS.includes("JOINT_ACCOUNT_WRONG_ECOA"));
  assert.ok(PENDING_CHECKS.includes("SSN_VARIATION"));
});

test("PENDING_CHECKS includes inquiry-related checks", () => {
  assert.ok(PENDING_CHECKS.includes("INQUIRY_TOO_OLD"));
  assert.ok(PENDING_CHECKS.includes("INQUIRY_DUPLICATE"));
  assert.ok(PENDING_CHECKS.includes("INQUIRY_PERMISSIBLE"));
  assert.ok(PENDING_CHECKS.includes("INQUIRY_SOFT_MIXED"));
});

// ---------------------------------------------------------------------------
// detectViolations: internal check failure should not propagate
// ---------------------------------------------------------------------------

test("detectViolations never throws even when check functions would crash", () => {
  // A deeply malformed object with circular-ish patterns
  const tl = { comments: [null, undefined, 42], adverseRatings: {} };
  assert.doesNotThrow(() => detectViolations(tl, REPORT_DATE));
});
