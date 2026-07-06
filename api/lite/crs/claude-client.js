"use strict";

/**
 * claude-client.js — Claude API Client with Circuit Breaker
 *
 * Mirrors the existing fetch pattern from fetch-utils.js.
 * Handles auth, timeouts, retries, and circuit breaking.
 */

const { logInfo, logWarn, logError: _logError } = require("../logger");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_MAX_TOKENS = 4096;

// Usage tracking
const usageStats = { calls: 0, inputTokens: 0, outputTokens: 0 };

// Circuit breaker state
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 60000; // 1 minute

function checkCircuitBreaker() {
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    if (Date.now() < circuitOpenUntil) {
      return { allowed: false, reason: "Circuit breaker open — Claude API temporarily disabled" };
    }
    // Half-open: allow one attempt
    consecutiveFailures = FAILURE_THRESHOLD - 1;
  }
  return { allowed: true };
}

function recordSuccess() {
  consecutiveFailures = 0;
}

function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
    logWarn("claude-client: Circuit breaker OPEN", {
      resetAt: new Date(circuitOpenUntil).toISOString()
    });
  }
}

/**
 * callClaude({ system, user, maxTokens, model, timeoutMs, useCache, temperature })
 *
 * @param {Object} opts
 * @param {string} opts.system - System prompt
 * @param {string} opts.user - User message content
 * @param {number} [opts.maxTokens] - Max tokens (default 4096)
 * @param {string} [opts.model] - Model ID (default claude-sonnet-4-6)
 * @param {number} [opts.timeoutMs] - Timeout in ms (default 90000)
 * @param {boolean} [opts.useCache=true] - Enable prompt caching for the system prompt
 * @param {number} [opts.temperature] - Temperature (0-1, default undefined — let Anthropic decide)
 * @returns {Promise<string>} Claude's text response
 */
async function callClaude({
  system,
  user,
  maxTokens,
  model,
  timeoutMs,
  useCache = true,
  temperature
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const circuitCheck = checkCircuitBreaker();
  if (!circuitCheck.allowed) throw new Error(circuitCheck.reason);

  const selectedModel = model || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  const timeout =
    timeoutMs || parseInt(process.env.CLAUDE_TIMEOUT || String(DEFAULT_TIMEOUT_MS), 10);
  const tokens = maxTokens || DEFAULT_MAX_TOKENS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  };
  if (useCache) {
    headers["anthropic-beta"] = "prompt-caching-2024-07-31";
  }

  const systemPayload =
    useCache && system
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : system;

  try {
    const requestBody = {
      model: selectedModel,
      max_tokens: tokens,
      system: systemPayload,
      messages: [{ role: "user", content: user }]
    };

    if (temperature !== undefined && temperature !== null) {
      requestBody.temperature = temperature;
    }

    const resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      recordFailure();
      throw new Error(`Claude API ${resp.status}: ${text.substring(0, 200)}`);
    }

    const data = await resp.json();
    const content = data.content?.[0]?.text;
    if (!content) {
      recordFailure();
      throw new Error("Claude returned empty content");
    }

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    usageStats.calls += 1;
    usageStats.inputTokens += inputTokens;
    usageStats.outputTokens += outputTokens;

    recordSuccess();
    logInfo(`[claude-client] model=${selectedModel} input=${inputTokens} output=${outputTokens}`);
    return content;
  } catch (err) {
    if (err.name === "AbortError") {
      recordFailure();
      throw new Error(`Claude API timeout after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Reset circuit breaker (for testing)
function resetCircuitBreaker() {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

function getUsageStats() {
  return { ...usageStats };
}

function resetUsageStats() {
  usageStats.calls = 0;
  usageStats.inputTokens = 0;
  usageStats.outputTokens = 0;
}

module.exports = {
  callClaude,
  checkCircuitBreaker,
  resetCircuitBreaker,
  getUsageStats,
  resetUsageStats,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS
};
