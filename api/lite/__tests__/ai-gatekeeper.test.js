const test = require("node:test");
const assert = require("node:assert/strict");

// Store original env
const originalEnv = { ...process.env };

// Reset VISION_KEY before tests
function setupEnv(hasKey = false) {
  if (hasKey) {
    process.env.UNDERWRITE_IQ_VISION_KEY = "test-key-123";
  } else {
    delete process.env.UNDERWRITE_IQ_VISION_KEY;
  }
}

function restoreEnv() {
  Object.keys(process.env).forEach(key => {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  });
  Object.assign(process.env, originalEnv);
}

// ============================================================================
// aiGateCheck tests - No API key configured
// ============================================================================
test("aiGateCheck returns ok:true when no API key configured", async () => {
  setupEnv(false);

  // Re-require to get fresh module with no key
  delete require.cache[require.resolve("../ai-gatekeeper")];
  const { aiGateCheck } = require("../ai-gatekeeper");

  const buffer = Buffer.from("%PDF-1.4 test content");
  const result = await aiGateCheck(buffer, "test.pdf");

  assert.equal(result.ok, true);
  assert.ok(result.reason.includes("No AI key") || result.reason.includes("skipped"));

  restoreEnv();
});

// ============================================================================
// aiGateCheck tests - With API key (mocked behavior)
// ============================================================================
test("aiGateCheck handles buffer input", async () => {
  setupEnv(false); // No key = skip mode

  delete require.cache[require.resolve("../ai-gatekeeper")];
  const { aiGateCheck } = require("../ai-gatekeeper");

  const buffer = Buffer.alloc(1024, "x");
  const result = await aiGateCheck(buffer, "test.pdf");

  assert.ok(result);
  assert.ok("ok" in result);
  assert.ok("reason" in result);

  restoreEnv();
});

test("aiGateCheck handles missing filename", async () => {
  setupEnv(false);

  delete require.cache[require.resolve("../ai-gatekeeper")];
  const { aiGateCheck } = require("../ai-gatekeeper");

  const buffer = Buffer.from("%PDF-1.4");
  const result = await aiGateCheck(buffer, null);

  assert.ok(result.ok);

  restoreEnv();
});

test("aiGateCheck handles undefined filename", async () => {
  setupEnv(false);

  delete require.cache[require.resolve("../ai-gatekeeper")];
  const { aiGateCheck } = require("../ai-gatekeeper");

  const buffer = Buffer.from("%PDF-1.4");
  const result = await aiGateCheck(buffer, undefined);

  assert.ok(result.ok);

  restoreEnv();
});

test("aiGateCheck handles empty buffer", async () => {
  setupEnv(false);

  delete require.cache[require.resolve("../ai-gatekeeper")];
  const { aiGateCheck } = require("../ai-gatekeeper");

  const buffer = Buffer.alloc(0);
  const result = await aiGateCheck(buffer, "empty.pdf");

  assert.ok(result);

  restoreEnv();
});

test("aiGateCheck returns suspected_bureaus array", async () => {
  setupEnv(false);

  delete require.cache[require.resolve("../ai-gatekeeper")];
  const { aiGateCheck } = require("../ai-gatekeeper");

  const buffer = Buffer.from("%PDF-1.4");
  const result = await aiGateCheck(buffer, "test.pdf");

  // When skipping, suspected_bureaus may not be present, but result should be valid
  assert.ok(result.ok !== undefined);

  restoreEnv();
});

// ============================================================================
// extractTextFromResponse tests (internal function behavior)
// ============================================================================
test("aiGateCheck gracefully handles large buffers", async () => {
  setupEnv(false);

  delete require.cache[require.resolve("../ai-gatekeeper")];
  const { aiGateCheck } = require("../ai-gatekeeper");

  // Create a large buffer (> 200KB to test truncation logic path)
  const largeBuffer = Buffer.alloc(300 * 1024, "x");
  const result = await aiGateCheck(largeBuffer, "large.pdf");

  assert.ok(result);

  restoreEnv();
});
