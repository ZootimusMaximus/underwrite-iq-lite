const test = require("node:test");
const assert = require("node:assert/strict");

// Test parseFullName directly (pure function)
const { parseFullName } = require("../ghl-contact-service");

// ============================================================================
// parseFullName tests
// ============================================================================
test("parseFullName splits first and last name", () => {
  const result = parseFullName("John Doe");
  assert.equal(result.firstName, "John");
  assert.equal(result.lastName, "Doe");
});

test("parseFullName handles single name", () => {
  const result = parseFullName("Madonna");
  assert.equal(result.firstName, "Madonna");
  assert.equal(result.lastName, "");
});

test("parseFullName handles multiple middle names", () => {
  const result = parseFullName("John Michael Smith Jr");
  assert.equal(result.firstName, "John");
  assert.equal(result.lastName, "Michael Smith Jr");
});

test("parseFullName handles empty string", () => {
  const result = parseFullName("");
  assert.equal(result.firstName, "");
  assert.equal(result.lastName, "");
});

test("parseFullName handles null", () => {
  const result = parseFullName(null);
  assert.equal(result.firstName, "");
  assert.equal(result.lastName, "");
});

test("parseFullName handles undefined", () => {
  const result = parseFullName(undefined);
  assert.equal(result.firstName, "");
  assert.equal(result.lastName, "");
});

test("parseFullName handles non-string input", () => {
  const result = parseFullName(12345);
  assert.equal(result.firstName, "");
  assert.equal(result.lastName, "");
});

test("parseFullName trims whitespace", () => {
  const result = parseFullName("  John   Doe  ");
  assert.equal(result.firstName, "John");
  assert.equal(result.lastName, "Doe");
});

test("parseFullName handles extra spaces between names", () => {
  const result = parseFullName("John    Michael    Doe");
  assert.equal(result.firstName, "John");
  assert.equal(result.lastName, "Michael Doe");
});

// ============================================================================
// Config function tests (with env var manipulation)
// ============================================================================
test("getApiBase returns default when not configured", async () => {
  const originalBase = process.env.GHL_API_BASE;
  delete process.env.GHL_API_BASE;

  // Re-require to get fresh module
  delete require.cache[require.resolve("../ghl-contact-service")];
  const { createOrUpdateContact } = require("../ghl-contact-service");

  // Call function - it will fail but we can check the error message
  const result = await createOrUpdateContact({ email: "test@test.com" });

  // Restore
  if (originalBase) process.env.GHL_API_BASE = originalBase;

  // Should fail due to missing API key, not base URL
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("API key"));
});

test("getApiKey returns null when not configured", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  const originalKey2 = process.env.GHL_API_KEY;
  delete process.env.GHL_PRIVATE_API_KEY;
  delete process.env.GHL_API_KEY;

  delete require.cache[require.resolve("../ghl-contact-service")];
  const { createOrUpdateContact } = require("../ghl-contact-service");

  const result = await createOrUpdateContact({ email: "test@test.com" });

  // Restore
  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;
  if (originalKey2) process.env.GHL_API_KEY = originalKey2;

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("API key"));
});

test("getLocationId returns null when not configured", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  const originalLoc = process.env.GHL_LOCATION_ID;

  process.env.GHL_PRIVATE_API_KEY = "test-key";
  delete process.env.GHL_LOCATION_ID;

  delete require.cache[require.resolve("../ghl-contact-service")];
  const { createOrUpdateContact } = require("../ghl-contact-service");

  const result = await createOrUpdateContact({ email: "test@test.com" });

  // Restore
  if (originalKey) {
    process.env.GHL_PRIVATE_API_KEY = originalKey;
  } else {
    delete process.env.GHL_PRIVATE_API_KEY;
  }
  if (originalLoc) process.env.GHL_LOCATION_ID = originalLoc;

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Location ID"));
});

// ============================================================================
// findContactByEmail tests
// ============================================================================
test("findContactByEmail returns null for empty email", async () => {
  const { findContactByEmail } = require("../ghl-contact-service");
  const result = await findContactByEmail("");
  assert.equal(result, null);
});

test("findContactByEmail returns null for null email", async () => {
  const { findContactByEmail } = require("../ghl-contact-service");
  const result = await findContactByEmail(null);
  assert.equal(result, null);
});

test("findContactByEmail returns null when API key missing", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  delete process.env.GHL_PRIVATE_API_KEY;
  delete process.env.GHL_API_KEY;

  delete require.cache[require.resolve("../ghl-contact-service")];
  const { findContactByEmail } = require("../ghl-contact-service");

  const result = await findContactByEmail("test@test.com");

  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;

  assert.equal(result, null);
});

// ============================================================================
// createAffiliate tests
// ============================================================================
test("createAffiliate returns error when API key missing", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  delete process.env.GHL_PRIVATE_API_KEY;
  delete process.env.GHL_API_KEY;

  delete require.cache[require.resolve("../ghl-contact-service")];
  const { createAffiliate } = require("../ghl-contact-service");

  const result = await createAffiliate("contact-123");

  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("API key"));
});

// ============================================================================
// createContactAndAffiliate tests
// ============================================================================
test("createContactAndAffiliate returns error when contact creation fails", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  delete process.env.GHL_PRIVATE_API_KEY;

  delete require.cache[require.resolve("../ghl-contact-service")];
  const { createContactAndAffiliate } = require("../ghl-contact-service");

  const result = await createContactAndAffiliate({ email: "test@test.com" });

  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;

  assert.equal(result.ok, false);
  assert.equal(result.contactCreated, false);
  assert.equal(result.affiliateCreated, false);
});

// ============================================================================
// updateContact tests
// ============================================================================
test("updateContact returns error when API key missing", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  delete process.env.GHL_PRIVATE_API_KEY;

  delete require.cache[require.resolve("../ghl-contact-service")];
  const { updateContact } = require("../ghl-contact-service");

  const result = await updateContact("contact-123", { firstName: "Test" });

  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("API key"));
});
