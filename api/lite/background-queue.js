"use strict";

// ============================================================================
// Background Task Queue
// ---------------------------------------------------------------------------
// Replaces fire-and-forget patterns with a Redis-backed task queue.
// Tasks are enqueued with type + payload, then drained by a cron endpoint
// (process-queue.js) that runs every 60s.
//
// Supports:
//   - deliver_letters  (letter generation + upload + GHL sync)
//   - ghl_sync         (GHL contact creation/update)
//   - airtable_sync    (Airtable record update)
//
// Retry: 3 attempts with exponential backoff (stored in Redis).
// Dead letter: Failed tasks after max retries are logged and dropped.
// ============================================================================

const dedupeStore = require("./dedupe-store");
const { logInfo, logError, logWarn } = require("./logger");

const TASK_QUEUE_KEY = "uwiq:taskq";
const TASK_PREFIX = "uwiq:task:";
const MAX_RETRIES = 3;
const TASK_TTL = 3600; // 1 hour TTL for task data

// ---------------------------------------------------------------------------
// Enqueue a background task
// ---------------------------------------------------------------------------

/**
 * Push a task onto the background queue.
 *
 * @param {string} type - Task type: 'deliver_letters' | 'ghl_sync' | 'airtable_sync'
 * @param {Object} payload - Serializable payload for the task handler
 * @returns {Promise<{ ok: boolean, taskId?: string }>}
 */
async function enqueueTask(type, payload) {
  const redis = dedupeStore.createRedisClient();
  if (!redis) {
    logWarn("Background queue: Redis not available, running inline", { type });
    // Fallback: run inline (old fire-and-forget behavior)
    return runTaskInline(type, payload);
  }

  const taskId = `task_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

  const task = {
    taskId,
    type,
    payload,
    attempts: 0,
    createdAt: new Date().toISOString(),
    lastError: null
  };

  try {
    // Store task data
    await redis.set(`${TASK_PREFIX}${taskId}`, JSON.stringify(task), { ex: TASK_TTL });
    // Push task ID onto the queue
    await redis.lpush(TASK_QUEUE_KEY, taskId);

    logInfo("Task enqueued", { taskId, type });
    return { ok: true, taskId };
  } catch (err) {
    logError("Failed to enqueue task", { type, error: err.message });
    // Fallback: run inline
    return runTaskInline(type, payload);
  }
}

// ---------------------------------------------------------------------------
// Process the queue (called by cron endpoint)
// ---------------------------------------------------------------------------

/**
 * Drain the task queue. Processes up to `maxTasks` tasks per invocation.
 *
 * @param {number} maxTasks - Max tasks to process in one run (default: 10)
 * @returns {Promise<{ processed: number, failed: number, requeued: number }>}
 */
async function processQueue(maxTasks = 10) {
  const redis = dedupeStore.createRedisClient();
  if (!redis) {
    logWarn("Background queue: Redis not available for processing");
    return { processed: 0, failed: 0, requeued: 0 };
  }

  let processed = 0;
  let failed = 0;
  let requeued = 0;

  for (let i = 0; i < maxTasks; i++) {
    // Pop next task ID (FIFO)
    const taskId = await redis.rpop(TASK_QUEUE_KEY);
    if (!taskId) break; // Queue empty

    // Load task data
    const raw = await redis.get(`${TASK_PREFIX}${taskId}`);
    if (!raw) {
      logWarn("Task data missing, skipping", { taskId });
      continue;
    }

    const task = typeof raw === "string" ? JSON.parse(raw) : raw;
    task.attempts = (task.attempts || 0) + 1;

    logInfo("Processing task", { taskId, type: task.type, attempt: task.attempts });

    try {
      await executeTask(task.type, task.payload);
      // Success — clean up
      await redis.del(`${TASK_PREFIX}${taskId}`);
      processed++;
      logInfo("Task completed", { taskId, type: task.type });
    } catch (err) {
      logError("Task failed", {
        taskId,
        type: task.type,
        attempt: task.attempts,
        error: err.message
      });
      task.lastError = err.message;

      if (task.attempts >= MAX_RETRIES) {
        // Dead letter — log and drop
        logError("Task dead-lettered after max retries", {
          taskId,
          type: task.type,
          attempts: task.attempts,
          lastError: task.lastError,
          payload: summarizePayload(task.payload)
        });
        await redis.del(`${TASK_PREFIX}${taskId}`);
        failed++;
      } else {
        // Retry — update task data and re-enqueue
        await redis.set(`${TASK_PREFIX}${taskId}`, JSON.stringify(task), { ex: TASK_TTL });
        await redis.lpush(TASK_QUEUE_KEY, taskId);
        requeued++;
        logInfo("Task requeued for retry", { taskId, attempt: task.attempts });
      }
    }
  }

  return { processed, failed, requeued };
}

// ---------------------------------------------------------------------------
// Get queue stats
// ---------------------------------------------------------------------------

/**
 * Get current queue length.
 * @returns {Promise<number>}
 */
async function getQueueLength() {
  const redis = dedupeStore.createRedisClient();
  if (!redis) return 0;

  try {
    return await redis.llen(TASK_QUEUE_KEY);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Task executors
// ---------------------------------------------------------------------------

/**
 * Route a task to its handler.
 */
async function executeTask(type, payload) {
  switch (type) {
    case "deliver_letters":
      return executeLetterDelivery(payload);
    case "ghl_sync":
      return executeGHLSync(payload);
    case "airtable_sync":
      return executeAirtableSync(payload);
    default:
      throw new Error(`Unknown task type: ${type}`);
  }
}

/**
 * Execute letter delivery task.
 */
async function executeLetterDelivery(payload) {
  const { deliverLetters } = require("./letter-delivery");
  const result = await deliverLetters(payload);
  if (!result.ok) {
    throw new Error(result.error || "Letter delivery failed");
  }

  // Fire the CRS letters-ready signal so U-02 emails the letters to the client
  // (closes the gap where CRS clients got URLs but no delivery email). CRS PATH
  // ONLY: the legacy PDF/analyzer path already fires U-02 via
  // notifyAnalyzerComplete, and both paths flow through this same task — so
  // gating on payload.crsResult prevents a double U-02 fire (double email) for
  // legacy clients. No-op until GHL_LETTERS_READY_WEBHOOK_URL is set. Non-fatal.
  if (payload.crsResult) {
    try {
      const { notifyLettersReady } = require("./ghl-webhook");
      // result.urls is keyed by FILENAME (storage.js). U-02's field map expects
      // the GHL field keys (e.g. funding_letter_url__inquiry_cleanup__ex) 1:1, so
      // translate filename → field key via result.fieldKeyMap before flattening
      // into the webhook payload. Without this, the payload would carry filename
      // keys and U-02's letter fields would never populate.
      let letterUrls = result.urls || {};
      if (result.fieldKeyMap && result.urls) {
        letterUrls = {};
        for (const [fileKey, url] of Object.entries(result.urls)) {
          const fieldKey = result.fieldKeyMap[fileKey];
          if (fieldKey) letterUrls[fieldKey] = url;
        }
      }
      await notifyLettersReady({
        contactId: result.contactId,
        email: payload.contactData?.email,
        fullName: payload.personal?.name,
        urls: letterUrls,
        path: result.path,
        creditSuggestions: payload.crsResult?.crmPayload?.suggestionSummary || ""
      });
    } catch (err) {
      const { logWarn } = require("./logger");
      logWarn("executeLetterDelivery: notifyLettersReady failed (non-fatal)", {
        error: err.message
      });
    }
  }

  return result;
}

/**
 * Execute GHL contact sync task.
 */
async function executeGHLSync(payload) {
  const { createOrUpdateContact } = require("./ghl-contact-service");
  const result = await createOrUpdateContact(payload);
  if (!result.ok) {
    throw new Error(result.error || "GHL sync failed");
  }
  return result;
}

/**
 * Execute Airtable sync task.
 */
async function executeAirtableSync(payload) {
  const { syncCRSResultToAirtable } = require("./crs/airtable-sync");
  const {
    result,
    recordId,
    email,
    crs_pull_scope,
    businessPullFailed,
    businessReport,
    reportUrls
  } = payload;
  const syncResult = await syncCRSResultToAirtable(result, recordId, email, {
    crs_pull_scope,
    businessPullFailed,
    businessReport: businessReport || null,
    reportUrls: reportUrls || null
  });
  if (!syncResult.ok) {
    throw new Error(syncResult.error || "Airtable sync failed");
  }
  return syncResult;
}

// ---------------------------------------------------------------------------
// Inline fallback (when Redis is unavailable)
// ---------------------------------------------------------------------------

async function runTaskInline(type, payload) {
  try {
    await executeTask(type, payload);
    return { ok: true, inline: true };
  } catch (err) {
    logError("Inline task execution failed", { type, error: err.message });
    return { ok: false, inline: true, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Summarize payload for dead-letter logging (avoid dumping huge objects).
 */
function summarizePayload(payload) {
  if (!payload) return null;
  return {
    email: payload.contactData?.email || payload.email || undefined,
    type: payload.crsDocuments ? "crs" : "legacy",
    outcome: payload.crsResult?.outcome || undefined
  };
}

module.exports = {
  enqueueTask,
  processQueue,
  getQueueLength
};
