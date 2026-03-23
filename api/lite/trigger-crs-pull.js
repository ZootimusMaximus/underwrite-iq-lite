"use strict";

// ============================================================================
// Trigger CRS Pull — AX06 Airtable Automation Endpoint
//
// POST /api/lite/trigger-crs-pull
//
// Receives a trigger from Airtable automation AX06 with a client_id,
// fetches PII from linked PII_IDENTITY record, builds the applicant
// object, and calls the full CRS pipeline (pull + analyze).
//
// Payload:
//   { client_id, round_id?, pull_type? }
//
// Returns structured CRS result for AX06 to write back to Airtable.
// ============================================================================

const { pullFullCRS } = require("./crs/stitch-credit-client");
const { runCRSEngine } = require("./crs/engine");
const { rateLimitMiddleware } = require("./rate-limiter");
const { fetchWithTimeout } = require("./fetch-utils");
const { enqueueTask } = require("./background-queue");
const { logError, logInfo, logWarn } = require("./logger");

// ---------------------------------------------------------------------------
// Airtable Config
// ---------------------------------------------------------------------------

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

// Table IDs from FUNDHUB MATRIX base
const TABLE_CLIENTS = process.env.AIRTABLE_TABLE_CLIENTS_ID || "tblmSXx3cL7g43Eyi";
const TABLE_PII_IDENTITY = process.env.AIRTABLE_TABLE_PII_ID || "tblRwLZR7uHDRb0LW";

const VALID_PULL_TYPES = ["consumer_only", "consumer_plus_ex_business"];

// ---------------------------------------------------------------------------
// Airtable Helpers (use table IDs directly for linked record lookups)
// ---------------------------------------------------------------------------

function airtableUrl(tableId, recordId) {
  return recordId
    ? `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${tableId}/${recordId}`
    : `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${tableId}`;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${AIRTABLE_API_KEY}`,
    "Content-Type": "application/json"
  };
}

/**
 * Fetch a record directly by table ID and record ID.
 * (airtable-sync.js uses table names, but we need table IDs for
 * PII_IDENTITY since its name may differ from the env var.)
 */
async function fetchRecord(tableId, recordId) {
  const resp = await fetchWithTimeout(airtableUrl(tableId, recordId), {
    method: "GET",
    headers: authHeaders()
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `Airtable GET ${tableId}/${recordId} failed: ${resp.status} ${text.substring(0, 200)}`
    );
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// PII to Applicant Mapping
// ---------------------------------------------------------------------------

/**
 * Map PII_IDENTITY fields to the applicant shape expected by pullFullCRS.
 *
 * PII fields: owner_first_name, owner_last_name, ssn_full, ssn_last4,
 *             dob, phone, street1, city, state, zip
 *
 * Applicant shape: { firstName, lastName, ssn, birthDate, address: { ... } }
 */
function mapPIIToApplicant(piiFields) {
  const errors = [];

  const firstName = (piiFields.owner_first_name || "").trim();
  const lastName = (piiFields.owner_last_name || "").trim();
  const ssn = (piiFields.ssn_full || "").replace(/\D/g, "");
  const birthDate = (piiFields.dob || "").trim();
  const street1 = (piiFields.street1 || "").trim();
  const city = (piiFields.city || "").trim();
  const state = (piiFields.state || "").trim();
  const zip = (piiFields.zip || "").trim();

  if (!firstName) errors.push("owner_first_name");
  if (!lastName) errors.push("owner_last_name");
  if (!ssn || ssn.length !== 9) errors.push("ssn_full (must be 9 digits)");
  if (!birthDate) errors.push("dob");
  if (!street1) errors.push("street1");
  if (!city) errors.push("city");
  if (!state) errors.push("state");
  if (!zip) errors.push("zip");

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    applicant: {
      firstName,
      lastName,
      ssn,
      birthDate,
      address: {
        addressLine1: street1,
        city,
        state,
        postalCode: zip
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  const triggerSource = "AX06";

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
      return res
        .status(400)
        .json({ ok: false, error: "MISSING_BODY", message: "Request body is required." });
    }

    // ----- Validate required fields -----
    const { client_id, round_id, pull_type } = body;

    if (!client_id) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_CLIENT_ID",
        message: "client_id (Airtable record ID) is required."
      });
    }

    // ----- Validate pull_type -----
    const crs_pull_scope = pull_type || "consumer_only";
    if (!VALID_PULL_TYPES.includes(crs_pull_scope)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_PULL_TYPE",
        message: `pull_type must be one of: ${VALID_PULL_TYPES.join(", ")}`
      });
    }

    // ----- Verify Airtable is configured -----
    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return res.status(500).json({
        ok: false,
        error: "AIRTABLE_NOT_CONFIGURED",
        message: "Airtable API key or base ID not configured."
      });
    }

    logInfo("CRS pull triggered", {
      source: triggerSource,
      client_id,
      round_id: round_id || null,
      pull_type: crs_pull_scope
    });

    // =========================================================================
    // Step 1: Fetch client record from Airtable CLIENTS table
    // =========================================================================
    let clientRecord;
    try {
      clientRecord = await fetchRecord(TABLE_CLIENTS, client_id);
    } catch (err) {
      logError("Failed to fetch client record", err);
      return res.status(200).json({
        ok: false,
        error: "CLIENT_FETCH_FAILED",
        message: `Could not fetch client record: ${err.message}`,
        source: triggerSource
      });
    }

    const clientFields = clientRecord.fields || {};

    // =========================================================================
    // Step 2: Resolve PII_IDENTITY linked record
    // =========================================================================
    // CLIENTS.identity is a linked field to PII_IDENTITY table.
    // Airtable returns linked fields as an array of record IDs.
    const identityLinks = clientFields.identity || clientFields.PII_IDENTITY || [];
    const piiRecordId = Array.isArray(identityLinks) ? identityLinks[0] : identityLinks;

    if (!piiRecordId) {
      logWarn("No PII_IDENTITY linked for client", { client_id });
      return res.status(200).json({
        ok: false,
        error: "NO_PII_LINKED",
        message:
          "Client record has no linked PII_IDENTITY record. Cannot pull CRS without identity data.",
        source: triggerSource,
        client_id
      });
    }

    let piiRecord;
    try {
      piiRecord = await fetchRecord(TABLE_PII_IDENTITY, piiRecordId);
    } catch (err) {
      logError("Failed to fetch PII record", err);
      return res.status(200).json({
        ok: false,
        error: "PII_FETCH_FAILED",
        message: `Could not fetch PII_IDENTITY record: ${err.message}`,
        source: triggerSource,
        client_id,
        pii_record_id: piiRecordId
      });
    }

    const piiFields = piiRecord.fields || {};

    // =========================================================================
    // Step 3: Map PII to applicant shape
    // =========================================================================
    const mappingResult = mapPIIToApplicant(piiFields);
    if (!mappingResult.ok) {
      logWarn("PII fields incomplete for CRS pull", {
        client_id,
        pii_record_id: piiRecordId,
        missing: mappingResult.errors
      });
      return res.status(200).json({
        ok: false,
        error: "INCOMPLETE_PII",
        message: `PII_IDENTITY record is missing required fields: ${mappingResult.errors.join(", ")}`,
        source: triggerSource,
        client_id,
        pii_record_id: piiRecordId,
        missing_fields: mappingResult.errors
      });
    }

    const { applicant } = mappingResult;
    const submittedName = `${applicant.firstName} ${applicant.lastName}`.trim();

    logInfo("PII resolved for CRS pull", {
      source: triggerSource,
      client_id,
      name: submittedName,
      pull_type: crs_pull_scope
    });

    // =========================================================================
    // Step 4: Pull CRS data from Stitch Credit
    // =========================================================================
    // For consumer_plus_ex_business, we need business info from the payload.
    // For consumer_only (default AX06 flow), business is null.
    const effectiveBusiness = crs_pull_scope === "consumer_only" ? null : body.business || null;

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
        details: pullErr.message,
        source: triggerSource,
        client_id
      });
    }

    const { rawResponses, businessReport, errors: pullErrors } = pullResult;

    // Track business pull failure
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
      source: triggerSource,
      client_id,
      bureausPulled: rawResponses.length,
      hasBusinessReport: !!businessReport,
      businessPullFailed,
      pullErrors: pullErrors.length
    });

    // =========================================================================
    // Step 5: Run CRS Engine
    // =========================================================================
    const submittedAddress = `${applicant.address.addressLine1}, ${applicant.address.city}, ${applicant.address.state} ${applicant.address.postalCode}`;

    const result = runCRSEngine({
      rawResponses,
      businessReport,
      submittedName,
      submittedAddress,
      formData: {
        email: clientFields.email || null,
        phone: piiFields.phone || null,
        name: submittedName,
        airtableRecordId: client_id,
        ref: round_id || null
      }
    });

    if (!result.ok) {
      return res.status(200).json({
        ok: false,
        error: "ENGINE_FAILED",
        message: "CRS engine processing failed.",
        source: triggerSource,
        client_id
      });
    }

    logInfo("CRS engine complete", {
      source: triggerSource,
      client_id,
      outcome: result.outcome,
      totalCombined: result.preapprovals?.totalCombined
    });

    // =========================================================================
    // Step 6: Post-processing — Airtable sync (queued)
    // =========================================================================
    enqueueTask("airtable_sync", {
      result,
      recordId: client_id,
      email: clientFields.email || null,
      crs_pull_scope,
      businessPullFailed
    });

    // =========================================================================
    // Response — structured for AX06 to consume
    // =========================================================================
    const pullMeta = {
      bureausPulled: rawResponses.length,
      businessPulled: !!businessReport,
      crs_pull_scope,
      pullErrors: pullErrors.length > 0 ? pullErrors : undefined
    };

    if (businessPullFailed) {
      pullMeta.businessPullFailed = true;
      pullMeta.businessPullFailReason = businessPullFailReason;
    }

    return res.status(200).json({
      ok: true,
      source: triggerSource,
      client_id,
      round_id: round_id || null,
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
      audit: result.audit,
      pull_meta: pullMeta
    });
  } catch (err) {
    logError("trigger-crs-pull fatal error", err);
    return res.status(200).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: "Something went wrong during CRS pull trigger. Please try again.",
      source: triggerSource
    });
  }
};

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

module.exports.mapPIIToApplicant = mapPIIToApplicant;
