"use strict";

/**
 * crs-live-test.js — Live End-to-End Test against Stitch Credit Sandbox
 *
 * Usage: node scripts/crs-live-test.js
 *
 * Pulls all 3 bureaus using sandbox test identities, then runs
 * the CRS engine and validates the full output shape.
 */

// Load .env.local
const fs = require("fs");
const path = require("path");
const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const {
  authenticate,
  pullConsumerBureau,
  pullAllConsumerBureaus
} = require("../api/lite/crs/stitch-credit-client");
const { runCRSEngine } = require("../api/lite/crs/engine");

// ---------------------------------------------------------------------------
// Sandbox Test Identities
// ---------------------------------------------------------------------------

const TEST_APPLICANTS = {
  transunion: {
    firstName: "BARBARA",
    middleName: "M",
    lastName: "DOTY",
    ssn: "666321120",
    birthDate: "1966-01-04",
    address: {
      addressLine1: "1234 MAIN ST",
      city: "DENTON",
      state: "TX",
      postalCode: "76201"
    }
  },
  experian: {
    firstName: "WILLIE",
    middleName: "L",
    lastName: "BOOZE",
    ssn: "666265040",
    birthDate: "1963-11-12",
    address: {
      addressLine1: "1234 MAIN ST",
      city: "SAN ANTONIO",
      state: "TX",
      postalCode: "78201"
    }
  },
  equifax: {
    firstName: "JOHN",
    middleName: "V",
    lastName: "BIALOGLOW",
    ssn: "666154480",
    birthDate: "1958-12-04",
    address: {
      addressLine1: "1234 MAIN ST",
      city: "WAHIAWA",
      state: "HI",
      postalCode: "96786"
    }
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hr(title) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function check(label, condition) {
  const icon = condition ? "\u2705" : "\u274C";
  console.log(`  ${icon} ${label}`);
  return condition;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testAuth() {
  hr("Step 1: Authentication");
  const token = await authenticate();
  check("Got JWT token", !!token);
  check("Token is string", typeof token === "string");
  check("Token length > 50", token.length > 50);
  console.log(`  Token preview: ${token.substring(0, 40)}...`);
  return token;
}

async function testSingleBureau(bureau) {
  hr(`Step 2: Single Bureau Pull — ${bureau.toUpperCase()}`);
  const applicant = TEST_APPLICANTS[bureau];
  const start = Date.now();
  const response = await pullConsumerBureau(bureau, applicant);
  const elapsed = Date.now() - start;
  console.log(`  Response time: ${elapsed}ms`);

  check("Response is object", typeof response === "object");
  check("Has creditFiles", Array.isArray(response.creditFiles));
  check("Has tradelines", Array.isArray(response.tradelines));
  check("Has scores", Array.isArray(response.scores));
  check("Has inquiries", Array.isArray(response.inquiries));

  if (response.scores?.length > 0) {
    const score = response.scores[0];
    console.log(`  Score: ${score.scoreName || score.modelName} = ${score.scoreValue}`);
  }
  console.log(`  Tradelines: ${response.tradelines?.length || 0}`);
  console.log(`  Inquiries: ${response.inquiries?.length || 0}`);
  console.log(`  Public Records: ${response.publicRecords?.length || 0}`);

  return response;
}

async function testAllBureaus() {
  hr("Step 3: Parallel All-Bureau Pull (TU identity)");
  const applicant = TEST_APPLICANTS.transunion;
  const start = Date.now();
  const { responses, errors } = await pullAllConsumerBureaus(applicant);
  const elapsed = Date.now() - start;
  console.log(`  Total response time: ${elapsed}ms`);

  check(`Got ${responses.length} successful responses`, responses.length > 0);
  if (errors.length > 0) {
    console.log(`  Errors (${errors.length}):`);
    errors.forEach(e => console.log(`    - ${e.bureau}: ${e.error}`));
  }
  return { responses, errors };
}

async function testCRSEngine(rawResponses) {
  hr("Step 4: CRS Engine — Full Pipeline");
  const start = Date.now();
  const result = runCRSEngine({
    rawResponses,
    businessReport: null,
    submittedName: "BARBARA M DOTY",
    submittedAddress: "1234 MAIN ST, DENTON, TX 76201",
    formData: {
      email: "test@fundhub.ai",
      phone: "5551234567",
      name: "BARBARA M DOTY",
      ref: "live-test-001"
    }
  });
  const elapsed = Date.now() - start;
  console.log(`  Engine time: ${elapsed}ms`);

  check("result.ok === true", result.ok === true);
  check("Has outcome", !!result.outcome);
  check("Has decision_label", !!result.decision_label);
  check("Has decision_explanation", !!result.decision_explanation);
  check("Has reason_codes[]", Array.isArray(result.reason_codes));
  check("Has confidence", !!result.confidence);
  check("Has consumer_summary", typeof result.consumer_summary === "string");
  check("Has preapprovals", !!result.preapprovals);
  check("Has optimization_findings[]", Array.isArray(result.optimization_findings));
  check("Has suggestions", !!result.suggestions);
  check("Has cards", !!result.cards);
  check("Has documents", !!result.documents);
  check("Has audit", !!result.audit);
  check("Has redirect", !!result.redirect);
  check("Has crm_payload", !!result.crm_payload);

  console.log(`\n  --- Engine Output Summary ---`);
  console.log(`  Outcome: ${result.outcome}`);
  console.log(`  Decision: ${result.decision_label}`);
  console.log(`  Explanation: ${result.decision_explanation}`);
  console.log(`  Confidence: ${result.confidence}`);
  console.log(`  Reason Codes: ${result.reason_codes?.join(", ") || "none"}`);
  console.log(`  Consumer Summary: ${result.consumer_summary?.substring(0, 120)}...`);
  if (result.preapprovals) {
    console.log(`  Pre-approvals:`);
    console.log(
      `    Total Personal: $${(result.preapprovals.totalPersonal || 0).toLocaleString()}`
    );
    console.log(
      `    Total Business: $${(result.preapprovals.totalBusiness || 0).toLocaleString()}`
    );
    console.log(
      `    Total Combined: $${(result.preapprovals.totalCombined || 0).toLocaleString()}`
    );
  }
  console.log(`  Findings: ${result.optimization_findings?.length || 0} categories`);
  console.log(`  Documents: ${result.documents?.letters?.length || 0} letters`);
  console.log(`  Summary Docs: ${result.documents?.summaryDocuments?.length || 0}`);

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n  CRS Live E2E Test — Stitch Credit Sandbox");
  console.log(`  API Base: ${process.env.STITCH_CREDIT_API_BASE}`);
  console.log(`  Email: ${process.env.STITCH_CREDIT_EMAIL}`);
  console.log(`  Time: ${new Date().toISOString()}`);

  let passed = 0;
  let failed = 0;

  try {
    // Step 1: Auth
    await testAuth();
    passed++;
  } catch (err) {
    console.error(`  FATAL: Auth failed — ${err.message}`);
    failed++;
    process.exit(1);
  }

  // Step 2: Single bureau pull (TU — most reliable sandbox identity)
  let tuResponse;
  try {
    tuResponse = await testSingleBureau("transunion");
    passed++;
  } catch (err) {
    console.error(`  FAILED: TU pull — ${err.message}`);
    failed++;
  }

  // Step 3: All bureaus (will likely get errors for EXP/EFX since we're using TU identity)
  let allResponses;
  try {
    const result = await testAllBureaus();
    allResponses = result.responses;
    passed++;
  } catch (err) {
    console.error(`  FAILED: All bureaus — ${err.message}`);
    failed++;
  }

  // Step 4: CRS Engine
  const engineInput = allResponses?.length > 0 ? allResponses : tuResponse ? [tuResponse] : null;
  if (engineInput) {
    try {
      await testCRSEngine(engineInput);
      passed++;
    } catch (err) {
      console.error(`  FAILED: Engine — ${err.message}`);
      console.error(err.stack);
      failed++;
    }
  } else {
    console.log("\n  SKIPPED: No bureau responses available for engine test");
    failed++;
  }

  // Summary
  hr("Summary");
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Status: ${failed === 0 ? "ALL PASSED" : "SOME FAILURES"}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("\nFATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
