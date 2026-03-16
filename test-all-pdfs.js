#!/usr/bin/env node
/**
 * Batch test all PDFs in gdrive folder
 * Outputs a markdown table with results
 */
const fs = require("fs");
const path = require("path");

const STAGING_URL = "https://underwrite-iq-lite-staging.vercel.app";
const GDRIVE_DIR = "./gdrive";
const TIMEOUT_SEC = 120; // 2 min timeout per PDF

const results = [];

async function testPdf(pdfPath) {
  const fileName = path.basename(pdfPath);
  const fileSize = fs.statSync(pdfPath).size;
  const sizeMB = (fileSize / 1024 / 1024).toFixed(2);

  const startTime = Date.now();

  try {
    // Step 1: Get job ID
    const tokenRes = await fetch(STAGING_URL + "/api/lite/upload-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: fileName.replace(".pdf", "").replace(/-/g, " "),
        email: "test" + Date.now() + "@example.com",
        phone: "555" + Date.now().toString().slice(-7),
        forceReprocess: true
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.ok) throw new Error(tokenData.error || "Token failed");

    // Step 2: Upload
    const { upload } = await import("@vercel/blob/client");
    const buffer = fs.readFileSync(pdfPath);
    const blob = new Blob([buffer], { type: "application/pdf" });

    await upload(fileName, blob, {
      access: "public",
      handleUploadUrl: STAGING_URL + "/api/lite/blob-upload",
      clientPayload: JSON.stringify({ jobId: tokenData.jobId })
    });

    // Step 3: Start processing
    await fetch(STAGING_URL + "/api/lite/start-processing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: tokenData.jobId })
    });

    // Step 4: Poll with timeout
    const maxPolls = TIMEOUT_SEC / 2;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const res = await fetch(STAGING_URL + "/api/lite/job-status?jobId=" + tokenData.jobId);
      const s = await res.json();

      if (s.status === "complete") {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const uw = s.result?.underwrite || {};
        return {
          file: fileName,
          size: sizeMB,
          status: "✅ Pass",
          time: elapsed + "s",
          score: uw.metrics?.score || "-",
          path: s.result?.redirect?.path || "-",
          reason: ""
        };
      }

      if (s.status === "error") {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        return {
          file: fileName,
          size: sizeMB,
          status: "❌ Fail",
          time: elapsed + "s",
          score: "-",
          path: "-",
          reason: s.error?.message || s.error || "Unknown error"
        };
      }
    }

    // Timeout
    return {
      file: fileName,
      size: sizeMB,
      status: "⏱️ Timeout",
      time: TIMEOUT_SEC + "s+",
      score: "-",
      path: "-",
      reason: "Exceeded " + TIMEOUT_SEC + "s timeout"
    };
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return {
      file: fileName,
      size: sizeMB,
      status: "❌ Fail",
      time: elapsed + "s",
      score: "-",
      path: "-",
      reason: err.message
    };
  }
}

async function main() {
  const files = fs
    .readdirSync(GDRIVE_DIR)
    .filter(f => f.endsWith(".pdf"))
    .sort();

  console.log(`\nTesting ${files.length} PDFs from ${GDRIVE_DIR}\n`);
  console.log("=".repeat(60));

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const pdfPath = path.join(GDRIVE_DIR, file);

    process.stdout.write(`[${i + 1}/${files.length}] ${file.padEnd(35)} `);

    const result = await testPdf(pdfPath);
    results.push(result);

    console.log(`${result.status} ${result.time} ${result.score ? "Score:" + result.score : ""}`);
  }

  // Print summary table
  console.log("\n" + "=".repeat(80));
  console.log("\n## Results Summary\n");
  console.log("| File | Size | Status | Time | Score | Path | Reason |");
  console.log("|------|------|--------|------|-------|------|--------|");

  for (const r of results) {
    console.log(
      `| ${r.file} | ${r.size} MB | ${r.status} | ${r.time} | ${r.score} | ${r.path} | ${r.reason} |`
    );
  }

  // Stats
  const passed = results.filter(r => r.status.includes("Pass")).length;
  const failed = results.filter(r => r.status.includes("Fail")).length;
  const timeout = results.filter(r => r.status.includes("Timeout")).length;

  console.log("\n## Summary");
  console.log(`- ✅ Passed: ${passed}`);
  console.log(`- ❌ Failed: ${failed}`);
  console.log(`- ⏱️ Timeout: ${timeout}`);
  console.log(`- Total: ${results.length}`);

  // Save to file
  const output = JSON.stringify(results, null, 2);
  fs.writeFileSync("test-all-results.json", output);
  console.log("\nResults saved to test-all-results.json");
}

main().catch(console.error);
