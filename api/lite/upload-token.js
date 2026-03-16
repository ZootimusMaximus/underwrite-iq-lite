// ============================================================================
// Upload Token Endpoint - Creates job and returns jobId for blob upload
// POST /api/lite/upload-token
// ============================================================================

const { rateLimitMiddleware } = require("./rate-limiter");
const {
  sanitizeEmail,
  sanitizePhone,
  sanitizeDeviceId,
  sanitizeRefId,
  sanitizeNumber,
  sanitizeBoolean,
  sanitizeString
} = require("./input-sanitizer");
const {
  generateJobId,
  createJob,
  findActiveJobByEmail,
  acquireUploadLock,
  releaseUploadLock
} = require("./job-store");
const { logInfo, logWarn, logError } = require("./logger");

// Max business age (100 years in months)
const MAX_BUSINESS_AGE_MONTHS = 1200;

/**
 * Sanitize JSON body fields (similar to sanitizeFormFields but for JSON)
 */
function sanitizeJsonBody(body) {
  const errors = [];
  const sanitized = {};

  // Sanitize email (required for job tracking)
  const emailResult = sanitizeEmail(body.email);
  if (!emailResult.ok) {
    errors.push({ field: "email", error: emailResult.error });
  } else {
    sanitized.email = emailResult.value;
  }

  // Sanitize phone
  const phoneResult = sanitizePhone(body.phone);
  if (!phoneResult.ok) {
    errors.push({ field: "phone", error: phoneResult.error });
  } else {
    sanitized.phone = phoneResult.value;
  }

  // Sanitize deviceId
  const deviceIdResult = sanitizeDeviceId(body.deviceId);
  if (!deviceIdResult.ok) {
    errors.push({ field: "deviceId", error: deviceIdResult.error });
  } else {
    sanitized.deviceId = deviceIdResult.value;
  }

  // Sanitize refId
  const refIdResult = sanitizeRefId(body.refId);
  if (!refIdResult.ok) {
    errors.push({ field: "refId", error: refIdResult.error });
  } else {
    sanitized.refId = refIdResult.value;
  }

  // Sanitize name
  const nameResult = sanitizeString(body.name, 200);
  if (!nameResult.ok) {
    errors.push({ field: "name", error: nameResult.error });
  } else {
    sanitized.name = nameResult.value;
  }

  // Sanitize businessName
  const businessNameResult = sanitizeString(body.businessName, 200);
  if (!businessNameResult.ok) {
    errors.push({ field: "businessName", error: businessNameResult.error });
  } else {
    sanitized.businessName = businessNameResult.value;
  }

  // Sanitize businessAgeMonths
  const businessAgeResult = sanitizeNumber(body.businessAgeMonths, {
    min: 0,
    max: MAX_BUSINESS_AGE_MONTHS,
    fieldName: "Business age"
  });
  if (!businessAgeResult.ok) {
    errors.push({ field: "businessAgeMonths", error: businessAgeResult.error });
  } else {
    sanitized.businessAgeMonths = businessAgeResult.value;
  }

  // Sanitize llcAgeMonths
  const llcAgeResult = sanitizeNumber(body.llcAgeMonths, {
    min: 0,
    max: MAX_BUSINESS_AGE_MONTHS,
    fieldName: "LLC age"
  });
  if (!llcAgeResult.ok) {
    errors.push({ field: "llcAgeMonths", error: llcAgeResult.error });
  } else {
    sanitized.llcAgeMonths = llcAgeResult.value;
  }

  // Sanitize hasLLC
  const hasLLCResult = sanitizeBoolean(body.hasLLC);
  if (!hasLLCResult.ok) {
    errors.push({ field: "hasLLC", error: hasLLCResult.error });
  } else {
    sanitized.hasLLC = hasLLCResult.value;
  }

  // forceReprocess flag
  sanitized.forceReprocess = body.forceReprocess === true;

  if (errors.length > 0) {
    logWarn("Input sanitization errors", { errors });
  }

  return {
    ok: errors.length === 0,
    sanitized,
    errors
  };
}

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only POST allowed
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
      code: "METHOD_NOT_ALLOWED"
    });
  }

  try {
    // Rate limiting
    const allowed = await rateLimitMiddleware(req, res);
    if (!allowed) return; // Response already sent

    // Parse JSON body
    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    } catch {
      return res.status(400).json({
        ok: false,
        error: "Invalid JSON body",
        code: "INVALID_JSON"
      });
    }

    // Sanitize inputs
    const { ok: sanitizeOk, sanitized, errors: sanitizeErrors } = sanitizeJsonBody(body);
    if (!sanitizeOk) {
      return res.status(400).json({
        ok: false,
        error: sanitizeErrors[0]?.error || "Invalid input",
        code: "VALIDATION_ERROR",
        details: sanitizeErrors
      });
    }

    // Email is required for job tracking
    if (!sanitized.email) {
      return res.status(400).json({
        ok: false,
        error: "Email is required",
        code: "EMAIL_REQUIRED"
      });
    }

    // Check for existing active job (resume functionality)
    const existingJob = await findActiveJobByEmail(sanitized.email);
    if (existingJob) {
      logInfo("Resuming existing job", {
        jobId: existingJob.jobId,
        status: existingJob.status,
        email: sanitized.email
      });

      return res.status(200).json({
        ok: true,
        jobId: existingJob.jobId,
        resumed: true,
        status: existingJob.status
      });
    }

    // Acquire upload lock to prevent concurrent uploads
    const lockAcquired = await acquireUploadLock(sanitized.email);
    if (!lockAcquired) {
      return res.status(409).json({
        ok: false,
        error: "Another upload is in progress. Please wait.",
        code: "CONCURRENT_UPLOAD"
      });
    }

    // Generate job ID and create job
    const jobId = generateJobId();
    const job = await createJob(jobId, sanitized);

    // Release lock after job created
    await releaseUploadLock(sanitized.email);

    if (!job) {
      return res.status(500).json({
        ok: false,
        error: "Failed to create upload session. Please try again.",
        code: "JOB_CREATE_FAILED"
      });
    }

    logInfo("Upload token created", {
      jobId,
      email: sanitized.email,
      name: sanitized.name
    });

    return res.status(200).json({
      ok: true,
      jobId,
      resumed: false
    });
  } catch (err) {
    logError("Upload token error", { error: err.message, stack: err.stack });

    return res.status(500).json({
      ok: false,
      error: "Something went wrong. Please try again.",
      code: "SYSTEM_ERROR"
    });
  }
};
