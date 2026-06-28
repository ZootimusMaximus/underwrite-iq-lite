"use strict";

/**
 * generate-deliverables.js — Claude API Document Generation Orchestrator
 *
 * Takes CRS engine output + personal info → calls Claude for each document
 * type → returns generated content ready for PDF rendering.
 */

const { callClaude } = require("./claude-client");
const { matchLenders } = require("./lender-matrix");
const { lookupFurnisherAddress } = require("./furnisher-addresses");
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
const { logInfo, logWarn: _logWarn, logError } = require("../logger");
const { detectViolations } = require("./metro2-violation-checker");
const { loadKnowledgeBase } = require("./metro2-kb-loader");
const { checkCROSimilarity } = require("./cro-similarity-checker");
const { validatePreSend } = require("./presend-validator");

// Prompt lookup used by generateFurnisherLetter
const prompts = {
  DISPUTE_ROUND1_PROMPT,
  DISPUTE_ROUND2_PROMPT,
  DISPUTE_ROUND3_PROMPT
};

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
 * Group tradelines by creditorName.
 * Returns: { "Capital One": [tl1, tl2], "Midland Funding": [tl3] }
 */
function groupByFurnisher(tradelines) {
  const groups = {};
  for (const tl of tradelines) {
    const name = tl.creditorName || "Unknown Creditor";
    if (!groups[name]) groups[name] = [];
    groups[name].push(tl);
  }
  return groups;
}

/**
 * Score and sort furnisher entries by total violation severity, capped at maxCount.
 * High = 3, Medium = 2, Low = 1
 */
function prioritizeFurnishers(furnisherEntries, maxCount) {
  const scored = furnisherEntries.map(([name, tradelines]) => {
    const allViolations = tradelines.flatMap(tl => detectViolations(tl).violations);
    const severityScore = allViolations.reduce((sum, v) => {
      return sum + (v.severity === "high" ? 3 : v.severity === "medium" ? 2 : 1);
    }, 0);
    return { name, tradelines, violations: allViolations, severityScore };
  });

  scored.sort((a, b) => b.severityScore - a.severityScore);
  return scored.slice(0, maxCount).map(s => [s.name, s.tradelines]);
}

/**
 * Generate a single dispute letter for one furnisher on one bureau.
 * Returns the letter object or null if no violations / validation fails.
 */
async function generateFurnisherLetter(
  furnisher,
  tradelines,
  bureau,
  round,
  kbSection,
  personal,
  existingLetters
) {
  // 1. Detect violations for all tradelines in this furnisher group
  const violations = tradelines.flatMap(tl => detectViolations(tl).violations);
  if (violations.length === 0) return null;

  // 2. Get the prompt template and replace placeholders
  const promptKey = `DISPUTE_ROUND${round}_PROMPT`;
  const promptTemplate = prompts[promptKey];

  const systemPrompt = promptTemplate
    .replace("[BUREAU]", bureau.charAt(0).toUpperCase() + bureau.slice(1))
    .replace("[FURNISHER]", furnisher)
    .replace("[ACCOUNT_ID]", tradelines[0]?.accountIdentifier?.slice(-4) || "XXXX")
    .replace("[KB_SECTION]", kbSection)
    .replace("[VIOLATIONS]", JSON.stringify(violations, null, 2));

  // 3. Build user message with client + tradeline data
  const userPayload = {
    client: {
      name: `${personal.firstName || ""} ${personal.lastName || ""}`.trim(),
      address: personal.address || ""
    },
    furnisher,
    bureau,
    round,
    tradelines: tradelines.map(tl => ({
      creditorName: tl.creditorName,
      accountIdentifier: tl.accountIdentifier,
      accountType: tl.accountType,
      status: tl.status,
      currentBalance: tl.currentBalance,
      pastDue: tl.pastDue,
      chargeOffAmount: tl.chargeOffAmount,
      openedDate: tl.openedDate,
      closedDate: tl.closedDate,
      currentRatingCode: tl.currentRatingCode,
      currentRatingType: tl.currentRatingType,
      paymentPattern: tl.paymentPattern,
      ownership: tl.ownership,
      inferredDofd: tl.inferredDofd,
      complianceConditionCode: tl.complianceConditionCode,
      specialCommentCode: tl.specialCommentCode
    })),
    violations: violations.map(v => ({
      code: v.code,
      field: v.field,
      expected: v.expected,
      actual: v.actual,
      statute: v.statute,
      explanation: v.explanation
    }))
  };

  // 4. Call Claude (Round 1 = default Sonnet, Rounds 2/3 = Opus).
  // Use the current Opus (4.8); opus-4-6 was retired. Env-overridable.
  const model = round === 1 ? undefined : process.env.CLAUDE_OPUS_MODEL || "claude-opus-4-8";
  const text = await callClaude({
    system: systemPrompt,
    user: JSON.stringify(userPayload),
    maxTokens: 3000,
    model,
    temperature: 0.4
  });

  if (!text) return null;

  // 5. Validate pre-send
  const furnisherAddress = lookupFurnisherAddress(furnisher);
  const validation = validatePreSend(text, {
    violations,
    round,
    furnisher,
    bureau,
    accountIdentifier: tradelines[0]?.accountIdentifier?.slice(-4) || null,
    furnisherAddress,
    priorRoundText: null
  });

  if (!validation.valid) {
    logError(`generate-deliverables: pre-send validation failed for ${furnisher}/${bureau}`, {
      failures: validation.failures.map(f => f.name)
    });
    return null;
  }

  // 6. CRO similarity check
  const existingTexts = existingLetters.map(l => l.text);
  const similarity = checkCROSimilarity(text, existingTexts);

  if (similarity.similar) {
    // Regenerate once with variation instruction
    const retryText = await callClaude({
      system:
        systemPrompt +
        "\n\nIMPORTANT: Your previous output was too similar to another letter. Vary your sentence structure, word choice, and argument ordering significantly. Use different opening paragraphs and citation patterns.",
      user: JSON.stringify(userPayload),
      maxTokens: 3000,
      model,
      temperature: 0.4
    });

    if (retryText) {
      const retryCheck = checkCROSimilarity(retryText, existingTexts);
      if (!retryCheck.similar) {
        return { type: "dispute", bureau, round, furnisher, violations, text: retryText };
      }
    }
    logError(
      `generate-deliverables: CRO similarity still too high after retry for ${furnisher}/${bureau}`
    );
    return null;
  }

  return { type: "dispute", bureau, round, furnisher, violations, text };
}

/**
 * Generate dispute letters — one per furnisher per dirty bureau (Round 1 only).
 * Rounds 2/3 are generated on-demand.
 * Personal info and inquiry removal letters are generated for all bureaus/outcomes.
 */
async function generateDisputeLetters(crsResult, personal) {
  const { normalized } = crsResult;
  const letters = [];
  const allBureaus = ["experian", "equifax", "transunion"];

  // Per-furnisher dispute letters: dirty bureaus, Round 1 only
  for (const bureauName of allBureaus) {
    const bureauData = crsResult.bureaus?.[bureauName];
    if (!bureauData || bureauData.clean) continue;

    const derogatoryTradelines = (normalized?.tradelines || []).filter(
      t => t.source === bureauName && t.isDerogatory
    );

    if (derogatoryTradelines.length === 0) continue;

    const furnisherGroups = groupByFurnisher(derogatoryTradelines);
    const round = 1;
    const kbSection = loadKnowledgeBase(round);

    // Prioritize furnishers by violation severity (max 15)
    const prioritized = prioritizeFurnishers(Object.entries(furnisherGroups), 15);

    // Process in batches of 3 (parallel within batch, sequential across batches)
    const batchSize = 3;
    for (let i = 0; i < prioritized.length; i += batchSize) {
      const batch = prioritized.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(([furnisher, tradelines]) =>
          generateFurnisherLetter(
            furnisher,
            tradelines,
            bureauName,
            round,
            kbSection,
            personal,
            letters
          )
        )
      );
      letters.push(...results.filter(Boolean));
    }
  }

  // Personal info + inquiry removal: ALL outcomes, ALL bureaus
  for (const bureau of allBureaus) {
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
