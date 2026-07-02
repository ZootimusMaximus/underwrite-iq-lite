"use strict";
/* eslint-disable no-console */

/**
 * E2E harness — new-model launch-readiness check (2026-07-02).
 *
 * The old 8-event spine (entry.captured … sale.closed) was RETIRED — GHL now owns
 * Stages 1 & 5 and those handlers are no-ops. This harness checks the CURRENT live
 * backend seams instead:
 *   - health: every launch-critical endpoint is deployed + auth-gated
 *   - live seams (opt-in): crs-payment-posted (flip crs_paid) + deliver-letters
 *     (repair set) on a configured test contact — both NON-billable
 *   - the billable CRS bureau pull (crs-pull-and-analyze) is a SEPARATE manual step
 *     (needs a real identity + explicit consent) — never fired here
 *
 * SAFETY: health-only by default (no mutations, no billable). Opt in per seam:
 *   node scripts/e2e-harness.js                         # health only
 *   CONFIRM_E2E=yes E2E_CONTACT_ID=<ghlId> node scripts/e2e-harness.js
 *        → also flips crs_paid + delivers repair letters on that contact
 *
 * Env: .env.local (DELIVER_LETTERS_SECRET/CONTEXT_FETCHER_SECRET, CRS_PAYMENT_SECRET,
 * GHL_*, AIRTABLE_*).
 */

require("dotenv").config({ path: ".env.local" });

const BASE = process.env.E2E_BASE || "https://underwrite-iq-lite.vercel.app";
const LIVE = process.env.CONFIRM_E2E === "yes";
const CONTACT_ID = process.env.E2E_CONTACT_ID || "";
const DELIVER_SECRET =
  process.env.DELIVER_LETTERS_SECRET || process.env.CONTEXT_FETCHER_SECRET || "";
const CRS_PAY_SECRET = process.env.CRS_PAYMENT_SECRET || process.env.CONTEXT_FETCHER_SECRET || "";

const AT_KEY = process.env.AIRTABLE_API_KEY;
const AT_BASE = process.env.AIRTABLE_BASE_ID;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};

// ---------------------------------------------------------------------------
// Health: each endpoint is up + gated as expected
// ---------------------------------------------------------------------------

async function probe(name, path, { method = "POST", expect, body } = {}) {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(body || {}) : undefined
    });
    const ok = expect.includes(r.status);
    record(name, ok, `HTTP ${r.status} (expected ${expect.join("/")})`);
  } catch (err) {
    record(name, false, `threw: ${err.message}`);
  }
}

async function healthChecks() {
  console.log("HEALTH — endpoints deployed + auth-gated:");
  await probe("root reachable", "/", { method: "GET", expect: [200] });
  await probe("crs-pull-and-analyze gated", "/api/lite/crs-pull-and-analyze", {
    expect: [401, 400]
  });
  await probe("deliver-letters gated", "/api/lite/deliver-letters", { expect: [401] });
  await probe("crs-payment-posted gated", "/api/lite/crs-payment-posted", { expect: [401] });
  await probe("events gated", "/api/events", { expect: [401] });
  console.log("");
}

// ---------------------------------------------------------------------------
// Verify helpers (reads)
// ---------------------------------------------------------------------------

async function airtableClientHasCloserResult(email) {
  if (!AT_KEY || !AT_BASE) return { checked: false };
  const url = `https://api.airtable.com/v0/${AT_BASE}/CLIENTS?filterByFormula=${encodeURIComponent(`{email}='${email}'`)}&maxRecords=1`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${AT_KEY}` } });
  if (!r.ok) return { checked: true, error: `HTTP ${r.status}` };
  const j = await r.json();
  const rec = (j.records || [])[0];
  return { checked: true, has: !!(rec && rec.fields && rec.fields.latest_crs_result_full) };
}

// ---------------------------------------------------------------------------
// Live seams (opt-in, non-billable)
// ---------------------------------------------------------------------------

async function liveSeams() {
  console.log("LIVE SEAMS (CONFIRM_E2E=yes) — non-billable mutations:");
  if (!CONTACT_ID) {
    record("live seams", false, "E2E_CONTACT_ID not set — skipping");
    return;
  }

  // 1) crs-payment-posted → flip crs_paid checkbox
  try {
    const r = await fetch(`${BASE}/api/lite/crs-payment-posted`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRS_PAY_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contactId: CONTACT_ID, amount: 32, consent: true })
    });
    const j = await r.json().catch(() => ({}));
    record(
      "crs-payment-posted flips crs_paid",
      r.status === 200 && j.ok,
      `HTTP ${r.status} updated=${(j.updated || []).join(",")}`
    );
  } catch (err) {
    record("crs-payment-posted flips crs_paid", false, `threw: ${err.message}`);
  }

  // 2) deliver-letters (repair) → 12 letters + GHL writeback
  try {
    const r = await fetch(`${BASE}/api/lite/deliver-letters`, {
      method: "POST",
      headers: { Authorization: `Bearer ${DELIVER_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contactId: CONTACT_ID, type: "repair" })
    });
    const j = await r.json().catch(() => ({}));
    const lt = j.letters || {};
    const ok = r.status === 200 && j.ok && lt.uploaded === 12 && j.ghlUpdated;
    record(
      "deliver-letters repair (12 uploaded + ghlUpdated)",
      ok,
      `HTTP ${r.status} generated=${lt.generated} uploaded=${lt.uploaded} failed=${lt.failed} ghlUpdated=${j.ghlUpdated}`
    );
  } catch (err) {
    record("deliver-letters repair", false, `threw: ${err.message}`);
  }

  // 3) verify closer-dashboard payload persisted (from a prior real pull)
  const cr = await airtableClientHasCloserResult(process.env.E2E_EMAIL || "");
  if (cr.checked && !cr.error) {
    record(
      "CLIENTS.latest_crs_result_full present",
      !!cr.has,
      cr.has ? "persisted" : "absent (needs a CRS pull first)"
    );
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  console.log(`E2E harness — ${LIVE ? "HEALTH + LIVE SEAMS" : "HEALTH ONLY"}`);
  console.log(`  base: ${BASE}`);
  console.log(`  contact id: ${CONTACT_ID || "(none — health only)"}`);
  console.log("");

  await healthChecks();
  if (LIVE) await liveSeams();

  const passed = results.filter(r => r.pass).length;
  console.log(`=== ${passed}/${results.length} checks passed ===`);
  console.log("Note: the billable CRS bureau pull (crs-pull-and-analyze) is a SEPARATE");
  console.log("manual step — run it with a real identity + explicit consent, not here.");
  process.exit(passed === results.length ? 0 : 1);
})();
