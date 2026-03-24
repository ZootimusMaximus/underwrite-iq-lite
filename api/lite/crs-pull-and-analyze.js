"use strict";

// ============================================================================
// CRS Pull & Analyze — Full Pipeline Endpoint
//
// POST /api/lite/crs-pull-and-analyze
//
// Takes applicant identity → pulls all bureaus via Stitch Credit →
// runs CRS engine → returns full output. This is the "one-call" endpoint
// for operators (e.g., Airtable automation triggers).
// ============================================================================

const { pullFullCRS } = require("./crs/stitch-credit-client");
const { runCRSEngine } = require("./crs/engine");
const { sanitizeFormFields } = require("./input-sanitizer");
const { rateLimitMiddleware } = require("./rate-limiter");
const {
  buildDedupeKeys,
  createRedisClient,
  checkDedupe,
  storeRedirect
} = require("./dedupe-store");
const { parseFullName } = require("./ghl-contact-service");
const { logError, logInfo } = require("./logger");
const { enqueueTask } = require("./background-queue");
const { notifyCRSSnapshotComplete } = require("./ghl-webhook");
const { derivePerBureauMetrics } = require("./crs/airtable-sync");

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  try {
    // ----- CORS -----
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    }

    // ----- Rate limiting -----
    const rateLimitAllowed = await rateLimitMiddleware(req, res);
    if (!rateLimitAllowed) return;

    // ----- Parse body -----
    const body = req.body;
    if (!body) {
      return res.status(400).json({ ok: false, error: "MISSING_BODY" });
    }

    // ----- Validate applicant -----
    const { applicant, business, formData } = body;

    // ----- Validate crs_pull_scope -----
    const VALID_PULL_SCOPES = ["consumer_only", "consumer_plus_ex_business"];
    const crs_pull_scope = body.crs_pull_scope || "consumer_only";
    if (!VALID_PULL_SCOPES.includes(crs_pull_scope)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PULL_SCOPE",
        message: `crs_pull_scope must be one of: ${VALID_PULL_SCOPES.join(", ")}`
      });
    }

    // ----- Validate business identity for consumer_plus_ex_business -----
    if (crs_pull_scope === "consumer_plus_ex_business") {
      const bizRequired = ["name", "city", "state"];
      const bizMissing = bizRequired.filter(f => !business?.[f]);
      if (bizMissing.length > 0) {
        return res.status(400).json({
          ok: false,
          error: "BUSINESS_IDENTITY_MISSING_FOR_REQUESTED_PULL_SCOPE",
          message: `consumer_plus_ex_business requires business identity. Missing: ${bizMissing.join(", ")}`,
          required: bizRequired,
          recommended: ["street", "zip", "phone", "ein"]
        });
      }
    }

    if (!applicant) {
      return res
        .status(400)
        .json({ ok: false, error: "MISSING_APPLICANT", message: "applicant object is required." });
    }

    const required = ["firstName", "lastName", "ssn", "birthDate"];
    const missing = required.filter(f => !applicant[f]);
    if (missing.length > 0) {
      return res.status(400).json({
        ok: false,
        error: "INCOMPLETE_APPLICANT",
        message: `Missing required fields: ${missing.join(", ")}`
      });
    }

    if (
      !applicant.address ||
      !applicant.address.addressLine1 ||
      !applicant.address.city ||
      !applicant.address.state ||
      !applicant.address.postalCode
    ) {
      return res.status(400).json({
        ok: false,
        error: "INCOMPLETE_ADDRESS",
        message: "applicant.address requires addressLine1, city, state, postalCode."
      });
    }

    // SSN format validation (9 digits)
    const ssnClean = String(applicant.ssn).replace(/\D/g, "");
    if (ssnClean.length !== 9) {
      return res
        .status(400)
        .json({ ok: false, error: "INVALID_SSN", message: "SSN must be 9 digits." });
    }
    applicant.ssn = ssnClean;

    // ----- Sanitize form data -----
    const sanitized = {};
    if (formData && typeof formData === "object") {
      const sanResult = sanitizeFormFields(formData);
      if (sanResult.ok) Object.assign(sanitized, sanResult.sanitized);
    }

    const submittedName = `${applicant.firstName} ${applicant.lastName}`.trim();

    // ----- Deduplication -----
    const forceReprocess = !!formData?.forceReprocess;
    const dedupeClient = createRedisClient();
    const dedupeKeys = buildDedupeKeys({
      email: sanitized.email || formData?.email,
      phone: sanitized.phone || formData?.phone,
      deviceId: sanitized.deviceId || formData?.deviceId,
      refId: sanitized.refId || formData?.ref
    });

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

    // =========================================================================
    // Step 1: Pull CRS data from Stitch Credit
    // =========================================================================
    // Determine business info to pass based on pull scope
    const effectiveBusiness = crs_pull_scope === "consumer_only" ? null : business || null;

    logInfo("CRS pull starting", {
      name: submittedName,
      hasBusiness: !!effectiveBusiness,
      crs_pull_scope
    });

    let pullResult;
    try {
      pullResult = await pullFullCRS(applicant, effectiveBusiness);
    } catch (pullErr) {
      logError("CRS pull failed", pullErr);
      return res.status(200).json({
        ok: false,
        error: "CRS_PULL_FAILED",
        message:
          "Failed to pull credit reports. Please verify applicant information and try again.",
        details: pullErr.message
      });
    }

    const { rawResponses, businessReport, errors: pullErrors } = pullResult;

    // If consumer_plus_ex_business was requested but business pull failed or
    // returned no data, do NOT silently downgrade — flag the failure clearly.
    let businessPullFailed = false;
    let businessPullFailReason = null;
    if (crs_pull_scope === "consumer_plus_ex_business" && !businessReport) {
      businessPullFailed = true;
      const bizError = pullErrors.find(e => e.bureau === "business");
      businessPullFailReason = bizError
        ? bizError.error
        : "Business search returned no results or no BIN found";
    }

    logInfo("CRS pull complete", {
      bureausPulled: rawResponses.length,
      hasBusinessReport: !!businessReport,
      businessPullFailed,
      pullErrors: pullErrors.length
    });

    // =========================================================================
    // Step 2: Run CRS Engine
    // =========================================================================
    const submittedAddress = applicant.address
      ? `${applicant.address.addressLine1}, ${applicant.address.city}, ${applicant.address.state} ${applicant.address.postalCode}`
      : "";

    const result = runCRSEngine({
      rawResponses,
      businessReport,
      submittedName,
      submittedAddress,
      formData: {
        email: sanitized.email || formData?.email || null,
        phone: sanitized.phone || formData?.phone || null,
        name: submittedName,
        companyName: business?.name || sanitized.companyName || formData?.companyName || null,
        hasLLC: formData?.hasLLC || false,
        llcAgeMonths: formData?.llcAgeMonths || null,
        businessAgeMonths: formData?.businessAgeMonths || null,
        ref: sanitized.refId || formData?.ref || null
      }
    });

    if (!result.ok) {
      return res
        .status(200)
        .json({ ok: false, error: "ENGINE_FAILED", message: "CRS engine processing failed." });
    }

    logInfo("CRS engine complete", {
      outcome: result.outcome,
      totalCombined: result.preapprovals?.totalCombined
    });

    // =========================================================================
    // Step 3: Post-processing (GHL, letters, dedup cache)
    // =========================================================================
    const redirectPath = result.redirect?.path;
    const refId =
      sanitized.refId ||
      formData?.ref ||
      `crs-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

    const redirect = {
      resultType: result.crm_payload?.resultType || "hold",
      refId
    };

    // Dedup cache
    if (dedupeClient && (dedupeKeys.userKey || dedupeKeys.deviceKey || dedupeKeys.refKey)) {
      try {
        await storeRedirect(dedupeClient, dedupeKeys, redirect);
      } catch {
        /* non-fatal: cache miss is acceptable */
      }
    }

    // GHL (queued)
    const email = sanitized.email || formData?.email;
    const phone = sanitized.phone || formData?.phone;
    if (email) {
      const { firstName, lastName } = parseFullName(submittedName);
      enqueueTask("ghl_sync", {
        firstName,
        lastName,
        email,
        phone,
        businessName: business?.name || null,
        resultType: redirect.resultType,
        creditScore: result.consumerSignals?.scores?.median || 0,
        totalFunding: result.preapprovals?.totalCombined || 0,
        refId
      });

      // ----- GHL Webhook: trigger U-03 (crs_snapshot_complete) -----
      const perBureau = derivePerBureauMetrics(result.normalized);
      notifyCRSSnapshotComplete({
        email,
        firstName,
        lastName,
        analyzerPath: redirectPath === "funding" ? "funding" : "repair",
        ficoScore: result.consumerSignals?.scores?.median || 0,
        utilizationPct: result.consumerSignals?.utilization?.pct || 0,
        inquiries: { ex: perBureau.ex.inqs, eq: perBureau.eq.inqs, tu: perBureau.tu.inqs },
        negatives: { ex: perBureau.ex.negs, eq: perBureau.eq.negs, tu: perBureau.tu.negs },
        // Late payments not yet derived per-bureau; CRS engine aggregates across bureaus
        lates: { ex: 0, eq: 0, tu: 0 }
      }).catch(() => {});
    }

    // Letter delivery (queued)
    if (
      result.documents?.letters?.length > 0 &&
      result.outcome !== "FRAUD_HOLD" &&
      result.outcome !== "MANUAL_REVIEW"
    ) {
      enqueueTask("deliver_letters", {
        contactId: null,
        contactData: {
          email: sanitized.email || formData?.email,
          phone: sanitized.phone || formData?.phone
        },
        bureaus: null,
        underwrite: {
          fundable: redirectPath === "funding",
          personal: { total_personal_funding: result.preapprovals?.totalPersonal || 0 },
          business: { business_funding: result.preapprovals?.totalBusiness || 0 }
        },
        personal: { name: submittedName, address: submittedAddress || null },
        crsDocuments: result.documents,
        crsResult: result
      });
    }

    // Airtable sync (queued) — pass crs_pull_scope so snapshot knows whether
    // business was expected and whether it failed
    const airtableRecordId = formData?.airtableRecordId || null;
    const syncEmail = sanitized.email || formData?.email || null;
    if (airtableRecordId || syncEmail) {
      enqueueTask("airtable_sync", {
        result,
        recordId: airtableRecordId,
        email: syncEmail,
        crs_pull_scope,
        businessPullFailed,
        businessReport: businessReport || null
      });
    }

    // =========================================================================
    // Response
    // =========================================================================
    const pullMeta = {
      bureausPulled: rawResponses.length,
      businessPulled: !!businessReport,
      crs_pull_scope,
      pullErrors: pullErrors.length > 0 ? pullErrors : undefined
    };

    // If business was mandatory but failed, include clear failure info
    if (businessPullFailed) {
      pullMeta.businessPullFailed = true;
      pullMeta.businessPullFailReason = businessPullFailReason;
    }

    return res.status(200).json({
      ok: true,
      deduped: false,
      outcome: result.outcome,
      decision_label: result.decision_label,
      decision_explanation: result.decision_explanation,
      reason_codes: result.reason_codes,
      confidence: result.confidence,
      consumer_summary: result.consumer_summary,
      business_summary: result.business_summary,
      preapprovals: result.preapprovals,
      optimization_findings: result.optimization_findings,
      suggestions: result.suggestions,
      cards: result.cards,
      documents: result.documents,
      redirect,
      audit: result.audit,
      // Pull metadata
      pull_meta: pullMeta
    });
  } catch (err) {
    logError("CRS pull-and-analyze fatal error", err);
    return res.status(200).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: "Something went wrong during credit analysis. Please try again."
    });
  }
};
