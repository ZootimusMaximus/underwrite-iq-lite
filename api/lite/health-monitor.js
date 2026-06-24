"use strict";

/**
 * GET /api/lite/health-monitor
 *
 * Cron-triggered (every 5 min) health check for services OUTSIDE GoHighLevel.
 * Checks: Airtable, GHL custom fields, Context Fetcher self-ping, Inquiry
 * Removal AI, required env vars. On any failure, emails a diagnostic via
 * Mailgun.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>
 *   If CRON_SECRET unset → warn + allow (dev mode, matches behavior-score-cron pattern).
 *
 * Response: 200 { ok, checks, alerted }
 *   Always 200 if the monitor itself succeeded. Body.ok=false means services are down.
 *   500 only if the handler itself throws.
 */

const { logInfo, logWarn, logError } = require("./logger");
const { fetchWithTimeout } = require("./fetch-utils");

const CHECK_TIMEOUT_MS = 8000;

// ─── Auth ─────────────────────────────────────────────────────────────────────

function validateCronAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    logWarn("health-monitor: CRON_SECRET is not set — running unauthenticated (dev mode)");
    return { ok: true };
  }
  const bearerHeader = req.headers["authorization"] || "";
  const token = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7).trim() : null;
  if (token && token === secret) return { ok: true };
  return { ok: false };
}

// ─── Health Checks ────────────────────────────────────────────────────────────

async function runHealthChecks(fetchImpl = fetchWithTimeout) {
  const baseChecks = await Promise.all([
    checkAirtable(fetchImpl),
    checkGHL(fetchImpl),
    checkContextFetcher(fetchImpl),
    checkInquiryRemovalAI(fetchImpl),
    checkRequiredEnvVars()
  ]);

  const crsCheck = await checkCRS(fetchImpl);
  if (crsCheck !== null) {
    baseChecks.push(crsCheck);
  }

  return baseChecks;
}

async function checkAirtable(fetchImpl) {
  const start = Date.now();
  try {
    const baseId = process.env.AIRTABLE_BASE_ID;
    const apiKey = process.env.AIRTABLE_API_KEY;
    const resp = await fetchImpl(
      `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      CHECK_TIMEOUT_MS
    );
    return {
      name: "Airtable",
      ok: resp.status === 200,
      detail: String(resp.status),
      latencyMs: Date.now() - start
    };
  } catch (err) {
    return { name: "Airtable", ok: false, detail: err.message, latencyMs: Date.now() - start };
  }
}

async function checkGHL(fetchImpl) {
  const start = Date.now();
  try {
    const base = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
    const locationId = process.env.GHL_LOCATION_ID;
    const apiKey = process.env.GHL_PRIVATE_API_KEY;
    const resp = await fetchImpl(
      `${base}/locations/${locationId}/customFields`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Version: "2021-07-28"
        }
      },
      CHECK_TIMEOUT_MS
    );
    return {
      name: "GHL",
      ok: resp.status === 200,
      detail: String(resp.status),
      latencyMs: Date.now() - start
    };
  } catch (err) {
    return { name: "GHL", ok: false, detail: err.message, latencyMs: Date.now() - start };
  }
}

async function checkContextFetcher(fetchImpl) {
  const start = Date.now();
  try {
    const selfBase = process.env.SELF_BASE_URL || "https://underwrite-iq-lite.vercel.app";
    const secret = process.env.CONTEXT_FETCHER_SECRET;
    const resp = await fetchImpl(
      `${selfBase}/api/lite/context-fetcher`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ contactId: "test_ax01b_verification" })
      },
      CHECK_TIMEOUT_MS
    );
    return {
      name: "ContextFetcher",
      ok: resp.status === 200,
      detail: String(resp.status),
      latencyMs: Date.now() - start
    };
  } catch (err) {
    return {
      name: "ContextFetcher",
      ok: false,
      detail: err.message,
      latencyMs: Date.now() - start
    };
  }
}

async function checkInquiryRemovalAI(fetchImpl) {
  const start = Date.now();
  try {
    const iraBase = process.env.IRA_BASE_URL || "https://inquiry-removal-ai-sigma.vercel.app";
    const resp = await fetchImpl(`${iraBase}/api/health`, { method: "GET" }, CHECK_TIMEOUT_MS);
    return {
      name: "InquiryRemovalAI",
      ok: resp.status < 500,
      detail: String(resp.status),
      latencyMs: Date.now() - start
    };
  } catch (err) {
    return {
      name: "InquiryRemovalAI",
      ok: false,
      detail: err.message,
      latencyMs: Date.now() - start
    };
  }
}

async function checkCRS(fetchImpl) {
  if (process.env.CRS_HEALTHCHECK_ENABLED !== "true") {
    return null; // Skipped — excluded from results entirely
  }

  const start = Date.now();
  try {
    const base = process.env.STITCH_CREDIT_API_BASE || "https://api-sandbox.stitchcredit.com";
    const username = process.env.STITCH_CREDIT_USERNAME || process.env.STITCH_CREDIT_EMAIL;
    const password = process.env.STITCH_CREDIT_PASSWORD;

    const resp = await fetchImpl(
      `${base}/api/users/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      },
      CHECK_TIMEOUT_MS
    );

    if (resp.status !== 200) {
      return {
        name: "CRS",
        ok: false,
        detail: `auth returned ${resp.status}`,
        latencyMs: Date.now() - start
      };
    }

    const data = await resp.json();
    const token = data.token || data.accessToken || data.jwt;

    return {
      name: "CRS",
      ok: !!token,
      detail: token ? String(resp.status) : "200 but no token in response",
      latencyMs: Date.now() - start
    };
  } catch (err) {
    return { name: "CRS", ok: false, detail: err.message, latencyMs: Date.now() - start };
  }
}

async function checkRequiredEnvVars() {
  try {
    const required = ["AIRTABLE_API_KEY", "GHL_PRIVATE_API_KEY", "CONTEXT_FETCHER_SECRET"];
    const missing = required.filter(k => !process.env[k]);
    const ok = missing.length === 0;
    return {
      name: "RequiredEnvVars",
      ok,
      detail: ok ? "all present" : missing.join(", "),
      latencyMs: 0
    };
  } catch (err) {
    return { name: "RequiredEnvVars", ok: false, detail: err.message, latencyMs: 0 };
  }
}

// ─── Alert ────────────────────────────────────────────────────────────────────

async function sendHealthAlert(failingChecks, opts = {}, fetchImpl = fetchWithTimeout) {
  const mailgunDomain = opts.mailgunDomain || process.env.MAILGUN_DOMAIN || "mg.fundhub.ai";
  const mailgunApiKey = opts.mailgunApiKey || process.env.MAILGUN_API_KEY;
  const alertEmail = opts.alertEmail || process.env.ALERT_EMAIL;
  const nowStr = opts.now || new Date().toISOString();

  if (!mailgunApiKey || !alertEmail) {
    logWarn("health-monitor: MAILGUN_API_KEY or ALERT_EMAIL not set — skipping alert");
    return { sent: false };
  }

  const failingLines = failingChecks
    .map(c => `- ${c.name}: ${c.detail} (${c.latencyMs}ms)`)
    .join("\n");

  const text = [
    "FundHub System Health Alert",
    `Timestamp: ${nowStr}`,
    "",
    "Failing checks:",
    failingLines,
    "",
    "Please investigate immediately."
  ].join("\n");

  const body = new URLSearchParams({
    from: `FundHub Health <health@${mailgunDomain}>`,
    to: alertEmail,
    subject: `[FundHub] System health alert: ${failingChecks.length} check(s) failing`,
    text
  });

  try {
    const resp = await fetchImpl(`https://api.mailgun.net/v3/${mailgunDomain}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from("api:" + mailgunApiKey).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (resp.ok) {
      logInfo("health-monitor: alert sent");
      return { sent: true };
    }

    logWarn("health-monitor: alert send failed", { status: resp.status });
    return { sent: false };
  } catch (err) {
    logWarn("health-monitor: alert send failed", { error: err.message });
    return { sent: false };
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const auth = validateCronAuth(req);
  if (!auth.ok) {
    logWarn("health-monitor: unauthorized");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  logInfo("health-monitor: running checks");

  try {
    const now = new Date().toISOString();
    const checks = await runHealthChecks();
    const overallOk = checks.every(c => c.ok);

    let alerted = false;
    if (!overallOk) {
      const failing = checks.filter(c => !c.ok);
      logWarn("health-monitor: checks failing", { failing: failing.map(c => c.name) });
      const result = await sendHealthAlert(failing, { now });
      alerted = result.sent;
    }

    logInfo("health-monitor: complete", { overallOk, alerted });
    return res.status(200).json({ ok: overallOk, checks, alerted });
  } catch (err) {
    logError("health-monitor: unhandled error", { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
};

module.exports.validateCronAuth = validateCronAuth;
module.exports.runHealthChecks = runHealthChecks;
module.exports.sendHealthAlert = sendHealthAlert;
