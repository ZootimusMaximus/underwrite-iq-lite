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
   - Business/LLC logic
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

    return {
      valid: true,
      fundable: !!u.fundable,

      // Scores & metrics
      score: m.score || null,
      util: m.utilization_pct ?? null,
      negatives: m.negative_accounts || 0,
      lates: m.late_payment_events || 0,

      // Inquiries
      inquiries: m.inquiries || { ex:0, tu:0, eq:0, total:0 },

      // Credit accounts (raw)
      cards: u.cards || [],      // IMPORTANT for per-card utilization logic
      loans: u.loans || [],

      // AU accounts if parser exposes them
      aus: u.authorized_users || [],

      // Address list (for #10)
      addresses: u.addresses || [],

      // Business info
      hasBusiness: !!u.has_business,
      businessAgeMonths: u.business_age_months || 0,

      // Comparable credit
      highestLimit: u.highest_limit || 0,
      highestLimitAgeMonths: u.highest_limit_age_months || 0,

      // Thin file signal
      thin: !!u.thin_file,

      // FUNDING blocks
      personalFunding:
        (u.personal?.card_funding || 0) +
        (u.personal?.loan_funding || 0),

      businessFunding: u.business?.business_funding || 0,
      totalFunding: u.totals?.total_combined_funding || 0,

      // REPAIR potential
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
      const name = card.name || "One of your cards";
      const util = card.utilization || card.util || 0;
      const isAU = !!card.is_au;

      if (util >= 50) {
        tips.push(`${name} is at ${util}%. Bring it WAY down — target ~3%.`);
      } else if (util >= 30) {
        tips.push(`${name} is at ${util}%. Lower this into single digits.`);
      } else if (util >= 15) {
        tips.push(`${name} is at ${util}%. Good start, but can be optimized to ~3%.`);
      }

      if (isAU && util >= 30) {
        tips.push(
          `${name} is an AU account with high utilization (${util}%). ` +
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
      tips.push(`You have ${t} inquiries. Removing them increases approval odds.`);
    }
    if (n.inquiries.ex > 2) tips.push(`Experian inquiries are highest — prioritize removing EX first.`);
    if (n.inquiries.tu > 2) tips.push(`TransUnion inquiries are high — remove TU inquiries if possible.`);
    if (n.inquiries.eq > 2) tips.push(`Equifax inquiries should be removed to strengthen approvals.`);

    return tips;
  },

  /* ------------------------------------------------------------
     5. Negative & Late Payment Suggestions
     ------------------------------------------------------------ */
  buildDerogatorySuggestions(n) {
    const tips = [];

    if (n.negatives > 0) {
      tips.push(
        `You have ${n.negatives} negative account(s). Removing these will dramatically increase your approval chances.`
      );
    }

    if (n.lates > 0) {
      tips.push(
        `${n.lates} account(s) have late payments. Removing late payments gives a large score boost.`
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     6. Thin File / Missing History Suggestions
     ------------------------------------------------------------ */
  buildThinFileSuggestions(n) {
    const tips = [];

    if (n.thin) {
      tips.push(
        "Your credit history is thin. Add 2–3 secured credit cards and 1 small secured loan to build depth."
      );
      return tips;
    }

    const hasCards = (n.cards && n.cards.length > 0);
    const hasLoans = (n.loans && n.loans.length > 0);

    if (!hasCards) {
      tips.push("You have no credit card history — open 2–3 small-limit or secured cards.");
    }

    if (!hasLoans) {
      tips.push("Add a small secured loan to round out your credit mix.");
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
      const name = au.name || "An AU account";
      const util = au.utilization || 0;

      if (au.is_negative) {
        tips.push(`${name} is negative — remove yourself as an authorized user.`);
      }

      if (util >= 30) {
        tips.push(
          `${name} has high utilization (${util}%). Ask the owner to lower it or remove yourself to protect your score.`
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

    if (n.highestLimit < 20000) {
      tips.push(
        "Build at least one $20,000+ credit card (6+ months old) for strong comparable credit. " +
        "You can do this through credit limit increases or adding a high-limit authorized user."
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     9. Business / LLC Suggestions
     ------------------------------------------------------------ */
  buildBusinessSuggestions(n) {
    const tips = [];

    if (!n.hasBusiness) {
      tips.push(
        "Consider forming an LLC to open up business funding options and long-term bank relationships."
      );
      return tips;
    }

    if (n.businessAgeMonths < 6) {
      tips.push(
        "Your business is still new — as it seasons for a few more months, your business funding options increase."
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     10. ALWAYS include Address Stability Suggestions
     ------------------------------------------------------------ */
  buildAddressSuggestions(n) {
    const tips = [];

    // Always show this one
    tips.push(
      "Make sure your current home address is updated with the credit bureaus. " +
      "A mismatched or outdated address causes automatic denials and slows down credit repair."
    );

    if (Array.isArray(n.addresses)) {
      if (n.addresses.length > 2) {
        tips.push(
          "You have several old addresses showing — cleaning these up improves identity verification and increases approvals."
        );
      }

      const primary = n.addresses.find(a => a.is_primary);
      if (primary && primary.is_old) {
        tips.push(
          "Your primary address appears outdated — update your state ID and ensure your credit reports match your current address."
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

    // Per-card utilization
    tips.push(...this.buildUtilizationSuggestions(n));

    // Derogatories
    tips.push(...this.buildDerogatorySuggestions(n));

    // Inquiries
    tips.push(...this.buildInquirySuggestions(n));

    // Thin file / mix improvements
    tips.push(...this.buildThinFileSuggestions(n));

    // AU cleanup
    tips.push(...this.buildAUSuggestions(n));

    // Comparable credit logic
    tips.push(...this.buildComparableCreditSuggestions(n));

    // Business logic
    tips.push(...this.buildBusinessSuggestions(n));

    // ALWAYS include address stability
    tips.push(...this.buildAddressSuggestions(n));

    // Human-readable fallback
    if (tips.length === 0) tips.push("Everything looks strong — minimal improvements needed.");

    return tips;
  },

  /* ------------------------------------------------------------
     12. Summary Builders
     ------------------------------------------------------------ */

  buildApprovedSummary(n) {
    const s = [];

    s.push("🟢 Approved — Your profile meets underwriting thresholds.");
    if (n.score) s.push(`- Score: ${n.score}`);
    if (n.util !== null) s.push(`- Utilization: ${n.util}%`);
    s.push(`- Inquiries: EX ${n.inquiries.ex} • TU ${n.inquiries.tu} • EQ ${n.inquiries.eq}`);
    if (n.negatives > 0) s.push(`- ${n.negatives} negative account(s) — still fundable`);

    s.push("");
    s.push("Estimated Funding:");
    s.push(`- Personal: $${n.personalFunding.toLocaleString()}`);
    s.push(`- Business: $${n.businessFunding.toLocaleString()}`);
    s.push(`- Total: $${n.totalFunding.toLocaleString()}`);

    return s.join("\n");
  },

  buildRepairSummary(n) {
    const s = [];

    s.push("🔧 Repair Needed — These items are blocking approvals:");
    s.push(`- Score: ${n.score || "--"}`);
    s.push(`- Negatives: ${n.negatives}`);
    s.push(`- Late Payments: ${n.lates}`);
    if (n.util !== null) s.push(`- Utilization: ${n.util}%`);

    s.push("");
    s.push("Funding Potential After Repair:");
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
