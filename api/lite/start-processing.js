// ============================================================================
// Start Processing Endpoint - Triggers processing after blob upload
// POST /api/lite/start-processing
// ============================================================================

const { getJob, updateJobProgress, failJob } = require("./job-store");
const { processUpload } = require("./process-upload");
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

    // Check if already processing (prevent duplicate processing)
    if (job.progress && job.progress.includes("Analyzing")) {
      return res.status(200).json({
        ok: true,
        status: "processing",
        message: "Already processing"
      });
    }

    logInfo("Starting processing", { jobId, fileCount: blobUrls.length });

    // Update status to show we're starting
    await updateJobProgress(jobId, "Downloading file...");

    // Process synchronously (this request will wait)
    // Using first blob URL for single-file MVP
    const blobUrl = blobUrls[0];

    try {
      await processUpload(jobId, blobUrl);

      return res.status(200).json({
        ok: true,
        status: "complete",
        message: "Processing complete"
      });
    } catch (err) {
      logError("Processing failed", { jobId, error: err.message });

      await failJob(jobId, {
        message: err.userMessage || err.message || "Processing failed",
        code: err.code || "PROCESSING_FAILED"
      });

      return res.status(200).json({
        ok: false,
        status: "error",
        error: {
          message: err.userMessage || "Processing failed",
          code: err.code || "PROCESSING_FAILED"
        }
      });
    }
  } catch (err) {
    logError("Start processing error", { jobId, error: err.message });

    return res.status(500).json({
      ok: false,
      error: "Failed to start processing",
      code: "SYSTEM_ERROR"
    });
  }
};
