"use strict";

/**
 * optimization-findings.js — Stage 07: Optimization Findings (v4)
 *
 * Detects 37 categories of credit optimization opportunities.
 * Each finding references specific tradelines by name, gives exact
 * dollar amounts, and generates template text at 5th-grade reading level.
 *
 * Key rules from spec:
 *   - One finding per issue (no grouping negatives)
 *   - Name every account (creditor name, not generic)
 *   - Exact numbers (current AND target)
 *   - Utilization target is always under 10%
 *   - Funding before new accounts
 *   - No cap on findings
 *   - Inquiries "do not affect funding" — never imply they hurt funding
 *   - AU findings: client is "not responsible for the debt"
 *   - Business findings emitted when !hasLLC AND no business report (NO_BUSINESS_ENTITY)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(code, category, severity, customerSafe, data) {
  return {
    code,
    category,
    severity,
    customerSafe,
    plainEnglishProblem: data.problem,
    whyItMatters: data.matters,
    whatToDoNext: data.next,
    targetState: data.target || "",
    documentTriggers: data.docs || [],
    workflowTags: data.tags || [],
    // Structured data for AI text generation
    accountData: data.accountData || null
  };
}

function fmt$(n) {
  if (n == null) return "$0";
  return "$" + Math.round(n).toLocaleString("en-US");
}

function monthsAgo(dateStr, refDate) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const ref = refDate ? new Date(refDate) : new Date();
  if (isNaN(d)) return null;
  return Math.floor((ref - d) / (1000 * 60 * 60 * 24 * 30.44));
}

function isMedicalCreditor(name) {
  const lower = (name || "").toLowerCase();
  const keywords = [
    "medical",
    "hospital",
    "clinic",
    "health",
    "physician",
    "dental",
    "surgery",
    "emergency"
  ];
  return keywords.some(kw => lower.includes(kw));
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
 * @param {Array}  [options.tradelines]  - Normalized tradelines
 * @param {Array}  [options.inquiries]   - Normalized inquiries
 * @param {Object} [options.identity]    - Normalized identity (names, addresses, employers)
 * @param {Object} [options.identityGate]
 * @param {Object} [options.formData]
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
  const {
    tradelines = [],
    inquiries = [],
    identity,
    identityGate: _identityGate,
    formData
  } = options || {};
  const findings = [];

  // =========================================================================
  // 2.1 UTILIZATION
  // =========================================================================

  // UTIL_CARD_OVER_10 — Individual card over 10%
  const openPrimaryRevolving = tradelines.filter(
    tl =>
      tl.status === "open" && !tl.isAU && tl.accountType === "revolving" && tl.effectiveLimit > 0
  );

  for (const tl of openPrimaryRevolving) {
    const util = Math.round((tl.currentBalance / tl.effectiveLimit) * 100);
    if (util > 10) {
      const target10 = Math.round(tl.effectiveLimit * 0.1);
      const sev = util >= 80 ? "critical" : util >= 50 ? "high" : "medium";
      findings.push(
        makeFinding("UTIL_CARD_OVER_10", "utilization", sev, true, {
          problem: `Your ${tl.creditorName} card is at ${util}% utilization. You owe ${fmt$(tl.currentBalance)} on a ${fmt$(tl.effectiveLimit)} limit.`,
          matters:
            "Lenders see this and think you are relying too much on credit. High utilization on individual cards drags your score down.",
          next: `Pay it down to ${fmt$(target10)} or less. That puts you at 10%, which is the ideal range for maximum scores and the best funding offers.`,
          target: `${tl.creditorName} under 10%`,
          docs: ["balance_reduction_guidance"],
          tags: ["needs_paydown"],
          accountData: {
            creditorName: tl.creditorName,
            currentBalance: tl.currentBalance,
            limit: tl.effectiveLimit,
            utilPct: util,
            targetBalance: target10
          }
        })
      );
    }
  }

  // UTIL_OVERALL_HIGH — Overall utilization above 30%
  if (cs.utilization.pct != null && cs.utilization.pct > 30) {
    const target10 = Math.round(cs.utilization.totalLimit * 0.1);
    const sev =
      cs.utilization.band === "critical"
        ? "critical"
        : cs.utilization.band === "high"
          ? "high"
          : "medium";
    findings.push(
      makeFinding("UTIL_OVERALL_HIGH", "utilization", sev, true, {
        problem: `Across all your credit cards, you are using ${cs.utilization.pct}% of your available credit. That is ${fmt$(cs.utilization.totalBalance)} in balances against ${fmt$(cs.utilization.totalLimit)} in limits.`,
        matters: "For the best scores and highest funding amounts, you want to be under 10% total.",
        next: `Get your total balances down to about ${fmt$(target10)}. The lower your utilization, the higher your pre-approval amount and the better your approval odds.`,
        target: "Overall utilization under 10%",
        docs: ["balance_reduction_guidance"],
        tags: ["needs_paydown"]
      })
    );
  }

  // UTIL_MODERATE — Utilization between 10-30%
  if (cs.utilization.pct != null && cs.utilization.pct > 10 && cs.utilization.pct <= 30) {
    const target10 = Math.round(cs.utilization.totalLimit * 0.1);
    findings.push(
      makeFinding("UTIL_MODERATE", "utilization", "medium", true, {
        problem: `Your utilization is at ${cs.utilization.pct}%. That is decent, but you are leaving money on the table.`,
        matters:
          "Under 10% is where the magic happens for funding. The lower your utilization, the higher your pre-approval amount.",
        next: `Get total balances under ${fmt$(target10)}. Push to get every card under 10% of its limit.`,
        target: "Overall utilization under 10%",
        docs: ["balance_reduction_guidance"],
        tags: ["needs_paydown"]
      })
    );
  }

  // AU_HIGH_UTIL — AU card with utilization over 30%
  const auCards = tradelines.filter(
    tl => tl.isAU && tl.status === "open" && tl.accountType === "revolving" && tl.effectiveLimit > 0
  );
  for (const tl of auCards) {
    const util = Math.round((tl.currentBalance / tl.effectiveLimit) * 100);
    if (util > 30) {
      findings.push(
        makeFinding("AU_HIGH_UTIL", "utilization", "medium", true, {
          problem: `You are listed as an authorized user on a ${tl.creditorName} card, and it is at ${util}% utilization. You are not responsible for this debt — it is someone else's account.`,
          matters:
            "Even though this is not your debt, it still counts against your credit utilization.",
          next: `Ask the main cardholder to pay it down, or call ${tl.creditorName} and ask to be removed from the card.`,
          target: "Remove or reduce AU card utilization",
          tags: ["needs_au_review"],
          accountData: {
            creditorName: tl.creditorName,
            currentBalance: tl.currentBalance,
            limit: tl.effectiveLimit,
            utilPct: util,
            isAU: true
          }
        })
      );
    }
  }

  // =========================================================================
  // 2.2 NEGATIVE ITEMS — One finding per item
  // =========================================================================

  // CHARGEOFF_ITEM — Individual charge-off
  const chargeoffs = tradelines.filter(tl => tl.currentRatingType === "ChargeOff");
  for (const tl of chargeoffs) {
    const bureaus = tl.source !== "unknown" ? tl.source : "your report";
    const opened = tl.openedDate
      ? new Date(tl.openedDate).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric"
        })
      : "an unknown date";
    const payOffer40 = tl.currentBalance ? fmt$(tl.currentBalance * 0.4) : null;
    const payOffer60 = tl.currentBalance ? fmt$(tl.currentBalance * 0.6) : null;
    findings.push(
      makeFinding("CHARGEOFF_ITEM", "derogatory", "critical", true, {
        problem: `You have a charge-off from ${tl.creditorName} for ${fmt$(tl.currentBalance || tl.chargeOffAmount)}. This opened in ${opened} and shows up on ${bureaus}.`,
        matters:
          "Charge-offs are one of the worst things on a credit report. They must be resolved before most funding is available.",
        next: payOffer40
          ? `First, we are disputing it with the bureaus using your dispute letters. If it comes back verified, call ${tl.creditorName} and offer to pay 40-60% (${payOffer40}-${payOffer60}) but ONLY if they agree in writing to delete it from your report. Do not pay without that agreement.`
          : `Dispute it with the bureaus using your dispute letters. If verified, negotiate a pay-for-delete with ${tl.creditorName}.`,
        target: "Zero charge-offs",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup"],
        accountData: {
          creditorName: tl.creditorName,
          balance: tl.currentBalance || tl.chargeOffAmount,
          openedDate: tl.openedDate,
          bureau: tl.source
        }
      })
    );
  }

  // COLLECTION_ITEM — Individual collection account
  const collections = tradelines.filter(
    tl =>
      tl.adverseRatings?.highest?.type === "CollectionOrChargeOff" &&
      tl.currentRatingType !== "ChargeOff"
  );
  for (const tl of collections) {
    const isMedical = isMedicalCreditor(tl.creditorName);
    if (isMedical) {
      // MEDICAL_COLLECTION — separate finding
      findings.push(
        makeFinding("MEDICAL_COLLECTION", "derogatory", "medium", true, {
          problem: `You have a medical collection for ${fmt$(tl.currentBalance)}.`,
          matters:
            "Good news: the bureaus have been removing many medical collections due to new rules. If paid or under $500, it may be eligible for automatic removal.",
          next: "Dispute it first. Medical collections are some of the easiest to get removed.",
          target: "Medical collection removed",
          docs: ["dispute_letter"],
          tags: ["needs_negative_cleanup"],
          accountData: {
            creditorName: tl.creditorName,
            balance: tl.currentBalance,
            isMedical: true
          }
        })
      );
    } else {
      const payOffer30 = tl.currentBalance ? fmt$(tl.currentBalance * 0.3) : null;
      const payOffer40 = tl.currentBalance ? fmt$(tl.currentBalance * 0.4) : null;
      findings.push(
        makeFinding("COLLECTION_ITEM", "derogatory", "critical", true, {
          problem: `You have a collection from ${tl.creditorName} for ${fmt$(tl.currentBalance)}.`,
          matters: "Collections severely damage scores and block most funding programs.",
          next: payOffer30
            ? `Step one: your dispute letters challenge this with each bureau. Step two: if verified, send a debt validation letter to ${tl.creditorName}. Step three: if validated, offer 30-40% (${payOffer30}-${payOffer40}) for a pay-for-delete.`
            : `Dispute with the bureaus first, then send a debt validation letter to ${tl.creditorName}.`,
          target: "Zero collections",
          docs: ["dispute_letter"],
          tags: ["needs_negative_cleanup"],
          accountData: {
            creditorName: tl.creditorName,
            balance: tl.currentBalance
          }
        })
      );
    }
  }

  // LATE_PAYMENT_RECENT — Account with late payments in the last 12 months
  // LATE_PAYMENT_OLD — Account with late payments only older than 12 months
  const withLates = tradelines.filter(
    tl =>
      !tl.isAU &&
      tl.latePayments &&
      (tl.latePayments._30 > 0 || tl.latePayments._60 > 0 || tl.latePayments._90 > 0)
  );
  for (const tl of withLates) {
    const total = tl.latePayments._30 + tl.latePayments._60 + tl.latePayments._90;
    const worst =
      tl.latePayments._90 > 0 ? "90-day" : tl.latePayments._60 > 0 ? "60-day" : "30-day";
    // Determine recency: check if account has recent activity (last 12 months)
    const acctAge = monthsAgo(tl.openedDate);
    const isRecent = acctAge != null && acctAge <= 12;
    if (isRecent) {
      findings.push(
        makeFinding("LATE_PAYMENT_RECENT", "derogatory", "high", true, {
          problem: `Your ${tl.creditorName} account shows ${total} late payment(s) in the last 12 months, including ${worst} lates.`,
          matters:
            "Recent late payments are the most damaging — lenders see them as a current risk signal.",
          next: `Get current immediately. Then write a goodwill letter to ${tl.creditorName} asking them to remove the lates. We included a template. Paying on time from here forward is the most important thing you can do.`,
          target: "Zero recent late payments",
          docs: ["dispute_letter"],
          tags: ["needs_negative_cleanup"],
          accountData: {
            creditorName: tl.creditorName,
            late30: tl.latePayments._30,
            late60: tl.latePayments._60,
            late90: tl.latePayments._90,
            worstLevel: worst
          }
        })
      );
    } else {
      findings.push(
        makeFinding("LATE_PAYMENT_OLD", "derogatory", "medium", true, {
          problem: `Your ${tl.creditorName} account shows ${total} late payment(s), including ${worst} lates. These are older than 12 months.`,
          matters:
            "Late payments stay on your report for 7 years, but their impact fades over time. Older lates hurt less.",
          next: `If you have been paying on time since, write a goodwill letter asking ${tl.creditorName} to remove them. We included a template. Another option: dispute with the bureaus. Sometimes the creditor does not respond and it gets removed.`,
          target: "Zero late payments",
          docs: ["dispute_letter"],
          tags: ["needs_negative_cleanup"],
          accountData: {
            creditorName: tl.creditorName,
            late30: tl.latePayments._30,
            late60: tl.latePayments._60,
            late90: tl.latePayments._90,
            worstLevel: worst
          }
        })
      );
    }
  }

  // BANKRUPTCY_ACTIVE
  if (cs.derogatories.activeBankruptcy) {
    findings.push(
      makeFinding("BANKRUPTCY_ACTIVE", "public_records", "critical", true, {
        problem: "Your credit report shows an active bankruptcy.",
        matters: "While active, most funding is off the table.",
        next: "Once discharged (usually 3-6 months), you can start rebuilding. Most people see scores climb within 12-18 months after discharge if they add new positive accounts.",
        target: "Bankruptcy discharged",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup"]
      })
    );
  }

  // BANKRUPTCY_DISCHARGED
  if (cs.derogatories.dischargedBankruptcy && !cs.derogatories.activeBankruptcy) {
    const ageMonths = cs.derogatories.bankruptcyAge;
    findings.push(
      makeFinding("BANKRUPTCY_DISCHARGED", "public_records", "high", true, {
        problem: `You have a discharged bankruptcy${ageMonths != null ? `, about ${ageMonths} months ago` : ""}. It will stay on your report for 7-10 years but its impact fades over time.`,
        matters: "The further you get from the bankruptcy, the less it hurts.",
        next: "Make sure all accounts included in the bankruptcy show $0 balance and correct status. If any still show active or with a balance, dispute them.",
        target: "All BK accounts reporting correctly",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup"]
      })
    );
  }

  // JUDGMENT_ITEM / TAX_LIEN — from public records or derogatory tradelines
  const judgmentTradelines = tradelines.filter(tl => {
    const comments = (tl.comments || []).map(c => (c.text || "").toLowerCase());
    return comments.some(c => c.includes("judgment"));
  });
  for (const tl of judgmentTradelines) {
    findings.push(
      makeFinding("JUDGMENT_ITEM", "public_records", "critical", true, {
        problem: `You have a judgment on your credit report from ${tl.creditorName}.`,
        matters: "Unsatisfied judgments are a deal-breaker for almost every lender.",
        next: "This needs to be satisfied (paid). Once paid, get a Satisfaction of Judgment from the court and send copies to all three bureaus.",
        target: "Judgment satisfied and removed",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup"]
      })
    );
  }

  const taxLienTradelines = tradelines.filter(tl => {
    const comments = (tl.comments || []).map(c => (c.text || "").toLowerCase());
    return comments.some(c => c.includes("tax lien"));
  });
  for (const _tl of taxLienTradelines) {
    findings.push(
      makeFinding("TAX_LIEN", "public_records", "critical", true, {
        problem: "You have a tax lien showing on your credit.",
        matters: "Until resolved, this blocks most funding programs.",
        next: "Contact the IRS or state tax authority to set up a payment plan. Once paid in full, request a Certificate of Release and send to all three bureaus.",
        target: "Tax lien released",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup"]
      })
    );
  }

  // =========================================================================
  // 2.3 TRADELINE DEPTH AND CREDIT MIX
  // =========================================================================

  // THIN_FILE — Fewer than 3 primary tradelines
  if (cs.tradelines.thinFile) {
    findings.push(
      makeFinding("THIN_FILE", "tradeline_depth", "medium", true, {
        problem: `You only have ${cs.tradelines.primary} account(s) in your own name. Most lenders want at least 3.`,
        matters: "A thin credit file limits your approval options and reduces funding amounts.",
        next: "If you are planning to apply for funding, do NOT open new accounts right now. New accounts drop your average credit age and can trigger automatic declines. Go for funding first. After you have secured your funding, then open additional cards to build depth.",
        target: "3+ primary tradelines",
        docs: ["buildout_strategy"],
        tags: ["needs_file_buildout"]
      })
    );
  }

  // NO_REVOLVING_ANCHOR — No seasoned revolving anchor
  if (!cs.anchors.revolving) {
    // Find the best candidate
    const bestRevolving = openPrimaryRevolving
      .filter(tl => !tl.isDerogatory)
      .sort((a, b) => (b.effectiveLimit || 0) - (a.effectiveLimit || 0))[0];

    const candidateMsg = bestRevolving
      ? ` Your ${bestRevolving.creditorName} card${bestRevolving.effectiveLimit ? ` with a ${fmt$(bestRevolving.effectiveLimit)} limit` : ""} is your best candidate. Keep it open, keep the balance low, and let it age.`
      : "";

    findings.push(
      makeFinding("NO_REVOLVING_ANCHOR", "tradeline_depth", "medium", true, {
        problem: `You do not have a strong credit card open for at least 2 years with a good limit.${candidateMsg}`,
        matters:
          "Lenders use your best card as a starting point for how much to offer. A strong revolving anchor drives your funding estimates.",
        next: "If you are looking to get funding now, go through the funding process first. Opening new cards before funding drops your average account age and can hurt your approvals. Build your anchor after funding is secured.",
        target: "Revolving anchor: 24+ months, $5K+ limit",
        docs: ["tradeline_guidance"],
        tags: ["needs_revolving"]
      })
    );
  }

  // NO_INSTALLMENT — No installment loan on file
  if (cs.tradelines.installmentDepth === 0) {
    findings.push(
      makeFinding("NO_INSTALLMENT", "tradeline_depth", "low", true, {
        problem: "You do not have any installment loans on your credit.",
        matters: "Having a mix of credit types helps your score.",
        next: "If you are planning to get funding, do NOT open a new loan right now. Apply for funding first. After that, a small credit builder loan from Self or a local credit union is a great way to add an installment tradeline.",
        target: "At least 1 installment tradeline",
        docs: ["tradeline_guidance"],
        tags: ["needs_file_buildout"]
      })
    );
  }

  // OLDEST_ACCOUNT_SHORT — Oldest account under 24 months
  const primaryTradelines = tradelines.filter(tl => !tl.isAU && tl.openedDate);
  const oldestMonths = primaryTradelines.reduce((max, tl) => {
    const m = monthsAgo(tl.openedDate);
    return m != null && m > max ? m : max;
  }, 0);
  if (oldestMonths > 0 && oldestMonths < 24) {
    findings.push(
      makeFinding("OLDEST_ACCOUNT_SHORT", "tradeline_depth", "medium", true, {
        problem: `Your oldest account is only ${oldestMonths} months old. Lenders want to see a track record.`,
        matters: "Credit age is a major scoring factor. Every month that passes helps.",
        next: "Do not close any current accounts. Just let them age.",
        target: "Oldest account 24+ months",
        tags: ["patience_required"]
      })
    );
  }

  // DONT_CLOSE_OLDEST — Keep oldest account open (info)
  if (oldestMonths >= 24) {
    const oldest = primaryTradelines.sort(
      (a, b) => new Date(a.openedDate) - new Date(b.openedDate)
    )[0];
    if (oldest) {
      findings.push(
        makeFinding("DONT_CLOSE_OLDEST", "tradeline_depth", "info", true, {
          problem: `Your oldest account is your ${oldest.creditorName}, open for ${oldestMonths} months.`,
          matters: "This account is building your credit history every month.",
          next: `Whatever you do, do not close this card. If you are worried about annual fees, call and ask to downgrade to a no-fee version.`,
          target: "Keep oldest account open",
          tags: []
        })
      );
    }
  }

  // =========================================================================
  // 2.4 AUTHORIZED USER MANAGEMENT
  // =========================================================================

  // AU_NEGATIVE_MARKS — AU account with lates or derogs
  for (const tl of auCards) {
    const util =
      tl.effectiveLimit > 0 ? Math.round((tl.currentBalance / tl.effectiveLimit) * 100) : 0;
    const hasLates =
      tl.latePayments &&
      (tl.latePayments._30 > 0 || tl.latePayments._60 > 0 || tl.latePayments._90 > 0);
    if (hasLates || tl.isDerogatory) {
      findings.push(
        makeFinding("AU_NEGATIVE_MARKS", "tradeline_quality", "high", true, {
          problem: `You are on a ${tl.creditorName} card as an authorized user, and it has ${hasLates ? "late payments" : "derogatory marks"} hurting your credit. You are not responsible for this debt — it is someone else's account.`,
          matters:
            "Even though this is not your debt, the negative history still counts against you.",
          next: `Call ${tl.creditorName} and ask to be removed as an authorized user. It should come off your report in 30-60 days.`,
          target: "Remove bad AU account",
          tags: ["needs_au_review"],
          accountData: {
            creditorName: tl.creditorName,
            util,
            isAU: true
          }
        })
      );
    }
  }

  // AU_GOOD_KEEP — Good AU account (info) — util under 10%
  for (const tl of auCards) {
    const util =
      tl.effectiveLimit > 0 ? Math.round((tl.currentBalance / tl.effectiveLimit) * 100) : 0;
    const age = monthsAgo(tl.openedDate);
    const hasLates =
      tl.latePayments &&
      (tl.latePayments._30 > 0 || tl.latePayments._60 > 0 || tl.latePayments._90 > 0);
    if (util < 10 && !hasLates && !tl.isDerogatory && age != null && age >= 36) {
      findings.push(
        makeFinding("AU_GOOD_KEEP", "tradeline_quality", "info", true, {
          problem: `Your ${tl.creditorName} authorized user account is helping your credit. It has been open ${age} months with ${util}% utilization. You are not responsible for this debt — it is adding positive history to your file.`,
          matters: "This account adds age and positive history to your file.",
          next: "Keep this one.",
          target: "Maintain good AU accounts",
          tags: []
        })
      );
    }
  }

  // =========================================================================
  // 2.5 INQUIRIES
  // =========================================================================

  // INQUIRY_REMOVAL — Any inquiries present (even 1)
  if (cs.inquiries.total > 0) {
    findings.push(
      makeFinding("INQUIRY_REMOVAL", "inquiries", "medium", true, {
        problem: `You have ${cs.inquiries.total} hard inquiry(ies) on your credit report.`,
        matters:
          "Inquiries are cleanup only — this does not affect funding. However, removing them keeps your report clean and tidy for lenders.",
        next: `We prioritize Experian first for inquiry removal. Your inquiry removal letters target any that did not result in an account. Send them out and do not apply for new credit until funding is secured.`,
        target: "Inquiries removed where possible",
        docs: ["inquiry_removal_letter"],
        tags: ["needs_inquiry_cleanup"]
      })
    );
  }

  // INQUIRY_DUPLICATE — Same-day duplicate inquiries
  if (inquiries.length > 0) {
    const byDate = {};
    for (const inq of inquiries) {
      if (!inq.date) continue;
      const dateKey = inq.date.substring(0, 10);
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(inq);
    }
    for (const [date, inqs] of Object.entries(byDate)) {
      const uniqueCreditors = [...new Set(inqs.map(i => i.creditorName))];
      if (uniqueCreditors.length >= 2) {
        const names = uniqueCreditors.slice(0, 3).join(" and ");
        const formattedDate = new Date(date).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric"
        });
        findings.push(
          makeFinding("INQUIRY_DUPLICATE", "inquiries", "medium", true, {
            problem: `On ${formattedDate}, you have inquiries from ${names}. Duplicate same-day inquiries can often be disputed.`,
            matters:
              "These do not affect funding, but same-day duplicates from different lenders are good candidates for removal.",
            next: "Your inquiry removal letters cover this. The ones that did not result in an account are the best candidates for removal.",
            target: "Remove duplicate inquiries",
            docs: ["inquiry_removal_letter"],
            tags: ["needs_inquiry_cleanup"]
          })
        );
      }
    }
  }

  // =========================================================================
  // 2.6 PERSONAL DATA CLEANUP
  // =========================================================================

  if (identity) {
    // MULTIPLE_ADDRESSES
    const uniqueAddresses = identity.addresses
      ? [...new Set(identity.addresses.map(a => `${a.line1} ${a.zip}`))]
      : [];
    if (uniqueAddresses.length > 1) {
      findings.push(
        makeFinding("MULTIPLE_ADDRESSES", "personal_data", "low", true, {
          problem: `Your credit report shows ${uniqueAddresses.length} different addresses.`,
          matters: "Lenders want to see stability. Multiple addresses can cause confusion.",
          next: "Your personal info dispute letters clean this up and consolidate to your current address.",
          target: "Single current address",
          docs: ["personal_info_letter"],
          tags: ["needs_personal_cleanup"]
        })
      );
    }

    // NAME_VARIATIONS
    const uniqueNames = identity.names
      ? [...new Set(identity.names.map(n => `${n.first} ${n.last}`.toLowerCase()))]
      : [];
    if (uniqueNames.length > 1) {
      findings.push(
        makeFinding("NAME_VARIATIONS", "personal_data", "low", true, {
          problem: `Your report shows ${uniqueNames.length} versions of your name.`,
          matters: "This can cause confusion and even application denials.",
          next: "Your personal info letters consolidate to your full legal name.",
          target: "Single legal name",
          docs: ["personal_info_letter"],
          tags: ["needs_personal_cleanup"]
        })
      );
    }

    // EMPLOYER_OUTDATED
    if (identity.employers && identity.employers.length > 0 && formData?.employer) {
      const reportEmployers = identity.employers.map(e => (e.name || "").toLowerCase());
      const formEmployer = formData.employer.toLowerCase();
      const mismatch = !reportEmployers.some(e => e.includes(formEmployer));
      if (mismatch) {
        findings.push(
          makeFinding("EMPLOYER_OUTDATED", "personal_data", "low", true, {
            problem: "Your credit report still lists an old employer.",
            matters: "Outdated employer info can cause issues during application verification.",
            next: "Your personal info letters will update it to your current business.",
            target: "Current employer on file",
            docs: ["personal_info_letter"],
            tags: ["needs_personal_cleanup"]
          })
        );
      }
    }
  }

  // =========================================================================
  // 2.7 BUREAU STATUS FINDINGS
  // =========================================================================

  // MIXED_BUREAU_STATUS — Some clean, some dirty bureaus (FUNDING_PLUS_REPAIR)
  if (outcome === "FUNDING_PLUS_REPAIR" && cs.bureauNegatives) {
    const pulled = Object.keys(cs.bureauNegatives).filter(b => cs.bureauNegatives[b].pulled);
    const cleanBureaus = pulled.filter(b => cs.bureauNegatives[b].clean);
    const dirtyBureaus = pulled.filter(b => !cs.bureauNegatives[b].clean);
    if (cleanBureaus.length > 0 && dirtyBureaus.length > 0) {
      findings.push(
        makeFinding("MIXED_BUREAU_STATUS", "derogatory", "high", true, {
          problem: `Your credit bureaus are split: ${cleanBureaus.join(", ")} ${cleanBureaus.length === 1 ? "is" : "are"} clean and ready for funding, but ${dirtyBureaus.join(", ")} ${dirtyBureaus.length === 1 ? "has" : "have"} negative items that need repair.`,
          matters:
            "You can start funding on the clean bureaus now while we repair the others in parallel.",
          next: "Your dispute letters target the dirty bureaus. Once repaired, you will qualify for funding on all three.",
          target: "All bureaus clean",
          docs: ["dispute_letter"],
          tags: ["needs_negative_cleanup", "mixed_bureau"]
        })
      );
    }
  }

  // ALL_BUREAUS_DIRTY — All bureaus have negatives (REPAIR_ONLY)
  if (outcome === "REPAIR_ONLY") {
    findings.push(
      makeFinding("ALL_BUREAUS_DIRTY", "derogatory", "critical", true, {
        problem: "All three of your credit bureaus show negative items that are blocking funding.",
        matters:
          "No funding programs are available until the negatives are resolved. Repair comes first.",
        next: "Your dispute letters challenge each negative item at each bureau. Work through the rounds. Most clients see results within 30-90 days.",
        target: "All bureaus clean",
        docs: ["dispute_letter"],
        tags: ["needs_negative_cleanup", "repair_only"]
      })
    );
  }

  // =========================================================================
  // 2.8 BUSINESS CREDIT
  // =========================================================================

  const hasLLC = bs?.available || formData?.hasLLC;

  // NO_BUSINESS_ENTITY — No LLC and no business report
  if (!hasLLC) {
    findings.push(
      makeFinding("NO_BUSINESS_ENTITY", "business", "low", true, {
        problem: "You do not have a registered business entity on file.",
        matters:
          "Business credit programs require an LLC or corporation. Without one, you are limited to personal credit funding only.",
        next: "Forming an LLC is straightforward — most states allow you to do it online for under $100. Once formed, we can help you build your business credit profile.",
        target: "LLC or corporation registered",
        docs: ["business_buildout_guide"],
        tags: ["business_prep"]
      })
    );
  } else if (!bs?.available && formData?.hasLLC) {
    // Has LLC per form but no business report

    if (formData.llcAgeMonths != null && formData.llcAgeMonths < 12) {
      // LLC_YOUNG
      findings.push(
        makeFinding("LLC_YOUNG", "business", "low", true, {
          problem: `Your LLC is ${formData.llcAgeMonths} months old.`,
          matters: "Most business lenders want 12 months minimum.",
          next: `Keep building. In ${12 - formData.llcAgeMonths} more months your options multiply. At 24 months you hit the highest tier.`,
          target: "12+ months business history",
          docs: ["business_buildout_guide"],
          tags: ["business_prep"]
        })
      );
    }
  } else if (bs?.available) {
    // Has business report

    // LLC_YOUNG (from business report)
    if (bs.profile.ageMonths != null && bs.profile.ageMonths < 12) {
      findings.push(
        makeFinding("LLC_YOUNG", "business", "low", true, {
          problem: `Your LLC is ${bs.profile.ageMonths} months old.`,
          matters: "Most business lenders want 12 months minimum.",
          next: `Keep building. In ${12 - bs.profile.ageMonths} more months your options multiply.`,
          target: "12+ months business history",
          docs: ["business_buildout_guide"],
          tags: ["business_prep"]
        })
      );
    }

    // CONSIDER_AGED_CORP
    if ((bs.profile.ageMonths == null || bs.profile.ageMonths < 12) && cs.scores.median >= 650) {
      findings.push(
        makeFinding("CONSIDER_AGED_CORP", "business", "low", true, {
          problem: "Your personal credit is strong but your business is young.",
          matters: "An aged corporation gives you time-in-business immediately.",
          next: "One option: purchase an aged corporation (a company formed years ago but never used). Costs $1,500-5,000+ depending on age. Our team can help with this.",
          target: "24+ months business history",
          tags: ["business_prep"]
        })
      );
    }

    // BIZ_NEGATIVE_ITEMS — Business has negative items
    if (bs.publicRecords && Object.keys(bs.publicRecords).length > 0) {
      findings.push(
        makeFinding("BIZ_NEGATIVE_ITEMS", "business", "medium", true, {
          problem: "Your business credit report shows negative items.",
          matters:
            "Business negative items reduce your business funding amounts and can block certain programs.",
          next: "Dispute any inaccurate items with Dun & Bradstreet and Experian Business. For verified items, contact the creditor to resolve them.",
          target: "Clean business credit report",
          docs: ["business_buildout_guide"],
          tags: ["business_prep"]
        })
      );
    }

    // BIZ_UTIL_HIGH — Business utilization over 10%
    if (bs.bizUtilization?.pct != null && bs.bizUtilization.pct > 10) {
      findings.push(
        makeFinding("BIZ_UTIL_HIGH", "business", "medium", true, {
          problem: `Your business credit utilization is at ${bs.bizUtilization.pct}%.`,
          matters:
            "Business lenders want to see low utilization on your business lines. High utilization signals cash flow pressure.",
          next: "Pay down business credit card balances. Target under 10% on each business card.",
          target: "Business utilization under 10%",
          docs: ["business_buildout_guide"],
          tags: ["business_prep"]
        })
      );
    }

    // BIZ_UCC_LIEN — UCC filings
    if (bs.ucc?.caution) {
      findings.push(
        makeFinding("BIZ_UCC_LIEN", "business", "medium", true, {
          problem: "Your business has UCC filings that indicate potential liens.",
          matters: "UCC filings reduce business funding amounts as a risk precaution.",
          next: "If any are from paid-off loans, contact the lender and ask them to file a UCC termination.",
          target: "Clean UCC status",
          docs: ["business_buildout_guide"],
          tags: ["business_prep"]
        })
      );
    }
  }

  // =========================================================================
  // 2.9 STRATEGIC OPPORTUNITIES
  // =========================================================================

  // FUNDING_FIRST — Go for funding before opening new accounts
  const isFundable =
    outcome === "FUNDING_PLUS_REPAIR" || outcome === "FULL_FUNDING" || outcome === "PREMIUM_STACK";
  if (isFundable) {
    findings.push(
      makeFinding("FUNDING_FIRST", "strategic", "high", true, {
        problem: "You qualify for funding. Do NOT open new accounts before applying.",
        matters:
          "Every new card or loan you open drops your average account age, adds a hard inquiry, and can trigger automatic declines from lenders.",
        next: "Get your funding locked in first while your file looks its best. After your funding is secured, then you can open new accounts to build depth for future rounds.",
        target: "Secure funding before new accounts",
        tags: ["funding_ready"]
      })
    );
  }

  // REQUEST_CLI — Eligible for credit limit increase
  for (const tl of openPrimaryRevolving) {
    const age = monthsAgo(tl.openedDate);
    const util =
      tl.effectiveLimit > 0 ? Math.round((tl.currentBalance / tl.effectiveLimit) * 100) : 0;
    const hasLates =
      tl.latePayments &&
      (tl.latePayments._30 > 0 || tl.latePayments._60 > 0 || tl.latePayments._90 > 0);
    if (age >= 12 && util < 10 && !hasLates && !tl.isDerogatory) {
      findings.push(
        makeFinding("REQUEST_CLI", "strategic", "low", true, {
          problem: `Your ${tl.creditorName} card has been open ${age} months with on-time payments and low utilization.`,
          matters: "A higher limit lowers your utilization and increases your funding potential.",
          next: `Call ${tl.creditorName} or check your app for a credit limit increase. Many issuers do a soft pull increase if you have been responsible. This does not open a new account or add a hard inquiry.`,
          target: "Higher credit limit",
          tags: [],
          accountData: {
            creditorName: tl.creditorName,
            limit: tl.effectiveLimit,
            ageMonths: age
          }
        })
      );
      break; // Only suggest for best candidate
    }
  }

  // STRONG_ANCHOR — Great revolving anchor exists (info)
  if (
    cs.anchors.revolving &&
    cs.anchors.revolving.limit >= 10000 &&
    cs.anchors.revolving.months >= 24
  ) {
    findings.push(
      makeFinding("STRONG_ANCHOR", "strategic", "info", true, {
        problem: `Your ${cs.anchors.revolving.creditor} with a ${fmt$(cs.anchors.revolving.limit)} limit and ${cs.anchors.revolving.months} months of history is your strongest card.`,
        matters: "This is your anchor — lenders use it as a starting point for offers.",
        next: `Keep it in good standing. Consider calling ${cs.anchors.revolving.creditor} for a limit increase. A higher limit here directly increases your funding number.`,
        target: "Maintain and grow anchor",
        tags: []
      })
    );
  }

  // PREMIUM_MAINTENANCE — File is strong, maintain it (info)
  if (outcome === "PREMIUM_STACK") {
    findings.push(
      makeFinding("PREMIUM_MAINTENANCE", "strategic", "info", true, {
        problem: "Your credit profile is in excellent shape. You are in the top funding tier.",
        matters: "Maintaining this profile keeps you eligible for maximum funding amounts.",
        next: "Keep it there: do not close old accounts, keep balances under 10% of limits, and do not open any new accounts before applying for funding. When ready, application order matters — our team can sequence your applications to maximize approvals.",
        target: "Maintain Premium Stack",
        tags: ["premium_profile"]
      })
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildOptimizationFindings
};
