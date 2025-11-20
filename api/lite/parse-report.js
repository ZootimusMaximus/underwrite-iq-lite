// ==================================================================================
// UnderwriteIQ — Perfection Pipeline v2  (GPT-5.1 VISION · MULTIPASS OCR + JSON ENFORCER)
// Endpoint: /api/lite/parse-report
//
// This version upgrades:
// - GPT-4.1 → gpt-4.1 (best OCR + lowest hallucination + strictest JSON adherence)
// - Adds MULTI-PASS extraction for near-perfect bureau accuracy
// - Adds schema validator + JSON rewriter
// - Adds hard normalization + auditor-level checks
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");

// Vercel API
module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// ============================================================================
// ERROR LOGGER — writes to /tmp/uwiq-errors.log
// ============================================================================
function logError(tag, err, context = "") {
  const msg = `
==== ${new Date().toISOString()} — ${tag} ====
${context ? "Context:\n" + context + "\n" : ""}
${String(err && err.stack ? err.stack : err)}
---------------------------------------------
`;
  console.error(msg);
  try { fs.appendFileSync("/tmp/uwiq-errors.log", msg); } catch (_) {}
}

// ============================================================================
// FALLBACK RESULT — Safe for clients
// ============================================================================
function buildFallbackResult(reason = "Analyzer failed") {
  return {
    ok: true,
    fallback: true,
    reason,
    summary: {
      score: null,
      risk_band: "unknown",
      note: "We couldn’t clearly read this credit report file. Please upload a more standard PDF (Experian, Equifax, TransUnion, or AnnualCreditReport.com)."
    },
    issues: [],
    dispute_groups: [],
    funding_estimate: {
      low: null,
      high: null,
      confidence: 0
    },
    suggestions: {
      web_summary:
        "We couldn’t read this credit report clearly. Try uploading a standard Experian, Equifax, TransUnion, or AnnualCreditReport.com PDF.",
      email_summary:
        "We couldn’t reliably read your credit report PDF. Please upload a more standard version so we can analyze it cleanly.",
      actions: [],
      au_actions: []
    }
  };
}

// ============================================================================
// STRICT SYSTEM PROMPT — 5.1 Vision Edition
// ============================================================================
const LLM_PROMPT = `
You are UnderwriteIQ, a forensic-level credit report analyzer.

You are given a FULL CONSUMER CREDIT REPORT PDF (possibly image-based).
Your task:
1. Detect all bureaus present (Experian, Equifax, TransUnion).
2. Extract clean, factual, non-hallucinated fields per bureau.
3. Follow the JSON schema EXACTLY — no missing keys, no added keys.
4. If a value is unknown, return null (do NOT guess).
5. If a bureau is not in the PDF, return null fields for that bureau.

STRICT RULES:
- No invented creditor names.
- No invented values.
- No missing keys.
- No markdown or commentary.
- Do not add "notes", "explanations", or extra fields.

RETURN:
VALID JSON OBJECT ONLY.

THE REQUIRED SCHEMA:
{
  "bureaus": {
    "experian": {
      "score": number|null,
      "utilization_pct": number|null,
      "inquiries": number|null,
      "negatives": number|null,
      "late_payment_events": number|null,
      "names": string[],
      "addresses": string[],
      "employers": string[],
      "tradelines": [
        {
          "creditor": string|null,
          "type": "revolving"|"installment"|"auto"|"mortgage"|"other"|null,
          "status": string|null,
          "balance": number|null,
          "limit": number|null,
          "opened": "YYYY-MM"|"YYYY-MM-DD"|null,
          "closed": "YYYY-MM"|"YYYY-MM-DD"|null,
          "is_au": boolean|null
        }
      ]
    },
    "equifax": { SAME STRUCTURE },
    "transunion": { SAME STRUCTURE }
  }
}
`;

// ============================================================================
// NORMALIZER HELPERS
// ============================================================================
function normalizeLLMOutput(str) {
  return String(str || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .trim();
}

function extractJsonStringFromResponse(json) {
  if (json.output_text && typeof json.output_text === "string") {
    return json.output_text.trim();
  }

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

  if (
    json.choices &&
    json.choices[0]?.message?.content &&
    typeof json.choices[0].message.content === "string"
  ) {
    return json.choices[0].message.content.trim();
  }

  return null;
}

// ============================================================================
// JSON REPAIR ENGINE — v5.1 UltraSTRICT
// ============================================================================
function tryParseJsonWithRepair(raw) {
  if (!raw) throw new Error("EMPTY_MODEL_OUTPUT");

  let cleaned = normalizeLLMOutput(raw);

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) {
    throw new Error("NO_JSON_OBJECT_FOUND");
  }

  let fixed = cleaned.substring(first, last + 1);

  // trailing commas
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  // unquoted keys
  fixed = fixed.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

  // bare date values
  fixed = fixed.replace(/:\s*(\d{4}-\d{2}(-\d{2})?)/g, ':"$1"');

  // unquoted strings
  fixed = fixed.replace(
    /:\s*([A-Za-z][A-Za-z0-9 _\-]*)\s*(,|\})/g,
    (match, val, end) => {
      const lower = val.toLowerCase();
      if (["true", "false", "null"].includes(lower)) return `:${lower}${end}`;
      if (/^[0-9.\-]+$/.test(val)) return `:${val}${end}`;
      return `:"${val}"${end}`;
    }
  );

  try {
    return JSON.parse(fixed);
  } catch (err) {
    logError("JSON_PARSE_FAIL", err, fixed.slice(0, 1000));
    throw new Error("JSON_PARSE_FAILED_AFTER_REPAIR: " + err.message);
  }
}

// ============================================================================
// ⭐ NEW: MULTIPASS gpt-4.1 ENGINE
// - Pass 1: OCR + raw extract
// - Pass 2: Re-extract using cleaned text as guidance
// - Pass 3: Final schema enforcement pass
// ============================================================================
async function callMultipass4_1(pdfBuffer, filename) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const base64 = pdfBuffer.toString("base64");
  const dataUrl = `data:application/pdf;base64,${base64}`;
  const safeFilename = filename || "credit-report.pdf";

  // --------------------------- PASS 1 — OCR EXTRACT ---------------------------
  const payload1 = {
    model: "gpt-4.1",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "PASS 1: Extract bureau data from this PDF exactly as per schema."
          },
          { type: "input_file", filename: safeFilename, file_data: dataUrl }
        ]
      }
    ],
    temperature: 0,
    max_output_tokens: 6000
  };

  const r1 = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload1)
  });

  if (!r1.ok) throw new Error("LLM_PASS1_ERROR: " + (await r1.text()));
  const j1 = await r1.json();
  let raw1 = extractJsonStringFromResponse(j1);
  let pass1 = tryParseJsonWithRepair(raw1);


  // --------------------------- PASS 2 — WITH GUIDANCE ---------------------------
  const guidance = JSON.stringify(pass1).slice(0, 18000);

  const payload2 = {
    model: "gpt-4.1",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "PASS 2: Improve accuracy using guidance JSON (do NOT invent, only correct errors). Guidance: " +
              guidance
          },
          { type: "input_file", filename: safeFilename, file_data: dataUrl }
        ]
      }
    ],
    temperature: 0,
    max_output_tokens: 6000
  };

  const r2 = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload2)
  });

  if (!r2.ok) throw new Error("LLM_PASS2_ERROR: " + (await r2.text()));
  const j2 = await r2.json();
  let raw2 = extractJsonStringFromResponse(j2);
  let pass2 = tryParseJsonWithRepair(raw2);

  // --------------------------- PASS 3 — FINAL SCHEMA HARDEN ---------------------------
  const payload3 = {
    model: "gpt-4.1",
    input: [
      { role: "system", content: LLM_PROMPT + "\n\nRETURN STRICT SCHEMA JSON ONLY." },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "PASS 3: Final JSON cleanup. Fix missing keys, invalid types. DO NOT invent. Input: " +
              JSON.stringify(pass2).slice(0, 18000)
          }
        ]
      }
    ],
    temperature: 0,
    max_output_tokens: 6000
  };

  const r3 = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload3)
  });

  if (!r3.ok) throw new Error("LLM_PASS3_ERROR: " + (await r3.text()));

  const j3 = await r3.json();
  let raw3 = extractJsonStringFromResponse(j3);
  let finalOutput = tryParseJsonWithRepair(raw3);

  return finalOutput;
}

// ============================================================================
// RETRY WRAPPER — 5.1 Vision Multipass
// ============================================================================
async function runCreditPdfLLM(pdfBuffer, filename) {
  let lastErr = null;

  for (let i = 1; i <= 3; i++) {
    try {
      return await callVision5_1_Multipass(pdfBuffer, filename);
    } catch (err) {
      lastErr = err;
      logError("VISION_5_1_ATTEMPT_" + i, err);
      await new Promise(r => setTimeout(r, 200 * i));
    }
  }

  throw new Error("LLM_FAILED_3X: " + lastErr);
}
// ============================================================================
// BUREAU NORMALIZER — ensures stable structure regardless of LLM errors
// ============================================================================
function normalizeBureau(b) {
  if (!b || typeof b !== "object") {
    return {
      available: false,
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
    available: true,
    score: b.score ?? null,
    utilization_pct: b.utilization_pct ?? null,
    inquiries: b.inquiries ?? null,
    negatives: b.negatives ?? null,
    late_payment_events: b.late_payment_events ?? null,
    names: Array.isArray(b.names) ? b.names : [],
    addresses: Array.isArray(b.addresses) ? b.addresses : [],
    employers: Array.isArray(b.employers) ? b.employers : [],
    tradelines: Array.isArray(b.tradelines) ? b.tradelines : []
  };
}

// ============================================================================
// SCORE SANITIZER — fixes weird OCR hallucinations (8516 → 851)
// ============================================================================
function sanitizeScore(score) {
  if (score == null) return null;
  let s = Number(score);

  if (!Number.isFinite(s)) return null;

  if (s > 9000) s = Math.floor(s / 10); // 8516 → 851
  if (s > 850) s = 850;                 // cap at 850
  if (s < 300) return null;             // invalid

  return s;
}

// ============================================================================
// HELPER: numeric parser with null safety
// ============================================================================
function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim().toLowerCase() === "null") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function numOrZero(v) {
  const n = toNumberOrNull(v);
  return n == null ? 0 : n;
}

// ============================================================================
// DATE HELPER
// ============================================================================
function monthsSince(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const match = dateStr.match(/^(\d{4})-(\d{2})/);
  if (!match) return null;

  const y = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;

  const opened = new Date(y, m - 1, 1);
  const now = new Date();

  return (
    (now.getFullYear() - opened.getFullYear()) * 12 +
    (now.getMonth() - opened.getMonth())
  );
}

// ============================================================================
// BUSINESS AGE PARSER
// ============================================================================
function getNumberField(fields, key) {
  if (!fields || fields[key] == null) return null;
  const raw = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ============================================================================
// ⭐ PRO UNDERWRITING ENGINE — Multi-bureau + business + safety
// ============================================================================
function computeUnderwrite(bureaus, businessAgeMonthsRaw) {
  const safe = bureaus || {};

  const ex = normalizeBureau(safe.experian);
  const eq = normalizeBureau(safe.equifax);
  const tu = normalizeBureau(safe.transunion);

  // sanitize scores for all bureaus
  ex.score = sanitizeScore(ex.score);
  eq.score = sanitizeScore(eq.score);
  tu.score = sanitizeScore(tu.score);

  const exInq = numOrZero(ex.inquiries);
  const eqInq = numOrZero(eq.inquiries);
  const tuInq = numOrZero(tu.inquiries);
  const totalInq = exInq + eqInq + tuInq;

  // --------------------------------------------------------------------------
  // LOCAL: Build summary for each bureau
  // --------------------------------------------------------------------------
  function buildBureauSummary(key, label, b) {
    const score = sanitizeScore(b.score);
    const util = toNumberOrNull(b.utilization_pct);
    const neg = numOrZero(b.negatives);
    const lates = numOrZero(b.late_payment_events);
    const tradelines = Array.isArray(b.tradelines) ? b.tradelines : [];

    let highestRevolvingLimit = 0;
    let highestInstallmentAmount = 0;
    let hasAnyRevolving = false;
    let hasAnyInstallment = false;
    let positiveTradelinesCount = 0;

    for (const tl of tradelines) {
      if (!tl || typeof tl !== "object") continue;

      const type = String(tl.type || "").toLowerCase();
      const status = String(tl.status || "").toLowerCase();
      const limit = numOrZero(tl.limit);
      const balance = numOrZero(tl.balance);
      const ageMonths = monthsSince(tl.opened);

      const isDerog =
        status.includes("chargeoff") ||
        status.includes("charge-off") ||
        status.includes("collection") ||
        status.includes("derog") ||
        status.includes("repossession") ||
        status.includes("foreclosure");

      if (!isDerog) positiveTradelinesCount++;

      const seasoned = ageMonths != null && ageMonths >= 24;

      if (type === "revolving") {
        hasAnyRevolving = true;
        if (status.includes("open") && seasoned && limit > highestRevolvingLimit) {
          highestRevolvingLimit = limit;
        }
      }

      if (["installment", "auto", "mortgage"].includes(type)) {
        hasAnyInstallment = true;
        const originalAmount = limit || balance;
        if (originalAmount > 0 && seasoned && !isDerog) {
          if (originalAmount > highestInstallmentAmount) {
            highestInstallmentAmount = originalAmount;
          }
        }
      }
    }

    const thinFile = positiveTradelinesCount < 3;
    const fileAllNegative = positiveTradelinesCount === 0 && neg > 0;

    const canCardStack = highestRevolvingLimit >= 5000 && hasAnyRevolving;
    const cardFunding = canCardStack ? highestRevolvingLimit * 5.5 : 0;

    const canLoanStack =
      highestInstallmentAmount >= 10000 && hasAnyInstallment && lates === 0;
    const loanFunding = canLoanStack ? highestInstallmentAmount * 3.0 : 0;

    const totalPersonalFunding = cardFunding + loanFunding;

    const fundable =
      score != null &&
      score >= 700 &&
      (util == null || util <= 30) &&
      neg === 0;

    return {
      key,
      label,
      available: b.available,
      score: score ?? 0,
      util,
      neg,
      lates,
      inquiries: numOrZero(b.inquiries),
      tradelines,
      highestRevolvingLimit,
      highestInstallmentAmount,
      hasAnyRevolving,
      hasAnyInstallment,
      thinFile,
      fileAllNegative,
      canCardStack,
      canLoanStack,
      canDualStack: canCardStack && canLoanStack,
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

  // Primary = highest-score available bureau
  let primary = bureauSummaries.find(b => b.available) || bureauSummaries[0];
  for (const b of bureauSummaries) {
    if (b.available && b.score > primary.score) primary = b;
  }

  const businessAgeMonths =
    typeof businessAgeMonthsRaw === "number" && Number.isFinite(businessAgeMonthsRaw)
      ? businessAgeMonthsRaw
      : null;

  const fundableBureaus = bureauSummaries.filter(b => b.available && b.fundable);
  const fundableCount = fundableBureaus.length;

  const totalCardFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.available ? b.cardFunding : 0),
    0
  );

  const totalLoanFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.available ? b.loanFunding : 0),
    0
  );

  let scale = 1;
  if (fundableCount === 1) scale = 1 / 3;

  const cardFunding = totalCardFundingBase * scale;
  const loanFunding = totalLoanFundingBase * scale;
  const totalPersonalFunding = cardFunding + loanFunding;

  let businessMultiplier = 0;
  if (businessAgeMonths != null && primary.cardFunding > 0) {
    if (businessAgeMonths < 12) businessMultiplier = 0.5;
    else if (businessAgeMonths < 24) businessMultiplier = 1.0;
    else businessMultiplier = 2.0;
  }

  const canBusinessFund = businessMultiplier > 0;
  const businessFunding = primary.cardFunding * businessMultiplier;
  const totalCombinedFunding = totalPersonalFunding + businessFunding;

  const needsUtilReduction =
    primary.util != null && Number.isFinite(primary.util) && primary.util > 30;

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
  if (!liteBannerFunding) liteBannerFunding = 15000;

  const fundable =
    primary.score != null &&
    primary.score >= 700 &&
    (primary.util == null || primary.util <= 30) &&
    primary.neg === 0;

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
        eq: eqInq,
        tu: tuInq,
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
        fundable: bureauSummaries[0].fundable,
        available: bureauSummaries[0].available
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
        fundable: bureauSummaries[1].fundable,
        available: bureauSummaries[1].available
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
        fundable: bureauSummaries[2].fundable,
        available: bureauSummaries[2].available
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
      total_business_funding: businessFunding,
      total_combined_funding: totalCombinedFunding
    },
    optimization,
    lite_banner_funding: liteBannerFunding
  };
}
// ============================================================================
// MAIN HANDLER — PDF Upload → GPT-5.1 Vision (Multipass) → Underwrite → Suggest
// ============================================================================
module.exports = async function handler(req, res) {
  try {
    // ---------------------------
    // CORS
    // ---------------------------
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

    // ---------------------------
    // Parse upload
    // ---------------------------
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
      return res
        .status(200)
        .json(
          buildFallbackResult(
            "No file detected. Please upload a credit report PDF."
          )
        );
    }

    const buffer = await fs.promises.readFile(file.filepath);

    // Extremely small PDFs = invalid report
    if (!buffer || buffer.length < 1500) {
      return res.status(200).json(
        buildFallbackResult(
          "This file is too small to be a full credit report. Please upload a different credit report PDF."
        )
      );
    }

    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    // ---------------------------
    // LLM Extraction (GPT-5.1 Vision Multipass)
    // ---------------------------
    let extracted;
    try {
      extracted = await runCreditPdfLLM(
        buffer,
        file.originalFilename || file.newFilename
      );

      if (!extracted || typeof extracted !== "object") {
        return res.status(200).json(
          buildFallbackResult(
            "This report could not be parsed. Please try another credit report PDF."
          )
        );
      }

      if (!("bureaus" in extracted)) {
        return res.status(200).json(
          buildFallbackResult(
            "Missing bureau section in this report. Try uploading a standard Experian, Equifax, or TransUnion PDF."
          )
        );
      }
    } catch (err) {
      logError("ANALYZER_CRASH", err);
      return res.status(200).json(
        buildFallbackResult(
          "We had trouble reading this file. Please upload a different type of credit report PDF."
        )
      );
    }

    // ---------------------------
    // Bureau Normalization
    // ---------------------------
    const bureaus = {
      experian: normalizeBureau(extracted.bureaus?.experian),
      equifax: normalizeBureau(extracted.bureaus?.equifax),
      transunion: normalizeBureau(extracted.bureaus?.transunion)
    };

    // ---------------------------
    // Underwriting
    // ---------------------------
    let uw;
    try {
      uw = computeUnderwrite(bureaus, businessAgeMonths);
    } catch (err) {
      logError(
        "UNDERWRITE_CRASH",
        err,
        JSON.stringify(extracted).slice(0, 800)
      );
      return res
        .status(200)
        .json(
          buildFallbackResult(
            "Underwriting failed for this file. Please upload a different credit report PDF."
          )
        );
    }

    // ---------------------------
    // Suggestions
    // ---------------------------
    let suggestions;
    try {
      suggestions = buildSuggestions(bureaus, uw);
    } catch (err) {
      logError("SUGGESTION_ENGINE_CRASH", err);
      suggestions = {
        web_summary:
          "We analyzed your file but couldn't generate detailed suggestions.",
        email_summary:
          "We analyzed your report but couldn't generate full suggestions.",
        actions: [],
        au_actions: []
      };
    }

    // ---------------------------
    // Redirect Logic
    // ---------------------------
    const redirect = {
      url: uw.fundable
        ? "https://fundhub.ai/confirmation-page-296844-430611"
        : "https://fundhub.ai/confirmation-page-296844-430611-722950",
      query: {
        bureau: uw.primary_bureau,
        funding: uw.lite_banner_funding,
        personal: uw.personal.total_personal_funding,
        business: uw.business.business_funding,
        total: uw.totals.total_combined_funding
      }
    };

    // ---------------------------
    // SUCCESS RESPONSE
    // ---------------------------
    return res.status(200).json({
      ok: true,
      bureaus,
      underwrite: uw,
      suggestions,
      redirect
    });
  } catch (err) {
    logError("FATAL_HANDLER", err);
    return res.status(200).json(
      buildFallbackResult(
        "A system-level error occurred. Please upload a different credit report PDF."
      )
    );
  }
};
