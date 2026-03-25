"use strict";

/**
 * build-documents.js — Stage 10: Document Package Builder
 *
 * Determines which documents to generate based on outcome and findings.
 * Actual PDF creation is handled by existing letter-generator.js + letter-delivery.js.
 */

/**
 * buildDocuments(outcome, findings, normalized, consumerSignals)
 *
 * @returns {{ package, letters[], summary }}
 */
function buildDocuments(outcome, findings, normalized, consumerSignals) {
  const availableBureaus = normalized.meta.availableBureaus || [];

  if (outcome === "FRAUD_HOLD" || outcome === "MANUAL_REVIEW") {
    const summaryDocs = [];
    summaryDocs.push({ type: "hold_notice", description: "Application hold notification", fieldKey: null });
    summaryDocs.push({ type: "operator_checklist", description: "Internal review checklist", fieldKey: null });
    return {
      package: "hold",
      letters: [],
      summaryDocuments: summaryDocs,
      summary:
        outcome === "FRAUD_HOLD"
          ? "Analysis suspended due to identity verification requirements."
          : "Application requires manual review. No documents generated."
    };
  }

  if (outcome === "REPAIR") {
    const letters = [];

    // 3 rounds × available bureaus = dispute letters
    for (let round = 1; round <= 3; round++) {
      for (const bureau of availableBureaus) {
        letters.push({
          type: "dispute",
          bureau,
          round,
          fieldKey: `repair_letter_round_${round}_${bureau.substring(0, 2)}`
        });
      }
    }

    // Personal info update letters (1 per bureau)
    for (const bureau of availableBureaus) {
      letters.push({
        type: "personal_info",
        bureau,
        round: null,
        fieldKey: `repair_letter_personal_info_${bureau.substring(0, 2)}`
      });
    }

    const summaryDocs = [];
    summaryDocs.push({ type: "repair_plan_summary", description: "Customer repair roadmap", fieldKey: "repair_plan_summary_url" });
    summaryDocs.push({
      type: "issue_priority_sheet",
      description: "Prioritized list of credit issues",
      fieldKey: null
    });
    summaryDocs.push({
      type: "operator_checklist",
      description: "Internal repair tracking checklist",
      fieldKey: null
    });

    return {
      package: "repair",
      letters,
      summaryDocuments: summaryDocs,
      summary: `Repair package: ${letters.filter(l => l.type === "dispute").length} dispute letters + ${letters.filter(l => l.type === "personal_info").length} personal info letters.`
    };
  }

  // CONDITIONAL_APPROVAL, FULL_STACK_APPROVAL, PREMIUM_STACK → funding package
  const letters = [];

  // Inquiry removal letters (1 per bureau with inquiries)
  for (const bureau of availableBureaus) {
    const hasInquiries = normalized.inquiries.some(i => i.source === bureau);
    if (hasInquiries) {
      letters.push({
        type: "inquiry_removal",
        bureau,
        round: null,
        fieldKey: `funding_letter_inquiry_${bureau.substring(0, 2)}`
      });
    }
  }

  // Personal info update letters (1 per bureau)
  for (const bureau of availableBureaus) {
    letters.push({
      type: "personal_info",
      bureau,
      round: null,
      fieldKey: `funding_letter_personal_info_${bureau.substring(0, 2)}`
    });
  }

  const summaryDocs = [];
  summaryDocs.push({
    type: "funding_summary",
    description: "Pre-approval funding summary for customer",
    fieldKey: "funding_summary_url"
  });
  summaryDocs.push({
    type: "operator_checklist",
    description: "Internal funding workflow checklist",
    fieldKey: null
  });
  if (consumerSignals?.tradelines?.thinFile || consumerSignals?.tradelines?.auDominance > 0.6) {
    summaryDocs.push({
      type: "business_prep_summary",
      description: "Business credit preparation guide",
      fieldKey: "business_prep_summary_url"
    });
  }

  return {
    package: "funding",
    letters,
    summaryDocuments: summaryDocs,
    summary: `Funding package: ${letters.filter(l => l.type === "inquiry_removal").length} inquiry removal + ${letters.filter(l => l.type === "personal_info").length} personal info letters.`
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildDocuments };
