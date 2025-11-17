// ==================================================================================
// UnderwriteIQ LITE — TEXT + LLM Parser (UNIFIED PRO VERSION)
// Per-bureau extraction + underwriting + suggestion scaffold
// GPT-4.1 + JSON auto-repair + annualcreditreport.com PDFs
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");

// Vercel API config
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
Extract data PER BUREAU from a consumer credit report PDF (including annualcreditreport.com style reports).

Return ONLY STRICT, COMPACT VALID JSON. NO EXTRA TEXT. NO MARKDOWN. NO COMMENTS.

Schema:

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
- Work directly from the report text, including annualcreditreport.com layout.
- If a bureau is completely missing, still include its key with nulls/empty arrays.
- If unsure, use null.
- Do NOT invent or guess creditor names.
- Do NOT include any explanation, commentary, or markdown.
- Output ONLY a single JSON object, nothing before or after.
`;

// =====================================================
// LLM OUTPUT NORMALIZER
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
// JSON STRING EXTRACTOR (Responses API + legacy)
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
          if (block.text.trim()) return block.text.trim();
        }
      }
    }
  }

  // 3. Legacy chat.completions format (just in case)
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
// JSON REPAIR PARSER (MULTI-LINE + HEURISTIC FIXES)
// =====================================================
function tryParseJsonWithRepair(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("No raw JSON text to parse.");
  }

  let cleaned = normalizeLLMOutput(raw);

  // Handle rare case of two JSON objects stuck together: {...}{...}
  const lastBrace = cleaned.lastIndexOf("{");
  if (lastBrace > 0) {
    // Take from last top-level object if multiple were concatenated
    cleaned = cleaned.slice(lastBrace);
  }

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Could not locate JSON object in model output.");
  }

  let fixed = cleaned.substring(first, last + 1);

  // ---- Heuristic repairs (minimal but effective) ----

  // 1. Fix trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  // 2. Quote unquoted keys: { key: ... } => { "key": ... }
  fixed = fixed.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

  // 3. Quote date-like values (YYYY-MM / YYYY-MM-DD) that are bare
  fixed = fixed.replace(/:\s*(\d{4}-\d{2}(?:-\d{2})?)(\s*[},])/g, ':"$1"$2');

  // 4. Convert = to : if the model ever uses key = value
  fixed = fixed.replace(/=\s*/g, ": ");

  // 5. Unify "null" (string) to null where obvious (simple pass; full coercion later)
  fixed = fixed.replace(/:\s*"null"(\s*[},])/g, ": null$1");

  try {
    return JSON.parse(fixed);
  } catch (err) {
    console.error("JSON REPAIR FAILED. Preview:", fixed.slice(0, 200));
    throw new Error("JSON parse failed (after repair): " + err.message);
  }
}

// =====================================================
// PRIMITIVE SANITIZERS
// =====================================================
function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (v === "null") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBoolOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.toLowerCase().trim();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return null;
}

function toStringOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  return String(v);
}

function toStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => (typeof x === "string" ? x.trim() : String(x || "")))
    .filter((s) => s.length > 0);
}

// =====================================================
// PER-BUREAU NORMALIZER
// =====================================================
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

  const rawTradelines = Array.isArray(b.tradelines) ? b.tradelines : [];
  const tradelines = rawTradelines.map((tl) => {
    if (!tl || typeof tl !== "object") return null;
    return {
      creditor: toStringOrNull(tl.creditor),
      type: toStringOrNull(tl.type),
      status: toStringOrNull(tl.status),
      balance: toNumberOrNull(tl.balance),
      limit: toNumberOrNull(tl.limit),
      opened: toStringOrNull(tl.opened),
      closed: toStringOrNull(tl.closed),
      is_au: toBoolOrNull(tl.is_au)
    };
  }).filter(Boolean);

  return {
    score: toNumberOrNull(b.score),
    utilization_pct: toNumberOrNull(b.utilization_pct),
    inquiries: toNumberOrNull(b.inquiries),
    negatives: toNumberOrNull(b.negatives),
    late_payment_events: toNumberOrNull(b.late_payment_events),
    names: toStringArray(b.names),
    addresses: toStringArray(b.addresses),
    employers: toStringArray(b.employers),
    tradelines
  };
}

// -----------------------------------------------
// Single LLM Call — Responses API (GPT-4.1)
// -----------------------------------------------
async function callOpenAIOnce(text) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const payload = {
    model: "gpt-4.1",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            // Allow up to ~50k chars to handle big annualcreditreport PDFs
            text: text.slice(0, 50000)
          }
        ]
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

  const cleanedRaw = normalizeLLMOutput(raw);
  return tryParseJsonWithRepair(cleanedRaw);
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

  const exInq = toNumberOrNull(ex.inquiries) || 0;
  const eqInq = toNumberOrNull(eq.inquiries) || 0;
  const tuInq = toNumberOrNull(tu.inquiries) || 0;
  const totalInq = exInq + eqInq + tuInq;

  function buildBureauSummary(key, label, b) {
    const score = toNumberOrNull(b.score) || 0;
    const util = toNumberOrNull(b.utilization_pct) || 0;
    const neg = toNumberOrNull(b.negatives) || 0;
    const lates = toNumberOrNull(b.late_payment_events) || 0;
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
      const limit = toNumberOrNull(tl.limit) || 0;
      const balance = toNumberOrNull(tl.balance) || 0;
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

    fileAllNegative = positiveTradelinesCount === 0 && neg > 0;
    const thinFile = positiveTradelinesCount < 3;

    const canCardStack = highestRevolvingLimit >= 5000 && hasAnyRevolving;
    const cardFunding = canCardStack ? highestRevolvingLimit * 5.5 : 0;

    const canLoanStack =
      highestInstallmentAmount >= 10000 && hasAnyInstallment && lates === 0;
    const loanFunding = canLoanStack ? highestInstallmentAmount * 3.0 : 0;

    const canDualStack = canCardStack && canLoanStack;
    const totalPersonalFunding = cardFunding + loanFunding;

    const fundable = score >= 700 && util <= 30 && neg === 0;

    return {
      key,
      label,
      score,
      util,
      neg,
      lates,
      inquiries: toNumberOrNull(b.inquiries) || 0,
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

  // Primary bureau: highest score (ties fall back to first non-zero)
  let primary = bureauSummaries[0];
  for (const b of bureauSummaries) {
    if (b.score > primary.score) {
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

  // If only ONE bureau is fundable, scale down by 1/3 (bank sees 3 bureaus)
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

  const needsUtilReduction = primary.util > 30;
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
  if (!liteBannerFunding && primary.score >= 700 && primary.util <= 30 && primary.neg === 0) {
    liteBannerFunding = 15000;
  }
  if (primary.score < 700 || primary.util > 30 || primary.neg !== 0) {
    liteBannerFunding = liteBannerFunding || 15000;
  }

  const fundable =
    primary.score >= 700 &&
    primary.util <= 30 &&
    primary.neg === 0 &&
    totalPersonalFunding > 0;

  return {
    fundable,
    primary_bureau: primary.key,
    metrics: {
      score: primary.score,
      utilization_pct: primary.util,
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
        score: bureauSummaries[0].score,
        utilization_pct: bureauSummaries[0].util,
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
        score: bureauSummaries[1].score,
        utilization_pct: bureauSummaries[1].util,
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
        score: bureauSummaries[2].score,
        utilization_pct: bureauSummaries[2].util,
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
  const p = uw.metrics || {};

  const score = toNumberOrNull(p.score);
  const util = toNumberOrNull(p.utilization_pct);
  const negatives = toNumberOrNull(p.negative_accounts) || 0;
  const inquiries = toNumberOrNull(p.inquiries && p.inquiries.total) || 0;
  const late = toNumberOrNull(p.late_payment_events) || 0;

  const actions = [];
  const au_actions = [];

  // Utilization guidance
  if (typeof util === "number" && Number.isFinite(util)) {
    if (util > 30) {
      actions.push(
        `Your utilization is about ${util}%. To maximize approvals, bring each card down to the 3–10% range before applying for new credit or funding.`
      );
    } else {
      actions.push(
        `Your utilization is in a solid range. Keeping each card between 3–10% will help you qualify for higher limits and better approvals.`
      );
    }
  } else {
    actions.push(
      `We couldn't precisely read your utilization from this PDF, but the rule is simple: keep each card between 3–10% before you apply for new funding.`
    );
  }

  if (negatives > 0) {
    actions.push(
      `You have about ${negatives} negative account(s). Removing or repairing these will increase your approval odds and potential limits.`
    );
  }

  if (inquiries > 0) {
    actions.push(
      `You have about ${inquiries} total inquiries. Reducing recent hard inquiries before applying can meaningfully boost approvals.`
    );
  }

  // AU logic
  const allBureaus = [
    (bureaus.experian && bureaus.experian.tradelines) || [],
    (bureaus.equifax && bureaus.equifax.tradelines) || [],
    (bureaus.transunion && bureaus.transunion.tradelines) || []
  ];

  const flattened = allBureaus.flat().filter((tl) => tl && typeof tl === "object");

  flattened.forEach((tl) => {
    if (tl.is_au === true) {
      const bal = toNumberOrNull(tl.balance) || 0;
      const lim = toNumberOrNull(tl.limit) || 1;
      const ratio = (bal / lim) * 100;

      if (ratio > 30) {
        au_actions.push(
          `Authorized user account "${tl.creditor || "Unknown AU"}" is about ${ratio.toFixed(
            1
          )}% utilized. Have the primary cardholder pay this down or remove you as an AU to instantly improve your utilization.`
        );
      }

      const st = String(tl.status || "").toLowerCase();
      if (st.includes("charge") || st.includes("collection") || st.includes("derog")) {
        au_actions.push(
          `Authorized user account "${tl.creditor || "Unknown AU"}" is reporting negative. Ask the primary cardholder to remove you as an authorized user immediately.`
        );
      }
    }
  });

  if (uw.optimization && uw.optimization.needs_file_buildout) {
    actions.push(
      `Your file is considered thin. Adding 1–2 new primary accounts (or carefully chosen authorized users) will help you look stronger to lenders.`
    );
  }

  if (negatives === 0 && inquiries === 0 && typeof util === "number" && util <= 30) {
    actions.push(
      "You are positioned for a credit limit increase. Consider requesting CLIs once your utilization is in the 3–10% range on each card."
    );
  }

  const webSummary = (() => {
    let s = `Your strongest bureau is ${String(primaryKey || "").toUpperCase() || "UNKNOWN"}. `;
    if (!uw.fundable) {
      s += `You're close — here’s what to fix next for maximum funding:`;
    } else {
      s += `You're fundable right now. Here’s how to maximize your approvals and limits:`;
    }
    return s;
  })();

  const emailSummary = `
Your strongest funding bureau is **${String(primaryKey || "").toUpperCase() || "UNKNOWN"}**.

To maximize the amount of credit you can receive, focus on the following:

Score: ${score != null ? score : "N/A"}
Utilization: ${util != null ? util + "%" : "N/A"}
Negatives: ${negatives}
Inquiries: ${inquiries}
Late Payments: ${late}

We recommend:
- Bringing each revolving card down into the 3–10% utilization range.
- Reducing recent hard inquiries where possible before applying.
- Removing or repairing any negative accounts.
- Cleaning up any high-utilization or negative authorized user accounts.

Once these steps are handled, your approval odds and potential funding amounts increase significantly.
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
    // CORS + preflight
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

    // Parse multipart form
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
    if (!file || !file.filepath) {
      return res.status(200).json(buildFallbackResult("No file uploaded"));
    }

    const buffer = await fs.promises.readFile(file.filepath);
    const pdf = await pdfParse(buffer);
    const text = (pdf.text || "").replace(/\s+/g, " ").trim();

    // Minimal text guard — protects against images-only or garbage PDFs
    if (!text || text.length < 200) {
      return res.status(200).json(buildFallbackResult("Not enough text extracted"));
    }

    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    let extracted;
    try {
      // Slightly higher guard before LLM (prevents super tiny junk)
      if (!text || text.trim().length < 400) {
        return res.status(200).json(buildFallbackResult("Not enough text extracted."));
      }

      extracted = await runCreditTextLLM(text);

      if (!extracted || typeof extracted !== "object") {
        return res.status(200).json(buildFallbackResult("Analyzer returned invalid JSON"));
      }

      if (!("bureaus" in extracted)) {
        return res
          .status(200)
          .json(buildFallbackResult("Analyzer failed: missing bureaus object"));
      }
    } catch (err) {
      console.error("Analyzer crash:", err);
      return res
        .status(200)
        .json(buildFallbackResult("Analyzer crashed: " + String(err)));
    }

    const bureaus = {
      experian: normalizeBureau(extracted.bureaus && extracted.bureaus.experian),
      equifax: normalizeBureau(extracted.bureaus && extracted.bureaus.equifax),
      transunion: normalizeBureau(extracted.bureaus && extracted.bureaus.transunion)
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
        personal: uw.personal && uw.personal.total_personal_funding,
        business: uw.business && uw.business.business_funding,
        total: uw.totals && uw.totals.total_combined_funding
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
