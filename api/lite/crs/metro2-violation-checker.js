"use strict";

/**
 * metro2-violation-checker.js — Metro 2 Violation Detection
 *
 * Implements 30 programmatic Metro 2 violation checks against a single
 * credit report tradeline. Pure deterministic logic — no AI calls,
 * no external dependencies, no throws.
 *
 * Usage:
 *   const { detectViolations } = require("./metro2-violation-checker");
 *   const { violations } = detectViolations(tradeline, reportDate);
 *
 * Each ViolationObject:
 *   {
 *     code:        string  — e.g., "DOFD_MISSING"
 *     field:       string  — Metro 2 field reference
 *     expected:    string  — what the value should be
 *     actual:      string  — what was found
 *     severity:    "high"|"medium"|"low"
 *     statute:     string  — FCRA statute citation
 *     explanation: string  — plain English for dispute letters
 *   }
 *
 * Checks marked as TODO require cross-tradeline data and are listed
 * in PENDING_CHECKS — they are not run by this module.
 */

// ---------------------------------------------------------------------------
// Pending checks (require cross-tradeline data or external context)
// ---------------------------------------------------------------------------

const PENDING_CHECKS = [
  "DOUBLE_REPORTING",         // Check 21 — needs cross-tradeline grouping
  "JOINT_ACCOUNT_WRONG_ECOA", // Check 32 — needs cross-bureau comparison
  "SSN_VARIATION",            // Check 34 — needs PII data
  "INQUIRY_TOO_OLD",          // Check 35 — operates on inquiry objects
  "INQUIRY_DUPLICATE",        // Check 36 — operates on inquiry objects
  "INQUIRY_PERMISSIBLE",      // Check 37 — operates on inquiry objects
  "INQUIRY_SOFT_MIXED",       // Check 38 — operates on inquiry objects
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse "YYYY-MM" or "YYYY-MM-DD" into a Date set to midnight UTC.
 * Returns null if unparseable.
 * @param {string|null} str
 * @returns {Date|null}
 */
function parseDate(str) {
  if (!str || typeof str !== "string") return null;
  const trimmed = str.trim();
  // "YYYY-MM" — treat as first day of the month
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}-01T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  // "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Return the absolute difference in whole months between two Dates.
 * @param {Date} date1
 * @param {Date} date2
 * @returns {number}
 */
function monthsDiff(date1, date2) {
  const ms = Math.abs(date2.getTime() - date1.getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24 * 30.44));
}

/**
 * Return the difference in whole days: date2 - date1 (positive = date2 is later).
 * @param {Date} date1
 * @param {Date} date2
 * @returns {number}
 */
function daysDiff(date1, date2) {
  return Math.floor((date2.getTime() - date1.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Search all comment text fields for a case-insensitive substring or regex.
 * @param {Array|null} comments
 * @param {string|RegExp} pattern
 * @returns {boolean}
 */
function hasCommentMatching(comments, pattern) {
  if (!Array.isArray(comments) || comments.length === 0) return false;
  const re =
    typeof pattern === "string"
      ? new RegExp(pattern, "i")
      : pattern;
  return comments.some((c) => {
    const text = [c.text, c.code, c.type].filter(Boolean).join(" ");
    return re.test(text);
  });
}

/**
 * Infer the Date of First Delinquency from adverseRatings.
 * Returns the earliest adverse date found, or null.
 * @param {object|null} adverseRatings
 * @returns {Date|null}
 */
function inferDofd(adverseRatings) {
  if (!adverseRatings) return null;
  const candidates = [
    adverseRatings.highest?.date,
    adverseRatings.mostRecent?.date,
    ...(adverseRatings.prior || []).map((p) => p?.date),
  ].filter(Boolean);
  const parsed = candidates.map(parseDate).filter(Boolean);
  if (parsed.length === 0) return null;
  return parsed.reduce((min, d) => (d < min ? d : min));
}

/**
 * Determine whether a status string signals closure/payment.
 * @param {string|null} status
 * @returns {boolean}
 */
function statusIndicatesClosed(status) {
  if (!status) return false;
  const lower = status.toLowerCase();
  return lower.includes("closed") || lower.includes("paid");
}

/**
 * Determine whether a status string signals charge-off.
 * @param {string|null} status
 * @returns {boolean}
 */
function statusIndicatesChargeOff(status) {
  if (!status) return false;
  const lower = status.toLowerCase();
  return lower.includes("chargeoff") || lower.includes("charge off") || lower.includes("charge-off");
}

/**
 * Determine whether a status or loanType signals collection.
 * @param {string|null} status
 * @param {string|null} loanType
 * @returns {boolean}
 */
function isCollection(status, loanType) {
  const sl = (status || "").toLowerCase();
  const ll = (loanType || "").toLowerCase();
  return sl.includes("collection") || ll.includes("collection");
}

/**
 * Build a ViolationObject.
 * @param {string} code
 * @param {string} field
 * @param {string} expected
 * @param {string} actual
 * @param {"high"|"medium"|"low"} severity
 * @param {string} statute
 * @param {string} explanation
 * @returns {object}
 */
function makeViolation(code, field, expected, actual, severity, statute, explanation) {
  return { code, field, expected, actual, severity, statute, explanation };
}

// ---------------------------------------------------------------------------
// Individual check functions
// Each returns a ViolationObject or null.
// ---------------------------------------------------------------------------

// --- Universal Checks (10) ---

/**
 * Check 1: DOFD_MISSING
 * Collection/chargeoff with no DOFD inferable.
 */
function checkDofdMissing(tl) {
  const isDerog =
    isCollection(tl.status, tl.loanType) ||
    statusIndicatesChargeOff(tl.status) ||
    tl.currentRatingType === "ChargeOff" ||
    tl.currentRatingType === "CollectionOrChargeOff";
  if (!isDerog) return null;
  const dofd = inferDofd(tl.adverseRatings);
  if (dofd !== null) return null;
  return makeViolation(
    "DOFD_MISSING",
    "Field 25 (DOFD)",
    "Date of First Delinquency must be reported for derogatory accounts",
    "No date of first delinquency inferable from adverse rating history",
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "The creditor is required to report the date of first delinquency for collection and charge-off accounts. Without this date, the 7-year removal clock cannot be verified. This account may be reporting past its legal expiration."
  );
}

/**
 * Check 2: DOFD_FUTURE
 * DOFD is in the future.
 */
function checkDofdFuture(tl, reportDate) {
  const dofd = inferDofd(tl.adverseRatings);
  if (!dofd) return null;
  if (dofd <= reportDate) return null;
  return makeViolation(
    "DOFD_FUTURE",
    "Field 25 (DOFD)",
    "Date of First Delinquency must be a past date",
    `DOFD is ${dofd.toISOString().slice(0, 10)}, which is after report date ${reportDate.toISOString().slice(0, 10)}`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "The date of first delinquency on this account is set in the future, which is impossible. This indicates a data entry error by the creditor. Future-dated delinquency dates are a clear Metro 2 violation."
  );
}

/**
 * Check 3: SEVEN_YEAR_EXPIRED
 * DOFD + 7 years is before the report date — item should have aged off.
 */
function checkSevenYearExpired(tl, reportDate) {
  const dofd = inferDofd(tl.adverseRatings);
  if (!dofd) return null;
  const expiry = new Date(dofd);
  expiry.setFullYear(expiry.getFullYear() + 7);
  if (expiry >= reportDate) return null;
  return makeViolation(
    "SEVEN_YEAR_EXPIRED",
    "Field 25 (DOFD)",
    "Account must be removed no later than 7 years after the date of first delinquency",
    `DOFD was ${dofd.toISOString().slice(0, 10)}; 7-year expiry was ${expiry.toISOString().slice(0, 10)}`,
    "high",
    "FCRA §1681c(a)",
    "Under the FCRA, most negative items must be removed from your credit report no later than 7 years after the original date of first delinquency. This account should have aged off already and its continued presence on your report is a violation."
  );
}

/**
 * Check 4: BALANCE_ON_CLOSED
 * Status is closed/paid but currentBalance > 0.
 */
function checkBalanceOnClosed(tl) {
  if (!statusIndicatesClosed(tl.status)) return null;
  if (!(tl.currentBalance > 0)) return null;
  return makeViolation(
    "BALANCE_ON_CLOSED",
    "Field 21 (Current Balance)",
    "A closed or paid account should report $0 balance",
    `Status is "${tl.status}" but currentBalance is $${tl.currentBalance}`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "This account is reported as closed or paid in full, yet it still shows an outstanding balance. A closed or fully paid account must report a zero balance. This discrepancy is inaccurate and constitutes a Metro 2 reporting violation."
  );
}

/**
 * Check 5: STALE_REPORTING
 * reportedDate is >90 days before reportDate.
 */
function checkStaleReporting(tl, reportDate) {
  const reported = parseDate(tl.reportedDate);
  if (!reported) return null;
  const diff = daysDiff(reported, reportDate);
  if (diff <= 90) return null;
  return makeViolation(
    "STALE_REPORTING",
    "Field 24 (Date Reported / Account Status Date)",
    "Account status should be updated at least every 90 days",
    `Last reported ${reported.toISOString().slice(0, 10)} — ${diff} days before report date`,
    "medium",
    "FCRA §1681s-2(a)(2)",
    "Creditors are required to update account information with accuracy. This account has not been updated in over 90 days, suggesting the reported information may be outdated. Stale data can misrepresent your current account status."
  );
}

/**
 * Check 6: MISSING_ACCOUNT_TYPE
 * accountType is null.
 */
function checkMissingAccountType(tl) {
  if (tl.accountType !== null && tl.accountType !== undefined) return null;
  return makeViolation(
    "MISSING_ACCOUNT_TYPE",
    "Field 9 (Account Type)",
    "Account type (revolving, installment, mortgage, open) must be reported",
    "accountType is null or not reported",
    "low",
    "FCRA §1681s-2(a)(1)(A)",
    "The account type field is required under Metro 2 format. Without a properly coded account type, the bureau cannot correctly categorize this account, which may adversely affect how your credit profile is evaluated."
  );
}

/**
 * Check 7: MISSING_CREDITOR
 * creditorName is null or empty.
 */
function checkMissingCreditor(tl) {
  if (tl.creditorName && tl.creditorName.trim().length > 0) return null;
  return makeViolation(
    "MISSING_CREDITOR",
    "Field 4 (Creditor Name / Subscriber Name)",
    "Creditor name must be present and non-empty",
    "creditorName is null or empty",
    "medium",
    "FCRA §1681s-2(a)(1)(A)",
    "Every tradeline must identify the furnishing creditor by name. An account with no creditor name cannot be verified, disputed, or resolved. This is a fundamental Metro 2 data completeness requirement."
  );
}

/**
 * Check 8: NEGATIVE_BALANCE
 * currentBalance < 0.
 */
function checkNegativeBalance(tl) {
  if (!(tl.currentBalance < 0)) return null;
  return makeViolation(
    "NEGATIVE_BALANCE",
    "Field 21 (Current Balance)",
    "Current balance cannot be a negative number",
    `currentBalance is $${tl.currentBalance}`,
    "medium",
    "FCRA §1681s-2(a)(1)(A)",
    "This account shows a negative balance, which is not a valid Metro 2 balance value. A negative balance likely indicates a data entry or system error at the creditor. The information as reported is inaccurate."
  );
}

/**
 * Check 9: PAST_DUE_ON_CURRENT
 * currentRatingType is "AsAgreed" but pastDue > 0.
 */
function checkPastDueOnCurrent(tl) {
  if (tl.currentRatingType !== "AsAgreed") return null;
  if (!(tl.pastDue > 0)) return null;
  return makeViolation(
    "PAST_DUE_ON_CURRENT",
    "Field 22 (Amount Past Due)",
    "An account rated as current (AsAgreed) must have $0 past due",
    `currentRatingType is "AsAgreed" but pastDue is $${tl.pastDue}`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "The payment rating on this account indicates it is current and paid as agreed, yet the past-due field shows an amount owed. These two data points directly contradict each other, which is a Metro 2 internal consistency violation."
  );
}

/**
 * Check 10: OPENED_FUTURE
 * openedDate is in the future.
 */
function checkOpenedFuture(tl, reportDate) {
  const opened = parseDate(tl.openedDate);
  if (!opened) return null;
  if (opened <= reportDate) return null;
  return makeViolation(
    "OPENED_FUTURE",
    "Field 10 (Date Opened)",
    "Account opened date must not be in the future",
    `openedDate is ${opened.toISOString().slice(0, 10)}, which is after report date ${reportDate.toISOString().slice(0, 10)}`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "This account reports an opening date that has not yet occurred. An account cannot be opened in the future. This is a clear data error that indicates inaccurate Metro 2 reporting."
  );
}

// --- Status / Balance Consistency (7) ---

/**
 * Check 11: STATUS_BALANCE_MISMATCH_PAID
 * Status indicates paid/closed (rating code "13" or status includes "paid") but balance > 0.
 */
function checkStatusBalanceMismatchPaid(tl) {
  const isPaidCode = tl.currentRatingCode === "13";
  const isPaidStatus = (tl.status || "").toLowerCase().includes("paid");
  if (!isPaidCode && !isPaidStatus) return null;
  if (!(tl.currentBalance > 0)) return null;
  return makeViolation(
    "STATUS_BALANCE_MISMATCH_PAID",
    "Field 17A (Payment Rating / Account Status) / Field 21 (Current Balance)",
    "A paid account (rating code 13 or paid status) must carry a $0 balance",
    `Account is coded as paid (code: ${tl.currentRatingCode || "n/a"}, status: ${tl.status || "n/a"}) but shows balance of $${tl.currentBalance}`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "The payment status indicates this account has been paid in full, but a balance is still being reported. This internal contradiction misrepresents the true state of the account and violates Metro 2 data accuracy standards."
  );
}

/**
 * Check 12: STATUS_CURRENT_WITH_PASTDUE
 * currentRatingCode is "1" or "-" (current) but pastDue > 0.
 */
function checkStatusCurrentWithPastDue(tl) {
  const isCurrent = tl.currentRatingCode === "1" || tl.currentRatingCode === "-";
  if (!isCurrent) return null;
  if (!(tl.pastDue > 0)) return null;
  return makeViolation(
    "STATUS_CURRENT_WITH_PASTDUE",
    "Field 17A (Payment Rating) / Field 22 (Amount Past Due)",
    "A current account (rating code 1 or -) must show $0 past due",
    `ratingCode is "${tl.currentRatingCode}" but pastDue is $${tl.pastDue}`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "The payment rating shows this account is current, but an amount is listed as past due. A current account by definition has no overdue amount. These conflicting values indicate a Metro 2 reporting error."
  );
}

/**
 * Check 13: CHARGEOFF_NO_AMOUNT
 * status is chargeoff or ratingType is "ChargeOff" but chargeOffAmount is null/0.
 */
function checkChargeoffNoAmount(tl) {
  const isChargeOff =
    statusIndicatesChargeOff(tl.status) ||
    tl.currentRatingType === "ChargeOff" ||
    tl.currentRatingType === "CollectionOrChargeOff";
  if (!isChargeOff) return null;
  if (tl.chargeOffAmount && tl.chargeOffAmount > 0) return null;
  return makeViolation(
    "CHARGEOFF_NO_AMOUNT",
    "Field 17A (Account Status)",
    "A charged-off account must report the charge-off amount",
    `Account is reported as charge-off but chargeOffAmount is ${tl.chargeOffAmount == null ? "null" : `$${tl.chargeOffAmount}`}`,
    "medium",
    "FCRA §1681s-2(a)(1)(A)",
    "When an account is reported as charged off, Metro 2 requires the original charge-off amount to be included. Without this amount, the severity of the derogatory entry cannot be properly assessed or verified."
  );
}

/**
 * Check 14: PAYMENT_RATING_STATUS_CONFLICT
 * currentRatingType is "AsAgreed" but isDerogatory is true,
 * OR ratingType is "ChargeOff" but ratingSeverity < 4.
 */
function checkPaymentRatingStatusConflict(tl) {
  if (tl.currentRatingType === "AsAgreed" && tl.isDerogatory === true) {
    return makeViolation(
      "PAYMENT_RATING_STATUS_CONFLICT",
      "Field 17A (Payment Rating) / Field 17B (Compliance Condition Code)",
      "An account rated AsAgreed must not be flagged as derogatory",
      `currentRatingType is "AsAgreed" but isDerogatory is true`,
      "high",
      "FCRA §1681s-2(a)(1)(A)",
      "The account is simultaneously coded as current/paid-as-agreed and flagged as a negative/derogatory item. These designations are mutually exclusive. This internal conflict in the Metro 2 data constitutes an inaccuracy in your credit file."
    );
  }
  if (tl.currentRatingType === "ChargeOff" && tl.ratingSeverity != null && tl.ratingSeverity < 4) {
    return makeViolation(
      "PAYMENT_RATING_STATUS_CONFLICT",
      "Field 17A (Payment Rating) / Field 17B (Compliance Condition Code)",
      "A ChargeOff rating must have a severity of 4 or higher on the 0–6 scale",
      `currentRatingType is "ChargeOff" but ratingSeverity is ${tl.ratingSeverity}`,
      "high",
      "FCRA §1681s-2(a)(1)(A)",
      "The account is reported as a charge-off but the internal severity score assigned by the bureau does not match the charge-off designation. This inconsistency indicates a coding error in the Metro 2 data."
    );
  }
  return null;
}

/**
 * Check 15: BALANCE_EXCEEDS_LIMIT
 * Revolving accounts: currentBalance > creditLimit * 1.5.
 */
function checkBalanceExceedsLimit(tl) {
  if (tl.accountType !== "revolving") return null;
  if (!(tl.creditLimit > 0)) return null;
  if (!(tl.currentBalance > tl.creditLimit * 1.5)) return null;
  const pct = Math.round((tl.currentBalance / tl.creditLimit) * 100);
  return makeViolation(
    "BALANCE_EXCEEDS_LIMIT",
    "Field 21 (Current Balance) / Field 13 (Credit Limit)",
    "Revolving balance should not exceed 150% of the credit limit without explanation",
    `currentBalance $${tl.currentBalance} is ${pct}% of credit limit $${tl.creditLimit}`,
    "low",
    "FCRA §1681s-2(a)(1)(A)",
    "The balance reported on this revolving account significantly exceeds the stated credit limit. While some over-limit balances are possible with fees, a balance at 150% or more of the limit typically indicates a data reporting error that should be verified."
  );
}

/**
 * Check 16: PAYMENT_HISTORY_CONFLICT
 * paymentPattern contains late indicators but currentRatingType is "AsAgreed"
 * AND all latePayment counts are zero.
 */
function checkPaymentHistoryConflict(tl) {
  if (tl.currentRatingType !== "AsAgreed") return null;
  if (!tl.paymentPattern || typeof tl.paymentPattern !== "string") return null;
  const hasLateInPattern = /[2345]/.test(tl.paymentPattern);
  if (!hasLateInPattern) return null;
  const late = tl.latePayments;
  if (!late) return null;
  const totalLate = (late._30 || 0) + (late._60 || 0) + (late._90 || 0);
  if (totalLate !== 0) return null;
  return makeViolation(
    "PAYMENT_HISTORY_CONFLICT",
    "Field 18 (Payment Pattern) / Field 17B (Payment Rating)",
    "Payment pattern codes and late payment counts must be consistent",
    `paymentPattern contains late codes (${tl.paymentPattern}) but latePayments total is 0 and ratingType is AsAgreed`,
    "medium",
    "FCRA §1681s-2(a)(1)(A)",
    "The 24-month payment history shows late payment indicators, yet the late payment counters all read zero and the account is rated as current. These data fields directly contradict each other, signaling a Metro 2 reporting inconsistency."
  );
}

/**
 * Check 17: SOLD_ACCOUNT_WITH_BALANCE
 * status includes "sold" or "transferred" AND currentBalance > 0.
 */
function checkSoldAccountWithBalance(tl) {
  const sl = (tl.status || "").toLowerCase();
  if (!sl.includes("sold") && !sl.includes("transferred")) return null;
  if (!(tl.currentBalance > 0)) return null;
  return makeViolation(
    "SOLD_ACCOUNT_WITH_BALANCE",
    "Field 17A (Account Status) / Field 21 (Current Balance)",
    "A sold or transferred account must report $0 balance — the debt now belongs to a new owner",
    `status is "${tl.status}" but currentBalance is $${tl.currentBalance}`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "This account has been sold or transferred to another creditor, yet the original creditor is still reporting a balance. Once an account is transferred, the original creditor must zero out the balance. Double-reporting a sold balance can artificially inflate what you owe."
  );
}

// --- Charge-Off / Collection Specific (5 implemented, 1 TODO) ---

/**
 * Check 18: COLLECTION_MISSING_ORIGINAL
 * status is "collection" or loanType includes "collection" AND no comment with original creditor info.
 */
function checkCollectionMissingOriginal(tl) {
  if (!isCollection(tl.status, tl.loanType)) return null;
  const hasOriginal = hasCommentMatching(tl.comments, /original\s+creditor/i);
  if (hasOriginal) return null;
  return makeViolation(
    "COLLECTION_MISSING_ORIGINAL",
    "Field K1 (Original Creditor Name)",
    "Collection accounts must identify the original creditor",
    "No comment found referencing original creditor",
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "Collection accounts are required to disclose the name of the original creditor. Without knowing the original creditor, it is impossible to verify that this collection legitimately belongs to you or that the debt is within the statute of limitations."
  );
}

/**
 * Check 19: COLLECTION_WRONG_STATUS
 * status is "collection" AND currentRatingCode is not "5" or "9".
 */
function checkCollectionWrongStatus(tl) {
  if (!isCollection(tl.status, tl.loanType)) return null;
  const validCollectionCodes = ["5", "9"];
  const code = tl.currentRatingCode;
  if (code == null) return null; // can't evaluate without a code
  if (validCollectionCodes.includes(String(code))) return null;
  return makeViolation(
    "COLLECTION_WRONG_STATUS",
    "Field 17A (Payment Rating / Account Status)",
    "Collection accounts must use Metro 2 status code 5 or 9",
    `currentRatingCode is "${code}", expected 5 or 9 for collections`,
    "medium",
    "FCRA §1681s-2(a)(1)(A)",
    "The Metro 2 payment rating code for this collection account does not match any valid collection status code. Collection accounts must be coded using the correct Metro 2 designators, otherwise the account may be miscategorized in bureau systems."
  );
}

/**
 * Check 20: CHARGEOFF_WITH_PAYMENTS
 * ratingType is "ChargeOff" but monthlyPayment > 0.
 */
function checkChargeoffWithPayments(tl) {
  if (
    tl.currentRatingType !== "ChargeOff" &&
    tl.currentRatingType !== "CollectionOrChargeOff"
  )
    return null;
  if (!(tl.monthlyPayment > 0)) return null;
  return makeViolation(
    "CHARGEOFF_WITH_PAYMENTS",
    "Field 12 (Scheduled Monthly Payment Amount)",
    "Charged-off accounts should not show a scheduled monthly payment",
    `ratingType is "${tl.currentRatingType}" but monthlyPayment is $${tl.monthlyPayment}`,
    "medium",
    "FCRA §1681s-2(a)(1)(A)",
    "Once an account is charged off, the creditor no longer expects regular scheduled payments under the original terms. Reporting a scheduled monthly payment amount alongside a charge-off status is contradictory and inaccurate Metro 2 data."
  );
}

/**
 * Check 22: COLLECTION_BALANCE_EXCEEDS_ORIGINAL
 * status is "collection" AND currentBalance > highBalance.
 */
function checkCollectionBalanceExceedsOriginal(tl) {
  if (!isCollection(tl.status, tl.loanType)) return null;
  if (!(tl.highBalance > 0)) return null;
  if (!(tl.currentBalance > tl.highBalance)) return null;
  return makeViolation(
    "COLLECTION_BALANCE_EXCEEDS_ORIGINAL",
    "Field 21 (Current Balance)",
    "Collection balance should not exceed the original high balance without proper explanation",
    `currentBalance $${tl.currentBalance} exceeds highBalance $${tl.highBalance}`,
    "medium",
    "FCRA §1681s-2(a)(1)(A)",
    "The balance reported on this collection account exceeds the original amount ever owed. Collection agencies may add allowable fees, but a balance higher than the original debt is often a sign of improper inflation. This should be challenged and verified."
  );
}

/**
 * Check 23: REAGED_DOFD
 * Multiple adverse dates found and earliest differs from most recent by >6 months
 * AND status worsened (possible re-aging).
 */
function checkReagedDofd(tl) {
  if (!tl.adverseRatings) return null;
  const highestDate = parseDate(tl.adverseRatings.highest?.date);
  const mostRecentDate = parseDate(tl.adverseRatings.mostRecent?.date);
  if (!highestDate || !mostRecentDate) return null;
  // Only flag if the "most recent" adverse date is AFTER the "highest" (original) by >6 months
  // indicating a possible DOFD re-age (the clock was reset forward)
  if (mostRecentDate <= highestDate) return null;
  const diff = monthsDiff(highestDate, mostRecentDate);
  if (diff <= 6) return null;
  return makeViolation(
    "REAGED_DOFD",
    "Field 25 (Date of First Delinquency)",
    "The date of first delinquency should remain fixed; it must not be advanced forward",
    `Earliest adverse date: ${highestDate.toISOString().slice(0, 10)}, most recent: ${mostRecentDate.toISOString().slice(0, 10)} (${diff} months apart)`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "Re-aging is an illegal practice where a creditor resets the date of first delinquency to a newer date, extending the time a negative item stays on your credit report beyond the legal 7-year limit. The history on this account suggests the delinquency date may have been advanced forward."
  );
}

// --- Bankruptcy (4) ---

/**
 * Check 24: BANKRUPTCY_WITH_BALANCE
 * BankruptcyOrWageEarnerPlan ratingType with balance > 0 and a closed date.
 */
function checkBankruptcyWithBalance(tl) {
  const isBK =
    tl.currentRatingType === "BankruptcyOrWageEarnerPlan" ||
    hasCommentMatching(tl.comments, /bankruptcy/i);
  if (!isBK) return null;
  if (!(tl.currentBalance > 0)) return null;
  if (!tl.closedDate) return null;
  return makeViolation(
    "BANKRUPTCY_WITH_BALANCE",
    "Field 21 (Current Balance)",
    "Accounts discharged in bankruptcy with a closed date should report $0 balance",
    `Bankruptcy indicated and closedDate is set, but currentBalance is $${tl.currentBalance}`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "This account appears to have been discharged in bankruptcy, which legally eliminates the debt. A discharged, closed bankruptcy account must show a zero balance. Continuing to report a balance after a bankruptcy discharge may violate both the FCRA and the bankruptcy discharge injunction."
  );
}

/**
 * Check 25: BANKRUPTCY_WRONG_RATING
 * ratingType is "BankruptcyOrWageEarnerPlan" but ratingSeverity is not 6.
 */
function checkBankruptcyWrongRating(tl) {
  if (tl.currentRatingType !== "BankruptcyOrWageEarnerPlan") return null;
  if (tl.ratingSeverity == null) return null;
  if (tl.ratingSeverity === 6) return null;
  return makeViolation(
    "BANKRUPTCY_WRONG_RATING",
    "Field 17B (Payment Rating Code)",
    "Bankruptcy-coded accounts must carry the maximum severity rating of 6",
    `currentRatingType is "BankruptcyOrWageEarnerPlan" but ratingSeverity is ${tl.ratingSeverity}`,
    "medium",
    "FCRA §1681s-2(a)(1)(A)",
    "A bankruptcy designation carries the highest Metro 2 severity code. When the rating type is bankruptcy but the severity score does not match, it signals a coding inconsistency that may affect how this derogatory item is treated by lenders and scoring models."
  );
}

/**
 * Check 26: BANKRUPTCY_STILL_REPORTING_LATE
 * ratingType is "BankruptcyOrWageEarnerPlan" but paymentPattern shows recent late marks.
 * "Recent" = late marks within the first 6 characters (months) of the pattern (left = newest).
 */
function checkBankruptcyStillReportingLate(tl) {
  if (tl.currentRatingType !== "BankruptcyOrWageEarnerPlan") return null;
  if (!tl.paymentPattern || typeof tl.paymentPattern !== "string") return null;
  const recent = tl.paymentPattern.slice(0, 6);
  if (!/[2345]/.test(recent)) return null;
  return makeViolation(
    "BANKRUPTCY_STILL_REPORTING_LATE",
    "Field 18 (Payment Pattern)",
    "Accounts in active bankruptcy should not continue accumulating late payment marks",
    `paymentPattern shows recent late codes in first 6 months: "${recent}"`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "Once a bankruptcy is filed, creditors should not continue posting new late payment marks. The recent payment history on this account still shows delinquency codes that appear to have been added after the bankruptcy was initiated, which is improper Metro 2 reporting."
  );
}

/**
 * Check 27: INCLUDED_IN_BANKRUPTCY_NO_FLAG
 * Balance is 0, closedDate exists, comments mention "included in bankruptcy",
 * but ratingType is NOT "BankruptcyOrWageEarnerPlan".
 */
function checkIncludedInBankruptcyNoFlag(tl) {
  if (!(tl.currentBalance === 0 || tl.currentBalance === null)) return null;
  if (!tl.closedDate) return null;
  if (!hasCommentMatching(tl.comments, /included\s+in\s+bankruptcy/i)) return null;
  if (tl.currentRatingType === "BankruptcyOrWageEarnerPlan") return null;
  return makeViolation(
    "INCLUDED_IN_BANKRUPTCY_NO_FLAG",
    "Field 38 (Special Comment Code)",
    "An account noted as included in bankruptcy must use the BankruptcyOrWageEarnerPlan rating type",
    `Comments state "included in bankruptcy" but currentRatingType is "${tl.currentRatingType || "not set"}"`,
    "medium",
    "FCRA §1681s-2(a)(1)(A)",
    "A comment on this account states it was included in a bankruptcy proceeding, but the payment rating type has not been updated to reflect the bankruptcy designation. This missing code means the account may not be properly classified in bureau systems."
  );
}

// --- Dispute / Compliance (3) ---

/**
 * Check 28: DISPUTE_FLAG_STALE
 * Comments mention "dispute" AND reportedDate is >60 days old.
 */
function checkDisputeFlagStale(tl, reportDate) {
  if (!hasCommentMatching(tl.comments, /disput/i)) return null;
  const reported = parseDate(tl.reportedDate);
  if (!reported) return null;
  const diff = daysDiff(reported, reportDate);
  if (diff <= 60) return null;
  return makeViolation(
    "DISPUTE_FLAG_STALE",
    "Field 20 (Compliance Condition Code / Dispute Flag)",
    "Disputed accounts must be investigated and resolved within 30 days; a dispute flag older than 60 days indicates no response",
    `Last reported ${reported.toISOString().slice(0, 10)}, ${diff} days before report date, with active dispute notation`,
    "medium",
    "FCRA §1681i(a)(1)(A)",
    "This account is flagged as under dispute, but has not been updated in over 60 days. Creditors are required to complete their reinvestigation within 30 days of receiving a dispute. A dispute notation that remains unresolved beyond that window suggests the creditor failed to respond as required."
  );
}

/**
 * Check 29: DISPUTED_BUT_NO_NOTATION
 * Account is derogatory AND has no comments mentioning dispute.
 * NOTE: This is a low-confidence check — it flags a potential missing notation,
 * not a confirmed violation. Only useful when the consumer has filed a known dispute.
 */
function checkDisputedButNoNotation(tl) {
  if (!tl.isDerogatory) return null;
  if (hasCommentMatching(tl.comments, /disput/i)) return null;
  return makeViolation(
    "DISPUTED_BUT_NO_NOTATION",
    "Field 20 (Compliance Condition Code)",
    "If a consumer has disputed this account, a dispute notation should appear",
    "Account is derogatory with no dispute notation in comments",
    "low",
    "FCRA §1681i(a)(3)",
    "This derogatory account does not carry any dispute notation. If you have previously disputed this item with the bureau or the creditor, the creditor is required to add a dispute flag to the Metro 2 data. The absence of this notation may indicate non-compliance."
  );
}

/**
 * Check 30: COMPLIANCE_CODE_MISSING
 * isDerogatory is true but no compliance condition code comment found.
 */
function checkComplianceCodeMissing(tl) {
  if (!tl.isDerogatory) return null;
  // Look for any comment that appears to be a compliance/condition code
  // (typically short uppercase codes or "XB", "XC", "XH", etc.)
  const hasCompliance = hasCommentMatching(
    tl.comments,
    /\b(compliance|condition|XB|XC|XH|XR|XD|XE|XF|XG|XI|XJ|XK|XL|XM|XN|XO|XP|XQ|XS|XT|XU|XV|XW|XX|XY|XZ)\b/i
  );
  if (hasCompliance) return null;
  return makeViolation(
    "COMPLIANCE_CODE_MISSING",
    "Field 20 (Compliance Condition Code)",
    "Derogatory accounts should carry an applicable compliance condition code",
    "No compliance condition code found in account comments",
    "low",
    "FCRA §1681s-2(a)(3)",
    "Metro 2 requires creditors to include a compliance condition code on accounts with adverse information, indicating the account's standing relative to federal regulations. The absence of this code on a derogatory account may indicate incomplete Metro 2 reporting."
  );
}

// --- Personal Info / Mixed File (2 implemented, 2 TODO) ---

/**
 * Check 31: AU_REPORTED_NEGATIVE
 * isAU or ownership is "authorized_user" AND isDerogatory.
 */
function checkAuReportedNegative(tl) {
  const isAu = tl.isAU === true || tl.ownership === "authorized_user";
  if (!isAu) return null;
  if (!tl.isDerogatory) return null;
  return makeViolation(
    "AU_REPORTED_NEGATIVE",
    "Field 37 (ECOA Code / Account Ownership)",
    "Authorized user accounts should not carry negative marks against the AU",
    `ownership is "${tl.ownership || "authorized_user"}" and isDerogatory is true`,
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "You are an authorized user on this account, not the primary account holder. As an authorized user, you are not legally responsible for the debt. Negative marks from an account on which you are only an authorized user should not be held against your credit profile."
  );
}

/**
 * Check 33: DECEASED_FLAG_ALIVE
 * Comments include a deceased indicator.
 * (Always flagged — if the consumer is alive, this is an error.)
 */
function checkDeceasedFlagAlive(tl) {
  if (!hasCommentMatching(tl.comments, /deceas/i)) return null;
  return makeViolation(
    "DECEASED_FLAG_ALIVE",
    "Field 38 (Special Comment Code)",
    "Account must not carry a deceased indicator for a living consumer",
    "Comment text contains a deceased indicator",
    "high",
    "FCRA §1681s-2(a)(1)(A)",
    "This account carries a notation indicating the account holder is deceased. If you are alive and actively disputing this record, the deceased flag is a serious error. This type of mixed-file or erroneous notation can block credit applications and must be corrected immediately."
  );
}

// ---------------------------------------------------------------------------
// Check registry — ordered execution list
// ---------------------------------------------------------------------------

const CHECKS = [
  // Universal
  (tl, rd) => checkDofdMissing(tl),
  (tl, rd) => checkDofdFuture(tl, rd),
  (tl, rd) => checkSevenYearExpired(tl, rd),
  (tl, rd) => checkBalanceOnClosed(tl),
  (tl, rd) => checkStaleReporting(tl, rd),
  (tl, rd) => checkMissingAccountType(tl),
  (tl, rd) => checkMissingCreditor(tl),
  (tl, rd) => checkNegativeBalance(tl),
  (tl, rd) => checkPastDueOnCurrent(tl),
  (tl, rd) => checkOpenedFuture(tl, rd),
  // Status / Balance Consistency
  (tl, rd) => checkStatusBalanceMismatchPaid(tl),
  (tl, rd) => checkStatusCurrentWithPastDue(tl),
  (tl, rd) => checkChargeoffNoAmount(tl),
  (tl, rd) => checkPaymentRatingStatusConflict(tl),
  (tl, rd) => checkBalanceExceedsLimit(tl),
  (tl, rd) => checkPaymentHistoryConflict(tl),
  (tl, rd) => checkSoldAccountWithBalance(tl),
  // Charge-Off / Collection
  (tl, rd) => checkCollectionMissingOriginal(tl),
  (tl, rd) => checkCollectionWrongStatus(tl),
  (tl, rd) => checkChargeoffWithPayments(tl),
  (tl, rd) => checkCollectionBalanceExceedsOriginal(tl),
  (tl, rd) => checkReagedDofd(tl),
  // Bankruptcy
  (tl, rd) => checkBankruptcyWithBalance(tl),
  (tl, rd) => checkBankruptcyWrongRating(tl),
  (tl, rd) => checkBankruptcyStillReportingLate(tl),
  (tl, rd) => checkIncludedInBankruptcyNoFlag(tl),
  // Dispute / Compliance
  (tl, rd) => checkDisputeFlagStale(tl, rd),
  (tl, rd) => checkDisputedButNoNotation(tl),
  (tl, rd) => checkComplianceCodeMissing(tl),
  // Personal Info / Mixed File
  (tl, rd) => checkAuReportedNegative(tl),
  (tl, rd) => checkDeceasedFlagAlive(tl),
];

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run all implemented Metro 2 violation checks against a single tradeline.
 *
 * Never throws. Returns { violations: [] } on bad input.
 *
 * @param {object} tradeline — Normalized tradeline from the CRS engine
 * @param {Date}   [reportDate=new Date()] — The date of the credit report pull
 * @returns {{ violations: Array<object> }}
 */
function detectViolations(tradeline, reportDate = new Date()) {
  if (!tradeline || typeof tradeline !== "object") {
    return { violations: [] };
  }

  const rd =
    reportDate instanceof Date && !isNaN(reportDate.getTime())
      ? reportDate
      : new Date();

  const violations = [];

  for (const check of CHECKS) {
    try {
      const result = check(tradeline, rd);
      if (result !== null && result !== undefined) {
        violations.push(result);
      }
    } catch (_err) {
      // Individual check failures must never bubble up — log and continue
      // (no logger dependency here; caller can wrap if needed)
    }
  }

  return { violations };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  detectViolations,

  // Individual check functions — exported for unit testing
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
  checkStatusCurrentWithPastDue,
  checkChargeoffNoAmount,
  checkPaymentRatingStatusConflict,
  checkBalanceExceedsLimit,
  checkPaymentHistoryConflict,
  checkSoldAccountWithBalance,
  checkCollectionMissingOriginal,
  checkCollectionWrongStatus,
  checkChargeoffWithPayments,
  checkCollectionBalanceExceedsOriginal,
  checkReagedDofd,
  checkBankruptcyWithBalance,
  checkBankruptcyWrongRating,
  checkBankruptcyStillReportingLate,
  checkIncludedInBankruptcyNoFlag,
  checkDisputeFlagStale,
  checkDisputedButNoNotation,
  checkComplianceCodeMissing,
  checkAuReportedNegative,
  checkDeceasedFlagAlive,

  // Helpers — exported for unit testing
  parseDate,
  monthsDiff,
  hasCommentMatching,
  inferDofd,

  // Metadata
  PENDING_CHECKS,
};
