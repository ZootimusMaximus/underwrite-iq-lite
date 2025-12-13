// ============================================================================
// UnderwriteIQ Lite — Centralized Logger (Pino)
// ============================================================================
// High-performance structured logging for production
// Uses Pino for fast, JSON-based logging compatible with log aggregators

const pino = require("pino");

// Create logger instance with production-ready configuration
const logger = pino({
  level: process.env.LOG_LEVEL || "info",

  // Serverless-friendly: no pretty printing in production
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss Z",
            ignore: "pid,hostname",
          },
        }
      : undefined,

  // Base fields included in every log
  base: {
    service: "underwrite-iq-lite",
    env: process.env.NODE_ENV || "production",
  },

  // Timestamp format
  timestamp: pino.stdTimeFunctions.isoTime,

  // Serializers for common objects
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
});

/**
 * Log an error with context
 * @param {string} tag - Error tag/category
 * @param {Error|string} err - Error object or message
 * @param {string} context - Additional context
 */
function logError(tag, err, context = "") {
  logger.error(
    {
      tag,
      context,
      err: err instanceof Error ? err : new Error(String(err)),
    },
    `Error: ${tag}`,
  );
}

/**
 * Log info message
 * @param {string} msg - Info message
 * @param {object} data - Additional data
 */
function logInfo(msg, data = {}) {
  logger.info(data, msg);
}

/**
 * Log warning message
 * @param {string} msg - Warning message
 * @param {object} data - Additional data
 */
function logWarn(msg, data = {}) {
  logger.warn(data, msg);
}

/**
 * Log debug message (only in development)
 * @param {string} msg - Debug message
 * @param {object} data - Additional data
 */
function logDebug(msg, data = {}) {
  logger.debug(data, msg);
}

/**
 * Create a child logger with additional context
 * @param {object} bindings - Context to bind to all logs
 * @returns {object} Child logger instance
 */
function createChildLogger(bindings) {
  return logger.child(bindings);
}

module.exports = {
  logger,
  logError,
  logInfo,
  logWarn,
  logDebug,
  createChildLogger,
};
