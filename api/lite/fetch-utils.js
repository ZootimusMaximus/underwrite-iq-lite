// ============================================================================
// UnderwriteIQ Lite — Fetch Utilities
// ============================================================================
// Provides timeout-protected fetch to prevent hanging requests

const { logWarn } = require("./logger");

// Default timeout for external API calls (30 seconds)
const DEFAULT_TIMEOUT_MS = 30000;

// Timeout for expensive OpenAI calls (60 seconds)
const OPENAI_TIMEOUT_MS = 60000;

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
 * Fetch with timeout for OpenAI API calls (longer timeout)
 * @param {string} url - URL to fetch
 * @param {object} options - Fetch options
 * @returns {Promise<Response>}
 */
async function fetchOpenAI(url, options = {}) {
  return fetchWithTimeout(url, options, OPENAI_TIMEOUT_MS);
}

module.exports = {
  fetchWithTimeout,
  fetchOpenAI,
  DEFAULT_TIMEOUT_MS,
  OPENAI_TIMEOUT_MS
};
