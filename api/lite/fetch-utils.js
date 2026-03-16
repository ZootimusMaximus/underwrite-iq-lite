// ============================================================================
// UnderwriteIQ Lite — Fetch Utilities
// ============================================================================
// Provides timeout-protected fetch to prevent hanging requests

const { logWarn, logInfo } = require("./logger");

// Default timeout for external API calls (30 seconds)
const DEFAULT_TIMEOUT_MS = 30000;

// Timeout for OpenAI calls
// Hobby plan: 60s Vercel limit, Pro plan: 300s limit
// Default 90s - works on Pro, will hit Vercel limit on Hobby for very large files
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT || "90000", 10);

// ============================================================================
// Circuit Breaker for OpenAI API
// ============================================================================
// Prevents cascading failures when OpenAI is slow/down

const CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 3, // Open circuit after 3 consecutive failures
  resetTimeoutMs: 30000, // Try again after 30 seconds
  halfOpenMaxRequests: 1 // Allow 1 request in half-open state
};

// Circuit breaker state (in-memory, resets on cold start)
const circuitState = {
  failures: 0,
  lastFailureTime: 0,
  state: "closed" // closed, open, half-open
};

/**
 * Check if circuit breaker allows request
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkCircuitBreaker() {
  const now = Date.now();

  if (circuitState.state === "closed") {
    return { allowed: true };
  }

  if (circuitState.state === "open") {
    // Check if reset timeout has passed
    const timeSinceFailure = now - circuitState.lastFailureTime;
    if (timeSinceFailure >= CIRCUIT_BREAKER_CONFIG.resetTimeoutMs) {
      circuitState.state = "half-open";
      logInfo("Circuit breaker entering half-open state");
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `Service temporarily unavailable. Retry in ${Math.ceil((CIRCUIT_BREAKER_CONFIG.resetTimeoutMs - timeSinceFailure) / 1000)}s`
    };
  }

  // half-open state - allow limited requests
  return { allowed: true };
}

/**
 * Record successful request - reset circuit breaker
 */
function recordSuccess() {
  if (circuitState.state === "half-open") {
    logInfo("Circuit breaker closing - service recovered");
  }
  circuitState.failures = 0;
  circuitState.state = "closed";
}

/**
 * Record failed request - may trip circuit breaker
 */
function recordFailure() {
  circuitState.failures++;
  circuitState.lastFailureTime = Date.now();

  if (circuitState.failures >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
    circuitState.state = "open";
    logWarn("Circuit breaker OPEN - blocking requests", {
      failures: circuitState.failures,
      resetAfterMs: CIRCUIT_BREAKER_CONFIG.resetTimeoutMs
    });
  }
}

/**
 * Fetch with timeout protection
 * Prevents requests from hanging indefinitely if external service is slow/down
 *
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @param {number} timeoutMs - Timeout in milliseconds (default: 30000)
 * @returns {Promise<Response>}
 * @throws {Error} If request times out or fails
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } catch (err) {
    if (err.name === "AbortError") {
      logWarn("Fetch request timed out", { url, timeoutMs });
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch with timeout for OpenAI API calls (with circuit breaker)
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @returns {Promise<Response>}
 * @throws {Error} If circuit breaker is open or request fails
 */
async function fetchOpenAI(url, options = {}) {
  // Check circuit breaker before making request
  const circuitCheck = checkCircuitBreaker();
  if (!circuitCheck.allowed) {
    throw new Error(circuitCheck.reason || "Service temporarily unavailable");
  }

  try {
    const response = await fetchWithTimeout(url, options, OPENAI_TIMEOUT_MS);

    // Record success if response is ok
    if (response.ok) {
      recordSuccess();
    } else if (response.status >= 500) {
      // Server errors count as failures
      recordFailure();
    }

    return response;
  } catch (err) {
    // Timeouts and network errors count as failures
    recordFailure();
    throw err;
  }
}

module.exports = {
  fetchWithTimeout,
  fetchOpenAI,
  checkCircuitBreaker,
  recordSuccess,
  recordFailure,
  DEFAULT_TIMEOUT_MS,
  OPENAI_TIMEOUT_MS
};
