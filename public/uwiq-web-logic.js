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
   • Uses your custom suggestion logic
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

      // track highest limit for revolving
      if (type === "revolving" && limit > highestLimit) {
        highestLimit = limit;
      }

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
      is_old: false
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

      // Inquiries
      inquiries: m.inquiries || { ex: 0, tu: 0, eq: 0, total: 0 },

      // Derived lists
      cards,
      loans,
      aus,
      addresses,

      // Business + file profile
      hasBusiness,
      businessAgeMonths,
      highestLimit:
        highestLimit || this._toNumber(personal.highest_revolving_limit, 0),
      highestLimitAgeMonths: 0,
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
     3. Inquiry logic (ONE clean line)
     ------------------------------------------------------------ */
  buildInquirySuggestion(n) {
    const t = n.inquiries.total || 0;
    if (t === 0) return null;

    return [
      `You have ${t} inquiry${t === 1 ? "" : "ies"}. Removing them increases approval odds.`
    ];
  },

  /* ------------------------------------------------------------
     4. Per-card utilization logic (your exact rules)
     ------------------------------------------------------------ */
  buildUtilizationSuggestions(n) {
    const tips = [];
    if (!Array.isArray(n.cards) || n.cards.length === 0) return tips;

    // Primary revolving = card with highest limit (non-AU preferred)
    let primaryCard = null;
    let primaryLimit = -1;

    n.cards.forEach((card) => {
      if (!card) return;
      const limit = card.limit || 0;
      const isAU = !!card.is_au;
      if (!isAU && limit > primaryLimit) {
        primaryLimit = limit;
        primaryCard = card;
      }
    });

    // Fallback: if no non-AU, use absolute highest limit card
    if (!primaryCard) {
      n.cards.forEach((card) => {
        if (!card) return;
        const limit = card.limit || 0;
        if (limit > primaryLimit) {
          primaryLimit = limit;
          primaryCard = card;
        }
      });
    }

    // 1️⃣ Primary revolving card: ≥ 10% → dollar amount toward ~3%
    if (primaryCard && primaryCard.limit > 0) {
      const name = primaryCard.name || "your primary credit card";
      const util = primaryCard.utilization ?? 0;
      const limit = primaryCard.limit || 0;
      const balance = primaryCard.balance || 0;

      if (util >= 10) {
        const targetBalance = Math.round(limit * 0.03);
        const payDown = balance - targetBalance;
        if (payDown > 0) {
          tips.push(
            `Bring ${name} down by about $${payDown.toLocaleString()} toward ~3%.`
          );
        } else {
          tips.push(
            `Bring ${name} closer to ~3% utilization for maximum approval power.`
          );
        }
      }
    }

    // 2️⃣ AU cards with ≥ 30% utilization
    n.cards.forEach((card) => {
      if (!card) return;
      const name = card.name || "An authorized user card";
      const util = card.utilization ?? 0;
      const isAU = !!card.is_au;

      if (isAU && util >= 30) {
        tips.push(
          `${name} is an authorized user account with high utilization. Remove yourself or have the owner lower the balance.`
        );
      }
    });

    return tips;
  },

  /* ------------------------------------------------------------
     5. Derogatory + late payments (your copy)
     ------------------------------------------------------------ */
  buildDerogatorySuggestions(n) {
    const tips = [];

    if (n.negatives > 0) {
      tips.push(
        `You have ${n.negatives} negative account${n.negatives === 1 ? "" : "s"}. Removing these boosts approvals.`
      );
    }

    if (n.lates > 0) {
      tips.push(
        `${n.lates} account${n.lates === 1 ? "" : "s"} have late payments. Cleaning these gives a score boost.`
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     6. Thin file + missing history (your logic)
     ------------------------------------------------------------ */
  buildThinFileSuggestions(n) {
    const tips = [];
    const hasCards = Array.isArray(n.cards) && n.cards.length > 0;
    const hasLoans = Array.isArray(n.loans) && n.loans.length > 0;

    // If NO revolving cards at all → single suggestion, stop
    if (!hasCards) {
      tips.push(
        "You have no card history. Add 4–5 starter or secured cards from local credit unions."
      );
      return tips;
    }

    // No installment loans AND fundable
    if (!hasLoans && n.fundable) {
      tips.push(
        "Your file is thin. We suggest adding one secured loan after your funding round."
      );
    }

    // No installment loans AND NOT fundable (repair mode)
    if (!hasLoans && !n.fundable) {
      tips.push(
        "Add a small secured installment loan during your repair process to ensure strength in your file when cleanup is complete."
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     7. AU cleanup (your copy)
     ------------------------------------------------------------ */
  buildAUSuggestions(n) {
    const tips = [];
    if (!Array.isArray(n.aus)) return tips;

    n.aus.forEach((au) => {
      if (au && au.is_negative) {
        tips.push(
          `${au.name || "This authorized user account"} is negative. Have the account holder remove you from this card.`
        );
      }
    });

    return tips;
  },

  /* ------------------------------------------------------------
     8. Comparable credit logic (mode-aware)
     ------------------------------------------------------------ */
  buildComparableCreditSuggestions(n, mode) {
    const tips = [];

    if (!Array.isArray(n.cards) || n.cards.length === 0) return tips;

    // Find card with highest limit
    let topCard = null;
    let topLimit = -1;
    n.cards.forEach((card) => {
      if (!card) return;
      const limit = card.limit || 0;
      if (limit > topLimit) {
        topLimit = limit;
        topCard = card;
      }
    });

    if (!topCard || topLimit <= 0) return tips;
    if (topLimit >= 20000) return tips;

    const name = topCard.name || "one of your main cards";

    if (mode === "repair") {
      tips.push(
        `We suggest doing limit increases on your ${name} once your file is clean to get access to the maximum amount of capital.`
      );
    } else if (mode === "approved") {
      tips.push(
        `We suggest doing limit increases on your ${name} during your funding round to unlock maximum fundability and further push approvals.`
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     9. Business credit logic (your rules)
     ------------------------------------------------------------ */
  buildBusinessSuggestions(n, mode) {
    const tips = [];
    const revolvingExists = Array.isArray(n.cards) && n.cards.length > 0;

    // No LLC
    if (!n.hasBusiness) {
      if (!revolvingExists) {
        tips.push(
          "Form an LLC as soon as possible so when your file is seasoned you will get access to business funding."
        );
      } else if (mode === "approved") {
        tips.push(
          "Forming an LLC now opens up fundability based on your current profile, allowing access to additional business funding."
        );
      } else {
        tips.push(
          "Form an LLC now to position yourself for future business funding once your credit is fixed."
        );
      }
      return tips;
    }

    // Has LLC but young business
    if (n.businessAgeMonths < 6) {
      tips.push(
        "We suggest opening an additional LLC to get additional funding in the future."
      );
    }

    return tips;
  },

  /* ------------------------------------------------------------
     10. Address stability (max 2 lines, your copy)
     ------------------------------------------------------------ */
  buildAddressSuggestions(n) {
    const tips = [];

    // Baseline advice
    tips.push("Ensure your current address matches across bureaus.");

    if (Array.isArray(n.addresses) && n.addresses.length > 1) {
      tips.push("Clean up extra old addresses.");
    }

    return tips.slice(0, 2);
  },

  /* ------------------------------------------------------------
     11. Combine all suggestions (order + dedupe)
     ------------------------------------------------------------ */
  buildCombinedSuggestions(n, mode) {
    let tips = [];

    // 1. Utilization
    tips.push(...this.buildUtilizationSuggestions(n));

    // 2. Derogatories
    tips.push(...this.buildDerogatorySuggestions(n));

    // 3. Inquiries
    const inquiryLine = this.buildInquirySuggestion(n);
    if (inquiryLine) tips.push(...inquiryLine);

    // 4. Thin file / missing history
    tips.push(...this.buildThinFileSuggestions(n));

    // 5. AU cleanup
    tips.push(...this.buildAUSuggestions(n));

    // 6. Comparable credit
    tips.push(...this.buildComparableCreditSuggestions(n, mode));

    // 7. Business suggestions
    tips.push(...this.buildBusinessSuggestions(n, mode));

    // 8. Address stability
    tips.push(...this.buildAddressSuggestions(n));

    // Dedupe
    const clean = [...new Set(tips)];

    if (clean.length === 0) {
      clean.push("Everything looks strong.");
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
     15. MAIN EXPORT — full backend payload → display
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
  },

  /* ------------------------------------------------------------
     16. LITE EXPORT — from redirect query string
        For fix-my-credit / funding-approved pages
     ------------------------------------------------------------ */
  buildFromRedirectQuery(search) {
    // search: string like "?personal=..." or a URLSearchParams
    let params;
    if (typeof URLSearchParams !== "undefined") {
      if (search instanceof URLSearchParams) {
        params = search;
      } else {
        const s =
          typeof search === "string"
            ? search
            : typeof window !== "undefined"
            ? window.location.search || ""
            : "";
        params = new URLSearchParams(s);
      }
    } else {
      // super-defensive: no URLSearchParams support
      params = {
        get() {
          return null;
        }
      };
    }

    const getNum = (key, fallback = null) => {
      const v = params.get(key);
      if (v === null || v === "") return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };

    const modeParam = params.get("mode");
    const fundableFlag = params.get("fundable");

    const n = {
      valid: true,
      fundable:
        modeParam === "approved" ||
        modeParam === "fundable" ||
        fundableFlag === "1",

      // core metrics (optional in query)
      score: getNum("score", null),
      util: getNum("util", null),
      negatives: getNum("negatives", 0) ?? getNum("neg", 0),
      lates: getNum("lates", 0) ?? getNum("late", 0),

      inquiries: {
        ex: getNum("inq_ex", getNum("inqEx", 0)),
        tu: getNum("inq_tu", getNum("inqTu", 0)),
        eq: getNum("inq_eq", getNum("inqEq", 0)),
        total: getNum("inq_total", 0)
      },

      // no tradeline detail from redirect
      cards: [],
      loans: [],
      aus: [],
      addresses: [],

      hasBusiness: getNum("business", 0) > 0,
      businessAgeMonths: getNum("biz_age", 0),
      highestLimit: getNum("highestLimit", 0),
      highestLimitAgeMonths: 0,
      thin: params.get("thin") === "1",

      // current funding (approval page)
      personalFunding: getNum("personal", 0) ?? getNum("personalTotal", 0),
      businessFunding: getNum("business", 0) ?? getNum("businessTotal", 0),
      totalFunding:
        getNum("total", null) ??
        getNum("totalCombined", null),

      // potential after repair (repair page)
      personalPotential: getNum("personalPotential", null),
      businessPotential: getNum("businessPotential", null),
      totalPotential: getNum("totalPotential", null)
    };

    if (n.totalFunding == null) {
      n.totalFunding = (n.personalFunding || 0) + (n.businessFunding || 0);
    }

    const classification = this.classify(n);

    return {
      valid: n.valid,
      mode: classification.mode,
      summaryText: this.buildDisplayBlock(n, classification),
      data: n
    };
  },

  /* ------------------------------------------------------------
     17. REDIRECT BUILDER — from normalized object "n"
        Use this on the analyzer page AFTER parse-report
        to build URLs for Approved / Repair pages.
     ------------------------------------------------------------ */
  buildRedirectFromNormalized(n) {
    if (!n || !n.valid) {
      return {
        url: "https://fundhub.ai/fix-my-credit-analyzer",
        query: {}
      };
    }

    const safe = (v) =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;

    const score = n.score ?? null;
    const util  = n.util ?? null;
    const neg   = n.negatives ?? 0;
    const late  = n.lates ?? 0;

    const inq = n.inquiries || {
      ex: 0, tu: 0, eq: 0, total: 0
    };

    const personal = safe(n.personalFunding);
    const business = safe(n.businessFunding);
    const total    = safe(n.totalFunding);

    const personalPotential = safe(n.personalPotential);
    const businessPotential = safe(n.businessPotential);
    const totalPotential    = safe(n.totalPotential);

    // --------------------------------------------------------
    // APPROVED → Funding Approved Page
    // --------------------------------------------------------
    if (n.fundable) {
      return {
        url: "https://fundhub.ai/funding-approved-analyzer-462533",
        query: {
          mode: "approved",

          // For approval page JS
          personalTotal: personal,
          businessTotal: business,
          totalCombined: total,
          funding: total,

          // Metrics for UI
          score,
          util,
          neg,
          late,

          // Inquiries for UI
          inqEx: safe(inq.ex),
          inqTu: safe(inq.tu),
          inqEq: safe(inq.eq),

          // Also send the "UWiq tester" style keys
          personal,
          business,
          total,
          negatives: neg,
          lates: late,
          inq_ex: safe(inq.ex),
          inq_tu: safe(inq.tu),
          inq_eq: safe(inq.eq),
          inq_total: safe(inq.total)
        }
      };
    }

    // --------------------------------------------------------
    // REPAIR → Fix My Credit Page
    // --------------------------------------------------------
    return {
      url: "https://fundhub.ai/fix-my-credit-analyzer",
      query: {
        mode: "repair",

        // After-repair funding for repair page JS
        personalPotential,
        businessPotential,
        totalPotential,

        // Metrics for “Negative Items / Late / Score”
        score,
        util,
        neg,
        late,

        // Inquiries
        inqEx: safe(inq.ex),
        inqTu: safe(inq.tu),
        inqEq: safe(inq.eq),
        inq_total: safe(inq.total),

        // Also send these for compatibility
        negatives: neg,
        lates: late
      }
    };
  }
};

/* ===========================
   END OF UWiq Logic Engine v4
   =========================== */
