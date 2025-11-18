/* ============================================================
   UWiq Web Logic — Frontend Display Engine
   ------------------------------------------------------------
   Contains ALL logic for:
   - Approved vs Repair decision
   - Funding calculations
   - Per-card utilization analysis
   - Inquiry analysis
   - Negative account + late payment analysis
   - Thin-file logic
   - Authorized user logic
   - Comparable credit logic
   - Business/LLC logic (with boost math)
   - Address stability logic
   - English summaries for ISP Tester
   ============================================================ */

window.UWiq = {

  /* ------------------------------------------------------------
     1. Normalize parser JSON into a safe format
     ------------------------------------------------------------ */
  normalize(data) {
    if (!data || !data.ok || !data.underwrite) {
      return { valid: false, reason: "Invalid or unreadable report." };
    }

    const u = data.underwrite;
    const m = u.metrics || {};

    const rawCards = Array.isArray(u.cards) ? u.cards : [];
    const rawAus   = Array.isArray(u.authorized_users) ? u.authorized_users : [];
    const ausFromCards = rawCards.filter(
      c => c.is_au === true || c.is_au === 1 || c.role === "AU"
    );
    const mergedAus = rawAus.concat(ausFromCards);

    return {
      valid: true,
      fundable: !!u.fundable,

      // Scores & metrics
      score: m.score || null,
      util: m.utilization_pct ?? null,
      negatives: m.negative_accounts || 0,
      lates: m.late_payment_events || 0,

      // Inquiries
      inquiries: m.inquiries || { ex: 0, tu: 0, eq: 0, total: 0 },

      // Credit accounts (raw)
      cards: rawCards,                 // used for per-card + primary/AU logic
      loans: Array.isArray(u.loans) ? u.loans : [],

      // AU accounts
      aus: mergedAus,

      // Address list (for #10)
      addresses: Array.isArray(u.addresses) ? u.addresses : [],

      // Business info
      hasBusiness: !!u.has_business,
      businessAgeMonths: u.business_age_months || 0,

      // Comparable credit (may be missing)
      highestLimit: u.highest_limit || 0,
      highestLimitAgeMonths: u.highest_limit_age_months || 0,

      // Thin file signal
      thin: !!u.thin_file,

      // FUNDING blocks (current)
      personalFunding:
        (u.personal?.card_funding || 0) +
        (u.personal?.loan_funding || 0),

      businessFunding: u.business?.business_funding || 0,
      totalFunding: u.totals?.total_combined_funding || 0,

      // REPAIR potential (max after cleanup)
      personalPotential: u.personal?.total_personal_funding || 0,
      businessPotential: u.business?.business_funding || 0,
      totalPotential: u.totals?.total_combined_funding || 0
    };
  },

  /* ------------------------------------------------------------
     2. Approved vs Repair classification
     ------------------------------------------------------------ */
  classify(n) {
    if (!n.valid) return { mode: "invalid", reason: n.reason };
    return { mode: n.fundable ? "approved" : "repair" };
  },

  /* ------------------------------------------------------------
     3. Per-Card Utilization Suggestions
     ------------------------------------------------------------ */
  buildUtilizationSuggestions(n) {
    const tips = [];
    if (!Array.isArray(n.cards)) return tips;

    n.cards.forEach(card => {
      const name = card.name || card.creditor || "One of your cards";
      const limit = card.limit || card.high_credit || 0;
      const balance = card.balance || 0;
      const util = card.utilization ?? card.util ?? (limit > 0 ? Math.round((balance / limit) * 100) : 0);
      const isAU = !!(card.is_au === true || card.is_au === 1 || card.role === "AU");

      if (util >= 15) {
        // Amount needed to get to ~3% utilization
        if (limit > 0) {
          const targetBalance = limit * 0.03;
          const payDown = balance - targetBalance;
          if (payDown > 10) {
            tips.push(
              `${name} is at ${util}%. Paying down about $${Math.round(payDown)
                .toLocaleString()} brings it near 3% utilization.`
            );
          } else {
            tips.push(`${name} is at ${util}%. Aim for single-digit utilization if possible.`);
          }
        } else {
          tips.push(`${name} is at ${util}%. Aim for single-digit utilization if possible.`);
        }
      }

      if (isAU && util >= 30) {
        tips.push(
          `${name} is an authorized-user card with high utilization (${util}%). ` +
          `Ask the owner to reduce it, or consider removing yourself so it doesn’t drag your score down.`
        );
      }
    });

    return tips;
  },

  /* ------------------------------------------------------------
     4. Inquiry Suggestions
     ------------------------------------------------------------ */
  buildInquirySuggestions(n) {
    const t = n.inquiries.total || 0;
    const tips = [];

    if (t > 0) {
      tips.push(`You have ${t} recent inquiries. Removing them increases approval odds.`);
    }
    if (n.inquiries.ex > 2) tips.push(`Experian inquiries are highest — prioritize removing Experian first.`);
    if (n.inquiries.tu > 2) tips.push(`TransUnion inquiries are high — removing TU inquiries will help approvals.`);
    if (n.inquiries.eq > 2) tips.push(`Equifax inquiries are elevated — cleaning these up strengthens approvals.`);

    return tips;
  },

  /* ------------------------------------------------------------
     5. Negative & Late Payment Suggestions
     ------------------------------------------------------------ */
  buildDerogatorySuggestions(n) {
    const tips = [];

    if (n.negatives > 0) {
      tips.push(
        `You have ${n.negatives} negative account(s). Removing these is the #1 way to unlock funding approvals.`
      );
    }

    if (n.lates > 0) {
      tips.push(
        `${n.lates} account(s) have late payments. Removing lates gives a major score and approval boost.`
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     6. Thin File / Missing History Suggestions
     ------------------------------------------------------------ */
  buildThinFileSuggestions(n) {
    const tips = [];

    const hasCards = Array.isArray(n.cards) && n.cards.length > 0;
    const hasLoans = Array.isArray(n.loans) && n.loans.length > 0;

    if (n.thin) {
      tips.push(
        "Your credit history is thin. Add 2–3 small secured credit cards and 1 small secured loan to build depth."
      );
      return tips;
    }

    if (!hasCards) {
      tips.push("You have no credit card history — open 2–3 small-limit or secured cards in your name.");
    }

    if (!hasLoans) {
      tips.push("Add a small secured loan to round out your credit mix and show installment history.");
    }

    return tips;
  },

  /* ------------------------------------------------------------
     7. Authorized User (AU) Suggestions
     ------------------------------------------------------------ */
  buildAUSuggestions(n) {
    const tips = [];
    if (!Array.isArray(n.aus)) return tips;

    n.aus.forEach(au => {
      const name = au.name || au.creditor || "An authorized-user account";
      const util = au.utilization ?? (au.limit > 0 ? Math.round((au.balance / au.limit) * 100) : 0);

      if (au.is_negative) {
        tips.push(`${name} is negative — remove yourself as an authorized user to stop that damage.`);
      }

      if (util >= 30) {
        tips.push(
          `${name} has high utilization (${util}%). Ask the owner to lower the balance or remove you from the card.`
        );
      }
    });

    return tips;
  },

  /* ------------------------------------------------------------
     8. Comparable Credit / High-Limit Strategy
     ------------------------------------------------------------ */
  buildComparableCreditSuggestions(n) {
    const tips = [];
    const cards = Array.isArray(n.cards) ? n.cards : [];

    const primaryCards = cards.filter(
      c => !(c.is_au === true || c.is_au === 1 || c.role === "AU")
    );

    // If they have no primary revolving history, DO NOT suggest 20k limits / limit increases here
    if (primaryCards.length === 0) {
      return tips;
    }

    const highestPrimaryLimit = primaryCards.reduce((max, c) => {
      const lim = c.limit || c.high_credit || 0;
      return lim > max ? lim : max;
    }, 0);

    if (highestPrimaryLimit < 20000) {
      tips.push(
        "Over time, aim to build at least one primary credit card with a $20,000+ limit (6+ months old). " +
        "That becomes strong comparable credit for larger approvals."
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     9. Business / LLC Suggestions + Boost Math
     ------------------------------------------------------------ */
  calculateBusinessBoost(n) {
    const personalMax = n.personalPotential || 0;
    const totalMax = n.totalPotential || 0;
    const boostRaw = Math.max(0, totalMax - personalMax);

    // If boost is tiny, just speak qualitatively
    if (boostRaw < 1000) {
      return {
        amount: 0,
        text:
          "After cleanup, adding an LLC and building business credit can meaningfully increase your total funding capacity."
      };
    }

    return {
      amount: boostRaw,
      text:
        `After cleanup, adding an LLC and building business credit could add roughly ` +
        `$${boostRaw.toLocaleString()} in total funding potential on top of your personal profile.`
    };
  },

  buildBusinessSuggestions(n) {
    const tips = [];
    const boost = this.calculateBusinessBoost(n);

    if (!n.hasBusiness) {
      tips.push(
        "Consider forming an LLC to open up business credit cards and lines separate from your personal profile."
      );
      tips.push(boost.text);
      return tips;
    }

    if (n.businessAgeMonths < 6) {
      tips.push(
        "Your business is still new — as it seasons past 6–12 months, business funding limits increase."
      );
    }

    tips.push(boost.text);
    return tips;
  },

  /* ------------------------------------------------------------
     10. ALWAYS include Address Stability Suggestions
     ------------------------------------------------------------ */
  buildAddressSuggestions(n) {
    const tips = [];

    tips.push(
      "Make sure your current home address is updated with all three bureaus. " +
      "A mismatched or outdated address can trigger auto-denials and slow credit repair."
    );

    if (Array.isArray(n.addresses)) {
      if (n.addresses.length > 2) {
        tips.push(
          "You have multiple old addresses reporting — cleaning these up helps with identity checks during underwriting."
        );
      }

      const primary = n.addresses.find(a => a.is_primary);
      if (primary && primary.is_old) {
        tips.push(
          "Your primary address looks outdated — update your ID and ensure your reports reflect your current residence."
        );
      }
    }

    return tips;
  },

  /* ------------------------------------------------------------
     11. Combined Suggestions (Approved or Repair)
     ------------------------------------------------------------ */
  buildCombinedSuggestions(n, mode) {
    let tips = [];

    // Core levers
    tips.push(...this.buildUtilizationSuggestions(n));
    tips.push(...this.buildDerogatorySuggestions(n));
    tips.push(...this.buildInquirySuggestions(n));
    tips.push(...this.buildAUSuggestions(n));

    // Thin file / mix improvements
    // In APPROVED mode, we keep these but they read as optimization, not “you’re broken”
    tips.push(...this.buildThinFileSuggestions(n));

    // Comparable credit (only if primary revolving exists)
    tips.push(...this.buildComparableCreditSuggestions(n));

    // Business / LLC logic with boost
    tips.push(...this.buildBusinessSuggestions(n));

    // ALWAYS include address stability
    tips.push(...this.buildAddressSuggestions(n));

    // Clean duplicates / overly similar lines (simple dedupe by text)
    const seen = new Set();
    tips = tips.filter(t => {
      const key = t.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (tips.length === 0) tips.push("Everything looks strong — only minor optimization is needed.");

    return tips;
  },

  /* ------------------------------------------------------------
     12. Summary Builders
     ------------------------------------------------------------ */
  buildApprovedSummary(n) {
    const s = [];

    s.push("🟢 Approved — your profile meets underwriting thresholds.");
    if (n.score) s.push(`- Score: ${n.score}`);
    if (n.util !== null) s.push(`- Utilization: ${n.util}% (ideal range is 3–10%)`);
    s.push(`- Inquiries: EX ${n.inquiries.ex} • TU ${n.inquiries.tu} • EQ ${n.inquiries.eq}`);
    if (n.negatives > 0) s.push(`- ${n.negatives} negative account(s) are present but still fundable.`);

    s.push("");
    s.push("Estimated Funding (current):");
    s.push(`- Personal: $${n.personalFunding.toLocaleString()}`);
    s.push(`- Business: $${n.businessFunding.toLocaleString()}`);
    s.push(`- Total: $${n.totalFunding.toLocaleString()}`);

    return s.join("\n");
  },

  buildRepairSummary(n) {
    const s = [];

    s.push("🔧 Repair Needed — these items are blocking approvals right now:");
    s.push(`- Score: ${n.score || "--"}`);
    s.push(`- Negatives: ${n.negatives}`);
    s.push(`- Late Payments: ${n.lates}`);
    if (n.util !== null) s.push(`- Utilization: ${n.util}% (goal is ~3% per card)`);

    s.push("");
    s.push("Funding Potential After Cleanup:");
    s.push(`- Personal: $${n.personalPotential.toLocaleString()}`);
    s.push(`- Business: $${n.businessPotential.toLocaleString()}`);
    s.push(`- Total: $${n.totalPotential.toLocaleString()}`);

    return s.join("\n");
  },

  /* ------------------------------------------------------------
     13. Main English Output Builder
     ------------------------------------------------------------ */
  buildDisplayBlock(n, classification) {
    const out = [];

    if (classification.mode === "invalid") {
      out.push("❌ Report unreadable.");
      out.push(classification.reason);
      return out.join("\n");
    }

    if (classification.mode === "approved") {
      out.push(this.buildApprovedSummary(n));
      out.push("\n\nOptimization Tips:");
      this.buildCombinedSuggestions(n, "approved").forEach(t => out.push("- " + t));
      return out.join("\n");
    }

    if (classification.mode === "repair") {
      out.push(this.buildRepairSummary(n));
      out.push("\n\nPriority Fixes:");
      this.buildCombinedSuggestions(n, "repair").forEach(t => out.push("- " + t));
      return out.join("\n");
    }

    return "Unknown classification.";
  },

  /* ------------------------------------------------------------
     14. MAIN EXPORT FOR TESTER
     ------------------------------------------------------------ */
  buildDisplay(rawJson) {
    const n = this.normalize(rawJson);
    const classification = this.classify(n);

    return {
      valid: n.valid,
      mode: classification.mode,
      summaryText: this.buildDisplayBlock(n, classification),
      data: n
    };
  }
};

/* End of UWiq Web Logic */
