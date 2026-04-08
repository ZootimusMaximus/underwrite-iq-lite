"use strict";

/**
 * generate-deliverables.js — Claude API Document Generation Orchestrator
 *
 * Takes CRS engine output + personal info → calls Claude for each document
 * type → returns generated content ready for PDF rendering.
 */

const { callClaude } = require("./claude-client");
const { matchLenders } = require("./lender-matrix");
const {
  CREDIT_ANALYSIS_PROMPT,
  ROADMAP_PROMPT,
  FUNDING_SNAPSHOT_PROMPT,
  LENDER_MATCH_PROMPT,
  DISPUTE_ROUND1_PROMPT,
  DISPUTE_ROUND2_PROMPT,
  DISPUTE_ROUND3_PROMPT,
  PERSONAL_INFO_PROMPT,
  INQUIRY_REMOVAL_PROMPT
} = require("./doc-prompts");
const { logInfo, logWarn, logError } = require("../logger");

// CTA config
function getCTAConfig(outcome) {
  return {
    bookingUrl: process.env.BOOKING_URL || "www.fundhubbookingurl.template",
    outcome,
    academyRef: "Fundhub Academy"
  };
}

/**
 * Build the structured data payload that gets sent to Claude as context.
 */
function buildEngineDataPayload(crsResult, personal, lenderMatches) {
  const {
    outcome,
    consumerSignals,
    businessSignals,
    preapprovals,
    projectedPreapproval,
    suggestions,
    normalized
  } = crsResult;

  return JSON.stringify(
    {
      client: {
        name: personal.name,
        address: personal.address
      },
      outcome,
      scores: consumerSignals.scores,
      utilization: consumerSignals.utilization,
      tradelines: normalized.tradelines,
      auImpact: consumerSignals.auImpact,
      bureauNegatives: consumerSignals.bureauNegatives,
      inquiries: normalized.inquiries,
      personalInfo: normalized.identity,
      preapprovals,
      projectedPreapproval,
      findings: suggestions?.fullSuggestions || [],
      businessSignals,
      lenderMatches,
      cta: getCTAConfig(outcome)
    },
    null,
    2
  );
}

/**
 * Safe Claude call — returns null on failure instead of throwing
 */
async function safeCallClaude(opts, docType) {
  try {
    const result = await callClaude(opts);
    logInfo(`generate-deliverables: ${docType} generated`, {
      length: result.length
    });
    return result;
  } catch (err) {
    logError(`generate-deliverables: ${docType} failed`, {
      error: err.message
    });
    return null;
  }
}

/**
 * Generate dispute letters for dirty bureaus (sequential to avoid rate limits)
 */
async function generateDisputeLetters(crsResult, personal) {
  const { outcome, consumerSignals, normalized } = crsResult;
  const letters = [];
  const bureauNeg = consumerSignals.bureauNegatives || {};

  const needsRepair = outcome === "REPAIR_ONLY" || outcome === "FUNDING_PLUS_REPAIR";

  // Dispute rounds: only for dirty bureaus that need repair
  for (const bureau of ["experian", "equifax", "transunion"]) {
    const bureauInfo = bureauNeg[bureau];
    if (!bureauInfo?.clean === false || !needsRepair) continue;
    if (bureauInfo?.clean) continue;

    const prompts = [
      { round: 1, prompt: DISPUTE_ROUND1_PROMPT },
      { round: 2, prompt: DISPUTE_ROUND2_PROMPT },
      { round: 3, prompt: DISPUTE_ROUND3_PROMPT }
    ];

    for (const { round, prompt } of prompts) {
      const letterData = JSON.stringify({
        client: personal,
        bureau,
        round,
        negativeItems: bureauInfo.items || [],
        tradelines: (normalized.tradelines || []).filter(t => t.source === bureau && t.isDerogatory)
      });

      const text = await safeCallClaude(
        {
          system: prompt.replace("[BUREAU]", bureau.charAt(0).toUpperCase() + bureau.slice(1)),
          user: letterData,
          maxTokens: 3000
        },
        `dispute-round${round}-${bureau}`
      );

      if (text) {
        letters.push({ type: "dispute", bureau, round, text });
      }
    }
  }

  // Personal info + inquiry removal: ALL outcomes, ALL bureaus
  for (const bureau of ["experian", "equifax", "transunion"]) {
    const bureauName = bureau.charAt(0).toUpperCase() + bureau.slice(1);

    const piText = await safeCallClaude(
      {
        system: PERSONAL_INFO_PROMPT.replace("[BUREAU]", bureauName),
        user: JSON.stringify({
          client: personal,
          personalInfo: normalized.identity
        }),
        maxTokens: 2000
      },
      `personal-info-${bureau}`
    );

    if (piText) {
      letters.push({ type: "personal_info", bureau, text: piText });
    }

    const inqText = await safeCallClaude(
      {
        system: INQUIRY_REMOVAL_PROMPT.replace("[BUREAU]", bureauName),
        user: JSON.stringify({
          client: personal,
          inquiries: (normalized.inquiries || []).filter(i => i.source === bureau)
        }),
        maxTokens: 2000
      },
      `inquiry-removal-${bureau}`
    );

    if (inqText) {
      letters.push({ type: "inquiry_removal", bureau, text: inqText });
    }
  }

  return letters;
}

/**
 * generateDeliverables(crsResult, personal)
 *
 * @param {Object} crsResult - Full CRS engine output
 * @param {Object} personal - { name, address }
 * @returns {Object} Generated documents + letters
 */
async function generateDeliverables(crsResult, personal) {
  const { consumerSignals, businessSignals, outcome } = crsResult;

  // Step 1: Match lenders
  const lenderMatches = matchLenders(consumerSignals, businessSignals, outcome);

  // Step 2: Build engine data payload for Claude
  const engineData = buildEngineDataPayload(crsResult, personal, lenderMatches);

  logInfo("generate-deliverables: starting document generation", {
    outcome,
    findingsCount: crsResult.suggestions?.fullSuggestions?.length || 0,
    lendersMatched: lenderMatches.totalMatched
  });

  // Step 3: Generate 4 main documents in parallel
  const [analysis, roadmap, snapshot, lenderList] = await Promise.all([
    safeCallClaude(
      {
        system: CREDIT_ANALYSIS_PROMPT,
        user: engineData,
        maxTokens: 6000
      },
      "credit-analysis"
    ),
    safeCallClaude(
      {
        system: ROADMAP_PROMPT,
        user: engineData,
        maxTokens: 8000
      },
      "roadmap"
    ),
    safeCallClaude(
      {
        system: FUNDING_SNAPSHOT_PROMPT,
        user: engineData,
        maxTokens: 4000
      },
      "funding-snapshot"
    ),
    safeCallClaude(
      {
        system: LENDER_MATCH_PROMPT,
        user: engineData,
        maxTokens: 4000
      },
      "lender-match"
    )
  ]);

  // Step 4: Generate dispute letters (sequential for rate limits)
  const letters = await generateDisputeLetters(crsResult, personal);

  logInfo("generate-deliverables: complete", {
    documents: {
      analysis: !!analysis,
      roadmap: !!roadmap,
      snapshot: !!snapshot,
      lenderList: !!lenderList,
      letterCount: letters.length
    }
  });

  return {
    documents: {
      creditAnalysis: analysis,
      roadmap,
      fundingSnapshot: snapshot,
      lenderMatchList: lenderList
    },
    letters,
    lenderMatches,
    meta: {
      generatedAt: new Date().toISOString(),
      outcome,
      documentsGenerated: [analysis, roadmap, snapshot, lenderList].filter(Boolean).length,
      lettersGenerated: letters.length
    }
  };
}

module.exports = {
  generateDeliverables,
  buildEngineDataPayload,
  generateDisputeLetters
};
