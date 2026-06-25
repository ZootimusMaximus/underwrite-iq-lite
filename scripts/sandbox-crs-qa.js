"use strict";

/**
 * sandbox-crs-qa.js — Sandbox-Only CRS Pipeline QA
 *
 * SAFETY: Explicitly forces STITCH_CREDIT_API_BASE to the sandbox URL
 * (api-sandbox.stitchcredit.com) BEFORE any module loads, regardless of
 * what .env.local sets. If the override fails, we abort before any network call.
 *
 * Usage: node scripts/sandbox-crs-qa.js
 *
 * NEVER touches production CRS. Reads sandbox creds from .env.local.
 * Does NOT write to Airtable or GHL — calls stitch-credit-client + engine only.
 */

// ---------------------------------------------------------------------------
// 1. Force sandbox URL FIRST (before any module load)
// ---------------------------------------------------------------------------

const SANDBOX_URL = "https://api-sandbox.stitchcredit.com";
process.env.STITCH_CREDIT_API_BASE = SANDBOX_URL;

// ---------------------------------------------------------------------------
// 2. Load .env.local for credentials (username + password only)
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env.local");
if (!fs.existsSync(envPath)) {
  console.error("FATAL: .env.local not found — cannot load sandbox credentials");
  process.exit(1);
}

const envLines = fs.readFileSync(envPath, "utf8").split("\n");
for (const line of envLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const val = trimmed
    .slice(eqIdx + 1)
    .trim()
    .replace(/^["']|["']$/g, ""); // strip surrounding quotes
  // Only set creds — DO NOT allow .env.local to override our sandbox URL
  if (key === "STITCH_CREDIT_USERNAME" || key === "STITCH_CREDIT_EMAIL" || key === "STITCH_CREDIT_PASSWORD") {
    process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// 3. Safety check: abort if API base got overridden somehow
// ---------------------------------------------------------------------------

if (process.env.STITCH_CREDIT_API_BASE !== SANDBOX_URL) {
  console.error(
    `FATAL: STITCH_CREDIT_API_BASE was overridden to ${process.env.STITCH_CREDIT_API_BASE} — aborting to prevent production access`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Require modules AFTER env is set
// ---------------------------------------------------------------------------

const {
  authenticate,
  pullConsumerBureau,
  pullAllConsumerBureaus,
  invalidateToken
} = require("../api/lite/crs/stitch-credit-client");

const { runCRSEngine } = require("../api/lite/crs/engine");

// ---------------------------------------------------------------------------
// Sandbox Test Identities
// Known to return canned data from Stitch sandbox
// ---------------------------------------------------------------------------

const IDENTITIES = {
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

const CHECKS = { passed: 0, failed: 0 };

function hr(title) {
  console.log(`\n${"=".repeat(62)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(62));
}

function check(label, condition, detail = "") {
  const icon = condition ? "PASS" : "FAIL";
  const d = detail ? ` | ${detail}` : "";
  console.log(`  [${icon}] ${label}${d}`);
  if (condition) CHECKS.passed++;
  else CHECKS.failed++;
  return condition;
}

function note(msg) {
  console.log(`  NOTE: ${msg}`);
}

// ---------------------------------------------------------------------------
// Stage 1: Auth
// ---------------------------------------------------------------------------

async function stage1_auth() {
  hr("STAGE 1 — Authentication");
  console.log(`  API Base: ${process.env.STITCH_CREDIT_API_BASE}`);
  console.log(`  Username: ${process.env.STITCH_CREDIT_USERNAME || process.env.STITCH_CREDIT_EMAIL || "(not set)"}`);

  invalidateToken(); // ensure fresh token fetch
  const t0 = Date.now();
  const token = await authenticate();
  const ms = Date.now() - t0;

  check("Got JWT token", !!token);
  check("Token is string", typeof token === "string");
  check("Token length > 50", token.length > 50, `length=${token.length}`);
  check("Response time < 10s", ms < 10000, `${ms}ms`);

  console.log(`  Token preview: ${token.substring(0, 40)}...`);
  return token;
}

// ---------------------------------------------------------------------------
// Stage 2: Per-bureau single pulls
// ---------------------------------------------------------------------------

async function stage2_perBureau() {
  hr("STAGE 2 — Per-Bureau Single Pulls");

  const results = {};

  for (const [bureau, applicant] of Object.entries(IDENTITIES)) {
    console.log(`\n  -- ${bureau.toUpperCase()} (SSN: ${applicant.ssn.substring(0, 3)}****) --`);
    const t0 = Date.now();
    try {
      const resp = await pullConsumerBureau(bureau, applicant);
      const ms = Date.now() - t0;

      check(`${bureau}: pull succeeded`, true, `${ms}ms`);
      check(`${bureau}: has creditFiles[]`, Array.isArray(resp.creditFiles));
      check(`${bureau}: has tradelines[]`, Array.isArray(resp.tradelines));
      check(`${bureau}: has scores[]`, Array.isArray(resp.scores));
      check(`${bureau}: has inquiries[]`, Array.isArray(resp.inquiries));

      const scoreVal = resp.scores?.[0]?.scoreValue;
      const scoreModel = resp.scores?.[0]?.scoreName || resp.scores?.[0]?.modelName || "?";
      console.log(`    Score: ${scoreVal ?? "none"} (${scoreModel})`);
      console.log(`    Tradelines: ${resp.tradelines?.length ?? 0}`);
      console.log(`    Inquiries: ${resp.inquiries?.length ?? 0}`);
      console.log(`    Public Records: ${resp.publicRecords?.length ?? 0}`);

      // Check response shape matches what normalize-soft-pull.js expects
      check(`${bureau}: repositoryIncluded present`, !!resp.repositoryIncluded);
      check(`${bureau}: requestData present`, !!resp.requestData);

      results[bureau] = resp;
    } catch (err) {
      check(`${bureau}: pull succeeded`, false, err.message);
      note(`Tried identity: ${applicant.firstName} ${applicant.lastName}, SSN ${applicant.ssn.substring(0, 3)}****`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stage 3: Parallel all-bureau pull (TU identity, most reliable)
// ---------------------------------------------------------------------------

async function stage3_parallelPull() {
  hr("STAGE 3 — Parallel All-Bureau Pull (TU identity)");
  const applicant = IDENTITIES.transunion;
  const t0 = Date.now();

  const { responses, errors } = await pullAllConsumerBureaus(applicant, [
    "transunion",
    "experian",
    "equifax"
  ]);
  const ms = Date.now() - t0;

  check("At least 1 bureau responded", responses.length > 0, `got ${responses.length}`);
  console.log(`  Errors (${errors.length}):`);
  errors.forEach(e => console.log(`    - ${e.bureau}: ${e.error}`));
  console.log(`  Total time: ${ms}ms`);

  return responses;
}

// ---------------------------------------------------------------------------
// Stage 4: Normalize + full engine (no Airtable/GHL)
// ---------------------------------------------------------------------------

async function stage4_engine(rawResponses, submittedName) {
  hr("STAGE 4 — CRS Engine (normalize → signals → route → preapprovals → findings)");

  if (!rawResponses || rawResponses.length === 0) {
    check("Engine has input responses", false, "no responses passed in");
    return null;
  }

  check("Engine has input responses", true, `${rawResponses.length} bureau(s)`);

  const t0 = Date.now();
  let result;
  try {
    result = runCRSEngine({
      rawResponses,
      businessReport: null,
      submittedName: submittedName || "BARBARA M DOTY",
      submittedAddress: "1234 MAIN ST, DENTON, TX 76201",
      formData: {
        email: "sandbox-qa@fundhub.ai",
        phone: "5551234567",
        name: submittedName || "BARBARA M DOTY",
        ref: "sandbox-crs-qa-001"
      }
    });
  } catch (err) {
    check("Engine ran without throwing", false, `${err.constructor.name}: ${err.message}`);
    console.error("  Stack:", err.stack?.split("\n").slice(0, 5).join("\n  "));
    return null;
  }
  const ms = Date.now() - t0;

  check("Engine ran without throwing", true, `${ms}ms`);

  // Shape checks
  check("result.ok === true", result.ok === true);
  check("Has outcome string", typeof result.outcome === "string" && result.outcome.length > 0);
  check("Outcome is valid tier", ["FRAUD_HOLD","MANUAL_REVIEW","REPAIR_ONLY","FUNDING_PLUS_REPAIR","FULL_FUNDING","PREMIUM_STACK"].includes(result.outcome));
  check("Has decision_label", typeof result.decision_label === "string");
  check("Has reason_codes[]", Array.isArray(result.reason_codes));
  check("Has confidence", typeof result.confidence === "string" || typeof result.confidence === "number");
  check("Has consumer_summary (string)", typeof result.consumer_summary === "string");
  check("Has preapprovals object", typeof result.preapprovals === "object" && result.preapprovals !== null);
  check("preapprovals.totalCombined is number", typeof result.preapprovals?.totalCombined === "number");
  check("Has optimization_findings[]", Array.isArray(result.optimization_findings));
  check("Has suggestions", !!result.suggestions);
  check("Has cards", !!result.cards);
  check("Has documents", typeof result.documents === "object");
  check("Has audit", typeof result.audit === "object");
  check("Has redirect", typeof result.redirect === "object");
  check("Has crm_payload", typeof result.crm_payload === "object");
  check("Has normalized (internal)", typeof result.normalized === "object");
  check("Has consumerSignals (internal)", typeof result.consumerSignals === "object");

  // Scores
  const scores = result.consumerSignals?.scores;
  check("consumerSignals.scores present", !!scores);

  // Key result fields
  console.log("\n  --- Final Engine Output ---");
  console.log(`  Outcome tier:      ${result.outcome}`);
  console.log(`  Decision label:    ${result.decision_label}`);
  console.log(`  Confidence:        ${result.confidence}`);
  console.log(`  Reason codes:      ${(result.reason_codes || []).join(", ") || "none"}`);
  console.log(`  Consumer summary:  ${(result.consumer_summary || "").substring(0, 100)}...`);
  console.log(`  Score (median):    ${result.consumerSignals?.scores?.median ?? "N/A"}`);
  console.log(`  Utilization:       ${result.consumerSignals?.utilization?.pct ?? "N/A"}%`);
  console.log(`  Active derogs:     ${result.consumerSignals?.derogatories?.active ?? "N/A"}`);
  console.log(`  Thin file:         ${result.consumerSignals?.tradelines?.thinFile ?? "N/A"}`);

  if (result.preapprovals) {
    console.log(`\n  Pre-approvals:`);
    console.log(`    Personal total:  $${(result.preapprovals.totalPersonal || 0).toLocaleString()}`);
    console.log(`    Business total:  $${(result.preapprovals.totalBusiness || 0).toLocaleString()}`);
    console.log(`    Combined total:  $${(result.preapprovals.totalCombined || 0).toLocaleString()}`);
  }

  console.log(`\n  Findings:          ${result.optimization_findings?.length || 0}`);
  if (result.optimization_findings?.length) {
    result.optimization_findings.slice(0, 5).forEach(f => {
      console.log(`    - [${f.priority || "?"}] ${f.code}: ${(f.title || "").substring(0, 60)}`);
    });
    if (result.optimization_findings.length > 5) {
      console.log(`    ... (${result.optimization_findings.length - 5} more)`);
    }
  }

  console.log(`  Letters:           ${result.documents?.letters?.length || 0}`);
  console.log(`  Summary docs:      ${result.documents?.summaryDocuments?.length || 0}`);
  console.log(`  Redirect path:     ${result.redirect?.path || "none"}`);

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n============================================================");
  console.log("  CRS SANDBOX QA — FundHub UnderwriteIQ");
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log(`  Confirmed Sandbox URL: ${SANDBOX_URL}`);
  console.log("  NOTE: NO Airtable or GHL writes — pipeline-only");
  console.log("============================================================");

  // Stage 1: Auth
  try {
    await stage1_auth();
  } catch (err) {
    console.error(`\nFATAL: Auth failed — ${err.message}`);
    console.error(`  (Attempted URL: ${SANDBOX_URL})`);
    process.exit(1);
  }

  // Stage 2: Per-bureau pulls
  let perBureauResults = {};
  try {
    perBureauResults = await stage2_perBureau();
  } catch (err) {
    console.error(`\nStage 2 error: ${err.message}`);
  }

  // Stage 3: Parallel pull
  let parallelResponses = [];
  try {
    parallelResponses = await stage3_parallelPull();
  } catch (err) {
    console.error(`\nStage 3 error: ${err.message}`);
  }

  // Stage 4: Engine — use best available input
  // Prefer per-bureau TU response (most data) or fall back to parallel results
  const tuResp = perBureauResults.transunion;
  const engineInput = parallelResponses.length > 0
    ? parallelResponses
    : tuResp
    ? [tuResp]
    : Object.values(perBureauResults).filter(Boolean);

  const engineResult = await stage4_engine(engineInput, "BARBARA M DOTY");

  // ---------------------------------------------------------------------------
  // Final summary
  // ---------------------------------------------------------------------------

  hr("QA SUMMARY");
  console.log(`  Checks passed:  ${CHECKS.passed}`);
  console.log(`  Checks failed:  ${CHECKS.failed}`);
  console.log(`  Total checks:   ${CHECKS.passed + CHECKS.failed}`);
  console.log(`  Result:         ${CHECKS.failed === 0 ? "ALL PASSED" : `${CHECKS.failed} FAILURES`}`);

  if (CHECKS.failed > 0) {
    console.log("\n  Search output above for [FAIL] lines.");
  }

  process.exit(CHECKS.failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("\nUNHANDLED ERROR:", err.message);
  console.error(err.stack);
  process.exit(1);
});
