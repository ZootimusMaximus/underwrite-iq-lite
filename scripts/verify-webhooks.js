/* global AbortSignal */
"use strict";

/**
 * verify-webhooks.js — Webhook Health Check
 *
 * Verifies all GHL and Airtable webhook endpoints are responding.
 * Sends a no-op probe (event: "health_check") to each URL and reports status.
 *
 * Usage: node scripts/verify-webhooks.js
 */

const GHL_WEBHOOK_BASE =
  "https://services.leadconnectorhq.com/hooks/ORh91GeY4acceSASSnLR/webhook-trigger";

const ENDPOINTS = {
  // GHL workflow triggers
  "U-01 (Analyzer Start)": `${GHL_WEBHOOK_BASE}/03f27697-68e1-411a-81e4-6ecff03fb239`,
  "U-02 (Analyzer Complete)": `${GHL_WEBHOOK_BASE}/330139cd-098d-46f8-9e65-25cd3545a612`,
  "U-03 (CRS Snapshot Sync)": `${GHL_WEBHOOK_BASE}/faa8c0be-31b0-48a6-97a3-d39eff741665`,
  "S-01 (New Lead)": `${GHL_WEBHOOK_BASE}/7143ffce-5cfe-4df5-9f00-5364decf2735`,
  "AT-02 (Attribution)": `${GHL_WEBHOOK_BASE}/f42ef901-e780-4a74-aa39-d8107d1d3542`,
  "AX-05 (Ready to Fund)": `${GHL_WEBHOOK_BASE}/97dadd2b-db30-485e-a14d-d0f85f378e61`,
  "AX-06 (Inquiry Status)": `${GHL_WEBHOOK_BASE}/cd2b5d78-8620-4138-9665-05888dd4fda8`,
  "AX-07/AX-12 (Blocker Task)": `${GHL_WEBHOOK_BASE}/3adbd3b0-1551-418e-b670-dd729165f78e`,
  "HX-04 (Duplicate Blocker)": `${GHL_WEBHOOK_BASE}/227fa525-ad3f-4f1e-ad0f-63882aeb6b93`,
  "HX-05B (Recon Mismatch)": `${GHL_WEBHOOK_BASE}/4f7d3613-1ce0-44f9-b345-ac9fb10097ef`,
  "F-10R (Inbox Verified)": `${GHL_WEBHOOK_BASE}/8e5e64ce-ba3f-44df-bde2-620aab10c58c`,
  "DisputeFox (ZAP DF-*)": `${GHL_WEBHOOK_BASE}/193227ed-46ff-4cab-be7f-0d482e3571e4`,

  // Airtable automation triggers
  "AX01A (Airtable Analyzer)":
    "https://hooks.airtable.com/workflows/v1/genericWebhook/appXsq65yB9VuNup5/wflPBbRZOHYWeHNIm/wtr1UrDveJfnkpbac",
  "AX14 (Airtable Bank Inbox)":
    "https://hooks.airtable.com/workflows/v1/genericWebhook/appXsq65yB9VuNup5/wflmJqlsTtuA7XPhx/wtrOpDqCjNOFodIO8"
};

const PROBE_PAYLOAD = {
  event: "health_check",
  source: "verify-webhooks",
  timestamp: new Date().toISOString()
};

async function checkEndpoint(label, url) {
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PROBE_PAYLOAD),
      signal: AbortSignal.timeout(10000)
    });
    const ms = Date.now() - start;
    return { label, status: resp.status, ok: resp.ok, ms, error: null };
  } catch (err) {
    const ms = Date.now() - start;
    return { label, status: null, ok: false, ms, error: err.message };
  }
}

async function main() {
  console.log("Webhook Health Check");
  console.log("=".repeat(70));
  console.log(`Checking ${Object.keys(ENDPOINTS).length} endpoints...\n`);

  const results = await Promise.all(
    Object.entries(ENDPOINTS).map(([label, url]) => checkEndpoint(label, url))
  );

  let pass = 0;
  let fail = 0;

  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    const status = r.error ? `ERROR: ${r.error}` : `HTTP ${r.status}`;
    console.log(`${icon} ${r.label.padEnd(35)} ${status.padEnd(20)} ${r.ms}ms`);
    if (r.ok) pass++;
    else fail++;
  }

  console.log("\n" + "=".repeat(70));
  console.log(`Results: ${pass} pass, ${fail} fail out of ${results.length} total`);

  if (fail > 0) {
    console.log("\n⚠️  Failed endpoints need investigation.");
    process.exit(1);
  } else {
    console.log("\n✅ All endpoints responding.");
  }
}

main().catch(console.error);
