/* eslint-disable -- Airtable automation script, not Node.js. Uses Airtable globals (input, output, base) and top-level await. Copy-paste into Airtable UI. */
// =============================================================================
// AX06 — Pull CRS Now (Manual Button) — Airtable Automation Script
//
// PURPOSE: Replace the current "map-only" AX06 script that just logs a payload
//          and does nothing. This script actually triggers a CRS pull by POSTing
//          to the UnderwriteIQ Lite API.
//
// WHERE:   Paste this into Airtable → FUNDHUB MATRIX → Automations →
//          "AX06 — Pull CRS Now (Button)" → SCRIPT step (replacing existing).
//
// TRIGGER: When CLIENTS.run_pull_crs_now = checked
//
// FLOW:
//   1. Read CLIENTS record (get linked PII_IDENTITY + email)
//   2. Read PII_IDENTITY record (get SSN, DOB, name, address)
//   3. Set refresh_in_progress = true on CLIENTS
//   4. POST to /api/lite/crs-pull-and-analyze
//   5. Output status for the next automation step (uncheck run_pull_crs_now)
//
// INPUTS (configure in Airtable automation "Input variables"):
//   - client_record_id  = (Trigger) Airtable record ID
//
// SECRETS (configure in Airtable automation "Secrets"):
//   - underwriteiq_base_url  (e.g. "https://underwrite-iq-lite.vercel.app")
//
// AUTOMATION STEPS (after this script):
//   - SET: run_pull_crs_now = unchecked
//   - SET: refresh_in_progress = false  (only if script output.success = false)
//
// ENDPOINT CONTRACT: POST /api/lite/crs-pull-and-analyze
//   Required body:
//     applicant.firstName     (string)
//     applicant.lastName      (string)
//     applicant.ssn           (string, 9 digits)
//     applicant.birthDate     (string, YYYY-MM-DD)
//     applicant.address.addressLine1 (string)
//     applicant.address.city  (string)
//     applicant.address.state (string, 2-letter)
//     applicant.address.postalCode (string)
//   Optional body:
//     crs_pull_scope          ("consumer_only" | "consumer_plus_ex_business")
//     business.name           (required if scope is consumer_plus_ex_business)
//     business.city           (required if scope is consumer_plus_ex_business)
//     business.state          (required if scope is consumer_plus_ex_business)
//     formData.email          (for GHL sync + dedup)
//     formData.phone          (for GHL sync)
//     formData.airtableRecordId (for Airtable sync back)
//
// =============================================================================

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const cfg = input.config();
const clientId = cfg.client_record_id;

// Base URL from secret (no trailing slash)
const BASE_URL = input.secret("underwriteiq_base_url") || "https://underwrite-iq-lite.vercel.app";
const API_ENDPOINT = `${BASE_URL}/api/lite/crs-pull-and-analyze`;

// Table references
const CLIENTS_TABLE = "CLIENTS";
const PII_TABLE = "PII_IDENTITY";

// ---------------------------------------------------------------------------
// Step 1: Load CLIENTS record
// ---------------------------------------------------------------------------
const clientsTbl = base.getTable(CLIENTS_TABLE);
const clientRec = await clientsTbl.selectRecordAsync(clientId, {
  fields: [
    "Client Name",
    "email",
    "phone",
    "ghl_contact_id",
    "identity", // linked PII_IDENTITY record
    "crs_pull_scope" // optional: "consumer_only" or "consumer_plus_ex_business"
  ]
});

if (!clientRec) {
  output.set("success", false);
  output.set("error", `Client record ${clientId} not found`);
  throw new Error(`Client record ${clientId} not found`);
}

const email = clientRec.getCellValueAsString("email") || null;
const phone = clientRec.getCellValueAsString("phone") || null;
const ghlContactId = clientRec.getCellValueAsString("ghl_contact_id") || null;

// Get crs_pull_scope — defaults to "consumer_only" if not set
let crsPullScope = "consumer_only";
const scopeRaw = clientRec.getCellValueAsString("crs_pull_scope");
if (scopeRaw === "consumer_plus_ex_business") {
  crsPullScope = "consumer_plus_ex_business";
}

// ---------------------------------------------------------------------------
// Step 2: Load linked PII_IDENTITY record
// ---------------------------------------------------------------------------
const identityLinks = clientRec.getCellValue("identity");
if (!identityLinks || identityLinks.length === 0) {
  output.set("success", false);
  output.set("error", "No PII_IDENTITY record linked to this client");
  throw new Error("No PII_IDENTITY record linked — cannot pull CRS without identity data");
}

const piiTbl = base.getTable(PII_TABLE);
const piiRec = await piiTbl.selectRecordAsync(identityLinks[0].id, {
  fields: [
    "owner_first_name",
    "owner_last_name",
    "ssn_full",
    "dob",
    "street1",
    "city",
    "state",
    "zip",
    "phone"
  ]
});

if (!piiRec) {
  output.set("success", false);
  output.set("error", "PII_IDENTITY record not found");
  throw new Error("PII_IDENTITY record exists in link but cannot be loaded");
}

// Extract PII fields
const firstName = piiRec.getCellValueAsString("owner_first_name") || "";
const lastName = piiRec.getCellValueAsString("owner_last_name") || "";
const ssnFull = piiRec.getCellValueAsString("ssn_full") || "";
const street1 = piiRec.getCellValueAsString("street1") || "";
const piiCity = piiRec.getCellValueAsString("city") || "";
const piiState = piiRec.getCellValueAsString("state") || "";
const piiZip = piiRec.getCellValueAsString("zip") || "";
const piiPhone = piiRec.getCellValueAsString("phone") || phone || "";

// DOB: Airtable date fields return ISO string or null
const dobRaw = piiRec.getCellValue("dob");
let birthDate = "";
if (dobRaw) {
  // Airtable returns "YYYY-MM-DD" for date fields
  birthDate = typeof dobRaw === "string" ? dobRaw : dobRaw.toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Step 3: Validate required fields
// ---------------------------------------------------------------------------
const missing = [];
if (!firstName) missing.push("owner_first_name");
if (!lastName) missing.push("owner_last_name");
if (!ssnFull || ssnFull.replace(/\D/g, "").length !== 9) missing.push("ssn_full (9 digits)");
if (!birthDate) missing.push("dob");
if (!street1) missing.push("street1");
if (!piiCity) missing.push("city");
if (!piiState) missing.push("state");
if (!piiZip) missing.push("zip");

if (missing.length > 0) {
  const msg = `Missing required PII fields: ${missing.join(", ")}`;
  output.set("success", false);
  output.set("error", msg);
  throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Step 4: Set refresh_in_progress = true
// ---------------------------------------------------------------------------
await clientsTbl.updateRecordAsync(clientId, {
  refresh_in_progress: true
});

// ---------------------------------------------------------------------------
// Step 5: Build payload and POST to CRS pull endpoint
// ---------------------------------------------------------------------------
const payload = {
  applicant: {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    ssn: ssnFull.replace(/\D/g, ""),
    birthDate: birthDate,
    address: {
      addressLine1: street1.trim(),
      city: piiCity.trim(),
      state: piiState.trim().toUpperCase(),
      postalCode: piiZip.trim()
    }
  },
  crs_pull_scope: crsPullScope,
  formData: {
    email: email,
    phone: piiPhone || phone,
    airtableRecordId: clientId,
    forceReprocess: true // Manual button should always pull fresh
  }
};

console.log(`AX06: Sending CRS pull request for ${firstName} ${lastName}`);
console.log(`AX06: Endpoint: ${API_ENDPOINT}`);
console.log(`AX06: Scope: ${crsPullScope}`);

let response;
try {
  response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
} catch (fetchErr) {
  // Network error — API unreachable
  await clientsTbl.updateRecordAsync(clientId, { refresh_in_progress: false });
  output.set("success", false);
  output.set("error", `Network error: ${fetchErr.message}`);
  throw new Error(`CRS API unreachable: ${fetchErr.message}`);
}

const result = await response.json();

if (!response.ok || !result.ok) {
  // API returned an error — clear refresh lock
  await clientsTbl.updateRecordAsync(clientId, { refresh_in_progress: false });
  const errMsg = result.error || result.message || `HTTP ${response.status}`;
  console.log(`AX06: CRS pull failed — ${errMsg}`);
  output.set("success", false);
  output.set("error", errMsg);
  throw new Error(`CRS pull failed: ${errMsg}`);
}

// ---------------------------------------------------------------------------
// Step 6: Success — log result summary
// ---------------------------------------------------------------------------
// Note: refresh_in_progress is cleared by the API's Airtable sync (background queue)
// via syncCRSResultToAirtable() which sets refresh_in_progress = false.
// If that fails for any reason, a safety net should clear it after a timeout.

console.log(`AX06: CRS pull succeeded`);
console.log(`AX06: Outcome: ${result.outcome}`);
console.log(`AX06: Decision: ${result.decision_label}`);
if (result.preapprovals) {
  console.log(`AX06: Total combined: $${result.preapprovals.totalCombined}`);
}
if (result.pull_meta) {
  console.log(`AX06: Bureaus pulled: ${result.pull_meta.bureausPulled}`);
  console.log(`AX06: Business pulled: ${result.pull_meta.businessPulled}`);
}

output.set("success", true);
output.set("outcome", result.outcome || "");
output.set("decision_label", result.decision_label || "");
output.set("error", "");
