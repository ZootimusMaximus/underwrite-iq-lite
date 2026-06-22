"use strict";

/**
 * GET /api/lite/behavior-score-cron
 * Vercel cron handler — runs the behavior-score sweep nightly at 07:00 UTC.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 *   - If CRON_SECRET is set and the header doesn't match → 401.
 *   - If CRON_SECRET is unset → log warning + allow (dev/local mode), mirroring
 *     the auth pattern in context-fetcher.js.
 *
 * Response: { ok: true, scored: <n>, errors: <n> }
 */

const { logInfo, logWarn, logError } = require("./logger");
const { runSweep } = require("./behavior-score");

// ─── Auth ─────────────────────────────────────────────────────────────────────

function validateCronAuth(req) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    logWarn("behavior-score-cron: CRON_SECRET is not set — running unauthenticated (dev mode)");
    return { ok: true };
  }

  const bearerHeader = req.headers["authorization"] || "";
  const token = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7).trim() : null;

  if (token && token === secret) {
    return { ok: true };
  }

  return { ok: false };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const auth = validateCronAuth(req);
  if (!auth.ok) {
    logWarn("behavior-score-cron: unauthorized");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  logInfo("behavior-score-cron: nightly sweep triggered");

  try {
    const { scored, errors } = await runSweep();
    logInfo("behavior-score-cron: sweep complete", { scored, errors });
    return res.status(200).json({ ok: true, scored, errors });
  } catch (err) {
    logError("behavior-score-cron: unhandled error", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// Export auth helper for testing
module.exports.validateCronAuth = validateCronAuth;
