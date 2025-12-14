// ============================================================================
// UnderwriteIQ Lite — Configuration Validator
// ============================================================================
// Validates required environment variables at startup
// Fails fast with clear error messages if configuration is missing

const { logInfo, logWarn } = require("./logger");

/**
 * Validates that all required environment variables are set
 * @throws {Error} If any required environment variables are missing
 */
function validateConfig() {
  const required = [
    "UNDERWRITE_IQ_VISION_KEY",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN"
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    const errorMessage = [
      "Missing required environment variables:",
      ...missing.map(key => `   - ${key}`),
      "",
      "See .env.example for required configuration"
    ].join("\n");

    throw new Error(errorMessage);
  }

  // Log successful validation
  logInfo("Configuration validated successfully", { requiredVars: required.length });
}

/**
 * Validates configuration and logs warnings for optional variables
 */
function validateConfigWithWarnings() {
  // Validate required vars (throws on error)
  validateConfig();

  // Check optional but recommended vars
  const recommended = ["REDIRECT_URL_FUNDABLE", "REDIRECT_URL_NOT_FUNDABLE", "REDIRECT_BASE_URL"];

  const missingRecommended = recommended.filter(key => !process.env[key]);

  if (missingRecommended.length > 0) {
    logWarn("Optional environment variables not set (using defaults)", {
      missingVars: missingRecommended
    });
  }
}

module.exports = {
  validateConfig,
  validateConfigWithWarnings
};
