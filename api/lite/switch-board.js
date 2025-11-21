// ============================================================================
// UnderwriteIQ — Switchboard (v3 RECONSTRUCTED)
// Purpose:
//   • Accept parsed bureaus from parse-report.js
//   • Run underwriting via underwriter.js
//   • Decide redirect → Approved page OR Repair page
//   • Build URL query params for frontend
// ============================================================================

const { computeUnderwrite, getNumberField } = require("./underwriter");

// ============================================================================
// Helper: Safe number for URL params
// ============================================================================
function safeNum(v) {
  if (v == null || isNaN(v)) return 0;
  return Number(v);
}

// ============================================================================
// Handler
// ============================================================================
module.exports = async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, msg: "Method not allowed" });
    }

    const body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(JSON.parse(data || "{}")));
    });

    const bureaus = body.bureaus || null;
    const businessAgeMonths = getNumberField(body, "businessAgeMonths");

    if (!bureaus) {
      return res.status(400).json({
        ok: false,
        msg: "Missing bureau data"
      });
    }

    // --------------------------
    // RUN UNDERWRITER
    // --------------------------
    const uw = computeUnderwrite(bureaus, businessAgeMonths);

    const p = uw.personal || {};
    const b = uw.business || {};
    const t = uw.totals || {};
    const m = uw.metrics || {};
    const inq = m.inquiries || {};

    // --------------------------
    // BUILD URL PARAMS
    // --------------------------
    const params = new URLSearchParams({
      personalTotal: safeNum(p.total_personal_funding),
      businessTotal: safeNum(b.business_funding),
      totalCombined: safeNum(t.total_combined_funding),

      score: safeNum(m.score),
      util: safeNum(m.utilization_pct),

      inqEx: safeNum(inq.ex),
      inqTu: safeNum(inq.tu),
      inqEq: safeNum(inq.eq),

      neg: safeNum(m.negative_accounts),
      late: safeNum(m.late_payment_events)
    });

    // --------------------------
    // DECISION: APPROVED vs REPAIR
    // --------------------------
    let redirect = {};
    if (uw.fundable) {
      redirect.url = "https://fundhub.ai/funding-approved";
      redirect.query = params;
    } else {
      redirect.url = "https://fundhub.ai/funding-repair";
      redirect.query = params;
    }

    return res.status(200).json({
      ok: true,
      underwrite: uw,
      redirect
    });

  } catch (err) {
    console.error("[SWITCHBOARD ERROR]", err);
    return res.status(200).json({
      ok: false,
      msg: "System error in underwriting."
    });
  }
};
