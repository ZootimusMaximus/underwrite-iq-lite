// ============================================================================
// Start Processing Endpoint - Queues job for async processing
// POST /api/lite/start-processing
// ============================================================================

const { getJob, enqueueJob, getQueueLength, getQueuePosition, JobStatus } = require("./job-store");
const { logInfo, logError } = require("./logger");

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only POST allowed
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      code: "METHOD_NOT_ALLOWED"
    });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return res.status(400).json({
      ok: false,
      error: "Invalid JSON body",
      code: "INVALID_JSON"
    });
  }

  const { jobId } = body;

  if (!jobId) {
    return res.status(400).json({
      ok: false,
      error: "Missing jobId",
      code: "MISSING_JOB_ID"
    });
  }

  try {
    // Get job
    const job = await getJob(jobId);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Job not found",
        code: "JOB_NOT_FOUND"
      });
    }

    // Check if already completed or failed
    if (job.status === "complete") {
      return res.status(200).json({
        ok: true,
        status: "complete",
        message: "Job already complete"
      });
    }

    if (job.status === "error") {
      return res.status(200).json({
        ok: false,
        status: "error",
        error: job.error
      });
    }

    // Check if we have blob URLs to process
    const blobUrls = job.blobUrls || [];
    if (blobUrls.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "No files uploaded yet",
        code: "NO_FILES"
      });
    }

    // Check if already queued or processing
    if (job.status === JobStatus.QUEUED) {
      const position = await getQueuePosition(jobId);
      return res.status(200).json({
        ok: true,
        status: "queued",
        position,
        message: `Already queued (position ${position})`
      });
    }

    if (job.status === JobStatus.PROCESSING) {
      return res.status(200).json({
        ok: true,
        status: "processing",
        message: "Already processing"
      });
    }

    logInfo("Queueing job for processing", { jobId, fileCount: blobUrls.length });

    // Enqueue the job for async processing
    const position = await enqueueJob(jobId);
    const queueLength = await getQueueLength();

    logInfo("Job queued", { jobId, position, queueLength });

    return res.status(200).json({
      ok: true,
      status: "queued",
      position,
      queueLength,
      message: `Queued for processing (position ${position})`,
      estimatedWait: `~${Math.ceil(position * 30)} seconds`
    });
  } catch (err) {
    logError("Start processing error", { jobId, error: err.message });

    return res.status(500).json({
      ok: false,
      error: "Failed to start processing",
      code: "SYSTEM_ERROR"
    });
  }
};
