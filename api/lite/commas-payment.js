"use strict";

/**
 * POST /api/lite/commas-payment
 *
 * Commas (formerly FANBASIS) payment webhook. Commas IS the processor (replaces
 * Stripe). Register this URL in the Commas dashboard (Developer page) for events
 * `payment.succeeded` + `payment.failed` and paste the signing secret into
 * COMMAS_WEBHOOK_SECRET.
 *
 * Routing (branch on product NAME + AMOUNT, per Chris 2026-07-15):
 *   - "Business Financial Assessment" / $32  -> CRS paid gate: sets GHL crs_paid
 *       (same effect as /api/lite/crs-payment-posted) -> fires C-00.
 *   - "Consulting Services Deposit" (variable) -> deposit/onboarding: sets
 *       CLIENTS.run_inquiry_removal = true in Airtable -> BRIDGE -> AX23 ->
 *       /api/schedule-call -> Bland bureau call (Item 7).
 *   - "Consulting Success Fee" (variable) -> logged; wire the target with Chris.
 *
 * The $3,000 deposit + the success fee vary per client — never hardcode amounts;
 * we route on the product NAME and record whatever amount arrives.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ COMMAS ADAPTER (⚠️ CONFIRM against apidocs.fan or a real sandbox payload)   │
 * │ The exact webhook body field paths + signature header below are best-effort │
 * │ from standard processor conventions. Once we have a real Commas sandbox     │
 * │ payload, verify SIG_HEADER + the paths in extractEvent() and adjust only    │
 * │ that block — the routing/seam logic underneath is correct.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Auth: HMAC-SHA256 of the raw body in header `x-commas-signature` (override via
 * COMMAS_SIGNATURE_HEADER), keyed by COMMAS_WEBHOOK_SECRET. Falls back to a
 * shared Bearer secret (COMMAS_PAYMENT_SECRET || CONTEXT_FETCHER_SECRET) if no
 * signing secret is configured. Fail-closed in production if neither is set.
 */

const crypto = require("crypto");
const { logInfo, logWarn, logError } = require("./logger");
const { updateContactCustomFields } = require("./ghl-contact-service");
const { fetchWithTimeout } = require("./fetch-utils");

// NOTE: `module.exports.config` (bodyParser:false, so we can read the raw body for
// the HMAC) is set at the BOTTOM — after the handler is assigned — otherwise the
// `module.exports = handler` assignment would wipe it.

// --- Config -----------------------------------------------------------------
const SIG_HEADER = (process.env.COMMAS_SIGNATURE_HEADER || "x-commas-signature").toLowerCase();
const WEBHOOK_SECRET = process.env.COMMAS_WEBHOOK_SECRET || null;
const BEARER_SECRET =
  process.env.COMMAS_PAYMENT_SECRET || process.env.CONTEXT_FETCHER_SECRET || null;

const GHL_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const GHL_KEY = () => process.env.GHL_PRIVATE_API_KEY || process.env.GHL_API_KEY || null;
const GHL_LOCATION = () => process.env.GHL_LOCATION_ID || null;

const AIRTABLE_KEY = () => process.env.AIRTABLE_API_KEY || null;
const AIRTABLE_BASE = () => process.env.AIRTABLE_BASE_ID || null;
const AIRTABLE_CLIENTS = process.env.AIRTABLE_TABLE_CLIENTS || "CLIENTS";

// Product routing — name match is primary, amount is a secondary signal.
const PRODUCT = {
  CRS: { nameIncludes: "business financial assessment", amount: 32 },
  DEPOSIT: { nameIncludes: "consulting services deposit" },
  SUCCESS_FEE: { nameIncludes: "consulting success fee" },
  // $1,000 DIY Letters downsell (DS-02). CONFIRM the exact Commas product name
  // with Chris; amount 1000 is the fallback matcher (mirrors CRS $32).
  DIY: { nameIncludes: "diy letters", amount: 1000 }
};

const CRS_PAID_CHECKED = ["CRS Paid"]; // GHL checkbox option label, must be an array
const DIY_PAID_CHECKED = ["Yes"]; // cf_diy_paid checkbox option — CONFIRM value with Chris

// --- Raw body ---------------------------------------------------------------
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// --- Auth -------------------------------------------------------------------
function verifyAuth(req, rawBody) {
  if (WEBHOOK_SECRET) {
    const provided = String(req.headers[SIG_HEADER] || "").trim();
    if (!provided) return false;
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
    // Some processors prefix the header (e.g. "sha256=..."); accept the raw hex tail.
    const providedHex = provided.includes("=") ? provided.split("=").pop().trim() : provided;
    try {
      return crypto.timingSafeEqual(Buffer.from(providedHex, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  }
  if (BEARER_SECRET) {
    const bearer = req.headers["authorization"] || "";
    const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
    return token === BEARER_SECRET;
  }
  // No secret configured: fail-closed in prod, open in dev.
  if (process.env.NODE_ENV === "production") {
    logError("commas-payment: no COMMAS_WEBHOOK_SECRET/BEARER secret set — refusing in production");
    return false;
  }
  logWarn("commas-payment: no secret set — running unauthenticated (dev mode)");
  return true;
}

// --- COMMAS ADAPTER: normalize the webhook body into {type, name, amount, email} ---
function extractEvent(body) {
  const b = body || {};
  const d = b.data && (b.data.object || b.data) ? b.data.object || b.data : b;
  const type = String(b.type || b.event || b.event_type || d.type || "").toLowerCase();

  // amount: prefer major-unit fields; fall back to minor units (cents) / 100.
  let amount = d.amount ?? d.amount_total ?? d.total ?? d.price ?? b.amount ?? b.amount_total;
  if ((amount === undefined || amount === null) && typeof d.amount_cents === "number") {
    amount = d.amount_cents / 100;
  }
  amount = amount === undefined || amount === null || amount === "" ? null : Number(amount);
  if (Number.isNaN(amount)) amount = null;
  // NOTE (ADAPTER): amount unit (dollars vs cents) — confirm against a real Commas
  // payload. Explicit `amount_cents` is downscaled above; the main `amount` field is
  // trusted as-is. Do NOT add a >=N heuristic — deposits vary and would mis-downscale.

  // product name: try line items, product blocks, and flat fields.
  const li =
    (Array.isArray(d.line_items) && d.line_items[0]) ||
    (Array.isArray(d.items) && d.items[0]) ||
    {};
  const name =
    d.product_name ||
    (d.product && (d.product.name || d.product.title)) ||
    li.name ||
    li.product_name ||
    (li.price && li.price.product && li.price.product.name) ||
    d.name ||
    b.product_name ||
    "";

  const email =
    d.customer_email ||
    (d.customer && (d.customer.email || d.customer.email_address)) ||
    d.email ||
    d.email_address ||
    (d.billing && d.billing.email) ||
    b.email ||
    "";

  return { type, name: String(name), amount, email: String(email).trim().toLowerCase() };
}

function nameMatches(name, needle) {
  return String(name || "")
    .toLowerCase()
    .includes(needle);
}

// Pure routing decision from a normalized event. Unit-tested; keep side-effect free.
// Returns: "ignored" | "no_email" | "crs" | "deposit" | "success_fee" | "diy" | "unmatched".
function routeFor(evt) {
  if (!evt || !evt.type || !evt.type.includes("succeeded")) return "ignored";
  if (!evt.email) return "no_email";
  // Name matches take priority (most specific) so a variable-amount deposit that
  // happens to be $1,000 can't be misrouted to DIY by an amount fallback.
  if (nameMatches(evt.name, PRODUCT.CRS.nameIncludes)) return "crs";
  if (nameMatches(evt.name, PRODUCT.DIY.nameIncludes)) return "diy";
  if (nameMatches(evt.name, PRODUCT.DEPOSIT.nameIncludes)) return "deposit";
  if (nameMatches(evt.name, PRODUCT.SUCCESS_FEE.nameIncludes)) return "success_fee";
  // Amount fallbacks — only when the product name is missing/unrecognized.
  if (evt.amount === PRODUCT.CRS.amount) return "crs";
  if (evt.amount === PRODUCT.DIY.amount) return "diy";
  return "unmatched";
}

// --- GHL contact lookup by email -------------------------------------------
async function findGhlContactIdByEmail(email) {
  const key = GHL_KEY();
  const loc = GHL_LOCATION();
  if (!key || !loc || !email) return null;
  const url = `${GHL_BASE}/contacts/?locationId=${loc}&query=${encodeURIComponent(email)}`;
  try {
    const resp = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${key}`, Version: GHL_VERSION, Accept: "application/json" }
    });
    if (!resp.ok) {
      logWarn("commas-payment: GHL contact search failed", { status: resp.status });
      return null;
    }
    const json = await resp.json();
    const list = json.contacts || json.contact || [];
    const arr = Array.isArray(list) ? list : [list];
    const hit = arr.find(c => c && String(c.email || "").toLowerCase() === email);
    return (hit && hit.id) || (arr[0] && arr[0].id) || null;
  } catch (err) {
    logError("commas-payment: GHL lookup error", { error: err.message });
    return null;
  }
}

// --- Airtable CLIENTS lookup + patch ---------------------------------------
async function setClientInquiryRemovalByEmail(email) {
  const key = AIRTABLE_KEY();
  const base = AIRTABLE_BASE();
  if (!key || !base || !email) return { ok: false, error: "airtable not configured / no email" };
  const enc = encodeURIComponent(AIRTABLE_CLIENTS);
  const formula = encodeURIComponent(`LOWER({email})='${email.replace(/'/g, "\\'")}'`);
  const findUrl = `https://api.airtable.com/v0/${base}/${enc}?filterByFormula=${formula}&maxRecords=1`;
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  try {
    const findResp = await fetchWithTimeout(findUrl, { headers });
    if (!findResp.ok) return { ok: false, error: `find ${findResp.status}` };
    const found = await findResp.json();
    const rec = found.records && found.records[0];
    if (!rec) return { ok: false, error: "no CLIENTS record for email" };
    const patchUrl = `https://api.airtable.com/v0/${base}/${enc}/${rec.id}`;
    const patchResp = await fetchWithTimeout(patchUrl, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields: { run_inquiry_removal: true } })
    });
    if (!patchResp.ok) return { ok: false, error: `patch ${patchResp.status}` };
    return { ok: true, recordId: rec.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// --- Handler ----------------------------------------------------------------
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, Authorization, ${SIG_HEADER}`);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  const rawBody = await readRawBody(req);

  if (!verifyAuth(req, rawBody)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }

  const evt = extractEvent(body);
  logInfo("commas-payment: received", {
    type: evt.type,
    name: evt.name,
    amount: evt.amount,
    hasEmail: !!evt.email
  });

  // Route the event (pure decision — see routeFor, unit-tested).
  const route = routeFor(evt);
  if (route === "ignored") {
    return res.status(200).json({ ok: true, ignored: evt.type || "unknown_event" });
  }
  if (route === "no_email") {
    logWarn("commas-payment: no customer email on payment event — cannot route", {
      name: evt.name
    });
    return res.status(200).json({ ok: true, routed: "none", reason: "no_email" });
  }

  try {
    // CRS soft-pull ($32 Business Financial Assessment) -> flip crs_paid in GHL
    if (route === "crs") {
      const contactId = await findGhlContactIdByEmail(evt.email);
      if (!contactId) {
        logWarn("commas-payment: CRS paid but no GHL contact found", { email: evt.email });
        return res.status(200).json({ ok: true, routed: "crs", contact: null });
      }
      const fields = { crs_paid: CRS_PAID_CHECKED };
      if (evt.amount !== null) fields.cf_crs_charge_amount = evt.amount;
      const r = await updateContactCustomFields(contactId, fields);
      logInfo("commas-payment: crs_paid set", { contactId, ok: !!(r && r.ok) });
      return res.status(200).json({ ok: !!(r && r.ok), routed: "crs", contactId });
    }

    // $1,000 DIY Letters downsell (DS-02) -> flip cf_diy_paid in GHL.
    // Mirrors the crs_paid pattern: the handler only sets the trigger field;
    // the GHL workflow reacts (Sales Outcome, portal grant, DS-02 handoff),
    // and DS-02 fires the deliver-letters endpoint. No credit pull / charge here
    // — the $32 soft pull already happened on the call.
    if (route === "diy") {
      const contactId = await findGhlContactIdByEmail(evt.email);
      if (!contactId) {
        logWarn("commas-payment: DIY paid but no GHL contact found", { email: evt.email });
        return res.status(200).json({ ok: true, routed: "diy", contact: null });
      }
      const fields = { cf_diy_paid: DIY_PAID_CHECKED };
      if (evt.amount !== null) fields.cf_diy_charge_amount = evt.amount;
      const r = await updateContactCustomFields(contactId, fields);
      logInfo("commas-payment: cf_diy_paid set", { contactId, ok: !!(r && r.ok) });
      return res.status(200).json({ ok: !!(r && r.ok), routed: "diy", contactId });
    }

    // Consulting Services Deposit -> onboarding/funding (Item 7 bureau call)
    if (route === "deposit") {
      const r = await setClientInquiryRemovalByEmail(evt.email);
      logInfo("commas-payment: deposit -> run_inquiry_removal", { email: evt.email, ok: r.ok });
      return res.status(200).json({ ok: r.ok, routed: "deposit", ...r });
    }

    // Consulting Success Fee -> logged; target flow TBD with Chris.
    if (route === "success_fee") {
      logInfo("commas-payment: success fee received (no target wired yet)", {
        email: evt.email,
        amount: evt.amount
      });
      return res.status(200).json({ ok: true, routed: "success_fee", amount: evt.amount });
    }

    logWarn("commas-payment: unmatched product — no route", { name: evt.name, amount: evt.amount });
    return res.status(200).json({ ok: true, routed: "none", reason: "unmatched_product" });
  } catch (err) {
    logError("commas-payment: unhandled error", { error: err.message });
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
};

// Exported for unit tests (pure, side-effect free).
module.exports.extractEvent = extractEvent;
module.exports.routeFor = routeFor;
module.exports.nameMatches = nameMatches;

// Disable Vercel's body parser so readRawBody() can compute the HMAC over the
// exact bytes Commas signed. MUST be after the handler assignment above.
module.exports.config = { api: { bodyParser: false } };
