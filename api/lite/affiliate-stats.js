const { getAffiliateStats } = require("./affiliate-service");

module.exports = async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, msg: "Method not allowed" });
    }

    if (process.env.AFFILIATE_DASHBOARD_ENABLED !== "true") {
      return res.status(200).json({
        ok: true,
        stats: {
          tier1_earnings: 0,
          tier2_earnings: 0,
          total_earnings: 0,
          tier1_referrals_count: 0,
          tier2_referrals_count: 0,
          referral_url: ""
        },
        warning: "Affiliate dashboard disabled."
      });
    }

    const ref = req.query?.ref || req.query?.refId;
    if (!ref || typeof ref !== "string") {
      return res.status(200).json({ ok: false, msg: "Missing ref id." });
    }

    const result = await getAffiliateStats(ref);
    return res.status(200).json({
      ok: true,
      stats: result.stats,
      warning: result.warning || null
    });
  } catch (err) {
    console.error("[affiliate-stats] fatal", err);
    return res.status(200).json({
      ok: true,
      stats: {
        tier1_earnings: 0,
        tier2_earnings: 0,
        total_earnings: 0,
        tier1_referrals_count: 0,
        tier2_referrals_count: 0,
        referral_url: ""
      },
      warning: "Referral stats updating — check back soon."
    });
  }
};
