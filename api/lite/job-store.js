// ============================================================================
// Job Store - Redis-based job lifecycle management for async processing
// ============================================================================

const crypto = require("crypto");
const { createRedisClient, normalizeEmail } = require("./dedupe-store");
const { logInfo, logError, logWarn } = require("./logger");

const JOB_PREFIX = "uwiq:job:";
const EMAIL_JOB_PREFIX = "uwiq:ejob:"; // Maps email to active jobId
const QUEUE_KEY = "uwiq:queue"; // Processing queue
const PROCESSING_SET = "uwiq:processing"; // Track in-flight jobs

// Status-specific TTLs (seconds)
const STATUS_TTLS = {
  pending: 300, // 5 min - pending jobs expire fast
  queued: 600, // 10 min - queued jobs waiting for processing
  processing: 600, // 10 min - processing jobs get more time
  complete: 3600, // 1 hour - completed jobs stick around for polling
  error: 1800 // 30 min - errors available for debugging
};

const JobStatus = {
  PENDING: "pending",
  QUEUED: "queued",
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

// ============================================================================
// Queue Functions - For async job processing
// ============================================================================

/**
 * Add job to processing queue
 * @param {string} jobId - Job identifier
 * @returns {Promise<number>} Queue position (1-based)
 */
async function enqueueJob(jobId) {
  const redis = createRedisClient();
  if (!redis) return 0;

  try {
    // Add to queue (LPUSH = add to front, RPOP = take from back = FIFO)
    await redis.lpush(QUEUE_KEY, jobId);
    const position = await redis.llen(QUEUE_KEY);

    // Update job status to queued
    const job = await getJob(jobId);
    if (job) {
      job.status = JobStatus.QUEUED;
      job.progress = `Queued for processing (position ${position})`;
      job.updatedAt = new Date().toISOString();

      const key = `${JOB_PREFIX}${jobId}`;
      await redis.set(key, JSON.stringify(job), { ex: STATUS_TTLS.queued });
    }

    logInfo("Job enqueued", { jobId, position });
    return position;
  } catch (err) {
    logError("Failed to enqueue job", { jobId, error: err.message });
    return 0;
  }
}

/**
 * Dequeue next job for processing
 * @returns {Promise<string|null>} Job ID or null if queue empty
 */
async function dequeueJob() {
  const redis = createRedisClient();
  if (!redis) return null;

  try {
    // Pop from back of queue (FIFO)
    const jobId = await redis.rpop(QUEUE_KEY);
    if (!jobId) return null;

    // Add to processing set to track in-flight jobs
    await redis.sadd(PROCESSING_SET, jobId);

    logInfo("Job dequeued", { jobId });
    return jobId;
  } catch (err) {
    logError("Failed to dequeue job", { error: err.message });
    return null;
  }
}

/**
 * Mark job as done processing (remove from processing set)
 * @param {string} jobId - Job identifier
 */
async function markProcessingDone(jobId) {
  const redis = createRedisClient();
  if (!redis || !jobId) return;

  try {
    await redis.srem(PROCESSING_SET, jobId);
    logInfo("Job processing done", { jobId });
  } catch (err) {
    logWarn("Failed to mark processing done", { jobId, error: err.message });
  }
}

/**
 * Get current queue length
 * @returns {Promise<number>} Number of jobs in queue
 */
async function getQueueLength() {
  const redis = createRedisClient();
  if (!redis) return 0;

  try {
    return await redis.llen(QUEUE_KEY);
  } catch (err) {
    logError("Failed to get queue length", { error: err.message });
    return 0;
  }
}

/**
 * Get job's position in queue (0 if not in queue)
 * @param {string} jobId - Job identifier
 * @returns {Promise<number>} Position (1-based) or 0 if not queued
 */
async function getQueuePosition(jobId) {
  const redis = createRedisClient();
  if (!redis || !jobId) return 0;

  try {
    // Get entire queue to find position
    const queue = await redis.lrange(QUEUE_KEY, 0, -1);
    const idx = queue.indexOf(jobId);

    // Convert to 1-based position from back (FIFO order)
    // If job is at end of list (idx = length-1), it's position 1
    return idx >= 0 ? queue.length - idx : 0;
  } catch (err) {
    logError("Failed to get queue position", { jobId, error: err.message });
    return 0;
  }
}

/**
 * Check if a job is currently being processed
 * @param {string} jobId - Job identifier
 * @returns {Promise<boolean>} True if job is in processing set
 */
async function isJobProcessing(jobId) {
  const redis = createRedisClient();
  if (!redis || !jobId) return false;

  try {
    return await redis.sismember(PROCESSING_SET, jobId);
  } catch (err) {
    return false;
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
  releaseUploadLock,
  // Queue functions
  enqueueJob,
  dequeueJob,
  markProcessingDone,
  getQueueLength,
  getQueuePosition,
  isJobProcessing
};
