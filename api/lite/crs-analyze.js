"use strict";

// ============================================================================
// CRS Analyze — Stitch Credit Soft-Pull Endpoint
//
// POST /api/lite/crs-analyze
//
// Accepts raw Stitch Credit CRS responses (JSON) and runs the full CRS engine
// pipeline. This is the CRS counterpart to the PDF-based switchboard.js.
// ============================================================================

const { runCRSEngine } = require("./crs/engine");
const { enrichSuggestionsWithAI } = require("./crs/suggestion-text-generator");
const { generateDeliverables } = require("./crs/generate-deliverables");
const { sanitizeFormFields } = require("./input-sanitizer");
const { rateLimitMiddleware } = require("./rate-limiter");
const {
  buildDedupeKeys,
  createRedisClient,
  checkDedupe,
  storeRedirect
} = require("./dedupe-store");
const { parseFullName } = require("./ghl-contact-service");
const { logError, logWarn, logInfo } = require("./logger");
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
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
      return res
        .status(400)
        .json({ ok: false, error: "MISSING_BODY", message: "Request body is required." });
    }

    // ----- Validate required fields -----
    const { rawResponses, businessReport, formData } = body;

    if (!rawResponses || !Array.isArray(rawResponses) || rawResponses.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_RAW_RESPONSES",
        message: "rawResponses must be a non-empty array of Stitch Credit CRS responses."
      });
    }

    if (rawResponses.length > 3) {
      return res.status(400).json({
        ok: false,
        error: "TOO_MANY_RESPONSES",
        message: "Maximum 3 CRS responses (one per bureau)."
      });
    }

    // ----- Sanitize form data -----
    const sanitized = {};
    if (formData && typeof formData === "object") {
      const sanResult = sanitizeFormFields(formData);
      if (sanResult.ok) {
        Object.assign(sanitized, sanResult.sanitized);
      }
    }

    const submittedName = sanitized.name || formData?.name || "";
    const submittedAddress = sanitized.address || formData?.address || "";

    // ----- Deduplication check -----
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
        logInfo("CRS dedup hit", { keys: Object.keys(dedupeKeys).filter(k => dedupeKeys[k]) });
        return res.status(200).json({ ok: true, redirect: cached.redirect, deduped: true });
      }
    }

    // ----- Run CRS Engine -----
    logInfo("CRS engine starting", {
      bureauCount: rawResponses.length,
      hasBusiness: !!businessReport,
      hasName: !!submittedName
    });

    const result = runCRSEngine({
      rawResponses,
      businessReport: businessReport || null,
      submittedName,
      submittedAddress,
      formData: {
        email: sanitized.email || formData?.email || null,
        phone: sanitized.phone || formData?.phone || null,
        name: submittedName || null,
        companyName: sanitized.companyName || formData?.companyName || null,
        hasLLC: formData?.hasLLC || false,
        llcAgeMonths: formData?.llcAgeMonths || null,
        businessAgeMonths: formData?.businessAgeMonths || null,
        ref: sanitized.refId || formData?.ref || null
      }
    });

    if (!result.ok) {
      return res.status(200).json({
        ok: false,
        error: "ENGINE_FAILED",
        message: "CRS engine returned a non-ok result."
      });
    }

    // ----- AI Text Enhancement (non-blocking) -----
    if (result.suggestions?.fullSuggestions?.length > 0) {
      try {
        result.suggestions.fullSuggestions = await enrichSuggestionsWithAI(
          result.suggestions.fullSuggestions
        );
      } catch (_aiErr) {
        // Falls back to template text — already handled inside the function
      }
    }

    // ----- Step 15: Claude API Document Generation (non-blocking) -----
    let deliverables = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const personal = {
          name: submittedName || sanitized.name || "Client",
          address: submittedAddress || ""
        };
        deliverables = await generateDeliverables(result, personal);
        result.deliverables = deliverables;
      } catch (_docErr) {
        logWarn("Document generation failed, continuing without", { error: _docErr.message });
      }
    }

    logInfo("CRS engine complete", {
      outcome: result.outcome,
      totalCombined: result.preapprovals?.totalCombined,
      findingsCount: result.optimization_findings?.length,
      documentsGenerated: deliverables?.meta?.documentsGenerated || 0
    });

    // ----- Build redirect -----
    const redirectPath = result.redirect?.path;
    const baseUrl =
      redirectPath === "funding"
        ? process.env.REDIRECT_URL_FUNDABLE || "https://fundhub.ai/funding-approved-analyzer-462533"
        : redirectPath === "repair"
          ? process.env.REDIRECT_URL_NOT_FUNDABLE || "https://fundhub.ai/fix-my-credit-analyzer"
          : null;

    const refId =
      sanitized.refId ||
      formData?.ref ||
      `crs-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

    const redirect = {
      resultType:
        result.crm_payload?.resultType ||
        (redirectPath === "funding" ? "funding" : redirectPath === "repair" ? "repair" : "hold"),
      resultUrl: baseUrl || null,
      url: baseUrl || null,
      refId
    };

    // ----- Store in dedup cache -----
    if (dedupeClient && (dedupeKeys.userKey || dedupeKeys.deviceKey || dedupeKeys.refKey)) {
      try {
        await storeRedirect(dedupeClient, dedupeKeys, redirect);
      } catch (err) {
        logWarn("CRS dedup store failed", { error: err.message });
      }
    }

    // ----- GHL Contact (queued) -----
    const email = sanitized.email || formData?.email;
    const phone = sanitized.phone || formData?.phone;
    if (email) {
      const { firstName, lastName } = parseFullName(submittedName);
      enqueueTask("ghl_sync", {
        firstName,
        lastName,
        email,
        phone,
        businessName: sanitized.companyName || formData?.companyName,
        resultType: redirect.resultType,
        creditScore: result.consumerSignals?.scores?.median || 0,
        totalFunding: result.preapprovals?.totalCombined || 0,
        creditSuggestions: result.crmPayload?.suggestionSummary || "",
        refId
      });

      // ----- GHL Webhook: trigger U-03 (crs_snapshot_complete) -----
      // Fires async — does not block response. U-03 handles: CRS metric mapping,
      // CRS Status = Complete, crs:snapshot tag, triggers U-04 (promote Primary Snapshot).
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
        lates: { ex: perBureau.ex.lates, eq: perBureau.eq.lates, tu: perBureau.tu.lates },
        creditSuggestions: result.crmPayload?.suggestionSummary || ""
      }).catch(() => {});
    }

    // ----- Letter delivery (queued) -----
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
        personal: {
          name: submittedName,
          address: submittedAddress || null
        },
        crsDocuments: result.documents,
        crsResult: result
      });
    }

    // ----- Airtable sync (queued) -----
    const airtableRecordId = formData?.airtableRecordId || null;
    const syncEmail = sanitized.email || formData?.email || null;
    if (airtableRecordId || syncEmail) {
      enqueueTask("airtable_sync", { result, recordId: airtableRecordId, email: syncEmail });
    }

    // ----- Response -----
    return res.status(200).json({
      ok: true,
      deduped: false,
      // Top-level spec fields
      outcome: result.outcome,
      decision_label: result.decision_label,
      decision_explanation: result.decision_explanation,
      reason_codes: result.reason_codes,
      confidence: result.confidence,
      consumer_summary: result.consumer_summary,
      business_summary: result.business_summary,
      // Detail
      preapprovals: result.preapprovals,
      optimization_findings: result.optimization_findings,
      suggestions: result.suggestions,
      cards: result.cards,
      documents: result.documents,
      redirect,
      // Internal (stripped for customer-safe responses)
      audit: result.audit
    });
  } catch (err) {
    logError("CRS analyze fatal error", err, { method: req.method, path: req.url });
    return res.status(200).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: "Something went wrong during credit analysis. Please try again."
    });
  }
};
