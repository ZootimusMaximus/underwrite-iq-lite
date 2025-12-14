require("dotenv").config({ quiet: true });
const fs = require("fs");

async function testParse() {
  const pdfPath = "./testdata.pdf";

  if (!fs.existsSync(pdfPath)) {
    console.error("testdata.pdf not found");
    process.exit(1);
  }

  console.log("📄 Testing parse speed with testdata.pdf...");
  console.log("⏱️  Starting timer...\n");

  const startTime = Date.now();

  // Read PDF as buffer and create proper FormData for Node.js native fetch
  const pdfBuffer = fs.readFileSync(pdfPath);
  const blob = new Blob([pdfBuffer], { type: "application/pdf" });

  const form = new FormData();
  form.append("file", blob, "testdata.pdf");

  try {
    const response = await fetch("http://localhost:3000/api/lite/parse-report", {
      method: "POST",
      body: form
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    const result = await response.json();

    console.log("=".repeat(50));
    console.log("⏱️  TOTAL TIME: " + elapsed + " seconds");
    console.log("=".repeat(50));
    console.log("\n✅ OK: " + result.ok);

    if (result.ok && result.bureaus) {
      const bureaus = result.bureaus;
      console.log("\n📊 Bureaus found:");
      if (bureaus.experian)
        console.log("   - Experian: Score " + (bureaus.experian.score || "N/A"));
      if (bureaus.equifax) console.log("   - Equifax: Score " + (bureaus.equifax.score || "N/A"));
      if (bureaus.transunion)
        console.log("   - TransUnion: Score " + (bureaus.transunion.score || "N/A"));
    } else if (!result.ok) {
      console.log("\n❌ Error: " + (result.reason || result.msg));
    }

    console.log("\n" + "=".repeat(50));
    if (elapsed <= 30) {
      console.log("🎯 GOAL MET: Under 30 seconds!");
    } else {
      console.log("⚠️  GOAL MISSED: " + elapsed + "s > 30s target");
    }
  } catch (err) {
    console.error("Error:", err.message);
    console.log("\n💡 Make sure vercel dev is running on port 3000");
  }
}

testParse();
