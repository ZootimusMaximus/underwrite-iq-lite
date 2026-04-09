"use strict";

// ============================================================================
// Idempotency — Redis-based duplicate event guard
//
// Uses Upstash Redis (same singleton pattern as dedupe-store.js).
// Key format: evt:{idempotency_key}
// TTL: 7 days (events older than 7 days can be safely re-sent).
//
// The check + set is done in two steps:
//   1. checkIdempotency(key) — returns true if already processed
//   2. markProcessed(key, metadata) — sets the key with TTL after handler succeeds
//
// This two-step approach means a handler crash between check and mark will
// allow the event to be retried, which is the correct behavior.
//
// See: FundHub Modular Event System Developer Handoff, section 10.
// ============================================================================

const { Redis } = require("@upstash/redis");
const { logInfo, logWarn, logError } = require("../../lite/logger");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const KEY_PREFIX = "evt:";

// ---------------------------------------------------------------------------
// Singleton Redis client (matches dedupe-store.js pattern)
// ---------------------------------------------------------------------------

let redisInstance = null;

/**
 * Get or create the singleton Redis client.
 * Returns null if credentials are not configured (graceful degradation).
 *
 * @returns {Redis|null}
 */
function getRedisClient() {
  if (redisInstance) return redisInstance;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    logWarn(
      "Idempotency store unavailable — UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set"
    );
    return null;
  }

  try {
    redisInstance = new Redis({ url, token });
    return redisInstance;
  } catch (err) {
    logError("Failed to initialize idempotency Redis client", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if an event with the given idempotency key has already been processed.
 *
 * @param {string} idempotencyKey - Stable idempotency key from the event envelope
 * @returns {Promise<boolean>} true if already processed (caller should skip), false otherwise
 * @throws {Error} if Redis is configured but the read fails (let caller decide policy)
 */
async function checkIdempotency(idempotencyKey) {
  if (!idempotencyKey) return false;

  const redis = getRedisClient();
  if (!redis) {
    // No Redis = no idempotency protection. Log and continue.
    logWarn("Idempotency check skipped — Redis not available", { key: idempotencyKey });
    return false;
  }

  const redisKey = KEY_PREFIX + idempotencyKey;
  const existing = await redis.get(redisKey);
  return existing !== null && existing !== undefined;
}

/**
 * Mark an event as processed in the idempotency store.
 * Called after the handler succeeds.
 *
 * @param {string} idempotencyKey - Stable idempotency key from the event envelope
 * @param {object} metadata - Data to store (event_id, event_name, processed_at, etc.)
 * @returns {Promise<boolean>} true if stored successfully, false otherwise
 */
async function markProcessed(idempotencyKey, metadata = {}) {
  if (!idempotencyKey) return false;

  const redis = getRedisClient();
  if (!redis) {
    logWarn("Idempotency mark skipped — Redis not available", { key: idempotencyKey });
    return false;
  }

  const redisKey = KEY_PREFIX + idempotencyKey;
  const value = JSON.stringify({
    ...metadata,
    stored_at: new Date().toISOString()
  });

  try {
    await redis.set(redisKey, value, { ex: TTL_SECONDS });
    logInfo("Idempotency key stored", { key: idempotencyKey, ttl: TTL_SECONDS });
    return true;
  } catch (err) {
    logWarn("Failed to store idempotency key", { key: idempotencyKey, error: err.message });
    return false;
  }
}

/**
 * Read the stored metadata for a processed event (useful for debugging).
 *
 * @param {string} idempotencyKey
 * @returns {Promise<object|null>}
 */
async function getProcessedEvent(idempotencyKey) {
  if (!idempotencyKey) return null;

  const redis = getRedisClient();
  if (!redis) return null;

  const redisKey = KEY_PREFIX + idempotencyKey;
  const raw = await redis.get(redisKey);
  if (!raw) return null;

  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

/**
 * Reset the singleton Redis instance (for testing).
 */
function _resetForTesting() {
  redisInstance = null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  checkIdempotency,
  markProcessed,
  getProcessedEvent,
  getRedisClient,
  TTL_SECONDS,
  KEY_PREFIX,
  _resetForTesting
};
