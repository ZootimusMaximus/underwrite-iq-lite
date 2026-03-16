// ============================================================================
// QStash Client - Async job queue for concurrent processing
// ============================================================================

const { Client, Receiver } = require("@upstash/qstash");
const { logInfo, logError } = require("./logger");

// Configuration
const FLOW_CONTROL_KEY = "uwiq-processing";
const PARALLELISM_LIMIT = parseInt(process.env.QSTASH_PARALLELISM || "3", 10);
const MAX_RETRIES = 5;

// Singletons
let client = null;
let receiver = null;

/**
 * Get QStash client (singleton)
 */
function getClient() {
  if (!client) {
    const token = process.env.QSTASH_TOKEN;
    if (!token) {
      throw new Error("QSTASH_TOKEN environment variable is required");
    }
    client = new Client({ token });
  }
  return client;
}

/**
 * Get QStash receiver for signature verification (singleton)
 */
function getReceiver() {
  if (!receiver) {
    const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
    const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

    if (!currentKey || !nextKey) {
      throw new Error("QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY are required");
    }

    receiver = new Receiver({
      currentSigningKey: currentKey,
      nextSigningKey: nextKey
    });
  }
  return receiver;
}

/**
 * Get the worker URL for QStash callbacks
 */
function getWorkerUrl() {
  // Allow override for staging/testing
  if (process.env.QSTASH_WORKER_URL) {
    return process.env.QSTASH_WORKER_URL;
  }

  // Construct from Vercel URL
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) {
    const protocol = vercelUrl.includes("localhost") ? "http" : "https";
    return `${protocol}://${vercelUrl}/api/lite/qstash-worker`;
  }

  // Fallback for local development
  return "http://localhost:3000/api/lite/qstash-worker";
}

/**
 * Publish a job to the QStash queue
 * @param {string} jobId - The job ID
 * @param {string} blobUrl - The blob URL to process
 * @returns {Promise<{messageId: string}>}
 */
async function publishToQueue(jobId, blobUrl) {
  const c = getClient();
  const workerUrl = getWorkerUrl();

  const startTime = Date.now();

  try {
    const result = await c.publishJSON({
      url: workerUrl,
      body: { jobId, blobUrl },
      retries: MAX_RETRIES,
      flowControl: {
        key: FLOW_CONTROL_KEY,
        parallelism: PARALLELISM_LIMIT
      }
    });

    const elapsed = Date.now() - startTime;
    logInfo("Job published to QStash", {
      jobId,
      messageId: result.messageId,
      workerUrl,
      parallelism: PARALLELISM_LIMIT,
      elapsed_ms: elapsed
    });

    return { messageId: result.messageId };
  } catch (err) {
    logError("Failed to publish to QStash", {
      jobId,
      error: err.message,
      workerUrl
    });
    throw err;
  }
}

/**
 * Verify QStash signature on incoming request
 * @param {object} req - The request object
 * @returns {Promise<boolean>}
 */
async function verifySignature(req) {
  try {
    const r = getReceiver();
    const signature = req.headers["upstash-signature"];

    if (!signature) {
      logError("Missing QStash signature header");
      return false;
    }

    // Get the raw body - QStash signs the raw body
    let body = req.body;
    if (typeof body === "object") {
      body = JSON.stringify(body);
    }

    const isValid = await r.verify({
      signature,
      body
    });

    if (!isValid) {
      logError("Invalid QStash signature");
    }

    return isValid;
  } catch (err) {
    logError("QStash signature verification error", { error: err.message });
    return false;
  }
}

/**
 * Check if QStash is configured
 */
function isQStashConfigured() {
  return !!(
    process.env.QSTASH_TOKEN &&
    process.env.QSTASH_CURRENT_SIGNING_KEY &&
    process.env.QSTASH_NEXT_SIGNING_KEY
  );
}

module.exports = {
  publishToQueue,
  verifySignature,
  isQStashConfigured,
  getWorkerUrl,
  FLOW_CONTROL_KEY,
  PARALLELISM_LIMIT,
  MAX_RETRIES
};
