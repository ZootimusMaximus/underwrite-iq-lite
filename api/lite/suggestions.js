// ============================================================================
// UnderwriteIQ — Suggestion Engine (Standalone)
// ============================================================================

function buildSuggestions(uw, user = {}) {
  const out = [];

  const o = uw.optimization || {};
  const m = uw.metrics || {};
  const p = uw.personal || {};

  const util = m.utilization_pct;
  const totalInq = m.inquiries?.total || 0;
  const neg = m.negative_accounts || 0;

  // ---------------------------
  // UTILIZATION
  // ---------------------------
  if (o.needs_util_reduction) {
    if (util >= 80) {
      out.push(
        "Your utilization is extremely high (80%+). Paying balances down aggressively will unlock a large jump in scores and approvals."
      );
    } else if (util >= 50) {
      out.push(
        "Your utilization is high (50–80%). Reducing revolving balances under 30% will significantly improve approval odds and limits."
      );
    } else {
      out.push(
        "Lower your revolving utilization below ~30% for optimal approval odds and limit assignments."
      );
    }
  }

  // ---------------------------
  // PRIMARY REVOLVING
  // ---------------------------
  if (o.needs_new_primary_revolving) {
    out.push(
      "Add a strong primary revolving account (not AU) with a $5,000+ limit to anchor your profile before stacking."
    );
  }

  // ---------------------------
  // INQUIRIES
  // ---------------------------
  if (o.needs_inquiry_cleanup) {
    if (totalInq > 12) {
      out.push(
        "You have a high number of recent hard inquiries. Cleaning these up will prevent auto-declines and open up better approvals."
      );
    } else {
      out.push(
        "Removing unnecessary or duplicate hard inquiries will improve automated underwriting scores and limit increases."
      );
    }
  }

  // ---------------------------
  // NEGATIVE ITEMS
  // ---------------------------
  if (o.needs_negative_cleanup) {
    if (neg > 5) {
      out.push(
        "You have multiple negative accounts. Prioritize charge-offs and collections first to unlock the biggest score gains."
      );
    } else {
      out.push(
        "You have some negative accounts. Targeted disputes and settlement strategy will help remove them from your reports."
      );
    }
  }

  // ---------------------------
  // FILE BUILDOUT
  // ---------------------------
  if (o.needs_file_buildout) {
    if (o.file_all_negative) {
      out.push(
        "Your file is mostly negative or very thin. Add 1–2 new primary tradelines and a small installment account to rebuild your foundation."
      );
    } else if (p.highest_revolving_limit === 0 && p.highest_installment_amount === 0) {
      out.push(
        "Your file is thin. Add at least one primary credit card and one small installment loan to establish depth."
      );
    } else {
      out.push(
        "Add a couple of additional positive tradelines to strengthen your profile and unlock higher funding tiers."
      );
    }
  }

  // ---------------------------
  // LLC LOGIC
  // ---------------------------
  const hasLLC = user.hasLLC ?? false;
  const llcAge = user.llcAgeMonths ?? 0;

  if (!hasLLC && uw.fundable) {
    out.push(
      "You’re approved, but you don’t have an LLC. Forming one now lets you unlock business funding immediately."
    );
  } else if (!hasLLC && !uw.fundable) {
    out.push(
      "You don’t have an LLC yet. Form an LLC now so it can season while your credit is being repaired."
    );
  } else if (hasLLC && llcAge < 6) {
    out.push(
      "Your LLC is under 6 months old. Approvals and limits improve significantly after it seasons past 6 months."
    );
  } else if (hasLLC && llcAge >= 6 && llcAge < 24) {
    out.push(
      "Your LLC is seasoning well. Once it matures past 12–24 months, business approvals increase even more."
    );
  } else if (hasLLC && llcAge >= 24 && uw.fundable) {
    out.push(
      "Your LLC is fully seasoned. Combined with a strong personal profile, you are positioned for top-tier business limits."
    );
  } else if (hasLLC && llcAge >= 24 && !uw.fundable) {
    out.push(
      "Your LLC is seasoned. Once personal cleanup finishes, you will unlock the highest tiers of business approvals."
    );
  }

  // ---------------------------
  // FALLBACK
  // ---------------------------
  if (out.length === 0) {
    if (uw.fundable) {
      out.push(
        "Your profile is strong. The next step is proper sequencing and lender selection to maximize total approvals."
      );
    } else {
      out.push(
        "You're close to approval. A few targeted improvements will push you into approval range."
      );
    }
  }

  return out;
}

module.exports = { buildSuggestions };
