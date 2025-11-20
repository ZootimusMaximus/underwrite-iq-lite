/* ============================================================
   UWiq Web Logic — Frontend Display Engine (v4 · 5.1-Compatible)
   ------------------------------------------------------------
   Updated to match new UnderwriteIQ 5.1 backend response:

   Backend shape (parse-report):
   {
     ok: true,
     bureaus: { experian, equifax, transunion },
     underwrite: {
       fundable,
       primary_bureau,
       metrics: {
         score,
         utilization_pct,
         negative_accounts,
         late_payment_events,
         inquiries: { ex, tu, eq, total }
       },
       per_bureau: {...},
       personal: {
         highest_revolving_limit,
         highest_installment_amount,
         can_card_stack,
         can_loan_stack,
         can_dual_stack,
         card_funding,
         loan_funding,
         total_personal_funding
       },
       business: {
         business_age_months,
         can_business_fund,
         business_multiplier,
         business_funding
       },
       totals: {
         total_personal_funding,
         total_business_funding,
         total_combined_funding
       },
       optimization: {
         needs_util_reduction,
         target_util_pct,
         needs_new_primary_revolving,
         needs_inquiry_cleanup,
         needs_negative_cleanup,
         needs_file_buildout,
         thin_file,
         file_all_negative
       },
       lite_banner_funding
     },
     suggestions: { web_summary, email_summary, actions, au_actions },
     redirect: {...}
   }

   This frontend:
   • Derives cards/loans/AUs from bureau tradelines
   • Uses new metrics + optimization flags
   • Keeps your “Approved / Repair” UX & summaries
   • Keeps inquiry / AU / address / business logic
   ============================================================ */

window.UWiq = {
  /* ------------------------------------------------------------
     0. Internal helpers
     ------------------------------------------------------------ */
  _toNumber(value, fallback = 0) {
    if (value === null || value === undefined) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  },

  _isNegativeStatus(status) {
    const s = String(status || "").toLowerCase();
    return (
      s.includes("chargeoff") ||
      s.includes("charge-off") ||
      s.includes("collection") ||
      s.includes("derog") ||
      s.includes("repossession") ||
      s.includes("foreclosure") ||
      s.includes("120") ||
      s.includes("90") ||
      s.includes("60") ||
      s.includes("late")
    );
  },

  _collectTradelines(bureau) {
    if (!bureau || !Array.isArray(bureau.tradelines)) return [];
    return bureau.tradelines;
  },

  _dedupeStrings(arr) {
    const set = new Set();
    const out = [];
    for (const v of arr || []) {
      const s = String(v || "").trim();
      if (!s) continue;
      if (!set.has(s)) {
        set.add(s);
        out.push(s);
      }
    }
    return out;
  },

  /* ------------------------------------------------------------
     1. Normalize parser JSON → compact object "n"
     ------------------------------------------------------------ */
  normalize(data) {
    if (!data || !data.ok || !data.underwrite) {
      return { valid: false, reason: "Invalid or unreadable report." };
    }

    const uw = data.underwrite || {};
    const m = uw.metrics || {};
    const bureaus = data.bureaus || {};
    const ex = bureaus.experian || {};
    const eq = bureaus.equifax || {};
    const tu = bureaus.transunion || {};

    // --- Collect all tradelines from all bureaus ---
    const allTradelines = [
      ...this._collectTradelines(ex),
      ...this._collectTradelines(eq),
      ...this._collectTradelines(tu)
    ];

    const cards = [];
    const loans = [];
    const aus = [];

    let highestLimit = 0;

    allTradelines.forEach((tl) => {
      if (!tl || typeof tl !== "object") return;

      const type = String(tl.type || "").toLowerCase();
      const creditor = tl.creditor || "Credit account";
      const limit = this._toNumber(tl.limit, 0);
      const balance = this._toNumber(tl.balance, 0);
      const isAU = tl.is_au === true;
      const status = tl.status || "";
      const isNegative = this._isNegativeStatus(status);

      const util = limit > 0 ? Math.round((balance / limit) * 100) : 0;

      // track highest limit
      if (type === "revolving" && limit > highestLimit) {
        highestLimit = limit;
      }

      // build card model for revolving
      if (type === "revolving") {
        cards.push({
          name: creditor,
          utilization: util,
          is_au: isAU,
          balance,
          limit,
          status,
          is_negative: isNegative
        });
      }

      // build loan model
      if (["installment", "auto", "mortgage"].includes(type)) {
        loans.push({
          name: creditor,
          type,
          balance,
          limit,
          status,
          is_negative: isNegative
        });
      }

      // AU model
      if (isAU) {
        aus.push({
          name: creditor,
          utilization: util,
          status,
          is_negative: isNegative
        });
      }
    });

    // --- Addresses (simple, safe) ---
    const rawAddresses = [
      ...(Array.isArray(ex.addresses) ? ex.addresses : []),
      ...(Array.isArray(eq.addresses) ? eq.addresses : []),
      ...(Array.isArray(tu.addresses) ? tu.addresses : [])
    ];
    const dedupedAddresses = this._dedupeStrings(rawAddresses);
    const addresses = dedupedAddresses.map((addr, idx) => ({
      label: addr,
      is_primary: idx === 0,
      is_old: false // we don't have age data on frontend
    }));

    // --- Business info ---
    const business = uw.business || {};
    const totals = uw.totals || {};
    const personal = uw.personal || {};
    const optimization = uw.optimization || {};

    const hasBusiness =
      business.business_age_months != null &&
      Number(business.business_age_months) > 0;

    const businessAgeMonths = this._toNumber(
      business.business_age_months,
      0
    );

    // Funding numbers
    const personalFunding =
      this._toNumber(personal.card_funding, 0) +
      this._toNumber(personal.loan_funding, 0);

    const businessFunding = this._toNumber(
      business.business_funding,
      0
    );

    const totalFunding = this._toNumber(
      totals.total_combined_funding,
      personalFunding + businessFunding
    );

    // Potentials: using totals from backend (same shape)
    const personalPotential = this._toNumber(
      personal.total_personal_funding,
      personalFunding
    );
    const businessPotential = this._toNumber(
      business.business_funding,
      businessFunding
    );
    const totalPotential = this._toNumber(
      totals.total_combined_funding,
      personalPotential + businessPotential
    );

    return {
      valid: true,
      fundable: !!uw.fundable,

      // Core metrics
      score: m.score || null,
      util: m.utilization_pct ?? null,
      negatives: m.negative_accounts || 0,
      lates: m.late_payment_events || 0,

      // Inquiries (already combined per backend)
      inquiries: m.inquiries || { ex: 0, tu: 0, eq: 0, total: 0 },

      // Derived lists
      cards,
      loans,
      aus,
      addresses,

      // Business + file profile
      hasBusiness,
      businessAgeMonths,
      highestLimit: highestLimit || this._toNumber(personal.highest_revolving_limit, 0),
      highestLimitAgeMonths: 0, // not available on frontend
      thin: !!optimization.thin_file,

      // Funding (current + potential)
      personalFunding,
      businessFunding,
      totalFunding,
      personalPotential,
      businessPotential,
      totalPotential
    };
  },

  /* ------------------------------------------------------------
     2. Approved vs Repair
     ------------------------------------------------------------ */
  classify(n) {
    if (!n.valid) return { mode: "invalid", reason: n.reason };
    return { mode: n.fundable ? "approved" : "repair" };
  },

  /* ------------------------------------------------------------
     3. Inquiry logic (one line max + optional bureau note)
     ------------------------------------------------------------ */
  buildInquirySuggestion(n) {
    const t = n.inquiries.total || 0;
    if (t === 0) return null;

    const suggestions = [];

    // Main inquiry line
    suggestions.push(
      `You have ${t} inquiry${t === 1 ? "" : "ies"}. Removing them will increase approval odds.`
    );

    // Bureau-specific outlier
    const { ex, tu, eq } = n.inquiries;
    const bureauCounts = { Experian: ex || 0, TransUnion: tu || 0, Equifax: eq || 0 };
    const max = Math.max(ex || 0, tu || 0, eq || 0);

    if (max >= 3 && max >= t * 0.5) {
      const bureau = Object.keys(bureauCounts).find(
        (b) => bureauCounts[b] === max
      );
      if (bureau) {
        suggestions.push(
          `Most of your inquiries are on ${bureau}. Removing those first will help.`
        );
      }
    }

    return suggestions;
  },

  /* ------------------------------------------------------------
     4. Per-card utilization logic
     ------------------------------------------------------------ */
  buildUtilizationSuggestions(n) {
    const tips = [];
    if (!Array.isArray(n.cards)) return tips;

    n.cards.forEach((card) => {
      const name = card.name || "One of your cards";
      const util = card.utilization ?? card.util ?? 0;
      const isAU = !!card.is_au;

      if (util >= 50) tips.push(`${name} is at ${util}%. Bring this down toward ~3%.`);
      else if (util >= 30)
        tips.push(`${name} is at ${util}%. Lowering balances here will help.`);
      else if (util >= 15)
        tips.push(`${name} is at ${util}%. You can optimize this further.`);

      if (isAU && util >= 30) {
        tips.push(
          `${name} is an authorized user account with high utilization. Consider asking the owner to lower it or removing yourself.`
        );
      }
    });

    return tips;
  },

  /* ------------------------------------------------------------
     5. Derogatory + late payments
     ------------------------------------------------------------ */
  buildDerogatorySuggestions(n) {
    const tips = [];

    if (n.negatives > 0) {
      tips.push(
        `You have ${n.negatives} negative account${n.negatives === 1 ? "" : "s"}. Removing these will dramatically increase approval potential.`
      );
    }

    if (n.lates > 0) {
      tips.push(
        `${n.lates} account${n.lates === 1 ? "" : "s"} have late payments. Cleaning these up gives a major score boost.`
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     6. Thin file + no revolving logic
     ------------------------------------------------------------ */
  buildThinFileSuggestions(n) {
    const tips = [];

    const hasCards = n.cards && n.cards.length > 0;

    // If absolutely no revolving history
    if (!hasCards) {
      tips.push(
        "You currently have no active credit card history. Adding 2–3 starter or secured credit cards will build the foundation needed for strong approvals."
      );
      return tips; // Important: do NOT add other credit mix logic
    }

    // Non-thin file mix logic
    if (n.thin) {
      tips.push(
        "Your credit file is thin. Adding at least one secured loan helps build depth."
      );
    }

    const hasLoans = n.loans && n.loans.length > 0;
    if (!hasLoans) {
      tips.push("Adding a small secured loan will help diversify your credit mix.");
    }

    return tips;
  },

  /* ------------------------------------------------------------
     7. AU cleanup
     ------------------------------------------------------------ */
  buildAUSuggestions(n) {
    const tips = [];
    if (!Array.isArray(n.aus)) return tips;

    n.aus.forEach((au) => {
      if (au.is_negative) {
        tips.push(
          `${au.name || "An authorized user account"} is reporting negative. Removing yourself may improve your profile.`
        );
      }
    });

    return tips;
  },

  /* ------------------------------------------------------------
     8. Comparable credit logic (skip if no revolving)
     ------------------------------------------------------------ */
  buildComparableCreditSuggestions(n) {
    const tips = [];

    // Only if revolving exists
    if (!n.cards || n.cards.length === 0) return tips;

    if (n.highestLimit < 20000) {
      tips.push(
        "Building at least one $20,000+ credit line (6+ months old) strengthens comparable credit and increases upper-limit approvals."
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     9. Business LLC logic (never show $0)
     ------------------------------------------------------------ */
  buildBusinessSuggestions(n, mode) {
    const tips = [];

    const revolvingExists = n.cards && n.cards.length > 0;

    if (!n.hasBusiness) {
      if (!revolvingExists) {
        tips.push(
          "While you build your personal credit, forming an LLC can position you for business credit opportunities in the future."
        );
      } else if (mode === "approved") {
        tips.push(
          "Forming an LLC can open additional business credit opportunities as you continue building history."
        );
      } else {
        tips.push(
          "While completing credit repair, forming an LLC now positions you for strong business funding once cleanup is complete."
        );
      }
      return tips;
    }

    if (n.businessAgeMonths < 6) {
      tips.push(
        "As your LLC seasons past the 6-month mark, business approvals increase significantly."
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     10. Address stability (max 2 lines)
     ------------------------------------------------------------ */
  buildAddressSuggestions(n) {
    const tips = [];

    // Always show baseline advice
    tips.push(
      "Ensure your current home address is updated with all three bureaus. A mismatched address can cause auto-denials."
    );

    if (!Array.isArray(n.addresses)) return tips;

    if (n.addresses.length > 3) {
      tips.push(
        "You have multiple old addresses listed — cleaning these up improves verification."
      );
    }

    const primary = n.addresses.find((a) => a.is_primary);
    if (primary && primary.is_old) {
      tips.push(
        "Your primary address appears outdated — update your state ID and make sure all bureaus match."
      );
    }

    return tips.slice(0, 2); // max two lines
  },

  /* ------------------------------------------------------------
     11. Combine all suggestions (deduped, clean, human)
     ------------------------------------------------------------ */
  buildCombinedSuggestions(n, mode) {
    let tips = [];

    // 1. Utilization
    tips.push(...this.buildUtilizationSuggestions(n));

    // 2. Derogatories (negatives + lates)
    tips.push(...this.buildDerogatorySuggestions(n));

    // 3. Inquiries (only once)
    const inquiryLine = this.buildInquirySuggestion(n);
    if (inquiryLine) tips.push(...inquiryLine);

    // 4. Thin file / missing history
    tips.push(...this.buildThinFileSuggestions(n));

    // 5. Authorized user
    tips.push(...this.buildAUSuggestions(n));

    // 6. Comparable credit (only if they have revolving)
    tips.push(...this.buildComparableCreditSuggestions(n));

    // 7. Business suggestions (LLC logic)
    tips.push(...this.buildBusinessSuggestions(n, mode));

    // 8. Address stability (always add)
    tips.push(...this.buildAddressSuggestions(n));

    // Dedupe
    const clean = [...new Set(tips)];

    // Fallback
    if (clean.length === 0) {
      clean.push("Everything looks strong — minimal improvements needed.");
    }

    return clean;
  },

  /* ------------------------------------------------------------
     12. Summary (Approved)
     ------------------------------------------------------------ */
  buildApprovedSummary(n) {
    const out = [];

    out.push("🟢 Approved — your profile meets underwriting thresholds.");

    if (n.score) out.push(`- Score: ${n.score}`);
    if (n.util !== null)
      out.push(`- Utilization: ${n.util}% (ideal is ~3% per card)`);

    out.push(
      `- Inquiries: EX ${n.inquiries.ex || 0} • TU ${n.inquiries.tu || 0} • EQ ${n.inquiries.eq || 0}`
    );

    if (n.negatives > 0) {
      out.push(
        `- ${n.negatives} negative account${n.negatives === 1 ? "" : "s"} — still fundable.`
      );
    }

    out.push("");
    out.push("Estimated Funding:");

    const p = n.personalFunding;
    const b = n.businessFunding;
    const t = n.totalFunding;

    if (t > 0) {
      out.push(`- Personal: $${p.toLocaleString()}`);
      out.push(`- Business: $${b.toLocaleString()}`);
      out.push(`- Total: $${t.toLocaleString()}`);
    } else {
      out.push(
        "- Funding estimates will appear once credit mix is stronger."
      );
    }

    return out.join("\n");
  },

  /* ------------------------------------------------------------
     13. Summary (Repair)
     ------------------------------------------------------------ */
  buildRepairSummary(n) {
    const out = [];

    out.push("🔧 Repair Needed — these items are blocking approvals right now:");

    out.push(`- Score: ${n.score ?? "--"}`);
    out.push(`- Negatives: ${n.negatives}`);
    out.push(`- Late Payments: ${n.lates}`);

    if (n.util !== null)
      out.push(`- Utilization: ${n.util}% (goal is ~3% per card)`);

    out.push("");
    out.push("Funding Potential After Cleanup:");

    const p = n.personalPotential;
    const b = n.businessPotential;
    const t = n.totalPotential;

    if (t > 0) {
      out.push(`- Personal: $${p.toLocaleString()}`);
      out.push(`- Business: $${b.toLocaleString()}`);
      out.push(`- Total: $${t.toLocaleString()}`);
    } else {
      out.push(
        "- Once cleanup is complete, funding opportunities will open up."
      );
    }

    return out.join("\n");
  },

  /* ------------------------------------------------------------
     14. Build display block
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
      this.buildCombinedSuggestions(n, "approved").forEach((t) =>
        out.push("- " + t)
      );
      return out.join("\n");
    }

    if (classification.mode === "repair") {
      out.push(this.buildRepairSummary(n));
      out.push("\n\nPriority Fixes:");
      this.buildCombinedSuggestions(n, "repair").forEach((t) =>
        out.push("- " + t)
      );
      return out.join("\n");
    }

    return "Unknown classification.";
  },

  /* ------------------------------------------------------------
     15. MAIN EXPORT
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

/* ===========================
   END OF UWiq Logic Engine v4
   =========================== */
