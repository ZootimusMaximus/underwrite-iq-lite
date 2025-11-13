// ==================================================================================
// UnderwriteIQ LITE — TEXT + LLM Parser
// Option C: Retry + Repair + High Token Limit + Redirect
// Upgraded to PRO logic (cards + loans + business tiers), while keeping
// LITE outputs and GHL redirects stable.
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");

module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// -----------------------------------------------
// SYSTEM PROMPT (Compact JSON)
// -----------------------------------------------
const LLM_PROMPT = `
You are UnderwriteIQ, an AI credit analyst.
You will be given RAW TEXT extracted from a CREDIT REPORT PDF.
Return ONLY VALID COMPACT JSON (ONE LINE). No commentary. No markdown.
If unsure, use null or 0.

Fields:
score
score_model
utilization_pct
inquiries { ex, tu, eq }
negative_accounts
late_payment_events
tradelines[] with:
  - creditor
  - type (revolving | installment | auto | other)
  - status (open | closed | chargeoff | collection | derogatory | etc.)
  - balance
  - limit
  - opened (YYYY-MM or YYYY-MM-DD or null)
  - closed
`;

// -----------------------------------------------
// JSON Extraction Helpers
// -----------------------------------------------
function extractJsonStringFromResponse(json) {
  // Primary: Responses API output_text
  if (json.output_text && json.output_text.trim()) {
    return json.output_text.trim();
  }

  // New format: output[] blocks
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

  // Fallback: old chat-style choices
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
// Single OpenAI Call (Responses API)
// -----------------------------------------------
async function callOpenAIOnce(text) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const payload = {
    model: "gpt-4o-mini",
    input: [
      // System: plain string (NO typed segments here)
      { role: "system", content: LLM_PROMPT },
      // User: typed input_text
      {
        role: "user",
        content: [
          { type: "input_text", text: text.slice(0, 15000) }
        ]
      }
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
// LLM Pipeline with Retry
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
  const month = Number(m[2]); // 1–12
  if (!year || !month) return null;

  const opened = new Date(year, month - 1, 1);
  const now = new Date();
  const yearsDiff = now.getFullYear() - opened.getFullYear();
  const monthsDiff = now.getMonth() - opened.getMonth();
  return yearsDiff * 12 + monthsDiff;
}

// -----------------------------------------------
// UnderwriteIQ PRO Engine
// -----------------------------------------------
//
// This computes:
//  - fundable flag (no inquiries gate)
//  - personal_card_funding
//  - personal_loan_funding
//  - business_funding (0.5x / 1x / 2x tiers)
//  - total_personal_funding / total_business_funding / total_combined_funding
//  - lite_banner_funding for your existing hero range
//
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

  // ---------- FUNDABILITY GATE ----------
  // Inquiries DO NOT block fundability; you remove them before funding.
  const fundable =
    score >= 700 &&
    util <= 30 &&
    neg === 0;

  // ---------- TRADLINE ANALYSIS ----------
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

    if (isDerog) {
      // negative tradeline
    } else {
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

  // ---------- PERSONAL CARD LANE ----------
  const canCardStack =
    highestRevolvingLimit >= 5000 &&
    hasAnyRevolving;

  const personalCardFunding = canCardStack
    ? highestRevolvingLimit * 5.5
    : 0;

  // ---------- PERSONAL LOAN LANE ----------
  const canLoanStack =
    highestInstallmentAmount >= 10000 &&
    hasAnyInstallment &&
    lates === 0; // v1: no lates to loan-stack hard

  const personalLoanFunding = canLoanStack
    ? highestInstallmentAmount * 3.0   // v1 baseline multiplier
    : 0;

  const canDualStack = canCardStack && canLoanStack;
  const totalPersonalFunding = personalCardFunding + personalLoanFunding;

  // ---------- BUSINESS LANE (AGE TIERS) ----------
  // 0–12 months   → 0.5× personal card stack
  // 12–24 months  → 1.0× personal card stack
  // 24+ months    → 2.0× personal card stack
  let businessMultiplier = 0;

  if (fundable && businessAgeMonths != null && personalCardFunding > 0) {
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

  // ---------- LITE BANNER ESTIMATE (for hero range) ----------
  // Use card funding as base (like before). If none, use a safe floor.
  let liteBannerFunding = personalCardFunding;
  if (!liteBannerFunding && fundable) {
    liteBannerFunding = 15000;
  }
  if (!fundable) {
    liteBannerFunding = personalCardFunding || 15000;
  }

  // ---------- OPTIMIZATION FLAGS (for roadmap/emails later) ----------
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
// MAIN HANDLER
// -----------------------------------------------
module.exports = async function handler(req, res) {

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, msg:"Method not allowed" });
  }

  try {
    // Parse file via Formidable (Vercel-safe)
    const form = formidable({
      multiples:false,
      keepExtensions:true,
      uploadDir:"/tmp",
      maxFileSize:25*1024*1024
    });

    const { fields, files } = await new Promise((resolve, reject)=>
      form.parse(req, (err, fields, files)=>{
        if (err) reject(err);
        else resolve({ fields, files });
      })
    );

    const file = files.file;
    if (!file?.filepath) {
      return res.status(400).json({ ok:false, msg:"No file uploaded." });
    }

    const buffer = await fs.promises.readFile(file.filepath);
    const parsedPDF = await pdfParse(buffer);

    const text = (parsedPDF.text || "")
      .replace(/\s+/g," ")
      .trim();

    if (text.length < 50) {
      return res.status(400).json({
        ok:false,
        msg:"Unreadable PDF. Upload a real bureau report."
      });
    }

    // Business age from form (optional)
    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    // Run LLM parser
    const extracted = await runCreditTextLLM(text);

    // PRO underwriting
    const uw = computeUnderwrite(extracted, businessAgeMonths);

    // GHL redirects (unchanged URLs)
    const redirect = {
      url: uw.fundable
        ? "https://fundhub.ai/confirmation-page-296844-430611"             // FUNDING APPROVED
        : "https://fundhub.ai/confirmation-page-296844-430611-722950",     // FIX MY CREDIT
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

    // SUCCESS
    return res.status(200).json({
      ok:true,
      inputs: extracted,
      underwrite: uw,        // PRO data (for dashboards/emails later)
      outputs: {             // LITE data (compatible with current setup)
        fundable: uw.fundable,
        banner_estimate: uw.lite_banner_funding,
        negative_accounts: uw.metrics.negative_accounts,
        negatives_count: uw.metrics.negative_accounts,
        late_payment_events: uw.metrics.late_payment_events
      },
      redirect
    });

  } catch(err) {
    console.error("❌ Parser error:", err);
    return res.status(500).json({
      ok:false,
      msg:"Parser failed",
      error:String(err)
    });
  }
};
