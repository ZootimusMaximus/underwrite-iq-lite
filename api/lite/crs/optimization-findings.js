"use strict";

/**
 * optimization-findings.js — Stage 07: Optimization Findings
 *
 * Detects 14 categories of credit optimization opportunities and
 * generates structured findings with customer-safe language.
 */

// ---------------------------------------------------------------------------
// Finding Categories
// ---------------------------------------------------------------------------

const FINDINGS = {
  UTIL_STRESS: {
    code: "UTIL_STRESS",
    category: "utilization",
    customerSafe: true
  },
  NO_REVOLVING_ANCHOR: {
    code: "NO_REVOLVING_ANCHOR",
    category: "tradeline_depth",
    customerSafe: true
  },
  THIN_FILE: {
    code: "THIN_FILE",
    category: "tradeline_depth",
    customerSafe: true
  },
  INQUIRY_PRESSURE: {
    code: "INQUIRY_PRESSURE",
    category: "inquiries",
    customerSafe: true
  },
  ACTIVE_CHARGEOFF: {
    code: "ACTIVE_CHARGEOFF",
    category: "derogatory",
    customerSafe: true
  },
  ACTIVE_COLLECTION: {
    code: "ACTIVE_COLLECTION",
    category: "derogatory",
    customerSafe: true
  },
  ACTIVE_60_90_120: {
    code: "ACTIVE_60_90_120",
    category: "derogatory",
    customerSafe: true
  },
  BANKRUPTCY_LIEN_JUDGMENT: {
    code: "BANKRUPTCY_LIEN_JUDGMENT",
    category: "public_records",
    customerSafe: true
  },
  AU_DOMINANT: {
    code: "AU_DOMINANT",
    category: "tradeline_quality",
    customerSafe: true
  },
  SUPPORT_DELINQUENCY: {
    code: "SUPPORT_DELINQUENCY",
    category: "derogatory",
    customerSafe: false
  },
  STALE_REPORT: {
    code: "STALE_REPORT",
    category: "data_quality",
    customerSafe: true
  },
  IDENTITY_FRAUD: {
    code: "IDENTITY_FRAUD",
    category: "identity",
    customerSafe: false
  },
  NO_LLC_YOUNG_LLC: {
    code: "NO_LLC_YOUNG_LLC",
    category: "business",
    customerSafe: true
  },
  WEAK_BUSINESS: {
    code: "WEAK_BUSINESS",
    category: "business",
    customerSafe: true
  },
  BUSINESS_UCC_CAUTION: {
    code: "BUSINESS_UCC_CAUTION",
    category: "business",
    customerSafe: false
  }
};

// ---------------------------------------------------------------------------
// Severity + Text Builders
// ---------------------------------------------------------------------------

function makeFinding(template, severity, texts) {
  return {
    ...template,
    severity,
    plainEnglishProblem: texts.problem,
    whyItMatters: texts.matters,
    whatToDoNext: texts.next,
    targetState: texts.target || "",
    documentTriggers: texts.docs || [],
    workflowTags: texts.tags || []
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * buildOptimizationFindings(consumerSignals, businessSignals, outcome, preapprovals, options)
 *
 * @param {Object} consumerSignals
 * @param {Object} businessSignals
 * @param {string} outcome
 * @param {Object} preapprovals
 * @param {Object} [options]
 * @param {Array} [options.tradelines] - Normalized tradelines for support detection
 * @param {Object} [options.identityGate] - Identity gate result for stale report detection
 * @param {Object} [options.formData] - Form data with hasLLC, llcAgeMonths for fallback detection
 * @returns {Array<Object>} findings
 */
function buildOptimizationFindings(
  consumerSignals,
  businessSignals,
  outcome,
  preapprovals,
  options
) {
  const cs = consumerSignals;
  const bs = businessSignals;
  const { tradelines, identityGate, formData } = options || {};
  const findings = [];

  // 1. UTIL_STRESS — utilization > 30%
  if (
    cs.utilization.band === "moderate" ||
    cs.utilization.band === "high" ||
    cs.utilization.band === "critical"
  ) {
    const sev =
      cs.utilization.band === "critical"
        ? "critical"
        : cs.utilization.band === "high"
          ? "high"
          : "medium";
    findings.push(
      makeFinding(FINDINGS.UTIL_STRESS, sev, {
        problem: `Your credit utilization is at ${cs.utilization.pct}% across your revolving accounts.`,
        matters:
          "Lenders view utilization above 30% as a risk signal. Lower utilization improves scores and approval odds.",
        next: `Pay down revolving balances to below 30% of your total limits ($${Math.round(cs.utilization.totalLimit * 0.3)} target balance).`,
        target: "Utilization under 30%",
        docs: ["balance_reduction_guidance"],
        tags: ["needs_paydown"]
      })
    );
  }

  // 2. NO_REVOLVING_ANCHOR — no qualifying revolving anchor
  if (!cs.anchors.revolving) {
    findings.push(
      makeFinding(FINDINGS.NO_REVOLVING_ANCHOR, "medium", {
        problem: "You don't have a seasoned revolving credit line with a high limit.",
        matters:
          "A strong revolving anchor (open 2+ years, $5K+ limit) is the primary driver for card-based funding estimates.",
        next: "Open a primary credit card and maintain it for 24+ months with on-time payments.",
        target: "Revolving anchor with $5K+ limit",
        docs: ["tradeline_guidance"],
        tags: ["needs_revolving"]
      })
    );
  }

  // 3. THIN_FILE — < 3 primary tradelines
  if (cs.tradelines.thinFile) {
    findings.push(
      makeFinding(FINDINGS.THIN_FILE, "medium", {
        problem: `You have only ${cs.tradelines.primary} primary tradeline(s). Most lenders want to see at least 3.`,
        matters: "A thin credit file limits your approval options and reduces funding amounts.",
        next: "Open additional primary accounts (credit cards, installment loans) to build depth.",
        target: "3+ primary tradelines",
        docs: ["buildout_strategy"],
        tags: ["needs_file_buildout"]
      })
    );
  }

  // 4. INQUIRY_PRESSURE — 6+ inquiries in 6 months
  if (cs.inquiries.pressure === "high" || cs.inquiries.pressure === "storm") {
    const sev = cs.inquiries.pressure === "storm" ? "high" : "medium";
    findings.push(
      makeFinding(FINDINGS.INQUIRY_PRESSURE, sev, {
        problem: `You have ${cs.inquiries.last6Mo} credit inquiries in the last 6 months.`,
        matters: "Excessive inquiries signal desperation to lenders and can lower scores.",
        next: "Avoid applying for new credit for 6-12 months to let inquiry pressure fade.",
        target: "2 or fewer inquiries in 6 months",
        docs: ["inquiry_removal_letter"],
        tags: ["needs_inquiry_cleanup"]
      })
    );
  }

  // 5. ACTIVE_CHARGEOFF
  if (cs.derogatories.chargeoffs > 0) {
    findings.push(
      makeFinding(FINDINGS.ACTIVE_CHARGEOFF, "critical", {
        problem: `You have ${cs.derogatories.chargeoffs} charge-off(s) on your credit report.`,
        matters:
          "Charge-offs are among the most damaging items. They must be resolved before most funding is available.",
        next: "Negotiate pay-for-delete agreements or dispute inaccurate charge-offs with the bureaus.",
        target: "Zero charge-offs",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup"]
      })
    );
  }

  // 6. ACTIVE_COLLECTION
  if (cs.derogatories.collections > 0) {
    findings.push(
      makeFinding(FINDINGS.ACTIVE_COLLECTION, "critical", {
        problem: `You have ${cs.derogatories.collections} collection account(s) reporting.`,
        matters: "Collections severely damage scores and block most funding programs.",
        next: "Dispute inaccurate collections or negotiate settlements with pay-for-delete.",
        target: "Zero collections",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup"]
      })
    );
  }

  // 7. ACTIVE_60_90_120
  if (
    cs.derogatories.active60 > 0 ||
    cs.derogatories.active90 > 0 ||
    cs.derogatories.active120Plus > 0
  ) {
    const count =
      cs.derogatories.active60 + cs.derogatories.active90 + cs.derogatories.active120Plus;
    findings.push(
      makeFinding(FINDINGS.ACTIVE_60_90_120, "high", {
        problem: `You have ${count} account(s) currently 60+ days past due.`,
        matters: "Accounts 60+ days late show active payment problems and block most funding.",
        next: "Bring all past-due accounts current immediately. Contact creditors for payment plans.",
        target: "All accounts current",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup"]
      })
    );
  }

  // 8. BANKRUPTCY_LIEN_JUDGMENT
  const hasBK = cs.derogatories.activeBankruptcy || cs.derogatories.dischargedBankruptcy;
  const hasBizPR =
    bs?.available &&
    (bs.publicRecords?.bankruptcy || bs.publicRecords?.judgment || bs.publicRecords?.taxLien);
  if (hasBK || hasBizPR) {
    const sev = cs.derogatories.activeBankruptcy ? "critical" : "high";
    findings.push(
      makeFinding(FINDINGS.BANKRUPTCY_LIEN_JUDGMENT, sev, {
        problem: "Your credit report shows public record items (bankruptcy, lien, or judgment).",
        matters:
          "Public records are the most severe negative items and can block funding for years.",
        next: cs.derogatories.activeBankruptcy
          ? "Wait for bankruptcy discharge and rebuilding period (typically 2-4 years)."
          : "Ensure discharged items are reporting correctly. Dispute any inaccuracies.",
        target: "Clean public records",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup"]
      })
    );
  }

  // 9. AU_DOMINANT — AU > 60% of tradelines
  if (cs.tradelines.auDominance > 0.6) {
    findings.push(
      makeFinding(FINDINGS.AU_DOMINANT, "medium", {
        problem: `${Math.round(cs.tradelines.auDominance * 100)}% of your tradelines are authorized user accounts.`,
        matters:
          "Lenders discount AU accounts. A file dominated by AU tradelines gets reduced funding.",
        next: "Open primary accounts in your own name to build a stronger independent credit profile.",
        target: "AU accounts under 40% of total",
        docs: ["tradeline_guidance"],
        tags: ["needs_file_buildout"]
      })
    );
  }

  // 10. SUPPORT_DELINQUENCY — child support delinquent (internal only)
  if (cs.derogatories.active > 0 && tradelines) {
    const supportKeywords = [
      "child support",
      "support enforcement",
      "family court",
      "cse ",
      "dcss"
    ];
    const hasSupportTradeline = tradelines.some(tl => {
      const name = (tl.creditorName || tl.subscriberName || "").toLowerCase();
      return supportKeywords.some(kw => name.includes(kw));
    });
    if (hasSupportTradeline) {
      findings.push(
        makeFinding(FINDINGS.SUPPORT_DELINQUENCY, "critical", {
          problem: "A child support or government support obligation appears delinquent.",
          matters:
            "Support obligations are treated as priority debts and can block funding programs.",
          next: "Contact the support enforcement agency to resolve arrears before applying.",
          target: "Support obligations current",
          tags: ["needs_negative_cleanup"]
        })
      );
    }
  }

  // 11. STALE_REPORT — report older than 30 days
  if (identityGate?.reasons?.includes("ALL_REPORTS_STALE")) {
    findings.push(
      makeFinding(FINDINGS.STALE_REPORT, "high", {
        problem: "Your credit report data is more than 30 days old.",
        matters:
          "Stale data may not reflect recent changes and cannot support accurate funding decisions.",
        next: "Pull a fresh credit report to get current data.",
        target: "Report less than 30 days old",
        docs: ["request_updated_report"],
        tags: ["stale_data"]
      })
    );
  }

  // 12. IDENTITY_FRAUD — fraud signals detected
  if (outcome === "FRAUD_HOLD") {
    findings.push(
      makeFinding(FINDINGS.IDENTITY_FRAUD, "critical", {
        problem: "Identity or fraud concerns were detected during analysis.",
        matters: "All funding programs are suspended until identity is verified.",
        next: "Contact our team to verify your identity and resolve any discrepancies.",
        target: "Identity verified",
        tags: ["fraud_hold"]
      })
    );
  }

  // 13. NO_LLC_YOUNG_LLC — no business or < 12 months old
  // Use formData fallback when no business report is available
  if (!bs?.available) {
    if (formData?.hasLLC && formData.llcAgeMonths != null && formData.llcAgeMonths >= 12) {
      // Form says they have an LLC 12+ months — no finding needed, just no report
    } else if (formData?.hasLLC && formData.llcAgeMonths != null && formData.llcAgeMonths < 12) {
      findings.push(
        makeFinding(FINDINGS.NO_LLC_YOUNG_LLC, "low", {
          problem: `Your business is only ${formData.llcAgeMonths} months old (from application).`,
          matters: "Most business funding programs require at least 12 months of business history.",
          next: "Continue building your business credit history. Apply for business credit cards to establish tradelines.",
          target: "12+ months business history",
          docs: ["business_buildout_guide"],
          tags: ["business_prep"]
        })
      );
    } else {
      findings.push(
        makeFinding(FINDINGS.NO_LLC_YOUNG_LLC, "low", {
          problem: "No business entity was found for your application.",
          matters: "Having an established business entity unlocks additional funding programs.",
          next: "Form an LLC or corporation and build business credit for 12+ months.",
          target: "Active LLC/Corp with 12+ months history",
          docs: ["business_formation_guide"],
          tags: ["business_prep"]
        })
      );
    }
  } else if (bs.profile.ageMonths != null && bs.profile.ageMonths < 12) {
    findings.push(
      makeFinding(FINDINGS.NO_LLC_YOUNG_LLC, "low", {
        problem: `Your business is only ${bs.profile.ageMonths} months old.`,
        matters: "Most business funding programs require at least 12 months of business history.",
        next: "Continue building your business credit history. Apply for business credit cards to establish tradelines.",
        target: "12+ months business history",
        docs: ["business_buildout_guide"],
        tags: ["business_prep"]
      })
    );
  }

  // 14. WEAK_BUSINESS — intelliscore < 40 or FSR < 30
  if (bs?.available && !bs.hardBlock?.blocked) {
    const weakIntelli = bs.scores.intelliscore != null && bs.scores.intelliscore < 40;
    const weakFsr = bs.scores.fsr != null && bs.scores.fsr < 30;
    if (weakIntelli || weakFsr) {
      findings.push(
        makeFinding(FINDINGS.WEAK_BUSINESS, "medium", {
          problem: `Your business credit scores are below optimal (Intelliscore: ${bs.scores.intelliscore ?? "N/A"}, FSR: ${bs.scores.fsr ?? "N/A"}).`,
          matters: "Weak business scores reduce business funding amounts and approval odds.",
          next: "Pay business obligations on time, reduce days-beyond-terms (DBT), and establish more business tradelines.",
          target: "Intelliscore 60+, FSR 40+",
          docs: ["business_buildout_guide"],
          tags: ["business_prep"]
        })
      );
    }
  }

  // 15. BUSINESS_UCC_CAUTION — UCC filings indicate caution
  if (bs?.available && bs.ucc?.caution) {
    findings.push(
      makeFinding(FINDINGS.BUSINESS_UCC_CAUTION, "medium", {
        problem: "UCC filings on your business credit indicate potential liens or encumbrances.",
        matters: "UCC filings reduce business funding amounts by 30% as a risk precaution.",
        next: "Review UCC filings and resolve or release any that are no longer applicable.",
        target: "Clean UCC filing status",
        docs: ["business_buildout_guide"],
        tags: ["business_prep"]
      })
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildOptimizationFindings,
  FINDINGS
};
