"use strict";

/**
 * crs-lexisnexis-test.js — Test LexisNexis Top Business Endpoints
 *
 * Authenticates with Stitch Credit, searches for a test business via
 * LexisNexis, pulls the comprehensive report (JSON + PDF), and saves
 * raw responses to disk.
 *
 * Usage: node scripts/crs-lexisnexis-test.js
 *
 * Output: /Users/darwin1/Documents/projects/fundhub/mar 2026/
 *   - lexisnexis-search-response.json
 *   - lexisnexis-report-response.json
 *   - lexisnexis-report.pdf
 */

// ---------------------------------------------------------------------------
// Load .env.local
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

const {
  authenticate,
  searchTopBusiness,
  pullTopBusinessReport,
  pullTopBusinessReportPdf
} = require("../api/lite/crs/stitch-credit-client");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OUTPUT_DIR = "/Users/darwin1/Documents/projects/fundhub/mar 2026";

// Sandbox test business (from Postman collection)
const TEST_BUSINESS = {
  companyName: "1BASELAM, INC",
  streetAddress: "3646 RIVER HEIGHTS XING",
  city: "MARIETTA",
  state: "GA",
  zipCode: "30067",
  seleId: 1928983913
};

// Known IDs for direct report pull (bypass search if needed)
const KNOWN_IDS = {
  seleID: 1928983913,
  orgID: 1928983913,
  ultID: 1928983913
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hr(title) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  hr("LexisNexis Top Business — Sandbox Test");
  console.log(
    `  API Base : ${process.env.STITCH_CREDIT_API_BASE || "https://api-sandbox.stitchcredit.com"}`
  );
  console.log(
    `  Email    : ${process.env.STITCH_CREDIT_EMAIL || process.env.STITCH_CREDIT_USERNAME || "(not set)"}`
  );
  console.log(`  Output   : ${OUTPUT_DIR}`);
  console.log(`  Time     : ${new Date().toISOString()}`);

  // --- Step 1: Authenticate ---
  hr("Step 1 — Authenticate");
  let token;
  try {
    token = await authenticate();
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

  // --- Step 2: Search for business ---
  hr("Step 2 — Search Top Business");
  console.log(
    `  Searching for: "${TEST_BUSINESS.companyName}"${TEST_BUSINESS.state ? ` in ${TEST_BUSINESS.state}` : ""}`
  );

  let searchResult;
  const searchStart = Date.now();
  try {
    searchResult = await searchTopBusiness(TEST_BUSINESS);
    const elapsed = Date.now() - searchStart;
    console.log(`  Search completed (${elapsed}ms)`);

    const searchPath = path.join(OUTPUT_DIR, "lexisnexis-search-response.json");
    fs.writeFileSync(searchPath, JSON.stringify(searchResult, null, 2), "utf8");
    console.log(`  Saved → ${searchPath}`);

    // Show result summary
    if (Array.isArray(searchResult)) {
      console.log(`  Results: ${searchResult.length} businesses found`);
      for (const biz of searchResult.slice(0, 5)) {
        console.log(
          `    - ${biz.companyName || biz.businessName || JSON.stringify(biz).substring(0, 80)}`
        );
      }
    } else if (searchResult?.results) {
      console.log(`  Results: ${searchResult.results.length} businesses found`);
      for (const biz of searchResult.results.slice(0, 5)) {
        console.log(
          `    - ${biz.companyName || biz.businessName || JSON.stringify(biz).substring(0, 80)}`
        );
      }
    } else {
      console.log(`  Response shape: ${JSON.stringify(Object.keys(searchResult || {}))}`);
      console.log(`  Preview: ${JSON.stringify(searchResult).substring(0, 200)}`);
    }
  } catch (err) {
    const elapsed = Date.now() - searchStart;
    console.error(`\n  Search FAILED (${elapsed}ms): ${err.message}`);
    console.log("\n  Saving error details and exiting...");

    const errPath = path.join(OUTPUT_DIR, "lexisnexis-search-error.json");
    fs.writeFileSync(
      errPath,
      JSON.stringify({ error: err.message, stack: err.stack, elapsed }, null, 2),
      "utf8"
    );
    console.log(`  Saved → ${errPath}`);
    process.exit(1);
  }

  // --- Step 3: Extract IDs for report pull ---
  hr("Step 3 — Extract Business IDs");

  let ids;
  // Try to extract seleID/orgID/ultID from search response
  // Shape might vary — handle common patterns
  if (searchResult?.seleID || searchResult?.seleId) {
    ids = {
      seleID: searchResult.seleID || searchResult.seleId,
      orgID: searchResult.orgID || searchResult.orgId || 0,
      ultID: searchResult.ultID || searchResult.ultId || 0
    };
  } else if (Array.isArray(searchResult) && searchResult.length > 0) {
    const first = searchResult[0];
    ids = {
      seleID: first.seleID || first.seleId,
      orgID: first.orgID || first.orgId || 0,
      ultID: first.ultID || first.ultId || 0
    };
  } else if (searchResult?.results?.length > 0) {
    const first = searchResult.results[0];
    ids = {
      seleID: first.seleID || first.seleId,
      orgID: first.orgID || first.orgId || 0,
      ultID: first.ultID || first.ultId || 0
    };
  }

  if (!ids?.seleID) {
    console.log("  Could not extract seleID from search response — using known sandbox IDs.");
    ids = KNOWN_IDS;
  }

  console.log(`  seleID: ${ids.seleID}`);
  console.log(`  orgID:  ${ids.orgID}`);
  console.log(`  ultID:  ${ids.ultID}`);

  // --- Step 4: Pull full JSON report ---
  hr("Step 4 — Pull Top Business Report (JSON)");

  const reportStart = Date.now();
  try {
    const report = await pullTopBusinessReport(ids);
    const elapsed = Date.now() - reportStart;
    console.log(`  Report pulled (${elapsed}ms)`);

    const reportPath = path.join(OUTPUT_DIR, "lexisnexis-report-response.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`  Saved → ${reportPath}`);

    // Show summary
    const keys = Object.keys(report || {});
    console.log(`  Top-level keys: ${keys.join(", ")}`);
  } catch (err) {
    const elapsed = Date.now() - reportStart;
    console.error(`  Report pull FAILED (${elapsed}ms): ${err.message}`);
  }

  // --- Step 5: Pull PDF report ---
  hr("Step 5 — Pull Top Business Report (PDF)");

  const pdfStart = Date.now();
  try {
    const pdfBuffer = await pullTopBusinessReportPdf(ids);
    const elapsed = Date.now() - pdfStart;
    console.log(`  PDF pulled (${elapsed}ms)`);

    const pdfPath = path.join(OUTPUT_DIR, "lexisnexis-report.pdf");
    if (Buffer.isBuffer(pdfBuffer)) {
      fs.writeFileSync(pdfPath, pdfBuffer);
    } else if (pdfBuffer instanceof ArrayBuffer || ArrayBuffer.isView(pdfBuffer)) {
      fs.writeFileSync(pdfPath, Buffer.from(pdfBuffer));
    } else {
      // Might be a response body — try to write as-is
      fs.writeFileSync(pdfPath, pdfBuffer);
    }
    console.log(`  Saved → ${pdfPath}`);

    const stats = fs.statSync(pdfPath);
    console.log(`  Size: ${(stats.size / 1024).toFixed(1)} KB`);
  } catch (err) {
    const elapsed = Date.now() - pdfStart;
    console.error(`  PDF pull FAILED (${elapsed}ms): ${err.message}`);
  }

  // --- Summary ---
  hr("Done");
  console.log(`  All outputs saved to: ${OUTPUT_DIR}`);
  console.log(`  Files:`);
  console.log(`    - lexisnexis-search-response.json`);
  console.log(`    - lexisnexis-report-response.json`);
  console.log(`    - lexisnexis-report.pdf`);
  console.log("");
}

main().catch(err => {
  console.error("\nFATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
