// ============================================================================
// UnderwriteIQ Lite — Rate Limiter (Upstash)
// ============================================================================
// Prevents API abuse and protects against unbounded OpenAI costs
// Uses distributed rate limiting with Upstash Redis

const { Ratelimit } = require("@upstash/ratelimit");
const { Redis } = require("@upstash/redis");
const { logWarn, logInfo } = require("./logger");

// Rate limit configuration (can be overridden by environment variables)
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "10", 10);
const RATE_LIMIT_WINDOW = process.env.RATE_LIMIT_WINDOW || "1 m"; // 1 minute
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== "false"; // Enabled by default

// Create Redis client for rate limiting
let redis = null;
let ratelimit = null;

/**
 * Initialize rate limiter
 * @returns {Ratelimit|null} Rate limiter instance or null if disabled/unavailable
 */
function createRateLimiter() {
  if (!RATE_LIMIT_ENABLED) {
    logInfo("Rate limiting is disabled");
    return null;
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    logWarn("Rate limiting disabled: Redis credentials not configured");
    return null;
  }

  try {
    redis = new Redis({
      url: redisUrl,
      token: redisToken
    });

    // Create rate limiter with sliding window algorithm
    ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW),
      analytics: true,
      prefix: "uwiq:ratelimit"
    });

    logInfo(
      `Rate limiting initialized: ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW}`
    );
    return ratelimit;
  } catch (err) {
    logWarn("Failed to initialize rate limiter", { error: err.message });
    return null;
  }
}

/**
 * Get rate limiter instance (lazy initialization)
 * @returns {Ratelimit|null}
 */
function getRateLimiter() {
  if (ratelimit === null && RATE_LIMIT_ENABLED) {
    ratelimit = createRateLimiter();
  }
  return ratelimit;
}

/**
 * Extract identifier from request for rate limiting
 * Uses IP address, with fallback to user-agent
 * @param {object} req - Request object
 * @returns {string} Identifier for rate limiting
 */
function getIdentifier(req) {
  // Try to get real IP from headers (Vercel, Cloudflare, etc.)
  const forwardedFor = req.headers["x-forwarded-for"];
  const realIp = req.headers["x-real-ip"];
  const cfConnectingIp = req.headers["cf-connecting-ip"];

  const ip = cfConnectingIp || realIp || (forwardedFor ? forwardedFor.split(",")[0].trim() : null);

  // Fallback to socket address if no headers
  const socketIp = req.socket?.remoteAddress || req.connection?.remoteAddress;

  // Last resort: user-agent hash
  const userAgent = req.headers["user-agent"] || "unknown";

  return ip || socketIp || `ua:${userAgent}`;
}

/**
 * Check rate limit for a request
 * @param {object} req - Request object
 * @returns {Promise<{success: boolean, limit: number, remaining: number, reset: number, identifier: string}>}
 */
async function checkRateLimit(req) {
  const limiter = getRateLimiter();

  // If rate limiting is disabled or unavailable, allow request
  if (!limiter) {
    return {
      success: true,
      limit: 0,
      remaining: 0,
      reset: 0,
      identifier: "disabled"
    };
  }

  const identifier = getIdentifier(req);

  try {
    const { success, limit, remaining, reset } = await limiter.limit(identifier);

    if (!success) {
      logWarn("Rate limit exceeded", {
        identifier,
        limit,
        remaining,
        reset: new Date(reset).toISOString()
      });
    }

    return { success, limit, remaining, reset, identifier };
  } catch (err) {
    // If rate limiting fails, allow request but log error
    logWarn("Rate limit check failed, allowing request", { error: err.message });
    return {
      success: true,
      limit: 0,
      remaining: 0,
      reset: 0,
      identifier,
      error: err.message
    };
  }
}

/**
 * Set rate limit headers on response
 * @param {object} res - Response object
 * @param {object} rateLimitResult - Result from checkRateLimit
 */
function setRateLimitHeaders(res, rateLimitResult) {
  if (rateLimitResult.limit > 0) {
    res.setHeader("X-RateLimit-Limit", rateLimitResult.limit);
    res.setHeader("X-RateLimit-Remaining", rateLimitResult.remaining);
    res.setHeader("X-RateLimit-Reset", rateLimitResult.reset);
  }
}

/**
 * Rate limiting middleware
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @returns {Promise<boolean>} True if request is allowed, false if rate limited
 */
async function rateLimitMiddleware(req, res) {
  const result = await checkRateLimit(req);

  // Set rate limit headers
  setRateLimitHeaders(res, result);

  // If rate limited, send 429 response
  if (!result.success) {
    res.status(429).json({
      ok: false,
      error: "Too many requests. Please try again later.",
      retryAfter: Math.ceil((result.reset - Date.now()) / 1000)
    });
    return false;
  }

  return true;
}

module.exports = {
  checkRateLimit,
  setRateLimitHeaders,
  rateLimitMiddleware,
  getIdentifier,
  getRateLimiter
};
