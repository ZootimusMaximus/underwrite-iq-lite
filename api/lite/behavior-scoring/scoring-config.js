/**
 * Behavior Scoring spec v1 — starting values, tune later.
 * This file is the single source of truth for all weights, thresholds,
 * decay constants, tier boundaries, and keyword lists.
 * Adjust numbers here; logic files must not hard-code these values.
 */

const SCORING_CONFIG = {
  // ─────────────────────────────────────────────
  // RESPONSIVENESS  (0–100, higher = better)
  // ─────────────────────────────────────────────
  responsiveness: {
    weights: {
      median_reply_time: 0.4,
      reply_rate: 0.3,
      action_latency: 0.3
    },
    // Score bands for median_reply_time
    median_reply_time_bands: [
      { maxHours: 1, score: 100 },
      { maxHours: 6, score: 80 },
      { maxHours: 24, score: 65 },
      { maxHours: 48, score: 45 },
      { maxHours: Infinity, score: 20 }
    ],
    // reply_rate: linear 0–100 mapped from 0%–100%
    reply_rate_linear: true,
    // action_latency score bands (hours)
    action_latency_bands: [
      { maxHours: 0, score: 100, label: "same-day" }, // same calendar day
      { maxHours: 24, score: 85 },
      { maxHours: 48, score: 65 },
      { maxHours: 72, score: 20 }, // >72h also catches Infinity below
      { maxHours: Infinity, score: 20 }
    ],
    // Ghost streak: penalty per consecutive unanswered message
    ghost_streak_penalty_per: -15,
    ghost_streak_cap: -45,
    // Tier boundaries (score → letter)
    tiers: { A: 80, B: 60, C: 40 } // <40 = D
  },

  // ─────────────────────────────────────────────
  // ENGAGEMENT  (0–100, higher = better)
  // ─────────────────────────────────────────────
  engagement: {
    weights: {
      inbound_initiated: 0.3,
      video_watch_pct: 0.25,
      click_rate: 0.2,
      content_depth: 0.15,
      open_rate: 0.1
    },
    // inbound_initiated score bands (count of client-initiated contacts)
    inbound_initiated_bands: [
      { min: 0, max: 0, score: 0 },
      { min: 1, max: 2, score: 50 },
      { min: 3, max: 5, score: 75 },
      { min: 6, max: Infinity, score: 100 }
    ],
    // video_watch_pct: linear 0–100 mapped from 0%–100%
    video_watch_pct_linear: true,
    // click_rate: linear 0–100 mapped from 0%–100%
    click_rate_linear: true,
    // content_depth score bands (distinct content pieces consumed)
    content_depth_bands: [
      { min: 0, max: 0, score: 0 },
      { min: 1, max: 2, score: 40 },
      { min: 3, max: 5, score: 70 },
      { min: 6, max: Infinity, score: 100 }
    ],
    // open_rate: linear 0–100 mapped from 0%–100%
    open_rate_linear: true,
    tiers: { A: 80, B: 60, C: 40 }
  },

  // ─────────────────────────────────────────────
  // FRICTION  (0–100, HIGH = BAD; accumulating penalty, recency-weighted)
  // ─────────────────────────────────────────────
  friction: {
    // Each event type adds these raw penalty points (before recency weighting)
    event_penalties: {
      collections_chargeback_failed_payment: 40,
      no_show: 25,
      missing_late_docs: 15,
      reschedule: 10,
      ops_action_required: 10
    },
    // Accumulated penalty is capped at 100
    cap: 100,
    // Tiers (score = accumulated friction; higher = worse)
    tiers: {
      Low: { min: 0, max: 20 },
      Medium: { min: 21, max: 50 },
      High: { min: 51, max: 100 }
    }
    // Recency decay uses the same half-life as global decay below
  },

  // ─────────────────────────────────────────────
  // INTENT  (0–100, higher = better)
  // ─────────────────────────────────────────────
  intent: {
    weights: {
      intent_actions: 0.4,
      buying_signal_language: 0.3,
      stated_goal_urgency: 0.2,
      objection_vs_interest: 0.1
    },
    // intent_actions: booked_call + paid_deposit are highest signals.
    // Scorer assigns a 0–100 score from these; deposit > call > inquiry.
    intent_action_scores: {
      paid_deposit: 100,
      booked_call: 75,
      requested_info: 40
    },
    // motivation_label is a separate field, not part of the 0–100 score.
    motivation_labels: ["speed", "relief", "growth", "certainty", "control"],
    tiers: { A: 80, B: 60, C: 40 }
  },

  // ─────────────────────────────────────────────
  // KEYWORD LISTS
  // ─────────────────────────────────────────────
  keywords: {
    buying_signals: [
      "price",
      "cost",
      "how much",
      "when can",
      "how do i start",
      "ready",
      "asap",
      "today",
      "this week",
      "sign up",
      "get started"
    ],
    urgency_cues: [
      "urgent",
      "immediately",
      "right away",
      "need it now",
      "as soon as possible",
      "deadline",
      "by end of",
      "this month",
      "can't wait"
    ],
    stated_goal_cues: [
      "fund my business",
      "get approved",
      "improve credit",
      "remove inquiries",
      "buy a house",
      "open a line of credit",
      "get a loan"
    ]
  },

  // ─────────────────────────────────────────────
  // MECHANICS
  // ─────────────────────────────────────────────
  mechanics: {
    // Recency decay: weight = 0.5 ^ (age_days / 30)  → 30-day half-life
    recency_decay: {
      half_life_days: 30,
      formula: "weight = 0.5 ** (age_days / 30)"
    },
    // Confidence: provisional when signals < threshold
    confidence: {
      threshold_signals: 3,
      formula: "confidence = Math.min(1, signal_count / threshold_signals)",
      provisional_label: "provisional",
      confirmed_label: "confirmed"
    },
    // Composite score (optional aggregation)
    composite: {
      weights: {
        responsiveness: 0.3,
        engagement: 0.25,
        friction_inverted: 0.25, // (100 - friction_score)
        intent: 0.2
      },
      formula: "0.30*R + 0.25*E + 0.25*(100-F) + 0.20*I"
    }
  }
};

module.exports = { SCORING_CONFIG };
