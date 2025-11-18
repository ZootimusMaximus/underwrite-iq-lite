/* ============================================================
   UWiq Web Logic — Frontend Display Engine
   ------------------------------------------------------------
   Contains ALL logic for:
   - Approved vs Repair decision
   - Funding calculations
   - Optimization suggestions
   - Repair suggestions
   - English summaries for display
   ============================================================ */

window.UWiq = {

  /* ------------------------------------------------------------
     1. Normalize parser JSON
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
      score: m.score || null,
      util: m.utilization_pct ?? null,
      negatives: m.negative_accounts || 0,
      lates: m.late_payment_events || 0,
      inquiries: m.inquiries || { ex:0, tu:0, eq:0, total:0 },

      // Funding blocks
      personalFunding:
        (u.personal?.card_funding || 0) +
        (u.personal?.loan_funding || 0),

      businessFunding: u.business?.business_funding || 0,
      totalFunding: u.totals?.total_combined_funding || 0,

      // Repair potential
      personalPotential: u.personal?.total_personal_funding || 0,
      businessPotential: u.business?.business_funding || 0,
      totalPotential: u.totals?.total_combined_funding || 0
    };
  },

  /* ------------------------------------------------------------
     2. Determine scenario
     ------------------------------------------------------------ */
  classify(n) {
    if (!n.valid) {
      return { mode: "invalid", reason: n.reason };
    }
    return { mode: n.fundable ? "approved" : "repair" };
  },

  /* ------------------------------------------------------------
     3. Approved summary
     ------------------------------------------------------------ */
  buildApprovedSummary(n) {
    const s = [];

    s.push(`🟢 Approved — Your file meets the underwriting thresholds.`);

    if (n.score) s.push(`- Score: ${n.score}`);
    if (n.util !== null) s.push(`- Utilization: ${n.util}% (ideal 3–10%)`);

    s.push(
      `- Inquiries: EX ${n.inquiries.ex} • TU ${n.inquiries.tu} • EQ ${n.inquiries.eq}`
    );

    if (n.negatives > 0) {
      s.push(`- ${n.negatives} negative accounts — still fundable.`);
    }

    s.push("");
    s.push(`Estimated Funding:`);
    s.push(`- Personal: $${n.personalFunding.toLocaleString()}`);
    s.push(`- Business: $${n.businessFunding.toLocaleString()}`);
    s.push(`- Total: $${n.totalFunding.toLocaleString()}`);

    return s.join("\n");
  },

  /* ------------------------------------------------------------
     4. Approved suggestions
     ------------------------------------------------------------ */
  buildApprovedSuggestions(n) {
    const tips = [];

    if (n.util > 15) tips.push("Lower utilization under 10% for higher limits.");
    if (n.util > 30) tips.push("Utilization above 30% severely caps approvals.");
    if (n.inquiries.total > 4) tips.push("Avoid new inquiries for 90 days.");
    if (n.negatives > 0) tips.push(`Removing ${n.negatives} negatives increases approvals.`);

    if (tips.length === 0) tips.push("Everything looks strong — excellent approval profile.");

    return tips;
  },

  /* ------------------------------------------------------------
     5. Repair summary
     ------------------------------------------------------------ */
  buildRepairSummary(n) {
    const s = [];

    s.push(`🔧 Repair Needed — Items are blocking approvals.`);

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
     6. Repair suggestions
     ------------------------------------------------------------ */
  buildRepairSuggestions(n) {
    const tips = [];

    if (n.negatives > 0) tips.push(`Remove ${n.negatives} negative accounts.`);
    if (n.lates > 0) tips.push("Remove late payments for major score boost.");
    if (n.util > 30) tips.push("Reduce utilization under 20% (ideally 10%).");
    if (n.inquiries.total > 4) tips.push("Allow inquiries to age (90 days).");

    if (tips.length === 0) tips.push("Minor issues only — cleanup unlocks full funding.");

    return tips;
  },

  /* ------------------------------------------------------------
     7. English output builder
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
      this.buildApprovedSuggestions(n).forEach(t => out.push("- " + t));
      return out.join("\n");
    }

    if (classification.mode === "repair") {
      out.push(this.buildRepairSummary(n));
      out.push("\n\nPriority Fixes:");
      this.buildRepairSuggestions(n).forEach(t => out.push("- " + t));
      return out.join("\n");
    }

    return "Unknown classification.";
  },

  /* ------------------------------------------------------------
     8. MAIN EXPORT
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
