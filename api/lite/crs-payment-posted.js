"use strict";

/**
 * POST /api/lite/crs-payment-posted
 *
 * Soft-pull / CRS charge-posted webhook. When the CRS (soft-pull) charge posts on
 * the call, the payment rail calls this to flip the GHL gate field
 * `crs_paid` = true — one of S-06's full-intake gates. Mirrors the AR
 * payment-posted pattern: an EVENT flips the box, the closer never ticks it by hand
 * (manual tick is only a stopgap until this is wired).
 *
 * Request body: { contactId: string, amount?: number, consent?: boolean }
 *   contactId — GHL contact ID (strict alphanumeric allowlist)
 *   amount    — charge amount; recorded to cf_crs_charge_amount when provided
 *   consent   — soft-pull consent; recorded to cf_crs_softpull_consent ("Yes") when true
 *
 * Auth: Authorization: Bearer <CRS_PAYMENT_SECRET || CONTEXT_FETCHER_SECRET>
 *   If neither secret is set, auth is skipped (dev/local mode).
 *
 * GHL field keys (verified live 2026-06-29): contact.crs_paid (checkbox),
 * contact.cf_crs_charge_amount (monetary), contact.cf_crs_softpull_consent (single-options).
 */

const { logInfo, logWarn, logError } = require("./logger");
const { updateContactCustomFields } = require("./ghl-contact-service");

// GHL checkbox "true" is the option label, which for crs_paid is "CRS Paid".
const CRS_PAID_TRUE = "CRS Paid";

function validateAuth(req) {
  const secret = process.env.CRS_PAYMENT_SECRET || process.env.CONTEXT_FETCHER_SECRET;
  if (!secret) {
    logWarn("crs-payment-posted: no secret set — running unauthenticated (dev mode)");
    return { ok: true };
  }
  const bearer = req.headers["authorization"] || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
  const headerSecret = req.headers["x-crs-payment-secret"] || null;
  if ((token && token === secret) || (headerSecret && headerSecret === secret)) {
    return { ok: true };
  }
  return { ok: false };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-crs-payment-secret"
  );

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!validateAuth(req).ok) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const body = req.body || {};
  const contactId =
    body.contactId || body.contact_id || (body.customData && body.customData.contactId);
  if (!contactId) {
    return res.status(400).json({ ok: false, error: "contactId is required" });
  }
  // GHL contact ids are alphanumeric — reject anything else (defensive).
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(contactId)) {
    return res.status(400).json({ ok: false, error: "Invalid contactId" });
  }

  // Build the field writes. crs_paid is always flipped; charge amount + consent
  // are recorded when provided so the contact carries the full charge context.
  const fields = { crs_paid: CRS_PAID_TRUE };
  const amount = body.amount ?? (body.customData && body.customData.amount);
  if (amount !== undefined && amount !== null && amount !== "") {
    const num = Number(amount);
    if (!Number.isNaN(num)) fields.cf_crs_charge_amount = String(num);
  }
  const consent = body.consent ?? (body.customData && body.customData.consent);
  if (consent === true || consent === "true" || consent === "Yes") {
    fields.cf_crs_softpull_consent = "Yes";
  }

  logInfo("crs-payment-posted: flipping crs_paid", {
    contactId,
    hasAmount: "cf_crs_charge_amount" in fields,
    hasConsent: "cf_crs_softpull_consent" in fields
  });

  try {
    const result = await updateContactCustomFields(contactId, fields);
    if (!result || !result.ok) {
      logError("crs-payment-posted: GHL update failed", {
        contactId,
        error: result && result.error
      });
      return res.status(502).json({ ok: false, error: "GHL update failed" });
    }
    return res.status(200).json({ ok: true, contactId, updated: Object.keys(fields) });
  } catch (err) {
    logError("crs-payment-posted: unhandled error", { contactId, error: err.message });
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
};
