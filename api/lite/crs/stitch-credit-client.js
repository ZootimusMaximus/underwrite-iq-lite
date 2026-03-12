"use strict";

/**
 * stitch-credit-client.js — Stitch Credit CRS API Client
 *
 * Handles authentication and soft-pull requests to Stitch Credit's
 * sandbox/production API. Pulls consumer reports (TU, EXP, EFX) and
 * optional business reports, returning raw responses for the CRS engine.
 */

const { fetchWithTimeout } = require("../fetch-utils");
const { logInfo, logWarn, logError } = require("../logger");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_BASE = process.env.STITCH_CREDIT_API_BASE || "https://api-sandbox.stitchcredit.com";
const API_USERNAME = process.env.STITCH_CREDIT_USERNAME || process.env.STITCH_CREDIT_EMAIL;
const API_PASSWORD = process.env.STITCH_CREDIT_PASSWORD;
const TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Consumer Soft-Pull Endpoints
// ---------------------------------------------------------------------------

const BUREAU_ENDPOINTS = {
  transunion: "/api/transunion/credit-report/standard/tu-prequal-fico9",
  experian: "/api/experian/credit-profile/credit-report/standard/exp-prequal-fico9",
  equifax: "/api/equifax/credit-report/standard/efx-prequal-fico9"
};

// ---------------------------------------------------------------------------
// Business Credit Endpoints
// ---------------------------------------------------------------------------

const BUSINESS_ENDPOINTS = {
  search: "/api/ccc/exp/search",
  report: "/api/ccc/exp/report"
};

// ---------------------------------------------------------------------------
// Token Cache (in-memory, 50-minute refresh)
// ---------------------------------------------------------------------------

let cachedToken = null;
let tokenExpiry = 0;
const TOKEN_BUFFER_MS = 10 * 60 * 1000; // Refresh 10 min before expiry

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/**
 * authenticate() — Login and get JWT bearer token.
 * @returns {Promise<string>} Bearer token
 */
async function authenticate() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  if (!API_USERNAME || !API_PASSWORD) {
    throw new Error(
      "STITCH_CREDIT_USERNAME (or STITCH_CREDIT_EMAIL) and STITCH_CREDIT_PASSWORD are required"
    );
  }

  const resp = await fetchWithTimeout(
    `${API_BASE}/api/users/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: API_USERNAME, password: API_PASSWORD })
    },
    TIMEOUT_MS
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Stitch Credit auth failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const token = data.token || data.accessToken || data.jwt;

  if (!token) {
    throw new Error("Stitch Credit auth: no token in response");
  }

  cachedToken = token;
  // JWT tokens expire in 1 hour, refresh at 50 minutes
  tokenExpiry = now + 60 * 60 * 1000 - TOKEN_BUFFER_MS;

  logInfo("Stitch Credit authenticated", { expiresIn: "50m" });
  return token;
}

// ---------------------------------------------------------------------------
// Consumer Soft Pull
// ---------------------------------------------------------------------------

/**
 * buildConsumerPayload(applicant) — Build the request body for consumer pulls.
 *
 * @param {Object} applicant
 * @param {string} applicant.firstName
 * @param {string} applicant.lastName
 * @param {string} [applicant.middleName]
 * @param {string} [applicant.suffix]
 * @param {string} applicant.ssn - 9 digits, no dashes
 * @param {string} applicant.birthDate - YYYY-MM-DD
 * @param {Object} applicant.address
 * @param {string} applicant.address.addressLine1
 * @param {string} [applicant.address.addressLine2]
 * @param {string} applicant.address.city
 * @param {string} applicant.address.state - 2-letter
 * @param {string} applicant.address.postalCode - 5 digits
 * @returns {Object}
 */
function buildConsumerPayload(applicant) {
  return {
    firstName: applicant.firstName,
    middleName: applicant.middleName || "",
    lastName: applicant.lastName,
    suffix: applicant.suffix || "",
    birthDate: applicant.birthDate,
    ssn: applicant.ssn,
    addresses: [
      {
        borrowerResidencyType: "Current",
        addressLine1: applicant.address.addressLine1,
        addressLine2: applicant.address.addressLine2 || "",
        city: applicant.address.city,
        state: applicant.address.state,
        postalCode: applicant.address.postalCode
      }
    ]
  };
}

/**
 * pullConsumerBureau(bureau, applicant) — Pull a single bureau soft report.
 *
 * @param {'transunion'|'experian'|'equifax'} bureau
 * @param {Object} applicant
 * @returns {Promise<Object>} Raw CRS response
 */
async function pullConsumerBureau(bureau, applicant) {
  const endpoint = BUREAU_ENDPOINTS[bureau];
  if (!endpoint) throw new Error(`Unknown bureau: ${bureau}`);

  const token = await authenticate();
  const payload = buildConsumerPayload(applicant);

  // TU also accepts email
  if (bureau === "transunion" && applicant.email) {
    payload.email = applicant.email;
  }

  logInfo("Pulling consumer bureau", { bureau });

  const resp = await fetchWithTimeout(
    `${API_BASE}${endpoint}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    },
    TIMEOUT_MS
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logError("Consumer bureau pull failed", null, {
      bureau,
      status: resp.status,
      body: text.substring(0, 200)
    });
    throw new Error(`Bureau pull failed (${bureau}): ${resp.status}`);
  }

  const data = await resp.json();
  logInfo("Consumer bureau pull success", { bureau, hasTradelines: !!data.tradelines });
  return data;
}

/**
 * pullAllConsumerBureaus(applicant, bureaus) — Pull 1-3 bureaus in parallel.
 *
 * @param {Object} applicant
 * @param {string[]} [bureaus=['transunion','experian','equifax']]
 * @returns {Promise<{ responses: Object[], errors: Object[] }>}
 */
async function pullAllConsumerBureaus(applicant, bureaus) {
  const targetBureaus = bureaus || ["transunion", "experian", "equifax"];
  const results = await Promise.allSettled(
    targetBureaus.map(bureau => pullConsumerBureau(bureau, applicant))
  );

  const responses = [];
  const errors = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      responses.push(result.value);
    } else {
      errors.push({ bureau: targetBureaus[i], error: result.reason?.message || "Unknown error" });
      logWarn("Bureau pull failed", { bureau: targetBureaus[i], error: result.reason?.message });
    }
  });

  return { responses, errors };
}

// ---------------------------------------------------------------------------
// Business Credit
// ---------------------------------------------------------------------------

/**
 * searchBusiness(businessName, state) — Search for a business.
 *
 * @param {string} businessName
 * @param {string} state - 2-letter state code
 * @returns {Promise<Object>} Search results
 */
async function searchBusiness(businessName, state) {
  const token = await authenticate();

  const resp = await fetchWithTimeout(
    `${API_BASE}${BUSINESS_ENDPOINTS.search}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ name: businessName, state })
    },
    TIMEOUT_MS
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Business search failed: ${resp.status} ${text.substring(0, 200)}`);
  }

  return resp.json();
}

/**
 * pullBusinessReport(bin) — Pull Experian Business Premier Profile by BIN.
 *
 * @param {string} bin - Business Identification Number from search
 * @returns {Promise<Object>} Raw business report
 */
async function pullBusinessReport(bin) {
  const token = await authenticate();

  logInfo("Pulling business report", { bin });

  const resp = await fetchWithTimeout(
    `${API_BASE}${BUSINESS_ENDPOINTS.report}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ bin })
    },
    TIMEOUT_MS
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    logError("Business report pull failed", null, {
      bin,
      status: resp.status,
      body: text.substring(0, 200)
    });
    throw new Error(`Business report failed: ${resp.status}`);
  }

  const data = await resp.json();
  logInfo("Business report pull success", { bin });
  return data;
}

// ---------------------------------------------------------------------------
// Full CRS Pull (consumer + optional business)
// ---------------------------------------------------------------------------

/**
 * pullFullCRS(applicant, businessInfo) — Pull all consumer bureaus + optional business.
 *
 * @param {Object} applicant - Consumer identity info
 * @param {Object} [businessInfo] - { name, state, bin }
 * @returns {Promise<{ rawResponses: Object[], businessReport: Object|null, errors: Object[] }>}
 */
async function pullFullCRS(applicant, businessInfo) {
  // Consumer pulls (parallel)
  const { responses, errors } = await pullAllConsumerBureaus(applicant);

  if (responses.length === 0) {
    throw new Error(
      `All bureau pulls failed: ${errors.map(e => `${e.bureau}: ${e.error}`).join("; ")}`
    );
  }

  // Business pull (optional)
  let businessReport = null;
  if (businessInfo?.bin) {
    try {
      businessReport = await pullBusinessReport(businessInfo.bin);
    } catch (err) {
      errors.push({ bureau: "business", error: err.message });
      logWarn("Business report pull failed, continuing without", { error: err.message });
    }
  } else if (businessInfo?.name && businessInfo?.state) {
    // Search first, then pull
    try {
      const searchResult = await searchBusiness(businessInfo.name, businessInfo.state);
      const bin = searchResult?.results?.[0]?.bin || searchResult?.bin;
      if (bin) {
        businessReport = await pullBusinessReport(bin);
      } else {
        logInfo("No business BIN found from search", { name: businessInfo.name });
      }
    } catch (err) {
      errors.push({ bureau: "business", error: err.message });
      logWarn("Business search/report failed, continuing without", { error: err.message });
    }
  }

  return { rawResponses: responses, businessReport, errors };
}

// ---------------------------------------------------------------------------
// Invalidate Token (for testing / force refresh)
// ---------------------------------------------------------------------------

function invalidateToken() {
  cachedToken = null;
  tokenExpiry = 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  authenticate,
  buildConsumerPayload,
  pullConsumerBureau,
  pullAllConsumerBureaus,
  searchBusiness,
  pullBusinessReport,
  pullFullCRS,
  invalidateToken,
  // For testing
  BUREAU_ENDPOINTS,
  BUSINESS_ENDPOINTS
};
