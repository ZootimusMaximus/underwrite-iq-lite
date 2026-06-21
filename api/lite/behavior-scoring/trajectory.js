"use strict";

/**
 * Reads prior BEHAVIOR_SCORES rows for a contact and computes trend.
 * Pure computation over passed-in rows — caller handles Airtable fetch.
 */

/**
 * @param {Array} historyRows - BEHAVIOR_SCORES Airtable .fields objects, sorted by ts asc
 * @param {number|Date} now
 * @returns {{ direction: 'rising'|'flat'|'falling', slope: number, perDimension: object }}
 */
function computeTrajectory(historyRows, now) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const cutoff = nowMs - 14 * 24 * 60 * 60 * 1000;

  const rows = historyRows
    .filter(r => {
      const ts = r.ts ? new Date(r.ts).getTime() : 0;
      return ts >= cutoff;
    })
    .sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));

  if (rows.length < 2) {
    return { direction: "flat", slope: 0, perDimension: {}, data_points: rows.length };
  }

  const compositeSlope = linearSlope(rows.map(r => r.composite || 0));

  const perDimension = {};
  for (const dim of ["responsiveness", "engagement", "friction", "intent"]) {
    const vals = rows.map(r => r[dim] || 0);
    const s = linearSlope(vals);
    perDimension[dim] = {
      slope: s,
      direction: classifySlope(s)
    };
  }

  return {
    direction: classifySlope(compositeSlope),
    slope: parseFloat(compositeSlope.toFixed(4)),
    perDimension,
    data_points: rows.length
  };
}

// Simple least-squares slope (rise per index step)
function linearSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function classifySlope(slope) {
  if (slope > 1) return "rising";
  if (slope < -1) return "falling";
  return "flat";
}

module.exports = { computeTrajectory, linearSlope, classifySlope };
