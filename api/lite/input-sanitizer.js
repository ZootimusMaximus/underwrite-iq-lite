// ============================================================================
// UnderwriteIQ Lite — Input Sanitizer
// ============================================================================
// Sanitizes and validates all user input from forms and POST requests
// Prevents XSS, injection attacks, and malformed data
//
// RESPONSIBILITIES:
//   ✔ Sanitize string inputs (remove dangerous characters)
//   ✔ Validate email format
//   ✔ Validate phone format (digits only)
//   ✔ Validate numeric fields (age, months, etc.)
//   ✔ Validate boolean fields
//   ✔ Enforce length limits
//   ✔ Provide clear error messages
// ============================================================================

const { logWarn } = require("./logger");

// Maximum field lengths (prevent DoS via large inputs)
const MAX_EMAIL_LENGTH = 254; // RFC 5321
const MAX_PHONE_LENGTH = 20;
const MAX_DEVICE_ID_LENGTH = 100;
const MAX_REF_ID_LENGTH = 100;
const MAX_GENERAL_STRING_LENGTH = 500;

// Reasonable business age limits
const MAX_BUSINESS_AGE_MONTHS = 1200; // 100 years
const MIN_BUSINESS_AGE_MONTHS = 0;

/**
 * Strip HTML tags and dangerous characters from string
 * Prevents XSS attacks
 */
function stripHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/<[^>]*>/g, "") // Remove HTML tags
    .replace(/[<>'"]/g, "") // Remove quotes and angle brackets
    .trim();
}

/**
 * Validate and sanitize email address
 * @param {string} email - Email address to validate
 * @returns {{ok: boolean, value: string|null, error: string|null}}
 */
function sanitizeEmail(email) {
  if (!email || typeof email !== "string") {
    return { ok: true, value: null, error: null };
  }

  const cleaned = stripHtml(email).toLowerCase().trim();

  // Check length
  if (cleaned.length > MAX_EMAIL_LENGTH) {
    return {
      ok: false,
      value: null,
      error: `Email address is too long (max ${MAX_EMAIL_LENGTH} characters)`
    };
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleaned)) {
    return {
      ok: false,
      value: null,
      error: "Invalid email format"
    };
  }

  return { ok: true, value: cleaned, error: null };
}

/**
 * Validate and sanitize phone number (digits only)
 * @param {string} phone - Phone number to validate
 * @returns {{ok: boolean, value: string|null, error: string|null}}
 */
function sanitizePhone(phone) {
  if (!phone || typeof phone !== "string") {
    return { ok: true, value: null, error: null };
  }

  // Extract only digits
  const cleaned = phone.replace(/\D/g, "");

  if (cleaned.length === 0) {
    return { ok: true, value: null, error: null };
  }

  // Check length (minimum 10 digits for US/international)
  if (cleaned.length < 10 || cleaned.length > MAX_PHONE_LENGTH) {
    return {
      ok: false,
      value: null,
      error: `Phone number must be 10-${MAX_PHONE_LENGTH} digits`
    };
  }

  return { ok: true, value: cleaned, error: null };
}

/**
 * Sanitize device ID (alphanumeric + hyphens only)
 * @param {string} deviceId - Device ID to sanitize
 * @returns {{ok: boolean, value: string|null, error: string|null}}
 */
function sanitizeDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== "string") {
    return { ok: true, value: null, error: null };
  }

  // Allow only alphanumeric and hyphens
  const cleaned = deviceId.replace(/[^a-zA-Z0-9-]/g, "").trim();

  if (cleaned.length === 0) {
    return { ok: true, value: null, error: null };
  }

  if (cleaned.length > MAX_DEVICE_ID_LENGTH) {
    return {
      ok: false,
      value: null,
      error: `Device ID is too long (max ${MAX_DEVICE_ID_LENGTH} characters)`
    };
  }

  return { ok: true, value: cleaned, error: null };
}

/**
 * Sanitize reference ID (alphanumeric + hyphens + underscores)
 * @param {string} refId - Reference ID to sanitize
 * @returns {{ok: boolean, value: string|null, error: string|null}}
 */
function sanitizeRefId(refId) {
  if (!refId || typeof refId !== "string") {
    return { ok: true, value: null, error: null };
  }

  // Allow only alphanumeric, hyphens, and underscores
  const cleaned = refId.replace(/[^a-zA-Z0-9-_]/g, "").trim();

  if (cleaned.length === 0) {
    return { ok: true, value: null, error: null };
  }

  if (cleaned.length > MAX_REF_ID_LENGTH) {
    return {
      ok: false,
      value: null,
      error: `Reference ID is too long (max ${MAX_REF_ID_LENGTH} characters)`
    };
  }

  return { ok: true, value: cleaned, error: null };
}

/**
 * Validate and sanitize numeric field (business age, etc.)
 * @param {any} value - Value to validate
 * @param {object} options - Validation options {min, max, fieldName}
 * @returns {{ok: boolean, value: number|null, error: string|null}}
 */
function sanitizeNumber(value, options = {}) {
  const { min = 0, max = Infinity, fieldName = "Value" } = options;

  if (value === null || value === undefined || value === "") {
    return { ok: true, value: null, error: null };
  }

  const num = Number(value);

  if (!Number.isFinite(num)) {
    return {
      ok: false,
      value: null,
      error: `${fieldName} must be a valid number`
    };
  }

  if (num < min || num > max) {
    return {
      ok: false,
      value: null,
      error: `${fieldName} must be between ${min} and ${max}`
    };
  }

  return { ok: true, value: num, error: null };
}

/**
 * Validate boolean field
 * @param {any} value - Value to validate
 * @returns {{ok: boolean, value: boolean|null, error: string|null}}
 */
function sanitizeBoolean(value) {
  if (value === null || value === undefined || value === "") {
    return { ok: true, value: null, error: null };
  }

  if (value === true || value === "true" || value === "1") {
    return { ok: true, value: true, error: null };
  }

  if (value === false || value === "false" || value === "0") {
    return { ok: true, value: false, error: null };
  }

  return {
    ok: false,
    value: null,
    error: "Value must be true or false"
  };
}

/**
 * Sanitize general string field
 * @param {string} str - String to sanitize
 * @param {number} maxLength - Maximum allowed length
 * @returns {{ok: boolean, value: string|null, error: string|null}}
 */
function sanitizeString(str, maxLength = MAX_GENERAL_STRING_LENGTH) {
  if (!str || typeof str !== "string") {
    return { ok: true, value: null, error: null };
  }

  const cleaned = stripHtml(str).trim();

  if (cleaned.length === 0) {
    return { ok: true, value: null, error: null };
  }

  if (cleaned.length > maxLength) {
    return {
      ok: false,
      value: null,
      error: `String is too long (max ${maxLength} characters)`
    };
  }

  return { ok: true, value: cleaned, error: null };
}

/**
 * Sanitize all form fields from switchboard
 * @param {object} fields - Raw form fields from formidable
 * @returns {{ok: boolean, sanitized: object, errors: array}}
 */
function sanitizeFormFields(fields) {
  const errors = [];
  const sanitized = {};

  // Helper to get field value (formidable returns arrays)
  function getFieldValue(key) {
    if (!fields || fields[key] == null) return null;
    const raw = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
    if (typeof raw === "string") return raw;
    if (raw == null) return null;
    return String(raw);
  }

  // Sanitize email
  const emailResult = sanitizeEmail(getFieldValue("email"));
  if (!emailResult.ok) {
    errors.push({ field: "email", error: emailResult.error });
  } else {
    sanitized.email = emailResult.value;
  }

  // Sanitize phone
  const phoneResult = sanitizePhone(getFieldValue("phone"));
  if (!phoneResult.ok) {
    errors.push({ field: "phone", error: phoneResult.error });
  } else {
    sanitized.phone = phoneResult.value;
  }

  // Sanitize deviceId
  const deviceIdResult = sanitizeDeviceId(getFieldValue("deviceId"));
  if (!deviceIdResult.ok) {
    errors.push({ field: "deviceId", error: deviceIdResult.error });
  } else {
    sanitized.deviceId = deviceIdResult.value;
  }

  // Sanitize refId
  const refIdResult = sanitizeRefId(getFieldValue("refId"));
  if (!refIdResult.ok) {
    errors.push({ field: "refId", error: refIdResult.error });
  } else {
    sanitized.refId = refIdResult.value;
  }

  // Sanitize businessAgeMonths
  const businessAgeResult = sanitizeNumber(getFieldValue("businessAgeMonths"), {
    min: MIN_BUSINESS_AGE_MONTHS,
    max: MAX_BUSINESS_AGE_MONTHS,
    fieldName: "Business age"
  });
  if (!businessAgeResult.ok) {
    errors.push({ field: "businessAgeMonths", error: businessAgeResult.error });
  } else {
    sanitized.businessAgeMonths = businessAgeResult.value;
  }

  // Sanitize llcAgeMonths
  const llcAgeResult = sanitizeNumber(getFieldValue("llcAgeMonths"), {
    min: MIN_BUSINESS_AGE_MONTHS,
    max: MAX_BUSINESS_AGE_MONTHS,
    fieldName: "LLC age"
  });
  if (!llcAgeResult.ok) {
    errors.push({ field: "llcAgeMonths", error: llcAgeResult.error });
  } else {
    sanitized.llcAgeMonths = llcAgeResult.value;
  }

  // Sanitize hasLLC
  const hasLLCResult = sanitizeBoolean(getFieldValue("hasLLC"));
  if (!hasLLCResult.ok) {
    errors.push({ field: "hasLLC", error: hasLLCResult.error });
  } else {
    sanitized.hasLLC = hasLLCResult.value;
  }

  // Log warnings for sanitization errors
  if (errors.length > 0) {
    logWarn("Input sanitization errors detected", { errors });
  }

  return {
    ok: errors.length === 0,
    sanitized,
    errors
  };
}

module.exports = {
  sanitizeEmail,
  sanitizePhone,
  sanitizeDeviceId,
  sanitizeRefId,
  sanitizeNumber,
  sanitizeBoolean,
  sanitizeString,
  sanitizeFormFields,
  stripHtml
};
