"use strict";

/**
 * identity-fraud-gate.js — Stage 02: Identity & Fraud Gate
 *
 * Validates identity consistency and checks for fraud signals
 * from the normalized CRS payload. Returns pass/fail with
 * outcome routing for FRAUD_HOLD or MANUAL_REVIEW.
 */

const MAX_REPORT_AGE_DAYS = 30;
const FRAUD_RISK_THRESHOLD = 50;

// ---------------------------------------------------------------------------
// Name Matching (adapted from validate-identity.js for CRS shapes)
// ---------------------------------------------------------------------------

function normalizeName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNameParts(fullName) {
  const normalized = normalizeName(fullName);
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts[parts.length - 1] };
}

function firstNameMatches(a, b) {
  if (!a || !b) return false;
  return (
    a === b ||
    (a.length === 1 && a.charAt(0) === b.charAt(0)) ||
    (b.length === 1 && b.charAt(0) === a.charAt(0))
  );
}

/**
 * Check if submitted name matches a CRS identity name object.
 * CRS names are { first, middle, last, source }.
 */
function nameMatchesCRS(submittedName, crsName) {
  const submitted = extractNameParts(submittedName);
  const report = { first: normalizeName(crsName.first), last: normalizeName(crsName.last) };

  if (!submitted.first || !report.first) return false;
  if (!firstNameMatches(submitted.first, report.first)) return false;
  if (submitted.last && report.last) return submitted.last === report.last;
  return true;
}

// ---------------------------------------------------------------------------
// Individual Checks
// ---------------------------------------------------------------------------

function checkNameMatch(submittedName, identityNames) {
  if (!submittedName) return { ok: false, reason: "NAME_NOT_PROVIDED" };
  if (!identityNames.length) return { ok: true, warning: "NO_NAMES_ON_FILE" };

  for (const name of identityNames) {
    if (nameMatchesCRS(submittedName, name)) {
      return { ok: true, matchedName: `${name.first} ${name.last}` };
    }
  }

  return { ok: false, reason: "NAME_MISMATCH" };
}

function checkReportFreshness(bureaus, referenceDate) {
  const now = referenceDate || new Date();
  const results = [];
  let anyFresh = false;

  for (const [key, data] of Object.entries(bureaus)) {
    if (!data.available || !data.reportDate) continue;
    const reportDate = new Date(data.reportDate);
    if (isNaN(reportDate.getTime())) continue;
    const ageDays = Math.floor((now - reportDate) / (1000 * 60 * 60 * 24));
    results.push({ bureau: key, ageDays, fresh: ageDays <= MAX_REPORT_AGE_DAYS });
    if (ageDays <= MAX_REPORT_AGE_DAYS) anyFresh = true;
  }

  if (results.length === 0) return { ok: true, warning: "NO_REPORT_DATES" };
  if (!anyFresh) return { ok: false, reason: "ALL_REPORTS_STALE", details: results };
  return { ok: true, details: results };
}

function checkAddressConflicts(addresses) {
  // Group by source, compare primary (first) address across bureaus
  const bySource = {};
  for (const addr of addresses) {
    if (!bySource[addr.source]) bySource[addr.source] = [];
    bySource[addr.source].push(addr);
  }

  const primaryAddresses = [];
  for (const [source, addrs] of Object.entries(bySource)) {
    if (addrs.length) {
      primaryAddresses.push({ source, line1: addrs[0].line1, zip: addrs[0].zip });
    }
  }

  if (primaryAddresses.length < 2) return { ok: true };

  const conflicts = [];
  for (let i = 0; i < primaryAddresses.length; i++) {
    for (let j = i + 1; j < primaryAddresses.length; j++) {
      const a = primaryAddresses[i];
      const b = primaryAddresses[j];
      if (a.zip !== "unknown" && b.zip !== "unknown" && a.zip !== b.zip) {
        conflicts.push({ bureauA: a.source, bureauB: b.source, zipA: a.zip, zipB: b.zip });
      }
    }
  }

  if (conflicts.length) return { ok: false, reason: "ADDRESS_CONFLICT", conflicts };
  return { ok: true };
}

function checkFraudSignals(fraudFinders) {
  if (!fraudFinders) return { ok: true, available: false, flags: [] };

  const flags = [];

  if (fraudFinders.risk) {
    if (fraudFinders.risk.score != null && fraudFinders.risk.score > FRAUD_RISK_THRESHOLD) {
      flags.push("HIGH_FRAUD_RISK_SCORE");
    }
    if (fraudFinders.risk.tumblingRisk != null && fraudFinders.risk.tumblingRisk > 0) {
      flags.push("TUMBLING_RISK");
    }
    if (fraudFinders.risk.postalMatch) {
      const pm = fraudFinders.risk.postalMatch;
      if (pm.lastName === "no_match") flags.push("POSTAL_LASTNAME_MISMATCH");
      if (pm.street === "no_match") flags.push("POSTAL_STREET_MISMATCH");
      if (pm.zip === "no_match") flags.push("POSTAL_ZIP_MISMATCH");
    }
  }

  if (fraudFinders.emailValidation) {
    if (fraudFinders.emailValidation.status && fraudFinders.emailValidation.status !== "valid") {
      flags.push("EMAIL_INVALID");
    }
  }

  return { ok: flags.length === 0, available: true, flags };
}

function checkSecurityFreezes(securityFreezes) {
  if (!securityFreezes || !securityFreezes.detected) return { ok: true, detected: false };
  return {
    ok: false,
    detected: true,
    bureaus: securityFreezes.bureaus,
    reason: "SECURITY_FREEZE_DETECTED"
  };
}

function checkConsumerFraudAlerts(fraudAlertsOnFile) {
  if (!fraudAlertsOnFile || !fraudAlertsOnFile.detected) return { ok: true, detected: false };
  return {
    ok: false,
    detected: true,
    bureaus: fraudAlertsOnFile.bureaus,
    types: fraudAlertsOnFile.types,
    reason: "CONSUMER_FRAUD_ALERT_ON_FILE"
  };
}

function checkFileIntegrity(bureaus) {
  const available = Object.values(bureaus).filter(b => b.available);
  if (available.length === 0) return { ok: false, reason: "NO_BUREAUS_AVAILABLE" };

  const hasAnyScore = available.some(b => b.score != null);
  if (!hasAnyScore) return { ok: false, reason: "NO_SCORES_RETURNED" };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * runIdentityAndFraudGate(normalized, submittedName, submittedAddress)
 *
 * @param {Object} normalized - Output of normalizeSoftPullPayload (Module 1)
 * @param {string} submittedName - Name from the application form
 * @param {string} [submittedAddress] - Address from the form (optional)
 * @returns {{ passed, outcome, reasons[], confidence }}
 */
function runIdentityAndFraudGate(normalized, submittedName, _submittedAddress) {
  const { identity, bureaus, fraudFinders, securityFreezes, fraudAlertsOnFile } = normalized;
  const reasons = [];
  let fraudSignalCount = 0;
  let warningCount = 0;

  // 1. Name match
  const nameResult = checkNameMatch(submittedName, identity.names);
  if (!nameResult.ok) reasons.push(nameResult.reason);
  if (nameResult.warning) warningCount++;

  // 2. Report freshness
  const freshnessResult = checkReportFreshness(bureaus);
  if (!freshnessResult.ok) reasons.push(freshnessResult.reason);
  if (freshnessResult.warning) warningCount++;

  // 3. Address conflicts (cross-bureau)
  const addressResult = checkAddressConflicts(identity.addresses);
  if (!addressResult.ok) {
    reasons.push(addressResult.reason);
    warningCount++;
  }

  // 4. Fraud signals (TU fraudFinders)
  const fraudResult = checkFraudSignals(fraudFinders);
  if (!fraudResult.ok) {
    reasons.push(...fraudResult.flags);
    fraudSignalCount = fraudResult.flags.length;
  }

  // 5. File integrity
  const integrityResult = checkFileIntegrity(bureaus);
  if (!integrityResult.ok) reasons.push(integrityResult.reason);

  // 6. Security freezes
  const freezeResult = checkSecurityFreezes(securityFreezes);
  if (!freezeResult.ok) {
    reasons.push(freezeResult.reason);
  }

  // 7. Consumer fraud alerts on file (distinct from fraudFinders risk scoring)
  const fraudAlertResult = checkConsumerFraudAlerts(fraudAlertsOnFile);
  if (!fraudAlertResult.ok) {
    reasons.push(fraudAlertResult.reason);
  }

  // ── Decision ────────────────────────────────────────────────────────

  // Security freeze → MANUAL_REVIEW (cannot pull full report, hard blocker)
  if (freezeResult.detected) {
    return {
      passed: false,
      outcome: "MANUAL_REVIEW",
      reasons,
      confidence: "high",
      securityFreeze: { detected: true, bureaus: freezeResult.bureaus }
    };
  }

  // Consumer fraud alert on file → MANUAL_REVIEW (hard blocker for funding)
  if (fraudAlertResult.detected) {
    return {
      passed: false,
      outcome: "MANUAL_REVIEW",
      reasons,
      confidence: "high",
      fraudAlertOnFile: {
        detected: true,
        bureaus: fraudAlertResult.bureaus,
        types: fraudAlertResult.types
      }
    };
  }

  // Strong fraud signals → FRAUD_HOLD
  const hasHighRisk = (fraudResult.flags || []).includes("HIGH_FRAUD_RISK_SCORE");
  const hasTumbling = (fraudResult.flags || []).includes("TUMBLING_RISK");
  const isFraudHold = fraudSignalCount >= 2 || (hasHighRisk && hasTumbling);

  if (isFraudHold) {
    return { passed: false, outcome: "FRAUD_HOLD", reasons, confidence: "high" };
  }

  // No bureaus or no scores → MANUAL_REVIEW
  if (reasons.includes("NO_BUREAUS_AVAILABLE") || reasons.includes("NO_SCORES_RETURNED")) {
    return { passed: false, outcome: "MANUAL_REVIEW", reasons, confidence: "high" };
  }

  // All reports stale → MANUAL_REVIEW
  if (reasons.includes("ALL_REPORTS_STALE")) {
    return { passed: false, outcome: "MANUAL_REVIEW", reasons, confidence: "medium" };
  }

  // Name mismatch without fraud signals → MANUAL_REVIEW (could be typo)
  if (reasons.includes("NAME_MISMATCH")) {
    return { passed: false, outcome: "MANUAL_REVIEW", reasons, confidence: "medium" };
  }

  // Single fraud flag or address conflict → pass with reduced confidence
  if (fraudSignalCount === 1 || reasons.includes("ADDRESS_CONFLICT")) {
    const confidence = warningCount > 1 ? "low" : "medium";
    return { passed: true, outcome: null, reasons, confidence };
  }

  // Clean
  const confidence = warningCount > 0 ? "medium" : "high";
  return { passed: true, outcome: null, reasons, confidence };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runIdentityAndFraudGate,
  // Exported for testing
  normalizeName,
  extractNameParts,
  nameMatchesCRS,
  checkNameMatch,
  checkReportFreshness,
  checkAddressConflicts,
  checkFraudSignals,
  checkSecurityFreezes,
  checkConsumerFraudAlerts,
  checkFileIntegrity,
  MAX_REPORT_AGE_DAYS,
  FRAUD_RISK_THRESHOLD
};
