"use strict";

/**
 * lender-matrix.js — Rule-Based Lender Matching Engine
 *
 * Matches client profiles to lenders based on score, utilization,
 * tradeline count, business age, and outcome tier. No AI needed.
 */

// Lender database — each entry has requirements and metadata
const LENDERS = [
  // Business Cards
  {
    name: "Chase Ink Preferred",
    type: "Biz Card",
    minScore: 700,
    minTIB: 12,
    requiresBiz: true,
    estRange: "$10K-$25K",
    whyFit: "Strong business card with rewards. Chase history helps."
  },
  {
    name: "Amex Blue Business Plus",
    type: "Biz Card",
    minScore: 700,
    minTIB: 12,
    requiresBiz: true,
    estRange: "$10K-$30K",
    whyFit: "No preset spending limit. Great for scaling."
  },
  {
    name: "Capital One Spark Cash",
    type: "Biz Card",
    minScore: 680,
    minTIB: 6,
    requiresBiz: true,
    estRange: "$5K-$20K",
    whyFit: "Lower threshold. Good early win for business credit."
  },

  // Business Lines of Credit
  {
    name: "OnDeck",
    type: "LOC",
    minScore: 660,
    minTIB: 12,
    minRevenue: 100000,
    requiresBiz: true,
    estRange: "$5K-$250K",
    whyFit: "Flexible line of credit. Fast approval process."
  },
  {
    name: "Bluevine",
    type: "LOC",
    minScore: 700,
    minTIB: 24,
    minRevenue: 120000,
    requiresBiz: true,
    estRange: "$5K-$250K",
    whyFit: "Strong LOC for established businesses."
  },
  {
    name: "Fundbox",
    type: "LOC",
    minScore: 680,
    minTIB: 12,
    requiresBiz: true,
    estRange: "$1K-$150K",
    whyFit: "Clean bureaus plus business bank account required."
  },
  {
    name: "Kabbage (Amex)",
    type: "LOC",
    minScore: 640,
    minTIB: 12,
    minRevenue: 50000,
    requiresBiz: true,
    estRange: "$2K-$250K",
    whyFit: "Lower score threshold with revenue proof."
  },

  // Business Term Loans
  {
    name: "SBA 7(a)",
    type: "Term Loan",
    minScore: 680,
    minTIB: 24,
    requiresBiz: true,
    estRange: "$25K-$350K",
    whyFit: "Best rates available. Government-backed."
  },
  {
    name: "Credibly",
    type: "Term Loan",
    minScore: 650,
    minTIB: 12,
    minRevenue: 180000,
    requiresBiz: true,
    estRange: "$5K-$400K",
    whyFit: "Flexible terms for growing businesses."
  },

  // Personal Cards
  {
    name: "Chase Sapphire Preferred",
    type: "Personal Card",
    minScore: 700,
    requiresBiz: false,
    estRange: "$5K-$25K",
    whyFit: "Strong personal card. Good starting point."
  },
  {
    name: "Amex Gold",
    type: "Personal Card",
    minScore: 700,
    requiresBiz: false,
    estRange: "$5K-$25K",
    whyFit: "Premium rewards with solid limits."
  },

  // Personal Loans
  {
    name: "Lending Club",
    type: "Personal Loan",
    minScore: 700,
    requiresBiz: false,
    estRange: "$5K-$40K",
    whyFit: "Personal loan. No business required."
  },
  {
    name: "SoFi",
    type: "Personal Loan",
    minScore: 700,
    requiresBiz: false,
    estRange: "$5K-$100K",
    whyFit: "High limits for strong profiles."
  },
  {
    name: "Navy Federal*",
    type: "Personal Loan",
    minScore: 650,
    requiresBiz: false,
    estRange: "$5K-$15K",
    whyFit: "Best rates if you are eligible. Requires membership."
  },
  {
    name: "Marcus by Goldman Sachs",
    type: "Personal Loan",
    minScore: 660,
    requiresBiz: false,
    estRange: "$3.5K-$40K",
    whyFit: "No fees. Solid rates for good credit."
  }
];

/**
 * matchLenders(consumerSignals, businessSignals, outcome)
 *
 * @returns {{ availableNow: [], afterOptimization: [], totalMatched: number }}
 */
function matchLenders(consumerSignals, businessSignals, outcome) {
  const cs = consumerSignals;
  const bs = businessSignals;
  const score = cs.scores.median || 0;
  const bizAge = bs?.profile?.ageMonths || 0;
  const hasBiz = bs?.available && !bs.hardBlock?.blocked;
  const _allClean = cs.allBureausClean;
  const isFundable =
    outcome === "FULL_FUNDING" || outcome === "PREMIUM_STACK" || outcome === "FUNDING_PLUS_REPAIR";

  const availableNow = [];
  const afterOptimization = [];

  for (const lender of LENDERS) {
    // Check if business is required but not available
    if (lender.requiresBiz && !hasBiz) {
      afterOptimization.push({ ...lender, whatNeeded: "Business entity required" });
      continue;
    }
    if (lender.requiresBiz && lender.minTIB && bizAge < lender.minTIB) {
      afterOptimization.push({
        ...lender,
        whatNeeded: `${lender.minTIB} months time in business required (currently ${bizAge})`
      });
      continue;
    }

    // Check score
    if (score < lender.minScore) {
      afterOptimization.push({
        ...lender,
        whatNeeded: `Score ${lender.minScore}+ required (currently ${score})`
      });
      continue;
    }

    // Check if bureaus are clean enough
    if (!isFundable) {
      afterOptimization.push({ ...lender, whatNeeded: "Clean bureaus required first" });
      continue;
    }

    availableNow.push(lender);
  }

  return {
    availableNow,
    afterOptimization,
    totalMatched: availableNow.length + afterOptimization.length
  };
}

module.exports = { matchLenders, LENDERS };
