const test = require("node:test");
const assert = require("node:assert/strict");

// Store original env
const originalEnv = { ...process.env };

// Reset env before each test
function resetEnv() {
  // Clear relevant env vars
  delete process.env.UNDERWRITE_IQ_VISION_KEY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.REDIRECT_URL_FUNDABLE;
  delete process.env.REDIRECT_URL_NOT_FUNDABLE;
  delete process.env.REDIRECT_BASE_URL;
}

// Restore original env after tests
function restoreEnv() {
  Object.keys(process.env).forEach(key => {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  });
  Object.assign(process.env, originalEnv);
}

test("validateConfig throws when UNDERWRITE_IQ_VISION_KEY is missing", () => {
  resetEnv();
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token123";

  // Need to re-require to get fresh module
  delete require.cache[require.resolve("../config-validator")];
  const { validateConfig } = require("../config-validator");

  assert.throws(
    () => validateConfig(),
    err => err.message.includes("UNDERWRITE_IQ_VISION_KEY")
  );

  restoreEnv();
});

test("validateConfig throws when UPSTASH_REDIS_REST_URL is missing", () => {
  resetEnv();
  process.env.UNDERWRITE_IQ_VISION_KEY = "key123";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token123";

  delete require.cache[require.resolve("../config-validator")];
  const { validateConfig } = require("../config-validator");

  assert.throws(
    () => validateConfig(),
    err => err.message.includes("UPSTASH_REDIS_REST_URL")
  );

  restoreEnv();
});

test("validateConfig throws when UPSTASH_REDIS_REST_TOKEN is missing", () => {
  resetEnv();
  process.env.UNDERWRITE_IQ_VISION_KEY = "key123";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";

  delete require.cache[require.resolve("../config-validator")];
  const { validateConfig } = require("../config-validator");

  assert.throws(
    () => validateConfig(),
    err => err.message.includes("UPSTASH_REDIS_REST_TOKEN")
  );

  restoreEnv();
});

test("validateConfig throws with all missing vars listed", () => {
  resetEnv();

  delete require.cache[require.resolve("../config-validator")];
  const { validateConfig } = require("../config-validator");

  assert.throws(
    () => validateConfig(),
    err => {
      return (
        err.message.includes("UNDERWRITE_IQ_VISION_KEY") &&
        err.message.includes("UPSTASH_REDIS_REST_URL") &&
        err.message.includes("UPSTASH_REDIS_REST_TOKEN")
      );
    }
  );

  restoreEnv();
});

test("validateConfig passes when all required vars are set", () => {
  resetEnv();
  process.env.UNDERWRITE_IQ_VISION_KEY = "key123";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token123";

  delete require.cache[require.resolve("../config-validator")];
  const { validateConfig } = require("../config-validator");

  assert.doesNotThrow(() => validateConfig());

  restoreEnv();
});

test("validateConfigWithWarnings passes and warns on missing optional vars", () => {
  resetEnv();
  process.env.UNDERWRITE_IQ_VISION_KEY = "key123";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token123";

  delete require.cache[require.resolve("../config-validator")];
  const { validateConfigWithWarnings } = require("../config-validator");

  // Should not throw, just warn
  assert.doesNotThrow(() => validateConfigWithWarnings());

  restoreEnv();
});

test("validateConfigWithWarnings passes with all vars set", () => {
  resetEnv();
  process.env.UNDERWRITE_IQ_VISION_KEY = "key123";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token123";
  process.env.REDIRECT_URL_FUNDABLE = "https://example.com/fundable";
  process.env.REDIRECT_URL_NOT_FUNDABLE = "https://example.com/not-fundable";
  process.env.REDIRECT_BASE_URL = "https://example.com";

  delete require.cache[require.resolve("../config-validator")];
  const { validateConfigWithWarnings } = require("../config-validator");

  assert.doesNotThrow(() => validateConfigWithWarnings());

  restoreEnv();
});
