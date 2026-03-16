require("dotenv").config();
const fs = require("fs");
const { put } = require("@vercel/blob");

const STAGING_URL = "https://underwrite-iq-lite-staging.vercel.app";

async function test() {
  const pdfPath = "./gdrive/derrick-downs.pdf";
  const buffer = fs.readFileSync(pdfPath);
  console.log("Testing:", pdfPath, "-", (buffer.length / 1024 / 1024).toFixed(2), "MB");

  // Step 1: Get upload token
  console.log("\n1. Getting upload token...");
  const tokenRes = await fetch(STAGING_URL + "/api/lite/upload-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: "derrick-downs.pdf",
      contentType: "application/pdf",
      email: "test@example.com",
      phone: "5551234567",
      name: "Derrick Downs"
    })
  });
  const tokenData = await tokenRes.json();
  console.log("   JobId:", tokenData.jobId);

  if (!tokenData.ok) {
    console.error("Token failed:", tokenData);
    return;
  }

  // Step 2: Upload to blob
  console.log("\n2. Uploading to Vercel Blob...");
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    console.error("   ERROR: BLOB_READ_WRITE_TOKEN not set");
    return;
  }
  const blobRes = await put("uploads/" + tokenData.jobId + "/derrick-downs.pdf", buffer, {
    access: "public",
    token: blobToken
  });
  console.log("   Blob URL:", blobRes.url.slice(0, 80) + "...");

  // Step 3: Start processing
  console.log("\n3. Starting processing...");
  const startRes = await fetch(STAGING_URL + "/api/lite/start-processing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId: tokenData.jobId,
      blobUrl: blobRes.url,
      forceReprocess: true
    })
  });
  const startData = await startRes.json();
  console.log("   Status:", startData.status || startData.error);

  // Step 4: Poll for result
  console.log("\n4. Polling for result...");
  const startTime = Date.now();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const statusRes = await fetch(STAGING_URL + "/api/lite/job-status?jobId=" + tokenData.jobId);
    const status = await statusRes.json();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("   [" + elapsed + "s] Status:", status.status, "-", status.progress || "");

    if (status.status === "complete" || status.status === "error") {
      console.log("\n5. Final Result:");
      if (status.result) {
        console.log("   Mode:", status.result.meta ? status.result.meta.mode : "unknown");
        if (status.result.bureaus) {
          const b = status.result.bureaus;
          if (b.experian && b.experian.score) console.log("   Experian:", b.experian.score);
          if (b.equifax && b.equifax.score) console.log("   Equifax:", b.equifax.score);
          if (b.transunion && b.transunion.score) console.log("   TransUnion:", b.transunion.score);
        }
      }
      if (status.redirect) {
        console.log("   Redirect:", status.redirect.resultType);
      }
      if (status.error) {
        console.log("   Error:", status.error);
      }
      break;
    }
  }

  console.log("\nTotal time:", ((Date.now() - startTime) / 1000).toFixed(1), "s");
}

test().catch(console.error);
