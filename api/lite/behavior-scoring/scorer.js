"use strict";

/**
 * Pure scoring logic — no network calls, no Date.now().
 * All weights/thresholds come from SCORING_CONFIG.
 */

const { SCORING_CONFIG } = require("./scoring-config");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function recencyWeight(timestampMs, nowMs) {
  const halfLife = SCORING_CONFIG.mechanics.recency_decay.half_life_days;
  const ageDays = (nowMs - timestampMs) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLife);
}

function scoreBand(value, bands) {
  for (const band of bands) {
    if (value <= band.maxHours) return band.score;
  }
  return bands[bands.length - 1].score;
}

function scoreBandByMin(value, bands) {
  for (let i = bands.length - 1; i >= 0; i--) {
    if (value >= bands[i].min) return bands[i].score;
  }
  return bands[0].score;
}

function getTier(score, tiersConfig) {
  // tiersConfig: { A: 80, B: 60, C: 40 } — <40 = D
  if (score >= tiersConfig.A) return "A";
  if (score >= tiersConfig.B) return "B";
  if (score >= tiersConfig.C) return "C";
  return "D";
}

function getFrictionTier(score) {
  const t = SCORING_CONFIG.friction.tiers;
  if (score <= t.Low.max) return "Low";
  if (score <= t.Medium.max) return "Medium";
  return "High";
}

function computeConfidence(signalsPresent) {
  const { threshold_signals, provisional_label, confirmed_label } =
    SCORING_CONFIG.mechanics.confidence;
  const confidence = Math.min(1, signalsPresent / threshold_signals);
  const label = signalsPresent < threshold_signals ? provisional_label : confirmed_label;
  return { confidence: parseFloat(confidence.toFixed(4)), label };
}

// ─── Responsiveness ───────────────────────────────────────────────────────────

/**
 * signals: {
 *   median_reply_time_hours?: number,     // source: CONVERSATION_MESSAGES
 *   reply_rate?: number,                  // 0–1, source: CONVERSATION_MESSAGES
 *   action_latency_hours?: number,        // source: FUNDING_ROUNDS / CLIENTS (deposit → first action)
 *   ghost_streak?: number,                // consecutive unanswered outbound msgs
 * }
 * now: Date | number (ms)
 */
function computeResponsiveness(signals, _now) {
  const cfg = SCORING_CONFIG.responsiveness;
  const weights = cfg.weights;

  let weightedSum = 0;
  let weightTotal = 0;
  let signalsPresent = 0;
  const contributors = [];

  if (signals.median_reply_time_hours != null) {
    const s = scoreBand(signals.median_reply_time_hours, cfg.median_reply_time_bands);
    weightedSum += weights.median_reply_time * s;
    weightTotal += weights.median_reply_time;
    signalsPresent++;
    contributors.push({ signal: "median_reply_time", score: s, weight: weights.median_reply_time });
  }

  if (signals.reply_rate != null) {
    const s = Math.round(signals.reply_rate * 100);
    weightedSum += weights.reply_rate * s;
    weightTotal += weights.reply_rate;
    signalsPresent++;
    contributors.push({ signal: "reply_rate", score: s, weight: weights.reply_rate });
  }

  if (signals.action_latency_hours != null) {
    const s = scoreBand(signals.action_latency_hours, cfg.action_latency_bands);
    weightedSum += weights.action_latency * s;
    weightTotal += weights.action_latency;
    signalsPresent++;
    contributors.push({ signal: "action_latency", score: s, weight: weights.action_latency });
  }

  let baseScore = weightTotal > 0 ? weightedSum / weightTotal : 0;

  // Ghost streak penalty (applied after weighted avg)
  let ghostPenalty = 0;
  if (signals.ghost_streak != null && signals.ghost_streak > 0) {
    ghostPenalty = Math.max(
      cfg.ghost_streak_cap,
      cfg.ghost_streak_penalty_per * signals.ghost_streak
    );
    baseScore = Math.max(0, baseScore + ghostPenalty);
    contributors.push({ signal: "ghost_streak", score: ghostPenalty, weight: 1 });
  }

  const score = Math.round(Math.max(0, Math.min(100, baseScore)));
  const { confidence, label } = computeConfidence(signalsPresent);

  return {
    score,
    tier: getTier(score, cfg.tiers),
    confidence,
    confidence_label: label,
    signals_present: signalsPresent,
    contributors
  };
}

// ─── Engagement ───────────────────────────────────────────────────────────────

/**
 * signals: {
 *   inbound_initiated?: number,       // source: CONVERSATION_MESSAGES (count)
 *   content_depth?: number,           // source: CONVERSATION_MESSAGES (distinct content pieces mentioned/requested)
 *   video_watch_pct?: number,         // NOT YET CAPTURED — omit
 *   click_rate?: number,              // NOT YET CAPTURED — omit
 *   open_rate?: number,               // NOT YET CAPTURED — omit
 * }
 */
function computeEngagement(signals, _now) {
  const cfg = SCORING_CONFIG.engagement;
  const weights = cfg.weights;

  let weightedSum = 0;
  let weightTotal = 0;
  let signalsPresent = 0;
  const contributors = [];

  if (signals.inbound_initiated != null) {
    const s = scoreBandByMin(signals.inbound_initiated, cfg.inbound_initiated_bands);
    weightedSum += weights.inbound_initiated * s;
    weightTotal += weights.inbound_initiated;
    signalsPresent++;
    contributors.push({ signal: "inbound_initiated", score: s, weight: weights.inbound_initiated });
  }

  if (signals.content_depth != null) {
    const s = scoreBandByMin(signals.content_depth, cfg.content_depth_bands);
    weightedSum += weights.content_depth * s;
    weightTotal += weights.content_depth;
    signalsPresent++;
    contributors.push({ signal: "content_depth", score: s, weight: weights.content_depth });
  }

  // video_watch_pct — NOT YET CAPTURED
  if (signals.video_watch_pct != null) {
    const s = Math.round(signals.video_watch_pct * 100);
    weightedSum += weights.video_watch_pct * s;
    weightTotal += weights.video_watch_pct;
    signalsPresent++;
    contributors.push({ signal: "video_watch_pct", score: s, weight: weights.video_watch_pct });
  }

  // click_rate — NOT YET CAPTURED
  if (signals.click_rate != null) {
    const s = Math.round(signals.click_rate * 100);
    weightedSum += weights.click_rate * s;
    weightTotal += weights.click_rate;
    signalsPresent++;
    contributors.push({ signal: "click_rate", score: s, weight: weights.click_rate });
  }

  // open_rate — NOT YET CAPTURED
  if (signals.open_rate != null) {
    const s = Math.round(signals.open_rate * 100);
    weightedSum += weights.open_rate * s;
    weightTotal += weights.open_rate;
    signalsPresent++;
    contributors.push({ signal: "open_rate", score: s, weight: weights.open_rate });
  }

  const score = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;
  const { confidence, label } = computeConfidence(signalsPresent);

  return {
    score: Math.max(0, Math.min(100, score)),
    tier: getTier(score, cfg.tiers),
    confidence,
    confidence_label: label,
    signals_present: signalsPresent,
    contributors
  };
}

// ─── Friction ─────────────────────────────────────────────────────────────────

/**
 * signals: {
 *   events?: Array<{ type: string, timestamp: number }> // recency-weighted friction events
 * }
 * Friction event types from config: collections_chargeback_failed_payment, no_show,
 * missing_late_docs, reschedule, ops_action_required
 *
 * Sources:
 *   no_show — CLIENTS (no_show field) or manual ops flag
 *   missing_late_docs — CLIENTS (missing_late_docs or ops notes)
 *   reschedule — FUNDING_ROUNDS (reschedule events)
 *   collections_chargeback_failed_payment — CLIENTS (collections field)
 *   ops_action_required — CLIENTS (ops_action_required field)
 */
function computeFriction(signals, now) {
  const cfg = SCORING_CONFIG.friction;
  const nowMs = now instanceof Date ? now.getTime() : now;

  let accumulated = 0;
  let signalsPresent = 0;
  const contributors = [];

  const events = signals.events || [];

  for (const ev of events) {
    const penalty = cfg.event_penalties[ev.type];
    if (penalty == null) continue;

    const w = ev.timestamp ? recencyWeight(ev.timestamp, nowMs) : 1;
    const weightedPenalty = penalty * w;
    accumulated += weightedPenalty;
    signalsPresent++;
    contributors.push({
      signal: ev.type,
      raw_penalty: penalty,
      recency_weight: w,
      weighted_penalty: weightedPenalty
    });
  }

  const score = Math.round(Math.min(cfg.cap, Math.max(0, accumulated)));
  const { confidence, label } = computeConfidence(signalsPresent);

  return {
    score,
    tier: getFrictionTier(score),
    confidence,
    confidence_label: label,
    signals_present: signalsPresent,
    contributors
  };
}

// ─── Intent ───────────────────────────────────────────────────────────────────

/**
 * signals: {
 *   intent_actions?: Array<{ type: string, timestamp: number }>,   // paid_deposit, booked_call, requested_info
 *   message_bodies?: Array<{ text: string, timestamp: number, direction: string }>, // for keyword scan
 *   stated_goal_urgency?: number,     // 0–1 (derived from keyword hits — urgency_cues)
 *   objection_vs_interest?: number,   // 0–1 (0=objections dominate, 1=interest dominates)
 * }
 */
function computeIntent(signals, now) {
  const cfg = SCORING_CONFIG.intent;
  const kw = SCORING_CONFIG.keywords;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const weights = cfg.weights;

  let weightedSum = 0;
  let weightTotal = 0;
  let signalsPresent = 0;
  const contributors = [];

  // intent_actions — source: FUNDING_ROUNDS (booked_call), CLIENTS (paid_deposit)
  if (signals.intent_actions && signals.intent_actions.length > 0) {
    // Take the highest-scoring action, recency-weighted
    let bestScore = 0;
    for (const action of signals.intent_actions) {
      const base = cfg.intent_action_scores[action.type] || 0;
      const w = action.timestamp ? recencyWeight(action.timestamp, nowMs) : 1;
      const s = base * w;
      if (s > bestScore) bestScore = s;
    }
    const s = Math.min(100, Math.round(bestScore));
    weightedSum += weights.intent_actions * s;
    weightTotal += weights.intent_actions;
    signalsPresent++;
    contributors.push({ signal: "intent_actions", score: s, weight: weights.intent_actions });
  }

  // buying_signal_language — scan inbound message bodies for keyword hits
  let buyingSignalScore = 0;
  const motivationHits = { speed: 0, relief: 0, growth: 0, certainty: 0, control: 0 };

  if (signals.message_bodies && signals.message_bodies.length > 0) {
    const inbound = signals.message_bodies.filter(m => m.direction === "inbound");
    let totalHits = 0;

    for (const msg of inbound) {
      const text = (msg.text || "").toLowerCase();
      const w = msg.timestamp ? recencyWeight(msg.timestamp, nowMs) : 1;

      for (const kword of kw.buying_signals) {
        if (text.includes(kword)) {
          totalHits += w;
          // Map buying signals to motivation labels heuristically
          if (
            ["asap", "today", "this week", "when can", "how do i start"].some(k => text.includes(k))
          ) {
            motivationHits.speed += w;
          }
          if (["get started", "sign up", "ready"].some(k => text.includes(k))) {
            motivationHits.growth += w;
          }
          if (["price", "cost", "how much"].some(k => text.includes(k))) {
            motivationHits.certainty += w;
          }
        }
      }

      for (const cue of kw.stated_goal_cues) {
        if (text.includes(cue)) {
          totalHits += w;
          motivationHits.growth += w;
        }
      }

      for (const cue of kw.urgency_cues) {
        if (text.includes(cue)) {
          motivationHits.speed += w;
        }
      }
    }

    // Normalize: cap at 5 hits = 100
    buyingSignalScore = Math.min(100, Math.round((totalHits / 5) * 100));
    weightedSum += weights.buying_signal_language * buyingSignalScore;
    weightTotal += weights.buying_signal_language;
    signalsPresent++;
    contributors.push({
      signal: "buying_signal_language",
      score: buyingSignalScore,
      weight: weights.buying_signal_language
    });
  }

  // stated_goal_urgency
  if (signals.stated_goal_urgency != null) {
    const s = Math.round(signals.stated_goal_urgency * 100);
    weightedSum += weights.stated_goal_urgency * s;
    weightTotal += weights.stated_goal_urgency;
    signalsPresent++;
    contributors.push({
      signal: "stated_goal_urgency",
      score: s,
      weight: weights.stated_goal_urgency
    });
  }

  // objection_vs_interest
  if (signals.objection_vs_interest != null) {
    const s = Math.round(signals.objection_vs_interest * 100);
    weightedSum += weights.objection_vs_interest * s;
    weightTotal += weights.objection_vs_interest;
    signalsPresent++;
    contributors.push({
      signal: "objection_vs_interest",
      score: s,
      weight: weights.objection_vs_interest
    });
  }

  const score = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;
  const { confidence, label } = computeConfidence(signalsPresent);

  // Pick motivation_label from highest-hit category
  let motivation_label = null;
  const topMotivation = Object.entries(motivationHits).sort((a, b) => b[1] - a[1])[0];
  if (topMotivation && topMotivation[1] > 0) {
    motivation_label = topMotivation[0];
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    tier: getTier(score, cfg.tiers),
    motivation_label,
    confidence,
    confidence_label: label,
    signals_present: signalsPresent,
    contributors
  };
}

// ─── Composite ────────────────────────────────────────────────────────────────

/**
 * Combine all 4 dimensions into composite + top_signals.
 * @param {object} opts - { responsiveness, engagement, friction, intent } result objects, `now`
 */
function computeComposite({ responsiveness, engagement, friction, intent }) {
  const w = SCORING_CONFIG.mechanics.composite.weights;

  const composite = Math.round(
    w.responsiveness * responsiveness.score +
      w.engagement * engagement.score +
      w.friction_inverted * (100 - friction.score) +
      w.intent * intent.score
  );

  // Collect top contributors sorted by weighted contribution
  const allContributors = [
    { dimension: "responsiveness", contribution: w.responsiveness * responsiveness.score },
    { dimension: "engagement", contribution: w.engagement * engagement.score },
    { dimension: "friction_inverted", contribution: w.friction_inverted * (100 - friction.score) },
    { dimension: "intent", contribution: w.intent * intent.score }
  ];
  allContributors.sort((a, b) => b.contribution - a.contribution);
  const top_signals = allContributors.map(c => c.dimension);

  // Overall confidence = min of all dimension confidences
  const overallConfidence = Math.min(
    responsiveness.confidence,
    engagement.confidence,
    friction.confidence,
    intent.confidence
  );

  const { threshold_signals, provisional_label, confirmed_label } =
    SCORING_CONFIG.mechanics.confidence;
  const totalSignals =
    responsiveness.signals_present +
    engagement.signals_present +
    friction.signals_present +
    intent.signals_present;

  const confidence_label = totalSignals < threshold_signals ? provisional_label : confirmed_label;

  return {
    composite: Math.max(0, Math.min(100, composite)),
    top_signals,
    overall_confidence: parseFloat(overallConfidence.toFixed(4)),
    confidence_label
  };
}

module.exports = {
  computeResponsiveness,
  computeEngagement,
  computeFriction,
  computeIntent,
  computeComposite,
  // exported for tests
  recencyWeight,
  computeConfidence
};
