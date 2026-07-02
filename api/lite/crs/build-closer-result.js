"use strict";

/**
 * build-closer-result.js — assemble the compact Closer Dashboard payload.
 *
 * The CRS engine computes everything the sales closer needs on every run, but
 * only a handful of scalars were persisted. This maps the full runCRSEngine
 * result into a single JSON blob that lands on the CLIENTS record
 * (latest_crs_result_full) so the read-only Closer Dashboard reads Airtable
 * only — nothing recomputed client-side. See dashboard build spec Item 1.
 *
 * Null-safe: MANUAL_REVIEW / FRAUD_HOLD outcomes can carry null scores and
 * suppressed ($0) pre-approvals — every access is guarded.
 */

const { matchLenders } = require("./lender-matrix");

function buildCloserResult(crsResult) {
  if (!crsResult) return null;

  const cs = crsResult.consumerSignals || {};
  const bs = crsResult.businessSignals || null;
  const pre = crsResult.preapprovals || {};
  const outcome = crsResult.outcomeResult?.outcome || crsResult.outcome || null;

  // matchLenders is never called in the live pipeline — invoke it here for the
  // reach COUNTS only (names are placeholder data and must never be surfaced).
  let lenderReach = { availableNow: 0, afterOptimization: 0 };
  try {
    const m = matchLenders(cs, bs, outcome);
    lenderReach = {
      availableNow: (m?.availableNow || []).length,
      afterOptimization: (m?.afterOptimization || []).length
    };
  } catch {
    // matchLenders is best-effort; a failure must not break the CRS write path.
  }

  const product = p => ({
    final: p?.final ?? 0,
    offerBand: p?.offerBand ?? null,
    eligible: p?.eligible ?? false,
    ...(p?.capReason ? { capReason: p.capReason } : {})
  });

  // Per-bureau clean/dirty + negative counts — drives the split-bureau view.
  const bn = cs.bureauNegatives || {};
  const bureauNegatives = {};
  for (const b of Object.keys(bn)) {
    bureauNegatives[b] = {
      clean: bn[b]?.clean ?? null,
      pulled: bn[b]?.pulled ?? false,
      count: bn[b]?.count ?? 0
    };
  }

  return {
    outcome,
    reasonCodes: crsResult.outcomeResult?.reasonCodes || crsResult.reason_codes || [],
    confidenceBand: pre.confidenceBand ?? null,
    modifiersApplied: pre.modifiersApplied || [],
    preapprovals: {
      totalCombined: pre.totalCombined ?? 0,
      totalPersonal: pre.totalPersonal ?? 0,
      totalBusiness: pre.totalBusiness ?? 0,
      personalCard: product(pre.personalCard),
      personalLoan: product(pre.personalLoan),
      business: product(pre.business)
    },
    // Stack flags = engine-native product eligibility (Chris 2026-07-01: use
    // .eligible, do NOT invent can_*_stack fields).
    stackFlags: {
      card: pre.personalCard?.eligible ?? false,
      loan: pre.personalLoan?.eligible ?? false,
      dual: !!(pre.personalCard?.eligible && pre.personalLoan?.eligible)
    },
    projectedTotalCombined: crsResult.projectedPreapproval?.totalCombined ?? null,
    scores: {
      median: cs.scores?.median ?? null,
      perBureau: {
        ex: cs.scores?.perBureau?.ex ?? null,
        tu: cs.scores?.perBureau?.tu ?? null,
        eq: cs.scores?.perBureau?.eq ?? null
      },
      bureauConfidence: cs.scores?.bureauConfidence ?? null
    },
    utilizationBand: cs.utilization?.band ?? null,
    inquiryPressure: cs.inquiries?.pressure ?? null,
    anchors: {
      revolvingLimit: cs.anchors?.revolving?.limit ?? null,
      installmentAmount: cs.anchors?.installment?.amount ?? null
    },
    bureauNegatives,
    allBureausClean: cs.allBureausClean ?? null,
    anyBureauClean: cs.anyBureauClean ?? null,
    topMoves: (crsResult.suggestions?.topMoves || []).slice(0, 5),
    lenderReach,
    generatedAt: null // stamped by the caller (engine has no Date.now access issue here, but keep write-time stamping in airtable-sync)
  };
}

module.exports = { buildCloserResult };
