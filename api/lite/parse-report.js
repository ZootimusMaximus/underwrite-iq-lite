// ==================================================================================
// UnderwriteIQ LITE — TEXT + LLM Parser (PRO VERSION)
// Per-bureau extraction + underwriting + suggestion scaffold
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
// SMALL HELPERS
// -----------------------------------------------
function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const trimmed = v.trim().toLowerCase();
    if (trimmed === "" || trimmed === "null" || trimmed === "none" || trimmed === "n/a") {
      return null;
    }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toNumberOrZero(v) {
  const n = toNumberOrNull(v);
  return n == null ? 0 : n;
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
- Match each tradeline to the correct bureau.
- If a bureau is missing, set that bureau to null or empty arrays.
- If unsure, use null.
- Do NOT invent or guess creditor names.
- Do NOT include any explanation, commentary, or markdown.
- Output ONLY JSON, nothing else.
`;

// =====================================================
// PART 1 — LLM OUTPUT NORMALIZER
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
// PART 2 — JSON STRING EXTRACTOR (Responses / Chat)
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
// PART 3 — JSON REPAIR PARSER (MULTI-OBJECT SAFE)
// =====================================================
function tryParseJsonWithRepair(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("No raw JSON text to parse.");
  }

  const cleaned = normalizeLLMOutput(raw);

  // Find all balanced {...} regions outside of strings
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else {
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(cleaned.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  if (!candidates.length) {
    throw new Error("Could not locate JSON object in model output.");
  }

  // Try candidates from largest to smallest (prefer the most detailed)
  candidates.sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    let fixed = candidate;

    // 1. Fix trailing commas before } or ]
    fixed = fixed.replace(/,\s*([}\]])/g, "$1");

    // 2. Quote unquoted keys: { key: ... } => { "key": ... }
    fixed = fixed.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

    // 3. Fix unquoted string values (simple heuristic)
    fixed = fixed.replace(
      /:\s*([A-Za-z][A-Za-z0-9 _\-]*)\s*(,|\})/g,
      (m, val, end) => {
        // Skip if already quoted or numeric
        if (val.startsWith('"') || /^[0-9.\-]+$/.test(val)) return `:${val}${end}`;
        return `:"${val}"${end}`;
      }
    );

    // 4. Quote YYYY-MM / YYYY-MM-DD date-like values if unquoted
    fixed = fixed.replace(/:\s*(\d{4}-\d{2}(?:-\d{2})?)/g, ':"$1"');

    try {
      return JSON.parse(fixed);
    } catch (err) {
      // Try next candidate
      continue;
    }
  }

  throw new Error("JSON parse failed (after repair) for all candidates.");
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

  const rawTradelines = Array.isArray(b.tradelines) ? b.tradelines : [];

  const tradelines = rawTradelines.map((tl) => {
    if (!tl || typeof tl !== "object") return null;
    const isAu =
      tl.is_au === true ||
      tl.is_au === "true" ||
      tl.is_au === "TRUE" ||
      tl.is_au === "Yes" ||
      tl.is_au === "yes";

    return {
      creditor: tl.creditor || null,
      type: tl.type || null,
      status: tl.status || null,
      balance: toNumberOrNull(tl.balance),
      limit: toNumberOrNull(tl.limit),
      opened: tl.opened || null,
      closed: tl.closed || null,
      is_au: isAu
    };
  }).filter(Boolean);

  return {
    score: toNumberOrNull(b.score),
    utilization_pct: toNumberOrNull(b.utilization_pct),
    inquiries: toNumberOrNull(b.inquiries),
    negatives: toNumberOrNull(b.negatives),
    late_payment_events: toNumberOrNull(b.late_payment_events),
    names: Array.isArray(b.names) ? b.names : [],
    addresses: Array.isArray(b.addresses) ? b.addresses : [],
    employers: Array.isArray(b.employers) ? b.employers : [],
    tradelines
  };
}

// -----------------------------------------------
// MERGE BUREAU OBJECTS ACROSS CHUNKS
// -----------------------------------------------
function mergeSingleBureau(base, next) {
  if (!base) return next;
  if (!next) return base;

  const result = { ...base };

  function pickNumeric(field, strategy = "max") {
    const a = toNumberOrNull(base[field]);
    const b = toNumberOrNull(next[field]);
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    if (strategy === "max") return Math.max(a, b);
    if (strategy === "sum") return a + b;
    return b;
  }

  result.score = pickNumeric("score", "max");
  result.utilization_pct = pickNumeric("utilization_pct", "max");
  result.inquiries = pickNumeric("inquiries", "sum");
  result.negatives = pickNumeric("negatives", "sum");
  result.late_payment_events = pickNumeric("late_payment_events", "sum");

  result.names = Array.from(new Set([...(base.names || []), ...(next.names || [])]));
  result.addresses = Array.from(new Set([...(base.addresses || []), ...(next.addresses || [])]));
  result.employers = Array.from(new Set([...(base.employers || []), ...(next.employers || [])]));

  const baseTls = Array.isArray(base.tradelines) ? base.tradelines : [];
  const nextTls = Array.isArray(next.tradelines) ? next.tradelines : [];
  result.tradelines = [...baseTls, ...nextTls];

  return result;
}

function mergeBureausObjects(a, b) {
  if (!a && !b) return null;
  const safeA = a || {};
  const safeB = b || {};

  return {
    experian: mergeSingleBureau(safeA.experian || null, safeB.experian || null),
    equifax: mergeSingleBureau(safeA.equifax || null, safeB.equifax || null),
    transunion: mergeSingleBureau(safeA.transunion || null, safeB.transunion || null)
  };
}

// -----------------------------------------------
// Single LLM Call — Responses API (GPT-4 family)
// -----------------------------------------------
async function callOpenAIOnce(textChunk) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const payload = {
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [{ type: "input_text", text: textChunk }]
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
// Chunk helper for large PDFs
// -----------------------------------------------
function chunkText(text, maxChars = 15000) {
  const chunks = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

// -----------------------------------------------
// LLM Pipeline with Retry + Chunk Merge
// -----------------------------------------------
async function runCreditTextLLM(fullText) {
  const chunks = chunkText(fullText, 15000);
  let mergedExtraction = null;
  let lastError = null;

  for (const chunk of chunks) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const out = await callOpenAIOnce(chunk);

        if (!out || typeof out !== "object" || !out.bureaus) {
          throw new Error("LLM returned invalid JSON shape");
        }

        const normalizedChunkBureaus = {
          experian: normalizeBureau(out.bureaus.experian),
          equifax: normalizeBureau(out.bureaus.equifax),
          transunion: normalizeBureau(out.bureaus.transunion)
        };

        mergedExtraction = mergedExtraction
          ? mergeBureausObjects(mergedExtraction, normalizedChunkBureaus)
          : normalizedChunkBureaus;

        break; // successful, break retry loop
      } catch (err) {
        lastError = err;
        console.error("UnderwriteIQ LLM chunk attempt failed:", String(err));

        const msg = String(err || "");
        if (
          msg.includes("Missing UNDERWRITE_IQ_VISION_KEY") ||
          msg.includes("LLM refusal") ||
          msg.includes("context_length_exceeded")
        ) {
          throw err;
        }

        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  }

  if (!mergedExtraction) {
    throw new Error("LLM failed after retries: " + String(lastError));
  }

  return mergedExtraction;
}

// -----------------------------------------------
// Helpers
// -----------------------------------------------
function getNumberField(fields, key) {
  if (!fields || fields[key] == null) return null;
  const raw = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
  return toNumberOrNull(raw);
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
    const score = toNumberOrZero(b.score);
    const util = toNumberOrZero(b.utilization_pct);
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
  const p = uw.metrics;

  const score = p.score;
  const util = p.utilization_pct;
  const negatives = p.negative_accounts;
  const inquiries = p.inquiries.total;
  const late = p.late_payment_events;

  const actions = [];
  const au_actions = [];

  // Utilization guidance (only if we have a real number)
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

  if (typeof negatives === "number" && negatives > 0) {
    actions.push(
      `You have ${negatives} negative accounts. Removing or repairing these increases approval odds.`
    );
  }

  if (typeof inquiries === "number" && inquiries > 0) {
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
          )}% utilized. Removing it improves your utilization instantly.`
        );
      }

      const st = String(tl.status || "").toLowerCase();
      if (st.includes("charge") || st.includes("collection") || st.includes("derog")) {
        au_actions.push(
          `Authorized user account "${tl.creditor}" is reporting negative. Ask the primary cardholder to remove you from this card.`
        );
      }
    }
  });

  if (uw.optimization.needs_file_buildout) {
    actions.push(
      `Your file is thin. Adding 1–2 primary accounts (or strategic authorized users) will boost credibility.`
    );
  }

  if (
    typeof negatives === "number" &&
    typeof inquiries === "number" &&
    typeof util === "number" &&
    negatives === 0 &&
    inquiries === 0 &&
    util <= 30
  ) {
    actions.push(
      "You are positioned for a credit limit increase. Consider requesting CLIs after your utilization is reduced into the 3–10% range."
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

Score: ${score}
Utilization: ${util}%
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
    const text = (pdf.text || "").replace(/\s+/g, " ").trim();

    if (!text || text.length < 200) {
      return res.status(200).json(buildFallbackResult("Not enough text extracted"));
    }

    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    let bureaus;
    try {
      if (!text || text.trim().length < 500) {
        return res.status(200).json(buildFallbackResult("Not enough text extracted."));
      }

      const extracted = await runCreditTextLLM(text);

      if (!extracted || typeof extracted !== "object") {
        return res.status(200).json(buildFallbackResult("Analyzer returned invalid JSON"));
      }

      bureaus = {
        experian: normalizeBureau(extracted.experian || extracted?.bureaus?.experian),
        equifax: normalizeBureau(extracted.equifax || extracted?.bureaus?.equifax),
        transunion: normalizeBureau(extracted.transunion || extracted?.bureaus?.transunion)
      };
    } catch (err) {
      console.error("Analyzer crash:", err);
      return res
        .status(200)
        .json(buildFallbackResult("Analyzer crashed: " + String(err)));
    }

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
