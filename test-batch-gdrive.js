#!/usr/bin/env node
/**
 * Batch test all PDFs in gdrive folder
 * Extracts names from filenames and tests blob flow
 */

const fs = require("fs");
const path = require("path");

const baseUrl = process.argv[2] || "https://underwrite-iq-lite-staging.vercel.app";
const gdriveDir = "./gdrive";

// Map filename to expected name on credit report
function extractName(filename) {
  const base = path.basename(filename, ".pdf");

  // Handle specific patterns
  const nameMap = {
    "brian-will": "Brian Will",
    "shawna-titchener": "Shawna Titchener",
    "andrew-lauder": "Andrew Lauder",
    "vincent-cao": "Vincent Cao",
    "andre-bland": "Andre Bland",
    "andrea-hwang": "Andrea Hwang",
    "ashley-searcey": "Ashley Searcey",
    "david-lloyd": "David Lloyd",
    "chris-hood": "Chris Hood",
    "isaac-sandlin": "Isaac Sandlin",
    "maxwell-okoh": "Maxwell Okoh",
    "ayman-elbadri": "Ayman Elbadri",
    "travis-witherspoon": "Travis Witherspoon",
    "tue-luong": "Tue Luong",
    "Brice Pierce Equifax": "Brice Pierce",
    "Brice Pierce Transunion (1)": "Brice Pierce",
    "Brice Pierce Transunion": "Brice Pierce",
    "Clayton Brown Equifax": "Clayton Brown",
    "Elisheva Bronsteyn Transunion": "Elisheva Bronsteyn",
    "Evelyn Gonzales Equifax": "Evelyn Gonzales",
    "evelyn Gonzales Transunion": "Evelyn Gonzales",
    "Shawna Titchener Equifax": "Shawna Titchener",
    "Shawna Titchener Transunion": "Shawna Titchener",
    "HOWARD M. SIMON": "Howard M Simon",
    "Nicholas Ortiz - Experian": "Nicholas Ortiz",
    "Ryan W. Morgan Experian": "Ryan W Morgan",
    JeremyAdamsExperian: "Jeremy Adams",
    RashawnTransunion: "Rashawn",
    SHAWNExperian: "Shawn",
    TransunionChrisHood: "Chris Hood",
    "SCW CREDIT REPORT EXPERIAN": "SCW",
    "Experian Single Credit Report": "Unknown",
    "FICO Score 3B Report - Printable Version": "Unknown",
    "PrivacyGuard - Credit Gateway-report": "Unknown",
    "Trans Union PDF": "Unknown",
    "transunion cr": "Unknown"
  };

  return nameMap[base] || base.replace(/-/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

async function testPdf(pdfPath, name) {
  const startTime = Date.now();
  const fileSize = fs.statSync(pdfPath).size;

  try {
    // Step 1: Create job
    const tokenRes = await fetch(`${baseUrl}/api/lite/upload-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        email: "batch-test@example.com",
        phone: "5551234567",
        forceReprocess: true
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.ok) {
      return { status: "FAILED", error: tokenData.error, time: 0, score: null, path: null };
    }

    const { jobId } = tokenData;

    // Step 2: Upload to Blob
    const { upload } = await import("@vercel/blob/client");
    const fileBuffer = fs.readFileSync(pdfPath);
    const fileName = path.basename(pdfPath);
    const blob = new Blob([fileBuffer], { type: "application/pdf" });

    await upload(fileName, blob, {
      access: "public",
      handleUploadUrl: `${baseUrl}/api/lite/blob-upload`,
      clientPayload: JSON.stringify({ jobId })
    });

    // Step 3: Start processing
    const processRes = await fetch(`${baseUrl}/api/lite/start-processing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId })
    });

    const processData = await processRes.json();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (processData.status === "complete") {
      // Get full result
      const statusRes = await fetch(`${baseUrl}/api/lite/job-status?jobId=${jobId}`);
      const statusData = await statusRes.json();

      if (statusData.status === "error") {
        return {
          status: "FAILED",
          error: statusData.error?.code || statusData.error?.message,
          time: elapsed,
          score: null,
          path: null,
          size: (fileSize / 1024 / 1024).toFixed(2)
        };
      }

      const result = statusData.result || {};
      const uw = result.underwrite || {};

      return {
        status: "SUCCESS",
        error: null,
        time: elapsed,
        score: uw.metrics?.score || "N/A",
        path: result.redirect?.path || "unknown",
        size: (fileSize / 1024 / 1024).toFixed(2)
      };
    }

    if (processData.status === "error") {
      return {
        status: "FAILED",
        error: processData.error?.code || processData.error?.message,
        time: elapsed,
        score: null,
        path: null,
        size: (fileSize / 1024 / 1024).toFixed(2)
      };
    }

    // Poll if still processing
    for (let i = 0; i < 60; i++) {
      const statusRes = await fetch(`${baseUrl}/api/lite/job-status?jobId=${jobId}`);
      const statusData = await statusRes.json();
      const pollElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (statusData.status === "complete") {
        const result = statusData.result || {};
        const uw = result.underwrite || {};

        return {
          status: "SUCCESS",
          error: null,
          time: pollElapsed,
          score: uw.metrics?.score || "N/A",
          path: result.redirect?.path || "unknown",
          size: (fileSize / 1024 / 1024).toFixed(2)
        };
      }

      if (statusData.status === "error") {
        return {
          status: "FAILED",
          error: statusData.error?.code || statusData.error?.message,
          time: pollElapsed,
          score: null,
          path: null,
          size: (fileSize / 1024 / 1024).toFixed(2)
        };
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    return {
      status: "TIMEOUT",
      error: "Polling timeout",
      time: "120+",
      score: null,
      path: null,
      size: (fileSize / 1024 / 1024).toFixed(2)
    };
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return {
      status: "ERROR",
      error: err.message,
      time: elapsed,
      score: null,
      path: null,
      size: (fileSize / 1024 / 1024).toFixed(2)
    };
  }
}

async function main() {
  console.log("\n=== Batch PDF Test ===\n");
  console.log(`URL: ${baseUrl}\n`);

  // Get all PDFs
  const files = fs
    .readdirSync(gdriveDir)
    .filter(f => f.endsWith(".pdf"))
    .map(f => path.join(gdriveDir, f));

  console.log(`Found ${files.length} PDFs to test\n`);

  const results = [];

  for (let i = 0; i < files.length; i++) {
    const pdfPath = files[i];
    const filename = path.basename(pdfPath);
    const name = extractName(filename);

    console.log(`[${i + 1}/${files.length}] Testing: ${filename}`);
    console.log(`         Name: ${name}`);

    const result = await testPdf(pdfPath, name);
    results.push({ filename, name, ...result });

    const statusIcon = result.status === "SUCCESS" ? "✓" : "✗";
    console.log(
      `         ${statusIcon} ${result.status} (${result.time}s) ${result.error || ""}\n`
    );

    // Small delay between tests
    if (i < files.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Print summary table
  console.log("\n" + "=".repeat(120));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(120));
  console.log("");
  console.log(
    "Filename".padEnd(45) +
      "Name".padEnd(25) +
      "Size".padEnd(8) +
      "Status".padEnd(10) +
      "Time".padEnd(8) +
      "Score".padEnd(8) +
      "Path".padEnd(10) +
      "Error"
  );
  console.log("-".repeat(120));

  for (const r of results) {
    console.log(
      r.filename.substring(0, 44).padEnd(45) +
        r.name.substring(0, 24).padEnd(25) +
        `${r.size}MB`.padEnd(8) +
        r.status.padEnd(10) +
        `${r.time}s`.padEnd(8) +
        (r.score || "-").toString().padEnd(8) +
        (r.path || "-").padEnd(10) +
        (r.error || "").substring(0, 30)
    );
  }

  console.log("-".repeat(120));

  const successCount = results.filter(r => r.status === "SUCCESS").length;
  const failedCount = results.filter(r => r.status === "FAILED").length;
  const errorCount = results.filter(r => r.status === "ERROR").length;

  console.log(
    `\nTotal: ${results.length} | Success: ${successCount} | Failed: ${failedCount} | Error: ${errorCount}`
  );

  // Save results to JSON
  fs.writeFileSync("batch-test-results.json", JSON.stringify(results, null, 2));
  console.log("\nResults saved to batch-test-results.json");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
