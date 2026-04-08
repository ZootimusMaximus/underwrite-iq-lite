"use strict";

/**
 * derive-business-signals.js — Stage 03b: Business Signal Derivation
 *
 * Consumes a raw Experian Business Premier Profile response and derives
 * business credit signals for outcome routing, pre-approvals, and
 * optimization findings.
 *
 * If no business report is provided, returns { available: false }.
 */

const { monthsBetween, getUtilizationBand } = require("./derive-consumer-signals");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDbtStress(dbt) {
  if (dbt === null || dbt === undefined) return "unknown";
  if (dbt === 0) return "none";
  if (dbt <= 15) return "low";
  if (dbt <= 30) return "moderate";
  if (dbt <= 60) return "high";
  return "severe";
}

function getIntelliscoreBand(score) {
  if (score == null) return "unknown";
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "fair";
  return "weak";
}

function getFsrBand(score) {
  if (score == null) return "unknown";
  if (score >= 60) return "low_risk";
  if (score >= 40) return "moderate_risk";
  return "high_risk";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * deriveBusinessSignals(businessReport)
 *
 * @param {Object|null} businessReport - Raw Experian Business Premier Profile response
 *   Can be the full response { auth, result, data } or just the data object.
 * @returns {Object} Business signals for downstream modules
 */
function deriveBusinessSignals(businessReport) {
  if (!businessReport) return { available: false };

  const data = businessReport.data || businessReport;
  if (!data || typeof data !== "object") return { available: false };

  const scoreInfo = data.scoreInformation || {};
  const commercialScore = scoreInfo.commercialScore || {};
  const fsrScore = scoreInfo.fsrScore || {};
  const header = data.businessHeader || {};
  const corpReg = data.corporateRegistration || {};
  const facts = data.businessFacts || {};
  const creditSummary = data.expandedCreditSummary || {};
  const fraudShield = data.commercialFraudShieldSummary || {};
  const uccFilings = data.uccFilingsDetail || [];

  const now = new Date().toISOString().split("T")[0];
  const incorporatedDate = corpReg.incorporatedDate || null;
  const ageMonths = incorporatedDate ? monthsBetween(incorporatedDate, now) : null;
  const isActive = corpReg.statusFlag?.code === "A";

  // ── Scores ──────────────────────────────────────────────────────────
  const scores = {
    intelliscore: commercialScore.score ?? null,
    intelliscoreRisk: commercialScore.riskClass?.definition ?? null,
    intelliscoreBand: getIntelliscoreBand(commercialScore.score),
    fsr: fsrScore.score ?? null,
    fsrRisk: fsrScore.riskClass?.definition ?? null,
    fsrBand: getFsrBand(fsrScore.score),
    recommendedLimit: commercialScore.recommendedCreditLimitAmount ?? null
  };

  // ── Profile ─────────────────────────────────────────────────────────
  const profile = {
    name: header.businessName || null,
    incorporatedDate,
    ageMonths,
    type: facts.businessType || null,
    state: facts.stateOfIncorporation || null,
    isActive
  };

  // ── DBT (Days Beyond Terms) ─────────────────────────────────────────
  const currentDbt = creditSummary.currentDbt ?? null;
  const dbt = {
    current: currentDbt,
    stress: getDbtStress(currentDbt),
    monthlyAvg: creditSummary.monthlyAverageDbt ?? null
  };

  // ── Fraud Shield ────────────────────────────────────────────────────
  const ofacCode = fraudShield.ofacMatchWarning?.code;
  const ofacClear = ofacCode === 1; // code 1 = "No Match Found"
  const fraudShieldSignals = {
    ofacClear,
    isActive: fraudShield.activeBusinessIndicator ?? null,
    riskTriggers: fraudShield.businessRiskTriggersIndicator ?? null,
    nameVerified: fraudShield.nameAddressVerificationIndicator ?? null
  };

  // ── Public Records ──────────────────────────────────────────────────
  const publicRecords = {
    bankruptcy: creditSummary.bankruptcyIndicator === true,
    judgment: creditSummary.judgmentIndicator === true,
    taxLien: creditSummary.taxLienIndicator === true
  };

  // ── UCC Filings ─────────────────────────────────────────────────────
  const ucc = {
    count: uccFilings.length,
    caution: uccFilings.length > 0
  };

  // ── Business Negative Items (v2) ────────────────────────────────────
  const bizNegativeItems = {
    hasNegatives:
      publicRecords.bankruptcy ||
      publicRecords.judgment ||
      publicRecords.taxLien ||
      (currentDbt != null && currentDbt > 30),
    items: []
  };
  if (publicRecords.bankruptcy) bizNegativeItems.items.push("bankruptcy");
  if (publicRecords.judgment) bizNegativeItems.items.push("judgment");
  if (publicRecords.taxLien) bizNegativeItems.items.push("tax_lien");
  if (currentDbt != null && currentDbt > 30) bizNegativeItems.items.push("high_dbt");

  // ── Business Utilization (v2 — same thresholds as personal) ─────────
  const bizCreditSummary = creditSummary || {};
  const bizTotalBalance = bizCreditSummary.currentTotalAccountBalance?.amount ?? null;
  const bizHighCredit = bizCreditSummary.highestCreditAmount?.amount ?? null;
  const bizUtilPct =
    bizTotalBalance != null && bizHighCredit != null && bizHighCredit > 0
      ? Math.round((bizTotalBalance / bizHighCredit) * 100)
      : null;
  const bizUtilization = {
    pct: bizUtilPct,
    band: getUtilizationBand(bizUtilPct)
  };

  // ── Hard Blocks ─────────────────────────────────────────────────────
  const blockReasons = [];
  if (!isActive) blockReasons.push("BUSINESS_INACTIVE");
  if (!ofacClear && ofacCode !== undefined) blockReasons.push("OFAC_MATCH");
  if (publicRecords.bankruptcy) blockReasons.push("BUSINESS_BANKRUPTCY");
  if (publicRecords.judgment) blockReasons.push("BUSINESS_JUDGMENT");
  if (publicRecords.taxLien) blockReasons.push("BUSINESS_TAX_LIEN");
  if (fraudShieldSignals.nameVerified === false) blockReasons.push("BUSINESS_VERIFICATION_FAILED");
  if (bizNegativeItems.hasNegatives) blockReasons.push("BUSINESS_NEGATIVE_ITEMS");
  if (ucc.caution) blockReasons.push("BUSINESS_UCC_LIEN");

  const hardBlock = {
    blocked: blockReasons.length > 0,
    reasons: blockReasons
  };

  return {
    available: true,
    scores,
    profile,
    dbt,
    fraudShield: fraudShieldSignals,
    publicRecords,
    ucc,
    bizNegativeItems,
    bizUtilization,
    hardBlock
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  deriveBusinessSignals,
  getDbtStress,
  getIntelliscoreBand,
  getFsrBand
};
