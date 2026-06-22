"use strict";

/**
 * POST /api/lite/behavior-score
 * Auth: CONTEXT_FETCHER_SECRET (Bearer or x-context-fetcher-secret header)
 *
 * Body { contactId: string } — single recompute
 * Body { sweep: true }       — batch all contacts in CONVERSATION_MESSAGES
 */

const { logInfo, logWarn, logError } = require("./logger");
const { fetchWithTimeout } = require("./fetch-utils");
const { scoreContact } = require("./behavior-scoring/score-contact");

// ─── Auth (mirrors context-fetcher.js) ────────────────────────────────────────

function validateAuth(req) {
  const secret = process.env.CONTEXT_FETCHER_SECRET;
  if (!secret) {
    logWarn("behavior-score: CONTEXT_FETCHER_SECRET not set — dev mode");
    return { ok: true };
  }
  const bearer = req.headers["authorization"] || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
  const header = req.headers["x-context-fetcher-secret"] || null;
  if ((token && token === secret) || (header && header === secret)) return { ok: true };
  return { ok: false };
}

// ─── Batch: get distinct contact_ids ─────────────────────────────────────────

async function getAllContactIds() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID || "appXsq65yB9VuNup5";
  const table = process.env.AIRTABLE_TABLE_CONVERSATION_MESSAGES || "tblPL17FxHaZrCxt4";

  if (!apiKey) throw new Error("AIRTABLE_API_KEY not set");

  const seen = new Set();
  let offset = null;

  do {
    const params = new URLSearchParams({ pageSize: "100" });
    params.append("fields[]", "contact_id"); // Airtable expects fields[] (bracketed), not fields
    if (offset) params.set("offset", offset);

    const resp = await fetchWithTimeout(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}?${params}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!resp.ok) throw new Error(`Airtable list failed: ${resp.status}`);
    const data = await resp.json();
    for (const rec of data.records || []) {
      const cid = rec.fields && rec.fields.contact_id;
      if (cid) seen.add(cid);
    }
    offset = data.offset || null;
  } while (offset);

  return [...seen];
}

// ─── Sweep logic (exported for cron reuse) ───────────────────────────────────

/**
 * Run the full batch sweep: fetch all distinct contact_ids and score each one.
 * Returns { scored, errors } counts. Does NOT write to res — safe to call from
 * any context (POST handler or GET cron).
 *
 * @returns {Promise<{ scored: number, errors: number }>}
 */
async function runSweep() {
  logInfo("behavior-score: sweep started");
  const contactIds = await getAllContactIds();

  let scored = 0;
  let errors = 0;

  for (const contactId of contactIds) {
    try {
      const r = await scoreContact(contactId);
      if (r.ok) {
        scored++;
      } else {
        errors++;
      }
    } catch (err) {
      logError("behavior-score: sweep single failed", err, { contactId });
      errors++;
    }
  }

  logInfo("behavior-score: sweep complete", { scored, errors });
  return { scored, errors };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-context-fetcher-secret"
    );
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const auth = validateAuth(req);
  if (!auth.ok) {
    logWarn("behavior-score: unauthorized");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const body = req.body || {};

  // ── Batch sweep ──────────────────────────────────────────────────────────
  if (body.sweep === true) {
    try {
      const { scored, errors } = await runSweep();
      return res.status(200).json({ ok: true, sweep: true, scored, errors });
    } catch (err) {
      logError("behavior-score: sweep failed", err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ── Single recompute ──────────────────────────────────────────────────────
  const { contactId } = body;
  if (!contactId) {
    return res.status(400).json({ ok: false, error: "contactId is required" });
  }

  try {
    const result = await scoreContact(contactId);
    return res.status(200).json(result);
  } catch (err) {
    logError("behavior-score: score failed", err, { contactId });
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// Export sweep function for reuse by the cron endpoint
module.exports.runSweep = runSweep;
