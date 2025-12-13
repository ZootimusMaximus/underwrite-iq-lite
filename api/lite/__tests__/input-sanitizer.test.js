// ============================================================================
// Input Sanitizer Tests
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeEmail,
  sanitizePhone,
  sanitizeDeviceId,
  sanitizeRefId,
  sanitizeNumber,
  sanitizeBoolean,
  sanitizeString,
  sanitizeFormFields,
  stripHtml
} = require("../input-sanitizer");

// ============================================================================
// stripHtml Tests
// ============================================================================

test("stripHtml removes HTML tags", () => {
  const result = stripHtml("<script>alert('xss')</script>hello");
  // stripHtml removes < > ' " so result is: scriptalert(xss)/scripthello
  // Then it removes quotes, leaving: scriptalert(xss)/scripthello
  assert.equal(result, "alert(xss)hello");
});

test("stripHtml removes quotes and angle brackets", () => {
  const result = stripHtml("test<>'\"data");
  assert.equal(result, "testdata");
});

test("stripHtml trims whitespace", () => {
  const result = stripHtml("  hello world  ");
  assert.equal(result, "hello world");
});

// ============================================================================
// sanitizeEmail Tests
// ============================================================================

test("sanitizeEmail accepts valid email", () => {
  const result = sanitizeEmail("test@example.com");
  assert.equal(result.ok, true);
  assert.equal(result.value, "test@example.com");
  assert.equal(result.error, null);
});

test("sanitizeEmail converts to lowercase", () => {
  const result = sanitizeEmail("TEST@EXAMPLE.COM");
  assert.equal(result.ok, true);
  assert.equal(result.value, "test@example.com");
});

test("sanitizeEmail rejects invalid format", () => {
  const result = sanitizeEmail("not-an-email");
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.match(result.error, /Invalid email format/);
});

test("sanitizeEmail rejects emails that are too long", () => {
  const longEmail = "a".repeat(300) + "@example.com";
  const result = sanitizeEmail(longEmail);
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/);
});

test("sanitizeEmail strips HTML", () => {
  const result = sanitizeEmail("<script>test@example.com</script>");
  assert.equal(result.ok, true);
  // After stripping HTML tags and special chars: scripttestexample.com/script -> test@example.com
  assert.equal(result.value, "test@example.com");
});

test("sanitizeEmail handles null/undefined", () => {
  assert.equal(sanitizeEmail(null).ok, true);
  assert.equal(sanitizeEmail(null).value, null);
  assert.equal(sanitizeEmail(undefined).ok, true);
  assert.equal(sanitizeEmail("").ok, true);
});

// ============================================================================
// sanitizePhone Tests
// ============================================================================

test("sanitizePhone extracts digits only", () => {
  const result = sanitizePhone("(123) 456-7890");
  assert.equal(result.ok, true);
  assert.equal(result.value, "1234567890");
});

test("sanitizePhone rejects phone numbers that are too short", () => {
  const result = sanitizePhone("123");
  assert.equal(result.ok, false);
  assert.match(result.error, /must be 10/);
});

test("sanitizePhone rejects phone numbers that are too long", () => {
  const longPhone = "1".repeat(25);
  const result = sanitizePhone(longPhone);
  assert.equal(result.ok, false);
  assert.match(result.error, /must be 10/);
});

test("sanitizePhone handles international format", () => {
  const result = sanitizePhone("+1 (234) 567-8901");
  assert.equal(result.ok, true);
  assert.equal(result.value, "12345678901");
});

test("sanitizePhone handles null/undefined", () => {
  assert.equal(sanitizePhone(null).ok, true);
  assert.equal(sanitizePhone(null).value, null);
  assert.equal(sanitizePhone("").ok, true);
});

// ============================================================================
// sanitizeDeviceId Tests
// ============================================================================

test("sanitizeDeviceId accepts alphanumeric and hyphens", () => {
  const result = sanitizeDeviceId("device-123-abc");
  assert.equal(result.ok, true);
  assert.equal(result.value, "device-123-abc");
});

test("sanitizeDeviceId removes special characters", () => {
  const result = sanitizeDeviceId("device!@#$123");
  assert.equal(result.ok, true);
  assert.equal(result.value, "device123");
});

test("sanitizeDeviceId rejects device IDs that are too long", () => {
  const longId = "a".repeat(150);
  const result = sanitizeDeviceId(longId);
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/);
});

test("sanitizeDeviceId handles null/undefined", () => {
  assert.equal(sanitizeDeviceId(null).ok, true);
  assert.equal(sanitizeDeviceId(null).value, null);
});

// ============================================================================
// sanitizeRefId Tests
// ============================================================================

test("sanitizeRefId accepts alphanumeric, hyphens, and underscores", () => {
  const result = sanitizeRefId("ref_123-abc");
  assert.equal(result.ok, true);
  assert.equal(result.value, "ref_123-abc");
});

test("sanitizeRefId removes special characters", () => {
  const result = sanitizeRefId("ref!@#$123");
  assert.equal(result.ok, true);
  assert.equal(result.value, "ref123");
});

test("sanitizeRefId rejects ref IDs that are too long", () => {
  const longId = "a".repeat(150);
  const result = sanitizeRefId(longId);
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/);
});

// ============================================================================
// sanitizeNumber Tests
// ============================================================================

test("sanitizeNumber accepts valid number", () => {
  const result = sanitizeNumber(42, { min: 0, max: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.value, 42);
});

test("sanitizeNumber converts string to number", () => {
  const result = sanitizeNumber("42", { min: 0, max: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.value, 42);
});

test("sanitizeNumber rejects non-numeric values", () => {
  const result = sanitizeNumber("not-a-number");
  assert.equal(result.ok, false);
  assert.match(result.error, /must be a valid number/);
});

test("sanitizeNumber enforces minimum", () => {
  const result = sanitizeNumber(-5, { min: 0, max: 100 });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be between/);
});

test("sanitizeNumber enforces maximum", () => {
  const result = sanitizeNumber(150, { min: 0, max: 100 });
  assert.equal(result.ok, false);
  assert.match(result.error, /must be between/);
});

test("sanitizeNumber handles null/undefined", () => {
  assert.equal(sanitizeNumber(null).ok, true);
  assert.equal(sanitizeNumber(null).value, null);
  assert.equal(sanitizeNumber("").ok, true);
});

// ============================================================================
// sanitizeBoolean Tests
// ============================================================================

test("sanitizeBoolean accepts true", () => {
  assert.equal(sanitizeBoolean(true).value, true);
  assert.equal(sanitizeBoolean("true").value, true);
  assert.equal(sanitizeBoolean("1").value, true);
});

test("sanitizeBoolean accepts false", () => {
  assert.equal(sanitizeBoolean(false).value, false);
  assert.equal(sanitizeBoolean("false").value, false);
  assert.equal(sanitizeBoolean("0").value, false);
});

test("sanitizeBoolean rejects invalid values", () => {
  const result = sanitizeBoolean("invalid");
  assert.equal(result.ok, false);
  assert.match(result.error, /must be true or false/);
});

test("sanitizeBoolean handles null/undefined", () => {
  assert.equal(sanitizeBoolean(null).ok, true);
  assert.equal(sanitizeBoolean(null).value, null);
});

// ============================================================================
// sanitizeString Tests
// ============================================================================

test("sanitizeString strips HTML and trims", () => {
  const result = sanitizeString("  <b>hello</b>  ");
  assert.equal(result.ok, true);
  // After stripping HTML tags and special chars: bhello/b -> hello (after removing < > )
  assert.equal(result.value, "hello");
});

test("sanitizeString enforces max length", () => {
  const longString = "a".repeat(600);
  const result = sanitizeString(longString, 500);
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/);
});

test("sanitizeString handles null/undefined", () => {
  assert.equal(sanitizeString(null).ok, true);
  assert.equal(sanitizeString(null).value, null);
});

// ============================================================================
// sanitizeFormFields Tests
// ============================================================================

test("sanitizeFormFields processes valid form data", () => {
  const fields = {
    email: ["test@example.com"],
    phone: ["1234567890"],
    deviceId: ["device-123"],
    refId: ["ref_abc"],
    businessAgeMonths: ["24"],
    llcAgeMonths: ["12"],
    hasLLC: ["true"]
  };

  const result = sanitizeFormFields(fields);
  assert.equal(result.ok, true);
  assert.equal(result.sanitized.email, "test@example.com");
  assert.equal(result.sanitized.phone, "1234567890");
  assert.equal(result.sanitized.deviceId, "device-123");
  assert.equal(result.sanitized.refId, "ref_abc");
  assert.equal(result.sanitized.businessAgeMonths, 24);
  assert.equal(result.sanitized.llcAgeMonths, 12);
  assert.equal(result.sanitized.hasLLC, true);
  assert.equal(result.errors.length, 0);
});

test("sanitizeFormFields handles non-array field values", () => {
  const fields = {
    email: "test@example.com",
    phone: "1234567890"
  };

  const result = sanitizeFormFields(fields);
  assert.equal(result.ok, true);
  assert.equal(result.sanitized.email, "test@example.com");
  assert.equal(result.sanitized.phone, "1234567890");
});

test("sanitizeFormFields detects invalid email", () => {
  const fields = {
    email: ["not-an-email"]
  };

  const result = sanitizeFormFields(fields);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].field, "email");
});

test("sanitizeFormFields detects invalid phone", () => {
  const fields = {
    phone: ["123"] // Too short
  };

  const result = sanitizeFormFields(fields);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].field, "phone");
});

test("sanitizeFormFields detects invalid businessAgeMonths", () => {
  const fields = {
    businessAgeMonths: ["9999"] // Too large
  };

  const result = sanitizeFormFields(fields);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].field, "businessAgeMonths");
});

test("sanitizeFormFields handles multiple errors", () => {
  const fields = {
    email: ["not-an-email"],
    phone: ["123"],
    businessAgeMonths: ["9999"]
  };

  const result = sanitizeFormFields(fields);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
});

test("sanitizeFormFields handles empty fields", () => {
  const fields = {};

  const result = sanitizeFormFields(fields);
  assert.equal(result.ok, true);
  assert.equal(result.sanitized.email, null);
  assert.equal(result.sanitized.phone, null);
  assert.equal(result.errors.length, 0);
});
