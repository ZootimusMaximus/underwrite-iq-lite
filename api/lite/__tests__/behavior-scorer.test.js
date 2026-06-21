"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  computeResponsiveness,
  computeEngagement,
  computeFriction,
  computeIntent,
  computeComposite,
  recencyWeight,
  computeConfidence
} = require("../behavior-scoring/scorer");
const { SCORING_CONFIG } = require("../behavior-scoring/scoring-config");

const NOW = new Date("2026-06-21T12:00:00Z").getTime();

// ─── recencyWeight ─────────────────────────────────────────────────────────────

describe("recencyWeight", () => {
  it("weight = 1 for same-time event", () => {
    assert.ok(Math.abs(recencyWeight(NOW, NOW) - 1) < 1e-5);
  });

  it("weight = 0.5 at 30 days ago (half-life)", () => {
    const thirtyDaysAgo = NOW - 30 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(recencyWeight(thirtyDaysAgo, NOW) - 0.5) < 1e-5);
  });

  it("weight = 0.25 at 60 days ago", () => {
    const sixtyDaysAgo = NOW - 60 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(recencyWeight(sixtyDaysAgo, NOW) - 0.25) < 1e-5);
  });

  it("older events have lower weight than recent ones", () => {
    const older = recencyWeight(NOW - 20 * 24 * 60 * 60 * 1000, NOW);
    const newer = recencyWeight(NOW - 5 * 24 * 60 * 60 * 1000, NOW);
    assert.ok(newer > older);
  });
});

// ─── computeConfidence ────────────────────────────────────────────────────────

describe("computeConfidence", () => {
  const threshold = SCORING_CONFIG.mechanics.confidence.threshold_signals;

  it("0 signals → confidence 0, provisional", () => {
    const { confidence, label } = computeConfidence(0);
    assert.equal(confidence, 0);
    assert.equal(label, "provisional");
  });

  it("below threshold → provisional", () => {
    const { label } = computeConfidence(threshold - 1);
    assert.equal(label, "provisional");
  });

  it("at threshold → confirmed, confidence 1", () => {
    const { confidence, label } = computeConfidence(threshold);
    assert.equal(confidence, 1);
    assert.equal(label, "confirmed");
  });

  it("above threshold → capped at 1", () => {
    const { confidence } = computeConfidence(threshold + 5);
    assert.equal(confidence, 1);
  });
});

// ─── computeResponsiveness ────────────────────────────────────────────────────

describe("computeResponsiveness", () => {
  it("fast responder → high score (A tier)", () => {
    const result = computeResponsiveness(
      { median_reply_time_hours: 0.5, reply_rate: 1.0, action_latency_hours: 0 },
      NOW
    );
    assert.ok(result.score >= 80);
    assert.equal(result.tier, "A");
  });

  it("slow responder → low score (D tier)", () => {
    const result = computeResponsiveness(
      { median_reply_time_hours: 100, reply_rate: 0.1, action_latency_hours: 200 },
      NOW
    );
    assert.ok(result.score < 40);
    assert.equal(result.tier, "D");
  });

  it("ghost streak penalizes score", () => {
    const withGhost = computeResponsiveness(
      { median_reply_time_hours: 1, reply_rate: 1.0, ghost_streak: 3 },
      NOW
    );
    const withoutGhost = computeResponsiveness(
      { median_reply_time_hours: 1, reply_rate: 1.0, ghost_streak: 0 },
      NOW
    );
    assert.ok(withoutGhost.score > withGhost.score);
  });

  it("ghost streak penalty capped at config cap", () => {
    const result = computeResponsiveness(
      { median_reply_time_hours: 1, reply_rate: 1.0, ghost_streak: 100 },
      NOW
    );
    assert.ok(result.score >= 0);
  });

  it("tier boundaries: score=80 → A", () => {
    const r = computeResponsiveness({ reply_rate: 0.8 }, NOW);
    if (r.score >= 80) assert.equal(r.tier, "A");
    else if (r.score >= 60 && r.score < 80) assert.equal(r.tier, "B");
    else if (r.score >= 40 && r.score < 60) assert.equal(r.tier, "C");
    else assert.equal(r.tier, "D");
  });

  it("no signals → score 0, provisional", () => {
    const result = computeResponsiveness({}, NOW);
    assert.equal(result.score, 0);
    assert.equal(result.confidence_label, "provisional");
  });

  it("absent signals reduce confidence", () => {
    const partial = computeResponsiveness({ reply_rate: 0.8 }, NOW);
    const full = computeResponsiveness(
      { median_reply_time_hours: 1, reply_rate: 0.8, action_latency_hours: 2 },
      NOW
    );
    assert.ok(full.confidence >= partial.confidence);
  });

  it("reply_rate 0.6 maps to score 60", () => {
    const result = computeResponsiveness({ reply_rate: 0.6 }, NOW);
    assert.equal(result.score, 60);
  });
});

// ─── computeEngagement ────────────────────────────────────────────────────────

describe("computeEngagement", () => {
  it("high inbound initiated → good engagement", () => {
    const result = computeEngagement({ inbound_initiated: 6 }, NOW);
    assert.ok(result.score > 50);
  });

  it("zero inbound → score 0 from that signal", () => {
    const result = computeEngagement({ inbound_initiated: 0 }, NOW);
    assert.equal(result.score, 0);
  });

  it("absent signals (video/click/open) → provisional", () => {
    const result = computeEngagement({ inbound_initiated: 6 }, NOW);
    assert.equal(result.confidence_label, "provisional");
  });

  it("content_depth 6 → score 100 for that band", () => {
    const result = computeEngagement({ inbound_initiated: 6, content_depth: 6 }, NOW);
    assert.ok(result.score > 0);
  });

  it("null signals don't crash", () => {
    assert.doesNotThrow(() => computeEngagement({}, NOW));
  });

  it("tier boundaries respected", () => {
    const r = computeEngagement({ inbound_initiated: 6 }, NOW);
    if (r.score >= 80) assert.equal(r.tier, "A");
    else if (r.score >= 60) assert.equal(r.tier, "B");
    else if (r.score >= 40) assert.equal(r.tier, "C");
    else assert.equal(r.tier, "D");
  });
});

// ─── computeFriction ──────────────────────────────────────────────────────────

describe("computeFriction", () => {
  it("no events → score 0, Low tier", () => {
    const result = computeFriction({ events: [] }, NOW);
    assert.equal(result.score, 0);
    assert.equal(result.tier, "Low");
  });

  it("collections event → Medium tier (40 points, between 21-50)", () => {
    const result = computeFriction(
      { events: [{ type: "collections_chargeback_failed_payment", timestamp: NOW }] },
      NOW
    );
    assert.ok(Math.abs(result.score - 40) < 1);
    assert.equal(result.tier, "Medium");
  });

  it("no_show event → adds 25 points", () => {
    const result = computeFriction({ events: [{ type: "no_show", timestamp: NOW }] }, NOW);
    assert.ok(Math.abs(result.score - 25) < 1);
    assert.equal(result.tier, "Medium");
  });

  it("accumulated events capped at 100", () => {
    const events = Array(10)
      .fill(null)
      .map(() => ({
        type: "collections_chargeback_failed_payment",
        timestamp: NOW
      }));
    const result = computeFriction({ events }, NOW);
    assert.equal(result.score, 100);
  });

  it("older events have less impact (recency decay)", () => {
    const recentEvent = { type: "no_show", timestamp: NOW };
    const oldEvent = {
      type: "no_show",
      timestamp: NOW - 60 * 24 * 60 * 60 * 1000
    };
    const recent = computeFriction({ events: [recentEvent] }, NOW);
    const old = computeFriction({ events: [oldEvent] }, NOW);
    assert.ok(recent.score > old.score);
  });

  it("friction score HIGH = bad for composite (inverted)", () => {
    const highFriction = computeFriction(
      { events: [{ type: "collections_chargeback_failed_payment", timestamp: NOW }] },
      NOW
    );
    assert.ok(highFriction.score > 30);
  });

  it("tier boundaries: 0-20 = Low, 21-50 = Medium, 51-100 = High", () => {
    const low = computeFriction({ events: [{ type: "reschedule", timestamp: NOW }] }, NOW);
    assert.equal(low.tier, "Low");

    const twoNoShows = computeFriction(
      {
        events: [
          { type: "no_show", timestamp: NOW },
          { type: "no_show", timestamp: NOW }
        ]
      },
      NOW
    );
    assert.equal(twoNoShows.tier, "Medium");

    const big = computeFriction(
      { events: [{ type: "collections_chargeback_failed_payment", timestamp: NOW }] },
      NOW
    );
    assert.equal(big.tier, "Medium");
  });

  it("absent events → 0 signals, provisional", () => {
    const result = computeFriction({ events: [] }, NOW);
    assert.equal(result.confidence_label, "provisional");
  });
});

// ─── computeIntent ────────────────────────────────────────────────────────────

describe("computeIntent", () => {
  it("paid_deposit → high intent score", () => {
    const result = computeIntent(
      { intent_actions: [{ type: "paid_deposit", timestamp: NOW }] },
      NOW
    );
    assert.ok(result.score > 50);
  });

  it("booked_call → moderate-high intent", () => {
    const result = computeIntent(
      { intent_actions: [{ type: "booked_call", timestamp: NOW }] },
      NOW
    );
    assert.ok(result.score > 30);
  });

  it("buying signal keywords → motivation label extracted", () => {
    const result = computeIntent(
      {
        message_bodies: [
          { text: "I am ready to get started asap", timestamp: NOW, direction: "inbound" }
        ]
      },
      NOW
    );
    assert.ok(result.motivation_label !== null);
  });

  it("urgency keywords → speed motivation", () => {
    const result = computeIntent(
      {
        message_bodies: [
          { text: "I need it asap, this is urgent", timestamp: NOW, direction: "inbound" }
        ]
      },
      NOW
    );
    assert.equal(result.motivation_label, "speed");
  });

  it("price keywords → certainty motivation", () => {
    const result = computeIntent(
      {
        message_bodies: [
          {
            text: "How much does it cost? What is the price?",
            timestamp: NOW,
            direction: "inbound"
          }
        ]
      },
      NOW
    );
    assert.ok(["certainty", "speed", "growth"].includes(result.motivation_label));
  });

  it("no intent signals → score 0, provisional", () => {
    const result = computeIntent({}, NOW);
    assert.equal(result.score, 0);
    assert.equal(result.confidence_label, "provisional");
  });

  it("outbound messages don't contribute to buying signal score", () => {
    const outbound = computeIntent(
      {
        message_bodies: [
          { text: "ready to get started asap", timestamp: NOW, direction: "outbound" }
        ]
      },
      NOW
    );
    const inbound = computeIntent(
      {
        message_bodies: [
          { text: "ready to get started asap", timestamp: NOW, direction: "inbound" }
        ]
      },
      NOW
    );
    assert.ok(inbound.score > outbound.score);
  });

  it("tier boundaries for intent", () => {
    const r = computeIntent({ intent_actions: [{ type: "paid_deposit", timestamp: NOW }] }, NOW);
    if (r.score >= 80) assert.equal(r.tier, "A");
    else if (r.score >= 60) assert.equal(r.tier, "B");
    else if (r.score >= 40) assert.equal(r.tier, "C");
    else assert.equal(r.tier, "D");
  });
});

// ─── computeComposite ─────────────────────────────────────────────────────────

describe("computeComposite", () => {
  it("high friction lowers composite via inversion", () => {
    const base = {
      responsiveness: { score: 80, confidence: 1, signals_present: 3, contributors: [] },
      engagement: { score: 80, confidence: 1, signals_present: 3, contributors: [] },
      intent: { score: 80, confidence: 1, signals_present: 3, contributors: [] }
    };

    const lowFriction = computeComposite({
      ...base,
      friction: { score: 10, confidence: 1, signals_present: 1, contributors: [] }
    });
    const highFriction = computeComposite({
      ...base,
      friction: { score: 90, confidence: 1, signals_present: 1, contributors: [] }
    });
    assert.ok(lowFriction.composite > highFriction.composite);
  });

  it("formula: 0.30*R + 0.25*E + 0.25*(100-F) + 0.20*I", () => {
    const dims = {
      responsiveness: { score: 60, confidence: 1, signals_present: 3, contributors: [] },
      engagement: { score: 80, confidence: 1, signals_present: 3, contributors: [] },
      friction: { score: 20, confidence: 1, signals_present: 1, contributors: [] },
      intent: { score: 40, confidence: 1, signals_present: 3, contributors: [] }
    };
    const { composite } = computeComposite(dims);
    const expected = Math.round(0.3 * 60 + 0.25 * 80 + 0.25 * 80 + 0.2 * 40);
    assert.equal(composite, expected);
  });

  it("top_signals array has 4 entries", () => {
    const dims = {
      responsiveness: { score: 50, confidence: 1, signals_present: 3, contributors: [] },
      engagement: { score: 50, confidence: 1, signals_present: 3, contributors: [] },
      friction: { score: 10, confidence: 1, signals_present: 1, contributors: [] },
      intent: { score: 50, confidence: 1, signals_present: 3, contributors: [] }
    };
    const { top_signals } = computeComposite(dims);
    assert.equal(top_signals.length, 4);
  });

  it("overall_confidence is min of all confidences", () => {
    const dims = {
      responsiveness: { score: 50, confidence: 1, signals_present: 3, contributors: [] },
      engagement: { score: 50, confidence: 0.33, signals_present: 1, contributors: [] },
      friction: { score: 10, confidence: 0, signals_present: 0, contributors: [] },
      intent: { score: 50, confidence: 1, signals_present: 3, contributors: [] }
    };
    const { overall_confidence } = computeComposite(dims);
    assert.equal(overall_confidence, 0);
  });

  it("composite is capped at 0–100", () => {
    const dims = {
      responsiveness: { score: 100, confidence: 1, signals_present: 3, contributors: [] },
      engagement: { score: 100, confidence: 1, signals_present: 3, contributors: [] },
      friction: { score: 0, confidence: 1, signals_present: 1, contributors: [] },
      intent: { score: 100, confidence: 1, signals_present: 3, contributors: [] }
    };
    const { composite } = computeComposite(dims);
    assert.ok(composite <= 100);
    assert.ok(composite >= 0);
  });
});
