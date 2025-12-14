const { createRedisClient, lookupByRef } = require("./dedupe-store");
const { logError } = require("./logger");

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
      return res.status(200).json({ ok: true, redirect: null, disabled: true });
    }

    const ref = req.query?.ref || req.query?.refId;
    if (!ref || typeof ref !== "string") {
      return res.status(200).json({ ok: false, msg: "Missing ref id." });
    }

    const redis = createRedisClient();
    if (!redis) {
      return res.status(200).json({ ok: false, msg: "Cache unavailable." });
    }

    const redirect = await lookupByRef(redis, ref);
    if (!redirect) {
      return res.status(200).json({ ok: false, msg: "No active redirect found.", redirect: null });
    }

    return res.status(200).json({ ok: true, redirect });
  } catch (err) {
    logError("Referral lookup failed", err);
    return res.status(200).json({ ok: false, msg: "Unexpected error.", redirect: null });
  }
};
