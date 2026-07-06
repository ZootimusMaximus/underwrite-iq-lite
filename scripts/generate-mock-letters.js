"use strict";

/**
 * generate-mock-letters.js
 *
 * Generates 3 sample Round 1 dispute letters using the actual CRS pipeline:
 *   1. detectViolations(tradeline)  — metro2-violation-checker
 *   2. loadKnowledgeBase(1)         — metro2-kb-loader
 *   3. DISPUTE_ROUND1_PROMPT        — doc-prompts
 *   4. callClaude(...)              — claude-client
 *
 * Saves output to: /Users/darwin1/Documents/projects/fundhub/mar 2026/apr-26/MOCK-DISPUTE-LETTERS.md
 *
 * Run from underwrite-iq-lite/:
 *   node scripts/generate-mock-letters.js
 */

// ---------------------------------------------------------------------------
// Env — must come before any module that reads process.env
// ---------------------------------------------------------------------------

require("dotenv").config({ path: ".env.local" });

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

const fs = require("fs");

const { detectViolations } = require("../api/lite/crs/metro2-violation-checker");
const { loadKnowledgeBase } = require("../api/lite/crs/metro2-kb-loader");
const { callClaude } = require("../api/lite/crs/claude-client");
const { DISPUTE_ROUND1_PROMPT } = require("../api/lite/crs/doc-prompts");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OUTPUT_PATH =
  "/Users/darwin1/Documents/projects/fundhub/mar 2026/apr-26/MOCK-DISPUTE-LETTERS.md";

// Mock consumer — used in the letter body
const personal = {
  firstName: "James",
  lastName: "Richardson",
  address: "4521 Oak Park Drive, Phoenix, AZ 85016"
};

// Bureau mailing addresses (standard)
const BUREAU_ADDRESSES = {
  experian: "Experian\nP.O. Box 4500\nAllen, TX 75013",
  equifax: "Equifax Information Services LLC\nP.O. Box 740256\nAtlanta, GA 30374",
  transunion: "TransUnion LLC\nConsumer Dispute Center\nP.O. Box 2000\nChester, PA 19016"
};

// ---------------------------------------------------------------------------
// Mock tradelines
// ---------------------------------------------------------------------------

const tradelines = [
  {
    _label: "Midland Funding Collection",
    creditorName: "Midland Funding LLC",
    status: "collection",
    currentBalance: 2100,
    chargeOffAmount: 1850,
    currentRatingCode: "9",
    currentRatingType: "CollectionOrChargeOff",
    isDerogatory: true,
    openedDate: "2019-03-15",
    comments: [], // no original creditor comment → COLLECTION_MISSING_ORIGINAL
    adverseRatings: null, // no dates → DOFD_MISSING
    source: "experian",
    accountNumber: "****7421"
  },
  {
    _label: "Capital One Charge-Off",
    creditorName: "Capital One",
    status: "chargeoff",
    currentBalance: 4500, // non-zero on chargeoff → BALANCE violation
    chargeOffAmount: 4500,
    currentRatingCode: "5",
    currentRatingType: "ChargeOff",
    isDerogatory: true,
    openedDate: "2018-06-01",
    closedDate: "2022-01-15",
    pastDue: 4500,
    monthlyPayment: 150, // → CHARGEOFF_WITH_PAYMENTS
    source: "equifax",
    accountNumber: "****3388",
    adverseRatings: {
      mostRecent: { date: "2021-08-01" }
    }
  },
  {
    _label: "Discover Late Payments",
    creditorName: "Discover Financial",
    status: "open",
    accountType: "revolving",
    currentBalance: 3200,
    creditLimit: 5000,
    currentRatingCode: "1", // coded current …
    currentRatingType: "AsAgreed", // … but has pastDue → PAST_DUE_ON_CURRENT
    isDerogatory: false,
    pastDue: 450,
    latePayments: { _30: 3, _60: 1, _90: 0 },
    paymentPattern: "CCCC2C3CCCCCCCCCCCCCC2CC",
    source: "transunion",
    openedDate: "2020-01-10",
    accountNumber: "****9012",
    adverseRatings: null
  }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format violations array into a readable block for the prompt.
 */
function formatViolations(violations) {
  if (!violations || violations.length === 0) {
    return "No programmatic violations detected. Review account manually for accuracy issues.";
  }

  return violations
    .map((v, i) => {
      return [
        `Violation ${i + 1}: ${v.code}`,
        `  Field:       ${v.field}`,
        `  Severity:    ${v.severity}`,
        `  Statute:     ${v.statute}`,
        `  Expected:    ${v.expected}`,
        `  Actual:      ${v.actual}`,
        `  Explanation: ${v.explanation}`
      ].join("\n");
    })
    .join("\n\n");
}

/**
 * Build the full system prompt for Round 1 by replacing placeholders.
 */
function buildPrompt(kbContent, tradeline, violations) {
  const bureauLabel = tradeline.source || "the bureau";
  const bureauName = bureauLabel.charAt(0).toUpperCase() + bureauLabel.slice(1);

  return DISPUTE_ROUND1_PROMPT.replace(/\[BUREAU\]/g, bureauName)
    .replace(/\[FURNISHER\]/g, tradeline.creditorName || "Unknown Furnisher")
    .replace(/\[ACCOUNT_ID\]/g, tradeline.accountNumber || "Unknown")
    .replace(/\[KB_SECTION\]/g, kbContent)
    .replace(/\[VIOLATIONS\]/g, formatViolations(violations));
}

/**
 * Build the user message passed to Claude.
 */
function buildUserMessage(tradeline) {
  const lines = [
    `CONSUMER: ${personal.firstName} ${personal.lastName}`,
    `ADDRESS:  ${personal.address}`,
    "",
    `ACCOUNT DETAILS:`,
    `  Creditor:        ${tradeline.creditorName}`,
    `  Account:         ${tradeline.accountNumber || "on file"}`,
    `  Status:          ${tradeline.status}`,
    `  Current Balance: $${tradeline.currentBalance ?? 0}`,
    `  Source Bureau:   ${tradeline.source}`,
    `  Opened Date:     ${tradeline.openedDate || "unknown"}`
  ];

  if (tradeline.chargeOffAmount) {
    lines.push(`  Charge-Off Amount: $${tradeline.chargeOffAmount}`);
  }
  if (tradeline.closedDate) {
    lines.push(`  Closed Date:       ${tradeline.closedDate}`);
  }
  if (tradeline.pastDue > 0) {
    lines.push(`  Past Due:          $${tradeline.pastDue}`);
  }
  if (tradeline.monthlyPayment > 0) {
    lines.push(`  Monthly Payment:   $${tradeline.monthlyPayment}`);
  }
  if (tradeline.creditLimit > 0) {
    lines.push(`  Credit Limit:      $${tradeline.creditLimit}`);
  }
  if (tradeline.latePayments) {
    const lp = tradeline.latePayments;
    lines.push(`  Late Payments:     30-day: ${lp._30}, 60-day: ${lp._60}, 90-day: ${lp._90}`);
  }

  const bureauAddress = BUREAU_ADDRESSES[tradeline.source.toLowerCase()] || tradeline.source;
  lines.push("", `BUREAU ADDRESS:`, bureauAddress);

  lines.push("", "Please write the complete dispute letter now.");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=============================================================");
  console.log(" FundHub — Mock Dispute Letter Generator");
  console.log("=============================================================");
  console.log(`Consumer: ${personal.firstName} ${personal.lastName}`);
  console.log(`Output:   ${OUTPUT_PATH}`);
  console.log("");

  // Load KB once (cached in module scope after first call)
  console.log("[1/4] Loading Metro 2 Knowledge Base (Round 1)...");
  let kbContent;
  try {
    kbContent = loadKnowledgeBase(1);
    const approxTokens = Math.ceil(kbContent.length / 4);
    console.log(`      KB loaded — ~${approxTokens.toLocaleString()} tokens`);
  } catch (err) {
    console.error("      WARNING: KB load failed:", err.message);
    kbContent = "";
  }
  console.log("");

  const results = []; // { label, source, violations, letter, error }

  for (let i = 0; i < tradelines.length; i++) {
    const tl = tradelines[i];
    console.log(`--------------------------------------------------------------`);
    console.log(`Letter ${i + 1}/3: ${tl._label} (${tl.source.toUpperCase()})`);
    console.log(`--------------------------------------------------------------`);

    // Step 1: Detect violations
    console.log("[2/4] Detecting Metro 2 violations...");
    const { violations } = detectViolations(tl);
    console.log(`      Found ${violations.length} violation(s):`);
    violations.forEach(v => {
      console.log(`        • [${v.severity.toUpperCase()}] ${v.code} — ${v.statute}`);
    });

    // Step 2 already done above (KB loaded once)
    // Step 3: Build prompt
    console.log("[3/4] Building prompt...");
    const systemPrompt = buildPrompt(kbContent, tl, violations);
    const userMessage = buildUserMessage(tl);

    // Step 4: Call Claude
    console.log("[4/4] Calling Claude API...");
    let letter = null;
    let letterError = null;

    try {
      letter = await callClaude({
        system: systemPrompt,
        user: userMessage,
        maxTokens: 2048,
        model: "claude-haiku-4-5", // fast + cheap for demo letters
        temperature: 0.3,
        useCache: true
      });
      console.log(`      Done — ${letter.length.toLocaleString()} chars`);
    } catch (err) {
      letterError = err.message;
      console.error(`      ERROR: ${err.message}`);
    }

    results.push({
      label: tl._label,
      source: tl.source,
      creditor: tl.creditorName,
      accountId: tl.accountNumber || "Unknown",
      violations,
      letter,
      error: letterError
    });

    console.log("");
  }

  // ---------------------------------------------------------------------------
  // Write markdown output
  // ---------------------------------------------------------------------------

  console.log("=============================================================");
  console.log(" Writing output file...");
  console.log("=============================================================");

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

  const mdLines = [
    "# Mock Dispute Letters — Round 1",
    "",
    `**Generated:** ${timestamp}  `,
    `**Consumer:** ${personal.firstName} ${personal.lastName}  `,
    `**Address:** ${personal.address}  `,
    `**Script:** \`scripts/generate-mock-letters.js\``,
    "",
    "---",
    ""
  ];

  results.forEach((r, i) => {
    mdLines.push(`## Letter ${i + 1}: ${r.label}`);
    mdLines.push("");
    mdLines.push(`| Field | Value |`);
    mdLines.push(`|---|---|`);
    mdLines.push(`| Bureau | ${r.source.charAt(0).toUpperCase() + r.source.slice(1)} |`);
    mdLines.push(`| Furnisher | ${r.creditor} |`);
    mdLines.push(`| Account | ${r.accountId} |`);
    mdLines.push(`| Violations Found | ${r.violations.length} |`);
    mdLines.push("");

    if (r.violations.length > 0) {
      mdLines.push("### Detected Violations");
      mdLines.push("");
      mdLines.push("| Code | Severity | Statute |");
      mdLines.push("|---|---|---|");
      r.violations.forEach(v => {
        mdLines.push(`| \`${v.code}\` | ${v.severity} | ${v.statute} |`);
      });
      mdLines.push("");
    }

    mdLines.push("### Generated Letter");
    mdLines.push("");

    if (r.error) {
      mdLines.push(`> **ERROR:** Claude API call failed — ${r.error}`);
    } else if (r.letter) {
      mdLines.push("```");
      mdLines.push(r.letter);
      mdLines.push("```");
    } else {
      mdLines.push("> No letter generated.");
    }

    mdLines.push("");
    mdLines.push("---");
    mdLines.push("");
  });

  // Summary
  const successCount = results.filter(r => r.letter && !r.error).length;
  const totalViolations = results.reduce((sum, r) => sum + r.violations.length, 0);

  mdLines.push("## Summary");
  mdLines.push("");
  mdLines.push(`- **Letters generated:** ${successCount} / ${results.length}`);
  mdLines.push(`- **Total violations detected:** ${totalViolations}`);
  mdLines.push("");
  results.forEach((r, i) => {
    const status = r.error ? "❌ FAILED" : "✅ OK";
    mdLines.push(`- Letter ${i + 1} (${r.label}): ${status} — ${r.violations.length} violation(s)`);
  });

  fs.writeFileSync(OUTPUT_PATH, mdLines.join("\n"), "utf8");

  console.log("");
  console.log(`Output saved to: ${OUTPUT_PATH}`);
  console.log(`Letters: ${successCount}/${results.length} successful`);
  console.log(`Total violations detected: ${totalViolations}`);
  console.log("Done.");
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
