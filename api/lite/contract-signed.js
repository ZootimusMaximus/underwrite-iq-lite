"use strict";

/**
 * POST /api/lite/contract-signed
 *
 * Contract-signature event webhook. The CRM is event-based — when the funding
 * contract is signed, the signature event hits this endpoint and it flips the GHL
 * gate field `contract_funding_signed` = true (an S-06 full-intake gate). No
 * manual tick, no external platform: the signature event flips the box and the
 * next step triggers automatically. Mirror of crs-payment-posted (the crs_paid
 * gate).
 *
 * Request body: { contactId: string }
 *   contactId — GHL contact ID (strict alphanumeric allowlist)
 *
 * Auth: Authorization: Bearer <CONTRACT_SIGNED_SECRET || CONTEXT_FETCHER_SECRET>
 *   If neither secret is set, auth is skipped (dev/local mode).
 *
 * GHL field key (verified live 2026-06-29): contact.contract_funding_signed
 * (CHECKBOX, option "Contract Funding Signed"). updateContactCustomFields passes
 * the array through untouched — a plain string silently fails to check the box.
 */

const { logInfo, logWarn, logError } = require("./logger");
const { updateContactCustomFields } = require("./ghl-contact-service");

// CHECKBOX "checked" value = the option label inside an array.
const CONTRACT_SIGNED_CHECKED = ["Contract Funding Signed"];

function validateAuth(req) {
  const secret = process.env.CONTRACT_SIGNED_SECRET || process.env.CONTEXT_FETCHER_SECRET;
  if (!secret) {
    logWarn("contract-signed: no secret set — running unauthenticated (dev mode)");
    return { ok: true };
  }
  const bearer = req.headers["authorization"] || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
  const headerSecret = req.headers["x-contract-signed-secret"] || null;
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
    "Content-Type, Authorization, x-contract-signed-secret"
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
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(contactId)) {
    return res.status(400).json({ ok: false, error: "Invalid contactId" });
  }

  logInfo("contract-signed: flipping contract_funding_signed", { contactId });

  try {
    const result = await updateContactCustomFields(contactId, {
      contract_funding_signed: CONTRACT_SIGNED_CHECKED
    });
    if (!result || !result.ok) {
      logError("contract-signed: GHL update failed", { contactId, error: result && result.error });
      return res.status(502).json({ ok: false, error: "GHL update failed" });
    }
    return res.status(200).json({ ok: true, contactId, updated: ["contract_funding_signed"] });
  } catch (err) {
    logError("contract-signed: unhandled error", { contactId, error: err.message });
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
};
