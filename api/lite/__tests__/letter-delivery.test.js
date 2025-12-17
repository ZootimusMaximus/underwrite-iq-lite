const test = require("node:test");
const assert = require("node:assert/strict");

const { deliverLetters, deliverLettersAsync } = require("../letter-delivery");

// ============================================================================
// deliverLetters - path determination tests
// ============================================================================
test("deliverLetters returns repair path for non-fundable", async () => {
  // This will fail at GHL contact creation due to missing API key,
  // but we can still verify path determination
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.GHL_PRIVATE_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    bureaus: {},
    underwrite: { fundable: false },
    personal: {}
  });

  // Restore
  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.path, "repair");
});

test("deliverLetters returns fundable path for fundable", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.GHL_PRIVATE_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    bureaus: {},
    underwrite: { fundable: true },
    personal: {}
  });

  // Restore
  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.path, "fundable");
});

test("deliverLetters defaults to repair path when underwrite is empty", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.GHL_PRIVATE_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.path, "repair");
});

// ============================================================================
// deliverLetters - letter generation tests
// ============================================================================
test("deliverLetters generates correct number of letters for repair path", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: { fundable: false },
    personal: { name: "Test User" }
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Repair path: 9 dispute + 3 personal info (one per bureau) = 12 letters
  assert.equal(result.letters.generated, 12);
});

test("deliverLetters generates correct number of letters for fundable path", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: { fundable: true },
    personal: { name: "Test User" }
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Fundable path: 3 inquiry + 3 personal info (one per bureau) = 6 letters
  assert.equal(result.letters.generated, 6);
});

// ============================================================================
// deliverLetters - upload failure handling
// ============================================================================
test("deliverLetters reports upload failures when token missing", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: { fundable: true },
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.letters.uploaded, 0);
  assert.equal(result.letters.failed, 6); // All 6 fundable letters should fail
});

// ============================================================================
// deliverLetters - GHL skip handling
// ============================================================================
test("deliverLetters skips GHL update when no contactId and no contactData", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    contactData: null,
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.ghlSkipped, true);
  assert.equal(result.ghlUpdated, false);
});

// ============================================================================
// deliverLetters - result structure tests
// ============================================================================
test("deliverLetters includes duration in result", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.ok(typeof result.duration === "number");
  assert.ok(result.duration >= 0);
});

test("deliverLetters includes urls object in result", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-id",
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.ok(result.urls !== undefined);
  assert.ok(typeof result.urls === "object");
});

// ============================================================================
// deliverLettersAsync tests
// ============================================================================
test("deliverLettersAsync returns immediately with async flag", () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = deliverLettersAsync({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.ok, true);
  assert.equal(result.async, true);
  assert.ok(result.message.includes("background"));
});

test("deliverLettersAsync does not block execution", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const start = Date.now();
  const result = deliverLettersAsync({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: {},
    personal: {}
  });
  const elapsed = Date.now() - start;

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Should return in less than 50ms (not waiting for letter generation)
  assert.ok(elapsed < 50);
  assert.equal(result.ok, true);
});

// ============================================================================
// deliverLetters - error handling tests
// ============================================================================
test("deliverLetters handles null bureaus gracefully", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-id",
    bureaus: null,
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Should still work, using empty bureaus
  assert.equal(result.ok, true);
  assert.ok(result.letters.generated > 0);
});

test("deliverLetters handles null personal gracefully", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-id",
    bureaus: {},
    underwrite: {},
    personal: null
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Should still work, using empty personal
  assert.equal(result.ok, true);
  assert.ok(result.letters.generated > 0);
});

test("deliverLetters handles null underwrite gracefully", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-id",
    bureaus: {},
    underwrite: null,
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Should default to repair path
  assert.equal(result.ok, true);
  assert.equal(result.path, "repair");
});
