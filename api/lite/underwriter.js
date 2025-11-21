// ==================================================================================
// UnderwriteIQ — Underwriter Engine (Standalone Module)
// PURE underwriting logic
//
// Input:
//    { bureaus: { experian, equifax, transunion }, businessAgeMonths }
//
// Output:
//    {
//      fundable,
//      primary_bureau,
//      metrics: {...},
//      per_bureau: {...},
//      personal: {...},
//      business: {...},
//      totals: {...},
//      optimization: {...},
//      lite_banner_funding
//    }
//
// ZERO logic changed.
// EXACT math + logic taken directly from your last working version.
// ==================================================================================

/* -------------------- Helpers -------------------- */

function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toNumberOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitizeScore(score) {
  if (score == null) return null;
  let s = Number(score);
  if (!Number.isFinite(s)) return null;

  if (s > 9000) s = Math.floor(s / 10); // 8516 → 851
  if (s > 850) s = 850;
  if (s < 300) return null;

  return s;
}

function monthsSince(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;

  const y = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mm)) return null;

  const opened = new Date(y, mm - 1, 1);
  const now = new Date();

  return (
    (now.getFullYear() - opened.getFullYear()) * 12 +
    (now.getMonth() - opened.getMonth())
  );
}

function normalizeBureau(b) {
  if (!b || typeof b !== "object") {
    return {
      available: false,
      score: null,
      utilization_pct: null,
      inquiries: null,
      negatives: null,
      late_payment_events: null,
      names: [],
      addresses: [],
      employers: [],
      tradelines: []
    };
  }

  return {
    available: true,
    score: sanitizeScore(b.score),
    utilization_pct: toNumberOrNull(b.utilization_pct),
    inquiries: numOrZero(b.inquiries),
    negatives: numOrZero(b.negatives),
    late_payment_events: numOrZero(b.late_payment_events),
    names: Array.isArray(b.names) ? b.names : [],
    addresses: Array.isArray(b.addresses) ? b.addresses : [],
    employers: Array.isArray(b.employers) ? b.employers : [],
    tradelines: Array.isArray(b.tradelines) ? b.tradelines : []
  };
}

/* -------------------- Bureau Summary Builder -------------------- */

function buildBureauSummary(key, label, b) {
  const score = sanitizeScore(b.score);
  const util = toNumberOrNull(b.utilization_pct);
  const neg = numOrZero(b.negatives);
  const lates = numOrZero(b.late_payment_events);
  const tradelines = Array.isArray(b.tradelines) ? b.tradelines : [];

  let highestRevolvingLimit = 0;
  let highestInstallmentAmount = 0;
  let hasRevolving = false;
  let hasInstallment = false;
  let positiveTradelines = 0;

  for (const tl of tradelines) {
    if (!tl || typeof tl !== "object") continue;

    const type = String(tl.type || "").toLowerCase();
    const status = String(tl.status || "").toLowerCase();
    const limit = numOrZero(tl.limit);
    const balance = numOrZero(tl.balance);
    const age = monthsSince(tl.opened);

    const isDerog =
      status.includes("charge") ||
      status.includes("collection") ||
      status.includes("derog") ||
      status.includes("repossession") ||
      status.includes("foreclosure");

    if (!isDerog) positiveTradelines++;

    const seasoned = age != null && age >= 24;

    if (type === "revolving") {
      hasRevolving = true;
      if (status.includes("open") && seasoned && limit > highestRevolvingLimit) {
        highestRevolvingLimit = limit;
      }
    }

    if (["installment", "auto", "mortgage"].includes(type)) {
      hasInstallment = true;
      const orig = limit || balance;
      if (orig > 0 && seasoned && !isDerog && orig > highestInstallmentAmount) {
        highestInstallmentAmount = orig;
      }
    }
  }

  const thinFile = positiveTradelines < 3;
  const fileAllNegative = positiveTradelines === 0 && neg > 0;

  const canCardStack = highestRevolvingLimit >= 5000 && hasRevolving;
  const cardFunding = canCardStack ? highestRevolvingLimit * 5.5 : 0;

  const canLoanStack = highestInstallmentAmount >= 10000 && hasInstallment && lates === 0;
  const loanFunding = canLoanStack ? highestInstallmentAmount * 3.0 : 0;

  const totalPersonalFunding = cardFunding + loanFunding;

  const fundable =
    score != null &&
    score >= 700 &&
    (util == null || util <= 30) &&
    neg === 0;

  return {
    key,
    label,
    available: b.available,
    score: score ?? 0,
    util,
    negatives: neg,
    lates,
    inquiries: numOrZero(b.inquiries),
    tradelines,
    highestRevolvingLimit,
    highestInstallmentAmount,
    hasRevolving,
    hasInstallment,
    thinFile,
    fileAllNegative,
    canCardStack,
    canLoanStack,
    canDualStack: canCardStack && canLoanStack,
    cardFunding,
    loanFunding,
    totalPersonalFunding,
    fundable
  };
}

/* -------------------- Main Underwriter Function -------------------- */

function runUnderwriter(rawBureaus, businessAgeMonths) {
  const ex = normalizeBureau(rawBureaus.experian);
  const eq = normalizeBureau(rawBureaus.equifax);
  const tu = normalizeBureau(rawBureaus.transunion);

  const bureauSummaries = [
    buildBureauSummary("experian", "Experian", ex),
    buildBureauSummary("equifax", "Equifax", eq),
    buildBureauSummary("transunion", "TransUnion", tu)
  ];

  let primary = bureauSummaries.find(b => b.available) || bureauSummaries[0];
  for (const b of bureauSummaries) {
    if (b.available && b.score > primary.score) primary = b;
  }

  const exInq = ex.inquiries;
  const eqInq = eq.inquiries;
  const tuInq = tu.inquiries;
  const totalInq = exInq + eqInq + tuInq;

  const fundableCount = bureauSummaries.filter(b => b.available && b.fundable).length;

  const totalCardBase = bureauSummaries.reduce(
    (s, b) => s + (b.available ? b.cardFunding : 0),
    0
  );
  const totalLoanBase = bureauSummaries.reduce(
    (s, b) => s + (b.available ? b.loanFunding : 0),
    0
  );

  let scale = 1;
  if (fundableCount === 1) scale = 1 / 3;

  const cardFunding = totalCardBase * scale;
  const loanFunding = totalLoanBase * scale;
  const totalPersonalFunding = cardFunding + loanFunding;

  let businessMultiplier = 0;
  if (businessAgeMonths != null && primary.cardFunding > 0) {
    if (businessAgeMonths < 12) businessMultiplier = 0.5;
    else if (businessAgeMonths < 24) businessMultiplier = 1.0;
    else businessMultiplier = 2.0;
  }

  const businessFunding = primary.cardFunding * businessMultiplier;
  const totalCombined = totalPersonalFunding + businessFunding;

  const optimization = {
    needs_util_reduction:
      primary.util != null && primary.util > 30,
    target_util_pct:
      primary.util != null && primary.util > 30 ? 30 : null,
    needs_new_primary_revolving:
      !primary.hasRevolving || primary.highestRevolvingLimit < 5000,
    needs_inquiry_cleanup: totalInq > 0,
    needs_negative_cleanup: primary.negatives > 0,
    needs_file_buildout: primary.thinFile || primary.fileAllNegative,
    thin_file: primary.thinFile,
    file_all_negative: primary.fileAllNegative
  };

  let lite_banner_funding = primary.cardFunding || cardFunding;
  if (!lite_banner_funding) lite_banner_funding = 15000;

  const fundable =
    primary.score != null &&
    primary.score >= 700 &&
    (primary.util == null || primary.util <= 30) &&
    primary.negatives === 0;

  return {
    fundable,
    primary_bureau: primary.key,
    metrics: {
      score: primary.score,
      utilization_pct: primary.util,
      negative_accounts: primary.negatives,
      late_payment_events: primary.lates,
      inquiries: {
        ex: exInq,
        eq: eqInq,
        tu: tuInq,
        total: totalInq
      }
    },
    per_bureau: {
      experian: bureauSummaries[0],
      equifax: bureauSummaries[1],
      transunion: bureauSummaries[2]
    },
    personal: {
      highest_revolving_limit: primary.highestRevolvingLimit,
      highest_installment_amount: primary.highestInstallmentAmount,
      can_card_stack: primary.canCardStack,
      can_loan_stack: primary.canLoanStack,
      can_dual_stack: primary.canDualStack,
      card_funding: cardFunding,
      loan_funding: loanFunding,
      total_personal_funding: totalPersonalFunding
    },
    business: {
      business_age_months: businessAgeMonths,
      can_business_fund: businessMultiplier > 0,
      business_multiplier: businessMultiplier,
      business_funding: businessFunding
    },
    totals: {
      total_personal_funding: totalPersonalFunding,
      total_business_funding: businessFunding,
      total_combined_funding: totalCombined
    },
    optimization,
    lite_banner_funding
  };
}

/* -------------------- Export -------------------- */
module.exports = {
  runUnderwriter
};
