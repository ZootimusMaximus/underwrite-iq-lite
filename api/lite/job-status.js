// ============================================================================
// Job Status Endpoint - Polling endpoint for job progress
// GET /api/lite/job-status?jobId=xxx
// ============================================================================

const { getJob, JobStatus, getQueuePosition, getQueueLength } = require("./job-store");
const { logInfo, logWarn } = require("./logger");

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only GET allowed
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      code: "METHOD_NOT_ALLOWED"
    });
  }

  // Get jobId from query
  const jobId = req.query?.jobId || new URL(req.url, "http://localhost").searchParams.get("jobId");

  if (!jobId) {
    return res.status(400).json({
      ok: false,
      error: "Missing jobId parameter",
      code: "MISSING_JOB_ID"
    });
  }

  // Validate jobId format (job_<timestamp><hex>)
  if (!/^job_[a-z0-9]+$/i.test(jobId)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid jobId format",
      code: "INVALID_JOB_ID"
    });
  }

  try {
    const job = await getJob(jobId);

    if (!job) {
      logWarn("Job not found for status check", { jobId });
      return res.status(404).json({
        ok: false,
        status: "not_found",
        error: "Session not found or expired. Please start over.",
        code: "JOB_NOT_FOUND"
      });
    }

    // Build response based on status
    const response = {
      ok: true,
      jobId: job.jobId,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };

    // Add result data for completed jobs
    if (job.status === JobStatus.COMPLETE) {
      response.result = job.result;
      response.completedAt = job.completedAt;

      logInfo("Job status: complete", { jobId });
    }

    // Add error data for failed jobs
    if (job.status === JobStatus.ERROR) {
      response.error = job.error;
      response.completedAt = job.completedAt;

      logInfo("Job status: error", { jobId, error: job.error });
    }

    // Add queue info for queued jobs
    if (job.status === JobStatus.QUEUED) {
      const position = await getQueuePosition(jobId);
      const queueLength = await getQueueLength();

      response.position = position;
      response.queueLength = queueLength;
      response.progress = `Waiting in queue (position ${position})`;
      response.estimatedWait = `~${Math.ceil(position * 30)} seconds`;

      logInfo("Job status: queued", { jobId, position, queueLength });
    }

    // Add file count for pending/processing
    if (job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING) {
      response.fileCount = job.fileCount || 0;
      response.uploadedFiles = job.blobUrls?.length || 0;
    }

    return res.status(200).json(response);
  } catch (err) {
    logWarn("Job status check failed", { jobId, error: err.message });

    return res.status(500).json({
      ok: false,
      error: "Failed to check job status. Please try again.",
      code: "STATUS_CHECK_FAILED"
    });
  }
};
