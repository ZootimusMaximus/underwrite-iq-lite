"use strict";

/**
 * normalize-soft-pull.js — Stage 01: Ingest & Normalize
 *
 * Accepts one or more raw Stitch Credit CRS soft-pull responses,
 * merges them into a single canonical payload for downstream engine modules.
 *
 * Handles:
 * - String-to-number parsing for all amounts
 * - Bureau-specific field normalization (TU/EXP/EFX quirks)
 * - Income model score filtering
 * - Equifax inquiry deduplication
 * - Missing values → explicit 'unknown' (never silent nulls)
 * - AU detection via accountOwnershipType
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BUREAU_MAP = {
  TransUnion: "transunion",
  Experian: "experian",
  Equifax: "equifax"
};

const FICO_MODEL_NAMES = new Set([
  "FICO® Score 9",
  "FICO Score 9",
  "Experian/Fair Isaac Risk Model V9"
]);

const OWNERSHIP_MAP = {
  AuthorizedUser: "authorized_user",
  Individual: "individual",
  JointContractualLiability: "joint",
  JointParticipating: "joint",
  Maker: "primary",
  Comaker: "comaker",
  Undesignated: "undesignated"
};

const ACCOUNT_TYPE_MAP = {
  Revolving: "revolving",
  Installment: "installment",
  Mortgage: "mortgage",
  Open: "open",
  Unknown: "unknown"
};

const STATUS_MAP = {
  Open: "open",
  Closed: "closed",
  Paid: "paid",
  Transferred: "transferred"
};

const RATING_SEVERITY = {
  AsAgreed: 0,
  TooNew: 0,
  NoDataAvailable: 0,
  Late30Days: 1,
  Late60Days: 2,
  Late90Days: 3,
  LateOver120Days: 4,
  CollectionOrChargeOff: 5,
  ChargeOff: 5,
  BankruptcyOrWageEarnerPlan: 6
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a string amount to a number. Returns null for missing/empty/invalid.
 */
function parseAmount(val) {
  if (val === null || val === undefined || val === "" || val === "UNKNOWN") {
    return null;
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * Return val or 'unknown' if falsy/missing.
 */
function orUnknown(val) {
  return val || "unknown";
}

/**
 * Normalize a bureau sourceType string to lowercase key.
 */
function normBureau(sourceType) {
  return BUREAU_MAP[sourceType] || "unknown";
}

/**
 * Deduplicate Equifax inquiries (known EFX issue: same inquiry appears 2x).
 * Key on creditorName + inquiryDate + subscriberCode.
 */
function dedupeInquiries(inquiries) {
  const seen = new Set();
  return inquiries.filter(inq => {
    const key = `${inq.creditorName}|${inq.inquiryDate}|${inq.subscriberCode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

function normalizeScore(raw) {
  if (!FICO_MODEL_NAMES.has(raw.modelName)) return null;

  return {
    value: parseAmount(raw.scoreValue),
    model: raw.modelName || "unknown",
    modelCode: raw.modelNameType || "unknown",
    source: normBureau(raw.sourceType),
    percentile: parseAmount(raw.scoreRankPercentileValue) ?? null,
    min: parseAmount(raw.scoreMinimumValue) ?? null,
    max: parseAmount(raw.scoreMaximumValue) ?? null,
    factaInquiriesImpact: raw.factaInquiriesIndicator === true,
    factors: (raw.scoreFactors || []).map(f => ({
      code: f.scoreFactorCode || "unknown",
      text: f.scoreFactorText || "unknown"
    }))
  };
}

function normalizeTradeline(raw) {
  const ownershipRaw = raw.accountOwnershipType || "Undesignated";
  const ownership = OWNERSHIP_MAP[ownershipRaw] || "undesignated";
  const isAU = ownershipRaw === "AuthorizedUser";

  const creditLimit = parseAmount(raw.creditLimitAmount);
  const highBalance = parseAmount(raw.highBalanceAmount);
  const currentBalance = parseAmount(raw.currentBalanceAmount);

  // Effective limit: creditLimit if available, fallback to highBalance for revolving
  const effectiveLimit =
    creditLimit !== null
      ? creditLimit
      : highBalance !== null && highBalance > 0
        ? highBalance
        : null;

  const adverseRaw = raw.adverseRatings;
  const adverseRatings = adverseRaw
    ? {
        highest: {
          date: adverseRaw.highestAdverseRatingDate || null,
          code: adverseRaw.highestAdverseRatingCode || null,
          type: adverseRaw.highestAdverseRatingType || null
        },
        mostRecent: {
          date: adverseRaw.mostRecentAdverseRatingDate || null,
          code: adverseRaw.mostRecentAdverseRatingCode || null,
          type: adverseRaw.mostRecentAdverseRatingType || null
        },
        prior: (adverseRaw.priorAdverseRatings || []).map(p => ({
          date: p.priorAdverseRatingDate || null,
          code: p.priorAdverseRatingCode || null,
          type: p.priorAdverseRatingType || null
        }))
      }
    : null;

  return {
    creditorName: orUnknown(raw.creditorName),
    accountIdentifier: raw.accountIdentifier || "unknown",
    source: normBureau(raw.sourceType),
    accountType: ACCOUNT_TYPE_MAP[raw.accountType] || "unknown",
    loanType: raw.loanType || "unknown",
    ownership,
    isAU,
    status: STATUS_MAP[raw.accountStatusType] || "unknown",
    openedDate: raw.accountOpenedDate || null,
    closedDate: raw.accountClosedDate || null,
    reportedDate: raw.accountReportedDate || null,
    lastActivityDate: raw.lastActivityDate || null,
    creditLimit,
    highBalance,
    currentBalance,
    effectiveLimit,
    pastDue: parseAmount(raw.pastDueAmount),
    monthlyPayment: parseAmount(raw.monthlyPaymentAmount),
    chargeOffAmount: parseAmount(raw.chargeOffAmount),
    termsMonths: parseAmount(raw.termsMonthsCount),
    monthsReviewed: parseAmount(raw.monthsReviewedCount),
    latePayments: {
      _30: parseAmount(raw._30DayLates) ?? 0,
      _60: parseAmount(raw._60DayLates) ?? 0,
      _90: parseAmount(raw._90DayLates) ?? 0
    },
    currentRatingCode: raw.currentRatingCode || "-",
    currentRatingType: raw.currentRatingType || "NoDataAvailable",
    ratingSeverity: RATING_SEVERITY[raw.currentRatingType] ?? 0,
    isDerogatory: raw.derogatoryDataIndicator === true,
    paymentPattern: raw.paymentPatternData
      ? { data: raw.paymentPatternData, startDate: raw.paymentPatternStartDate || null }
      : null,
    adverseRatings,
    comments: (raw.comments || []).map(c => ({
      code: c.commentCode || null,
      source: c.commentSourceType || "unknown",
      type: c.commentType || "unknown",
      text: c.commentText || ""
    }))
  };
}

function normalizeInquiry(raw) {
  return {
    creditorName: orUnknown(raw.creditorName),
    date: raw.inquiryDate || null,
    businessType: raw.businessType || "unknown",
    subscriberCode: raw.subscriberCode || "unknown",
    source: normBureau(raw.sourceType)
  };
}

function normalizePublicRecord(raw) {
  return {
    type: raw.publicRecordType || "unknown",
    filedDate: raw.filedDate || null,
    dispositionDate: raw.dispositionDate || null,
    dispositionType: raw.dispositionType || null,
    docketId: raw.docketIdentifier || null,
    courtName: raw.courtName || null,
    amount: raw.legalObligationAmount !== "UNKNOWN" ? parseAmount(raw.legalObligationAmount) : null,
    bankruptcyType: raw.bankruptcyType || null,
    ownershipType: raw.accountOwnershipType || null,
    source: normBureau(raw.sourceType)
  };
}

function normalizeIdentity(creditFile) {
  const detail = creditFile.creditFileDetail || {};
  const source = normBureau(detail.sourceType);

  const names = (creditFile.aliases || []).map(a => ({
    first: a.firstName || "unknown",
    middle: a.middleName || null,
    last: a.lastName || "unknown",
    source
  }));

  const ssns = (creditFile.ssns || []).map(s => ({
    value: s.ssn || "unknown",
    source
  }));

  const dobs = (creditFile.dobs || []).map(d => ({
    value: d.dob || "unknown",
    source
  }));

  const addresses = (creditFile.addresses || []).map(a => ({
    line1: a.addressLine1 || "unknown",
    line2: a.addressLine2 || null,
    city: a.city || "unknown",
    state: a.state || "unknown",
    zip: (a.postalCode || "").replace(/-/g, "").substring(0, 5) || "unknown",
    zipFull: a.postalCode || "unknown",
    type: a.borrowerResidencyType || null,
    dateReported: a.dateReported || null,
    source
  }));

  const employers = (creditFile.employments || []).map(e => ({
    name: e.employerName || "unknown",
    position: e.employmentPositionDescription || null,
    status: e.employmentStatusType || null,
    startDate: e.employmentStartDate || null,
    reportedDate: e.employmentReportedDate || null,
    source
  }));

  return {
    names,
    ssns,
    dobs,
    addresses,
    employers,
    infileDate: detail.creditFileInfileDate || null,
    source
  };
}

function normalizeAlerts(raw) {
  return (raw || []).map(a => ({
    category: a.responseAlertMessageCategoryType || null,
    service: a.responseAlertMessageServiceType || null,
    text: a.responseAlertMessageText || "",
    source: normBureau(a.sourceType)
  }));
}

// Patterns that indicate a security freeze on a bureau file
const FREEZE_PATTERNS = [
  /security\s*freeze/i,
  /frozen\s*file/i,
  /file\s*frozen/i,
  /credit\s*freeze/i,
  /consumer\s*freeze/i
];

// Patterns that indicate a consumer fraud alert on file
const FRAUD_ALERT_PATTERNS = [
  /fraud\s*alert/i,
  /initial\s*fraud/i,
  /extended\s*fraud/i,
  /active\s*duty\s*alert/i,
  /military\s*alert/i
];

const FREEZE_CATEGORIES = new Set(["SecurityFreeze", "FrozenFile", "CreditFreeze"]);

const FRAUD_ALERT_CATEGORIES = new Set([
  "FraudAlert",
  "InitialFraudAlert",
  "ExtendedFraudAlert",
  "ActiveDutyAlert"
]);

/**
 * Scan normalized alerts + creditFile statuses for security freezes.
 * Returns { detected: boolean, bureaus: string[] }
 */
function detectSecurityFreezes(alerts, creditFiles) {
  const frozenBureaus = new Set();

  for (const alert of alerts || []) {
    const cat = alert.category || "";
    const text = alert.text || "";
    if (
      FREEZE_CATEGORIES.has(cat) ||
      FREEZE_PATTERNS.some(p => p.test(text)) ||
      FREEZE_PATTERNS.some(p => p.test(cat))
    ) {
      if (alert.source) frozenBureaus.add(alert.source);
      else frozenBureaus.add("unknown");
    }
  }

  // Also check creditFileDetail.creditFileResultStatusType
  for (const cf of creditFiles || []) {
    const status = cf?.creditFileDetail?.creditFileResultStatusType || "";
    if (/frozen|freeze/i.test(status)) {
      const source = normBureau(cf?.creditFileDetail?.sourceType);
      frozenBureaus.add(source || "unknown");
    }
  }

  return {
    detected: frozenBureaus.size > 0,
    bureaus: [...frozenBureaus]
  };
}

/**
 * Scan normalized alerts for consumer fraud alerts on file.
 * Returns { detected: boolean, bureaus: string[], types: string[] }
 */
function detectFraudAlerts(alerts) {
  const alertBureaus = new Set();
  const alertTypes = new Set();

  for (const alert of alerts || []) {
    const cat = alert.category || "";
    const text = alert.text || "";
    if (
      FRAUD_ALERT_CATEGORIES.has(cat) ||
      FRAUD_ALERT_PATTERNS.some(p => p.test(text)) ||
      FRAUD_ALERT_PATTERNS.some(p => p.test(cat))
    ) {
      if (alert.source) alertBureaus.add(alert.source);
      alertTypes.add(cat || "FraudAlert");
    }
  }

  return {
    detected: alertBureaus.size > 0,
    bureaus: [...alertBureaus],
    types: [...alertTypes]
  };
}

function normalizeFraudFinders(raw) {
  if (!raw || !raw.length) return null;

  const ff = raw[0];
  return {
    email: ff.eam
      ? {
          dateFirstSeen: ff.eam.date_first_seen || null,
          longevity: ff.eam.longevity ?? null,
          velocity: ff.eam.velocity ?? null,
          popularity: ff.eam.popularity ?? null
        }
      : null,
    domain: ff.dam
      ? {
          dateFirstSeen: ff.dam.date_first_seen || null,
          longevity: ff.dam.longevity ?? null,
          velocity: ff.dam.velocity ?? null,
          popularity: ff.dam.popularity ?? null
        }
      : null,
    risk: ff.risk
      ? {
          score: ff.risk.score ?? null,
          tumblingRisk: ff.risk.tumbling_risk ?? null,
          domainRiskScore: ff.risk.domain?.domain_risk_score ?? null,
          postalMatch: ff.risk.postal
            ? {
                firstName: ff.risk.postal.first_name_match || "no_data",
                lastName: ff.risk.postal.last_name_match || "no_data",
                street: ff.risk.postal.street_match || "no_data",
                city: ff.risk.postal.city_match || "no_data",
                zip: ff.risk.postal.zip_match || "no_data",
                addressType: ff.risk.postal.address_type || null,
                deliverability: ff.risk.postal.deliverability || null
              }
            : null
        }
      : null,
    emailValidation: ff.email_validation
      ? {
          address: ff.email_validation.address || null,
          status: ff.email_validation.status || null,
          statusCode: ff.email_validation.status_code ?? null,
          domainType: ff.email_validation.domain_type || null
        }
      : null
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * normalizeSoftPullPayload(rawResponses)
 *
 * @param {Array<Object>} rawResponses - Array of raw Stitch Credit CRS responses
 *   (one per bureau pull). Each must have the standard CRS top-level shape.
 *
 * @returns {Object} Canonical normalized payload for downstream engine modules.
 */
function normalizeSoftPullPayload(rawResponses) {
  if (!Array.isArray(rawResponses) || rawResponses.length === 0) {
    throw new Error("normalizeSoftPullPayload: expected non-empty array of CRS responses");
  }

  const identity = { names: [], ssns: [], dobs: [], addresses: [], employers: [] };
  const bureaus = {};
  const allTradelines = [];
  const allInquiries = [];
  const allPublicRecords = [];
  const allAlerts = [];
  const allCreditFiles = [];
  let fraudFinders = null;
  let requestDate = null;
  let requestingParty = null;

  for (const raw of rawResponses) {
    // Meta
    if (!requestDate && raw.responseDetail?.dateRequested) {
      requestDate = raw.responseDetail.dateRequested;
    }
    if (!requestingParty && raw.responseDetail?.requestingParty?.name) {
      requestingParty = raw.responseDetail.requestingParty.name;
    }

    // Determine which bureau this response is for
    const repoIncl = raw.repositoryIncluded || {};
    const bureauKey = repoIncl.transunion
      ? "transunion"
      : repoIncl.experian
        ? "experian"
        : repoIncl.equifax
          ? "equifax"
          : null;

    if (!bureauKey) continue;

    // Identity from creditFiles
    for (const cf of raw.creditFiles || []) {
      const id = normalizeIdentity(cf);
      identity.names.push(...id.names);
      identity.ssns.push(...id.ssns);
      identity.dobs.push(...id.dobs);
      identity.addresses.push(...id.addresses);
      identity.employers.push(...id.employers);

      // Bureau-level info
      if (!bureaus[bureauKey]) {
        bureaus[bureauKey] = { available: true, infileDate: id.infileDate };
      }
    }

    // Scores — filter to FICO only, deduplicate
    const ficoScores = (raw.scores || []).map(normalizeScore).filter(Boolean);
    // TU returns duplicate FICO scores — take first
    const primaryScore = ficoScores[0] || null;
    if (bureaus[bureauKey] && primaryScore) {
      bureaus[bureauKey].score = primaryScore.value;
      bureaus[bureauKey].scoreModel = primaryScore.model;
      bureaus[bureauKey].scoreModelCode = primaryScore.modelCode;
      bureaus[bureauKey].percentile = primaryScore.percentile;
      bureaus[bureauKey].min = primaryScore.min;
      bureaus[bureauKey].max = primaryScore.max;
      bureaus[bureauKey].factaInquiriesImpact = primaryScore.factaInquiriesImpact;
      bureaus[bureauKey].scoreFactors = primaryScore.factors;
    }

    // Report date from responseDetail
    if (bureaus[bureauKey] && raw.responseDetail?.dateRequested) {
      bureaus[bureauKey].reportDate = raw.responseDetail.dateRequested;
    }

    // Tradelines
    const tradelines = (raw.tradelines || []).map(normalizeTradeline);
    allTradelines.push(...tradelines);

    // Inquiries — dedupe EFX
    let inquiries = (raw.inquiries || []).map(normalizeInquiry);
    if (bureauKey === "equifax") {
      inquiries = dedupeInquiries(inquiries);
    }
    allInquiries.push(...inquiries);

    // Public records
    const publicRecords = (raw.publicRecords || []).map(normalizePublicRecord);
    allPublicRecords.push(...publicRecords);

    // Alerts
    allAlerts.push(...normalizeAlerts(raw.responseAlertMessages));

    // Collect raw creditFiles for freeze detection
    if (raw.creditFiles) allCreditFiles.push(...raw.creditFiles);

    // Fraud finders (TU only)
    if (bureauKey === "transunion" && raw.fraudFinders?.length) {
      fraudFinders = normalizeFraudFinders(raw.fraudFinders);
    }
  }

  // Ensure all 3 bureau slots exist
  for (const key of ["transunion", "experian", "equifax"]) {
    if (!bureaus[key]) {
      bureaus[key] = { available: false, score: null };
    }
  }

  const availableBureaus = Object.keys(bureaus).filter(k => bureaus[k].available);

  // Detect security freezes and consumer fraud alerts from alerts + creditFiles
  const securityFreezes = detectSecurityFreezes(allAlerts, allCreditFiles);
  const fraudAlertsOnFile = detectFraudAlerts(allAlerts);

  return {
    identity,
    bureaus,
    tradelines: allTradelines,
    inquiries: allInquiries,
    publicRecords: allPublicRecords,
    alerts: allAlerts,
    fraudFinders,
    securityFreezes,
    fraudAlertsOnFile,
    meta: {
      requestDate: requestDate || "unknown",
      requestingParty: requestingParty || "unknown",
      bureauCount: availableBureaus.length,
      availableBureaus
    }
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  normalizeSoftPullPayload,
  // Exported for testing
  detectSecurityFreezes,
  detectFraudAlerts,
  parseAmount,
  normalizeScore,
  normalizeTradeline,
  normalizeInquiry,
  normalizePublicRecord,
  normalizeIdentity,
  dedupeInquiries,
  FICO_MODEL_NAMES,
  OWNERSHIP_MAP,
  RATING_SEVERITY
};
