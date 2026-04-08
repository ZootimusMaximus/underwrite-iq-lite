const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSuggestions } = require("../crs/build-suggestions");

// ============================================================================
// Tests
// ============================================================================

test("buildSuggestions: empty findings → empty layers", () => {
  const result = buildSuggestions([], "FULL_STACK_APPROVAL", {}, null);
  assert.equal(result.layers.length, 4);
  assert.equal(result.layers[0].items.length, 0);
  assert.equal(result.topMoves.length, 0);
  assert.equal(result.flatList.length, 0);
});

test("buildSuggestions: critical findings in layer 1", () => {
  const findings = [
    {
      code: "ACTIVE_CHARGEOFF",
      severity: "critical",
      category: "derogatory",
      customerSafe: true,
      plainEnglishProblem: "Chargeoff",
      whatToDoNext: "Dispute it",
      whyItMatters: "bad"
    },
    {
      code: "UTIL_STRESS",
      severity: "high",
      category: "utilization",
      customerSafe: true,
      plainEnglishProblem: "High util",
      whatToDoNext: "Pay down",
      whyItMatters: "limits score"
    }
  ];
  const result = buildSuggestions(findings, "REPAIR", {}, null);

  assert.equal(result.layers[0].name, "Primary Blockers");
  assert.equal(result.layers[0].items.length, 2); // critical + high
});

test("buildSuggestions: medium findings in layer 2", () => {
  const findings = [
    {
      code: "THIN_FILE",
      severity: "medium",
      category: "tradeline_depth",
      customerSafe: true,
      plainEnglishProblem: "Thin",
      whatToDoNext: "Build file",
      whyItMatters: "limits"
    }
  ];
  const result = buildSuggestions(findings, "CONDITIONAL_APPROVAL", {}, null);

  assert.equal(result.layers[1].name, "Next Best Moves");
  assert.equal(result.layers[1].items.length, 1);
});

test("buildSuggestions: business findings in layer 4", () => {
  const findings = [
    {
      code: "NO_LLC_YOUNG_LLC",
      severity: "low",
      category: "business",
      customerSafe: true,
      plainEnglishProblem: "No LLC",
      whatToDoNext: "Form LLC",
      whyItMatters: "unlocks biz funding"
    },
    {
      code: "WEAK_BUSINESS",
      severity: "medium",
      category: "business",
      customerSafe: true,
      plainEnglishProblem: "Weak scores",
      whatToDoNext: "Build biz credit",
      whyItMatters: "limits biz"
    }
  ];
  const result = buildSuggestions(findings, "CONDITIONAL_APPROVAL", {}, null);

  assert.equal(result.layers[3].name, "Business Prep");
  assert.equal(result.layers[3].items.length, 2);
  // Business findings should NOT appear in severity layers
  assert.equal(result.layers[1].items.length, 0);
  assert.equal(result.layers[2].items.length, 0);
});

test("buildSuggestions: topMoves sorted by severity", () => {
  const findings = [
    {
      code: "THIN_FILE",
      severity: "medium",
      category: "tradeline_depth",
      customerSafe: true,
      plainEnglishProblem: "Thin",
      whatToDoNext: "Build",
      whyItMatters: ""
    },
    {
      code: "ACTIVE_CHARGEOFF",
      severity: "critical",
      category: "derogatory",
      customerSafe: true,
      plainEnglishProblem: "Chargeoff",
      whatToDoNext: "Fix",
      whyItMatters: ""
    },
    {
      code: "UTIL_STRESS",
      severity: "high",
      category: "utilization",
      customerSafe: true,
      plainEnglishProblem: "Util",
      whatToDoNext: "Pay",
      whyItMatters: ""
    }
  ];
  const result = buildSuggestions(findings, "REPAIR", {}, null);

  assert.equal(result.topMoves[0].code, "ACTIVE_CHARGEOFF");
  assert.equal(result.topMoves[1].code, "UTIL_STRESS");
  assert.equal(result.topMoves[2].code, "THIN_FILE");
});

test("buildSuggestions: topMoves NOT capped (v3 — all findings)", () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({
    code: `FINDING_${i}`,
    severity: "high",
    category: "derogatory",
    customerSafe: true,
    plainEnglishProblem: `Problem ${i}`,
    whatToDoNext: `Fix ${i}`,
    whyItMatters: ""
  }));
  const result = buildSuggestions(findings, "REPAIR", {}, null);
  assert.equal(result.topMoves.length, 10, "v3 removes the top-5 cap");
});

test("buildSuggestions: fullSuggestions includes all customer-safe findings", () => {
  const findings = [
    {
      code: "A",
      severity: "critical",
      category: "derogatory",
      customerSafe: true,
      plainEnglishProblem: "P1",
      whatToDoNext: "N1",
      whyItMatters: "M1"
    },
    {
      code: "B",
      severity: "medium",
      category: "utilization",
      customerSafe: true,
      plainEnglishProblem: "P2",
      whatToDoNext: "N2",
      whyItMatters: "M2"
    },
    {
      code: "C",
      severity: "high",
      category: "identity",
      customerSafe: false,
      plainEnglishProblem: "P3",
      whatToDoNext: "N3",
      whyItMatters: "M3"
    }
  ];
  const result = buildSuggestions(findings, "REPAIR", {}, null);
  assert.equal(result.fullSuggestions.length, 2, "Only customer-safe findings");
  assert.equal(result.fullSuggestions[0].code, "A"); // critical first
});

test("buildSuggestions: projectedPreapproval passed through", () => {
  const projected = { total: 50000, cards: 30000, loans: 20000 };
  const result = buildSuggestions([], "FULL_STACK_APPROVAL", {}, null, projected);
  assert.deepStrictEqual(result.projectedPreapproval, projected);
});

test("buildSuggestions: projectedPreapproval null when not provided", () => {
  const result = buildSuggestions([], "FULL_STACK_APPROVAL", {}, null);
  assert.equal(result.projectedPreapproval, null);
});

test("buildSuggestions: flatList excludes non-customerSafe", () => {
  const findings = [
    {
      code: "PUBLIC",
      severity: "high",
      category: "derogatory",
      customerSafe: true,
      plainEnglishProblem: "Issue",
      whatToDoNext: "Fix it",
      whyItMatters: ""
    },
    {
      code: "INTERNAL",
      severity: "high",
      category: "identity",
      customerSafe: false,
      plainEnglishProblem: "Secret",
      whatToDoNext: "Internal only",
      whyItMatters: ""
    }
  ];
  const result = buildSuggestions(findings, "REPAIR", {}, null);
  assert.equal(result.flatList.length, 1);
  assert.equal(result.flatList[0], "Fix it");
});
