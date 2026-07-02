"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildCloserResult } = require("../crs/build-closer-result");

function fullResult() {
  return {
    outcome: "FULL_FUNDING",
    outcomeResult: {
      outcome: "FULL_FUNDING",
      reasonCodes: ["LOW_PRIMARY_REVOLVING_DEPTH"]
    },
    projectedPreapproval: { totalCombined: 210000 },
    preapprovals: {
      totalCombined: 150000,
      totalPersonal: 90000,
      totalBusiness: 60000,
      confidenceBand: "high",
      modifiersApplied: ["utilization"],
      personalCard: { final: 50000, offerBand: "strong", eligible: true },
      personalLoan: { final: 40000, offerBand: "moderate", eligible: true },
      business: {
        final: 60000,
        offerBand: "strong",
        eligible: true,
        capReason: "utilization_based"
      }
    },
    suggestions: {
      topMoves: [{ title: "Pay down card" }, { title: "Remove inquiry" }]
    },
    consumerSignals: {
      scores: { median: 742, perBureau: { ex: 748, tu: 740, eq: 738 }, bureauConfidence: "high" },
      utilization: { band: "good" },
      inquiries: { pressure: "low" },
      anchors: { revolving: { limit: 15000 }, installment: { amount: 22000 } },
      bureauNegatives: {
        experian: { clean: true, pulled: true, count: 0 },
        transunion: { clean: true, pulled: true, count: 0 },
        equifax: { clean: true, pulled: true, count: 0 }
      },
      allBureausClean: true,
      anyBureauClean: true
    },
    businessSignals: { available: true, profile: { ageMonths: 30 } }
  };
}

describe("buildCloserResult", () => {
  it("maps a full FULL_FUNDING result with all closer fields", () => {
    const r = buildCloserResult(fullResult());
    assert.equal(r.outcome, "FULL_FUNDING");
    assert.deepEqual(r.reasonCodes, ["LOW_PRIMARY_REVOLVING_DEPTH"]);
    assert.equal(r.preapprovals.totalCombined, 150000);
    assert.equal(r.preapprovals.totalPersonal, 90000);
    assert.equal(r.preapprovals.totalBusiness, 60000);
    assert.equal(r.preapprovals.personalCard.offerBand, "strong");
    assert.equal(r.preapprovals.business.capReason, "utilization_based");
    assert.equal(r.projectedTotalCombined, 210000);
    // stack flags come from engine-native .eligible (not invented can_*_stack)
    assert.deepEqual(r.stackFlags, { card: true, loan: true, dual: true });
    assert.equal(r.scores.median, 742);
    assert.equal(r.scores.perBureau.ex, 748);
    assert.equal(r.anchors.revolvingLimit, 15000);
    assert.equal(r.bureauNegatives.experian.clean, true);
    assert.equal(r.topMoves.length, 2);
    assert.equal(typeof r.lenderReach.availableNow, "number");
    assert.equal(typeof r.lenderReach.afterOptimization, "number");
  });

  it("is null-safe for a MANUAL_REVIEW result with no scores / suppressed preapprovals", () => {
    const r = buildCloserResult({
      outcome: "MANUAL_REVIEW",
      outcomeResult: { outcome: "MANUAL_REVIEW", reasonCodes: [] },
      projectedPreapproval: null,
      preapprovals: {
        totalCombined: 0,
        totalPersonal: 0,
        totalBusiness: 0,
        personalCard: { final: 0, eligible: false },
        personalLoan: { final: 0, eligible: false },
        business: { final: 0, eligible: false, capReason: "hard_block" }
      },
      consumerSignals: { scores: { median: null, perBureau: {} } }
    });
    assert.equal(r.outcome, "MANUAL_REVIEW");
    assert.equal(r.projectedTotalCombined, null);
    assert.equal(r.scores.median, null);
    assert.equal(r.scores.perBureau.ex, null);
    assert.deepEqual(r.stackFlags, { card: false, loan: false, dual: false });
    assert.equal(r.anchors.revolvingLimit, null);
    assert.deepEqual(r.bureauNegatives, {});
    assert.deepEqual(r.topMoves, []);
  });

  it("returns null for a null result and never throws", () => {
    assert.equal(buildCloserResult(null), null);
    assert.doesNotThrow(() => buildCloserResult({}));
  });
});
