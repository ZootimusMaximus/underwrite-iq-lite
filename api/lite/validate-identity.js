// ============================================================================
// validate-identity.js (Stage 3b — Post-Parse Identity Validation)
// ----------------------------------------------------------------------------
// Validates that:
//   1. Client's submitted name matches a name on the credit report
//   2. Report date is within 30 days (when available)
//
// Returns clear error messages for the website to display.
// ============================================================================

const { logWarn } = require("./logger");

// Max age of report in days
const MAX_REPORT_AGE_DAYS = 30;

// ----------------------------------------------------------------------------
// Normalize name for comparison (lowercase, remove special chars, trim)
// ----------------------------------------------------------------------------
function normalizeName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, "") // Remove non-letters
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();
}

// ----------------------------------------------------------------------------
// Extract first and last name parts
// ----------------------------------------------------------------------------
function extractNameParts(fullName) {
  const normalized = normalizeName(fullName);
  const parts = normalized.split(" ").filter(Boolean);

  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };

  return {
    first: parts[0],
    last: parts[parts.length - 1]
  };
}

// ----------------------------------------------------------------------------
// Check if two names match (fuzzy matching)
// Requires first name match AND last name match
// ----------------------------------------------------------------------------
function namesMatch(submittedName, reportName) {
  const submitted = extractNameParts(submittedName);
  const report = extractNameParts(reportName);

  // Both must have at least first name
  if (!submitted.first || !report.first) return false;

  // First name must match (or be initial match like "J" matches "JOHN")
  const firstMatch =
    submitted.first === report.first ||
    (submitted.first.charAt(0) === report.first.charAt(0) && submitted.first.length === 1) ||
    (report.first.charAt(0) === submitted.first.charAt(0) && report.first.length === 1);

  if (!firstMatch) return false;

  // If both have last names, they must match
  if (submitted.last && report.last) {
    return submitted.last === report.last;
  }

  // If only one has last name, still allow match (partial name submission)
  return true;
}

// ----------------------------------------------------------------------------
// Collect all names from merged bureaus
// ----------------------------------------------------------------------------
function collectReportNames(bureaus) {
  const allNames = new Set();

  for (const [, bureauData] of Object.entries(bureaus || {})) {
    if (bureauData && Array.isArray(bureauData.names)) {
      bureauData.names.forEach(name => {
        if (name) allNames.add(name);
      });
    }
  }

  return Array.from(allNames);
}

// ----------------------------------------------------------------------------
// Validate client name matches report
// ----------------------------------------------------------------------------
function validateNameMatch(submittedName, bureaus) {
  if (!submittedName) {
    return { ok: false, reason: "No name provided." };
  }

  const reportNames = collectReportNames(bureaus);

  if (reportNames.length === 0) {
    // No names extracted from report - can't validate, allow through with warning
    logWarn("No names found in credit report for validation", { submittedName });
    return { ok: true, warning: "Could not verify name - no names found in report" };
  }

  // Check if submitted name matches any name on the report
  for (const reportName of reportNames) {
    if (namesMatch(submittedName, reportName)) {
      return { ok: true, matchedName: reportName };
    }
  }

  // No match found
  return {
    ok: false,
    reason: `The name "${submittedName}" does not match any name on this credit report. Please upload a report that belongs to you.`,
    reportNames
  };
}

// ----------------------------------------------------------------------------
// Parse date from various formats
// ----------------------------------------------------------------------------
function parseReportDate(dateStr) {
  if (!dateStr) return null;

  // Try ISO format (YYYY-MM-DD)
  const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return new Date(parseInt(isoMatch[1]), parseInt(isoMatch[2]) - 1, parseInt(isoMatch[3]));
  }

  // Try MM/DD/YYYY format
  const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) {
    return new Date(parseInt(usMatch[3]), parseInt(usMatch[1]) - 1, parseInt(usMatch[2]));
  }

  // Try natural language date
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  return null;
}

// ----------------------------------------------------------------------------
// Get most recent report date from bureaus
// ----------------------------------------------------------------------------
function getMostRecentReportDate(bureaus) {
  let mostRecent = null;

  for (const [, bureauData] of Object.entries(bureaus || {})) {
    if (bureauData && bureauData.reportDate) {
      const date = parseReportDate(bureauData.reportDate);
      if (date && (!mostRecent || date > mostRecent)) {
        mostRecent = date;
      }
    }
  }

  return mostRecent;
}

// ----------------------------------------------------------------------------
// Validate report is within 30 days
// ----------------------------------------------------------------------------
function validateReportRecency(bureaus) {
  const reportDate = getMostRecentReportDate(bureaus);

  if (!reportDate) {
    // No date found - can't validate, allow through with warning
    logWarn("No report date found for recency validation");
    return { ok: true, warning: "Could not verify report date" };
  }

  const now = new Date();
  const ageMs = now.getTime() - reportDate.getTime();
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  if (ageDays > MAX_REPORT_AGE_DAYS) {
    return {
      ok: false,
      reason: `This credit report is ${ageDays} days old. Please upload a report from the last 30 days.`,
      reportDate: reportDate.toISOString().slice(0, 10),
      ageDays
    };
  }

  return { ok: true, reportDate: reportDate.toISOString().slice(0, 10), ageDays };
}

// ----------------------------------------------------------------------------
// Main validation function
// ----------------------------------------------------------------------------
function validateIdentity(submittedName, bureaus, options = {}) {
  const results = {
    nameMatch: null,
    reportRecency: null,
    ok: true,
    errors: []
  };

  // Validate name match
  if (options.skipNameMatch !== true) {
    results.nameMatch = validateNameMatch(submittedName, bureaus);
    if (!results.nameMatch.ok) {
      results.ok = false;
      results.errors.push(results.nameMatch.reason);
    }
  }

  // Validate report recency
  if (options.skipRecencyCheck !== true) {
    results.reportRecency = validateReportRecency(bureaus);
    if (!results.reportRecency.ok) {
      results.ok = false;
      results.errors.push(results.reportRecency.reason);
    }
  }

  // Combine error messages
  if (!results.ok) {
    results.reason = results.errors.join(" ");
  }

  return results;
}

module.exports = {
  validateIdentity,
  validateNameMatch,
  validateReportRecency,
  normalizeName,
  namesMatch,
  collectReportNames,
  MAX_REPORT_AGE_DAYS
};
