const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCards } = require("../crs/build-cards");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCS(overrides = {}) {
  return {
    scores: { median: 720, bureauConfidence: "high", spread: 20, perBureau: {} },
    tradelines: {
      total: 10,
      primary: 8,
      au: 2,
      auDominance: 0.2,
      revolvingDepth: 4,
      installmentDepth: 2,
      mortgagePresent: false,
      depth: 8,
      thinFile: false
    },
    anchors: { revolving: { creditor: "BANK", limit: 15000 }, installment: null },
    utilization: { totalBalance: 2000, totalLimit: 20000, pct: 10, band: "good" },
    inquiries: { total: 2, last6Mo: 1, last12Mo: 2, pressure: "low" },
    derogatories: {
      active: 0,
      chargeoffs: 0,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 0,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    },
    ...overrides
  };
}

function makeBS(overrides = {}) {
  return { available: true, hardBlock: { blocked: false, reasons: [] }, ...overrides };
}

// ============================================================================
// Tests
// ============================================================================

test("buildCards: FULL_STACK → full_stack tag", () => {
  const tags = buildCards("FULL_FUNDING", makeCS(), makeBS(), []);
  assert.ok(tags.includes("full_stack"));
  assert.ok(tags.includes("business_boost_available"));
});

test("buildCards: PREMIUM_STACK → both premium and full_stack tags", () => {
  const tags = buildCards("PREMIUM_STACK", makeCS(), null, []);
  assert.ok(tags.includes("premium_stack"));
  assert.ok(tags.includes("full_stack"));
});

test("buildCards: FRAUD_HOLD tag", () => {
  const tags = buildCards("FRAUD_HOLD", makeCS(), null, []);
  assert.ok(tags.includes("fraud_hold"));
});

test("buildCards: REPAIR with derogatories", () => {
  const cs = makeCS({
    derogatories: {
      active: 2,
      chargeoffs: 1,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 5,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    }
  });
  const tags = buildCards("REPAIR_ONLY", cs, null, []);
  assert.ok(tags.includes("needs_negative_cleanup"));
});

test("buildCards: utilization tags", () => {
  const cs = makeCS({
    utilization: { totalBalance: 9000, totalLimit: 10000, pct: 90, band: "critical" }
  });
  const tags = buildCards("REPAIR_ONLY", cs, null, []);
  assert.ok(tags.includes("util_critical"));
});

test("buildCards: thin file + AU dominant", () => {
  const cs = makeCS({
    tradelines: {
      total: 5,
      primary: 1,
      au: 4,
      auDominance: 0.8,
      revolvingDepth: 0,
      installmentDepth: 0,
      mortgagePresent: false,
      depth: 1,
      thinFile: true
    }
  });
  const tags = buildCards("FUNDING_PLUS_REPAIR", cs, null, []);
  assert.ok(tags.includes("thin_file"));
  assert.ok(tags.includes("au_dominant"));
  assert.ok(tags.includes("needs_file_buildout"));
});

test("buildCards: inquiry pressure", () => {
  const cs = makeCS({ inquiries: { total: 15, last6Mo: 12, last12Mo: 15, pressure: "storm" } });
  const tags = buildCards("FUNDING_PLUS_REPAIR", cs, null, []);
  assert.ok(tags.includes("needs_inquiry_cleanup"));
});

test("buildCards: bankruptcy tags", () => {
  const cs = makeCS({
    derogatories: {
      active: 0,
      chargeoffs: 0,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 0,
      activeBankruptcy: false,
      dischargedBankruptcy: true,
      bankruptcyAge: 36
    }
  });
  const tags = buildCards("FUNDING_PLUS_REPAIR", cs, null, []);
  assert.ok(tags.includes("bankruptcy_discharged"));
});

test("buildCards: near_approval when conditional with no critical findings", () => {
  const tags = buildCards("FUNDING_PLUS_REPAIR", makeCS(), null, [
    { severity: "medium", code: "THIN_FILE" }
  ]);
  assert.ok(tags.includes("near_approval"));
  assert.ok(tags.includes("conditional"));
});

test("buildCards: NOT near_approval when critical findings exist", () => {
  const tags = buildCards("FUNDING_PLUS_REPAIR", makeCS(), null, [
    { severity: "critical", code: "ACTIVE_CHARGEOFF" }
  ]);
  assert.ok(!tags.includes("near_approval"));
});

test("buildCards: business blocked", () => {
  const bs = makeBS({ hardBlock: { blocked: true, reasons: ["BUSINESS_INACTIVE"] } });
  const tags = buildCards("FUNDING_PLUS_REPAIR", makeCS(), bs, []);
  assert.ok(tags.includes("business_blocked"));
  assert.ok(!tags.includes("business_boost_available"));
});

test("buildCards: no duplicate tags", () => {
  const cs = makeCS({
    tradelines: {
      total: 5,
      primary: 1,
      au: 4,
      auDominance: 0.8,
      revolvingDepth: 0,
      installmentDepth: 0,
      mortgagePresent: false,
      depth: 1,
      thinFile: true
    }
  });
  const tags = buildCards("FUNDING_PLUS_REPAIR", cs, null, []);
  const unique = new Set(tags);
  assert.equal(tags.length, unique.size);
});

// ============================================================================
// Second audit fix pass — spec alias tags
// ============================================================================

test("buildCards: spec alias tags are present (inquiries, negatives, file_buildout, public_record)", () => {
  const cs = makeCS({
    tradelines: {
      total: 5,
      primary: 1,
      au: 4,
      auDominance: 0.8,
      revolvingDepth: 0,
      installmentDepth: 0,
      mortgagePresent: false,
      depth: 1,
      thinFile: true
    },
    inquiries: { total: 15, last6Mo: 12, last12Mo: 15, pressure: "storm" },
    derogatories: {
      active: 2,
      chargeoffs: 1,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: 0,
      active120Plus: 0,
      worstSeverity: 5,
      activeBankruptcy: false,
      dischargedBankruptcy: true,
      bankruptcyAge: 36
    }
  });
  const tags = buildCards("REPAIR_ONLY", cs, null, []);
  assert.ok(tags.includes("inquiries"), "should include spec alias tag: inquiries");
  assert.ok(tags.includes("negatives"), "should include spec alias tag: negatives");
  assert.ok(tags.includes("file_buildout"), "should include spec alias tag: file_buildout");
  assert.ok(tags.includes("public_record"), "should include spec alias tag: public_record");
});
