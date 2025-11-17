// ==================================================================================
// UnderwriteIQ LITE — TEXT + LLM Parser (PRO VERSION v2)
// Per-bureau extraction + underwriting + suggestion scaffold
// Accuracy upgrades: larger window, JSON repair, safer numbers, text cleaning
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");

// Increase body limit for large PDFs
module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// Max characters we send to LLM from extracted text
const MAX_TEXT_CHARS = 45000;

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
    suggestions: {
      web_summary: "We received your report and queued it for manual review.",
      email_summary:
        "Our system could not confidently parse your report. A human analyst will review your file and follow up with a custom plan.",
      actions: [],
      au_actions: []
    }
  };
}

// -----------------------------------------------
// SYSTEM PROMPT (PRO · PER BUREAU · COMPACT JSON)
// -----------------------------------------------
const LLM_PROMPT = `
You are UnderwriteIQ.
Extract data PER BUREAU from a consumer credit report.

Return ONLY COMPACT VALID JSON. NO EXTRA TEXT. NO MARKDOWN.

Output:

{
  "bureaus": {
    "experian": {
      "score": number | null,
      "utilization_pct": number | null,
      "inquiries": number | null,
      "negatives": number | null,
      "late_payment_events": number | null,
      "names": string[],
      "addresses": string[],
      "employers": string[],
      "tradelines": [
        {
          "creditor": string | null,
          "type": "revolving" | "installment" | "auto" | "mortgage" | "other" | null,
          "status": string | null,
          "balance": number | null,
          "limit": number | null,
          "opened": "YYYY-MM" | "YYYY-MM-DD" | null,
          "closed": "YYYY-MM" | "YYYY-MM-DD" | null,
          "is_au": boolean | null
        }
      ]
    },
    "equifax": {
      "score": number | null,
      "utilization_pct": number | null,
      "inquiries": number | null,
      "negatives": number | null,
      "late_payment_events": number | null,
      "names": string[],
      "addresses": string[],
      "employers": string[],
      "tradelines": [
        {
          "creditor": string | null,
          "type": "revolving" | "installment" | "auto" | "mortgage" | "other" | null,
          "status": string | null,
          "balance": number | null,
          "limit": number | null,
          "opened": "YYYY-MM" | "YYYY-MM-DD" | null,
          "closed": "YYYY-MM" | "YYYY-MM-DD" | null,
          "is_au": boolean | null
        }
      ]
    },
    "transunion": {
      "score": number | null,
      "utilization_pct": number | null,
      "inquiries": number | null,
      "negatives": number | null,
      "late_payment_events": number | null,
      "names": string[],
      "addresses": string[],
      "employers": string[],
      "tradelines": [
        {
          "creditor": string | null,
          "type": "revolving" | "installment" | "auto" | "mortgage" | "other" | null,
          "status": string | null,
          "balance": number | null,
          "limit": number | null,
          "opened": "YYYY-MM" | "YYYY-MM-DD" | null,
          "closed": "YYYY-MM" | "YYYY-MM-DD" | null,
          "is_au": boolean | null
        }
      ]
    }
  }
}

Rules:
- If a bureau is missing, set that bureau to null or empty arrays.
- If unsure, use null.
- Do NOT invent or guess creditor names.
- Do NOT include any explanation, commentary, or markdown.
- Output ONLY JSON, nothing else.
`;

// =====================================================
// TEXT CLEANER — handles boilerplate / AnnualCreditReport style
// =====================================================
function cleanCreditReportText(raw) {
  if (!raw) return "";

  let text = String(raw);

  // Normalize whitespace
  text = text.replace(/\r/g, " ").replace(/\t/g, " ");

  // Strip common boilerplate / page headers / footers
  text = text
    .replace(/Page \d+ of \d+/gi, " ")
    .replace(/Viewing your credit report online.*/gi, " ")
    .replace(/For assistance call .*?(\n|$)/gi, " ")
    .replace(/This information is supplied by .*/gi, " ")
    .replace(/www\.annualcreditreport\.com.*/gi, " ");

  // Collapse huge whitespace runs
  text = text.replace(/\s{3,}/g, " ");

  return text.trim();
}

// =====================================================
// 🆕 PART 1 — LLM OUTPUT NORMALIZER
// =====================================================
function normalizeLLMOutput(str) {
  return String(str || "")
    .replace(/\r/g, "")
    .replace(/\t+/g, " ")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

// =====================================================
// 🆕 PART 2 — JSON STRING EXTRACTOR
// =====================================================
function extractJsonStringFromResponse(json) {
  // 1. Direct output_text (Responses API)
  if (json.output_text && typeof json.output_text === "string") {
    return json.output_text.trim();
  }

  // 2. Responses API — output[]
  if (Array.isArray(json.output)) {
    for (const msg of json.output) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (
          (block.type === "output_text" || block.type === "summary_text") &&
          typeof block.text === "string"
        ) {
          return block.text.trim();
        }
      }
    }
  }

  // 3. Legacy chat.completions format
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

// =====================================================
// 🆕 PART 3 — JSON REPAIR PARSER (MULTI-LINE + FIXES)
// =====================================================
function tryParseJsonWithRepair(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("No raw JSON text to parse.");
  }

  const cleaned = normalizeLLMOutput(raw);

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Could not locate JSON object in model output.");
  }

  let fixed = cleaned.substring(first, last + 1);

  // 1. Fix trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  // 2. Quote unquoted keys: { key: ... } => { "key": ... }
  fixed = fixed.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

  // 3. Fix unquoted string values (simple heuristic)
  fixed = fixed.replace(
    /:\s*([A-Za-z][A-Za-z0-9 _\-]*)\s*(,|\})/g,
    (m, val, end) => {
      if (val.startsWith('"') || /^[0-9.\-]+$/.test(val)) return `:${val}${end}`;
      if (val === "null" || val === "NaN") return `:null${end}`;
      return `:"${val}"${end}`;
    }
  );

  // 4. Quote YYYY-MM / YYYY-MM-DD date-like fields
  fixed = fixed.replace(/:\s*(\d{4}-\d{2}(?:-\d{2})?)/g, ':"$1"');

  // 5. Convert "key = value" into "key: value"
  fixed = fixed.replace(/=\s*/g, ": ");

  try {
    return JSON.parse(fixed);
  } catch (err) {
    console.error("JSON REPAIR FAILED. Preview:", fixed.slice(0, 200));
    throw new Error("JSON parse failed (after repair): " + err.message);
  }
}

// =====================================================
// NUMBER HELPERS — avoid NaN / bogus 0s
// =====================================================
function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const trimmed = v.trim().toLowerCase();
    if (!trimmed || trimmed === "null" || trimmed === "nan" || trimmed === "na") {
      return null;
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNumberOrZero(v) {
  const n = toNumberOrNull(v);
  return n == null ? 0 : n;
}

// -----------------------------------------------
// PER-BUREAU NORMALIZER
// -----------------------------------------------
function normalizeBureau(b) {
  if (!b || typeof b !== "object") {
    return {
      score: null,
      utilization_pct: null,
      inquiries: null,
      negatives: null,
      late_payment_events: null,
      names: [],
      addresses: [],
      employers: [],
      tradelines: []
    };
  }
  return {
    score: toNumberOrNull(b.score),
    utilization_pct: toNumberOrNull(b.utilization_pct),
    inquiries: toNumberOrNull(b.inquiries),
    negatives: toNumberOrNull(b.negatives),
    late_payment_events: toNumberOrNull(b.late_payment_events),
    names: Array.isArray(b.names) ? b.names : [],
    addresses: Array.isArray(b.addresses) ? b.addresses : [],
    employers: Array.isArray(b.employers) ? b.employers : [],
    tradelines: Array.isArray(b.tradelines) ? b.tradelines : []
  };
}

// -----------------------------------------------
// Single LLM Call — Responses API (patched, gpt-4o)
// -----------------------------------------------
async function callOpenAIOnce(text) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const cleaned = cleanCreditReportText(text).slice(0, MAX_TEXT_CHARS);

  const payload = {
    // Primary model for accuracy; you can change via env if needed
    model: process.env.UNDERWRITE_IQ_MODEL || "gpt-4o",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [{ type: "input_text", text: cleaned }]
      }
    ],
    temperature: 0,
    max_output_tokens: 4096
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
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
      console.error(`UnderwriteIQ LLM attempt ${i} failed:`, String(err));

      if (
        String(err).includes("LLM HTTP error") ||
        String(err).includes("LLM refusal") ||
        String(err).includes("Missing UNDERWRITE_IQ_VISION_KEY")
      ) {
        break;
      }

      await new Promise((r) => setTimeout(r, 150 * i));
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

// ===============================================================
// PRO UNDERWRITING ENGINE (Per Bureau + Aggregate)
// ===============================================================
function computeUnderwrite(bureaus, businessAgeMonthsRaw) {
  const safeBureaus = bureaus || {};

  const ex = normalizeBureau(safeBureaus.experian);
  const eq = normalizeBureau(safeBureaus.equifax);
  const tu = normalizeBureau(safeBureaus.transunion);

  const exInq = toNumberOrZero(ex.inquiries);
  const eqInq = toNumberOrZero(eq.inquiries);
  const tuInq = toNumberOrZero(tu.inquiries);
  const totalInq = exInq + eqInq + tuInq;

  function buildBureauSummary(key, label, b) {
    const rawScore = toNumberOrNull(b.score);
    const score = rawScore == null ? 0 : rawScore;

    const rawUtil = toNumberOrNull(b.utilization_pct);
    const util = rawUtil == null ? 0 : rawUtil;

    const neg = toNumberOrZero(b.negatives);
    const lates = toNumberOrZero(b.late_payment_events);
    const tradelines = Array.isArray(b.tradelines) ? b.tradelines : [];

    let highestRevolvingLimit = 0;
    let highestInstallmentAmount = 0;
    let hasAnyRevolving = false;
    let hasAnyInstallment = false;
    let positiveTradelinesCount = 0;
    let fileAllNegative = false;

    for (const tl of tradelines) {
      const type = String(tl.type || "").toLowerCase();
      const status = String(tl.status || "").toLowerCase();
      const limit = toNumberOrZero(tl.limit);
      const balance = toNumberOrZero(tl.balance);
      const ageMonths = monthsSince(tl.opened);

      const isDerog =
        status.includes("chargeoff") ||
        status.includes("charge-off") ||
        status.includes("collection") ||
        status.includes("derog") ||
        status.includes("repossession") ||
        status.includes("foreclosure") ||
        status.includes("severe");

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

      if (type === "installment" || type === "auto" || type === "mortgage") {
        hasAnyInstallment = true;
        const originalAmount = limit || balance;
        if (originalAmount > 0 && seasoned && !isDerog) {
          if (originalAmount > highestInstallmentAmount) {
            highestInstallmentAmount = originalAmount;
          }
        }
      }
    }

    fileAllNegative = positiveTradelinesCount === 0 && neg > 0;
    const thinFile = positiveTradelinesCount < 3;

    const canCardStack = highestRevolvingLimit >= 5000 && hasAnyRevolving;
    const cardFunding = canCardStack ? highestRevolvingLimit * 5.5 : 0;

    const canLoanStack =
      highestInstallmentAmount >= 10000 && hasAnyInstallment && lates === 0;
    const loanFunding = canLoanStack ? highestInstallmentAmount * 3.0 : 0;

    const canDualStack = canCardStack && canLoanStack;
    const totalPersonalFunding = cardFunding + loanFunding;

    const fundable = rawScore != null && rawScore >= 700 && rawUtil != null && rawUtil <= 30 && neg === 0;

    return {
      key,
      label,
      rawScore,
      rawUtil,
      score,
      util,
      neg,
      lates,
      inquiries: toNumberOrZero(b.inquiries),
      tradelines,
      highestRevolvingLimit,
      highestInstallmentAmount,
      hasAnyRevolving,
      hasAnyInstallment,
      thinFile,
      fileAllNegative,
      canCardStack,
      canLoanStack,
      canDualStack,
      cardFunding,
      loanFunding,
      totalPersonalFunding,
      fundable,
      positiveTradelinesCount
    };
  }

  const bureauSummaries = [
    buildBureauSummary("experian", "Experian", ex),
    buildBureauSummary("equifax", "Equifax", eq),
    buildBureauSummary("transunion", "TransUnion", tu)
  ];

  // Primary = highest score bureau
  let primary = bureauSummaries[0];
  for (const b of bureauSummaries) {
    if ((b.rawScore || 0) > (primary.rawScore || 0)) {
      primary = b;
    }
  }

  const businessAgeMonths =
    typeof businessAgeMonthsRaw === "number" && Number.isFinite(businessAgeMonthsRaw)
      ? businessAgeMonthsRaw
      : null;

  const fundableBureaus = bureauSummaries.filter((b) => b.fundable);
  const fundableCount = fundableBureaus.length;

  const totalCardFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.cardFunding || 0),
    0
  );
  const totalLoanFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.loanFunding || 0),
    0
  );

  let scale = 1;
  if (fundableCount === 1) {
    scale = 1 / 3;
  }

  const cardFunding = totalCardFundingBase * scale;
  const loanFunding = totalLoanFundingBase * scale;
  const totalPersonalFunding = cardFunding + loanFunding;

  let businessMultiplier = 0;
  if (businessAgeMonths != null && primary.cardFunding > 0) {
    if (businessAgeMonths < 12) {
      businessMultiplier = 0.5;
    } else if (businessAgeMonths < 24) {
      businessMultiplier = 1.0;
    } else {
      businessMultiplier = 2.0;
    }
  }

  const canBusinessFund = businessMultiplier > 0;
  const businessFunding = primary.cardFunding * businessMultiplier;
  const totalBusinessFunding = businessFunding;
  const totalCombinedFunding = totalPersonalFunding + totalBusinessFunding;

  const needsUtilReduction = (primary.rawUtil != null ? primary.rawUtil : primary.util) > 30;
  const needsNewPrimaryRevolving =
    !primary.hasAnyRevolving || primary.highestRevolvingLimit < 5000;
  const needsInquiryCleanup = totalInq > 0;
  const needsNegativeCleanup = primary.neg > 0;
  const needsFileBuildOut = primary.thinFile || primary.fileAllNegative;

  const optimization = {
    needs_util_reduction: needsUtilReduction,
    target_util_pct: needsUtilReduction ? 30 : null,
    needs_new_primary_revolving: needsNewPrimaryRevolving,
    needs_inquiry_cleanup: needsInquiryCleanup,
    needs_negative_cleanup: needsNegativeCleanup,
    needs_file_buildout: needsFileBuildOut,
    thin_file: primary.thinFile,
    file_all_negative: primary.fileAllNegative
  };

  let liteBannerFunding = primary.cardFunding || cardFunding;
  const primaryScore = primary.rawScore != null ? primary.rawScore : primary.score;
  const primaryUtil = primary.rawUtil != null ? primary.rawUtil : primary.util;

  if (!liteBannerFunding && primaryScore >= 700 && primaryUtil <= 30 && primary.neg === 0) {
    liteBannerFunding = 15000;
  }
  if (primaryScore < 700 || primaryUtil > 30 || primary.neg !== 0) {
    liteBannerFunding = liteBannerFunding || 15000;
  }

  const fundable =
    primaryScore >= 700 &&
    primaryUtil <= 30 &&
    primary.neg === 0 &&
    totalPersonalFunding > 0;

  return {
    fundable,
    primary_bureau: primary.key,
    metrics: {
      score: primaryScore,
      utilization_pct: primaryUtil,
      negative_accounts: primary.neg,
      late_payment_events: primary.lates,
      inquiries: {
        ex: exInq,
        tu: tuInq,
        eq: eqInq,
        total: totalInq
      }
    },
    per_bureau: {
      experian: {
        score: bureauSummaries[0].rawScore,
        utilization_pct: bureauSummaries[0].rawUtil,
        negatives: bureauSummaries[0].neg,
        late_payment_events: bureauSummaries[0].lates,
        inquiries: bureauSummaries[0].inquiries,
        thin_file: bureauSummaries[0].thinFile,
        file_all_negative: bureauSummaries[0].fileAllNegative,
        card_funding: bureauSummaries[0].cardFunding,
        loan_funding: bureauSummaries[0].loanFunding,
        total_personal_funding: bureauSummaries[0].totalPersonalFunding,
        fundable: bureauSummaries[0].fundable
      },
      equifax: {
        score: bureauSummaries[1].rawScore,
        utilization_pct: bureauSummaries[1].rawUtil,
        negatives: bureauSummaries[1].neg,
        late_payment_events: bureauSummaries[1].lates,
        inquiries: bureauSummaries[1].inquiries,
        thin_file: bureauSummaries[1].thinFile,
        file_all_negative: bureauSummaries[1].fileAllNegative,
        card_funding: bureauSummaries[1].cardFunding,
        loan_funding: bureauSummaries[1].loanFunding,
        total_personal_funding: bureauSummaries[1].totalPersonalFunding,
        fundable: bureauSummaries[1].fundable
      },
      transunion: {
        score: bureauSummaries[2].rawScore,
        utilization_pct: bureauSummaries[2].rawUtil,
        negatives: bureauSummaries[2].neg,
        late_payment_events: bureauSummaries[2].lates,
        inquiries: bureauSummaries[2].inquiries,
        thin_file: bureauSummaries[2].thinFile,
        file_all_negative: bureauSummaries[2].fileAllNegative,
        card_funding: bureauSummaries[2].cardFunding,
        loan_funding: bureauSummaries[2].loanFunding,
        total_personal_funding: bureauSummaries[2].totalPersonalFunding,
        fundable: bureauSummaries[2].fundable
      }
    },
    personal: {
      highest_revolving_limit: primary.highestRevolvingLimit,
      highest_installment_amount: primary.highestInstallmentAmount,
      can_card_stack: primary.canCardStack,
      can_loan_stack: primary.canLoanStack,
      can_dual_stack: primary.canDualStack,
      card_funding: cardFunding,
      loan_funding: loanFunding,
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

// ============================================================================
// SUGGESTION ENGINE (PRO VERSION)
// ============================================================================
function buildSuggestions(bureaus, uw) {
  const primaryKey = uw.primary_bureau;
  const p = uw.metrics;

  const score = typeof p.score === "number" ? p.score : null;
  const util = typeof p.utilization_pct === "number" ? p.utilization_pct : null;
  const negatives = typeof p.negative_accounts === "number" ? p.negative_accounts : 0;
  const inquiries = typeof p.inquiries.total === "number" ? p.inquiries.total : 0;
  const late = typeof p.late_payment_events === "number" ? p.late_payment_events : 0;

  const actions = [];
  const au_actions = [];

  // Utilization guidance
  if (typeof util === "number" && Number.isFinite(util)) {
    if (util > 30) {
      actions.push(
        `Your utilization is about ${util}%. To maximize approvals, bring each card down to the 3–10% range before applying.`
      );
    } else {
      actions.push(
        `Your utilization is in a solid range. Keeping each card between 3–10% will help you qualify for higher limits.`
      );
    }
  } else {
    actions.push(
      `We couldn't accurately read utilization from this PDF, but the goal is simple: keep each card between 3–10% before you apply for new funding.`
    );
  }

  if (negatives > 0) {
    actions.push(
      `You have ${negatives} negative accounts. Removing or repairing these increases approval odds.`
    );
  }

  if (inquiries > 0) {
    actions.push(
      `You have ${inquiries} total inquiries. Reducing inquiries before applying boosts approval chances.`
    );
  }

  const allBureaus = [
    bureaus.experian.tradelines,
    bureaus.equifax.tradelines,
    bureaus.transunion.tradelines
  ];

  const flattened = allBureaus.flat().filter((tl) => tl && typeof tl === "object");

  flattened.forEach((tl) => {
    if (tl.is_au === true) {
      const bal = toNumberOrZero(tl.balance);
      const lim = toNumberOrZero(tl.limit) || 1;
      const ratio = (bal / lim) * 100;

      if (ratio > 30) {
        au_actions.push(
          `Authorized user account "${tl.creditor}" is about ${ratio.toFixed(
            1
          )}% utilized. Ask the primary to pay this down or remove you as an AU to instantly improve your utilization.`
        );
      }

      const st = String(tl.status || "").toLowerCase();
      if (st.includes("charge") || st.includes("collection") || st.includes("derog")) {
        au_actions.push(
          `Authorized user account "${tl.creditor}" is reporting negative. Ask the primary to fix it or remove you from the account immediately.`
        );
      }
    }
  });

  if (uw.optimization.needs_file_buildout) {
    actions.push(
      `Your file is thin. Adding 1–2 primary accounts (or strategic authorized users with low utilization and no negatives) will boost credibility.`
    );
  }

  if (negatives === 0 && inquiries === 0 && util != null && util <= 30) {
    actions.push(
      "You are positioned for a credit limit increase. Consider requesting CLIs after your utilization is reduced and stable for at least 1–2 statement cycles."
    );
  }

  const webSummary = (() => {
    let s = `Your strongest bureau is ${primaryKey.toUpperCase()}. `;
    if (!uw.fundable) {
      s += `You're close — here’s what to fix next for maximum funding:`;
    } else {
      s += `You're fundable right now. Here’s how to maximize your approvals:`;
    }
    return s;
  })();

  const emailSummary = `
Your strongest funding bureau is **${primaryKey.toUpperCase()}**.

To maximize the amount of credit you can receive, focus on the following:

Score: ${score !== null ? score : "N/A"}
Utilization: ${util !== null ? util + "%" : "N/A"}
Negatives: ${negatives}
Inquiries: ${inquiries}
Late Payments: ${late}

We recommend cleaning up utilization, inquiries, and any negative items before requesting new credit or applying for funding.
`.trim();

  return {
    web_summary: webSummary,
    email_summary: emailSummary,
    actions,
    au_actions
  };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================
module.exports = async function handler(req, res) {
  try {
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
    const pdf = await pdfParse(buffer);

    const rawText = (pdf.text || "");
    const text = cleanCreditReportText(rawText);

    if (!text || text.length < 200) {
      return res.status(200).json(buildFallbackResult("Not enough text extracted"));
    }

    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    let extracted;
    try {
      if (!text || text.trim().length < 500) {
        return res.status(200).json(buildFallbackResult("Not enough text extracted."));
      }

      extracted = await runCreditTextLLM(text);

      if (!extracted || typeof extracted !== "object") {
        return res.status(200).json(buildFallbackResult("Analyzer returned invalid JSON"));
      }

      if (!("bureaus" in extracted)) {
        return res
          .status(200)
          .json(buildFallbackResult("Analyzer failed: missing bureau object"));
      }
    } catch (err) {
      console.error("Analyzer crash:", err);
      return res
        .status(200)
        .json(buildFallbackResult("Analyzer crashed: " + String(err)));
    }

    const bureaus = {
      experian: normalizeBureau(extracted?.bureaus?.experian),
      equifax: normalizeBureau(extracted?.bureaus?.equifax),
      transunion: normalizeBureau(extracted?.bureaus?.transunion)
    };

    let uw;
    try {
      uw = computeUnderwrite(bureaus, businessAgeMonths);
    } catch (err) {
      console.error("Underwrite crash:", err);
      return res
        .status(200)
        .json(buildFallbackResult("Underwriting engine crashed"));
    }

    const suggestions = buildSuggestions(bureaus, uw);

    const redirect = {
      url: uw.fundable
        ? "https://fundhub.ai/confirmation-page-296844-430611"
        : "https://fundhub.ai/confirmation-page-296844-430611-722950",
      query: {
        bureau: uw.primary_bureau,
        funding: uw.lite_banner_funding,
        personal: uw.personal?.total_personal_funding,
        business: uw.business?.business_funding,
        total: uw.totals?.total_combined_funding
      }
    };

    return res.status(200).json({
      ok: true,
      bureaus,
      underwrite: uw,
      suggestions,
      redirect
    });
  } catch (err) {
    console.error("Fatal analyzer failure:", err);
    return res.status(200).json(buildFallbackResult("Fatal analyzer error"));
  }
};
