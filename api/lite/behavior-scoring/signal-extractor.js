"use strict";

/**
 * Turns raw Airtable rows into typed signal inputs for scorer.js.
 * Pure function — no network calls.
 *
 * Signal sources:
 *   CONVERSATION_MESSAGES fields: contact_id, channel, direction, body, timestamp, message_type
 *   CLIENTS fields: collections (→ collections_chargeback_failed_payment), no_show, missing_late_docs, ops_action_required
 *   FUNDING_ROUNDS fields: reschedule (→ reschedule event), booked_call_at (→ intent action), funded_date (→ action latency)
 *   INQUIRY_LOG: used for context only (not a direct signal source here)
 *
 * NOT YET CAPTURED (omitted, reduces confidence when absent):
 *   video_watch_pct, click_rate, open_rate
 */

function medianOf(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * @param {Array} messages - CONVERSATION_MESSAGES records (Airtable .fields)
 * @param {Array} clients - CLIENTS records (Airtable .fields) — typically 1 record
 * @param {Array} fundingRounds - FUNDING_ROUNDS records (Airtable .fields)
 * @param {number|Date} now - reference timestamp
 * @returns extracted signal object for scorer.js
 */
function extractSignals(messages, clients, fundingRounds, now) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const client = clients && clients[0] ? clients[0] : {};

  // ─── Conversation-derived signals ─────────────────────────────────────────

  // Filter out channel "other" (system noise)
  const realMessages = messages.filter(m => m.channel && m.channel !== "other");

  // Median reply time (hours): for each inbound message, find the next outbound response
  const replyTimes = [];
  const sorted = [...realMessages].sort((a, b) => {
    return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
  });

  for (let i = 0; i < sorted.length - 1; i++) {
    const msg = sorted[i];
    if (msg.direction !== "inbound") continue;
    const next = sorted[i + 1];
    if (next.direction === "outbound" && next.timestamp && msg.timestamp) {
      const diffHours = (new Date(next.timestamp) - new Date(msg.timestamp)) / (1000 * 60 * 60);
      if (diffHours >= 0 && diffHours < 720) {
        replyTimes.push(diffHours);
      }
    }
  }
  const median_reply_time_hours = medianOf(replyTimes);

  // Reply rate: % of outbound messages that received an inbound reply
  const outboundMsgs = sorted.filter(m => m.direction === "outbound");
  let repliedCount = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const msg = sorted[i];
    if (msg.direction !== "outbound") continue;
    const next = sorted[i + 1];
    if (next.direction === "inbound") repliedCount++;
  }
  const reply_rate = outboundMsgs.length > 0 ? repliedCount / outboundMsgs.length : null;

  // Ghost streak: consecutive outbound msgs with no inbound reply (from end of history)
  let ghost_streak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].direction === "outbound") {
      ghost_streak++;
    } else {
      break;
    }
  }
  if (ghost_streak === 0 || sorted.length === 0) ghost_streak = null;

  // Inbound-initiated: count of inbound messages where previous was also inbound or start of thread
  let inbound_initiated = 0;
  let prevDir = null;
  for (const msg of sorted) {
    if (msg.direction === "inbound" && (prevDir === null || prevDir === "inbound")) {
      inbound_initiated++;
    }
    prevDir = msg.direction;
  }

  // Message bodies for keyword scanning
  const message_bodies = realMessages.map(m => ({
    text: m.body || "",
    timestamp: m.timestamp ? new Date(m.timestamp).getTime() : nowMs,
    direction: m.direction || "outbound"
  }));

  // ─── Action latency (source: FUNDING_ROUNDS / deposit timestamp on CLIENTS) ─
  // Approximation: time between first outbound msg and first funding round record
  let action_latency_hours = null;
  if (fundingRounds.length > 0 && sorted.length > 0) {
    const firstMsg = sorted[0];
    const firstRound = fundingRounds
      .filter(r => r.created_time || r.Created)
      .sort(
        (a, b) =>
          new Date(a.created_time || a.Created || 0) - new Date(b.created_time || b.Created || 0)
      )[0];

    if (firstRound && firstMsg.timestamp) {
      const roundTs = new Date(firstRound.created_time || firstRound.Created || 0).getTime();
      const msgTs = new Date(firstMsg.timestamp).getTime();
      const diffHours = (roundTs - msgTs) / (1000 * 60 * 60);
      if (diffHours >= 0) action_latency_hours = diffHours;
    }
  }

  // ─── Intent actions ────────────────────────────────────────────────────────
  // source: CLIENTS (paid_deposit), FUNDING_ROUNDS (stage progression)
  const intent_actions = [];

  if (client.paid_deposit || client.deposit_paid) {
    const depositTs = client.deposit_date ? new Date(client.deposit_date).getTime() : nowMs;
    intent_actions.push({ type: "paid_deposit", timestamp: depositTs });
  }

  for (const round of fundingRounds) {
    const stageStr = (round.Stage || round.stage || "").toLowerCase();
    if (stageStr.includes("booked") || stageStr.includes("call scheduled")) {
      const ts = round.created_time ? new Date(round.created_time).getTime() : nowMs;
      intent_actions.push({ type: "booked_call", timestamp: ts });
    }
    if (stageStr.includes("requested") || stageStr.includes("info requested")) {
      const ts = round.created_time ? new Date(round.created_time).getTime() : nowMs;
      intent_actions.push({ type: "requested_info", timestamp: ts });
    }
  }

  // ─── Friction events ───────────────────────────────────────────────────────
  // sources noted per event type
  const frictionEvents = [];

  // collections_chargeback_failed_payment — source: CLIENTS.collections or failed_payment
  if (client.collections || client.failed_payment || client.chargeback) {
    frictionEvents.push({
      type: "collections_chargeback_failed_payment",
      timestamp: nowMs
    });
  }

  // no_show — source: CLIENTS.no_show
  if (client.no_show) {
    frictionEvents.push({ type: "no_show", timestamp: nowMs });
  }

  // missing_late_docs — source: CLIENTS.missing_late_docs or missing_docs
  if (client.missing_late_docs || client.missing_docs) {
    frictionEvents.push({ type: "missing_late_docs", timestamp: nowMs });
  }

  // reschedule — source: FUNDING_ROUNDS (reschedule field or stage)
  for (const round of fundingRounds) {
    const stageStr = (round.Stage || round.stage || "").toLowerCase();
    if (round.reschedule || stageStr.includes("reschedule")) {
      const ts = round.created_time ? new Date(round.created_time).getTime() : nowMs;
      frictionEvents.push({ type: "reschedule", timestamp: ts });
    }
  }

  // ops_action_required — source: CLIENTS.ops_action_required
  if (client.ops_action_required) {
    frictionEvents.push({ type: "ops_action_required", timestamp: nowMs });
  }

  return {
    // Responsiveness
    median_reply_time_hours,
    reply_rate,
    ghost_streak,
    action_latency_hours,

    // Engagement (live signals only)
    inbound_initiated,
    content_depth: null, // NOT YET CAPTURED — no content_depth tracking in messages table

    // NOT YET CAPTURED
    video_watch_pct: null,
    click_rate: null,
    open_rate: null,

    // Intent
    intent_actions,
    message_bodies,

    // Friction
    friction_events: frictionEvents
  };
}

module.exports = { extractSignals };
