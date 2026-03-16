// ============================================================================
// QStash Worker - Processes jobs from QStash queue
// POST /api/lite/qstash-worker
// ============================================================================

const { verifySignature } = require("./qstash-client");
const { processUpload } = require("./process-upload");
const { getJob, updateJobStatus, JobStatus } = require("./job-store");
const { logInfo, logError, logWarn } = require("./logger");

// Permanent error codes that should not be retried
const PERMANENT_ERROR_CODES = [
  "PARSE_FAILED",
  "INVALID_PDF",
  "PDF_TOO_SMALL",
  "IDENTITY_MISMATCH",
  "NAME_MISMATCH",
  "REPORT_TOO_OLD",
  "JOB_NOT_FOUND"
];

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Upstash-Signature");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Verify QStash signature
  const isValid = await verifySignature(req);
  if (!isValid) {
    logError("QStash worker: Invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // 2. Parse body
  const { jobId, blobUrl } = req.body || {};

  if (!jobId || !blobUrl) {
    logError("QStash worker: Missing jobId or blobUrl", { jobId, blobUrl });
    // Return 200 so QStash doesn't retry malformed requests
    return res.status(200).json({ error: "Missing required fields", skipped: true });
  }

  logInfo("QStash worker: Processing job", { jobId });

  // 3. Check job still exists and is in valid state
  const job = await getJob(jobId);

  if (!job) {
    logWarn("QStash worker: Job not found", { jobId });
    // Return 200 - no point retrying if job doesn't exist
    return res.status(200).json({ skipped: true, reason: "Job not found" });
  }

  // Skip if already completed or errored
  if (job.status === JobStatus.COMPLETE || job.status === JobStatus.ERROR) {
    logInfo("QStash worker: Job already in terminal state", {
      jobId,
      status: job.status
    });
    return res.status(200).json({ skipped: true, reason: "Job already terminal" });
  }

  // 4. Update status to PROCESSING
  await updateJobStatus(jobId, JobStatus.PROCESSING);

  // 5. Process the job
  const startTime = Date.now();

  try {
    await processUpload(jobId, blobUrl);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logInfo("QStash worker: Job completed", { jobId, elapsed_s: elapsed });

    return res.status(200).json({ ok: true, elapsed: `${elapsed}s` });
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Check if this is an OpenAI rate limit error
    if (err.status === 429 || err.code === "rate_limit_exceeded") {
      const retryAfter = err.headers?.["retry-after"] || 30;

      logWarn("QStash worker: OpenAI rate limit, requesting retry", {
        jobId,
        retryAfter,
        elapsed_s: elapsed
      });

      // Return 429 so QStash respects Retry-After header
      res.setHeader("Retry-After", retryAfter);
      return res.status(429).json({
        error: "Rate limited",
        retryAfter
      });
    }

    // Check if this is a permanent error (no point retrying)
    const errorCode = err.code || "";
    const isPermanent = PERMANENT_ERROR_CODES.some(code => errorCode.includes(code));

    if (isPermanent) {
      logError("QStash worker: Permanent failure", {
        jobId,
        code: errorCode,
        message: err.message,
        elapsed_s: elapsed
      });

      // processUpload already marks job as failed
      // Return 200 so QStash doesn't retry
      return res.status(200).json({
        ok: false,
        error: err.message,
        permanent: true
      });
    }

    // Transient error - return 500 for QStash to retry
    logError("QStash worker: Transient failure, will retry", {
      jobId,
      error: err.message,
      code: errorCode,
      elapsed_s: elapsed
    });

    return res.status(500).json({
      error: err.message,
      code: errorCode
    });
  }
};
