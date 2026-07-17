"use strict";

/**
 * generate-sample-packet.js
 *
 * Produces a SAMPLE SIMULATED client deliverable packet (PDFs) so Chris can see
 * exactly what a client receives — for building course content.
 *
 * Uses the sandbox bureau responses (no live Stitch pull) → runs the real CRS
 * engine → generates the Claude "rich" documents + dispute letters + the
 * deterministic summary PDFs → writes every PDF to a dated folder.
 *
 * All client-facing document titles are the scrubbed "business consulting"
 * names (no "credit"/"funding") per Chris's 2026-07-17 compliance note.
 *
 * Usage: node scripts/generate-sample-packet.js
 */

require("dotenv").config({ path: ".env.local" });

const fs = require("fs");
const path = require("path");

const { runCRSEngine } = require("../api/lite/crs/engine");
const { generateDeliverables } = require("../api/lite/crs/generate-deliverables");
const { renderAllPDFs } = require("../api/lite/crs/render-pdf");
const { generateAllSummaryDocuments } = require("../api/lite/crs/summary-doc-generator");

const SANDBOX_DIR = path.resolve(__dirname, "../api/lite/crs/sandbox");
const OUTPUT_DIR = path.resolve(__dirname, "../../july-2026/july-17/sample-packet");

const personal = {
  name: "James Richardson",
  address: "4521 Oak Park Drive, Phoenix, AZ 85016"
};

// Friendly, consulting-framed filenames for the packet.
const NICE_NAME = {
  credit_analysis: "Financial-Profile-Assessment",
  roadmap: "Business-Readiness-Roadmap",
  funding_snapshot: "Capital-Readiness-Snapshot",
  lender_match: "Capital-Partner-Shortlist",
  funding_summary: "Capital-Readiness-Summary",
  repair_plan_summary: "Optimization-Plan-Summary",
  business_prep_summary: "Business-Readiness-Guide"
};

function loadSandbox() {
  return ["exp", "efx", "tu"].map(b =>
    JSON.parse(fs.readFileSync(path.join(SANDBOX_DIR, `${b}.json`), "utf8"))
  );
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const manifest = [];
  let written = 0;

  const writeNamed = (fileName, buffer, tag) => {
    const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
    const file = path.join(OUTPUT_DIR, safe.endsWith(".pdf") ? safe : `${safe}.pdf`);
    fs.writeFileSync(file, buffer);
    written += 1;
    manifest.push(`${tag.padEnd(18)} ${path.basename(file)} (${buffer.length} bytes)`);
    process.stdout.write(`  ✔ ${path.basename(file)}\n`);
  };
  // Rich docs/summaries → consulting-branded name; letters keep their bureau/round filename.
  const write = (baseName, buffer, tag) => writeNamed(NICE_NAME[baseName] || baseName, buffer, tag);

  console.log("\n📦 Generating sample deliverable packet…\n");

  // 1) Engine
  const crsResult = runCRSEngine({
    rawResponses: loadSandbox(),
    submittedName: personal.name,
    submittedAddress: personal.address
  });
  console.log(
    `Engine outcome: ${crsResult.outcome} | score ${crsResult.consumerSignals?.scores?.median}\n`
  );

  // 2) Claude "rich" documents + dispute letters (needs ANTHROPIC_API_KEY)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      console.log("Generating AI documents + dispute letters (Claude)…");
      const d = await generateDeliverables(crsResult, personal);
      const documents = [
        { type: "credit_analysis", content: d.documents.creditAnalysis },
        { type: "roadmap", content: d.documents.roadmap },
        { type: "funding_snapshot", content: d.documents.fundingSnapshot },
        { type: "lender_match", content: d.documents.lenderMatchList }
      ].filter(x => x.content);

      const pdfs = await renderAllPDFs({
        documents,
        letters: d.letters || [],
        personal,
        engineData: crsResult
      });
      for (const p of pdfs) {
        if (NICE_NAME[p.docType]) {
          write(p.docType, p.buffer, "AI-DOC");
        } else {
          // Letters: keep renderAllPDFs filename (has bureau/round suffix) so the
          // three bureaus don't overwrite each other.
          writeNamed(p.filename, p.buffer, "LETTER");
        }
      }
    } catch (err) {
      console.log(`  ⚠ AI document step failed: ${err.message}`);
    }
  } else {
    console.log("  ⚠ ANTHROPIC_API_KEY not set — skipping AI documents.");
  }

  // 3) Deterministic client summary PDFs (no Claude) — force all 3 client-facing types
  try {
    console.log("\nGenerating summary PDFs…");
    const specs = [
      { type: "funding_summary" },
      { type: "repair_plan_summary" },
      { type: "business_prep_summary" }
    ];
    const summaries = await generateAllSummaryDocuments(specs, crsResult, personal);
    for (const s of summaries) {
      write(s.type, s.buffer, "SUMMARY");
    }
  } catch (err) {
    console.log(`  ⚠ Summary step failed: ${err.message}`);
  }

  // Manifest
  const manifestText =
    `FundHub — Sample Deliverable Packet\n` +
    `Generated for: ${personal.name}\n` +
    `Engine outcome: ${crsResult.outcome}\n` +
    `Files: ${written}\n\n` +
    manifest.join("\n") +
    `\n\nNOTE: Titles use the business-consulting naming (no "credit"/"funding").\n` +
    `Dispute letters intentionally keep FCRA legal language (sent to bureaus, not Commas).\n`;
  fs.writeFileSync(path.join(OUTPUT_DIR, "MANIFEST.txt"), manifestText);

  console.log(`\n✅ Done — ${written} PDFs → ${OUTPUT_DIR}\n`);
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
