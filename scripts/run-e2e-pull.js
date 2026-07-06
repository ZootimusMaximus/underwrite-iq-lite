"use strict";

/**
 * run-e2e-pull.js — One-command LIVE end-to-end CRS pull for the authorized test.
 *
 * Fires the real production funnel path: POST applicant identity to
 * /api/lite/crs-pull-and-analyze, which pulls the bureaus via the prod Stitch
 * Credit creds (already set in Vercel prod), runs the 12-stage engine, backgrounds
 * deliverables/letters, and syncs GHL + Airtable. This is the actual E2E.
 *
 * SAFETY / COMPLIANCE:
 *   - This performs a REAL credit pull on a REAL person. Run ONLY with explicit
 *     authorization and permissible purpose (consenting subject).
 *   - Guarded: does NOTHING unless CONFIRM_LIVE_PULL=yes is set, so it can never
 *     fire by accident.
 *   - Identity (real PII) is read from scripts/.e2e-identity.json (gitignored).
 *     The SSN is never printed.
 *   - CRS creds live in Vercel prod env — never on the command line here.
 *
 * USAGE (the "one go"):
 *   CONFIRM_LIVE_PULL=yes node scripts/run-e2e-pull.js
 *
 * Dry preview (no pull — just shows what would be sent, SSN masked):
 *   node scripts/run-e2e-pull.js
 */

const fs = require("fs");
const path = require("path");

const ENDPOINT =
  process.env.E2E_ENDPOINT || "https://underwrite-iq-lite.vercel.app/api/lite/crs-pull-and-analyze";
const IDENTITY_FILE = path.join(__dirname, ".e2e-identity.json");

function maskSsn(ssn) {
  const d = String(ssn || "").replace(/\D/g, "");
  return d.length === 9 ? `***-**-${d.slice(5)}` : "(invalid)";
}

(async () => {
  if (!fs.existsSync(IDENTITY_FILE)) {
    console.error(`Identity file not found: ${IDENTITY_FILE}`);
    console.error("Create it from the Colin test data before running.");
    process.exit(1);
  }

  const identity = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf8"));
  const { applicant, business, formData } = identity;

  // Preview (always shown; SSN masked)
  console.log("=== E2E CRS pull — applicant ===");
  console.log(`  name:    ${applicant.firstName} ${applicant.lastName}`);
  console.log(`  dob:     ${applicant.birthDate}`);
  console.log(`  ssn:     ${maskSsn(applicant.ssn)}`);
  console.log(
    `  address: ${applicant.address.addressLine1}, ${applicant.address.city}, ${applicant.address.state} ${applicant.address.postalCode}`
  );
  console.log(`  email:   ${applicant.email || "(none)"}`);
  console.log(`  endpoint:${ENDPOINT}`);
  if (identity._city_unconfirmed) console.log(`  NOTE: ${identity._city_unconfirmed}`);

  if (process.env.CONFIRM_LIVE_PULL !== "yes") {
    console.log("\n[DRY RUN] CONFIRM_LIVE_PULL is not 'yes' — no pull fired.");
    console.log("To run the LIVE pull: CONFIRM_LIVE_PULL=yes node scripts/run-e2e-pull.js");
    return;
  }

  console.log("\n[LIVE] CONFIRM_LIVE_PULL=yes — firing real pull...");
  const t = Date.now();
  const body = { applicant, formData };
  if (business) body.business = business;

  let resp, text;
  try {
    resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    text = await resp.text();
  } catch (err) {
    console.error("REQUEST FAILED:", err.message);
    process.exit(1);
  }

  let j;
  try {
    j = JSON.parse(text);
  } catch {
    /* non-JSON */
  }

  console.log(`\nHTTP ${resp.status} | ${((Date.now() - t) / 1000).toFixed(1)}s`);
  if (j) {
    console.log("  ok:        ", j.ok);
    console.log("  outcome:   ", j.outcome || j.result?.outcome);
    console.log("  redirect:  ", j.redirect?.path || j.result?.redirect?.path);
    const pre = j.preapprovals || j.result?.preapprovals;
    if (pre) console.log("  preapprovals total:", pre.totalCombined ?? pre.totalPersonal);
    console.log(
      "  per-bureau pull:",
      JSON.stringify(j.crs_pull_scope || j.result?.crs_pull_scope || "(see logs)")
    );
    console.log("\n  Full response keys:", Object.keys(j).join(", "));
  } else {
    console.log("  raw:", text.slice(0, 500));
  }
  console.log(
    "\nNext: check Vercel logs for the backgrounded deliver_letters + Airtable/GHL sync,\n" +
      "and confirm the contact's GHL fields + letter URLs populated."
  );
})();
