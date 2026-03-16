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

const { monthsBetween } = require("./derive-consumer-signals");

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
    caution: uccFilings.length > 3
  };

  // ── Hard Blocks ─────────────────────────────────────────────────────
  const blockReasons = [];
  if (!isActive) blockReasons.push("BUSINESS_INACTIVE");
  if (!ofacClear && ofacCode !== undefined) blockReasons.push("OFAC_MATCH");
  if (publicRecords.bankruptcy) blockReasons.push("BUSINESS_BANKRUPTCY");
  if (publicRecords.judgment) blockReasons.push("BUSINESS_JUDGMENT");
  if (publicRecords.taxLien) blockReasons.push("BUSINESS_TAX_LIEN");
  if (fraudShieldSignals.nameVerified === false) blockReasons.push("BUSINESS_VERIFICATION_FAILED");

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
