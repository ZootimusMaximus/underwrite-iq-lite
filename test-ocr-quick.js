const fs = require("fs");
const { put } = require("@vercel/blob");

const STAGING_URL = "https://underwrite-iq-lite-staging.vercel.app";

async function test() {
  const pdfPath = "./gdrive/derrick-downs.pdf";
  const buffer = fs.readFileSync(pdfPath);
  console.log("Testing:", pdfPath, "-", (buffer.length / 1024 / 1024).toFixed(2), "MB\n");

  // Step 1: Get upload token
  console.log("1. Getting upload token...");
  const tokenRes = await fetch(STAGING_URL + "/api/lite/upload-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: "derrick-downs.pdf",
      contentType: "application/pdf",
      email: "test" + Date.now() + "@example.com",
      phone: "555" + Date.now().toString().slice(-7),
      name: "Derrick Downs"
    })
  });
  const tokenData = await tokenRes.json();
  console.log("   JobId:", tokenData.jobId);

  // Step 2: Upload to blob with random suffix
  console.log("\n2. Uploading to Vercel Blob...");
  const blobRes = await put("uploads/" + tokenData.jobId + "/derrick-downs.pdf", buffer, {
    access: "public",
    token: process.env.BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: true
  });
  console.log("   Done");

  // Step 3: Start processing
  console.log("\n3. Starting processing...");
  const startTime = Date.now();
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
  console.log("   Response:", startData.status || startData.error);

  // Step 4: Poll
  console.log("\n4. Polling...");
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(STAGING_URL + "/api/lite/job-status?jobId=" + tokenData.jobId);
    const s = await res.json();
    const t = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log("   [" + t + "s] " + s.status + " - " + (s.progress || ""));

    if (s.status === "complete" || s.status === "error") {
      console.log("\n5. RESULT:");
      console.log("   Mode:", s.result && s.result.meta ? s.result.meta.mode : "unknown");
      if (s.result && s.result.bureaus) {
        const b = s.result.bureaus;
        if (b.experian && b.experian.score) console.log("   Experian:", b.experian.score);
        if (b.equifax && b.equifax.score) console.log("   Equifax:", b.equifax.score);
        if (b.transunion && b.transunion.score) console.log("   TransUnion:", b.transunion.score);
      }
      if (s.error) console.log("   Error:", s.error);
      console.log("\n=== TOTAL: " + t + "s ===");
      break;
    }
  }
}
test().catch(e => console.error("Error:", e.message));
