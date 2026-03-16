"use strict";

/**
 * crs-save-sandbox-responses.js — Pull & Save Raw Sandbox Bureau Responses
 *
 * Authenticates with Stitch Credit, pulls each bureau using its correct
 * sandbox test identity, and saves the raw JSON responses to disk.
 *
 * Usage: node scripts/crs-save-sandbox-responses.js
 *
 * Output: /Users/darwin1/Documents/projects/fundhub/mar 2026/
 *   - tu-sandbox-response.json
 *   - exp-sandbox-response.json
 *   - efx-sandbox-response.json
 */

// ---------------------------------------------------------------------------
// Load .env.local (manual line parsing, same as crs-live-test.js)
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

const { authenticate, pullConsumerBureau } = require("../api/lite/crs/stitch-credit-client");

// ---------------------------------------------------------------------------
// Output directory
// ---------------------------------------------------------------------------

const OUTPUT_DIR = "/Users/darwin1/Documents/projects/fundhub/mar 2026";

// ---------------------------------------------------------------------------
// Sandbox Test Identities (one unique person per bureau)
// ---------------------------------------------------------------------------

const BUREAU_CONFIGS = [
  {
    key: "transunion",
    label: "TransUnion",
    outputFile: "tu-sandbox-response.json",
    applicant: {
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
    }
  },
  {
    key: "experian",
    label: "Experian",
    outputFile: "exp-sandbox-response.json",
    applicant: {
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
    }
  },
  {
    key: "equifax",
    label: "Equifax",
    outputFile: "efx-sandbox-response.json",
    applicant: {
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
  }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hr(title) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function extractSummary(response, _bureau) {
  const score = response.scores?.[0]?.scoreValue ?? response.scores?.[0]?.value ?? "N/A";

  const scoreName = response.scores?.[0]?.scoreName ?? response.scores?.[0]?.modelName ?? "Score";

  const tradelineCount = response.tradelines?.length ?? 0;
  const inquiryCount = response.inquiries?.length ?? 0;

  return { score, scoreName, tradelineCount, inquiryCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  hr("CRS Save Sandbox Responses");
  console.log(
    `  API Base : ${process.env.STITCH_CREDIT_API_BASE || "https://api-sandbox.stitchcredit.com"}`
  );
  console.log(
    `  Email    : ${process.env.STITCH_CREDIT_EMAIL || process.env.STITCH_CREDIT_USERNAME || "(not set)"}`
  );
  console.log(`  Output   : ${OUTPUT_DIR}`);
  console.log(`  Time     : ${new Date().toISOString()}`);

  // Authenticate first so we surface auth errors before pulling bureaus
  console.log("\n  Authenticating...");
  try {
    const token = await authenticate();
    console.log(`  Token obtained (${token.substring(0, 30)}...)`);
  } catch (err) {
    console.error(`\n  FATAL: Authentication failed — ${err.message}`);
    process.exit(1);
  }

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    console.error(`\n  FATAL: Output directory not found: ${OUTPUT_DIR}`);
    process.exit(1);
  }

  hr("Pulling Bureaus");

  const summaries = [];

  for (const config of BUREAU_CONFIGS) {
    const { key, label, outputFile, applicant } = config;
    const outputPath = path.join(OUTPUT_DIR, outputFile);

    process.stdout.write(`  ${label.padEnd(12)} — pulling...`);
    const start = Date.now();

    try {
      const response = await pullConsumerBureau(key, applicant);
      const elapsed = Date.now() - start;

      // Save raw response to disk
      fs.writeFileSync(outputPath, JSON.stringify(response, null, 2), "utf8");

      const { score, scoreName, tradelineCount, inquiryCount } = extractSummary(response, key);

      console.log(` done (${elapsed}ms)`);

      summaries.push({
        label,
        outputFile,
        score,
        scoreName,
        tradelineCount,
        inquiryCount,
        elapsed,
        ok: true
      });
    } catch (err) {
      const elapsed = Date.now() - start;
      console.log(` FAILED (${elapsed}ms)`);
      console.error(`    Error: ${err.message}`);
      summaries.push({ label, outputFile, ok: false, error: err.message, elapsed });
    }
  }

  // ---------------------------------------------------------------------------
  // Summary Table
  // ---------------------------------------------------------------------------

  hr("Summary");

  const colW = { bureau: 12, score: 20, tradelines: 11, inquiries: 10, time: 12, file: 30 };

  const header = [
    "Bureau".padEnd(colW.bureau),
    "Score".padEnd(colW.score),
    "Tradelines".padEnd(colW.tradelines),
    "Inquiries".padEnd(colW.inquiries),
    "Time".padEnd(colW.time),
    "File"
  ].join("  ");

  console.log(`  ${header}`);
  console.log(`  ${"-".repeat(header.length)}`);

  let allOk = true;
  for (const s of summaries) {
    if (!s.ok) {
      allOk = false;
      console.log(`  ${s.label.padEnd(colW.bureau)}  ERROR: ${s.error}`);
      continue;
    }

    const scoreCell = `${s.scoreName}: ${s.score}`.padEnd(colW.score);
    const row = [
      s.label.padEnd(colW.bureau),
      scoreCell,
      String(s.tradelineCount).padEnd(colW.tradelines),
      String(s.inquiryCount).padEnd(colW.inquiries),
      `${s.elapsed}ms`.padEnd(colW.time),
      s.outputFile
    ].join("  ");

    console.log(`  ${row}`);
  }

  console.log("");

  if (allOk) {
    console.log(`  All 3 bureau responses saved to: ${OUTPUT_DIR}\n`);
    process.exit(0);
  } else {
    console.log(`  Some bureaus failed. Check errors above.\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("\nFATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
