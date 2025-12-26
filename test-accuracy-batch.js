require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");

const TEST_PDFS = [
  // Experian (3)
  "4 11 25 Experian Credit report.pdf",
  "Nicholas Ortiz - Experian.pdf",
  "JeremyAdamsExperian.pdf",
  // TransUnion (4)
  "2025-04-04 - Andrew Lauder - TransUnion Credit Report.pdf",
  "ANDRE BLAND TRANSUNION.pdf",
  "Andrea Hwang Transunion.pdf",
  "Elisheva Bronsteyn Transunion.pdf",
  // Equifax (3)
  "AshleyHollandEquifax.pdf",
  "Brice Pierce Equifax.pdf",
  "Clayton Brown Equifax.pdf"
];

const GDRIVE_PATH = "./gdrive";
const API_URL =
  process.env.PARSE_ENDPOINT || "https://underwrite-iq-lite.vercel.app/api/lite/parse-report";

async function testSinglePdf(filename) {
  const filePath = path.join(GDRIVE_PATH, filename);

  if (!fs.existsSync(filePath)) {
    return { filename, ok: false, error: "File not found" };
  }

  const pdfBuffer = fs.readFileSync(filePath);
  const blob = new Blob([pdfBuffer], { type: "application/pdf" });
  const form = new FormData();
  form.append("file", blob, filename);

  const startTime = Date.now();

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      body: form
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const result = await response.json();

    return {
      filename,
      ok: result.ok,
      elapsed: elapsed + "s",
      bureaus: result.bureaus || null,
      error: result.ok ? null : result.reason || result.msg
    };
  } catch (err) {
    return { filename, ok: false, error: err.message };
  }
}

function extractBureauSummary(bureaus) {
  if (!bureaus) return "No bureaus";

  const summary = [];
  for (const [name, data] of Object.entries(bureaus)) {
    if (data) {
      summary.push(
        `${name}: score=${data.score || "N/A"}, util=${data.utilization_pct || "N/A"}%, neg=${data.negatives || 0}, tradelines=${data.tradelines?.length || 0}`
      );
    }
  }
  return summary.join(" | ") || "Empty";
}

async function runBatchTest() {
  console.log("=".repeat(70));
  console.log("🧪 PARSING ACCURACY TEST - 10 Sample Credit Reports");
  console.log("=".repeat(70));
  console.log(`📡 API: ${API_URL}\n`);

  const results = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < TEST_PDFS.length; i++) {
    const filename = TEST_PDFS[i];
    console.log(`[${i + 1}/${TEST_PDFS.length}] Testing: ${filename}`);

    const result = await testSinglePdf(filename);
    results.push(result);

    if (result.ok) {
      passed++;
      console.log(`   ✅ PASS (${result.elapsed}) - ${extractBureauSummary(result.bureaus)}`);
    } else {
      failed++;
      console.log(`   ❌ FAIL - ${result.error}`);
    }
    console.log("");
  }

  console.log("=".repeat(70));
  console.log("📊 SUMMARY");
  console.log("=".repeat(70));
  console.log(`Total: ${TEST_PDFS.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / TEST_PDFS.length) * 100).toFixed(1)}%`);
  console.log("");

  // Detailed results table
  console.log("=".repeat(70));
  console.log("📋 DETAILED RESULTS");
  console.log("=".repeat(70));

  for (const r of results) {
    console.log(`\n📄 ${r.filename}`);
    console.log(`   Status: ${r.ok ? "✅ PASS" : "❌ FAIL"}`);
    console.log(`   Time: ${r.elapsed || "N/A"}`);

    if (r.bureaus) {
      for (const [bureau, data] of Object.entries(r.bureaus)) {
        if (data) {
          console.log(`   ${bureau.toUpperCase()}:`);
          console.log(`      Score: ${data.score || "N/A"}`);
          console.log(`      Utilization: ${data.utilization_pct || "N/A"}%`);
          console.log(`      Negatives: ${data.negatives || 0}`);
          console.log(`      Inquiries: ${data.inquiries || 0}`);
          console.log(`      Tradelines: ${data.tradelines?.length || 0}`);
          console.log(`      Names: ${data.names?.length || 0}`);
          console.log(`      Addresses: ${data.addresses?.length || 0}`);
        }
      }
    } else if (r.error) {
      console.log(`   Error: ${r.error}`);
    }
  }

  // Save results to JSON
  const outputPath = "./test-accuracy-results.json";
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to ${outputPath}`);
}

runBatchTest();
