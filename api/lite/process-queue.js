"use strict";

// ============================================================================
// Process Queue — Cron Endpoint
// ---------------------------------------------------------------------------
// GET /api/lite/process-queue
//
// Vercel Cron calls this every 60 seconds to drain the background task queue.
// Processes up to 10 tasks per invocation (letters, GHL sync, Airtable sync).
//
// Auth: Vercel Cron requests include CRON_SECRET header automatically.
// Manual calls require ?secret=<CRON_SECRET> query param.
// ============================================================================

const { processQueue, getQueueLength } = require("./background-queue");
const { logInfo, logWarn } = require("./logger");

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Auth check — only Vercel Cron or authorized manual calls
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers["authorization"];
    const querySecret = req.query?.secret;
    const headerMatch = authHeader === `Bearer ${cronSecret}`;
    const queryMatch = querySecret === cronSecret;

    if (!headerMatch && !queryMatch) {
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }
  }

  try {
    const queueLength = await getQueueLength();

    if (queueLength === 0) {
      return res.status(200).json({ ok: true, message: "Queue empty", queueLength: 0 });
    }

    logInfo("Processing background queue", { queueLength });

    const result = await processQueue(10);

    logInfo("Queue processing complete", result);

    return res.status(200).json({
      ok: true,
      ...result,
      remainingEstimate: Math.max(0, queueLength - result.processed)
    });
  } catch (err) {
    logWarn("Queue processing error", { error: err.message });
    return res.status(200).json({ ok: false, error: err.message });
  }
};
