// ============================================================================
// Job Store - Redis-based job lifecycle management for async processing
// ============================================================================

const crypto = require("crypto");
const { createRedisClient, normalizeEmail } = require("./dedupe-store");
const { logInfo, logError, logWarn } = require("./logger");

const JOB_PREFIX = "uwiq:job:";
const EMAIL_JOB_PREFIX = "uwiq:ejob:"; // Maps email to active jobId

// Status-specific TTLs (seconds)
const STATUS_TTLS = {
  pending: 300, // 5 min - pending jobs expire fast
  processing: 600, // 10 min - processing jobs get more time
  complete: 3600, // 1 hour - completed jobs stick around for polling
  error: 1800 // 30 min - errors available for debugging
};

const JobStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETE: "complete",
  ERROR: "error"
};

/**
 * Generate a unique job ID
 * Format: job_<timestamp_base36><random_hex>
 */
function generateJobId() {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString("hex");
  return `job_${timestamp}${random}`;
}

/**
 * Create a new job in Redis
 * @param {string} jobId - Unique job identifier
 * @param {Object} metadata - Job metadata (name, email, phone, etc.)
 * @returns {Promise<Object|null>} Created job or null on failure
 */
async function createJob(jobId, metadata) {
  const redis = createRedisClient();
  if (!redis) {
    logWarn("Redis not available for job creation", { jobId });
    return null;
  }

  const now = new Date().toISOString();
  const job = {
    jobId,
    status: JobStatus.PENDING,
    progress: "Waiting for upload...",
    metadata: metadata || {},
    blobUrls: [],
    fileCount: 0,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };

  try {
    const key = `${JOB_PREFIX}${jobId}`;
    await redis.set(key, JSON.stringify(job), { ex: STATUS_TTLS.pending });

    // Also map email to jobId for resume functionality
    if (metadata?.email) {
      const emailKey = `${EMAIL_JOB_PREFIX}${normalizeEmail(metadata.email)}`;
      await redis.set(emailKey, jobId, { ex: STATUS_TTLS.pending });
    }

    logInfo("Job created", { jobId, email: metadata?.email });
    return job;
  } catch (err) {
    logError("Failed to create job", { jobId, error: err.message });
    return null;
  }
}

/**
 * Get a job by ID
 * @param {string} jobId - Job identifier
 * @returns {Promise<Object|null>} Job data or null
 */
async function getJob(jobId) {
  const redis = createRedisClient();
  if (!redis || !jobId) return null;

  try {
    const key = `${JOB_PREFIX}${jobId}`;
    const data = await redis.get(key);
    if (!data) return null;
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (err) {
    logError("Failed to get job", { jobId, error: err.message });
    return null;
  }
}

/**
 * Find active job by email (for resume functionality)
 * @param {string} email - User email
 * @returns {Promise<Object|null>} Active job or null
 */
async function findActiveJobByEmail(email) {
  const redis = createRedisClient();
  if (!redis || !email) return null;

  try {
    const emailKey = `${EMAIL_JOB_PREFIX}${normalizeEmail(email)}`;
    const jobId = await redis.get(emailKey);
    if (!jobId) return null;

    const job = await getJob(jobId);
    // Only return if job is still active (pending or processing)
    if (job && (job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING)) {
      return job;
    }
    return null;
  } catch (err) {
    logError("Failed to find job by email", { email, error: err.message });
    return null;
  }
}

/**
 * Update job progress
 * @param {string} jobId - Job identifier
 * @param {string} progress - Progress message
 * @param {string} [blobUrl] - Optional blob URL to add
 * @returns {Promise<Object|null>} Updated job or null
 */
async function updateJobProgress(jobId, progress, blobUrl = null) {
  const redis = createRedisClient();
  if (!redis || !jobId) return null;

  try {
    const job = await getJob(jobId);
    if (!job) return null;

    job.progress = progress;
    job.status = JobStatus.PROCESSING;
    job.updatedAt = new Date().toISOString();

    if (blobUrl) {
      job.blobUrls = job.blobUrls || [];
      job.blobUrls.push(blobUrl);
    }

    const key = `${JOB_PREFIX}${jobId}`;
    await redis.set(key, JSON.stringify(job), { ex: STATUS_TTLS.processing });

    logInfo("Job progress updated", { jobId, progress });
    return job;
  } catch (err) {
    logError("Failed to update job progress", { jobId, error: err.message });
    return null;
  }
}

/**
 * Increment file count for a job (used to enforce max 3 files)
 * @param {string} jobId - Job identifier
 * @returns {Promise<number>} New file count
 */
async function incrementJobFileCount(jobId) {
  const redis = createRedisClient();
  if (!redis || !jobId) return 0;

  try {
    const job = await getJob(jobId);
    if (!job) return 0;

    job.fileCount = (job.fileCount || 0) + 1;
    job.updatedAt = new Date().toISOString();

    const key = `${JOB_PREFIX}${jobId}`;
    const ttl = STATUS_TTLS[job.status] || STATUS_TTLS.pending;
    await redis.set(key, JSON.stringify(job), { ex: ttl });

    return job.fileCount;
  } catch (err) {
    logError("Failed to increment file count", { jobId, error: err.message });
    return 0;
  }
}

/**
 * Mark job as complete with result
 * @param {string} jobId - Job identifier
 * @param {Object} result - Result data (redirect, etc.)
 * @returns {Promise<Object|null>} Updated job or null
 */
async function completeJob(jobId, result) {
  const redis = createRedisClient();
  if (!redis || !jobId) return null;

  try {
    const job = await getJob(jobId);
    if (!job) return null;

    const now = new Date().toISOString();
    job.status = JobStatus.COMPLETE;
    job.progress = "Analysis complete!";
    job.result = result;
    job.updatedAt = now;
    job.completedAt = now;

    const key = `${JOB_PREFIX}${jobId}`;
    await redis.set(key, JSON.stringify(job), { ex: STATUS_TTLS.complete });

    // Clean up email mapping
    if (job.metadata?.email) {
      const emailKey = `${EMAIL_JOB_PREFIX}${normalizeEmail(job.metadata.email)}`;
      await redis.del(emailKey);
    }

    logInfo("Job completed", { jobId, path: result?.redirect?.path });
    return job;
  } catch (err) {
    logError("Failed to complete job", { jobId, error: err.message });
    return null;
  }
}

/**
 * Mark job as failed with error
 * @param {string} jobId - Job identifier
 * @param {Object} error - Error object { message, code }
 * @returns {Promise<Object|null>} Updated job or null
 */
async function failJob(jobId, error) {
  const redis = createRedisClient();
  if (!redis || !jobId) return null;

  try {
    const job = await getJob(jobId);
    if (!job) return null;

    const now = new Date().toISOString();
    job.status = JobStatus.ERROR;
    job.progress = "Processing failed";
    job.error = {
      message: error?.message || "An error occurred",
      code: error?.code || "SYSTEM_ERROR"
    };
    job.updatedAt = now;
    job.completedAt = now;

    const key = `${JOB_PREFIX}${jobId}`;
    await redis.set(key, JSON.stringify(job), { ex: STATUS_TTLS.error });

    // Clean up email mapping
    if (job.metadata?.email) {
      const emailKey = `${EMAIL_JOB_PREFIX}${normalizeEmail(job.metadata.email)}`;
      await redis.del(emailKey);
    }

    logWarn("Job failed", { jobId, error: job.error });
    return job;
  } catch (err) {
    logError("Failed to fail job", { jobId, error: err.message });
    return null;
  }
}

/**
 * Acquire a lock for concurrent upload prevention
 * @param {string} email - User email
 * @param {number} [ttlSeconds=30] - Lock TTL
 * @returns {Promise<boolean>} True if lock acquired
 */
async function acquireUploadLock(email, ttlSeconds = 30) {
  const redis = createRedisClient();
  if (!redis || !email) return true; // Allow if Redis unavailable

  try {
    const lockKey = `uwiq:lock:${normalizeEmail(email)}`;
    const result = await redis.set(lockKey, "1", { nx: true, ex: ttlSeconds });
    return result === "OK";
  } catch (err) {
    logWarn("Failed to acquire upload lock", { email, error: err.message });
    return true; // Allow on error
  }
}

/**
 * Release upload lock
 * @param {string} email - User email
 */
async function releaseUploadLock(email) {
  const redis = createRedisClient();
  if (!redis || !email) return;

  try {
    const lockKey = `uwiq:lock:${normalizeEmail(email)}`;
    await redis.del(lockKey);
  } catch (err) {
    logWarn("Failed to release upload lock", { email, error: err.message });
  }
}

module.exports = {
  JobStatus,
  STATUS_TTLS,
  JOB_PREFIX,
  generateJobId,
  createJob,
  getJob,
  findActiveJobByEmail,
  updateJobProgress,
  incrementJobFileCount,
  completeJob,
  failJob,
  acquireUploadLock,
  releaseUploadLock
};
