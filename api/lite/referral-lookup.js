const { createRedisClient, lookupByRef } = require("./dedupe-store");
const { jsonResponse, preflightResponse } = require("./http");

module.exports = async function handler(req) {
  try {
    if (req.method === "OPTIONS") {
      return preflightResponse("GET,OPTIONS");
    }

    if (req.method !== "GET") {
      return jsonResponse({ ok: false, msg: "Method not allowed" }, { status: 405 });
    }

    if (process.env.AFFILIATE_DASHBOARD_ENABLED !== "true") {
      return jsonResponse({ ok: true, redirect: null, disabled: true });
    }

    const ref = req.query?.ref || req.query?.refId;
    if (!ref || typeof ref !== "string") {
      return jsonResponse({ ok: false, msg: "Missing ref id." });
    }

    const redis = createRedisClient();
    if (!redis) {
      return jsonResponse({ ok: false, msg: "Cache unavailable." });
    }

    const redirect = await lookupByRef(redis, ref);
    if (!redirect) {
      return jsonResponse({ ok: false, msg: "No active redirect found.", redirect: null });
    }

    const { query, resultPath, ...safeRedirect } = redirect;
    return jsonResponse({ ok: true, redirect: safeRedirect });
  } catch (err) {
    console.error("[referral-lookup] fatal", err);
    return jsonResponse({ ok: false, msg: "Unexpected error.", redirect: null }, { status: 500 });
  }
};
