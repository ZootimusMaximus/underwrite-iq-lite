"use strict";

/**
 * derive-consumer-signals.js — Stage 03: Consumer Signal Derivation
 *
 * Consumes normalized CRS payload (Module 1 output) and derives
 * all consumer credit signals used for outcome routing, pre-approvals,
 * and optimization findings.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute median of a numeric array. Returns null for empty input.
 */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Months between two date strings. Returns 0 if either is invalid.
 */
function monthsBetween(fromStr, toStr) {
  if (!fromStr || !toStr) return 0;
  const from = new Date(fromStr);
  const to = new Date(toStr);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return 0;
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

/**
 * Get the most recent report date from bureaus as reference for date calculations.
 * Falls back to current date if no reportDates available.
 */
function getReferenceDate(bureaus) {
  const dates = Object.values(bureaus)
    .filter(b => b.available && b.reportDate)
    .map(b => new Date(b.reportDate));
  if (!dates.length) return new Date();
  return new Date(Math.max(...dates));
}

/**
 * Map utilization percentage to band.
 */
function getUtilizationBand(pct) {
  if (pct === null || pct === undefined) return "unknown";
  if (pct < 10) return "excellent";
  if (pct < 30) return "good";
  if (pct < 50) return "moderate";
  if (pct < 80) return "high";
  return "critical";
}

/**
 * Map 6-month inquiry count to pressure level.
 */
function getInquiryPressure(sixMonthCount) {
  if (sixMonthCount <= 2) return "low";
  if (sixMonthCount <= 5) return "moderate";
  if (sixMonthCount <= 9) return "high";
  return "storm";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * deriveConsumerSignals(normalized)
 *
 * @param {Object} normalized - Output of normalizeSoftPullPayload (Module 1)
 * @returns {Object} Consumer signals for downstream modules
 */
function deriveConsumerSignals(normalized) {
  const { bureaus, tradelines, inquiries, publicRecords } = normalized;
  const refDate = getReferenceDate(bureaus);
  const refIso = refDate.toISOString().split("T")[0];

  // ── Scores ──────────────────────────────────────────────────────────
  const availableScores = ["transunion", "experian", "equifax"]
    .filter(b => bureaus[b]?.available && bureaus[b]?.score != null)
    .map(b => bureaus[b].score);

  const scores = {
    median: median(availableScores),
    bureauConfidence:
      normalized.meta.bureauCount >= 3
        ? "high"
        : normalized.meta.bureauCount === 2
          ? "medium"
          : "low",
    spread:
      availableScores.length >= 2 ? Math.max(...availableScores) - Math.min(...availableScores) : 0,
    perBureau: {
      tu: bureaus.transunion?.score ?? null,
      ex: bureaus.experian?.score ?? null,
      eq: bureaus.equifax?.score ?? null
    }
  };

  // ── Tradelines ──────────────────────────────────────────────────────
  const primaryTradelines = tradelines.filter(t => !t.isAU);
  const auTradelines = tradelines.filter(t => t.isAU);

  const tradelineSignals = {
    total: tradelines.length,
    primary: primaryTradelines.length,
    au: auTradelines.length,
    auDominance:
      tradelines.length > 0 ? Math.round((auTradelines.length / tradelines.length) * 100) / 100 : 0,
    revolvingDepth: primaryTradelines.filter(
      t => t.accountType === "revolving" && t.status === "open"
    ).length,
    installmentDepth: primaryTradelines.filter(
      t => t.accountType === "installment" && t.status === "open"
    ).length,
    mortgagePresent: tradelines.some(t => t.accountType === "mortgage"),
    depth: primaryTradelines.length,
    thinFile: primaryTradelines.length < 3
  };

  // ── Anchors ─────────────────────────────────────────────────────────
  // Revolving: primary, revolving, open, seasoned ≥24mo, no derogatories
  const revolvingCandidates = tradelines.filter(
    t =>
      !t.isAU &&
      t.accountType === "revolving" &&
      t.status === "open" &&
      !t.isDerogatory &&
      t.effectiveLimit != null &&
      t.openedDate &&
      monthsBetween(t.openedDate, refIso) >= 24
  );
  const bestRevolving =
    revolvingCandidates.length > 0
      ? revolvingCandidates.reduce((best, t) => (t.effectiveLimit > best.effectiveLimit ? t : best))
      : null;

  // Installment: primary, installment, seasoned ≥24mo, no lates, no derogatories
  const installmentCandidates = tradelines.filter(
    t =>
      !t.isAU &&
      t.accountType === "installment" &&
      !t.isDerogatory &&
      t.highBalance != null &&
      t.highBalance > 0 &&
      t.openedDate &&
      monthsBetween(t.openedDate, refIso) >= 24 &&
      t.latePayments._30 + t.latePayments._60 + t.latePayments._90 === 0
  );
  const bestInstallment =
    installmentCandidates.length > 0
      ? installmentCandidates.reduce((best, t) => (t.highBalance > best.highBalance ? t : best))
      : null;

  const anchors = {
    revolving: bestRevolving
      ? {
          creditor: bestRevolving.creditorName,
          limit: bestRevolving.effectiveLimit,
          openedDate: bestRevolving.openedDate,
          months: monthsBetween(bestRevolving.openedDate, refIso)
        }
      : null,
    installment: bestInstallment
      ? {
          creditor: bestInstallment.creditorName,
          amount: bestInstallment.highBalance,
          openedDate: bestInstallment.openedDate,
          months: monthsBetween(bestInstallment.openedDate, refIso)
        }
      : null
  };

  // ── Utilization (open primary revolving only) ───────────────────────
  const openPrimaryRevolving = tradelines.filter(
    t => !t.isAU && t.accountType === "revolving" && t.status === "open"
  );
  const totalBalance = openPrimaryRevolving.reduce((sum, t) => sum + (t.currentBalance || 0), 0);
  const totalLimit = openPrimaryRevolving.reduce((sum, t) => sum + (t.effectiveLimit || 0), 0);
  const utilizationPct = totalLimit > 0 ? Math.round((totalBalance / totalLimit) * 100) : null;

  const utilization = {
    totalBalance,
    totalLimit,
    pct: utilizationPct,
    band: getUtilizationBand(utilizationPct)
  };

  // ── Inquiries ───────────────────────────────────────────────────────
  const sixMonthsAgo = new Date(refDate);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const twelveMonthsAgo = new Date(refDate);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  const last6Mo = inquiries.filter(i => i.date && new Date(i.date) >= sixMonthsAgo).length;
  const last12Mo = inquiries.filter(i => i.date && new Date(i.date) >= twelveMonthsAgo).length;

  const inquirySignals = {
    total: inquiries.length,
    last6Mo,
    last12Mo,
    pressure: getInquiryPressure(last6Mo)
  };

  // ── Derogatories ────────────────────────────────────────────────────
  const openDerogatories = tradelines.filter(t => t.isDerogatory && t.status === "open");
  const worstSeverity =
    openDerogatories.length > 0 ? Math.max(...openDerogatories.map(t => t.ratingSeverity)) : 0;

  // Chargeoffs/collections counted across ALL tradelines (not just open)
  const chargeoffs = tradelines.filter(t => t.currentRatingType === "ChargeOff").length;
  const collections = tradelines.filter(
    t => t.adverseRatings?.highest?.type === "CollectionOrChargeOff"
  ).length;

  const bankruptcies = publicRecords.filter(pr => pr.type && pr.type.includes("Bankruptcy"));
  const mostRecentBK = bankruptcies.length
    ? bankruptcies
        .filter(pr => pr.filedDate)
        .sort((a, b) => new Date(b.filedDate) - new Date(a.filedDate))[0] || null
    : null;

  const derogSignals = {
    active: openDerogatories.length,
    chargeoffs,
    collections,
    active30: openDerogatories.filter(t => t.currentRatingType === "Late30Days").length,
    active60: openDerogatories.filter(t => t.currentRatingType === "Late60Days").length,
    active90: openDerogatories.filter(t => t.currentRatingType === "Late90Days").length,
    active120Plus: openDerogatories.filter(t => t.currentRatingType === "LateOver120Days").length,
    worstSeverity,
    activeBankruptcy: bankruptcies.some(pr => pr.dispositionType !== "Discharged"),
    dischargedBankruptcy: bankruptcies.some(pr => pr.dispositionType === "Discharged"),
    bankruptcyAge: mostRecentBK?.filedDate ? monthsBetween(mostRecentBK.filedDate, refIso) : null
  };

  // ── Payment History ─────────────────────────────────────────────────
  const late30 = tradelines.reduce((sum, t) => sum + t.latePayments._30, 0);
  const late60 = tradelines.reduce((sum, t) => sum + t.latePayments._60, 0);
  const late90 = tradelines.reduce((sum, t) => sum + t.latePayments._90, 0);

  const paymentHistory = {
    late30,
    late60,
    late90,
    totalEvents: late30 + late60 + late90,
    recentActivity: tradelines.some(
      t => t.status === "open" && t.ratingSeverity >= 1 && t.ratingSeverity <= 4
    )
  };

  return {
    scores,
    tradelines: tradelineSignals,
    anchors,
    utilization,
    inquiries: inquirySignals,
    derogatories: derogSignals,
    paymentHistory
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  deriveConsumerSignals,
  // Exported for testing
  median,
  monthsBetween,
  getReferenceDate,
  getUtilizationBand,
  getInquiryPressure
};
