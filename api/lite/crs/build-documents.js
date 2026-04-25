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
    summaryDocs.push({
      type: "hold_notice",
      description: "Application hold notification",
      fieldKey: null
    });
    summaryDocs.push({
      type: "operator_checklist",
      description: "Internal review checklist",
      fieldKey: null
    });
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

  if (outcome === "REPAIR_ONLY") {
    const letters = [];

    // Round 1 only (Rounds 2/3 generated on-demand later)
    // bundled: true means generate one PDF per bureau containing per-furnisher dispute letters
    for (const bureau of availableBureaus) {
      letters.push({
        type: "dispute",
        bureau,
        round: 1,
        bundled: true,
        fieldKey: `repair_letter_url__round_1__${bureau.substring(0, 2)}`
      });
    }

    // Personal info update letters (1 per bureau)
    for (const bureau of availableBureaus) {
      letters.push({
        type: "personal_info",
        bureau,
        round: null,
        fieldKey: `repair_letter_url__personal_info_dispute__${bureau.substring(0, 2)}`
      });
    }

    const summaryDocs = [];
    summaryDocs.push({
      type: "repair_plan_summary",
      description: "Customer repair roadmap",
      fieldKey: "repair_plan_summary_url"
    });
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

  // FULL_FUNDING, FUNDING_PLUS_REPAIR, PREMIUM_STACK → funding package
  const letters = [];

  // Inquiry removal letters (1 per bureau with inquiries)
  for (const bureau of availableBureaus) {
    const hasInquiries = normalized.inquiries.some(i => i.source === bureau);
    if (hasInquiries) {
      letters.push({
        type: "inquiry_removal",
        bureau,
        round: null,
        fieldKey: `funding_letter_url__inquiry_cleanup__${bureau.substring(0, 2)}`
      });
    }
  }

  // Personal info update letters (1 per bureau)
  for (const bureau of availableBureaus) {
    letters.push({
      type: "personal_info",
      bureau,
      round: null,
      fieldKey: `funding_letter_url__personal_info_cleanup__${bureau.substring(0, 2)}`
    });
  }

  // FUNDING_PLUS_REPAIR: also generate dispute letter specs for dirty bureaus
  // (bureaus with negatives get Round 1 bundled dispute letters alongside funding docs)
  if (outcome === "FUNDING_PLUS_REPAIR") {
    const bureauNegatives = consumerSignals?.bureauNegatives || {};
    for (const bureau of availableBureaus) {
      const bureauInfo = bureauNegatives[bureau];
      if (bureauInfo && !bureauInfo.clean) {
        letters.push({
          type: "dispute",
          bureau,
          round: 1,
          bundled: true,
          fieldKey: `repair_letter_url__round_1__${bureau.substring(0, 2)}`
        });
      }
    }
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

  const disputeCount = letters.filter(l => l.type === "dispute").length;
  return {
    package: "funding",
    letters,
    summaryDocuments: summaryDocs,
    summary: `Funding package: ${letters.filter(l => l.type === "inquiry_removal").length} inquiry removal + ${letters.filter(l => l.type === "personal_info").length} personal info letters${disputeCount > 0 ? ` + ${disputeCount} dispute letter${disputeCount > 1 ? "s" : ""} (dirty bureaus)` : ""}.`
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildDocuments };
