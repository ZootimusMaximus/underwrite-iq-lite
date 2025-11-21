// ============================================================================
// UnderwriteIQ — Underwriting Engine (EXTRACTED FROM PARSE-REPORT ORIGINAL)
// NO LOGIC CHANGES. 100% SAME CALCULATIONS. 100% SAME OUTPUT SHAPE.
// ============================================================================

function sanitizeScore(score) {
  if (score == null) return null;
  let s = Number(score);

  if (!Number.isFinite(s)) return null;

  if (s > 9000) s = Math.floor(s / 10); // 8516 → 851
  if (s > 850) s = 850; 
  if (s < 300) return null;

  return s;
}

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim().toLowerCase() === "null") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numOrZero(v) {
  const n = toNumberOrNull(v);
  return n == null ? 0 : n;
}

function monthsSince(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const match = dateStr.match(/^(\d{4})-(\d{2})/);
  if (!match) return null;

  const y = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;

  const opened = new Date(y, m - 1, 1);
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
    score: b.score ?? null,
    utilization_pct: b.utilization_pct ?? null,
    inquiries: b.inquiries ?? null,
    negatives: b.negatives ?? null,
    late_payment_events: b.late_payment_events ?? null,
    names: Array.isArray(b.names) ? b.names : [],
    addresses: Array.isArray(b.addresses) ? b.addresses : [],
    employers: Array.isArray(b.employers) ? b.employers : [],
    tradelines: Array.isArray(b.tradelines) ? b.tradelines : []
  };
}

// ============================================================================
// BUSINESS AGE PARSER
// ============================================================================
function getNumberField(fields, key) {
  if (!fields || fields[key] == null) return null;
  const raw = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ============================================================================
// ⭐ UNDERWRITING ENGINE — EXACTLY AS ORIGINAL (NO LOGIC CHANGED)
// ============================================================================
function computeUnderwrite(bureaus, businessAgeMonthsRaw) {
  const safe = bureaus || {};

  const ex = normalizeBureau(safe.experian);
  const eq = normalizeBureau(safe.equifax);
  const tu = normalizeBureau(safe.transunion);

  ex.score = sanitizeScore(ex.score);
  eq.score = sanitizeScore(eq.score);
  tu.score = sanitizeScore(tu.score);

  const exInq = numOrZero(ex.inquiries);
  const eqInq = numOrZero(eq.inquiries);
  const tuInq = numOrZero(tu.inquiries);
  const totalInq = exInq + eqInq + tuInq;

  function buildBureauSummary(key, label, b) {
    const score = sanitizeScore(b.score);
    const util = toNumberOrNull(b.utilization_pct);
    const neg = numOrZero(b.negatives);
    const lates = numOrZero(b.late_payment_events);
    const tradelines = Array.isArray(b.tradelines) ? b.tradelines : [];

    let highestRevolvingLimit = 0;
    let highestInstallmentAmount = 0;
    let hasAnyRevolving = false;
    let hasAnyInstallment = false;
    let positiveTradelinesCount = 0;

    for (const tl of tradelines) {
      if (!tl) continue;

      const type = String(tl.type || "").toLowerCase();
      const status = String(tl.status || "").toLowerCase();
      const limit = numOrZero(tl.limit);
      const balance = numOrZero(tl.balance);
      const ageMonths = monthsSince(tl.opened);

      const isDerog =
        status.includes("chargeoff") ||
        status.includes("charge-off") ||
        status.includes("collection") ||
        status.includes("derog") ||
        status.includes("repossession") ||
        status.includes("foreclosure");

      if (!isDerog) positiveTradelinesCount++;

      const seasoned = ageMonths != null && ageMonths >= 24;

      if (type === "revolving") {
        hasAnyRevolving = true;
        if (status.includes("open") && seasoned && limit > highestRevolvingLimit) {
          highestRevolvingLimit = limit;
        }
      }

      if (["installment", "auto", "mortgage"].includes(type)) {
        hasAnyInstallment = true;
        const originalAmount = limit || balance;
        if (originalAmount > 0 && seasoned && !isDerog) {
          if (originalAmount > highestInstallmentAmount) {
            highestInstallmentAmount = originalAmount;
          }
        }
      }
    }

    const thinFile = positiveTradelinesCount < 3;
    const fileAllNegative = positiveTradelinesCount === 0 && neg > 0;

    const canCardStack = highestRevolvingLimit >= 5000 && hasAnyRevolving;
    const cardFunding = canCardStack ? highestRevolvingLimit * 5.5 : 0;

    const canLoanStack =
      highestInstallmentAmount >= 10000 &&
      hasAnyInstallment &&
      lates === 0;

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
      neg,
      lates,
      inquiries: numOrZero(b.inquiries),
      tradelines,
      highestRevolvingLimit,
      highestInstallmentAmount,
      hasAnyRevolving,
      hasAnyInstallment,
      thinFile,
      fileAllNegative,
      canCardStack,
      canLoanStack,
      canDualStack: canCardStack && canLoanStack,
      cardFunding,
      loanFunding,
      totalPersonalFunding,
      fundable,
      positiveTradelinesCount
    };
  }

  const bureauSummaries = [
    buildBureauSummary("experian", "Experian", ex),
    buildBureauSummary("equifax", "Equifax", eq),
    buildBureauSummary("transunion", "TransUnion", tu)
  ];

  let primary = bureauSummaries.find(b => b.available) || bureauSummaries[0];
  for (const b of bureauSummaries) {
    if (b.available && b.score > primary.score) primary = b;
  }

  const businessAgeMonths =
    typeof businessAgeMonthsRaw === "number" && Number.isFinite(businessAgeMonthsRaw)
      ? businessAgeMonthsRaw
      : null;

  const fundableBureaus = bureauSummaries.filter(b => b.available && b.fundable);
  const fundableCount = fundableBureaus.length;

  const totalCardFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.available ? b.cardFunding : 0),
    0
  );

  const totalLoanFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.available ? b.loanFunding : 0),
    0
  );

  let scale = 1;
  if (fundableCount === 1) scale = 1 / 3;

  const cardFunding = totalCardFundingBase * scale;
  const loanFunding = totalLoanFundingBase * scale;
  const totalPersonalFunding = cardFunding + loanFunding;

  let businessMultiplier = 0;
  if (businessAgeMonths != null && primary.cardFunding > 0) {
    if (businessAgeMonths < 12) businessMultiplier = 0.5;
    else if (businessAgeMonths < 24) businessMultiplier = 1.0;
    else businessMultiplier = 2.0;
  }

  const canBusinessFund = businessMultiplier > 0;
  const businessFunding = primary.cardFunding * businessMultiplier;
  const totalCombinedFunding = totalPersonalFunding + businessFunding;

  const needsUtilReduction =
    primary.util != null && primary.util > 30;

  const needsNewPrimaryRevolving =
    !primary.hasAnyRevolving || primary.highestRevolvingLimit < 5000;

  const needsInquiryCleanup = totalInq > 0;
  const needsNegativeCleanup = primary.neg > 0;
  const needsFileBuildOut = primary.thinFile || primary.fileAllNegative;

  const optimization = {
    needs_util_reduction: needsUtilReduction,
    target_util_pct: needsUtilReduction ? 30 : null,
    needs_new_primary_revolving: needsNewPrimaryRevolving,
    needs_inquiry_cleanup: needsInquiryCleanup,
    needs_negative_cleanup: needsNegativeCleanup,
    needs_file_buildout: needsFileBuildOut,
    thin_file: primary.thinFile,
    file_all_negative: primary.fileAllNegative
  };

  let liteBannerFunding = primary.cardFunding || cardFunding;
  if (!liteBannerFunding) liteBannerFunding = 15000;

  const fundable =
    primary.score != null &&
    primary.score >= 700 &&
    (primary.util == null || primary.util <= 30) &&
    primary.neg === 0;

  return {
    fundable,
    primary_bureau: primary.key,
    metrics: {
      score: primary.score,
      utilization_pct: primary.util,
      negative_accounts: primary.neg,
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
      can_business_fund: canBusinessFund,
      business_multiplier: businessMultiplier,
      business_funding: businessFunding
    },
    totals: {
      total_personal_funding,
      total_business_funding: businessFunding,
      total_combined_funding: totalCombinedFunding
    },
    optimization,
    lite_banner_funding
  };
}

module.exports = {
  computeUnderwrite,
  getNumberField,
  normalizeBureau
};
