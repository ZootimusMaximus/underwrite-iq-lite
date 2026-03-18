"use strict";

/**
 * generate-mock-clients.js — Generate 20 mock test clients
 *
 * Loads real Stitch Credit sandbox responses as templates, mutates them to
 * create 20 distinct credit profiles, runs each through the CRS engine,
 * and syncs results to Airtable (CLIENTS + SNAPSHOTS).
 *
 * Usage:
 *   node scripts/generate-mock-clients.js
 *   node scripts/generate-mock-clients.js --dry-run   # engine only, no Airtable writes
 *
 * Requires: AIRTABLE_API_KEY and AIRTABLE_BASE_ID in .env.local
 */

const path = require("node:path");
const fs = require("node:fs");

// Load env
require("dotenv").config({ path: path.resolve(__dirname, "../.env.local") });

const { runCRSEngine } = require("../api/lite/crs/engine");
const {
  isConfigured,
  createRecord,
  updateRecord,
  mapSnapshotFields,
  TABLE_CLIENTS,
  TABLE_SNAPSHOTS
} = require("../api/lite/crs/airtable-sync");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes("--dry-run");
const FIXTURES_DIR = path.resolve(__dirname, "../../mar 2026");

// ---------------------------------------------------------------------------
// Load sandbox fixture templates
// ---------------------------------------------------------------------------

let tuTemplate, expTemplate, efxTemplate;
try {
  tuTemplate = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "tu-sandbox-response.json"), "utf8")
  );
  expTemplate = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "exp-sandbox-response.json"), "utf8")
  );
  efxTemplate = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, "efx-sandbox-response.json"), "utf8")
  );
} catch (err) {
  console.error("Failed to load sandbox fixtures from", FIXTURES_DIR);
  console.error(err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 20 Mock Client Profiles
// ---------------------------------------------------------------------------

const MOCK_CLIENTS = [
  // --- PREMIUM_STACK (2) ---
  // Requires: score>=760, util<=10%, anchor revolving>=10k, revolvingDepth>=3, inquiry pressure "low" (<=2 in 6mo)
  // NOTE: inquiries are per-bureau, so total across 3 bureaus = ceil(N/3)*3. Set to 0 for "low" pressure.
  {
    name: "Marcus Wellington",
    email: "marcus.wellington@fundhub-test.com",
    phone: "5550100001",
    state: "CA",
    scores: { tu: 790, ex: 785, eq: 792 },
    utilization: 5,
    negatives: 0,
    inquiries: 0,
    tradelines: { revolving: 6, installment: 2 },
    expectedOutcome: "PREMIUM_STACK"
  },
  {
    name: "Diana Thornton",
    email: "diana.thornton@fundhub-test.com",
    phone: "5550100002",
    state: "NY",
    scores: { tu: 775, ex: 780, eq: 770 },
    utilization: 7,
    negatives: 0,
    inquiries: 0,
    tradelines: { revolving: 5, installment: 3 },
    expectedOutcome: "PREMIUM_STACK"
  },

  // --- FULL_STACK_APPROVAL (4) ---
  {
    name: "James Whitfield",
    email: "james.whitfield@fundhub-test.com",
    phone: "5550100003",
    state: "TX",
    scores: { tu: 740, ex: 735, eq: 742 },
    utilization: 18,
    negatives: 0,
    inquiries: 3,
    tradelines: { revolving: 4, installment: 2 },
    expectedOutcome: "FULL_STACK_APPROVAL"
  },
  {
    name: "Sarah Mitchell",
    email: "sarah.mitchell@fundhub-test.com",
    phone: "5550100004",
    state: "FL",
    scores: { tu: 720, ex: 715, eq: 725 },
    utilization: 22,
    negatives: 0,
    inquiries: 4,
    tradelines: { revolving: 3, installment: 1 },
    expectedOutcome: "FULL_STACK_APPROVAL"
  },
  {
    name: "Robert Chen",
    email: "robert.chen@fundhub-test.com",
    phone: "5550100005",
    state: "WA",
    scores: { tu: 710, ex: 705, eq: 715 },
    utilization: 25,
    negatives: 0,
    inquiries: 5,
    tradelines: { revolving: 5, installment: 2 },
    expectedOutcome: "FULL_STACK_APPROVAL"
  },
  {
    name: "Linda Park",
    email: "linda.park@fundhub-test.com",
    phone: "5550100006",
    state: "IL",
    scores: { tu: 730, ex: 725, eq: 728 },
    utilization: 15,
    negatives: 0,
    inquiries: 2,
    tradelines: { revolving: 4, installment: 1 },
    expectedOutcome: "FULL_STACK_APPROVAL"
  },

  // --- CONDITIONAL_APPROVAL (4) ---
  {
    name: "Kevin Rogers",
    email: "kevin.rogers@fundhub-test.com",
    phone: "5550100007",
    state: "GA",
    scores: { tu: 695, ex: 690, eq: 700 },
    utilization: 35,
    negatives: 0,
    inquiries: 6,
    tradelines: { revolving: 3, installment: 1 },
    expectedOutcome: "CONDITIONAL_APPROVAL"
  },
  {
    name: "Michelle Torres",
    email: "michelle.torres@fundhub-test.com",
    phone: "5550100008",
    state: "AZ",
    scores: { tu: 680, ex: 685, eq: 678 },
    utilization: 42,
    negatives: 0,
    inquiries: 8,
    tradelines: { revolving: 4, installment: 2 },
    expectedOutcome: "CONDITIONAL_APPROVAL"
  },
  {
    name: "Brian Nakamura",
    email: "brian.nakamura@fundhub-test.com",
    phone: "5550100009",
    state: "CO",
    scores: { tu: 695, ex: 690, eq: 698 },
    utilization: 32,
    negatives: 0,
    inquiries: 10,
    tradelines: { revolving: 3, installment: 1 },
    expectedOutcome: "CONDITIONAL_APPROVAL"
  },
  {
    name: "Jasmine Cole",
    email: "jasmine.cole@fundhub-test.com",
    phone: "5550100010",
    state: "NV",
    scores: { tu: 675, ex: 680, eq: 670 },
    utilization: 45,
    negatives: 0,
    inquiries: 7,
    tradelines: { revolving: 2, installment: 1 },
    expectedOutcome: "CONDITIONAL_APPROVAL"
  },

  // --- REPAIR (6) ---
  {
    name: "Derek Washington",
    email: "derek.washington@fundhub-test.com",
    phone: "5550100011",
    state: "OH",
    scores: { tu: 620, ex: 615, eq: 625 },
    utilization: 65,
    negatives: 2,
    inquiries: 5,
    tradelines: { revolving: 3, installment: 1 },
    expectedOutcome: "REPAIR"
  },
  {
    name: "Patricia Gomez",
    email: "patricia.gomez@fundhub-test.com",
    phone: "5550100012",
    state: "NM",
    scores: { tu: 580, ex: 575, eq: 585 },
    utilization: 78,
    negatives: 3,
    inquiries: 12,
    tradelines: { revolving: 2, installment: 1 },
    expectedOutcome: "REPAIR"
  },
  {
    name: "Anthony Brooks",
    email: "anthony.brooks@fundhub-test.com",
    phone: "5550100013",
    state: "MI",
    scores: { tu: 550, ex: 545, eq: 555 },
    utilization: 85,
    negatives: 4,
    inquiries: 15,
    tradelines: { revolving: 2, installment: 0 },
    expectedOutcome: "REPAIR"
  },
  {
    name: "Samantha Reed",
    email: "samantha.reed@fundhub-test.com",
    phone: "5550100014",
    state: "PA",
    scores: { tu: 640, ex: 635, eq: 638 },
    utilization: 55,
    negatives: 1,
    inquiries: 8,
    tradelines: { revolving: 3, installment: 2 },
    expectedOutcome: "REPAIR"
  },
  {
    name: "Victor Hernandez",
    email: "victor.hernandez@fundhub-test.com",
    phone: "5550100015",
    state: "NC",
    scores: { tu: 600, ex: 595, eq: 605 },
    utilization: 70,
    negatives: 2,
    inquiries: 9,
    tradelines: { revolving: 1, installment: 1 },
    expectedOutcome: "REPAIR"
  },
  {
    name: "Tanya Foster",
    email: "tanya.foster@fundhub-test.com",
    phone: "5550100016",
    state: "TN",
    scores: { tu: 565, ex: 560, eq: 570 },
    utilization: 90,
    negatives: 5,
    inquiries: 14,
    tradelines: { revolving: 2, installment: 0 },
    expectedOutcome: "REPAIR"
  },

  // --- MANUAL_REVIEW (2) — triggered by name mismatch ---
  // skipIdentityUpdate: true keeps template CRS names so submitted name won't match
  {
    name: "Xavier Phantom",
    email: "manual.review1@fundhub-test.com",
    phone: "5550100017",
    state: "OR",
    scores: { tu: 720, ex: 715, eq: 725 },
    utilization: 20,
    negatives: 0,
    inquiries: 3,
    tradelines: { revolving: 4, installment: 2 },
    skipIdentityUpdate: true,
    expectedOutcome: "MANUAL_REVIEW"
  },
  {
    name: "Zara Neverexist",
    email: "manual.review2@fundhub-test.com",
    phone: "5550100018",
    state: "VA",
    scores: { tu: 650, ex: 645, eq: 655 },
    utilization: 40,
    negatives: 0,
    inquiries: 6,
    tradelines: { revolving: 3, installment: 1 },
    skipIdentityUpdate: true,
    expectedOutcome: "MANUAL_REVIEW"
  },

  // --- FRAUD_HOLD (2) — triggered by fraud finder signals ---
  // injectFraud: true adds HIGH_FRAUD_RISK_SCORE + TUMBLING_RISK to TU response
  {
    name: "Carlos Phantom",
    email: "fraud.hold1@fundhub-test.com",
    phone: "5550100019",
    state: "TX",
    scores: { tu: 710, ex: 705, eq: 715 },
    utilization: 15,
    negatives: 0,
    inquiries: 2,
    tradelines: { revolving: 3, installment: 1 },
    injectFraud: true,
    expectedOutcome: "FRAUD_HOLD"
  },
  {
    name: "Natasha Decoy",
    email: "fraud.hold2@fundhub-test.com",
    phone: "5550100020",
    state: "FL",
    scores: { tu: 680, ex: 675, eq: 685 },
    utilization: 25,
    negatives: 0,
    inquiries: 4,
    tradelines: { revolving: 3, installment: 1 },
    injectFraud: true,
    expectedOutcome: "FRAUD_HOLD"
  }
];

// ---------------------------------------------------------------------------
// Synthetic CRS Response Builder
// ---------------------------------------------------------------------------

function buildSyntheticResponse(template, bureau, profile) {
  const resp = JSON.parse(JSON.stringify(template)); // deep clone

  const [firstName, ...lastParts] = profile.name.split(" ");
  const lastName = lastParts.join(" ") || "Test";

  // Update identity (skip for MANUAL_REVIEW profiles to trigger name mismatch)
  if (!profile.skipIdentityUpdate) {
    resp.requestData.firstName = firstName.toUpperCase();
    resp.requestData.lastName = lastName.toUpperCase();
    if (resp.creditFiles?.[0]?.aliases?.[0]) {
      resp.creditFiles[0].aliases[0].firstName = firstName.toUpperCase();
      resp.creditFiles[0].aliases[0].lastName = lastName.toUpperCase();
    }
  }
  resp.requestData.ssn = generateSSN(profile.email);
  resp.requestData.addresses[0].state = profile.state;

  // Update scores
  const bureauKey = { tu: "tu", exp: "ex", efx: "eq" }[bureau];
  const score = profile.scores[bureauKey] || 0;
  if (resp.scores) {
    resp.scores =
      score > 0
        ? [
            {
              borrowerSourceType: "Borrower",
              modelName:
                bureau === "tu"
                  ? "FICO® Score 9"
                  : bureau === "exp"
                    ? "Experian/Fair Isaac Risk Model V9"
                    : "FICO Score 9",
              sourceType:
                bureau === "tu" ? "TransUnion" : bureau === "exp" ? "Experian" : "Equifax",
              scoreValue: String(score),
              scoreMaximumValue: "850",
              scoreMinimumValue: "300",
              scoreFactors: [
                {
                  scoreFactorCode: "14",
                  scoreFactorText: "Length of time accounts have been established"
                }
              ]
            }
          ]
        : [];
  }

  // Build tradelines
  resp.tradelines = buildTradelines(bureau, profile);

  // Build inquiries
  resp.inquiries = buildInquiries(bureau, profile);

  // Build public records (negatives as collections)
  resp.publicRecords = [];

  // Inject fraud signals for FRAUD_HOLD profiles (TU only has fraudFinders)
  // Format: array of objects, normalizer reads raw[0].risk.score and raw[0].risk.tumbling_risk
  if (profile.injectFraud && bureau === "tu") {
    resp.fraudFinders = [
      {
        risk: {
          score: 75,
          tumbling_risk: 3
        }
      }
    ];
  }

  return resp;
}

function buildTradelines(bureau, profile) {
  const sourceType = bureau === "tu" ? "TransUnion" : bureau === "exp" ? "Experian" : "Equifax";
  const tradelines = [];
  const tl = profile.tradelines;

  if (tl.empty) return [];

  // Revolving accounts
  const revCount = tl.revolving || 0;
  for (let i = 0; i < revCount; i++) {
    const isAU = tl.auOnly && i === 0;
    const limit = 5000 + i * 3000;
    const balance = Math.round(limit * (profile.utilization / 100));
    const isDerog = i < (profile.negatives || 0);

    tradelines.push({
      accountIdentifier: `REV${String(i + 1).padStart(3, "0")}`,
      accountOpenedDate: `${2020 + i}-01-15`,
      accountReportedDate: "2026-03-01",
      accountStatusType: "Open",
      accountType: "Revolving",
      accountOwnershipType: isAU ? "AuthorizedUser" : "Individual",
      borrowerSourceType: "Borrower",
      derogatoryDataIndicator: isDerog,
      creditLimitAmount: String(limit),
      currentBalanceAmount: String(balance),
      highBalanceAmount: String(limit),
      pastDueAmount: isDerog ? String(Math.round(balance * 0.3)) : "0",
      monthsReviewedCount: "24",
      creditorName: `TEST BANK ${String.fromCharCode(65 + i)}`,
      subscriberCode: `0${i + 1}000000`,
      businessType: "Banking",
      loanType: "Revolving",
      _30DayLates: isDerog ? "2" : "0",
      _60DayLates: isDerog ? "1" : "0",
      _90DayLates: "0",
      currentRatingCode: isDerog ? "9" : "C",
      currentRatingType: isDerog ? "CollectionOrChargeOff" : "AsAgreed",
      paymentPatternData: isDerog ? "9CCCCCCCCCCCCCCCCCC" : "CCCCCCCCCCCCCCCCCCC",
      paymentPatternStartDate: "2026-03-01",
      sourceType
    });
  }

  // Installment accounts
  const instCount = tl.installment || 0;
  for (let i = 0; i < instCount; i++) {
    const origBalance = 15000 + i * 10000;
    const currentBalance = Math.round(origBalance * 0.6);

    tradelines.push({
      accountIdentifier: `INST${String(i + 1).padStart(3, "0")}`,
      accountOpenedDate: `${2019 + i}-06-01`,
      accountReportedDate: "2026-03-01",
      accountStatusType: "Open",
      accountType: "Installment",
      accountOwnershipType: "Individual",
      borrowerSourceType: "Borrower",
      derogatoryDataIndicator: false,
      highBalanceAmount: String(origBalance),
      currentBalanceAmount: String(currentBalance),
      pastDueAmount: "0",
      monthlyPaymentAmount: String(Math.round(origBalance / 60)),
      monthsReviewedCount: "36",
      termsMonthsCount: "60",
      creditorName: `AUTO FINANCE ${String.fromCharCode(65 + i)}`,
      subscriberCode: `0${i + 5}000000`,
      businessType: "Finance",
      loanType: "Installment",
      _30DayLates: "0",
      _60DayLates: "0",
      _90DayLates: "0",
      currentRatingCode: "C",
      currentRatingType: "AsAgreed",
      paymentPatternData: "CCCCCCCCCCCCCCCCCCC",
      paymentPatternStartDate: "2026-03-01",
      sourceType
    });
  }

  return tradelines;
}

function buildInquiries(bureau, profile) {
  const sourceType = bureau === "tu" ? "TransUnion" : bureau === "exp" ? "Experian" : "Equifax";
  const inquiries = [];

  // Distribute inquiries roughly evenly across bureaus (this bureau gets ~1/3)
  const count = Math.ceil(profile.inquiries / 3);
  for (let i = 0; i < count; i++) {
    const monthsAgo = i * 2 + 1;
    const date = new Date(2026, 2 - Math.floor(monthsAgo / 1), 15 - (monthsAgo % 28));

    inquiries.push({
      creditorName: `LENDER ${String.fromCharCode(65 + i)}`,
      borrowerSourceType: "Borrower",
      inquiryDate: date.toISOString().split("T")[0],
      businessType: "Banking",
      subscriberCode: `INQ${String(i + 1).padStart(4, "0")}`,
      sourceType
    });
  }

  return inquiries;
}

function generateSSN(email) {
  // Deterministic SSN from email hash (test data only)
  let hash = 0;
  for (const ch of email) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  const num = (Math.abs(hash) % 900000000) + 100000000;
  return String(num).slice(0, 9);
}

// ---------------------------------------------------------------------------
// Airtable Writers
// ---------------------------------------------------------------------------

async function createClientRecord(profile) {
  const fields = {
    full_name: profile.name,
    email: profile.email,
    phone: profile.phone,
    // personal_state is a single-select — skip to avoid INVALID_MULTIPLE_CHOICE_OPTIONS
    refresh_in_progress: true
  };

  const record = await createRecord(TABLE_CLIENTS, fields);
  return record.id;
}

async function createSnapshotRecord(crsResult, clientRecordId) {
  const fields = mapSnapshotFields(crsResult, clientRecordId);
  const record = await createRecord(TABLE_SNAPSHOTS, fields);
  return record.id;
}

async function markRefreshComplete(clientRecordId) {
  await updateRecord(TABLE_CLIENTS, clientRecordId, { refresh_in_progress: false });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n🏗️  Generating ${MOCK_CLIENTS.length} mock clients...`);
  console.log(
    `   Mode: ${DRY_RUN ? "DRY RUN (no Airtable writes)" : "LIVE (writing to Airtable)"}`
  );

  if (!DRY_RUN && !isConfigured()) {
    console.error("\n❌ Airtable not configured. Set AIRTABLE_API_KEY and AIRTABLE_BASE_ID.");
    process.exit(1);
  }

  const results = [];

  for (let i = 0; i < MOCK_CLIENTS.length; i++) {
    const profile = MOCK_CLIENTS[i];
    const num = String(i + 1).padStart(2, "0");

    process.stdout.write(
      `\n[${num}/${MOCK_CLIENTS.length}] ${profile.name} (${profile.expectedOutcome})... `
    );

    try {
      // 1. Build synthetic CRS responses (all 3 bureaus)
      const rawResponses = [];

      if (profile.scores.tu > 0 || !profile.tradelines.empty) {
        rawResponses.push(buildSyntheticResponse(tuTemplate, "tu", profile));
      }
      if (profile.scores.ex > 0) {
        rawResponses.push(buildSyntheticResponse(expTemplate, "exp", profile));
      }
      if (profile.scores.eq > 0) {
        rawResponses.push(buildSyntheticResponse(efxTemplate, "efx", profile));
      }

      // Fallback: at least 1 bureau
      if (rawResponses.length === 0) {
        rawResponses.push(buildSyntheticResponse(tuTemplate, "tu", profile));
      }

      // 2. Run CRS engine
      const engineResult = runCRSEngine({
        rawResponses,
        businessReport: null,
        submittedName: profile.name,
        submittedAddress: `123 Test St, ${profile.state}`,
        formData: {
          email: profile.email,
          phone: profile.phone,
          name: profile.name,
          ref: `mock-${num}`
        }
      });

      const outcome = engineResult.outcome;
      const match = outcome === profile.expectedOutcome ? "✅" : "⚠️";
      process.stdout.write(`${match} ${outcome}`);

      if (outcome !== profile.expectedOutcome) {
        process.stdout.write(` (expected ${profile.expectedOutcome})`);
      }

      // 3. Write to Airtable
      if (!DRY_RUN) {
        const clientId = await createClientRecord(profile);
        await createSnapshotRecord(engineResult, clientId);
        await markRefreshComplete(clientId);
        process.stdout.write(` → AT:${clientId.slice(0, 8)}...`);
      }

      results.push({
        name: profile.name,
        expected: profile.expectedOutcome,
        actual: outcome,
        match: outcome === profile.expectedOutcome,
        score: engineResult.consumerSignals?.scores?.median,
        preapproval: engineResult.preapprovals?.totalCombined || 0
      });
    } catch (err) {
      process.stdout.write(`❌ ERROR: ${err.message}`);
      results.push({
        name: profile.name,
        expected: profile.expectedOutcome,
        actual: "ERROR",
        match: false,
        error: err.message
      });
    }
  }

  // Summary
  console.log("\n\n" + "=".repeat(70));
  console.log("SUMMARY");
  console.log("=".repeat(70));

  const matched = results.filter(r => r.match).length;
  const mismatched = results.filter(r => !r.match && r.actual !== "ERROR").length;
  const errors = results.filter(r => r.actual === "ERROR").length;

  console.log(`✅ Matched: ${matched}/${results.length}`);
  if (mismatched > 0) console.log(`⚠️  Mismatched: ${mismatched}`);
  if (errors > 0) console.log(`❌ Errors: ${errors}`);

  // Outcome distribution
  const dist = {};
  for (const r of results) {
    dist[r.actual] = (dist[r.actual] || 0) + 1;
  }
  console.log("\nOutcome Distribution:");
  for (const [outcome, count] of Object.entries(dist).sort()) {
    console.log(`  ${outcome}: ${count}`);
  }

  // Mismatches detail
  if (mismatched > 0) {
    console.log("\nMismatches:");
    for (const r of results.filter(r => !r.match && r.actual !== "ERROR")) {
      console.log(`  ${r.name}: expected ${r.expected}, got ${r.actual} (score: ${r.score})`);
    }
  }

  console.log("");
}

main().catch(err => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
