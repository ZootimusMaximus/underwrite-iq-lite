"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { SCORING_CONFIG } = require("../behavior-scoring/scoring-config");

const DIMENSIONS = ["responsiveness", "engagement", "friction", "intent"];

describe("SCORING_CONFIG", () => {
  it("all 4 dimensions present", () => {
    for (const dim of DIMENSIONS) {
      assert.ok(Object.prototype.hasOwnProperty.call(SCORING_CONFIG, dim));
    }
  });

  it("responsiveness weights sum to 1.0", () => {
    const w = SCORING_CONFIG.responsiveness.weights;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });

  it("engagement weights sum to 1.0", () => {
    const w = SCORING_CONFIG.engagement.weights;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });

  it("intent weights sum to 1.0", () => {
    const w = SCORING_CONFIG.intent.weights;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });

  it("composite weights sum to 1.0", () => {
    const w = SCORING_CONFIG.mechanics.composite.weights;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });

  it("responsiveness median_reply_time_bands are monotonically non-decreasing", () => {
    const bands = SCORING_CONFIG.responsiveness.median_reply_time_bands;
    for (let i = 1; i < bands.length; i++) {
      assert.ok(bands[i].maxHours >= bands[i - 1].maxHours);
    }
  });

  it("friction tiers are monotonically ordered", () => {
    const { Low, Medium, High } = SCORING_CONFIG.friction.tiers;
    assert.ok(Low.max < Medium.min);
    assert.ok(Medium.max < High.min);
  });

  it("ghost_streak_cap is negative and <= penalty_per", () => {
    const cfg = SCORING_CONFIG.responsiveness;
    assert.ok(cfg.ghost_streak_penalty_per < 0);
    assert.ok(cfg.ghost_streak_cap <= cfg.ghost_streak_penalty_per);
  });

  it("buying_signals keyword list is non-empty", () => {
    assert.ok(SCORING_CONFIG.keywords.buying_signals.length > 0);
  });

  it("recency_decay half_life_days is 30", () => {
    assert.equal(SCORING_CONFIG.mechanics.recency_decay.half_life_days, 30);
  });
});
