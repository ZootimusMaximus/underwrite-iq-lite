// ============================================================================
// UnderwriteIQ — SWITCHBOARD (Stage 2: Validation + Merge + Underwrite + Suggestions)
// ============================================================================

const fs = require("fs");
const crypto = require("crypto");
const formidable = require("formidable");

const { validateConfig } = require("./config-validator");
const { validateReports } = require("./validate-reports");
const { validateIdentity } = require("./validate-identity");
const { computeUnderwrite } = require("./underwriter");
const { aiGateCheck } = require("./ai-gatekeeper");
const {
  buildDedupeKeys,
  createRedisClient,
  checkDedupe,
  storeRedirect,
  TTL_SECONDS
} = require("./dedupe-store");

// 🔥 NEW — modular suggestion engine
const { buildSuggestions } = require("./suggestions");

// Rate limiting
const { rateLimitMiddleware } = require("./rate-limiter");

// Input sanitization
const { sanitizeFormFields } = require("./input-sanitizer");

// Logging
const { logError, logWarn, logInfo } = require("./logger");

// GHL Contact Service
const { createOrUpdateContact, parseFullName } = require("./ghl-contact-service");

// Letter Delivery Service (deliverLetters is required inline to avoid circular deps)

// Helper to clean up temp files (prevents /tmp from filling up)
async function cleanupTempFiles(files) {
  if (!files || !Array.isArray(files)) return;
  for (const f of files) {
    if (f?.filepath) {
      try {
        await fs.promises.unlink(f.filepath);
      } catch (err) {
        // Ignore cleanup errors (file may already be deleted)
      }
    }
  }
}

// Validate configuration on module load
try {
  validateConfig();
} catch (err) {
  logError("Configuration validation failed", err);
  // Allow module to load but will fail on first request
}

// Parser endpoint
const PARSE_ENDPOINT =
  process.env.PARSE_ENDPOINT || "https://underwrite-iq-lite.vercel.app/api/lite/parse-report";

const MIN_PDF_BYTES = 40 * 1024;
// Max 10MB per file to prevent memory exhaustion (base64 adds 33% overhead)
const MAX_SAFE_FILE_SIZE = 10 * 1024 * 1024;
// Max 30MB total across all files
const MAX_TOTAL_FILE_SIZE = 30 * 1024 * 1024;
const AFFILIATE_ENABLED = process.env.AFFILIATE_DASHBOARD_ENABLED === "true";
const IDENTITY_ENABLED = process.env.IDENTITY_VERIFICATION_ENABLED !== "false";
// Skip AI gatekeeper for faster processing (set to "true" to skip)
const SKIP_GATEKEEPER = process.env.SKIP_AI_GATEKEEPER === "true";

// Safe number helper
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

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

// ----------------------------------------------------------------------------
// Call parse-report for a single PDF buffer
// ----------------------------------------------------------------------------
async function callParseReport(buffer, filename) {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: "application/pdf" });
  formData.append("file", blob, filename || "report.pdf");

  const resp = await fetch(PARSE_ENDPOINT, {
    method: "POST",
    body: formData
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`parse-report HTTP error: ${resp.status} ${text}`);
  }

  return await resp.json();
}

// ----------------------------------------------------------------------------
// Detect which bureaus exist in a parsed result
// ----------------------------------------------------------------------------
function detectBureauCodes(parsed) {
  const out = [];
  if (!parsed || !parsed.bureaus) return out;

  const b = parsed.bureaus;
  if (b.experian) out.push("EX");
  if (b.equifax) out.push("EQ");
  if (b.transunion) out.push("TU");

  return out;
}

// ----------------------------------------------------------------------------
// Merge bureaus from multiple parsed results, enforcing "no duplicates"
// ----------------------------------------------------------------------------
function mergeBureausOrThrow(parsedResults) {
  const final = { experian: null, equifax: null, transunion: null };
  const seen = { EX: false, EQ: false, TU: false };

  for (const parsed of parsedResults) {
    if (!parsed || !parsed.ok || !parsed.bureaus) {
      // Pass through the actual error reason from parse-report
      const reason = parsed?.reason || "One of the reports could not be parsed.";
      throw new Error(reason);
    }

    const codes = detectBureauCodes(parsed);
    const b = parsed.bureaus;

    if (codes.length === 0) {
      throw new Error(
        "One uploaded PDF has no recognizable Experian, Equifax, or TransUnion sections."
      );
    }

    for (const code of codes) {
      if (code === "EX") {
        if (seen.EX) throw new Error("Duplicate Experian detected.");
        seen.EX = true;
        final.experian = b.experian;
      }
      if (code === "EQ") {
        if (seen.EQ) throw new Error("Duplicate Equifax detected.");
        seen.EQ = true;
        final.equifax = b.equifax;
      }
      if (code === "TU") {
        if (seen.TU) throw new Error("Duplicate TransUnion detected.");
        seen.TU = true;
        final.transunion = b.transunion;
      }
    }
  }

  if (!final.experian && !final.equifax && !final.transunion) {
    throw new Error("No valid bureaus found.");
  }

  return final;
}

// ----------------------------------------------------------------------------
// Build cards (tags only — used by front-end)
// ----------------------------------------------------------------------------
function buildCards(uw) {
  const cards = [];
  const o = uw.optimization || {};
  const m = uw.metrics || {};

  if (o.needs_util_reduction) cards.push("util_high");
  if (o.needs_new_primary_revolving) cards.push("needs_revolving");
  if (o.needs_inquiry_cleanup) cards.push("inquiries");
  if (o.needs_negative_cleanup) cards.push("negatives");
  if (o.needs_file_buildout) cards.push("file_buildout");

  if (!uw.fundable && (m.score || 0) >= 680) {
    cards.push("near_approval");
  }

  return cards;
}

// ----------------------------------------------------------------------------
// MAIN HANDLER
// ----------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  try {
    logInfo("Switchboard request", { method: req.method });

    // ----- CORS -----
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, msg: "Method not allowed" });
    }

    // ----- Rate limiting -----
    const rateLimitAllowed = await rateLimitMiddleware(req, res);
    if (!rateLimitAllowed) {
      return; // Response already sent by middleware
    }

    // ----- Parse multipart -----
    const form = formidable({
      multiples: true,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { files, fields } = await new Promise((resolve, reject) =>
      form.parse(req, (err, flds, fls) =>
        err ? reject(err) : resolve({ fields: flds, files: fls })
      )
    );

    // ----- Input sanitization -----
    const sanitizationResult = sanitizeFormFields(fields);
    if (!sanitizationResult.ok) {
      const errorMessages = sanitizationResult.errors.map(e => `${e.field}: ${e.error}`).join(", ");
      return res.status(200).json({
        ok: false,
        msg: `Invalid input: ${errorMessages}`
      });
    }

    // Use sanitized values from this point forward
    const sanitized = sanitizationResult.sanitized;

    // Check for forceReprocess flag (for testing - skips deduplication)
    const forceReprocess = !!sanitized.forceReprocess;

    const dedupeClient = createRedisClient();
    const dedupeKeys = buildDedupeKeys({
      email: sanitized.email,
      phone: sanitized.phone,
      deviceId: sanitized.deviceId,
      refId: sanitized.refId
    });

    if (!AFFILIATE_ENABLED) {
      dedupeKeys.refKey = null;
      dedupeKeys.refId = null;
    }

    // Skip deduplication if forceReprocess is set
    if (
      !forceReprocess &&
      dedupeClient &&
      (dedupeKeys.userKey || dedupeKeys.deviceKey || dedupeKeys.refKey)
    ) {
      const cached = await checkDedupe(dedupeClient, dedupeKeys);
      if (cached?.redirect) {
        return res.status(200).json({ ok: true, redirect: cached.redirect, deduped: true });
      }
    }

    const rawFiles = files?.file;
    const fileList = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];

    // ----- Stage 1: structural validation -----
    const validation = await validateReports(fileList);
    if (!validation.ok) {
      await cleanupTempFiles(fileList);
      return res.status(200).json({ ok: false, msg: validation.reason });
    }

    const validatedFiles = validation.files || fileList;
    if (!validatedFiles.length) {
      await cleanupTempFiles(fileList);
      return res.status(200).json({ ok: false, msg: "No valid PDFs." });
    }

    // ----- Memory safety: validate total file size -----
    let totalFileSize = 0;
    for (const f of validatedFiles) {
      const fileSize = f.size || 0;
      if (fileSize > MAX_SAFE_FILE_SIZE) {
        await cleanupTempFiles(validatedFiles);
        return res.status(200).json({
          ok: false,
          msg: `File "${f.originalFilename || "unknown"}" is too large. Maximum size is 10MB per file.`
        });
      }
      totalFileSize += fileSize;
    }
    if (totalFileSize > MAX_TOTAL_FILE_SIZE) {
      await cleanupTempFiles(validatedFiles);
      return res.status(200).json({
        ok: false,
        msg: "Total upload size exceeds 30MB limit. Please upload smaller files."
      });
    }

    // ----- Stage 1b: AI gatekeeper + Stage 2: GPT parse -----
    const parsedResults = [];
    for (const f of validatedFiles) {
      let buf;
      try {
        buf = await fs.promises.readFile(f.filepath);
      } catch (readErr) {
        logError("Failed to read uploaded file", readErr, { filepath: f.filepath });
        await cleanupTempFiles(validatedFiles);
        return res.status(200).json({
          ok: false,
          msg: "Failed to read uploaded file."
        });
      }

      if (!buf || buf.length < MIN_PDF_BYTES) {
        await cleanupTempFiles(validatedFiles);
        return res.status(200).json({
          ok: false,
          msg: "This PDF appears incomplete or corrupted. Please download a fresh copy of your credit report and try again."
        });
      }

      // === Parse caching: check cache before expensive AI parsing ===
      const pdfHash = crypto.createHash("sha256").update(buf).digest("hex");
      const cacheKey = `uwiq:parse:${pdfHash}`;

      if (dedupeClient) {
        try {
          const cached = await dedupeClient.get(cacheKey);
          if (cached) {
            logInfo("Cache hit for PDF", {
              filename: f.originalFilename,
              hash: pdfHash.substring(0, 8)
            });
            parsedResults.push(JSON.parse(cached));
            continue; // Skip AI parsing entirely!
          }
        } catch (cacheErr) {
          logWarn("Cache check failed", { error: cacheErr.message });
          // Continue to parse normally
        }
      }

      // AI Gatekeeper - skip for speed if SKIP_AI_GATEKEEPER=true
      if (IDENTITY_ENABLED && !SKIP_GATEKEEPER) {
        try {
          const gate = await aiGateCheck(buf, f.originalFilename);
          if (!gate.ok) {
            await cleanupTempFiles(validatedFiles);
            return res.status(200).json({ ok: false, msg: gate.reason });
          }
        } catch (gateErr) {
          logError("AI gatekeeper failed", gateErr, { filename: f.originalFilename });
          await cleanupTempFiles(validatedFiles);
          return res.status(200).json({
            ok: false,
            msg: "We couldn't verify this document as a credit report. Please upload a PDF credit report from Experian, TransUnion, or Equifax."
          });
        }
      }

      // ----- Stage 2: expensive GPT parse -----
      // Wrap in try-catch to ensure temp file cleanup on failure
      try {
        const parsed = await callParseReport(buf, f.originalFilename);

        // Log if parse-report returned ok:false for debugging
        if (!parsed.ok) {
          logWarn("parse-report returned ok:false", {
            filename: f.originalFilename,
            reason: parsed.reason,
            hasBureaus: !!parsed.bureaus
          });
        }

        // === Cache successful parse for 24 hours ===
        if (dedupeClient && parsed.ok) {
          try {
            await dedupeClient.set(cacheKey, JSON.stringify(parsed), { ex: 86400 }); // 24h TTL
            logInfo("Cached parse result", { hash: pdfHash.substring(0, 8) });
          } catch (cacheErr) {
            logWarn("Cache write failed", { error: cacheErr.message });
          }
        }

        parsedResults.push(parsed);
      } catch (parseErr) {
        logError("GPT parse failed for file", parseErr, {
          filename: f.originalFilename,
          fileSize: buf.length
        });
        await cleanupTempFiles(validatedFiles);
        return res.status(200).json({
          ok: false,
          msg: "We couldn't process this credit report. Please ensure you're uploading a standard PDF credit report (not a screenshot or photo) and try again."
        });
      }
    }

    // ----- Stage 3: bureau merge -----
    let mergedBureaus;
    try {
      mergedBureaus = mergeBureausOrThrow(parsedResults);
    } catch (err) {
      await cleanupTempFiles(validatedFiles);
      return res.status(200).json({ ok: false, msg: err.message });
    }

    // ----- Stage 3b: identity validation (name match + report recency) -----
    const identityCheck = validateIdentity(sanitized.name, mergedBureaus);
    if (!identityCheck.ok) {
      await cleanupTempFiles(validatedFiles);
      logWarn("Identity validation failed", {
        name: sanitized.name,
        errors: identityCheck.errors
      });
      return res.status(200).json({ ok: false, msg: identityCheck.reason });
    }

    // ----- Stage 4: underwriting -----
    const businessAgeMonths = sanitized.businessAgeMonths || 0;
    const uw = computeUnderwrite(mergedBureaus, businessAgeMonths);

    const p = uw.personal || {};
    const b = uw.business || {};
    const t = uw.totals || {};
    const m = uw.metrics || {};
    const inq = m.inquiries || {};

    // ----- Stage 5: modular suggestions -----
    const suggestions = buildSuggestions(uw, {
      hasLLC: sanitized.hasLLC === true,
      llcAgeMonths: sanitized.llcAgeMonths || 0
    });

    const cards = buildCards(uw);

    // ----- Stage 6: redirect query -----
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

    // ----- Stage 7: redirect -----
    const baseUrl = uw.fundable
      ? process.env.REDIRECT_URL_FUNDABLE || "https://fundhub.ai/funding-approved-analyzer-462533"
      : process.env.REDIRECT_URL_NOT_FUNDABLE || "https://fundhub.ai/fix-my-credit-analyzer";

    const qs = new URLSearchParams(query || {}).toString();
    const resultUrl = baseUrl + (qs ? "?" + qs : "");

    const refId =
      dedupeKeys.refId ||
      sanitized.refId ||
      `ref-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

    const suggestionObjects = formatSuggestions(suggestions);
    const nowIso = new Date().toISOString();
    const daysRemaining = Math.max(0, Math.ceil(TTL_SECONDS / (60 * 60 * 24)));

    const redirect = {
      resultType: uw.fundable ? "funding" : "repair",
      resultUrl,
      url: resultUrl,
      query,
      suggestions: suggestionObjects,
      lastUpload: nowIso,
      daysRemaining,
      refId,
      affiliateLink: `${process.env.REDIRECT_BASE_URL || "https://fundhub.ai"}/credit-analyzer.html?ref=${encodeURIComponent(refId)}`
    };

    if (dedupeClient && (dedupeKeys.userKey || dedupeKeys.deviceKey || dedupeKeys.refKey)) {
      try {
        await storeRedirect(dedupeClient, dedupeKeys, redirect);
      } catch (err) {
        logWarn("Failed to store redirect in cache", {
          error: err.message,
          dedupeKeys: Object.keys(dedupeKeys).filter(k => dedupeKeys[k])
        });
      }
    }

    // ----- GHL Contact Creation (async, non-blocking) -----
    const { firstName, lastName } = parseFullName(sanitized.name);
    const ghlContactData = {
      firstName,
      lastName,
      email: sanitized.email,
      phone: sanitized.phone,
      businessName: sanitized.businessName,
      businessAgeMonths: sanitized.businessAgeMonths || 0,
      resultType: uw.fundable ? "funding_approved" : "credit_repair",
      creditScore: m.score || 0,
      totalFunding: t.total_combined_funding || 0,
      refId
    };

    // Letter delivery with GHL integration (blocking to ensure completion)
    logInfo("Starting letter delivery", { fundable: uw.fundable, hasEmail: !!sanitized.email });

    // First create/update GHL contact
    let contactId = null;
    if (sanitized.email) {
      const contactResult = await createOrUpdateContact(ghlContactData);
      if (contactResult.ok) {
        contactId = contactResult.contactId;
        logInfo("GHL contact ready", { contactId });
      } else {
        logWarn("GHL contact creation failed", { error: contactResult.error });
      }
    }

    // Deliver letters async (non-blocking for faster response)
    const { deliverLettersAsync } = require("./letter-delivery");
    deliverLettersAsync({
      contactId,
      contactData: ghlContactData,
      bureaus: mergedBureaus,
      underwrite: uw,
      personal: {
        name: sanitized.name || `${firstName} ${lastName}`.trim(),
        address: null
      }
    });

    logInfo("Letter delivery initiated (async)");

    // ----- Clean up temp files -----
    await cleanupTempFiles(validatedFiles);

    // ----- FINAL RESPONSE -----
    return res.status(200).json({
      ok: true,
      deduped: false,
      parsed: parsedResults,
      bureaus: mergedBureaus,
      underwrite: uw,
      optimization: uw.optimization,
      cards,
      suggestions,
      redirect
    });
  } catch (err) {
    logError("Switchboard fatal error", err, {
      method: req.method,
      path: req.url,
      hasFiles: !!req.files
    });
    return res.status(200).json({
      ok: false,
      msg: "Something went wrong while processing your report. Please try again or upload a different file."
    });
  }
};
