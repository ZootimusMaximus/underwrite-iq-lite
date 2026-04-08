"use strict";

/**
 * engine.js — CRS Engine Orchestrator
 *
 * Wires all 12 CRS modules into a single pipeline.
 * Takes raw Stitch Credit responses + form data → returns full output.
 */

const { normalizeSoftPullPayload } = require("./normalize-soft-pull");
const { deriveConsumerSignals } = require("./derive-consumer-signals");
const { deriveBusinessSignals } = require("./derive-business-signals");
const { runIdentityAndFraudGate } = require("./identity-fraud-gate");
const { routeOutcome } = require("./route-outcome");
const { estimatePreapprovals } = require("./estimate-preapprovals");
const { buildOptimizationFindings } = require("./optimization-findings");
const { buildSuggestions } = require("./build-suggestions");
const { buildCards } = require("./build-cards");
const { buildDocuments } = require("./build-documents");
const { buildCrmPayload, REDIRECT_PATHS } = require("./build-crm-payload");
const { buildAuditTrail } = require("./build-audit-trail");

// ---------------------------------------------------------------------------
// Summary Generators (Gaps 10 & 11)
// ---------------------------------------------------------------------------

function getScoreLabel(median) {
  if (median == null) return "unavailable";
  if (median >= 760) return "excellent";
  if (median >= 700) return "good";
  if (median >= 650) return "fair";
  if (median >= 580) return "below average";
  return "poor";
}

function buildConsumerSummary(cs) {
  const parts = [];
  const label = getScoreLabel(cs.scores.median);
  parts.push(`Credit score: ${cs.scores.median ?? "N/A"} (${label}).`);

  if (cs.utilization.pct != null) {
    parts.push(`Utilization at ${cs.utilization.pct}% (${cs.utilization.band}).`);
  }

  if (cs.derogatories.active > 0) {
    const items = [];
    if (cs.derogatories.chargeoffs > 0) items.push(`${cs.derogatories.chargeoffs} charge-off(s)`);
    if (cs.derogatories.collections > 0) items.push(`${cs.derogatories.collections} collection(s)`);
    if (cs.derogatories.activeBankruptcy) items.push("active bankruptcy");
    if (items.length > 0) {
      parts.push(`Active derogatories: ${items.join(", ")}.`);
    } else {
      parts.push(`${cs.derogatories.active} active derogatory item(s).`);
    }
  } else {
    parts.push("No active derogatories.");
  }

  if (cs.tradelines.thinFile) {
    parts.push(`Thin file with only ${cs.tradelines.primary} primary tradeline(s).`);
  }
  if (cs.tradelines.auDominance > 0.4) {
    parts.push(
      `AU-dominant file (${Math.round(cs.tradelines.auDominance * 100)}% authorized user).`
    );
  }

  return parts.join(" ");
}

const DECISION_LABELS = {
  FRAUD_HOLD: {
    label: "Application On Hold",
    explanation:
      "Your application has been placed on hold pending identity verification. Our team will contact you shortly."
  },
  MANUAL_REVIEW: {
    label: "Under Review",
    explanation:
      "Your application requires additional review by our team. We will follow up within 1-2 business days."
  },
  REPAIR: {
    label: "Credit Repair Recommended",
    explanation:
      "Based on your credit profile, we recommend addressing some items before pursuing funding. We have prepared a repair plan for you."
  },
  CONDITIONAL_APPROVAL: {
    label: "Conditionally Approved",
    explanation:
      "You are conditionally approved for funding. Addressing a few remaining items could increase your funding amount."
  },
  FULL_STACK_APPROVAL: {
    label: "Approved for Funding",
    explanation: "Congratulations! Your credit profile qualifies for our full funding programs."
  },
  PREMIUM_STACK: {
    label: "Premium Funding Approved",
    explanation:
      "Congratulations! Your excellent credit profile qualifies for our premium funding programs with the highest limits available."
  }
};

function buildBusinessSummary(bs) {
  if (!bs?.available) {
    return "No business entity found. Forming an LLC and building 12+ months of business credit history would unlock additional funding programs.";
  }

  const parts = [];
  parts.push(`Business credit available (${bs.profile.name || "unnamed entity"}).`);

  if (bs.scores.intelliscore != null) {
    parts.push(`Intelliscore: ${bs.scores.intelliscore} (${bs.scores.intelliscoreBand}).`);
  }
  if (bs.profile.ageMonths != null) {
    parts.push(`Business age: ${bs.profile.ageMonths} months.`);
  }
  if (bs.hardBlock.blocked) {
    parts.push(`Business blocked: ${bs.hardBlock.reasons.join(", ")}.`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Projected Signals — clone consumerSignals with fixes applied
// ---------------------------------------------------------------------------

function buildProjectedSignals(cs, findings) {
  // Deep clone consumer signals
  const projected = JSON.parse(JSON.stringify(cs));

  // Apply utilization fixes: assume all cards brought to 10%
  const hasUtilFindings = findings.some(
    f => f.code === "UTIL_CARD_OVER_10" || f.code === "UTIL_OVERALL_HIGH"
  );
  if (hasUtilFindings && projected.utilization.totalLimit > 0) {
    projected.utilization.pct = 9;
    projected.utilization.band = "excellent";
    projected.utilization.totalBalance = Math.round(projected.utilization.totalLimit * 0.09);
  }

  // Apply derogatory fixes: assume all resolved
  const hasNegFindings = findings.some(f =>
    ["CHARGEOFF_ITEM", "COLLECTION_ITEM", "LATE_PAYMENT_ITEM", "MEDICAL_COLLECTION"].includes(
      f.code
    )
  );
  if (hasNegFindings) {
    projected.derogatories.active = 0;
    projected.derogatories.chargeoffs = 0;
    projected.derogatories.collections = 0;
    projected.derogatories.active60 = 0;
    projected.derogatories.active90 = 0;
    projected.derogatories.active120Plus = 0;
    projected.derogatories.worstSeverity = 0;
    projected.paymentHistory.recentActivity = false;
  }

  // Apply inquiry fixes: assume reduced to 2
  const hasInquiryFindings = findings.some(f => ["INQUIRY_STORM", "INQUIRY_HIGH"].includes(f.code));
  if (hasInquiryFindings) {
    projected.inquiries.last6Mo = 2;
    projected.inquiries.pressure = "low";
  }

  // Bump score estimate based on fixes
  if (projected.scores.median != null) {
    let bump = 0;
    if (hasUtilFindings) bump += 30; // Utilization fix typically adds 20-40 pts
    if (hasNegFindings) bump += 20; // Removing negatives adds 15-30 pts
    if (hasInquiryFindings) bump += 5;
    projected.scores.median = Math.min(850, projected.scores.median + bump);
  }

  return projected;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * runCRSEngine(options)
 *
 * @param {Object} options
 * @param {Array<Object>} options.rawResponses - Raw Stitch Credit CRS responses (1-3)
 * @param {Object|null} options.businessReport - Raw Experian Business Premier Profile response
 * @param {string} options.submittedName - Name from the application form
 * @param {string} [options.submittedAddress] - Address from the form (optional)
 * @param {Object} [options.formData] - { email, phone, name, companyName, hasLLC, llcAgeMonths, businessAgeMonths, ref }
 * @returns {Object} Full CRS engine output (spec Section 6)
 */
function runCRSEngine(options) {
  const { rawResponses, businessReport, submittedName, submittedAddress, formData } = options;
  const timings = {};

  // 1. Normalize
  const t0 = Date.now();
  const normalized = normalizeSoftPullPayload(rawResponses);
  timings.normalize = Date.now() - t0;

  // 2. Identity & Fraud Gate
  const t1 = Date.now();
  const identityGate = runIdentityAndFraudGate(normalized, submittedName, submittedAddress);
  timings.identityGate = Date.now() - t1;

  // 3. Consumer Signals
  const t2 = Date.now();
  const consumerSignals = deriveConsumerSignals(normalized);
  timings.consumer = Date.now() - t2;

  // 4. Business Signals
  const t3 = Date.now();
  const businessSignals = deriveBusinessSignals(businessReport);
  timings.business = Date.now() - t3;

  // 5. Route Outcome
  const t4 = Date.now();
  const outcomeResult = routeOutcome(consumerSignals, businessSignals, identityGate);
  timings.outcome = Date.now() - t4;

  // 6. Estimate Pre-approvals
  const t5 = Date.now();
  const preapprovals = estimatePreapprovals(
    consumerSignals,
    businessSignals,
    outcomeResult.outcome
  );
  timings.preapprovals = Date.now() - t5;

  // 7. Optimization Findings
  const t6 = Date.now();
  const findings = buildOptimizationFindings(
    consumerSignals,
    businessSignals,
    outcomeResult.outcome,
    preapprovals,
    {
      tradelines: normalized.tradelines,
      inquiries: normalized.inquiries,
      identity: normalized.identity,
      identityGate,
      formData
    }
  );
  timings.findings = Date.now() - t6;

  // 7b. Projected Pre-approvals — re-run with fixes applied
  const t6b = Date.now();
  let projectedPreapproval = null;
  if (findings.length > 0) {
    const projected = buildProjectedSignals(consumerSignals, findings);
    projectedPreapproval = estimatePreapprovals(projected, businessSignals, outcomeResult.outcome);
  }
  timings.projectedPreapproval = Date.now() - t6b;

  // 8. Suggestions
  const t7 = Date.now();
  const suggestions = buildSuggestions(
    findings,
    outcomeResult.outcome,
    consumerSignals,
    businessSignals,
    projectedPreapproval
  );
  timings.suggestions = Date.now() - t7;

  // 9. Cards (tags)
  const cards = buildCards(outcomeResult.outcome, consumerSignals, businessSignals, findings);

  // 10. Documents
  const documents = buildDocuments(outcomeResult.outcome, findings, normalized, consumerSignals);

  // 11. CRM Payload
  const t8 = Date.now();
  const crmPayload = buildCrmPayload({
    normalized,
    consumerSignals,
    businessSignals,
    outcomeResult,
    preapprovals,
    cards,
    documents,
    suggestions,
    formData
  });
  timings.output = Date.now() - t8;

  // 12. Audit Trail
  const audit = buildAuditTrail({
    normalized,
    identityGate,
    consumerSignals,
    businessSignals,
    outcomeResult,
    preapprovals,
    findings,
    timings
  });

  // 13. Summaries (Gaps 10 & 11)
  const consumerSummary = buildConsumerSummary(consumerSignals);
  const businessSummary = buildBusinessSummary(businessSignals);

  // Redirect
  const redirectPath = REDIRECT_PATHS[outcomeResult.outcome] || null;
  const redirect = {
    url: redirectPath ? (redirectPath === "funding" ? "funding-approved" : "fix-my-credit") : null,
    path: redirectPath
  };

  // ── Canonical Output (spec Section 6) ───────────────────────────────
  const decisionInfo = DECISION_LABELS[outcomeResult.outcome] || {
    label: outcomeResult.outcome,
    explanation: ""
  };

  return {
    ok: true,
    outcome: outcomeResult.outcome,
    decision_label: decisionInfo.label,
    decision_explanation: decisionInfo.explanation,
    reason_codes: outcomeResult.reasonCodes,
    confidence: outcomeResult.confidence,
    consumer_summary: consumerSummary,
    business_summary: businessSummary,
    preapprovals,
    projectedPreapproval,
    optimization_findings: findings,
    suggestions,
    cards,
    documents,
    redirect,
    crm_payload: crmPayload,
    audit,
    // Internal detail (not in spec top-level, but useful for downstream)
    normalized,
    identityGate,
    consumerSignals,
    businessSignals,
    outcomeResult,
    findings,
    crmPayload
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { runCRSEngine, buildConsumerSummary, buildBusinessSummary };
