"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { computeTrajectory, linearSlope, classifySlope } = require("../behavior-scoring/trajectory");

const NOW = new Date("2026-06-21T12:00:00Z").getTime();

function row(daysAgo, composite, extra = {}) {
  const ts = new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { ts, composite, responsiveness: 50, engagement: 50, friction: 10, intent: 50, ...extra };
}

describe("linearSlope", () => {
  it("increasing values → positive slope", () => {
    assert.ok(linearSlope([10, 20, 30, 40, 50]) > 0);
  });

  it("decreasing values → negative slope", () => {
    assert.ok(linearSlope([50, 40, 30, 20, 10]) < 0);
  });

  it("flat values → slope 0", () => {
    assert.equal(linearSlope([50, 50, 50, 50]), 0);
  });

  it("single value → slope 0", () => {
    assert.equal(linearSlope([50]), 0);
  });
});

describe("classifySlope", () => {
  it("slope > 1 → rising", () => {
    assert.equal(classifySlope(2), "rising");
  });

  it("slope < -1 → falling", () => {
    assert.equal(classifySlope(-2), "falling");
  });

  it("slope between -1 and 1 → flat", () => {
    assert.equal(classifySlope(0), "flat");
    assert.equal(classifySlope(0.5), "flat");
    assert.equal(classifySlope(-0.5), "flat");
  });
});

describe("computeTrajectory", () => {
  it("rising scores → rising direction", () => {
    const history = [row(10, 30), row(7, 45), row(4, 60), row(1, 75)];
    const result = computeTrajectory(history, NOW);
    assert.equal(result.direction, "rising");
    assert.ok(result.slope > 0);
  });

  it("falling scores → falling direction", () => {
    const history = [row(10, 80), row(7, 65), row(4, 50), row(1, 35)];
    const result = computeTrajectory(history, NOW);
    assert.equal(result.direction, "falling");
    assert.ok(result.slope < 0);
  });

  it("flat scores → flat direction", () => {
    const history = [row(10, 60), row(7, 61), row(4, 60), row(1, 59)];
    const result = computeTrajectory(history, NOW);
    assert.equal(result.direction, "flat");
  });

  it("< 2 data points → flat, slope 0", () => {
    const result = computeTrajectory([row(5, 60)], NOW);
    assert.equal(result.direction, "flat");
    assert.equal(result.slope, 0);
  });

  it("empty history → flat, slope 0", () => {
    const result = computeTrajectory([], NOW);
    assert.equal(result.direction, "flat");
    assert.equal(result.slope, 0);
  });

  it("excludes rows older than 14 days", () => {
    const history = [row(30, 20), row(30, 20), row(5, 70)];
    const result = computeTrajectory(history, NOW);
    assert.equal(result.direction, "flat");
    assert.equal(result.data_points, 1);
  });

  it("returns perDimension breakdown", () => {
    const history = [
      row(10, 30, { responsiveness: 40, engagement: 50, friction: 30, intent: 20 }),
      row(5, 60, { responsiveness: 70, engagement: 70, friction: 10, intent: 60 }),
      row(1, 80, { responsiveness: 90, engagement: 90, friction: 5, intent: 80 })
    ];
    const result = computeTrajectory(history, NOW);
    assert.ok(Object.prototype.hasOwnProperty.call(result.perDimension, "responsiveness"));
    assert.ok(Object.prototype.hasOwnProperty.call(result.perDimension, "engagement"));
    assert.ok(Object.prototype.hasOwnProperty.call(result.perDimension, "friction"));
    assert.ok(Object.prototype.hasOwnProperty.call(result.perDimension, "intent"));
    assert.equal(result.perDimension.responsiveness.direction, "rising");
  });

  it("data_points reflects records within window", () => {
    const history = [row(5, 60), row(3, 65), row(1, 70)];
    const result = computeTrajectory(history, NOW);
    assert.equal(result.data_points, 3);
  });
});
