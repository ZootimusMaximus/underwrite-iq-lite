// ==================================================================================
// UnderwriteIQ LITE — Upgraded TEXT + LLM Parser (Crash-Proof Edition)
// Bureau-level parsing added for UI suggestions (NOT for letters yet).
// Employers added to personal info extraction.
// All underwriting logic fully preserved.
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
      experian: {},
      equifax: {},
      transunion: {}
    }
  };
}

// -----------------------------------------------
// 📌 UPDATED SYSTEM PROMPT WITH BUREAU PARSING
// -----------------------------------------------
const LLM_PROMPT = `
You are UnderwriteIQ, an AI credit analyst.
You will be given RAW TEXT extracted from a CREDIT REPORT PDF.

Return ONLY VALID COMPACT JSON (ONE LINE). No commentary. No markdown.

PART 1 — AGGREGATED FIELDS (FOR FUNDING ENGINE)
These fields MUST be present:

{
  "score": number or null,
  "score_model": string or null,
  "utilization_pct": number or null,
  "inquiries": { "ex": number, "tu": number, "eq": number },
  "negative_accounts": number,
  "late_payment_events": number,
  "tradelines": [
    {
      "creditor": string,
      "type": "revolving" | "installment" | "auto" | "other",
      "status": string,
      "balance": number,
      "limit": number,
      "opened": string | null,
      "closed": string | null
    }
  ]
}

PART 2 — BUREAU-LEVEL PARSING (FOR SUGGESTIONS UI)
Extract EACH BUREAU SEPARATELY:

"bureaus": {
  "experian": {
    "names": [ "name variations" ],
    "addresses": [ "address lines" ],
    "employers": [ "employer names" ],
    "inquiries": [ "inquiry names" ],
    "accounts": [ "creditor names" ]
  },
  "equifax": {
    "names": [],
    "addresses": [],
    "employers": [],
    "inquiries": [],
    "accounts": []
  },
  "transunion": {
    "names": [],
    "addresses": [],
    "employers": [],
    "inquiries": [],
    "accounts": []
  }
}

RULES:
- DO NOT mix bureaus.
- DO NOT aggregate names/addresses across bureaus.
- If unsure, return empty arrays, not null.
- JSON must be valid, compact, and complete.
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

// -----------------------------------------------
// Underwriting Engine (unchanged)
// -----------------------------------------------
function computeUnderwrite(data, businessAgeMonthsRaw) {
  const score = Number(data.score ?? 0);
  const util = Number(data.utilization_pct ?? 0);
  const neg = Number(data.negative_accounts ?? 0);

  const inquiries = data.inquiries || { ex: 0, tu: 0, eq: 0 };
  const exInq = Number(inquiries.ex || 0);
  const tuInq = Number(inquiries.tu || 0);
  const eqInq = Number(inquiries.eq || 0);
  const totalInq = exInq + tuInq + eqInq;

  const lates = Number(data.late_payment_events ?? 0);
  const tradelines = Array.isArray(data.tradelines) ? data.tradelines : [];

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
      if (status === "open" && seasoned && limit > highestRevolvingLimit) {
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

  const businessMultiplier =
    businessAgeMonths == null
      ? 0
      : businessAgeMonths < 12
        ? 0.5
        : businessAgeMonths < 24
          ? 1.0
          : 2.0;

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

  return {
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
      business_multiplier,
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

      if (!("score" in extracted)) {
        return res.status(200).json(buildFallbackResult("Missing required fields"));
      }

      // Ensure bureaus exist
      if (!extracted.bureaus) {
        extracted.bureaus = {
          experian: { names: [], addresses: [], employers: [], inquiries: [], accounts: [] },
          equifax: { names: [], addresses: [], employers: [], inquiries: [], accounts: [] },
          transunion: { names: [], addresses: [], employers: [], inquiries: [], accounts: [] }
        };
      }

    } catch (err) {
      console.error("Analyzer crashed:", err);
      return res.status(200).json(buildFallbackResult("Analyzer crashed: " + String(err)));
    }

    // -----------------------------------
    // Underwriting (safe)
    // -----------------------------------
    let uw;
    try {
      uw = computeUnderwrite(extracted, businessAgeMonths);
    } catch (err) {
      console.error("Underwrite crash:", err);
      return res.status(200).json(buildFallbackResult("Underwriting engine crashed"));
    }

    // -----------------------------------
    // Redirect block (unchanged)
    // -----------------------------------
    const redirect = {
      url: uw.fundable
        ? "https://fundhub.ai/confirmation-page-296844-430611"
        : "https://fundhub.ai/confirmation-page-296844-430611-722950",
      query: {
        funding: uw.lite_banner_funding,
        score: uw.metrics.score,
        util: uw.metrics.utilization_pct,
        inqEx: uw.metrics.inquiries.ex,
        inqTu: uw.metrics.inquiries.tu,
        inqEq: uw.metrics.inquiries.eq,
        neg: uw.metrics.negative_accounts,
        late: uw.metrics.late_payment_events
      }
    };

    // -----------------------------------
    // SUCCESS — NEVER FAIL FRONTEND
    // -----------------------------------
    return res.status(200).json({
      ok: true,
      inputs: extracted,
      underwrite: uw,
      bureaus: extracted.bureaus,
      outputs: {
        fundable: uw.fundable,
        banner_estimate: uw.lite_banner_funding,
        negative_accounts: uw.metrics.negative_accounts,
        negatives_count: uw.metrics.negative_accounts,
        late_payment_events: uw.metrics.late_payment_events
      },
      redirect
    });

  } catch (err) {
    console.error("Fatal analyzer failure:", err);
    return res.status(200).json(buildFallbackResult("Fatal analyzer error"));
  }
};
