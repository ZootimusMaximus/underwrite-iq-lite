"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateSummaryDocument,
  generateAllSummaryDocuments,
  generateFundingSummary,
  generateRepairPlanSummary,
  generateIssuePrioritySheet,
  generateHoldNotice,
  generateOperatorChecklist,
  generateBusinessPrepSummary
} = require("../crs/summary-doc-generator");

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const mockCRSResult = {
  ok: true,
  outcome: "CONDITIONAL_APPROVAL",
  decision_label: "Conditionally Approved",
  decision_explanation: "You are conditionally approved for funding.",
  reason_codes: ["SCORE_CONDITIONAL_BAND", "INQUIRY_PRESSURE"],
  confidence: "medium",
  consumer_summary: "Credit score: 695. Utilization at 42%.",
  consumerSignals: {
    scores: { median: 695 },
    utilization: { overall: 42 },
    derogatories: { active: 1 }
  },
  businessSignals: {
    available: true,
    scores: { intelliscore: 55, fsr: 3 },
    dbt: { value: 12 }
  },
  preapprovals: {
    totalPersonal: 45000,
    totalBusiness: 15000,
    totalCombined: 60000,
    confidenceBand: "medium"
  },
  optimization_findings: [
    {
      code: "HIGH_UTIL",
      category: "utilization",
      severity: "high",
      title: "High utilization on revolving accounts"
    },
    {
      code: "ACTIVE_DEROG",
      category: "derogatories",
      severity: "high",
      title: "Active derogatory account"
    },
    {
      code: "INQ_PRESSURE",
      category: "inquiries",
      severity: "medium",
      title: "Elevated inquiry count"
    }
  ],
  suggestions: {
    topMoves: [
      { title: "Pay down credit cards below 30%" },
      { title: "Dispute inaccurate derogatory" }
    ]
  }
};

const mockPersonal = { name: "BARBARA M DOTY", address: "123 Main St, Denton TX 76201" };

// ---------------------------------------------------------------------------
// Individual generator tests
// ---------------------------------------------------------------------------

test("generateFundingSummary: produces valid PDF buffer", async () => {
  const buffer = await generateFundingSummary(mockCRSResult, mockPersonal);
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 100);
  assert.equal(buffer.slice(0, 5).toString(), "%PDF-");
});

test("generateRepairPlanSummary: produces valid PDF buffer", async () => {
  const buffer = await generateRepairPlanSummary(mockCRSResult, mockPersonal);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.slice(0, 5).toString(), "%PDF-");
});

test("generateIssuePrioritySheet: produces valid PDF buffer", async () => {
  const buffer = await generateIssuePrioritySheet(mockCRSResult);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.slice(0, 5).toString(), "%PDF-");
});

test("generateHoldNotice: produces valid PDF buffer", async () => {
  const holdResult = {
    ...mockCRSResult,
    outcome: "FRAUD_HOLD",
    decision_label: "Application On Hold",
    decision_explanation: "Identity verification required.",
    reason_codes: ["FRAUD_HIGH_RISK"]
  };
  const buffer = await generateHoldNotice(holdResult, mockPersonal);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.slice(0, 5).toString(), "%PDF-");
});

test("generateOperatorChecklist: produces valid PDF for each outcome", async () => {
  const outcomes = [
    "FRAUD_HOLD",
    "MANUAL_REVIEW",
    "REPAIR",
    "CONDITIONAL_APPROVAL",
    "FULL_STACK_APPROVAL",
    "PREMIUM_STACK"
  ];
  for (const outcome of outcomes) {
    const result = { ...mockCRSResult, outcome };
    const buffer = await generateOperatorChecklist(result);
    assert.ok(Buffer.isBuffer(buffer), `Failed for ${outcome}`);
    assert.equal(buffer.slice(0, 5).toString(), "%PDF-");
  }
});

test("generateBusinessPrepSummary: produces valid PDF with business data", async () => {
  const buffer = await generateBusinessPrepSummary(mockCRSResult);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.slice(0, 5).toString(), "%PDF-");
});

test("generateBusinessPrepSummary: handles missing business signals", async () => {
  const noBusiness = { ...mockCRSResult, businessSignals: { available: false } };
  const buffer = await generateBusinessPrepSummary(noBusiness);
  assert.ok(Buffer.isBuffer(buffer));
});

// ---------------------------------------------------------------------------
// Dispatcher tests
// ---------------------------------------------------------------------------

test("generateSummaryDocument: routes to correct generator", async () => {
  const types = [
    "funding_summary",
    "repair_plan_summary",
    "issue_priority_sheet",
    "hold_notice",
    "operator_checklist",
    "business_prep_summary"
  ];
  for (const type of types) {
    const buffer = await generateSummaryDocument(type, mockCRSResult, mockPersonal);
    assert.ok(Buffer.isBuffer(buffer), `Failed for type: ${type}`);
  }
});

test("generateSummaryDocument: throws for unknown type", async () => {
  await assert.rejects(() => generateSummaryDocument("unknown_type", mockCRSResult), {
    message: /Unknown summary document type/
  });
});

// ---------------------------------------------------------------------------
// Batch generator tests
// ---------------------------------------------------------------------------

test("generateAllSummaryDocuments: generates all specs", async () => {
  const specs = [
    { type: "funding_summary", description: "test" },
    { type: "operator_checklist", description: "test" }
  ];

  const results = await generateAllSummaryDocuments(specs, mockCRSResult, mockPersonal);
  assert.equal(results.length, 2);
  assert.equal(results[0].filename, "funding_summary.pdf");
  assert.equal(results[0].type, "funding_summary");
  assert.equal(results[1].filename, "operator_checklist.pdf");
  assert.ok(Buffer.isBuffer(results[0].buffer));
});

test("generateAllSummaryDocuments: skips unknown types silently", async () => {
  const specs = [
    { type: "funding_summary", description: "test" },
    { type: "nonexistent_type", description: "test" },
    { type: "hold_notice", description: "test" }
  ];

  const results = await generateAllSummaryDocuments(specs, mockCRSResult, mockPersonal);
  assert.equal(results.length, 2);
  assert.equal(results[0].type, "funding_summary");
  assert.equal(results[1].type, "hold_notice");
});

test("generateAllSummaryDocuments: handles empty specs", async () => {
  const results = await generateAllSummaryDocuments([], mockCRSResult, mockPersonal);
  assert.equal(results.length, 0);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("generateFundingSummary: handles minimal CRS result", async () => {
  const minimal = { ok: true, outcome: "FULL_STACK_APPROVAL" };
  const buffer = await generateFundingSummary(minimal, {});
  assert.ok(Buffer.isBuffer(buffer));
});

test("generateRepairPlanSummary: handles no findings/suggestions", async () => {
  const minimal = { ok: true, outcome: "REPAIR", optimization_findings: [], suggestions: {} };
  const buffer = await generateRepairPlanSummary(minimal, mockPersonal);
  assert.ok(Buffer.isBuffer(buffer));
});

test("generateIssuePrioritySheet: handles no findings", async () => {
  const minimal = { ok: true, optimization_findings: [] };
  const buffer = await generateIssuePrioritySheet(minimal);
  assert.ok(Buffer.isBuffer(buffer));
});
