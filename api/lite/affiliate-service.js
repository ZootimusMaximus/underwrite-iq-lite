const DEFAULT_BASE = "https://services.leadconnectorhq.com";

function getApiBase() {
  return process.env.GHL_API_BASE || DEFAULT_BASE;
}

function getApiKey() {
  return process.env.GHL_PRIVATE_API_KEY || process.env.GHL_API_KEY || null;
}

async function fetchJson(url, key) {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json"
    }
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`Affiliate API error ${resp.status}: ${text}`);
    err.status = resp.status;
    throw err;
  }
  return await resp.json().catch(() => ({}));
}

async function getAffiliateStats(contactId) {
  const key = getApiKey();
  if (!key) {
    return {
      ok: false,
      warning: "Affiliate stats unavailable.",
      stats: emptyStats(contactId)
    };
  }

  const base = getApiBase();
  const statsUrl = `${base}/affiliate-managers/affiliates/${encodeURIComponent(contactId)}/stats`;
  const refsUrl = `${base}/affiliate-managers/affiliates/${encodeURIComponent(contactId)}/referrals`;

  try {
    const [statsResp, refsResp] = await Promise.all([
      fetchJson(statsUrl, key).catch(err => ({ error: err })),
      fetchJson(refsUrl, key).catch(err => ({ error: err }))
    ]);

    if (statsResp.error || refsResp.error) {
      return {
        ok: true,
        warning: "Referral stats updating — check back soon.",
        stats: emptyStats(contactId)
      };
    }

    const stats = {
      tier1_earnings: statsResp?.tier1_earnings ?? 0,
      tier2_earnings: statsResp?.tier2_earnings ?? 0,
      total_earnings: statsResp?.total_earnings ?? 0,
      tier1_referrals_count: refsResp?.tier1_referrals_count ?? 0,
      tier2_referrals_count: refsResp?.tier2_referrals_count ?? 0,
      referral_url:
        statsResp?.referral_url ||
        `${base}/credit-analyzer.html?ref=${encodeURIComponent(contactId)}`
    };

    return { ok: true, stats, warning: null };
  } catch (err) {
    console.error("[affiliate] fetch failed", err);
    return {
      ok: true,
      warning: "Referral stats updating — check back soon.",
      stats: emptyStats(contactId)
    };
  }
}

function emptyStats(contactId) {
  return {
    tier1_earnings: 0,
    tier2_earnings: 0,
    total_earnings: 0,
    tier1_referrals_count: 0,
    tier2_referrals_count: 0,
    referral_url: contactId
      ? `https://credit-analyzer.html?ref=${encodeURIComponent(contactId)}`
      : ""
  };
}

module.exports = {
  getAffiliateStats
};
