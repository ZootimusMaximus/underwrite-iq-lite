// ============================================================================
// Process Worker - Cron endpoint that processes queued jobs
// GET /api/lite/process-worker (called by Vercel Cron every minute)
// ============================================================================

const { dequeueJob, markProcessingDone, getQueueLength, getJob } = require("./job-store");
const { processUpload } = require("./process-upload");
const { logInfo, logError } = require("./logger");

// Max jobs to process per cron tick (prevents OpenAI rate limits)
const MAX_JOBS_PER_TICK = 2;

// Vercel cron timeout is 10s on Hobby, 60s on Pro
// Each job takes ~30s, so we process sequentially
const WORKER_TIMEOUT = 55000; // 55s safety margin

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Verify cron secret (prevent unauthorized calls)
  // Vercel Cron sends this automatically, or use CRON_SECRET env var
  const authHeader = req.headers["authorization"];
  const cronSecret = process.env.CRON_SECRET;

  // Allow if:
  // 1. No CRON_SECRET set (development)
  // 2. Authorization header matches Bearer token
  // 3. x-vercel-cron header present (Vercel's internal cron)
  const isVercelCron = req.headers["x-vercel-cron"] === "1";
  const isAuthorized = !cronSecret || authHeader === `Bearer ${cronSecret}` || isVercelCron;

  if (!isAuthorized) {
    logError("Unauthorized worker call", { authHeader: authHeader?.substring(0, 20) });
    return res.status(401).json({ error: "Unauthorized" });
  }

  const startTime = Date.now();
  const processed = [];
  let queueLength = 0;

  try {
    queueLength = await getQueueLength();
    logInfo("Worker started", { queueLength });

    if (queueLength === 0) {
      return res.status(200).json({
        ok: true,
        message: "Queue empty",
        processed: 0,
        queueLength: 0
      });
    }

    // Process up to MAX_JOBS_PER_TICK jobs
    for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
      // Check if we're running out of time
      const elapsed = Date.now() - startTime;
      if (elapsed > WORKER_TIMEOUT) {
        logInfo("Worker timeout approaching, stopping", { elapsed, processed: processed.length });
        break;
      }

      const jobId = await dequeueJob();
      if (!jobId) {
        logInfo("Queue exhausted", { processed: processed.length });
        break;
      }

      const jobStartTime = Date.now();

      try {
        const job = await getJob(jobId);

        if (!job) {
          logError("Job not found in queue", { jobId });
          await markProcessingDone(jobId);
          processed.push({ jobId, status: "not_found", time: 0 });
          continue;
        }

        if (!job.blobUrls?.length) {
          logError("Job has no blob URLs", { jobId });
          await markProcessingDone(jobId);
          processed.push({ jobId, status: "no_files", time: 0 });
          continue;
        }

        logInfo("Processing job from queue", { jobId, position: i + 1 });

        // Process synchronously within this worker
        await processUpload(jobId, job.blobUrls[0]);

        const jobTime = ((Date.now() - jobStartTime) / 1000).toFixed(1);
        processed.push({ jobId, status: "complete", time: `${jobTime}s` });
        logInfo("Job processed successfully", { jobId, time: jobTime });
      } catch (err) {
        const jobTime = ((Date.now() - jobStartTime) / 1000).toFixed(1);
        logError("Worker job failed", { jobId, error: err.message, time: jobTime });
        processed.push({ jobId, status: "error", error: err.message, time: `${jobTime}s` });
      } finally {
        await markProcessingDone(jobId);
      }
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const remainingQueue = await getQueueLength();

    logInfo("Worker completed", {
      processed: processed.length,
      elapsed: totalElapsed,
      remainingQueue
    });

    return res.status(200).json({
      ok: true,
      processed: processed.length,
      jobs: processed,
      elapsed: `${totalElapsed}s`,
      remainingQueue
    });
  } catch (err) {
    logError("Worker error", { error: err.message, stack: err.stack });

    return res.status(500).json({
      ok: false,
      error: "Worker failed",
      message: err.message
    });
  }
};
