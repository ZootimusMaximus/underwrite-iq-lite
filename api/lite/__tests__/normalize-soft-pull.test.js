const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const {
  normalizeSoftPullPayload,
  parseAmount,
  normalizeScore,
  normalizeTradeline,
  normalizePublicRecord,
  dedupeInquiries,
  RATING_SEVERITY
} = require("../crs/normalize-soft-pull");

// ---------------------------------------------------------------------------
// Load live sandbox responses
// ---------------------------------------------------------------------------
const FIXTURES_DIR = path.resolve(__dirname, "../../../../mar 2026");
let tuRaw, expRaw, efxRaw;

try {
  tuRaw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "tu-response.json"), "utf8"));
  expRaw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "exp-response.json"), "utf8"));
  efxRaw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "efx-response.json"), "utf8"));
} catch {
  // Tests will be skipped if fixture files are not available
}

// ============================================================================
// parseAmount
// ============================================================================

test("parseAmount: valid string number", () => {
  assert.equal(parseAmount("608"), 608);
  assert.equal(parseAmount("0"), 0);
  assert.equal(parseAmount("134624"), 134624);
});

test("parseAmount: returns null for empty/missing/invalid", () => {
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(undefined), null);
  assert.equal(parseAmount("UNKNOWN"), null);
  assert.equal(parseAmount("abc"), null);
});

// ============================================================================
// normalizeScore
// ============================================================================

test("normalizeScore: filters out income models", () => {
  const income = {
    modelName: "CreditVision Income Estimator",
    modelNameType: "00W16",
    scoreValue: "47 B"
  };
  assert.equal(normalizeScore(income), null);
});

test("normalizeScore: filters out Income Insight", () => {
  const income = { modelName: "Income Insight", modelNameType: "II", scoreValue: "37" };
  assert.equal(normalizeScore(income), null);
});

test("normalizeScore: normalizes TU FICO 9", () => {
  const raw = {
    modelName: "FICO® Score 9",
    modelNameType: "00W18",
    sourceType: "TransUnion",
    scoreValue: "725",
    scoreRankPercentileValue: "47",
    scoreMaximumValue: "850",
    scoreMinimumValue: "300",
    factaInquiriesIndicator: false,
    scoreFactors: [{ scoreFactorCode: "14", scoreFactorText: "LENGTH OF TIME" }]
  };
  const s = normalizeScore(raw);
  assert.equal(s.value, 725);
  assert.equal(s.source, "transunion");
  assert.equal(s.percentile, 47);
  assert.equal(s.min, 300);
  assert.equal(s.max, 850);
  assert.equal(s.factors.length, 1);
});

test("normalizeScore: EFX missing percentile/range", () => {
  const raw = {
    modelName: "FICO Score 9",
    modelNameType: "05206",
    sourceType: "Equifax",
    scoreValue: "636",
    factaInquiriesIndicator: true,
    scoreFactors: []
  };
  const s = normalizeScore(raw);
  assert.equal(s.value, 636);
  assert.equal(s.percentile, null);
  assert.equal(s.min, null);
  assert.equal(s.max, null);
});

// ============================================================================
// normalizeTradeline
// ============================================================================

test("normalizeTradeline: AU detection", () => {
  const raw = {
    accountOwnershipType: "AuthorizedUser",
    accountType: "Revolving",
    accountStatusType: "Open",
    creditorName: "CITI",
    creditLimitAmount: "8400",
    currentBalanceAmount: "608",
    sourceType: "TransUnion",
    derogatoryDataIndicator: false,
    currentRatingType: "AsAgreed"
  };
  const t = normalizeTradeline(raw);
  assert.equal(t.isAU, true);
  assert.equal(t.ownership, "authorized_user");
  assert.equal(t.creditLimit, 8400);
  assert.equal(t.currentBalance, 608);
  assert.equal(t.effectiveLimit, 8400);
});

test("normalizeTradeline: effectiveLimit falls back to highBalance", () => {
  const raw = {
    accountOwnershipType: "Individual",
    accountType: "Revolving",
    accountStatusType: "Open",
    creditorName: "BENEFICIAL",
    highBalanceAmount: "500",
    currentBalanceAmount: "239",
    sourceType: "Experian",
    derogatoryDataIndicator: false,
    currentRatingType: "AsAgreed"
  };
  const t = normalizeTradeline(raw);
  assert.equal(t.creditLimit, null);
  assert.equal(t.effectiveLimit, 500);
});

test("normalizeTradeline: empty highBalance on EXP", () => {
  const raw = {
    accountOwnershipType: "Individual",
    accountType: "Revolving",
    accountStatusType: "Open",
    creditorName: "BENEFICIAL",
    highBalanceAmount: "",
    currentBalanceAmount: "239",
    sourceType: "Experian",
    derogatoryDataIndicator: false,
    currentRatingType: "AsAgreed"
  };
  const t = normalizeTradeline(raw);
  assert.equal(t.highBalance, null);
  assert.equal(t.effectiveLimit, null);
});

test("normalizeTradeline: chargeoff with adverse ratings", () => {
  const raw = {
    accountOwnershipType: "Individual",
    accountType: "Installment",
    accountStatusType: "Closed",
    creditorName: "SIGNET BANK",
    chargeOffAmount: "4798",
    currentBalanceAmount: "4798",
    sourceType: "Experian",
    derogatoryDataIndicator: true,
    currentRatingCode: "9",
    currentRatingType: "ChargeOff",
    adverseRatings: {
      highestAdverseRatingDate: "2021-09-03",
      highestAdverseRatingCode: "9",
      highestAdverseRatingType: "CollectionOrChargeOff",
      mostRecentAdverseRatingDate: "2021-09-03",
      mostRecentAdverseRatingCode: "9",
      mostRecentAdverseRatingType: "CollectionOrChargeOff",
      priorAdverseRatings: [
        {
          priorAdverseRatingDate: "2021-09-03",
          priorAdverseRatingCode: "9",
          priorAdverseRatingType: "CollectionOrChargeOff"
        }
      ]
    }
  };
  const t = normalizeTradeline(raw);
  assert.equal(t.isDerogatory, true);
  assert.equal(t.chargeOffAmount, 4798);
  assert.equal(t.ratingSeverity, 5);
  assert.equal(t.adverseRatings.highest.type, "CollectionOrChargeOff");
  assert.equal(t.adverseRatings.prior.length, 1);
});

test("normalizeTradeline: late payment counts", () => {
  const raw = {
    accountOwnershipType: "Individual",
    accountType: "Open",
    accountStatusType: "Open",
    creditorName: "CT CHILD SUPPORT",
    currentBalanceAmount: "17148",
    sourceType: "Equifax",
    derogatoryDataIndicator: true,
    currentRatingType: "Late60Days",
    _30DayLates: "0",
    _60DayLates: "28",
    _90DayLates: "0"
  };
  const t = normalizeTradeline(raw);
  assert.equal(t.latePayments._60, 28);
  assert.equal(t.ratingSeverity, 2);
});

test("normalizeTradeline: missing late counts default to 0", () => {
  const raw = {
    accountOwnershipType: "Individual",
    accountType: "Revolving",
    accountStatusType: "Open",
    creditorName: "TEST",
    currentBalanceAmount: "100",
    sourceType: "Equifax",
    derogatoryDataIndicator: false,
    currentRatingType: "AsAgreed"
  };
  const t = normalizeTradeline(raw);
  assert.equal(t.latePayments._30, 0);
  assert.equal(t.latePayments._60, 0);
  assert.equal(t.latePayments._90, 0);
});

// ============================================================================
// dedupeInquiries
// ============================================================================

test("dedupeInquiries: removes EFX duplicates", () => {
  const inquiries = [
    { creditorName: "KROLL", inquiryDate: "2026-01-06", subscriberCode: "999ZB04441" },
    { creditorName: "KROLL", inquiryDate: "2026-01-06", subscriberCode: "999ZB04441" },
    { creditorName: "ONEMAIN", inquiryDate: "2026-01-04", subscriberCode: "999FP02420" }
  ];
  const deduped = dedupeInquiries(inquiries);
  assert.equal(deduped.length, 2);
});

// ============================================================================
// normalizePublicRecord
// ============================================================================

test("normalizePublicRecord: EXP bankruptcy", () => {
  const raw = {
    courtName: "US BKPT CT MA BOSTON",
    dispositionDate: "2022-02-11",
    dispositionType: "Discharged",
    docketIdentifier: "BK9321294",
    filedDate: "2021-10-28",
    legalObligationAmount: "UNKNOWN",
    sourceType: "Experian",
    publicRecordType: "BankruptcyChapter7"
  };
  const pr = normalizePublicRecord(raw);
  assert.equal(pr.type, "BankruptcyChapter7");
  assert.equal(pr.courtName, "US BKPT CT MA BOSTON");
  assert.equal(pr.amount, null);
  assert.equal(pr.source, "experian");
});

test("normalizePublicRecord: EFX bankruptcy with type", () => {
  const raw = {
    accountOwnershipType: "Joint",
    bankruptcyType: "Personal",
    dispositionType: "Discharged",
    docketIdentifier: "9223539",
    filedDate: "2019-09-01",
    sourceType: "Equifax",
    publicRecordType: "BankruptcyChapter7"
  };
  const pr = normalizePublicRecord(raw);
  assert.equal(pr.bankruptcyType, "Personal");
  assert.equal(pr.ownershipType, "Joint");
  assert.equal(pr.courtName, null);
});

// ============================================================================
// Full normalizeSoftPullPayload — live sandbox data
// ============================================================================

test("normalizeSoftPullPayload: throws on empty input", () => {
  assert.throws(() => normalizeSoftPullPayload([]), /non-empty array/);
  assert.throws(() => normalizeSoftPullPayload(null), /non-empty array/);
});

test("normalizeSoftPullPayload: single bureau (TU)", { skip: !tuRaw }, () => {
  const result = normalizeSoftPullPayload([tuRaw]);

  assert.equal(result.meta.bureauCount, 1);
  assert.deepEqual(result.meta.availableBureaus, ["transunion"]);
  assert.equal(result.bureaus.transunion.available, true);
  assert.equal(result.bureaus.transunion.score, 725);
  assert.equal(result.bureaus.experian.available, false);
  assert.equal(result.bureaus.equifax.available, false);

  // Identity
  assert.ok(result.identity.names.length >= 1);
  assert.equal(result.identity.names[0].first, "BARBARA");

  // Tradelines
  assert.ok(result.tradelines.length >= 3);
  const auTradeline = result.tradelines.find(t => t.isAU);
  assert.ok(auTradeline, "Should find AU tradeline");
  assert.equal(auTradeline.creditorName, "CITI");

  // Fraud finders (TU only)
  assert.ok(result.fraudFinders !== null);
  assert.ok(result.fraudFinders.risk !== null);
});

test("normalizeSoftPullPayload: single bureau (EXP)", { skip: !expRaw }, () => {
  const result = normalizeSoftPullPayload([expRaw]);

  assert.equal(result.bureaus.experian.available, true);
  assert.equal(result.bureaus.experian.score, 630);
  assert.equal(result.meta.bureauCount, 1);

  // Has chargeoff
  const chargeoff = result.tradelines.find(t => t.currentRatingType === "ChargeOff");
  assert.ok(chargeoff, "Should find chargeoff tradeline");
  assert.equal(chargeoff.chargeOffAmount, 4798);

  // Public records
  assert.ok(result.publicRecords.length >= 1);
  assert.equal(result.publicRecords[0].type, "BankruptcyChapter7");

  // Inquiries
  assert.ok(result.inquiries.length >= 10);

  // No fraud finders for EXP
  assert.equal(result.fraudFinders, null);
});

test("normalizeSoftPullPayload: single bureau (EFX)", { skip: !efxRaw }, () => {
  const result = normalizeSoftPullPayload([efxRaw]);

  assert.equal(result.bureaus.equifax.available, true);
  assert.equal(result.bureaus.equifax.score, 636);
  assert.equal(result.bureaus.equifax.percentile, null); // EFX has no percentile

  // EFX inquiry dedup
  const rawInqCount = efxRaw.inquiries.length;
  assert.ok(result.inquiries.length < rawInqCount, "EFX inquiries should be deduped");

  // Has derogatory tradelines
  const derogs = result.tradelines.filter(t => t.isDerogatory);
  assert.ok(derogs.length >= 3);

  // DOB (EFX only)
  assert.ok(result.identity.dobs.length >= 1);
});

test(
  "normalizeSoftPullPayload: all 3 bureaus merged",
  { skip: !tuRaw || !expRaw || !efxRaw },
  () => {
    const result = normalizeSoftPullPayload([tuRaw, expRaw, efxRaw]);

    assert.equal(result.meta.bureauCount, 3);
    assert.equal(result.bureaus.transunion.available, true);
    assert.equal(result.bureaus.experian.available, true);
    assert.equal(result.bureaus.equifax.available, true);

    // All tradelines merged
    const tuCount = tuRaw.tradelines.length;
    const expCount = expRaw.tradelines.length;
    const efxCount = efxRaw.tradelines.length;
    assert.equal(result.tradelines.length, tuCount + expCount + efxCount);

    // Identity from all bureaus (EFX may not have aliases)
    assert.ok(result.identity.names.length >= 2);
    assert.ok(result.identity.addresses.length >= 3);

    // Scores all populated
    assert.equal(result.bureaus.transunion.score, 725);
    assert.equal(result.bureaus.experian.score, 630);
    assert.equal(result.bureaus.equifax.score, 636);

    // Public records from multiple bureaus
    assert.ok(result.publicRecords.length >= 2);

    // Fraud finders from TU
    assert.ok(result.fraudFinders !== null);
  }
);

// ============================================================================
// RATING_SEVERITY ordering
// ============================================================================

test("RATING_SEVERITY: correct ordering", () => {
  assert.ok(RATING_SEVERITY.AsAgreed < RATING_SEVERITY.Late30Days);
  assert.ok(RATING_SEVERITY.Late30Days < RATING_SEVERITY.Late60Days);
  assert.ok(RATING_SEVERITY.Late60Days < RATING_SEVERITY.Late90Days);
  assert.ok(RATING_SEVERITY.Late90Days < RATING_SEVERITY.LateOver120Days);
  assert.ok(RATING_SEVERITY.LateOver120Days < RATING_SEVERITY.ChargeOff);
  assert.ok(RATING_SEVERITY.ChargeOff < RATING_SEVERITY.BankruptcyOrWageEarnerPlan);
});
