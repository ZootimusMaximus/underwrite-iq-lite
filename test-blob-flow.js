#!/usr/bin/env node
/**
 * Test script for Blob + Polling flow
 * Usage: node test-blob-flow.js <pdf-path> [name] [base-url]
 */

const fs = require("fs");
const path = require("path");

const pdfPath = process.argv[2] || "./testdata.pdf";
const name = process.argv[3] || "Test User";
const baseUrl = process.argv[4] || "https://underwrite-iq-lite-staging.vercel.app";

async function main() {
  console.log("\n=== Blob + Polling Flow Test ===\n");
  console.log(`PDF: ${pdfPath}`);
  console.log(`Name: ${name}`);
  console.log(`URL: ${baseUrl}\n`);

  const startTime = Date.now();

  // Check file exists
  if (!fs.existsSync(pdfPath)) {
    console.error(`ERROR: File not found: ${pdfPath}`);
    process.exit(1);
  }

  const fileSize = fs.statSync(pdfPath).size;
  console.log(`File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB\n`);

  // Step 1: Get job ID
  console.log("[1/4] Creating job...");
  const tokenRes = await fetch(`${baseUrl}/api/lite/upload-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      email: "test@example.com",
      phone: "5551234567",
      forceReprocess: true
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.ok) {
    console.error("ERROR:", tokenData.error);
    process.exit(1);
  }

  const { jobId } = tokenData;
  console.log(`       Job ID: ${jobId}`);

  // Step 2: Upload to Blob
  console.log("\n[2/5] Uploading to Blob...");

  // Dynamic import for ES module
  const { upload } = await import("@vercel/blob/client");

  const fileBuffer = fs.readFileSync(pdfPath);
  const fileName = path.basename(pdfPath);

  // Create a Blob from the buffer
  const blob = new Blob([fileBuffer], { type: "application/pdf" });

  try {
    const uploadResult = await upload(fileName, blob, {
      access: "public",
      handleUploadUrl: `${baseUrl}/api/lite/blob-upload`,
      clientPayload: JSON.stringify({ jobId })
    });
    console.log(`       Uploaded: ${uploadResult.url}`);
  } catch (err) {
    console.error("Upload error:", err.message);
    process.exit(1);
  }

  // Step 3: Start processing
  console.log("\n[3/5] Starting processing...");
  const processRes = await fetch(`${baseUrl}/api/lite/start-processing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId })
  });

  const processData = await processRes.json();
  console.log(`       Status: ${processData.status}`);

  if (processData.status === "error") {
    console.error(`\nERROR: ${processData.error?.message || "Processing failed"}`);
    process.exit(1);
  }

  if (processData.status === "complete") {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n[5/5] COMPLETE in ${elapsed}s\n`);

    // Get full result from job-status
    const finalRes = await fetch(`${baseUrl}/api/lite/job-status?jobId=${jobId}`);
    const finalData = await finalRes.json();

    displayResult(finalData);
    return;
  }

  // Step 4: Poll for result (if still processing)
  console.log("\n[4/5] Polling for result...");

  for (let i = 0; i < 90; i++) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const statusRes = await fetch(`${baseUrl}/api/lite/job-status?jobId=${jobId}`);
    const statusData = await statusRes.json();

    if (statusData.status === "complete") {
      console.log(`\n[5/5] COMPLETE in ${elapsed}s\n`);
      displayResult(statusData);
      return;
    }

    if (statusData.status === "error") {
      console.error(`\nERROR: ${statusData.error?.message || "Unknown error"}`);
      console.error(`Code: ${statusData.error?.code || "UNKNOWN"}`);
      process.exit(1);
    }

    // Show progress
    process.stdout.write(`\r       ${statusData.progress || "Processing..."} (${elapsed}s)`);

    await new Promise(r => setTimeout(r, 2000));
  }

  console.error("\nERROR: Polling timeout after 3 minutes");
  process.exit(1);
}

function displayResult(statusData) {
  console.log("=== RESULT ===\n");

  const result = statusData.result || {};
  const uw = result.underwrite || {};
  const m = uw.metrics || {};

  console.log(`Path: ${result.redirect?.path || "unknown"}`);
  console.log(`Score: ${m.score || "N/A"}`);
  console.log(`Utilization: ${m.utilization_pct || "N/A"}%`);
  console.log(`Negatives: ${m.negative_accounts || 0}`);
  console.log(`Fundable: ${uw.fundable ? "YES" : "NO"}`);
  console.log(`\nRedirect URL: ${result.redirect?.url || "N/A"}`);

  console.log("\n=== FULL RESPONSE ===\n");
  console.log(JSON.stringify(statusData, null, 2));
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
