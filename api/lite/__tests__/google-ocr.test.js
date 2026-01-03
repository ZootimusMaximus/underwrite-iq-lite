const test = require("node:test");
const assert = require("node:assert/strict");
const { googleOCR, isGoogleOCRAvailable } = require("../google-ocr");

test("googleOCR returns error when credentials missing", async () => {
  // In test env, credentials are typically not set
  if (isGoogleOCRAvailable()) {
    // Skip if credentials are available (integration test)
    return;
  }
  const buffer = Buffer.from("test content");
  const result = await googleOCR(buffer);
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("credentials") || result.error.includes("Missing"));
});

test("googleOCR returns text property even on error", async () => {
  const buffer = Buffer.from("test content");
  const result = await googleOCR(buffer);
  assert.equal(typeof result.text, "string");
});

test("isGoogleOCRAvailable returns boolean", () => {
  const result = isGoogleOCRAvailable();
  assert.equal(typeof result, "boolean");
});

test("googleOCR handles empty buffer gracefully", async () => {
  const buffer = Buffer.alloc(0);
  const result = await googleOCR(buffer);
  // Should not throw, should return a result object
  assert.ok(result !== null && typeof result === "object");
  assert.equal(typeof result.ok, "boolean");
});

test("googleOCR handles large buffer gracefully", async () => {
  const buffer = Buffer.alloc(1024 * 1024); // 1MB
  const result = await googleOCR(buffer);
  // Should not throw, should return a result object
  assert.ok(result !== null && typeof result === "object");
  assert.equal(typeof result.ok, "boolean");
});
