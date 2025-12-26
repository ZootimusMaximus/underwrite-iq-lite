#!/usr/bin/env node
/**
 * Test parallel uploads - simulates multiple concurrent users
 */

const fs = require("fs");
const path = require("path");

const baseUrl = process.argv[2] || "https://underwrite-iq-lite-staging.vercel.app";

// Test files with known names - 10 different PDFs
const testCases = [
  { file: "./gdrive/Brice Pierce Equifax.pdf", name: "Brice Pierce" },
  { file: "./gdrive/Clayton Brown Equifax.pdf", name: "Clayton Brown" },
  { file: "./gdrive/Elisheva Bronsteyn Transunion.pdf", name: "Elisheva Bronsteyn" },
  { file: "./gdrive/Evelyn Gonzales Equifax.pdf", name: "Evelyn Gonzales" },
  { file: "./gdrive/chris-hood.pdf", name: "Chris Hood" },
  { file: "./gdrive/david-lloyd.pdf", name: "David Lloyd" },
  { file: "./gdrive/andrea-hwang.pdf", name: "Andrea Hwang" },
  { file: "./gdrive/vincent-cao.pdf", name: "Vincent Cao" },
  { file: "./gdrive/ashley-searcey.pdf", name: "Ashley Searcey" },
  { file: "./gdrive/isaac-sandlin.pdf", name: "Isaac Sandlin" }
];

async function testUser(userId, pdfPath, name) {
  const startTime = Date.now();
  const log = msg => console.log(`[User ${userId}] ${msg}`);

  try {
    log(`Starting: ${path.basename(pdfPath)} (${name})`);

    // Step 1: Create job
    const tokenRes = await fetch(`${baseUrl}/api/lite/upload-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        email: `user${userId}@test.com`,
        phone: "555000000" + userId,
        forceReprocess: true
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.ok) {
      log(`❌ Failed to create job: ${tokenData.error}`);
      return { userId, status: "FAILED", error: tokenData.error, time: 0 };
    }

    const { jobId } = tokenData;
    log(`Job created: ${jobId}`);

    // Step 2: Upload to Blob
    const { upload } = await import("@vercel/blob/client");
    const fileBuffer = fs.readFileSync(pdfPath);
    const fileName = `user${userId}-${path.basename(pdfPath)}`;
    const blob = new Blob([fileBuffer], { type: "application/pdf" });

    log(`Uploading...`);
    await upload(fileName, blob, {
      access: "public",
      handleUploadUrl: `${baseUrl}/api/lite/blob-upload`,
      clientPayload: JSON.stringify({ jobId })
    });
    log(`Upload complete`);

    // Step 3: Start processing
    log(`Processing...`);
    const processRes = await fetch(`${baseUrl}/api/lite/start-processing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId })
    });

    const processData = await processRes.json();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (processData.status === "complete") {
      const statusRes = await fetch(`${baseUrl}/api/lite/job-status?jobId=${jobId}`);
      const statusData = await statusRes.json();

      if (statusData.status === "error") {
        log(`❌ FAILED (${elapsed}s): ${statusData.error?.code}`);
        return { userId, name, status: "FAILED", error: statusData.error?.code, time: elapsed };
      }

      const score = statusData.result?.underwrite?.metrics?.score || "N/A";
      const resultPath = statusData.result?.redirect?.path || "unknown";
      log(`✅ SUCCESS (${elapsed}s) - Score: ${score}, Path: ${resultPath}`);
      return { userId, name, status: "SUCCESS", score, path: resultPath, time: elapsed };
    }

    if (processData.status === "error") {
      log(`❌ FAILED (${elapsed}s): ${processData.error?.code}`);
      return { userId, name, status: "FAILED", error: processData.error?.code, time: elapsed };
    }

    // Poll if needed
    for (let i = 0; i < 60; i++) {
      const statusRes = await fetch(`${baseUrl}/api/lite/job-status?jobId=${jobId}`);
      const statusData = await statusRes.json();
      const pollElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (statusData.status === "complete") {
        const score = statusData.result?.underwrite?.metrics?.score || "N/A";
        const resultPath = statusData.result?.redirect?.path || "unknown";
        log(`✅ SUCCESS (${pollElapsed}s) - Score: ${score}, Path: ${resultPath}`);
        return { userId, name, status: "SUCCESS", score, path: resultPath, time: pollElapsed };
      }

      if (statusData.status === "error") {
        log(`❌ FAILED (${pollElapsed}s): ${statusData.error?.code}`);
        return { userId, name, status: "FAILED", error: statusData.error?.code, time: pollElapsed };
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    log(`❌ TIMEOUT`);
    return { userId, name, status: "TIMEOUT", time: "120+" };
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`❌ ERROR (${elapsed}s): ${err.message}`);
    return { userId, name, status: "ERROR", error: err.message, time: elapsed };
  }
}

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log(`PARALLEL UPLOAD TEST - ${testCases.length} CONCURRENT USERS`);
  console.log("=".repeat(70));
  console.log(`\nURL: ${baseUrl}\n`);

  const startTime = Date.now();

  // Run all users in parallel
  console.log(`Starting ${testCases.length} parallel uploads...\n`);

  const results = await Promise.all(testCases.map((tc, i) => testUser(i + 1, tc.file, tc.name)));

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));
  console.log("");
  console.log(
    "User".padEnd(8) +
      "Name".padEnd(22) +
      "Status".padEnd(10) +
      "Time".padEnd(10) +
      "Score".padEnd(8) +
      "Path/Error"
  );
  console.log("-".repeat(70));

  for (const r of results) {
    console.log(
      `User ${r.userId}`.padEnd(8) +
        (r.name || "").substring(0, 21).padEnd(22) +
        r.status.padEnd(10) +
        `${r.time}s`.padEnd(10) +
        (r.score || "-").toString().padEnd(8) +
        (r.path || r.error || "-")
    );
  }

  console.log("-".repeat(70));

  const successCount = results.filter(r => r.status === "SUCCESS").length;
  const failedCount = results.filter(r => r.status === "FAILED").length;
  console.log(`\nTotal time: ${totalTime}s (parallel)`);
  console.log(`Success: ${successCount}/${testCases.length} | Failed: ${failedCount}`);

  if (successCount === testCases.length) {
    console.log(`\n✅ API handles ${testCases.length} concurrent users successfully!`);
  } else {
    console.log("\n⚠️  Some requests failed - check logs above");
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
