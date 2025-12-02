const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TRI_MERGE_WARNING,
  ingestCreditReport,
  parseAnnualDisclosure,
  parseAsSingleBureau,
  enforceBureauSlots
} = require("../credit-ingestion");

test("tri-merge ingestion splits into bureau slices and shares mergedDocumentId", async () => {
  const text = `Experian Report Date: 2024-03-01 Score 720 section
  Lots of lines here before Equifax Report Date: 2024-02-11 Score: 690 details
  Additional filler and summary TransUnion reported on 02/01/2024 score 710 more lines`;

  const result = await ingestCreditReport(Buffer.from("dummy"), { textOverride: text });

  assert.equal(result.sourceType, "tri_merge");
  const bureaus = result.bureaus;
  assert.ok(bureaus.experian);
  assert.ok(bureaus.equifax);
  assert.ok(bureaus.transunion);
  assert.equal(bureaus.experian.derivedFromMerged, true);
  assert.equal(bureaus.equifax.derivedFromMerged, true);
  assert.equal(bureaus.transunion.derivedFromMerged, true);

  const ids = new Set([
    bureaus.experian.mergedDocumentId,
    bureaus.equifax.mergedDocumentId,
    bureaus.transunion.mergedDocumentId
  ]);
  assert.equal(ids.size, 1);
});

test("annual disclosure marks score unavailable when absent", () => {
  const annualText = "AnnualCreditReport.com disclosure for Equifax";
  const bureau = parseAnnualDisclosure(annualText);
  assert.equal(bureau.sourceType, "annual_disclosure");
  assert.equal(bureau.scoreDetails.available, false);
});

test("single bureau parsing is used when no tri-merge markers exist", async () => {
  const text = "Experian consumer file Report Date: 2024-04-01 score 735";
  const result = await ingestCreditReport(Buffer.from("dummy"), { textOverride: text });
  assert.equal(result.sourceType, "single_bureau");
  const bureau = result.bureaus.experian;
  assert.equal(bureau.score, 735);
  assert.equal(bureau.reportDate, "2024-04-01");
});

test("tri-merge detection falls back when boundaries are missing", async () => {
  const text = "Experian Equifax TransUnion"; // too short for three slices
  const result = await ingestCreditReport(Buffer.from("dummy"), { textOverride: text });
  const bureauList = Object.values(result.bureaus || {});
  assert.equal(result.sourceType, "single_bureau");
  assert.ok(bureauList[0].parsingWarnings.includes(TRI_MERGE_WARNING));
});

test("enforceBureauSlots replaces newer reports and rejects stale/overflow", () => {
  const existing = {
    experian: { reportDate: "2024-01-01" },
    equifax: { reportDate: "2024-02-01" },
    transunion: { reportDate: "2024-03-01" }
  };

  const incoming = {
    experian: { reportDate: "2024-05-01" },
    equifax: { reportDate: "2023-12-01" },
    newbureau: { reportDate: "2025-01-01" }
  };

  const { bureaus, rejected } = enforceBureauSlots(existing, incoming);
  assert.equal(bureaus.experian.reportDate, "2024-05-01");
  assert.ok(rejected.find(r => r.bureau === "equifax" && r.reason === "stale_report"));
  assert.ok(rejected.find(r => r.bureau === "newbureau" && r.reason === "max_bureaus_reached"));
});

test("parseAsSingleBureau exposes default metadata", () => {
  const bureau = parseAsSingleBureau("TransUnion score 640 as of 2024-01-20");
  assert.equal(bureau.sourceType, "single_bureau");
  assert.equal(bureau.score, 640);
  assert.equal(bureau.reportDate, "2024-01-20");
});
