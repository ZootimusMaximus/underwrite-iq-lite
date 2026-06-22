"use strict";

/**
 * Orchestrator: fetch → extract → trajectory → score → write GHL + Airtable.
 */

const { fetchWithTimeout } = require("../fetch-utils");
const { logInfo, logWarn, logError } = require("../logger");
const { extractSignals } = require("./signal-extractor");
const {
  computeResponsiveness,
  computeEngagement,
  computeFriction,
  computeIntent,
  computeComposite
} = require("./scorer");
const { computeTrajectory } = require("./trajectory");

// ─── Airtable config (mirrors context-fetcher.js pattern) ─────────────────────

const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const TABLE_CONVERSATION_MESSAGES =
  process.env.AIRTABLE_TABLE_CONVERSATION_MESSAGES || "tblPL17FxHaZrCxt4";
const TABLE_BEHAVIOR_SCORES = process.env.AIRTABLE_TABLE_BEHAVIOR_SCORES || "tblqEaS76g3b4l4tM";
const TABLE_CLIENTS = process.env.AIRTABLE_TABLE_CLIENTS || "CLIENTS";
const TABLE_FUNDING_ROUNDS = process.env.AIRTABLE_TABLE_FUNDING_ROUNDS || "FUNDING_ROUNDS";

function getAirtableBase() {
  return process.env.AIRTABLE_BASE_ID || "appXsq65yB9VuNup5";
}

function atUrl(table) {
  return `${AIRTABLE_API_BASE}/${getAirtableBase()}/${encodeURIComponent(table)}`;
}

function atHeaders() {
  return {
    Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
    "Content-Type": "application/json"
  };
}

async function atFind(table, filterFormula, maxRecords = 200) {
  const params = new URLSearchParams({
    filterByFormula: filterFormula,
    maxRecords: String(maxRecords)
  });
  const resp = await fetchWithTimeout(`${atUrl(table)}?${params}`, {
    method: "GET",
    headers: atHeaders()
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable ${table} query failed: ${resp.status} ${text.substring(0, 200)}`);
  }
  const data = await resp.json();
  return data.records || [];
}

async function atCreate(table, fields) {
  const resp = await fetchWithTimeout(atUrl(table), {
    method: "POST",
    headers: atHeaders(),
    body: JSON.stringify({ fields })
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Airtable ${table} create failed: ${resp.status} ${text.substring(0, 200)}`);
  }
  return resp.json();
}

// ─── GHL write ────────────────────────────────────────────────────────────────

async function writeGHLBehaviorFields(contactId, scores) {
  const key = process.env.GHL_PRIVATE_API_KEY || process.env.GHL_API_KEY;
  if (!key) {
    logWarn("score-contact: GHL key not configured, skipping GHL write");
    return { ok: false, error: "No GHL key" };
  }

  const base = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
  const url = `${base}/contacts/${contactId}`;

  const customFields = [
    { key: "behavior_responsiveness", field_value: String(scores.responsiveness.score) },
    { key: "behavior_engagement", field_value: String(scores.engagement.score) },
    { key: "behavior_friction", field_value: String(scores.friction.score) },
    { key: "behavior_intent", field_value: String(scores.intent.score) },
    { key: "behavior_motivation_label", field_value: scores.intent.motivation_label || "" },
    { key: "behavior_composite", field_value: String(scores.composite) },
    { key: "behavior_confidence", field_value: scores.confidence_label }
  ];

  try {
    const resp = await fetchWithTimeout(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Version: "2021-07-28"
      },
      body: JSON.stringify({ customFields })
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `GHL update failed: ${resp.status} ${text.substring(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    logError("score-contact: GHL write error", err, { contactId });
    return { ok: false, error: err.message };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} contactId - GHL contact ID
 * @param {Date|number} [referenceDate] - for deterministic scoring (defaults to now)
 */
async function scoreContact(contactId, referenceDate) {
  // Strict allowlist — GHL contact ids are alphanumeric. Blocks Airtable formula
  // injection through the filterByFormula strings built below.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(contactId || "")) {
    return { ok: false, error: "Invalid contactId" };
  }
  const now = referenceDate ? new Date(referenceDate) : new Date();
  const nowMs = now.getTime();
  // Defense-in-depth: escape backslashes before quotes (allowlist already blocks both).
  const escaped = contactId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  logInfo("score-contact: starting", { contactId });

  // ── 1. Fetch datalake ──────────────────────────────────────────────────────
  // FUNDING_ROUNDS has no contact field — it links to CLIENTS via "Client".
  // So fetch it via the CLIENTS record's linked "FUNDING_ROUNDS 2" record IDs
  // (same approach as context-fetcher.js), not by a ghl_contact_id filter.
  const [messageRecords, clientRecords, behaviorHistory] = await Promise.all([
    atFind(TABLE_CONVERSATION_MESSAGES, `{contact_id} = "${escaped}"`, 1000),
    atFind(TABLE_CLIENTS, `{ghl_contact_id} = "${escaped}"`, 1),
    atFind(TABLE_BEHAVIOR_SCORES, `{contact_id} = "${escaped}"`, 50)
  ]);

  const fundingRoundIds = (clientRecords[0] && clientRecords[0].fields["FUNDING_ROUNDS 2"]) || [];
  let fundingRecords = [];
  if (fundingRoundIds.length) {
    const formula =
      fundingRoundIds.length === 1
        ? `RECORD_ID()="${fundingRoundIds[0]}"`
        : `OR(${fundingRoundIds.map(id => `RECORD_ID()="${id}"`).join(",")})`;
    fundingRecords = await atFind(TABLE_FUNDING_ROUNDS, formula, fundingRoundIds.length);
  }

  const messages = messageRecords.map(r => r.fields);
  const clients = clientRecords.map(r => r.fields);
  const fundingRounds = fundingRecords.map(r => ({ ...r.fields, created_time: r.createdTime }));
  const historyFields = behaviorHistory.map(r => r.fields);

  // ── 2. Extract signals ────────────────────────────────────────────────────
  const signals = extractSignals(messages, clients, fundingRounds, now);

  // ── 3. Score each dimension ───────────────────────────────────────────────
  const responsiveness = computeResponsiveness(
    {
      median_reply_time_hours: signals.median_reply_time_hours,
      reply_rate: signals.reply_rate,
      action_latency_hours: signals.action_latency_hours,
      ghost_streak: signals.ghost_streak
    },
    nowMs
  );

  const engagement = computeEngagement(
    {
      inbound_initiated: signals.inbound_initiated,
      content_depth: signals.content_depth,
      video_watch_pct: signals.video_watch_pct,
      click_rate: signals.click_rate,
      open_rate: signals.open_rate
    },
    nowMs
  );

  const friction = computeFriction({ events: signals.friction_events }, nowMs);

  const intent = computeIntent(
    {
      intent_actions: signals.intent_actions,
      message_bodies: signals.message_bodies,
      stated_goal_urgency: signals.stated_goal_urgency || null,
      objection_vs_interest: signals.objection_vs_interest || null
    },
    nowMs
  );

  // ── 4. Trajectory ─────────────────────────────────────────────────────────
  const trajectory = computeTrajectory(historyFields, now);

  // ── 5. Composite ──────────────────────────────────────────────────────────
  const { composite, top_signals, overall_confidence, confidence_label } = computeComposite({
    responsiveness,
    engagement,
    friction,
    intent
  });

  const scorePayload = {
    responsiveness,
    engagement,
    friction,
    intent,
    composite,
    top_signals,
    overall_confidence,
    confidence_label,
    trajectory
  };

  // ── 6. Write GHL ──────────────────────────────────────────────────────────
  const ghlResult = await writeGHLBehaviorFields(contactId, {
    responsiveness,
    engagement,
    friction,
    intent,
    composite,
    confidence_label
  }).catch(err => ({ ok: false, error: err.message }));

  if (!ghlResult.ok) {
    logWarn("score-contact: GHL write failed (non-fatal)", { contactId, error: ghlResult.error });
  }

  // ── 7. Write BEHAVIOR_SCORES history ─────────────────────────────────────
  const historyRecord = {
    contact_id: contactId,
    ts: now.toISOString(),
    responsiveness: responsiveness.score,
    responsiveness_tier: responsiveness.tier,
    engagement: engagement.score,
    engagement_tier: engagement.tier,
    friction: friction.score,
    friction_tier: friction.tier,
    intent: intent.score,
    intent_tier: intent.tier,
    motivation_label: intent.motivation_label || "",
    composite,
    confidence: overall_confidence,
    trajectory: trajectory.direction,
    top_signals: JSON.stringify(top_signals)
  };

  await atCreate(TABLE_BEHAVIOR_SCORES, historyRecord).catch(err => {
    logWarn("score-contact: Airtable history write failed (non-fatal)", {
      contactId,
      error: err.message
    });
  });

  logInfo("score-contact: complete", { contactId, composite, trajectory: trajectory.direction });

  return { ok: true, contactId, scores: scorePayload };
}

module.exports = { scoreContact };
