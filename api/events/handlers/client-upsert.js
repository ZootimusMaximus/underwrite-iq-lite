"use strict";

// ============================================================================
// Client Master Upsert Handler
//
// Implements Spec Section 6 "Client Master / Upsert Contract".
// Called by every downstream event handler BEFORE any child writes
// (snapshots, funding rounds, inquiry log, etc.).
//
// Resolver order (spec § 6):
//   1. Match by ghl_contact_id if present
//   2. Normalize email → match by email
//   3. Normalize phone → match by phone
//   4. Nothing matched → create new client
//
// On each path the handler:
//   a) Creates or updates the GHL contact
//   b) Creates or updates Airtable CLIENTS
//   c) Writes back client_master_key, ghl_contact_id,
//      airtable_client_record_id, airtable_client_url to both systems
//
// Returns a stable identity object.  Downstream handlers MUST check ok:true
// before writing any child records (spec: "Block child writes until the
// Airtable client record exists").
//
// See: FundHub Modular Event System Developer Handoff 2026-04-08, Section 6.
// ============================================================================

const { logInfo, logWarn, logError } = require("../../lite/logger");
const { normalizeEmail, normalizePhone } = require("../utils/normalize");
const { fetchWithTimeout } = require("../../lite/fetch-utils");

// ---------------------------------------------------------------------------
// GHL config (mirrors patterns in ghl-contact-service.js)
// ---------------------------------------------------------------------------

const GHL_API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

function _ghlKey() {
  return process.env.GHL_PRIVATE_API_KEY || process.env.GHL_API_KEY || null;
}

function _locationId() {
  return process.env.GHL_LOCATION_ID || null;
}

function _ghlHeaders() {
  return {
    Authorization: `Bearer ${_ghlKey()}`,
    "Content-Type": "application/json",
    Version: GHL_API_VERSION
  };
}

// ---------------------------------------------------------------------------
// Airtable config (mirrors patterns in crs/airtable-sync.js)
// ---------------------------------------------------------------------------

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
// TABLE_CLIENTS defaults to "CLIENTS" (upper-case) to match FUNDHUB MATRIX.
const TABLE_CLIENTS = process.env.AIRTABLE_TABLE_CLIENTS || "CLIENTS";

function _atKey() {
  return process.env.AIRTABLE_API_KEY || null;
}

function _atBaseId() {
  return process.env.AIRTABLE_BASE_ID || null;
}

function _isAtConfigured() {
  return !!(_atKey() && _atBaseId());
}

function _atHeaders() {
  return {
    Authorization: `Bearer ${_atKey()}`,
    "Content-Type": "application/json"
  };
}

function _atTableUrl(recordId) {
  const encoded = encodeURIComponent(TABLE_CLIENTS);
  const base = `${AIRTABLE_API_BASE}/${_atBaseId()}/${encoded}`;
  return recordId ? `${base}/${recordId}` : base;
}

// ---------------------------------------------------------------------------
// CMK generator
// ---------------------------------------------------------------------------

/**
 * Generate a new client_master_key.
 * Format: cmk_{unix_ms}_{4-char hex}
 *
 * @returns {string}
 */
function generateClientMasterKey() {
  const ts = Date.now();
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `cmk_${ts}_${rand}`;
}

// ---------------------------------------------------------------------------
// Name helper
// ---------------------------------------------------------------------------

/**
 * Split a full name into { firstName, lastName }.
 * Mirrors parseFullName in ghl-contact-service.js.
 *
 * @param {string} fullName
 * @returns {{ firstName: string, lastName: string }}
 */
function parseFullName(fullName) {
  if (!fullName || typeof fullName !== "string") return { firstName: "", lastName: "" };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// ---------------------------------------------------------------------------
// Airtable URL builder
// ---------------------------------------------------------------------------

/**
 * Build an Airtable deep-link URL for a CLIENTS record.
 *
 * @param {string} recordId
 * @returns {string|null}
 */
function buildAirtableClientUrl(recordId) {
  const baseId = _atBaseId();
  if (!baseId || !recordId) return null;
  return `https://airtable.com/${baseId}/${encodeURIComponent(TABLE_CLIENTS)}/${recordId}`;
}

// ---------------------------------------------------------------------------
// GHL: lookup helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a GHL contact by its contact ID.
 *
 * @param {string} contactId
 * @returns {Promise<object|null>}
 */
async function _ghlGetById(contactId) {
  if (!contactId || !_ghlKey()) return null;

  try {
    const resp = await fetchWithTimeout(`${GHL_API_BASE}/contacts/${contactId}`, {
      method: "GET",
      headers: _ghlHeaders()
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.contact || data || null;
  } catch (err) {
    logWarn("GHL getById failed", { contactId, error: err.message });
    return null;
  }
}

/**
 * Search GHL for a contact matching an email address.
 * Performs an exact lowercase match on the returned set
 * (same pattern as findContactByEmail in ghl-contact-service.js).
 *
 * @param {string} email - Already normalized (lowercase)
 * @returns {Promise<object|null>}
 */
async function _ghlFindByEmail(email) {
  if (!email || !_ghlKey() || !_locationId()) return null;

  try {
    const url =
      `${GHL_API_BASE}/contacts/` +
      `?locationId=${encodeURIComponent(_locationId())}` +
      `&query=${encodeURIComponent(email)}`;

    const resp = await fetchWithTimeout(url, {
      method: "GET",
      headers: _ghlHeaders()
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const contacts = data.contacts || [];
    return contacts.find(c => (c.email || "").toLowerCase() === email.toLowerCase()) || null;
  } catch (err) {
    logWarn("GHL findByEmail failed", { email, error: err.message });
    return null;
  }
}

/**
 * Search GHL for a contact matching a phone number.
 * GHL's query does broad matching; we narrow to an exact E.164 match.
 *
 * @param {string} phone - Already normalized E.164 (+15555550123)
 * @returns {Promise<object|null>}
 */
async function _ghlFindByPhone(phone) {
  if (!phone || !_ghlKey() || !_locationId()) return null;

  try {
    const url =
      `${GHL_API_BASE}/contacts/` +
      `?locationId=${encodeURIComponent(_locationId())}` +
      `&query=${encodeURIComponent(phone)}`;

    const resp = await fetchWithTimeout(url, {
      method: "GET",
      headers: _ghlHeaders()
    });
    if (!resp.ok) return null;

    const data = await resp.json();
    const contacts = data.contacts || [];

    // Normalize stored phone for comparison using the same normalizePhone util
    return (
      contacts.find(c => {
        const stored = normalizePhone(c.phone || "");
        return stored && stored === phone;
      }) || null
    );
  } catch (err) {
    logWarn("GHL findByPhone failed", { phone, error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// GHL: write helpers
// ---------------------------------------------------------------------------

/**
 * Create a new GHL contact.
 *
 * @param {object} p - { firstName, lastName, email, phone, clientMasterKey }
 * @returns {Promise<{ ok: boolean, contactId?: string, contact?: object, error?: string }>}
 */
async function _ghlCreate(p) {
  if (!_ghlKey()) return { ok: false, error: "GHL_NOT_CONFIGURED" };
  if (!_locationId()) return { ok: false, error: "GHL_LOCATION_NOT_CONFIGURED" };

  const payload = {
    locationId: _locationId(),
    firstName: p.firstName || "",
    lastName: p.lastName || "",
    email: p.email || "",
    phone: p.phone || "",
    source: "FundHub Event System",
    tags: ["lead:new"],
    customFields: p.clientMasterKey
      ? [{ key: "cf_client_master_key", field_value: p.clientMasterKey }]
      : []
  };

  try {
    const resp = await fetchWithTimeout(`${GHL_API_BASE}/contacts/`, {
      method: "POST",
      headers: _ghlHeaders(),
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logError("GHL create contact failed", new Error(text), {
        status: resp.status,
        email: p.email
      });
      return { ok: false, error: `GHL_HTTP_${resp.status}` };
    }

    const result = await resp.json();
    const contactId = result.contact?.id || result.id;
    return { ok: true, contactId, contact: result.contact || result };
  } catch (err) {
    logError("GHL create contact exception", err, { email: p.email });
    return { ok: false, error: err.message };
  }
}

/**
 * Update an existing GHL contact.
 * Only fields present in updateData are sent.
 *
 * @param {string} contactId
 * @param {object} updateData
 * @returns {Promise<{ ok: boolean, contactId?: string, contact?: object, error?: string }>}
 */
async function _ghlUpdate(contactId, updateData) {
  if (!_ghlKey()) return { ok: false, error: "GHL_NOT_CONFIGURED" };

  try {
    const resp = await fetchWithTimeout(`${GHL_API_BASE}/contacts/${contactId}`, {
      method: "PUT",
      headers: _ghlHeaders(),
      body: JSON.stringify(updateData)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logError("GHL update contact failed", new Error(text), {
        status: resp.status,
        contactId
      });
      return { ok: false, error: `GHL_HTTP_${resp.status}` };
    }

    const result = await resp.json();
    return { ok: true, contactId, contact: result.contact || result };
  } catch (err) {
    logError("GHL update contact exception", err, { contactId });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Airtable: lookup helpers
// ---------------------------------------------------------------------------

/**
 * Search CLIENTS table by a field/value pair.
 *
 * @param {string} field
 * @param {string} value
 * @returns {Promise<object|null>} Airtable record or null
 */
async function _atFindBy(field, value) {
  if (!_isAtConfigured() || !value) return null;

  try {
    const safe = String(value).replace(/"/g, '\\"');
    const formula = `{${field}} = "${safe}"`;
    const params = new URLSearchParams({ filterByFormula: formula, maxRecords: "1" });

    const resp = await fetchWithTimeout(`${_atTableUrl()}?${params}`, {
      method: "GET",
      headers: _atHeaders()
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logWarn("Airtable CLIENTS lookup failed", {
        field,
        status: resp.status,
        body: text.slice(0, 200)
      });
      return null;
    }

    const data = await resp.json();
    return data.records?.[0] || null;
  } catch (err) {
    logWarn("Airtable CLIENTS lookup exception", { field, error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Airtable: write helpers
// ---------------------------------------------------------------------------

/**
 * Create a new CLIENTS record.
 *
 * @param {object} fields
 * @returns {Promise<object>} Created record
 * @throws {Error} on API failure
 */
async function _atCreate(fields) {
  if (!_isAtConfigured()) throw new Error("Airtable not configured");

  const resp = await fetchWithTimeout(_atTableUrl(), {
    method: "POST",
    headers: _atHeaders(),
    body: JSON.stringify({ fields, typecast: true })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable CLIENTS create failed: ${resp.status} ${text.slice(0, 200)}`);
  }

  return resp.json();
}

/**
 * Patch an existing CLIENTS record.
 *
 * @param {string} recordId
 * @param {object} fields
 * @returns {Promise<object>} Updated record
 * @throws {Error} on API failure
 */
async function _atUpdate(recordId, fields) {
  if (!_isAtConfigured()) throw new Error("Airtable not configured");

  const resp = await fetchWithTimeout(_atTableUrl(recordId), {
    method: "PATCH",
    headers: _atHeaders(),
    body: JSON.stringify({ fields, typecast: true })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable CLIENTS update failed: ${resp.status} ${text.slice(0, 200)}`);
  }

  return resp.json();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * handleClientUpsert — Resolve or create a unified client record.
 *
 * Called by every downstream event handler before any child writes.
 * Implements the three-tier resolver from Spec § 6.
 *
 * @param {object} event - Full event envelope from the router
 * @param {object}  event.contact
 * @param {string} [event.contact.ghl_contact_id]
 * @param {string} [event.contact.email]
 * @param {string} [event.contact.phone]
 * @param {string} [event.contact.airtable_client_record_id]
 * @param {string} [event.contact.name]        full name hint
 * @param {string} [event.contact.first_name]  optional first name
 * @param {string} [event.contact.last_name]   optional last name
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   client_master_key: string,
 *   ghl_contact_id: string|null,
 *   airtable_client_record_id: string|null,
 *   airtable_client_url: string|null,
 *   email: string|null,
 *   phone: string|null,
 *   name: string,
 *   isNew: boolean,
 *   error?: string,
 *   message?: string
 * }>}
 */
async function handleClientUpsert(event) {
  const contact = event?.contact || {};

  // -------------------------------------------------------------------------
  // 1. Normalize inputs
  // -------------------------------------------------------------------------
  const normalizedEmail = normalizeEmail(contact.email || "");
  const normalizedPhone = normalizePhone(contact.phone || "");
  const rawGhlId = String(contact.ghl_contact_id || "").trim() || null;
  const hintAirtableId = String(contact.airtable_client_record_id || "").trim() || null;

  // Derive name components from available fields
  let firstName = String(contact.first_name || "").trim();
  let lastName = String(contact.last_name || "").trim();
  if (!firstName && contact.name) {
    const parsed = parseFullName(contact.name);
    firstName = parsed.firstName;
    lastName = parsed.lastName;
  }
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || normalizedEmail || "";

  logInfo("client-upsert: starting", {
    hasGhlId: !!rawGhlId,
    hasEmail: !!normalizedEmail,
    hasPhone: !!normalizedPhone,
    hasAirtableHint: !!hintAirtableId,
    event_id: event.event_id
  });

  // -------------------------------------------------------------------------
  // 2. Resolve GHL contact — priority order per spec § 6
  // -------------------------------------------------------------------------
  let ghlContact = null;
  let resolveMethod = null;

  // 2a — by ghl_contact_id
  if (rawGhlId) {
    ghlContact = await _ghlGetById(rawGhlId);
    if (ghlContact) {
      resolveMethod = "ghl_contact_id";
      logInfo("client-upsert: matched GHL by ghl_contact_id", { ghl_contact_id: rawGhlId });
    } else {
      // Provided ID not found in GHL — fall through (stale/invalid ID)
      logWarn("client-upsert: ghl_contact_id not found, falling through", {
        ghl_contact_id: rawGhlId
      });
    }
  }

  // 2b — by email
  if (!ghlContact && normalizedEmail) {
    ghlContact = await _ghlFindByEmail(normalizedEmail);
    if (ghlContact) {
      resolveMethod = "email";
      logInfo("client-upsert: matched GHL by email", { email: normalizedEmail });
    }
  }

  // 2c — by phone
  if (!ghlContact && normalizedPhone) {
    ghlContact = await _ghlFindByPhone(normalizedPhone);
    if (ghlContact) {
      resolveMethod = "phone";
      logInfo("client-upsert: matched GHL by phone", { phone: normalizedPhone });
    }
  }

  const isNew = !ghlContact;

  // -------------------------------------------------------------------------
  // 3. Read or generate client_master_key
  //    Prefer the value already stored on the GHL contact custom field.
  // -------------------------------------------------------------------------
  const existingCmk =
    ghlContact?.customFields?.find?.(f => f.key === "cf_client_master_key")?.field_value || null;
  const clientMasterKey = existingCmk || generateClientMasterKey();

  // -------------------------------------------------------------------------
  // 4. Create or update GHL contact
  // -------------------------------------------------------------------------
  let ghlContactId = ghlContact?.id || null;

  if (isNew) {
    logInfo("client-upsert: no GHL match, creating new contact", {
      email: normalizedEmail,
      phone: normalizedPhone,
      event_id: event.event_id
    });

    const createResult = await _ghlCreate({
      firstName,
      lastName,
      email: normalizedEmail || "",
      phone: normalizedPhone || "",
      clientMasterKey
    });

    if (!createResult.ok) {
      // GHL failure on a new contact — we can still attempt Airtable,
      // but we cannot produce a valid identity without a GHL ID.
      logError("client-upsert: GHL create failed", new Error(createResult.error), {
        event_id: event.event_id
      });
      return {
        ok: false,
        error: "GHL_CREATE_FAILED",
        message: `GHL contact creation failed: ${createResult.error}`,
        client_master_key: clientMasterKey,
        ghl_contact_id: null,
        airtable_client_record_id: null,
        airtable_client_url: null,
        email: normalizedEmail,
        phone: normalizedPhone,
        name: displayName,
        isNew: true
      };
    }

    ghlContactId = createResult.contactId;
    ghlContact = createResult.contact;
    logInfo("client-upsert: GHL contact created", { ghl_contact_id: ghlContactId });
  } else {
    // Update existing contact: fill any gaps, refresh client_master_key field
    const updatePayload = {
      customFields: [{ key: "cf_client_master_key", field_value: clientMasterKey }]
    };

    if (firstName && !ghlContact.firstName) updatePayload.firstName = firstName;
    if (lastName && !ghlContact.lastName) updatePayload.lastName = lastName;
    if (normalizedEmail && !ghlContact.email) updatePayload.email = normalizedEmail;
    if (normalizedPhone && !ghlContact.phone) updatePayload.phone = normalizedPhone;

    const updateResult = await _ghlUpdate(ghlContactId, updatePayload);
    if (!updateResult.ok) {
      // Non-fatal — contact already exists; proceed to Airtable
      logWarn("client-upsert: GHL update failed (non-fatal, continuing)", {
        ghl_contact_id: ghlContactId,
        error: updateResult.error
      });
    } else {
      logInfo("client-upsert: GHL contact updated", {
        ghl_contact_id: ghlContactId,
        resolveMethod
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. Resolve Airtable CLIENTS record
  // -------------------------------------------------------------------------
  let airtableClientRecordId = null;
  let airtableClientUrl = null;
  let atError = null;

  if (!_isAtConfigured()) {
    logWarn("client-upsert: Airtable not configured — skipping CLIENTS upsert");
  } else {
    // 5a — use the hint passed in the event envelope (caller already has the ID)
    if (hintAirtableId) {
      airtableClientRecordId = hintAirtableId;
      airtableClientUrl = buildAirtableClientUrl(airtableClientRecordId);
      logInfo("client-upsert: using caller-provided Airtable record ID", {
        airtable_client_record_id: airtableClientRecordId
      });
    }

    // 5b — search by ghl_contact_id (most stable cross-system key)
    if (!airtableClientRecordId && ghlContactId) {
      const byGhlId = await _atFindBy("ghl_contact_id", ghlContactId);
      if (byGhlId) {
        airtableClientRecordId = byGhlId.id;
        airtableClientUrl = buildAirtableClientUrl(airtableClientRecordId);
        logInfo("client-upsert: Airtable match by ghl_contact_id", {
          airtable_client_record_id: airtableClientRecordId
        });
      }
    }

    // 5c — fall back to email search in Airtable
    if (!airtableClientRecordId && normalizedEmail) {
      const byEmail = await _atFindBy("email", normalizedEmail);
      if (byEmail) {
        airtableClientRecordId = byEmail.id;
        airtableClientUrl = buildAirtableClientUrl(airtableClientRecordId);
        logInfo("client-upsert: Airtable match by email", {
          airtable_client_record_id: airtableClientRecordId
        });
      }
    }

    // Build field payload — only write non-empty values
    const atFields = {};
    if (clientMasterKey) atFields.client_master_key = clientMasterKey;
    if (ghlContactId) atFields.ghl_contact_id = ghlContactId;
    if (normalizedEmail) atFields.email = normalizedEmail;
    if (normalizedPhone) atFields.phone = normalizedPhone;
    if (firstName) atFields.first_name = firstName;
    if (lastName) atFields.last_name = lastName;
    if (displayName) atFields.name = displayName;

    // 5d — create or patch
    try {
      if (airtableClientRecordId) {
        await _atUpdate(airtableClientRecordId, atFields);
        logInfo("client-upsert: Airtable CLIENTS updated", {
          airtable_client_record_id: airtableClientRecordId
        });
      } else {
        const created = await _atCreate(atFields);
        airtableClientRecordId = created.id;
        airtableClientUrl = buildAirtableClientUrl(airtableClientRecordId);
        logInfo("client-upsert: Airtable CLIENTS created", {
          airtable_client_record_id: airtableClientRecordId
        });
      }
    } catch (err) {
      atError = err.message;
      logError("client-upsert: Airtable CLIENTS upsert failed", err, {
        event_id: event.event_id
      });
    }
  }

  // -------------------------------------------------------------------------
  // 6. Write back Airtable IDs → GHL (non-fatal if it fails)
  //    Keeps GHL contact in sync so future event lookups skip Airtable search.
  // -------------------------------------------------------------------------
  if (ghlContactId && airtableClientRecordId) {
    const writeBack = {
      customFields: [
        { key: "cf_client_master_key", field_value: clientMasterKey },
        { key: "airtable_client_record_id", field_value: airtableClientRecordId },
        { key: "airtable_client_url", field_value: airtableClientUrl || "" }
      ]
    };

    const wbResult = await _ghlUpdate(ghlContactId, writeBack);
    if (!wbResult.ok) {
      logWarn("client-upsert: GHL write-back of Airtable IDs failed (non-fatal)", {
        ghl_contact_id: ghlContactId,
        error: wbResult.error
      });
    } else {
      logInfo("client-upsert: wrote Airtable IDs to GHL contact", {
        ghl_contact_id: ghlContactId
      });
    }
  }

  // -------------------------------------------------------------------------
  // 7. Gate check — spec requires blocking child writes without an Airtable
  //    client record.  Return ok: false so callers know to abort.
  // -------------------------------------------------------------------------
  if (!airtableClientRecordId) {
    const errMsg = atError || "Airtable CLIENTS record could not be resolved or created";
    logError(
      "client-upsert: blocking child writes — no Airtable client record",
      new Error(errMsg),
      { ghl_contact_id: ghlContactId, event_id: event.event_id }
    );

    return {
      ok: false,
      error: "AIRTABLE_CLIENT_MISSING",
      message: errMsg,
      client_master_key: clientMasterKey,
      ghl_contact_id: ghlContactId,
      airtable_client_record_id: null,
      airtable_client_url: null,
      email: normalizedEmail,
      phone: normalizedPhone,
      name: displayName,
      isNew
    };
  }

  // -------------------------------------------------------------------------
  // 8. Return stable identity object
  // -------------------------------------------------------------------------
  const identity = {
    ok: true,
    client_master_key: clientMasterKey,
    ghl_contact_id: ghlContactId,
    airtable_client_record_id: airtableClientRecordId,
    airtable_client_url: airtableClientUrl,
    email: normalizedEmail,
    phone: normalizedPhone,
    name: displayName,
    isNew
  };

  logInfo("client-upsert: complete", {
    isNew,
    resolveMethod: resolveMethod || (isNew ? "created" : "airtable_only"),
    ghl_contact_id: ghlContactId,
    airtable_client_record_id: airtableClientRecordId,
    client_master_key: clientMasterKey,
    event_id: event.event_id
  });

  return identity;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// upsertClient — adapter shim for downstream handler callers
//
// Handlers call:  upsertClient(contact, adapter)
// This shim builds a minimal synthetic event envelope and delegates to
// handleClientUpsert, then normalises the return shape into camelCase
// for backward compatibility.
// ---------------------------------------------------------------------------

/**
 * Resolve or create a stable client identity.
 * Thin wrapper around handleClientUpsert for use by event handlers.
 *
 * @param {object} contact - event.contact block
 * @param {object} [adapter] - Optional adapter block
 * @returns {Promise<{
 *   ok: boolean,
 *   ghlContactId: string,
 *   airtableClientRecordId: string,
 *   airtableClientUrl: string,
 *   clientMasterKey: string,
 *   isNew: boolean,
 *   error?: string
 * }>}
 */
async function upsertClient(contact, adapter) {
  const syntheticEvent = {
    contact: contact || {},
    adapter: adapter || {},
    event_id: `shim_${Date.now()}`
  };

  const result = await handleClientUpsert(syntheticEvent);

  // Normalise property names to camelCase expected by handlers
  return {
    ok: result.ok,
    ghlContactId: result.ghl_contact_id || null,
    airtableClientRecordId: result.airtable_client_record_id || null,
    airtableClientUrl: result.airtable_client_url || null,
    clientMasterKey: result.client_master_key || null,
    isNew: result.isNew || false,
    error: result.error || result.message || undefined
  };
}

module.exports = {
  handle: handleClientUpsert,
  handleClientUpsert,
  upsertClient,
  // Exposed for unit testing
  generateClientMasterKey,
  parseFullName,
  buildAirtableClientUrl
};
