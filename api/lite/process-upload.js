// ============================================================================
// Process Upload - Async processing logic for blob uploads
// ============================================================================

const { downloadBlob, deleteBlob } = require("./storage");
const { validateIdentity } = require("./validate-identity");
const { computeUnderwrite } = require("./underwriter");
const { buildSuggestions } = require("./suggestions");
const { createOrUpdateContact, parseFullName } = require("./ghl-contact-service");
const { deliverLettersAsync } = require("./letter-delivery");
const { TTL_SECONDS } = require("./dedupe-store");
const { getJob, updateJobProgress, completeJob, failJob } = require("./job-store");
const { logInfo, logWarn, logError } = require("./logger");
const { parseBuffer } = require("./parse-report");

// Min file size for valid PDF
const MIN_PDF_BYTES = 40 * 1024;

// Processing timeout (5 minutes)
const PROCESSING_TIMEOUT = 5 * 60 * 1000;

/**
 * Custom error class with user-friendly message and error code
 */
class ProcessingError extends Error {
  constructor(message, code, userMessage = null) {
    super(message);
    this.code = code;
    this.userMessage = userMessage || message;
    this.name = "ProcessingError";
  }
}

/**
 * Safe number helper
 */
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Format suggestions for response
 */
function formatSuggestions(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item, idx) => {
    if (typeof item === "string") {
      return { title: `Action ${idx + 1}`, description: item };
    }
    if (item && typeof item === "object") return item;
    return { title: `Action ${idx + 1}`, description: String(item || "") };
  });
}

/**
 * Call parse-report directly (bypasses HTTP to avoid payload size limits)
 */
async function callParseReport(buffer, filename) {
  // Direct function call instead of HTTP - avoids Vercel's 4.5MB payload limit
  const result = await parseBuffer(buffer, filename);

  if (!result.ok) {
    throw new ProcessingError(
      result.reason || "Parse failed",
      "PARSE_FAILED",
      "We couldn't read this credit report. Please try a different file."
    );
  }

  return result;
}

/**
 * Detect which bureaus exist in a parsed result
 */
function detectBureauCodes(parsed) {
  const out = [];
  if (!parsed || !parsed.bureaus) return out;

  const b = parsed.bureaus;
  if (b.experian) out.push("EX");
  if (b.equifax) out.push("EQ");
  if (b.transunion) out.push("TU");

  return out;
}

/**
 * Merge bureaus from parsed result (single PDF support for MVP)
 */
function mergeBureaus(parsed) {
  if (!parsed || !parsed.ok || !parsed.bureaus) {
    const reason = parsed?.reason || "The report could not be parsed.";
    throw new ProcessingError(reason, "PARSE_FAILED", reason);
  }

  const codes = detectBureauCodes(parsed);
  if (codes.length === 0) {
    throw new ProcessingError(
      "No recognizable bureau sections found",
      "INVALID_PDF",
      "This doesn't appear to be a valid credit report PDF. Please upload an Experian, Equifax, or TransUnion report."
    );
  }

  return parsed.bureaus;
}

/**
 * Build redirect object from underwrite results
 */
function buildRedirect(uw, metadata) {
  const p = uw.personal || {};
  const b = uw.business || {};
  const t = uw.totals || {};
  const m = uw.metrics || {};
  const inq = m.inquiries || {};

  const query = {
    personalTotal: safeNum(p.total_personal_funding),
    businessTotal: safeNum(b.business_funding),
    totalCombined: safeNum(t.total_combined_funding),
    score: safeNum(m.score),
    util: safeNum(m.utilization_pct),
    inqEx: safeNum(inq.ex),
    inqTu: safeNum(inq.tu),
    inqEq: safeNum(inq.eq),
    neg: safeNum(m.negative_accounts),
    late: safeNum(m.late_payment_events)
  };

  const baseUrl = uw.fundable
    ? process.env.REDIRECT_URL_FUNDABLE || "https://fundhub.ai/funding-approved-analyzer-462533"
    : process.env.REDIRECT_URL_NOT_FUNDABLE || "https://fundhub.ai/fix-my-credit-analyzer";

  const qs = new URLSearchParams(query).toString();
  const resultUrl = baseUrl + (qs ? "?" + qs : "");

  const refId =
    metadata.refId || `ref-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

  const nowIso = new Date().toISOString();
  const daysRemaining = Math.max(0, Math.ceil(TTL_SECONDS / (60 * 60 * 24)));

  return {
    path: uw.fundable ? "funding" : "repair",
    resultType: uw.fundable ? "funding" : "repair",
    resultUrl,
    url: resultUrl,
    query,
    lastUpload: nowIso,
    daysRemaining,
    refId,
    affiliateLink: `${process.env.REDIRECT_BASE_URL || "https://fundhub.ai"}/credit-analyzer.html?ref=${encodeURIComponent(refId)}`
  };
}

/**
 * Main processing function
 */
async function processUpload(jobId, blobUrl) {
  let buffer = null;

  try {
    // 1. Get job metadata
    const job = await getJob(jobId);
    if (!job) {
      throw new ProcessingError(
        "Job not found",
        "JOB_NOT_FOUND",
        "Session expired. Please start over."
      );
    }

    const metadata = job.metadata || {};
    logInfo("Processing started", { jobId, email: metadata.email });

    // 2. Download PDF from blob
    await updateJobProgress(jobId, "Downloading file...");
    buffer = await downloadBlob(blobUrl);

    if (!buffer || buffer.length < MIN_PDF_BYTES) {
      throw new ProcessingError(
        `PDF too small: ${buffer?.length || 0} bytes`,
        "PDF_TOO_SMALL",
        "This PDF appears incomplete or corrupt. Please upload a complete credit report."
      );
    }

    logInfo("PDF downloaded", { jobId, size: buffer.length });

    // 3. Parse with AI
    await updateJobProgress(jobId, "Analyzing credit report...");
    const parsed = await callParseReport(buffer, "report.pdf");

    if (!parsed.ok) {
      throw new ProcessingError(
        parsed.reason || "Parse failed",
        "PARSE_FAILED",
        parsed.reason || "We couldn't read this credit report. Please try a different file."
      );
    }

    logInfo("PDF parsed", { jobId, bureaus: detectBureauCodes(parsed) });

    // 4. Merge bureaus
    const mergedBureaus = mergeBureaus(parsed);

    // 5. Identity validation (name match + report recency)
    await updateJobProgress(jobId, "Validating report...");
    const identityCheck = validateIdentity(metadata.name, mergedBureaus);

    if (!identityCheck.ok) {
      throw new ProcessingError(
        identityCheck.reason,
        identityCheck.errors?.[0]?.code || "IDENTITY_MISMATCH",
        identityCheck.reason
      );
    }

    logInfo("Identity validated", { jobId });

    // 6. Underwrite
    await updateJobProgress(jobId, "Running analysis...");
    const businessAgeMonths = metadata.businessAgeMonths || 0;
    const uw = computeUnderwrite(mergedBureaus, businessAgeMonths);

    logInfo("Underwriting complete", {
      jobId,
      fundable: uw.fundable,
      score: uw.metrics?.score
    });

    // 7. Build suggestions
    const suggestions = buildSuggestions(uw, {
      hasLLC: metadata.hasLLC === true,
      llcAgeMonths: metadata.llcAgeMonths || 0
    });

    // 8. Build redirect object
    const redirect = buildRedirect(uw, metadata);
    redirect.suggestions = formatSuggestions(suggestions);

    // 9. GHL Contact + Letter delivery
    await updateJobProgress(jobId, "Updating your profile...");

    const { firstName, lastName } = parseFullName(metadata.name);
    const ghlContactData = {
      firstName,
      lastName,
      email: metadata.email,
      phone: metadata.phone,
      businessName: metadata.businessName,
      businessAgeMonths: metadata.businessAgeMonths || 0,
      resultType: uw.fundable ? "funding_approved" : "credit_repair",
      creditScore: uw.metrics?.score || 0,
      totalFunding: uw.totals?.total_combined_funding || 0,
      refId: redirect.refId
    };

    let contactId = null;
    if (metadata.email) {
      const contactResult = await createOrUpdateContact(ghlContactData);
      if (contactResult.ok) {
        contactId = contactResult.contactId;
        logInfo("GHL contact ready", { jobId, contactId });
      } else {
        logWarn("GHL contact creation failed", { jobId, error: contactResult.error });
      }
    }

    // Deliver letters async (fire-and-forget)
    await updateJobProgress(jobId, "Generating letters...");
    deliverLettersAsync({
      contactId,
      contactData: ghlContactData,
      bureaus: mergedBureaus,
      underwrite: uw,
      personal: {
        name: metadata.name || `${firstName} ${lastName}`.trim(),
        address: null
      }
    });

    logInfo("Letter delivery initiated", { jobId });

    // 10. Complete job with result
    const result = {
      redirect,
      underwrite: uw,
      bureaus: mergedBureaus,
      suggestions
    };

    await completeJob(jobId, result);
    logInfo("Job completed successfully", { jobId, path: redirect.path });
  } catch (err) {
    logError("Processing failed", {
      jobId,
      error: err.message,
      code: err.code,
      stack: err.stack
    });

    await failJob(jobId, {
      message: err.userMessage || err.message || "Processing failed",
      code: err.code || "SYSTEM_ERROR"
    });
  } finally {
    // 11. Cleanup blob (always, even on error)
    if (blobUrl) {
      try {
        await deleteBlob(blobUrl);
        logInfo("Blob cleaned up", { jobId });
      } catch (cleanupErr) {
        logWarn("Blob cleanup failed", { jobId, error: cleanupErr.message });
      }
    }
  }
}

/**
 * Async wrapper with timeout protection
 * Fire-and-forget - doesn't wait for completion
 */
function processUploadAsync(jobId, blobUrl) {
  // Wrap in timeout
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () =>
        reject(
          new ProcessingError(
            "Processing timeout",
            "TIMEOUT",
            "Processing took too long. Please try again."
          )
        ),
      PROCESSING_TIMEOUT
    )
  );

  // Race processing against timeout
  Promise.race([processUpload(jobId, blobUrl), timeoutPromise]).catch(async err => {
    logError("Async processing error", { jobId, error: err.message });

    // Mark job as failed if timeout
    if (err.code === "TIMEOUT") {
      await failJob(jobId, {
        message: "Processing took too long. Please try again.",
        code: "TIMEOUT"
      });
    }
  });
}

module.exports = {
  processUpload,
  processUploadAsync,
  ProcessingError
};
