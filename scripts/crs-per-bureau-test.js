"use strict";

/**
 * crs-per-bureau-test.js — Per-Bureau CRS Engine Test using Saved Sandbox Responses
 *
 * Usage: node scripts/crs-per-bureau-test.js
 *
 * Loads saved JSON responses from disk (no API calls), runs the CRS engine
 * on each bureau individually and then on all 3 combined.
 */

// ---------------------------------------------------------------------------
// Load .env.local (same pattern as crs-live-test.js)
// ---------------------------------------------------------------------------
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

const { runCRSEngine } = require("../api/lite/crs/engine");

// ---------------------------------------------------------------------------
// Paths to saved sandbox responses
// ---------------------------------------------------------------------------
const SANDBOX_DIR = path.join(__dirname, "..", "..", "mar 2026");

const RESPONSE_FILES = {
  transunion: path.join(SANDBOX_DIR, "tu-sandbox-response.json"),
  experian: path.join(SANDBOX_DIR, "exp-sandbox-response.json"),
  equifax: path.join(SANDBOX_DIR, "efx-sandbox-response.json")
};

// ---------------------------------------------------------------------------
// Test run configurations
// ---------------------------------------------------------------------------
const RUNS = [
  {
    label: "TU Only — BARBARA M DOTY",
    bureaus: ["transunion"],
    submittedName: "BARBARA M DOTY",
    submittedAddress: "1234 MAIN ST, DENTON, TX 76201"
  },
  {
    label: "EXP Only — WILLIE L BOOZE",
    bureaus: ["experian"],
    submittedName: "WILLIE L BOOZE",
    submittedAddress: "1234 MAIN ST, SAN ANTONIO, TX 78201"
  },
  {
    label: "EFX Only — JOHN V BIALOGLOW",
    bureaus: ["equifax"],
    submittedName: "JOHN V BIALOGLOW",
    submittedAddress: "1234 MAIN ST, WAHIAWA, HI 96786"
  },
  {
    label: "ALL 3 Combined — BARBARA M DOTY",
    bureaus: ["transunion", "experian", "equifax"],
    submittedName: "BARBARA M DOTY",
    submittedAddress: "1234 MAIN ST, DENTON, TX 76201"
  }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hr(title) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(70));
}

function loadResponse(bureau) {
  const filePath = RESPONSE_FILES[bureau];
  if (!fs.existsSync(filePath)) {
    throw new Error(`Saved response not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function printResult(label, result) {
  console.log(`\n  --- ${label} ---`);

  if (!result.ok) {
    console.log(`  result.ok        : false`);
    console.log(`  error            : ${result.error || "unknown"}`);
    console.log(`  message          : ${result.message || "(none)"}`);
    return;
  }

  console.log(`  result.ok        : ${result.ok}`);
  console.log(`  outcome          : ${result.outcome}`);
  console.log(`  decision_label   : ${result.decision_label}`);
  console.log(`  confidence       : ${result.confidence}`);
  console.log(`  reason_codes     : ${(result.reason_codes || []).join(", ") || "(none)"}`);

  if (result.preapprovals) {
    const pa = result.preapprovals;
    console.log(`  preapprovals:`);
    console.log(`    totalPersonal  : $${(pa.totalPersonal || 0).toLocaleString()}`);
    console.log(`    totalBusiness  : $${(pa.totalBusiness || 0).toLocaleString()}`);
    console.log(`    totalCombined  : $${(pa.totalCombined || 0).toLocaleString()}`);
  } else {
    console.log(`  preapprovals     : (none)`);
  }

  const findingsCount = Array.isArray(result.optimization_findings)
    ? result.optimization_findings.length
    : 0;
  console.log(`  optimization_findings : ${findingsCount} categories`);

  const lettersCount = result.documents?.letters?.length || 0;
  console.log(`  letters in documents  : ${lettersCount}`);

  const summary = result.consumer_summary || "";
  console.log(
    `  consumer_summary : ${summary.substring(0, 150)}${summary.length > 150 ? "..." : ""}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("\n  CRS Per-Bureau Test — Saved Sandbox Responses");
  console.log(`  Sandbox dir: ${SANDBOX_DIR}`);
  console.log(`  Time: ${new Date().toISOString()}`);

  // Load all responses upfront
  hr("Loading Saved Responses");
  const responses = {};
  for (const [bureau, filePath] of Object.entries(RESPONSE_FILES)) {
    try {
      responses[bureau] = loadResponse(bureau);
      console.log(`  [OK] ${bureau.toUpperCase()} loaded from ${path.basename(filePath)}`);
    } catch (err) {
      console.error(`  [FAIL] ${bureau.toUpperCase()}: ${err.message}`);
      process.exit(1);
    }
  }

  // Run each test configuration
  let passed = 0;
  let failed = 0;

  for (const run of RUNS) {
    hr(run.label);

    const rawResponses = run.bureaus.map(b => responses[b]);

    try {
      const result = runCRSEngine({
        rawResponses,
        businessReport: null,
        submittedName: run.submittedName,
        submittedAddress: run.submittedAddress,
        formData: {
          name: run.submittedName,
          email: "test@fundhub.ai",
          phone: "5551234567",
          ref: `per-bureau-test-${run.bureaus.join("-")}`
        }
      });

      printResult(run.label, result);
      passed++;
    } catch (err) {
      console.error(`\n  [ERROR] ${run.label}`);
      console.error(`  ${err.message}`);
      console.error(err.stack);
      failed++;
    }
  }

  // Summary
  hr("Summary");
  console.log(`  Runs passed : ${passed}`);
  console.log(`  Runs failed : ${failed}`);
  console.log(`  Status      : ${failed === 0 ? "ALL PASSED" : "SOME FAILURES"}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("\nFATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
