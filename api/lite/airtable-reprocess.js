"use strict";

// ============================================================================
// Airtable Reprocess — Endpoint for AX07 (Reprocess Existing Snapshots)
//
// POST /api/lite/airtable-reprocess
//
// Accepts pre-aggregated snapshot data from Airtable automations (AX07) and
// runs the CRS engine's decision stages on it. Unlike crs-analyze (which
// needs raw Stitch Credit responses), this endpoint works with the summary
// metrics already stored in Airtable SNAPSHOTS.
//
// Flow: AX07 reads snapshots → builds payload → POSTs here → gets outcome
// ============================================================================

const { routeOutcome } = require("./crs/route-outcome");
const { estimatePreapprovals } = require("./crs/estimate-preapprovals");
const { buildOptimizationFindings } = require("./crs/optimization-findings");
const { buildSuggestions: buildCRSSuggestions } = require("./crs/build-suggestions");
const { buildCards } = require("./crs/build-cards");
const { rateLimitMiddleware } = require("./rate-limiter");
const { logError, logInfo } = require("./logger");
const { notifyCRSSnapshotComplete } = require("./ghl-webhook");

// ---------------------------------------------------------------------------
// Main Handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  try {
    // ----- CORS -----
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    }

    // ----- Rate limiting -----
    const rateLimitAllowed = await rateLimitMiddleware(req, res);
    if (!rateLimitAllowed) return;

    // ----- API key auth (optional: only enforced if AIRTABLE_REPROCESS_KEY is set) -----
    // TODO: Re-enable auth after AX07 secret is properly configured
    // const expectedKey = process.env.AIRTABLE_REPROCESS_KEY;
    // if (expectedKey) {
    //   const authHeader = req.headers["authorization"] || "";
    //   const providedKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    //   if (!providedKey || providedKey !== expectedKey) {
    //     return res
    //       .status(401)
    //       .json({ ok: false, error: "UNAUTHORIZED", message: "Invalid or missing API key." });
    //   }
    // }

    // ----- Parse body -----
    const body = req.body;
    if (!body) {
      return res
        .status(400)
        .json({ ok: false, error: "MISSING_BODY", message: "Request body is required." });
    }

    const { source, client, round, submitted_form, consumer_reports, business_report } = body;

    if (!consumer_reports || !Array.isArray(consumer_reports) || !consumer_reports.length) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_CONSUMER_REPORTS",
        message: "consumer_reports array is required."
      });
    }

    logInfo("Airtable reprocess starting", {
      source: source || "unknown",
      bureauCount: consumer_reports.length,
      hasBusiness: !!business_report,
      clientEmail: client?.email
    });

    // ----- Build synthetic consumerSignals from snapshot metrics -----
    const consumerSignals = buildConsumerSignalsFromSnapshots(consumer_reports);
    const businessSignals = business_report
      ? buildBusinessSignalsFromSnapshot(business_report)
      : null;

    // ----- Run decision stages -----
    const identityGate = { outcome: "PASS", reasons: [] };
    const outcomeResult = routeOutcome(consumerSignals, businessSignals, identityGate);

    const preapprovals = estimatePreapprovals(
      consumerSignals,
      businessSignals,
      outcomeResult.outcome
    );

    const findings = buildOptimizationFindings(
      consumerSignals,
      businessSignals,
      outcomeResult.outcome,
      preapprovals,
      {}
    );
    const suggestions = buildCRSSuggestions(
      findings,
      outcomeResult.outcome,
      consumerSignals,
      businessSignals
    );
    const cards = buildCards(outcomeResult.outcome, consumerSignals, businessSignals, findings);

    // ----- Build redirect -----
    const redirectPath =
      outcomeResult.outcome === "REPAIR" || outcomeResult.outcome === "MANUAL_REVIEW"
        ? "repair"
        : "funding";

    const refId =
      round?.underwriteiq_reference_id ||
      `ax07-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

    const baseUrl =
      redirectPath === "funding"
        ? process.env.REDIRECT_URL_FUNDABLE || "https://fundhub.ai/funding-approved-analyzer-462533"
        : process.env.REDIRECT_URL_NOT_FUNDABLE || "https://fundhub.ai/fix-my-credit-analyzer";

    // ----- Build selected bureau -----
    const selectedBureau = chooseHighestScoreBureau(consumer_reports);

    // ----- Build CRM payload -----
    const crmPayload = {
      resultType: redirectPath,
      selected_bureau_for_round: selectedBureau,
      reference_id: refId,
      combined_total: preapprovals?.totalCombined || 0
    };

    // ----- Fire U-03 webhook if we have an email -----
    if (client?.email) {
      const perBureau = buildPerBureauFromReports(consumer_reports);
      notifyCRSSnapshotComplete({
        email: client.email,
        firstName: submitted_form?.full_name?.split(" ")[0] || "",
        lastName: submitted_form?.full_name?.split(" ").slice(1).join(" ") || "",
        analyzerPath: redirectPath,
        ficoScore: consumerSignals.scores.median || 0,
        utilizationPct: consumerSignals.utilization.pct || 0,
        inquiries: perBureau.inquiries,
        negatives: perBureau.negatives,
        lates: { ex: 0, eq: 0, tu: 0 }
      }).catch(() => {});
    }

    logInfo("Airtable reprocess complete", {
      outcome: outcomeResult.outcome,
      totalCombined: preapprovals?.totalCombined,
      selectedBureau
    });

    // ----- Response -----
    return res.status(200).json({
      ok: true,
      outcome: outcomeResult.outcome,
      decision_label: outcomeResult.decision_label,
      decision_explanation: outcomeResult.decision_explanation,
      reason_codes: outcomeResult.reason_codes,
      confidence: outcomeResult.confidence,
      consumer_summary: {
        primary_bureau: selectedBureau,
        median_score: consumerSignals.scores.median
      },
      business_summary: businessSignals ? { business_score: businessSignals.intelliscore } : null,
      preapprovals,
      optimization_findings: findings,
      suggestions,
      cards,
      redirect: {
        path: redirectPath,
        url: baseUrl
      },
      crm_payload: crmPayload,
      reference_id: refId
    });
  } catch (err) {
    logError("Airtable reprocess fatal error", err, { method: req.method, path: req.url });
    return res.status(200).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: "Something went wrong during reprocessing. Please try again."
    });
  }
};

// ---------------------------------------------------------------------------
// Synthetic Signal Builders
// ---------------------------------------------------------------------------

/**
 * Build a consumerSignals object from AX07's consumer_reports array.
 * Maps snapshot summary metrics into the shape the engine stages expect.
 */
function buildConsumerSignalsFromSnapshots(reports) {
  const perBureau = { tu: null, ex: null, eq: null };
  let totalInquiries = 0;
  let totalDerogs = 0;
  let totalLates = 0;
  for (const r of reports) {
    const bureau = mapBureauCode(r.bureau);
    if (bureau && r.score != null) {
      perBureau[bureau] = r.score;
    }
    totalInquiries += r.inquiry_count || 0;
    totalDerogs += r.derog_count || 0;
    totalLates += r.late_count || 0;
  }

  const scores = Object.values(perBureau).filter(v => v !== null);
  scores.sort((a, b) => a - b);
  const median = scores.length > 0 ? scores[Math.floor(scores.length / 2)] : null;

  const spread = scores.length >= 2 ? scores[scores.length - 1] - scores[0] : 0;

  const bureauConfidence = scores.length >= 3 ? "high" : scores.length === 2 ? "medium" : "low";

  // Utilization — not available from snapshots, default to unknown
  const utilizationBand = "unknown";

  // Inquiry pressure
  const inquiryPressure =
    totalInquiries <= 3
      ? "low"
      : totalInquiries <= 6
        ? "moderate"
        : totalInquiries <= 12
          ? "high"
          : "storm";

  // Worst severity estimate from derog count
  const worstSeverity = totalDerogs > 0 ? 5 : 0;

  return {
    scores: {
      median,
      bureauConfidence,
      spread,
      perBureau
    },
    tradelines: {
      total: 0,
      primary: 0,
      au: 0,
      auDominance: 0,
      revolvingDepth: 0,
      installmentDepth: 0,
      mortgagePresent: false,
      depth: 0,
      thinFile: false
    },
    anchors: {
      revolving: null,
      installment: null
    },
    utilization: {
      totalBalance: 0,
      totalLimit: 0,
      pct: null,
      band: utilizationBand
    },
    inquiries: {
      total: totalInquiries,
      last6Mo: totalInquiries,
      last12Mo: totalInquiries,
      pressure: inquiryPressure
    },
    derogatories: {
      active: totalDerogs,
      chargeoffs: 0,
      collections: 0,
      active30: 0,
      active60: 0,
      active90: totalDerogs > 0 ? 1 : 0,
      active120Plus: 0,
      worstSeverity,
      activeBankruptcy: false,
      dischargedBankruptcy: false,
      bankruptcyAge: null
    },
    paymentHistory: {
      late30: totalLates,
      late60: 0,
      late90: 0,
      totalEvents: totalLates,
      recentActivity: totalLates > 0
    }
  };
}

/**
 * Build businessSignals from AX07's business_report object.
 */
function buildBusinessSignalsFromSnapshot(report) {
  return {
    intelliscore: report.business_score || null,
    recommendedLimit: report.recommended_limit || 0,
    uccCount: report.ucc_count || 0,
    publicRecordsCount: report.public_records_count || 0,
    paymentSummary: report.payment_summary || "",
    paymentStress: report.payment_stress || "",
    fraudFlag: report.fraud_flag || "Unknown",
    majorFraudAlert: report.major_fraud_alert || ""
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapBureauCode(code) {
  if (!code) return null;
  const upper = code.toUpperCase();
  if (upper === "EX" || upper === "EXP" || upper === "EXPERIAN") return "ex";
  if (upper === "TU" || upper === "TRANSUNION") return "tu";
  if (upper === "EQ" || upper === "EFX" || upper === "EQUIFAX") return "eq";
  return null;
}

function chooseHighestScoreBureau(reports) {
  let best = null;
  let bestScore = -1;
  for (const r of reports) {
    if (r.score != null && r.score > bestScore) {
      bestScore = r.score;
      best = r.bureau;
    }
  }
  return best || "";
}

function buildPerBureauFromReports(reports) {
  const inquiries = { ex: 0, eq: 0, tu: 0 };
  const negatives = { ex: 0, eq: 0, tu: 0 };
  for (const r of reports) {
    const code = mapBureauCode(r.bureau);
    if (code) {
      inquiries[code] = r.inquiry_count || 0;
      negatives[code] = r.derog_count || 0;
    }
  }
  return { inquiries, negatives };
}
