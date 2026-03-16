"use strict";

/**
 * build-audit-trail.js — Stage 12: Audit Trail Builder
 *
 * Records pipeline execution details for debugging and compliance.
 */

const ENGINE_VERSION = "2.0.0-crs";

/**
 * buildAuditTrail(options)
 *
 * @param {Object} options
 * @param {Object} options.normalized
 * @param {Object} options.identityGate
 * @param {Object} options.consumerSignals
 * @param {Object} options.businessSignals
 * @param {Object} options.outcomeResult
 * @param {Object} options.preapprovals
 * @param {Array} options.findings
 * @param {Object} options.timings - { normalize, identityGate, consumer, business, outcome, preapprovals, findings, suggestions, output }
 * @returns {Object} Audit trail
 */
function buildAuditTrail(options) {
  const {
    normalized,
    identityGate,
    consumerSignals,
    businessSignals,
    outcomeResult,
    preapprovals,
    findings,
    timings
  } = options;
  const cs = consumerSignals;
  const t = timings || {};

  const pipeline = [
    {
      stage: "normalize",
      durationMs: t.normalize || 0,
      inputBureaus: normalized.meta.bureauCount,
      tradelinesFound: normalized.tradelines.length
    },
    {
      stage: "identityGate",
      durationMs: t.identityGate || 0,
      passed: identityGate?.passed ?? null
    },
    { stage: "consumerSignals", durationMs: t.consumer || 0, medianScore: cs.scores.median },
    {
      stage: "businessSignals",
      durationMs: t.business || 0,
      available: businessSignals?.available || false
    },
    {
      stage: "routeOutcome",
      durationMs: t.outcome || 0,
      outcome: outcomeResult.outcome,
      reasonCodes: outcomeResult.reasonCodes
    },
    {
      stage: "preapprovals",
      durationMs: t.preapprovals || 0,
      totalCombined: preapprovals.totalCombined
    },
    { stage: "optimizationFindings", durationMs: t.findings || 0, findingsCount: findings.length },
    { stage: "suggestions", durationMs: t.suggestions || 0 },
    { stage: "output", durationMs: t.output || 0 }
  ];

  const decisionsLog = [];

  // ── Identity Gate Detail ────────────────────────────────────────────
  if (identityGate) {
    const gateStatus = identityGate.passed ? "PASSED" : `BLOCKED → ${identityGate.outcome}`;
    decisionsLog.push(`identityGate: ${gateStatus} (confidence=${identityGate.confidence})`);
    if (identityGate.reasons?.length > 0) {
      decisionsLog.push(`identityGate.reasons: [${identityGate.reasons.join(", ")}]`);
    }
  }

  // ── Consumer Signal Summary ─────────────────────────────────────────
  decisionsLog.push(
    `medianScore=${cs.scores.median} from ${normalized.meta.bureauCount} bureau(s) (confidence=${cs.scores.bureauConfidence})`
  );
  if (cs.utilization.pct != null) {
    decisionsLog.push(`utilization=${cs.utilization.pct}% (${cs.utilization.band} band)`);
  }
  if (cs.derogatories?.active > 0) {
    decisionsLog.push(
      `activeDerogatories=${cs.derogatories.active} (chargeoffs=${cs.derogatories.chargeoffs ?? 0}, collections=${cs.derogatories.collections ?? 0})`
    );
  } else {
    decisionsLog.push("no active derogatories");
  }
  if (cs.tradelines?.thinFile) decisionsLog.push("thinFile=true");
  if (cs.tradelines?.auDominance > 0.4)
    decisionsLog.push(`auDominance=${Math.round(cs.tradelines.auDominance * 100)}%`);
  if (cs.inquiries && cs.inquiries.pressure !== "low")
    decisionsLog.push(`inquiryPressure=${cs.inquiries.pressure} (last6Mo=${cs.inquiries.last6Mo})`);

  // ── Business Signal Summary ─────────────────────────────────────────
  if (businessSignals?.available) {
    decisionsLog.push(
      `business: intelliscore=${businessSignals.scores?.intelliscore}, fsr=${businessSignals.scores?.fsr}, blocked=${businessSignals.hardBlock?.blocked}`
    );
  }

  // ── Outcome Routing ─────────────────────────────────────────────────
  decisionsLog.push(`outcome=${outcomeResult.outcome} (confidence=${outcomeResult.confidence})`);
  if (outcomeResult.reasonCodes?.length > 0) {
    decisionsLog.push(`reasonCodes: [${outcomeResult.reasonCodes.join(", ")}]`);
  }
  if (outcomeResult.businessBoostApplied) {
    decisionsLog.push(`businessBoost applied: ${outcomeResult.businessBoostDetail}`);
  }

  // ── Pre-Approval Summary ────────────────────────────────────────────
  decisionsLog.push(
    `totalFunding=$${preapprovals.totalCombined} (card=$${preapprovals.personalCard?.final || 0}, loan=$${preapprovals.personalLoan?.final || 0}, biz=$${preapprovals.business?.final || 0})`
  );
  if (preapprovals.modifiersApplied?.length > 0) {
    decisionsLog.push(`modifiers: [${preapprovals.modifiersApplied.join(", ")}]`);
  }
  decisionsLog.push(
    `customerSafe=${preapprovals.customerSafe ?? "unknown"}, confidenceBand=${preapprovals.confidenceBand ?? "unknown"}`
  );

  return {
    engineVersion: ENGINE_VERSION,
    timestamp: new Date().toISOString(),
    pipeline,
    decisionsLog
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { buildAuditTrail, ENGINE_VERSION };
