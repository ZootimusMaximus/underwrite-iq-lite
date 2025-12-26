// ============================================================================
// Blob Upload Handler - Handles Vercel Blob client uploads
// POST /api/lite/blob-upload
// ============================================================================

const { handleUpload } = require("@vercel/blob/client");
const { getJob, updateJobProgress, incrementJobFileCount, failJob } = require("./job-store");
const { logInfo, logWarn, logError } = require("./logger");

// Max 30MB per file, max 3 files
const MAX_FILE_SIZE = 30 * 1024 * 1024;
const MAX_FILES_PER_JOB = 3;

/**
 * Process the uploaded PDF asynchronously
 * Fire-and-forget - errors are handled internally
 */
async function triggerProcessing(jobId, blobUrl) {
  try {
    // Dynamic import to avoid circular deps
    const { processUploadAsync } = require("./process-upload");
    processUploadAsync(jobId, blobUrl);
    logInfo("Processing triggered", { jobId });
  } catch (err) {
    logError("Failed to trigger processing", { jobId, error: err.message });
    await failJob(jobId, {
      message: "Failed to start processing",
      code: "PROCESSING_INIT_FAILED"
    });
  }
}

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

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,

      /**
       * Called before generating upload token
       * Validates jobId and enforces file limits
       */
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload;
        try {
          payload = clientPayload ? JSON.parse(clientPayload) : {};
        } catch {
          throw new Error("Invalid client payload");
        }

        const { jobId } = payload;
        if (!jobId) {
          throw new Error("Missing jobId in payload");
        }

        // Validate job exists
        const job = await getJob(jobId);
        if (!job) {
          logWarn("Job not found for upload", { jobId });
          throw new Error("JOB_NOT_FOUND");
        }

        // Check file count limit
        if ((job.fileCount || 0) >= MAX_FILES_PER_JOB) {
          logWarn("Max files exceeded", { jobId, fileCount: job.fileCount });
          throw new Error("MAX_FILES_EXCEEDED");
        }

        // Increment file count atomically
        const newCount = await incrementJobFileCount(jobId);
        logInfo("File upload authorized", { jobId, fileCount: newCount });

        return {
          allowedContentTypes: ["application/pdf"],
          maximumSizeInBytes: MAX_FILE_SIZE,
          tokenPayload: JSON.stringify({ jobId, fileIndex: newCount })
        };
      },

      /**
       * Called after upload completes to Vercel Blob
       * Triggers async processing
       */
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        let payload;
        try {
          payload = tokenPayload ? JSON.parse(tokenPayload) : {};
        } catch {
          logError("Invalid token payload on completion");
          return;
        }

        const { jobId, fileIndex } = payload;
        if (!jobId) {
          logError("Missing jobId in completion payload");
          return;
        }

        logInfo("Blob upload completed", {
          jobId,
          fileIndex,
          url: blob.url,
          pathname: blob.pathname,
          size: blob.size
        });

        // Update job with blob URL
        await updateJobProgress(jobId, "Uploading file...", blob.url);

        // Get updated job to check if all files are uploaded
        const job = await getJob(jobId);
        const uploadedCount = job?.blobUrls?.length || 0;
        const expectedCount = job?.fileCount || 1;

        // Trigger processing when all files are uploaded
        // For MVP, process after first file (single file support)
        if (uploadedCount >= expectedCount) {
          logInfo("All files uploaded, triggering processing", {
            jobId,
            uploadedCount,
            expectedCount
          });

          // Use the first blob URL for processing
          const blobUrl = job.blobUrls[0];
          await triggerProcessing(jobId, blobUrl);
        }
      }
    });

    return res.status(200).json(jsonResponse);
  } catch (err) {
    // Handle specific error types
    const message = err.message || "Upload failed";

    if (message === "JOB_NOT_FOUND") {
      return res.status(404).json({
        ok: false,
        error: "Session not found. Please start over.",
        code: "JOB_NOT_FOUND"
      });
    }

    if (message === "MAX_FILES_EXCEEDED") {
      return res.status(400).json({
        ok: false,
        error: "Maximum of 3 files allowed per upload.",
        code: "MAX_FILES_EXCEEDED"
      });
    }

    logError("Blob upload error", { error: message, stack: err.stack });

    return res.status(500).json({
      ok: false,
      error: "File upload failed. Please try again.",
      code: "UPLOAD_FAILED"
    });
  }
};
