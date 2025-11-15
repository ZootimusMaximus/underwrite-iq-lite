// ==================================================================================
// UnderwriteIQ LITE — Per-Bureau TEXT + LLM Parser (Crash-Proof Edition)
// Full per-bureau underwriting (EX / EQ / TU).
// Employers added to personal info per bureau.
// Global funding scaled by (# fundable bureaus / # bureaus present).
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");

module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// -------------------------------------------------------------
// 🔒 FALLBACK RESULT — ALWAYS RETURN VALID JSON ON FAILURE
// -------------------------------------------------------------
function buildFallbackResult(reason = "Analyzer failed") {
  return {
    ok: true,
    manual_review: true,
    fallback: true,
    reason,
    summary: {
      score: null,
      risk_band: "unknown",
      note: "Your report has been queued for manual review."
    },
    issues: [],
    dispute_groups: [],
    funding_estimate: {
      low: null,
      high: null,
      confidence: 0
    },
    bureaus: {
      experian: {
        present: false,
        names: [],
        addresses: [],
        employers: [],
        inquiries: [],
        accounts: [],
        score: null,
        utilization_pct: null,
        negative_accounts: 0,
        late_payment_events: 0,
        inquiries_count: 0,
        tradelines: []
      },
      equifax: {
        present: false,
        names: [],
        addresses: [],
        employers: [],
        inquiries: [],
        accounts: [],
        score: null,
        utilization_pct: null,
        negative_accounts: 0,
        late_payment_events: 0,
        inquiries_count: 0,
        tradelines: []
      },
      transunion: {
        present: false,
        names: [],
        addresses: [],
        employers: [],
        inquiries: [],
        accounts: [],
        score: null,
        utilization_pct: null,
        negative_accounts: 0,
        late_payment_events: 0,
        inquiries_count: 0,
        tradelines: []
      }
    }
  };
}

// -----------------------------------------------
// 📌 SYSTEM PROMPT WITH FULL PER-BUREAU PARSING
// -----------------------------------------------
const LLM_PROMPT = `
You are UnderwriteIQ, an AI credit analyst.
You will be given RAW TEXT extracted from a CREDIT REPORT PDF.

Your job:
1) Parse each CREDIT BUREAU section separately (Experian, Equifax, TransUnion).
2) Output a SINGLE JSON object with a "bureaus" field.
3) For each bureau, return BOTH underwriting metrics and personal-info suggestions.

Return ONLY VALID COMPACT JSON (one line). No commentary. No markdown.

The JSON shape MUST be:

{
  "bureaus": {
    "experian": {
      "present": boolean,
      "score": number or null,
      "utilization_pct": number or null,
      "negative_accounts": number,
      "late_payment_events": number,
      "inquiries_count": number,

      "names": [ "name variations for Experian" ],
      "addresses": [ "address lines listed under Experian" ],
      "employers": [ "employer names listed under Experian" ],
      "inquiries": [ "creditor/lender names for Experian inquiries" ],
      "accounts": [ "creditor names for Experian tradelines" ],

      "tradelines": [
        {
          "creditor": string,
          "type": "revolving" | "installment" | "auto" | "other",
          "status": string,
          "balance": number,
          "limit": number,
          "opened": string | null,    // YYYY-MM or YYYY-MM-DD
          "closed": string | null
        }
      ]
    },
    "equifax": {
      "present": boolean,
      "score": number or null,
      "utilization_pct": number or null,
      "negative_accounts": number,
      "late_payment_events": number,
      "inquiries_count": number,
      "names": [ ... ],
      "addresses": [ ... ],
      "employers": [ ... ],
      "inquiries": [ ... ],
      "accounts": [ ... ],
      "tradelines": [ ... ]
    },
    "transunion": {
      "present": boolean,
      "score": number or null,
      "utilization_pct": number or null,
      "negative_accounts": number,
      "late_payment_events": number,
      "inquiries_count": number,
      "names": [ ... ],
      "addresses": [ ... ],
      "employers": [ ... ],
      "inquiries": [ ... ],
      "accounts": [ ... ],
      "tradelines": [ ... ]
    }
  }
}

RULES:
- "present" = true if that bureau clearly appears in the report, else false.
- DO NOT mix bureaus. Assign each item ONLY to its correct bureau.
- If unsure, use empty arrays, 0, or null.
- DO NOT invent fake data.
- JSON MUST be valid, minified, and parseable by JSON.parse.
`;

// -----------------------------------------------
// JSON Extraction Helpers
// -----------------------------------------------
function extractJsonStringFromResponse(json) {
  if (json.output_text && json.output_text.trim()) {
    return json.output_text.trim();
  }

  if (Array.isArray(json.output)) {
    for (const msg of json.output) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const chunk of msg.content) {
        if (
          (chunk.type === "output_text" || chunk.type === "summary_text") &&
          typeof chunk.text === "string" &&
          chunk.text.trim()
        ) {
          return chunk.text.trim();
        }
      }
    }
  }

  if (
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    typeof json.choices[0].message.content === "string"
  ) {
    return json.choices[0].message.content.trim();
  }

  return null;
}

function tryParseJsonWithRepair(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {}

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const sliced = raw.slice(first, last + 1);
    try {
      return JSON.parse(sliced);
    } catch (_) {}
  }

  throw new Error("JSON parse failed. Preview: " + raw.slice(0, 200));
}

// -----------------------------------------------
// Single OpenAI Call
// -----------------------------------------------
async function callOpenAIOnce(text) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const payload = {
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: LLM_PROMPT },
      { role: "user", content: [{ type: "input_text", text: text.slice(0, 15000) }] }
    ],
    temperature: 0,
    max_output_tokens: 4096
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("LLM HTTP error: " + errText);
  }

  const json = await resp.json();

  if (json.refusal) {
    throw new Error("LLM refusal: " + JSON.stringify(json.refusal));
  }

  const raw = extractJsonStringFromResponse(json);
  if (!raw) {
    throw new Error("LLM returned no output_text.");
  }

  return tryParseJsonWithRepair(raw);
}

// -----------------------------------------------
// Retry Logic (3 attempts)
// -----------------------------------------------
async function runCreditTextLLM(text) {
  let lastError = null;

  for (let i = 1; i <= 3; i++) {
    try {
      return await callOpenAIOnce(text);
    } catch (err) {
      lastError = err;
      const msg = String(err || "");
      console.error(`UnderwriteIQ LLM attempt ${i} failed:`, msg);

      if (
        msg.includes("LLM HTTP error") ||
        msg.includes("LLM refusal") ||
        msg.includes("Missing UNDERWRITE_IQ_VISION_KEY")
      ) {
        break;
      }

      await new Promise(r => setTimeout(r, 150 * i));
    }
  }

  throw new Error("LLM failed after 3 attempts: " + String(lastError));
}

// -----------------------------------------------
// Helpers
// -----------------------------------------------
function getNumberField(fields, key) {
  if (!fields || fields[key] == null) return null;
  const raw = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function monthsSince(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!year || !month) return null;

  const opened = new Date(year, month - 1, 1);
  const now = new Date();
  const yearsDiff = now.getFullYear() - opened.getFullYear();
  const monthsDiff = now.getMonth() - opened.getMonth();
  return yearsDiff * 12 + monthsDiff;
}

function normalizeBureau(raw, key) {
  const safe = raw && typeof raw === "object" ? raw : {};
  return {
    present: Boolean(safe.present),
    score: safe.score != null ? Number(safe.score) : null,
    utilization_pct: safe.utilization_pct != null ? Number(safe.utilization_pct) : null,
    negative_accounts: safe.negative_accounts != null ? Number(safe.negative_accounts) : 0,
    late_payment_events: safe.late_payment_events != null ? Number(safe.late_payment_events) : 0,
    inquiries_count: safe.inquiries_count != null ? Number(safe.inquiries_count) : 0,
    names: Array.isArray(safe.names) ? safe.names : [],
    addresses: Array.isArray(safe.addresses) ? safe.addresses : [],
    employers: Array.isArray(safe.employers) ? safe.employers : [],
    inquiries: Array.isArray(safe.inquiries) ? safe.inquiries : [],
    accounts: Array.isArray(safe.accounts) ? safe.accounts : [],
    tradelines: Array.isArray(safe.tradelines) ? safe.tradelines : [],
    bureau_key: key
  };
}

// -----------------------------------------------
// Per-Bureau Underwriting Engine
// -----------------------------------------------
function computeUnderwriteForBureau(bureauKey, bureauData, businessAgeMonthsRaw) {
  const score = Number(bureauData.score ?? 0);
  const util = Number(bureauData.utilization_pct ?? 0);
  const neg = Number(bureauData.negative_accounts ?? 0);
  const lates = Number(bureauData.late_payment_events ?? 0);
  const totalInq = Number(bureauData.inquiries_count ?? 0);
  const tradelines = Array.isArray(bureauData.tradelines) ? bureauData.tradelines : [];

  const businessAgeMonths =
    typeof businessAgeMonthsRaw === "number" && Number.isFinite(businessAgeMonthsRaw)
      ? businessAgeMonthsRaw
      : null;

  let highestRevolvingLimit = 0;
  let highestInstallmentAmount = 0;
  let hasAnyRevolving = false;
  let hasAnyInstallment = false;

  let positiveTradelinesCount = 0;
  let fileAllNegative = false;

  for (const tl of tradelines) {
    const type = String(tl.type || "").toLowerCase();
    const status = String(tl.status || "").toLowerCase();
    const limit = Number(tl.limit || 0);
    const balance = Number(tl.balance || 0);
    const ageMonths = monthsSince(tl.opened);

    const isDerog =
      status.includes("chargeoff") ||
      status.includes("collection") ||
      status.includes("derog") ||
      status.includes("repossession") ||
      status.includes("foreclosure");

    if (!isDerog) {
      positiveTradelinesCount++;
    }

    const seasoned = ageMonths != null && ageMonths >= 24;

    if (type === "revolving") {
      hasAnyRevolving = true;
      if (status.includes("open") && seasoned && limit > highestRevolvingLimit) {
        highestRevolvingLimit = limit;
      }
    }

    if (type === "installment") {
      hasAnyInstallment = true;
      const originalAmount = limit || balance;
      if (originalAmount > 0 && seasoned && !isDerog) {
        if (originalAmount > highestInstallmentAmount) {
          highestInstallmentAmount = originalAmount;
        }
      }
    }
  }

  fileAllNegative = (positiveTradelinesCount === 0 && neg > 0);
  const thinFile = positiveTradelinesCount < 3;

  const canCardStack =
    highestRevolvingLimit >= 5000 &&
    hasAnyRevolving;

  const personalCardFunding = canCardStack
    ? highestRevolvingLimit * 5.5
    : 0;

  const canLoanStack =
    highestInstallmentAmount >= 10000 &&
    hasAnyInstallment &&
    lates === 0;

  const personalLoanFunding = canLoanStack
    ? highestInstallmentAmount * 3.0
    : 0;

  const canDualStack = canCardStack && canLoanStack;
  const totalPersonalFunding = personalCardFunding + personalLoanFunding;

  let businessMultiplier = 0;
  if (businessAgeMonths != null && personalCardFunding > 0) {
    if (businessAgeMonths < 12) {
      businessMultiplier = 0.5;
    } else if (businessAgeMonths < 24) {
      businessMultiplier = 1.0;
    } else {
      businessMultiplier = 2.0;
    }
  }

  const canBusinessFund = businessMultiplier > 0;
  const businessFunding = personalCardFunding * businessMultiplier;
  const totalBusinessFunding = businessFunding;
  const totalCombinedFunding = totalPersonalFunding + totalBusinessFunding;

  let liteBannerFunding = personalCardFunding;
  if (!liteBannerFunding && score >= 700 && util <= 30 && neg === 0) {
    liteBannerFunding = 15000;
  }
  if (score < 700 || util > 30 || neg !== 0) {
    liteBannerFunding = personalCardFunding || 15000;
  }

  const needsUtilReduction = util > 30;
  const needsNewPrimaryRevolving = !hasAnyRevolving || highestRevolvingLimit < 5000;
  const needsInquiryCleanup = totalInq > 0;
  const needsNegativeCleanup = neg > 0;
  const needsFileBuildOut = thinFile || fileAllNegative;

  const optimization = {
    needs_util_reduction: needsUtilReduction,
    target_util_pct: needsUtilReduction ? 30 : null,
    needs_new_primary_revolving: needsNewPrimaryRevolving,
    needs_inquiry_cleanup: needsInquiryCleanup,
    needs_negative_cleanup: needsNegativeCleanup,
    needs_file_buildout: needsFileBuildOut,
    thin_file: thinFile,
    file_all_negative: fileAllNegative
  };

  const fundable =
    score >= 700 &&
    util <= 30 &&
    neg === 0;

  let exInq = 0, tuInq = 0, eqInq = 0;
  if (bureauKey === "experian") exInq = totalInq;
  if (bureauKey === "equifax") eqInq = totalInq;
  if (bureauKey === "transunion") tuInq = totalInq;

  return {
    bureau: bureauKey,
    fundable,
    metrics: {
      score,
      utilization_pct: util,
      negative_accounts: neg,
      late_payment_events: lates,
      inquiries: {
        ex: exInq,
        tu: tuInq,
        eq: eqInq,
        total: totalInq
      }
    },
    personal: {
      highest_revolving_limit: highestRevolvingLimit,
      highest_installment_amount: highestInstallmentAmount,
      can_card_stack: canCardStack,
      can_loan_stack: canLoanStack,
      can_dual_stack: canDualStack,
      card_funding: personalCardFunding,
      loan_funding: personalLoanFunding,
      total_personal_funding: totalPersonalFunding
    },
    business: {
      business_age_months: businessAgeMonths,
      can_business_fund: canBusinessFund,
      business_multiplier: businessMultiplier,
      business_funding: businessFunding
    },
    totals: {
      total_personal_funding: totalPersonalFunding,
      total_business_funding: totalBusinessFunding,
      total_combined_funding: totalCombinedFunding
    },
    optimization,
    lite_banner_funding: liteBannerFunding
  };
}

// -----------------------------------------------
// MAIN HANDLER — FULLY CRASH-PROOF
// -----------------------------------------------
module.exports = async function handler(req, res) {
  try {
    // CORS
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, msg: "Method not allowed" });
    }

    // -----------------------------------
    // Parse uploaded PDF
    // -----------------------------------
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { fields, files } = await new Promise((resolve, reject) =>
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      })
    );

    const file = files.file;
    if (!file?.filepath) {
      return res.status(200).json(buildFallbackResult("No file uploaded"));
    }

    const buffer = await fs.promises.readFile(file.filepath);
    const parsedPDF = await pdfParse(buffer);

    const text = (parsedPDF.text || "").replace(/\s+/g, " ").trim();

    if (!text || text.length < 200) {
      return res.status(200).json(buildFallbackResult("Not enough text extracted"));
    }

    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    // -----------------------------------
    // Analyzer execution (safe)
    // -----------------------------------
    let extracted;
    try {
      if (!text || text.trim().length < 500) {
        return res.status(200).json(buildFallbackResult("Not enough text extracted from report"));
      }

      extracted = await runCreditTextLLM(text);

      if (!extracted || typeof extracted !== "object") {
        return res.status(200).json(buildFallbackResult("Analyzer returned invalid format"));
      }

      if (!extracted.bureaus || typeof extracted.bureaus !== "object") {
        return res.status(200).json(buildFallbackResult("Missing bureaus field"));
      }

    } catch (err) {
      console.error("Analyzer crashed:", err);
      return res.status(200).json(buildFallbackResult("Analyzer crashed: " + String(err)));
    }

    // Normalize bureaus
    const rawBureaus = extracted.bureaus || {};
    const bureaus = {
      experian: normalizeBureau(rawBureaus.experian, "experian"),
      equifax: normalizeBureau(rawBureaus.equifax, "equifax"),
      transunion: normalizeBureau(rawBureaus.transunion, "transunion")
    };
    extracted.bureaus = bureaus;

    // -----------------------------------
    // Per-bureau underwriting
    // -----------------------------------
    const bureauResults = {};
    const keys = ["experian", "equifax", "transunion"];

    for (const key of keys) {
      const b = bureaus[key];

      const hasAnyData =
        b.present ||
        b.score != null ||
        b.utilization_pct != null ||
        b.negative_accounts > 0 ||
        b.late_payment_events > 0 ||
        b.inquiries_count > 0 ||
        (Array.isArray(b.tradelines) && b.tradelines.length > 0) ||
        (Array.isArray(b.names) && b.names.length > 0) ||
        (Array.isArray(b.addresses) && b.addresses.length > 0);

      if (!hasAnyData) {
        continue;
      }

      try {
        bureauResults[key] = computeUnderwriteForBureau(key, b, businessAgeMonths);
      } catch (err) {
        console.error(`Underwrite crash for bureau ${key}:`, err);
      }
    }

    const availableKeys = Object.keys(bureauResults);
    if (availableKeys.length === 0) {
      return res.status(200).json(buildFallbackResult("No recognizable bureau data for underwriting"));
    }

    const fundableKeys = availableKeys.filter(k => bureauResults[k].fundable);

    // Choose primary bureau:
    let primaryKey;
    if (fundableKeys.length > 0) {
      primaryKey = fundableKeys.reduce((best, k) => {
        if (!best) return k;
        const cur = bureauResults[k].totals.total_combined_funding;
        const prev = bureauResults[best].totals.total_combined_funding;
        return cur > prev ? k : best;
      }, null);
    } else {
      primaryKey = availableKeys.reduce((best, k) => {
        if (!best) return k;
        const cur = bureauResults[k].metrics.score;
        const prev = bureauResults[best].metrics.score;
        return cur > prev ? k : best;
      }, null);
    }

    const primary = bureauResults[primaryKey];

    const totalAvailable = availableKeys.length;
    const fundableCount = fundableKeys.length;
    const denom = Math.max(totalAvailable, 1);
    const scaleFactor = fundableCount === 0 ? 0 : (fundableCount / denom);

    const globalFundable = fundableCount > 0;

    const scaledPersonalFunding = primary.personal.total_personal_funding * scaleFactor;
    const scaledBusinessFunding = primary.business.business_funding * scaleFactor;
    const scaledTotalCombined = scaledPersonalFunding + scaledBusinessFunding;

    const globalScore = primary.metrics.score;
    const globalUtil = primary.metrics.utilization_pct;
    const globalNeg = primary.metrics.negative_accounts;
    const globalLates = primary.metrics.late_payment_events;

    const globalInquiries = {
      ex: bureauResults.experian ? bureauResults.experian.metrics.inquiries.total : 0,
      eq: bureauResults.equifax ? bureauResults.equifax.metrics.inquiries.total : 0,
      tu: bureauResults.transunion ? bureauResults.transunion.metrics.inquiries.total : 0
    };
    globalInquiries.total = globalInquiries.ex + globalInquiries.eq + globalInquiries.tu;

    const globalLiteBannerFunding = Math.round(primary.lite_banner_funding * scaleFactor);

    const globalUnderwrite = {
      fundable: globalFundable,
      primary_bureau: primaryKey,
      fundable_bureaus: fundableKeys,
      bureau_results: bureauResults,
      metrics: {
        score: globalScore,
        utilization_pct: globalUtil,
        negative_accounts: globalNeg,
        late_payment_events: globalLates,
        inquiries: globalInquiries
      },
      personal: {
        highest_revolving_limit: primary.personal.highest_revolving_limit,
        highest_installment_amount: primary.personal.highest_installment_amount,
        can_card_stack: primary.personal.can_card_stack,
        can_loan_stack: primary.personal.can_loan_stack,
        can_dual_stack: primary.personal.can_dual_stack,
        card_funding: primary.personal.card_funding * scaleFactor,
        loan_funding: primary.personal.loan_funding * scaleFactor,
        total_personal_funding: scaledPersonalFunding
      },
      business: {
        business_age_months: primary.business.business_age_months,
        can_business_fund: primary.business.can_business_fund,
        business_multiplier: primary.business.business_multiplier,
        business_funding: scaledBusinessFunding
      },
      totals: {
        total_personal_funding: scaledPersonalFunding,
        total_business_funding: scaledBusinessFunding,
        total_combined_funding: scaledTotalCombined
      },
      optimization: primary.optimization,
      lite_banner_funding: globalLiteBannerFunding
    };

    // -----------------------------------
    // Redirect block (kept compatible)
    // -----------------------------------
    const redirect = {
      url: globalUnderwrite.fundable
        ? "https://fundhub.ai/confirmation-page-296844-430611"
        : "https://fundhub.ai/confirmation-page-296844-430611-722950",
      query: {
        funding: globalUnderwrite.lite_banner_funding,
        score: globalUnderwrite.metrics.score,
        util: globalUnderwrite.metrics.utilization_pct,
        inqEx: globalUnderwrite.metrics.inquiries.ex,
        inqTu: globalUnderwrite.metrics.inquiries.tu,
        inqEq: globalUnderwrite.metrics.inquiries.eq,
        neg: globalUnderwrite.metrics.negative_accounts,
        late: globalUnderwrite.metrics.late_payment_events
      }
    };

    // -----------------------------------
    // SUCCESS — NEVER FAIL FRONTEND
    // -----------------------------------
    return res.status(200).json({
      ok: true,
      inputs: extracted,          // includes bureaus with names/addresses/employers
      underwrite: globalUnderwrite,
      bureaus: extracted.bureaus, // convenience duplication
      outputs: {
        fundable: globalUnderwrite.fundable,
        banner_estimate: globalUnderwrite.lite_banner_funding,
        negative_accounts: globalUnderwrite.metrics.negative_accounts,
        negatives_count: globalUnderwrite.metrics.negative_accounts,
        late_payment_events: globalUnderwrite.metrics.late_payment_events
      },
      redirect
    });

  } catch (err) {
    console.error("Fatal analyzer failure:", err);
    return res.status(200).json(buildFallbackResult("Fatal analyzer error"));
  }
};
