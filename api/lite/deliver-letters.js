"use strict";

/**
 * POST /api/lite/deliver-letters
 *
 * Downsell-triggered letter delivery. Per the customer journey (2026-06-30): the
 * CRS soft pull produces DATA ONLY — it no longer dishes out letters. Letters are
 * a downstream deliverable that fires on a trigger:
 *   - repair dispute letters  → the on-call credit-repair DOWNSELL (client passed
 *     on funding) — this is the primary use.
 *   - funding cleanup letters → on funding purchase (future trigger).
 *
 * A GHL workflow (the downsell flow) POSTs here with the contactId. We look up the
 * client's name/address off their GHL record, generate the letters, upload them,
 * and write the letter-URL fields back to the GHL contact (same path the pull used
 * to use — so the 422 fix applies here too).
 *
 * Request body: { contactId: string, type?: "repair"|"funding", bureaus?: string[] }
 * Auth: Authorization: Bearer <DELIVER_LETTERS_SECRET || CONTEXT_FETCHER_SECRET>.
 */

const { logInfo, logWarn, logError } = require("./logger");
const { getGHLContact } = require("./ghl-contact-service");
const { buildDocuments } = require("./crs/build-documents");
const { deliverLetters } = require("./letter-delivery");

const ALL_BUREAUS = ["transunion", "experian", "equifax"];

function validateAuth(req) {
  const secret = process.env.DELIVER_LETTERS_SECRET || process.env.CONTEXT_FETCHER_SECRET;
  if (!secret) {
    // FAIL CLOSED in production — this endpoint writes to the customer's CRM
    // record. Never serve it unauthenticated on a live deploy. Dev/local stays open.
    if (process.env.NODE_ENV === "production") {
      logError("deliver-letters: no secret configured — refusing to serve in production");
      return { ok: false };
    }
    logWarn("deliver-letters: no secret set — running unauthenticated (dev mode only)");
    return { ok: true };
  }
  const bearer = req.headers["authorization"] || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
  const headerSecret = req.headers["x-deliver-letters-secret"] || null;
  if ((token && token === secret) || (headerSecret && headerSecret === secret)) {
    return { ok: true };
  }
  return { ok: false };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-deliver-letters-secret"
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

  const type = body.type === "funding" ? "funding" : "repair";
  const bureaus =
    Array.isArray(body.bureaus) && body.bureaus.length
      ? body.bureaus.map(b => String(b).toLowerCase()).filter(b => ALL_BUREAUS.includes(b))
      : ALL_BUREAUS;

  // Look up the client's name/address off their GHL record (needed on the letters).
  let personal;
  try {
    const ghl = await getGHLContact(contactId);
    if (!ghl || !ghl.ok || !ghl.contact) {
      logWarn("deliver-letters: GHL contact lookup failed", { contactId, error: ghl && ghl.error });
      return res.status(502).json({ ok: false, error: "Contact lookup failed" });
    }
    const c = ghl.contact;
    const name =
      `${c.firstName || ""} ${c.lastName || ""}`.trim() ||
      c.contactName ||
      c.fullNameLowerCase ||
      "";
    personal = {
      name,
      address: {
        addressLine1: c.address1 || c.address || "",
        city: c.city || "",
        state: c.state || "",
        postalCode: c.postalCode || ""
      }
    };
  } catch (err) {
    logError("deliver-letters: GHL lookup threw", { contactId, error: err.message });
    return res.status(502).json({ ok: false, error: "Contact lookup failed" });
  }

  // Build the letter specs. Reuse buildDocuments so the field-key mapping (incl the
  // transunion → "tu" fix) is identical to the pull path. For a repair downsell we
  // dispute the given bureaus (default all three); funding builds cleanup letters.
  // inquiries left empty here — funding inquiry letters need pull-time inquiry data,
  // so the funding path currently emits personal-info cleanup only (repair is the
  // launch use; funding can be enriched later).
  const outcome = type === "funding" ? "FULL_FUNDING" : "REPAIR_ONLY";
  const normalized = { meta: { availableBureaus: bureaus }, inquiries: [] };
  const crsDocuments = buildDocuments(outcome, [], normalized, {});

  if (!crsDocuments.letters?.length) {
    return res
      .status(200)
      .json({ ok: true, contactId, type, delivered: 0, note: "no letters for this type/bureaus" });
  }

  logInfo("deliver-letters: delivering", {
    contactId,
    type,
    bureaus,
    letterCount: crsDocuments.letters.length
  });

  try {
    const result = await deliverLetters({ contactId, personal, crsDocuments });
    if (!result.ok) {
      logError("deliver-letters: delivery failed", { contactId, error: result.error });
      return res.status(502).json({ ok: false, error: result.error || "Delivery failed" });
    }
    return res.status(200).json({
      ok: true,
      contactId,
      type,
      bureaus,
      letters: result.letters,
      ghlUpdated: result.ghlUpdated
    });
  } catch (err) {
    logError("deliver-letters: threw", { contactId, error: err.message });
    return res.status(500).json({ ok: false, error: "Delivery error" });
  }
};
