"use strict";

/**
 * POST /api/lite/context-fetcher
 *
 * GHL Agent Context Fetcher — assembles a full-fidelity "chart" object for a
 * contact at conversation time. Used by GHL Voice AI Custom Actions /
 * Conversation AI V3 Custom Webhooks.
 *
 * Request: { contactId: string, behavioral?: object }
 * Response: full chart object (see return shape below)
 *
 * Behavioral scores live in GHL custom fields, NOT Airtable. This endpoint
 * uses them from the request payload when the caller provides them; otherwise it
 * reads them live from the GHL contact via getGHLContact(). A GHL read failure
 * degrades to behavioral: null (the request never fails).
 *
 * Behavioral object shape (NEW Behavior Scoring engine fields — primary):
 *   {
 *     responsiveness:    number 0-100  (behavior_responsiveness)
 *     engagement:        number 0-100  (behavior_engagement)
 *     friction:          number 0-100  (HIGH=bad; behavior_friction)
 *     intent:            number 0-100  (behavior_intent)
 *     motivation_label:  string        speed|relief|growth|certainty|control
 *     composite:         number 0-100  (behavior_composite)
 *     confidence:        string        high|provisional
 *     scored:            boolean       true = new engine has run for this contact
 *   }
 *
 * LEGACY FALLBACK (when new behavior_* fields absent — scorer not yet run):
 *   responsiveness, friction_level, motivation_label mapped from
 *   customer_responsiveness, customer_friction_level, primary_motivation.
 *   scored: false in this case.
 *
 * Optimization findings: the full UnderwriteIQ findings array is persisted to
 * Airtable as latest_optimization_findings_full (JSON, written at CRS sync
 * time). When present, optimization_suggestions is built from it and
 * optimization_suggestions_complete is true. When absent, it falls back to the
 * abbreviated latest_top_fixes text with optimization_suggestions_complete false.
 */

const { logInfo, logWarn, logError } = require("./logger");
const { fetchWithTimeout } = require("./fetch-utils");
const { getGHLContact } = require("./ghl-contact-service");

// ---------------------------------------------------------------------------
// Auth — shared secret guard
//
// Accepts the secret via:
//   Authorization: Bearer <CONTEXT_FETCHER_SECRET>
//   x-context-fetcher-secret: <CONTEXT_FETCHER_SECRET>
//
// If CONTEXT_FETCHER_SECRET is not set, auth is skipped (dev/local mode).
// ---------------------------------------------------------------------------

function validateContextFetcherAuth(req) {
  const secret = process.env.CONTEXT_FETCHER_SECRET;

  if (!secret) {
    logWarn(
      "context-fetcher: CONTEXT_FETCHER_SECRET is not set — running unauthenticated (dev mode)"
    );
    return { ok: true };
  }

  const bearerHeader = req.headers["authorization"] || "";
  const token = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7).trim() : null;
  const headerSecret = req.headers["x-context-fetcher-secret"] || null;

  if ((token && token === secret) || (headerSecret && headerSecret === secret)) {
    return { ok: true };
  }

  return { ok: false };
}

// ---------------------------------------------------------------------------
// Airtable config — reuse same pattern as crs/airtable-sync.js
// ---------------------------------------------------------------------------

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || "appXsq65yB9VuNup5";
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";

// Table names
const TABLE_CLIENTS = process.env.AIRTABLE_TABLE_CLIENTS || "CLIENTS";
const TABLE_SNAPSHOTS = process.env.AIRTABLE_TABLE_SNAPSHOTS || "SNAPSHOTS";
const TABLE_FUNDING_ROUNDS = process.env.AIRTABLE_TABLE_FUNDING_ROUNDS || "FUNDING_ROUNDS";
const TABLE_INQUIRY_LOG = process.env.AIRTABLE_TABLE_INQUIRY_LOG || "INQUIRY_LOG";
const TABLE_PERSONAL_TRADELINES =
  process.env.AIRTABLE_TABLE_PERSONAL_TRADELINES || "PERSONAL_TRADELINES";
const TABLE_BUSINESS_TRADELINES =
  process.env.AIRTABLE_TABLE_BUSINESS_TRADELINES || "BUSINESS_TRADELINES";
// CONVERSATION_MESSAGES uses a stable table ID (not a name) to avoid rename breakage
const TABLE_CONVERSATION_MESSAGES =
  process.env.AIRTABLE_TABLE_CONVERSATION_MESSAGES || "tblPL17FxHaZrCxt4";

function isConfigured() {
  return !!(AIRTABLE_API_KEY && AIRTABLE_BASE_ID);
}

function apiUrl(table, recordId) {
  const encoded = encodeURIComponent(table);
  return recordId
    ? `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encoded}/${recordId}`
    : `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encoded}`;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${AIRTABLE_API_KEY}`,
    "Content-Type": "application/json"
  };
}

async function atFind(table, filterFormula, maxRecords = 100) {
  const params = new URLSearchParams({
    filterByFormula: filterFormula,
    maxRecords: String(maxRecords)
  });
  const resp = await fetchWithTimeout(`${apiUrl(table)}?${params}`, {
    method: "GET",
    headers: authHeaders()
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable find [${table}] failed: ${resp.status} ${text.substring(0, 200)}`);
  }
  const data = await resp.json();
  return data.records || [];
}

// ---------------------------------------------------------------------------
// client_status derivation
//
// Priority order (highest wins):
//   1. funded      — funding_complete is truthy
//   2. repair      — Next Action Badge contains "repair" OR
//                    latest_underwriteiq_outcome contains "repair"
//   3. funding     — latest_underwriteiq_outcome contains "funding" or "approved"
//                    OR any active FUNDING_ROUNDS records exist
//   4. lead        — fallback
//
// "past" is a re-engagement variant of "funded" — we set it when funding_complete
// is true AND the caller is clearly reaching out again (future iteration can
// detect that from conversation recency; for now we always use "funded").
// ---------------------------------------------------------------------------

function deriveClientStatus(fields, hasFundingRounds) {
  const badge = (fields["Next Action Badge"] || "").toLowerCase();
  const outcome = (fields["latest_underwriteiq_outcome"] || "").toLowerCase();
  const complete = fields["funding_complete"];

  if (complete) return "funded";
  if (badge.includes("repair") || outcome.includes("repair")) return "repair";
  if (outcome.includes("funding") || outcome.includes("approved") || hasFundingRounds) {
    return "funding";
  }
  return "lead";
}

// awareness_level is derived AFTER client_status is known
function deriveAwarenessLevel(clientStatus, primaryFico, prequal) {
  if (clientStatus === "funded" || clientStatus === "past") return "L3";
  if (clientStatus === "funding" || clientStatus === "repair") return "L2";
  if (primaryFico || prequal) return "L1";
  return "L0";
}

// Split a multiline text field into a trimmed, non-empty string array
function splitMultiline(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
}

// Build a flat, prompt-ready text summary of the chart. GHL agent prompts
// consume a single text variable far more reliably than deep nested JSON, so
// this is the field to map into the agent's context in the GHL webhook node.
function buildAgentContextText(chart) {
  const c = chart.contact || {};
  const cr = chart.credit || {};
  const b = chart.behavioral || {};
  const lines = [];

  lines.push(
    `Contact: ${c.name || "Unknown"} (status: ${c.client_status || "?"}, awareness: ${c.awareness_level || "?"}).`
  );

  const creditBits = [];
  if (cr.primary_fico) creditBits.push(`FICO ${cr.primary_fico}`);
  if (cr.prequal_amount) creditBits.push(`prequal $${cr.prequal_amount}`);
  if (cr.preapproved_amount) creditBits.push(`preapproved $${cr.preapproved_amount}`);
  if (cr.utilization) creditBits.push(`utilization ${cr.utilization}`);
  if (cr.recommendation) creditBits.push(`recommendation: ${cr.recommendation}`);
  if (creditBits.length) lines.push(`Credit: ${creditBits.join(", ")}.`);

  if (Array.isArray(cr.optimization_suggestions) && cr.optimization_suggestions.length) {
    lines.push(`Top fixes: ${cr.optimization_suggestions.slice(0, 5).join("; ")}.`);
  }

  if (Array.isArray(chart.funding_history) && chart.funding_history.length) {
    const fh = chart.funding_history
      .map(r =>
        `round ${r.round || "?"} ${r.outcome || ""} ${r.amount ? "$" + r.amount : ""}`.trim()
      )
      .join("; ");
    lines.push(`Funding history: ${fh}.`);
  }

  const behaviorBits = [];
  if (b.responsiveness != null) behaviorBits.push(`responsiveness ${b.responsiveness}`);
  if (b.engagement != null) behaviorBits.push(`engagement ${b.engagement}`);
  if (b.friction != null) behaviorBits.push(`friction ${b.friction} (high=bad)`);
  if (b.intent != null) behaviorBits.push(`intent ${b.intent}`);
  if (b.motivation_label) behaviorBits.push(`motivation: ${b.motivation_label}`);
  if (behaviorBits.length) lines.push(`Behavior: ${behaviorBits.join(", ")}.`);

  const convo = Array.isArray(chart.conversation) ? chart.conversation : [];
  if (convo.length) {
    const recent = convo
      .slice(-6)
      .map(
        m =>
          `${m.role === "contact" ? "Them" : "Us"}: ${(m.text || "").replace(/\s+/g, " ").trim().slice(0, 200)}`
      )
      .join("\n");
    lines.push(`Recent conversation:\n${recent}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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

  const authResult = validateContextFetcherAuth(req);
  if (!authResult.ok) {
    logWarn("context-fetcher: unauthorized request");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (!isConfigured()) {
    logError("context-fetcher: Airtable not configured");
    return res.status(500).json({ ok: false, error: "Airtable not configured" });
  }

  const body = req.body;
  if (!body || !body.contactId) {
    return res.status(400).json({ ok: false, error: "contactId is required" });
  }

  const { contactId, behavioral: behavioralFromPayload } = body;

  // Strict allowlist — GHL contact ids are alphanumeric. Rejecting anything else
  // prevents Airtable formula injection via the filterByFormula strings below.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(contactId)) {
    return res.status(400).json({ ok: false, error: "Invalid contactId" });
  }

  logInfo("context-fetcher: request", { contactId });

  try {
    // -----------------------------------------------------------------------
    // 1. Fetch CLIENTS record by ghl_contact_id
    // -----------------------------------------------------------------------
    // Defense-in-depth: escape backslashes before quotes (allowlist already
    // blocks both, but keep the formula-safe escaping in case it ever loosens).
    const escaped = contactId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const clientRecords = await atFind(TABLE_CLIENTS, `{ghl_contact_id} = "${escaped}"`, 1);

    if (!clientRecords.length) {
      logWarn("context-fetcher: contact not found", { contactId });
      return res.status(404).json({ ok: false, error: "Contact not found" });
    }

    const clientRec = clientRecords[0];
    const cf = clientRec.fields;

    // -----------------------------------------------------------------------
    // 2. Linked record IDs
    // -----------------------------------------------------------------------
    const snapshotIds = cf["SNAPSHOTS 2"] || [];
    const fundingRoundIds = cf["FUNDING_ROUNDS 2"] || [];
    const inquiryLogIds = cf["INQUIRY_LOG"] || [];
    const personalTradelineIds = cf["PERSONAL_TRADELINES"] || [];
    const businessTradelineIds = cf["BUSINESS_TRADELINES"] || [];

    // -----------------------------------------------------------------------
    // 3. Parallel fetches
    // -----------------------------------------------------------------------
    const [snapshots, fundingRounds, inquiries, personalTradelines, businessTradelines, messages] =
      await Promise.all([
        fetchLinked(TABLE_SNAPSHOTS, snapshotIds),
        fetchLinked(TABLE_FUNDING_ROUNDS, fundingRoundIds),
        fetchLinked(TABLE_INQUIRY_LOG, inquiryLogIds),
        fetchLinked(TABLE_PERSONAL_TRADELINES, personalTradelineIds),
        fetchLinked(TABLE_BUSINESS_TRADELINES, businessTradelineIds),
        atFind(TABLE_CONVERSATION_MESSAGES, `{contact_id} = "${escaped}"`, 1000)
      ]);

    // -----------------------------------------------------------------------
    // 4. Primary snapshot (is_primary = true, else most recent by date)
    // -----------------------------------------------------------------------
    const primarySnap =
      snapshots.find(r => r.fields["is_primary"]) ||
      snapshots.sort(
        (a, b) =>
          new Date(b.fields["snapshot_date"] || 0) - new Date(a.fields["snapshot_date"] || 0)
      )[0] ||
      null;

    const snapF = primarySnap ? primarySnap.fields : {};

    const primaryFico = snapF["EX FICO"] || snapF["TU FICO"] || snapF["EQ FICO"] || null;

    const utilization = snapF["EX Util"] || snapF["TU Util"] || snapF["EQ Util"] || null;

    // -----------------------------------------------------------------------
    // 5. client_status + awareness_level
    // -----------------------------------------------------------------------
    const clientStatus = deriveClientStatus(cf, fundingRoundIds.length > 0);
    const prequal = cf["Prequal"] || null;
    const awarenessLevel = deriveAwarenessLevel(clientStatus, primaryFico, prequal);

    // -----------------------------------------------------------------------
    // 6. Build negatives from inquiry log + snapshot neg counts
    // -----------------------------------------------------------------------
    const negatives = inquiries
      .filter(r => r.fields["is_open"])
      .map(r => ({
        bureau: r.fields["bureau"] || null,
        name: r.fields["inquiry_name"] || null,
        detected: r.fields["Detected Date"] || null,
        status: r.fields["Status"] || null
      }));

    // -----------------------------------------------------------------------
    // 7. optimization_suggestions — full findings when available, top_fixes fallback
    // -----------------------------------------------------------------------
    let optimization_suggestions;
    let optimization_suggestions_complete;

    const fullFindingsJson = cf["latest_optimization_findings_full"];
    if (fullFindingsJson) {
      try {
        const parsed = JSON.parse(fullFindingsJson);
        optimization_suggestions = parsed.map(
          f => `${f.code}: ${f.plainEnglishProblem} — ${f.whatToDoNext}`
        );
        optimization_suggestions_complete = true;
      } catch (_e) {
        // Malformed JSON — fall back to top_fixes
        optimization_suggestions = splitMultiline(cf["latest_top_fixes"]);
        optimization_suggestions_complete = false;
      }
    } else {
      optimization_suggestions = splitMultiline(cf["latest_top_fixes"]);
      optimization_suggestions_complete = false;
    }

    // -----------------------------------------------------------------------
    // 8. Tradelines
    // -----------------------------------------------------------------------
    const tradelines = [
      ...personalTradelines.map(r => ({ ...r.fields, _type: "personal" })),
      ...businessTradelines.map(r => ({ ...r.fields, _type: "business" }))
    ];

    // -----------------------------------------------------------------------
    // 9. Best preapproval amount from funding rounds
    // -----------------------------------------------------------------------
    const preapprovedAmount =
      fundingRounds.reduce((max, r) => {
        const amt = r.fields["preapproval_amount"] || 0;
        return amt > max ? amt : max;
      }, 0) || null;

    // -----------------------------------------------------------------------
    // 10. files from report URLs on CLIENTS record
    // -----------------------------------------------------------------------
    const files = [];
    if (cf["raw_report_url_latest"])
      files.push({ type: "raw_report", location: cf["raw_report_url_latest"] });
    if (cf["latest_raw_personal_report_url"])
      files.push({ type: "raw_report", location: cf["latest_raw_personal_report_url"] });
    if (cf["latest_raw_business_report_url"])
      files.push({ type: "raw_report", location: cf["latest_raw_business_report_url"] });
    // Snapshot raw report URLs
    for (const snap of snapshots) {
      if (snap.fields["Raw Report URL"]) {
        files.push({ type: "raw_report", location: snap.fields["Raw Report URL"] });
      }
    }

    // -----------------------------------------------------------------------
    // 11. funding_history
    // -----------------------------------------------------------------------
    const funding_history = fundingRounds.map(r => ({
      round: r.fields["Round #"] || null,
      amount: r.fields["preapproval_amount"] || null,
      outcome: r.fields["underwriteiq_outcome"] || r.fields["Stage"] || null,
      date: r.fields["funded_date"] || r.fields["declined_date"] || null
    }));

    // -----------------------------------------------------------------------
    // 12. conversation — full verbatim log, sorted ts asc
    // -----------------------------------------------------------------------
    const conversation = messages
      // Exclude GHL internal-activity records (channel "other") — these are
      // system notifications, not real customer/agent messages. They remain in
      // the store for fidelity but must not feed the agent as conversation.
      .filter(r => r.fields["channel"] && r.fields["channel"] !== "other")
      .map(r => ({
        role: r.fields["direction"] === "inbound" ? "contact" : "agent",
        channel: r.fields["channel"] || null,
        text: r.fields["body"] || null,
        ts: r.fields["timestamp"] || null
      }))
      .sort((a, b) => {
        if (!a.ts) return 1;
        if (!b.ts) return -1;
        return new Date(a.ts) - new Date(b.ts);
      });

    // -----------------------------------------------------------------------
    // 13. recommendation
    // -----------------------------------------------------------------------
    const outcome = (cf["latest_underwriteiq_outcome"] || "").toLowerCase();
    let recommendation = "repair";
    if (outcome.includes("funding") || outcome.includes("approved")) recommendation = "funding";
    else if (outcome.includes("disqualified") || outcome.includes("decline"))
      recommendation = "disqualified";

    // -----------------------------------------------------------------------
    // 14. Behavioral scores — payload wins; fall back to GHL custom fields
    //
    // Primary: new Behavior Scoring engine fields (behavior_*).
    // Fallback: legacy fields (customer_responsiveness, customer_friction_level,
    // primary_motivation) when the scorer hasn't run yet.
    // scored: true  → new engine fields were present
    // scored: false → legacy fallback was used
    // -----------------------------------------------------------------------
    let behavioral = null;

    if (behavioralFromPayload) {
      behavioral = behavioralFromPayload;
    } else {
      try {
        const ghlResult = await getGHLContact(contactId);
        if (ghlResult.ok && ghlResult.contact) {
          const customFields = ghlResult.contact.customFields || [];
          const byKey = {};
          for (const f of customFields) {
            const k = f.fieldKey || f.key || f.id;
            if (k) byKey[k] = f.value ?? null;
          }

          // Detect whether the new scorer has run: any new behavior_* field present
          const newResponsiveness = byKey["behavior_responsiveness"] ?? null;
          const newEngagement = byKey["behavior_engagement"] ?? null;
          const newFriction = byKey["behavior_friction"] ?? null;
          const newIntent = byKey["behavior_intent"] ?? null;
          const newMotivationLabel = byKey["behavior_motivation_label"] ?? null;
          const newComposite = byKey["behavior_composite"] ?? null;
          const newConfidence = byKey["behavior_confidence"] ?? null;

          const scored =
            newResponsiveness !== null ||
            newEngagement !== null ||
            newFriction !== null ||
            newIntent !== null ||
            newMotivationLabel !== null ||
            newComposite !== null ||
            newConfidence !== null;

          if (scored) {
            behavioral = {
              responsiveness: newResponsiveness,
              engagement: newEngagement,
              friction: newFriction,
              intent: newIntent,
              motivation_label: newMotivationLabel,
              composite: newComposite,
              confidence: newConfidence,
              scored: true
            };
          } else {
            // Legacy fallback — scorer hasn't run for this contact yet
            behavioral = {
              responsiveness: byKey["customer_responsiveness"] ?? null,
              friction_level: byKey["customer_friction_level"] ?? null,
              motivation_label: byKey["primary_motivation"] ?? null,
              scored: false
            };
          }
        } else {
          logWarn("context-fetcher: GHL contact read failed, behavioral=null", {
            contactId,
            error: ghlResult.error
          });
        }
      } catch (ghlErr) {
        logWarn("context-fetcher: GHL contact read threw, behavioral=null", {
          contactId,
          error: ghlErr.message
        });
      }
    }

    // -----------------------------------------------------------------------
    // 15. Assemble chart
    // -----------------------------------------------------------------------
    const chart = {
      contact: {
        name: cf["Client Name"] || null,
        email: cf["email"] || null,
        phone: cf["phone"] || null,
        pipeline_stage: cf["Next Action Badge"] || null,
        client_status: clientStatus,
        awareness_level: awarenessLevel
      },
      credit: {
        primary_fico: primaryFico,
        prequal_amount: prequal,
        preapproved_amount: preapprovedAmount,
        recommendation,
        utilization,
        tradelines,
        negatives,
        optimization_suggestions,
        optimization_suggestions_complete
      },
      files,
      funding_history,
      behavioral,
      conversation
    };

    logInfo("context-fetcher: chart assembled", {
      contactId,
      clientStatus,
      awarenessLevel,
      snapshots: snapshots.length,
      fundingRounds: fundingRounds.length,
      messages: messages.length
    });

    // Flat prompt-ready summary — map THIS single field into the GHL agent.
    const agent_context_text = buildAgentContextText(chart);

    return res.status(200).json({ ok: true, agent_context_text, chart });
  } catch (err) {
    logError("context-fetcher: unhandled error", { contactId, error: err.message });
    return res.status(500).json({ ok: false, error: "Internal server error" });
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchLinked(table, ids) {
  if (!ids || ids.length === 0) return [];
  // Airtable linked fields give us record IDs — use RECORD_ID() OR formula
  // Build: OR(RECORD_ID()="recA", RECORD_ID()="recB", ...)
  const clauses = ids.map(id => `RECORD_ID()="${id}"`).join(",");
  const formula = ids.length === 1 ? `RECORD_ID()="${ids[0]}"` : `OR(${clauses})`;
  try {
    return await atFind(table, formula, ids.length);
  } catch (err) {
    logWarn(`context-fetcher: linked fetch failed for ${table}`, { error: err.message });
    return [];
  }
}

// Export internals for testing
module.exports.deriveClientStatus = deriveClientStatus;
module.exports.deriveAwarenessLevel = deriveAwarenessLevel;
module.exports.splitMultiline = splitMultiline;
module.exports.validateContextFetcherAuth = validateContextFetcherAuth;
