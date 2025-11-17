// ==================================================================================
// UnderwriteIQ — FULL PRO VERSION (Patch v8.0 — GPT-4.1 VISION, PDF DIRECT)
// Includes:
// - GPT-4.1 model (vision-capable, using PDF input_file)
// - No pdf-parse: model reads the raw PDF directly
// - Score sanitizer
// - Bureau availability logic
// - Massive JSON repair engine
// - Stronger type classifier
// - Error logging subsystem
// - User-facing fallbacks = "try a different credit report PDF"
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");

// Vercel API Config — handles large PDFs + file upload
module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// ============================================================================
// ERROR LOGGER — writes to /tmp/uwiq-errors.log (persists during runtime)
// ============================================================================
function logError(tag, err, context = "") {
  const msg = `
==== ${new Date().toISOString()} — ${tag} ====
${context ? "Context:\n" + context + "\n" : ""}
${String(err)}
---------------------------------------------
`;
  console.error(msg);
  try {
    fs.appendFileSync("/tmp/uwiq-errors.log", msg);
  } catch (_) {}
}

// ============================================================================
// FALLBACK RESULT — user-safe, no “manual review” language
// ============================================================================
function buildFallbackResult(reason = "Analyzer failed") {
  return {
    ok: true,
    fallback: true,
    reason,
    summary: {
      score: null,
      risk_band: "unknown",
      note:
        "We couldn't clearly read this credit report file. Please try uploading a different credit report PDF (Experian, Equifax, TransUnion, or AnnualCreditReport.com)."
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
        "We had trouble reading this specific credit report file. Please try again using a more standard PDF version such as Experian, Equifax, TransUnion, or AnnualCreditReport.com.",
      email_summary:
        "Our system couldn't reliably read the credit report file that was uploaded. Please try again using a more standard PDF version from Experian, Equifax, TransUnion, or AnnualCreditReport.com so we can run a clean analysis for you.",
      actions: [],
      au_actions: []
    }
  };
}

// ============================================================================
// GPT-4.1 SYSTEM PROMPT
// ============================================================================
const LLM_PROMPT = `
You are UnderwriteIQ. Extract FULL per-bureau data from a consumer credit report.

OUTPUT STRICTLY:
- VALID JSON ONLY
- NO markdown
- NO explanations
- NO commentary
- NO guesses about creditor names

Modeling rules:
- If a bureau does not appear → return null for all fields.
- If score missing (AnnualCreditReport™) → score = null.
- Never invent tradelines.

TYPE CLASSIFICATION RULES:
- Revolving if: credit card, AMEX, Chase, Citi, Capital One, Discover, Synchrony, etc.
- Installment if: personal loan, student loan, finance loan.
- Auto if lender mentions Auto, Hyundai, Ford Credit, Toyota, Santander Auto, etc.
- Mortgage if lender mentions Mortgage, Home Loan, PennyMac, Rocket, FHA, VA, etc.
- Otherwise type = "other".

The output schema:

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
   "equifax": { same structure },
   "transunion": { same structure }
 }
}

Return ONLY JSON.
`;

// ============================================================================
// NORMALIZER — strips markdown / fences / whitespace
// ============================================================================
function normalizeLLMOutput(str) {
  return String(str || "")
    .replace(/\r/g, "")
    .replace(/\t+/g, " ")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

// ============================================================================
// JSON EXTRACTOR — supports Responses API and Chat API outputs
// ============================================================================
function extractJsonStringFromResponse(json) {
  // Responses API "output_text"
  if (json.output_text && typeof json.output_text === "string") {
    return json.output_text.trim();
  }

  // Responses API "output" array
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

  // Chat Completions format (legacy)
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

// ============================================================================
// MASSIVE JSON REPAIR ENGINE — guarantees valid JSON or throws
// ============================================================================
function tryParseJsonWithRepair(raw) {
  if (!raw) throw new Error("No raw JSON from model.");

  let cleaned = normalizeLLMOutput(raw);

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) {
    throw new Error("Model output contains no JSON object.");
  }

  let fixed = cleaned.substring(first, last + 1);

  // Remove trailing commas
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  // Quote keys
  fixed = fixed.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

  // Quote date-like values
  fixed = fixed.replace(/:\s*(\d{4}-\d{2}(-\d{2})?)/g, ':"$1"');

  // Auto-quote simple barewords
  fixed = fixed.replace(
    /:\s*([A-Za-z][A-Za-z0-9 _\-]*)\s*(,|\})/g,
    (m, val, end) => {
      if (val.startsWith('"') || /^[0-9.\-]+$/.test(val)) return `:${val}${end}`;
      return `:"${val}"${end}`;
    }
  );

  try {
    return JSON.parse(fixed);
  } catch (err) {
    logError("JSON_PARSE_REPAIR_FAIL", err, fixed.slice(0, 500));
    throw new Error("JSON parse failed: " + err.message);
  }
}

// ============================================================================
// BUREAU NORMALIZER — ensures structure never breaks
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
// SCORE SANITIZER — fixes weird values like 8516 / 9350
// ============================================================================
function sanitizeScore(score) {
  if (score == null) return null;
  let s = Number(score);

  if (s > 9000) s = Math.floor(s / 10);
  if (s > 850) s = 850;
  if (s < 300) return null;

  return s;
}

// ============================================================================
// GPT-4.1 CALL — core LLM call (PDF via input_file)
// ============================================================================
async function callOpenAIOnce(pdfBuffer, filename) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const base64 = pdfBuffer.toString("base64");
  const dataUrl = `data:application/pdf;base64,${base64}`;
  const safeFilename = filename || "credit-report.pdf";

  const payload = {
    model: "gpt-4.1",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Extract per-bureau consumer credit report data from this PDF exactly following the schema in the system prompt."
          },
          {
            type: "input_file",
            filename: safeFilename,
            file_data: dataUrl
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
    throw new Error("LLM HTTP ERROR: " + errText);
  }

  const json = await resp.json();
  const raw = extractJsonStringFromResponse(json);

  if (!raw) {
    throw new Error("LLM returned no usable JSON.");
  }

  return tryParseJsonWithRepair(raw);
}

// ============================================================================
// RETRY WRAPPER — 3 attempts with backoff
// ============================================================================
async function runCreditPdfLLM(pdfBuffer, filename) {
  let lastError = null;

  for (let i = 1; i <= 3; i++) {
    try {
      return await callOpenAIOnce(pdfBuffer, filename);
    } catch (err) {
      lastError = err;
      logError("LLM_ATTEMPT_" + i, err);
      await new Promise(r => setTimeout(r, 150 * i));
    }
  }

  throw new Error("LLM failed after 3 attempts: " + lastError);
}

// ============================================================================
// BUSINESS AGE HELPER
// ============================================================================
function getNumberField(fields, key) {
  if (!fields || fields[key] == null) return null;
  const raw = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ============================================================================
// DATE HELPERS
// ============================================================================
function monthsSince(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const match = dateStr.match(/^(\d{4})-(\d{2})/);
  if (!match) return null;

  const y = Number(match[1]);
  const m = Number(match[2]);

  const opened = new Date(y, m - 1, 1);
  const now = new Date();

  return (
    (now.getFullYear() - opened.getFullYear()) * 12 +
    (now.getMonth() - opened.getMonth())
  );
}

// ============================================================================
// PRO UNDERWRITING ENGINE (Per Bureau + Aggregate)
// ============================================================================
function computeUnderwrite(bureaus, businessAgeMonthsRaw) {
  const safe = bureaus || {};

  const ex = normalizeBureau(safe.experian);
  const eq = normalizeBureau(safe.equifax);
  const tu = normalizeBureau(safe.transunion);

  // sanitize scores
  ex.score = sanitizeScore(ex.score);
  eq.score = sanitizeScore(eq.score);
  tu.score = sanitizeScore(tu.score);

  function toNumberOrNull(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && v.toLowerCase() === "null") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function numOrZero(v) {
    const n = toNumberOrNull(v);
    return n == null ? 0 : n;
  }

  const exInq = numOrZero(ex.inquiries);
  const eqInq = numOrZero(eq.inquiries);
  const tuInq = numOrZero(tu.inquiries);
  const totalInq = exInq + eqInq + tuInq;

  // --------------------------------------------------------------------------
  // Per-bureau summary builder
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

    // fundability rules per bureau
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

  // --------------------------------------------------------------------------
  // Build summaries for each bureau
  // --------------------------------------------------------------------------
  const bureauSummaries = [
    buildBureauSummary("experian", "Experian", ex),
    buildBureauSummary("equifax", "Equifax", eq),
    buildBureauSummary("transunion", "TransUnion", tu)
  ];

  // Choose primary bureau = highest score among available
  let primary = bureauSummaries[0];
  for (const b of bureauSummaries) {
    if (!b.available) continue;
    if (!primary.available || b.score > primary.score) {
      primary = b;
    }
  }

  // Business age
  const businessAgeMonths =
    typeof businessAgeMonthsRaw === "number" && Number.isFinite(businessAgeMonthsRaw)
      ? businessAgeMonthsRaw
      : null;

  // Multi-bureau fundability logic
  const fundableBureaus = bureauSummaries.filter(
    b => b.available && b.fundable
  );
  const fundableCount = fundableBureaus.length;

  const totalCardFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.available ? b.cardFunding : 0),
    0
  );
  const totalLoanFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.available ? b.loanFunding : 0),
    0
  );

  // Reduce expectations if only one bureau is fundable
  let scale = 1;
  if (fundableCount === 1) scale = 1 / 3;

  const cardFunding = totalCardFundingBase * scale;
  const loanFunding = totalLoanFundingBase * scale;
  const totalPersonalFunding = cardFunding + loanFunding;

  // Business multiplier
  let businessMultiplier = 0;
  if (businessAgeMonths != null && primary.cardFunding > 0) {
    if (businessAgeMonths < 12) businessMultiplier = 0.5;
    else if (businessAgeMonths < 24) businessMultiplier = 1.0;
    else businessMultiplier = 2.0;
  }

  const canBusinessFund = businessMultiplier > 0;
  const businessFunding = primary.cardFunding * businessMultiplier;
  const totalCombinedFunding = totalPersonalFunding + businessFunding;

  // Optimization flags
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

  // Lite banner funding minimum
  let liteBannerFunding = primary.cardFunding || cardFunding;
  if (!liteBannerFunding) liteBannerFunding = 15000;

  // Final global fundability for routing
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
// SUGGESTION ENGINE
// ============================================================================
function buildSuggestions(bureaus, uw) {
  const primaryKey = uw.primary_bureau;
  const m = uw.metrics;

  const score = m.score;
  const util = m.utilization_pct;
  const negatives = m.negative_accounts;
  const inquiries = m.inquiries.total;
  const late = m.late_payment_events;

  const actions = [];
  const au_actions = [];

  // Utilization recommendations
  if (typeof util === "number" && Number.isFinite(util)) {
    if (util > 30) {
      actions.push(
        `Your utilization is about ${util}%. Pay balances down into the 3–10% range before applying for new credit to maximize approvals.`
      );
    } else {
      actions.push(
        `Your utilization is in a solid range. Keeping each card between 3–10% will help you qualify for stronger limits.`
      );
    }
  } else {
    actions.push(
      `We couldn't clearly read utilization from this PDF, but the rule is simple: keep each card between 3–10% before submitting new applications.`
    );
  }

  if (negatives > 0) {
    actions.push(
      `You have ${negatives} negative account(s). Cleaning these up greatly improves approval odds with lenders.`
    );
  }

  if (inquiries > 0) {
    actions.push(
      `You have ${inquiries} total inquiries. Removing unnecessary or recent inquiries helps reduce “too many inquiries” denials.`
    );
  }

  // Authorized user cleanup
  const allTradelines = [
    ...(bureaus.experian?.tradelines || []),
    ...(bureaus.equifax?.tradelines || []),
    ...(bureaus.transunion?.tradelines || [])
  ];

  for (const tl of allTradelines) {
    if (!tl || typeof tl !== "object") continue;
    if (tl.is_au !== true) continue;

    const bal = tl.balance ? Number(tl.balance) : 0;
    const lim = tl.limit ? Number(tl.limit) : 1;
    const ratio = (bal / lim) * 100;
    const creditor = tl.creditor || "authorized user account";
    const status = String(tl.status || "").toLowerCase();

    if (ratio > 30) {
      au_actions.push(
        `Authorized user account "${creditor}" is around ${ratio.toFixed(
          1
        )}% utilized. Have the primary cardholder pay it down or remove you as an AU.`
      );
    }

    if (
      status.includes("charge") ||
      status.includes("collection") ||
      status.includes("derog") ||
      status.includes("delinquent")
    ) {
      au_actions.push(
        `Authorized user account "${creditor}" is reporting negative history. Ask the primary cardholder to remove you as an AU so it stops reporting.`
      );
    }
  }

  if (uw.optimization.needs_file_buildout) {
    actions.push(
      `Your credit file is on the thin side. Adding 1–2 new primary accounts or low-utilization authorized user accounts will strengthen your profile.`
    );
  }

  if (negatives === 0 && inquiries === 0 && (typeof util !== "number" || util <= 30)) {
    actions.push(
      `You're in a good position to request credit limit increases once balances are paid down.`
    );
  }

  const webSummary = (() => {
    let s = `Your strongest bureau right now is ${primaryKey.toUpperCase()}. `;
    if (!uw.fundable) {
      s += `You're close — here’s what to improve next to unlock higher approvals:`;
    } else {
      s += `You're fundable based on your profile. Here’s how to maximize approvals and starting limits:`;
    }
    return s;
  })();

  const emailSummary = `
Your strongest funding bureau is **${primaryKey.toUpperCase()}**.

Snapshot:
- Score: ${score ?? "not available"}
- Utilization: ${
    util != null && Number.isFinite(util) ? util + "%" : "not clearly readable"
  }
- Negative accounts: ${negatives}
- Total inquiries: ${inquiries}
- Recent late payments: ${late}

Fastest improvements:
1) Keep all cards in the 3–10% utilization range.
2) Remove negative items and unnecessary inquiries.
3) Fix or remove any AU cards that are maxed out or reporting negative history.
`.trim();

  return {
    web_summary: webSummary,
    email_summary: emailSummary,
    actions,
    au_actions
  };
}

// ============================================================================
// MAIN HANDLER — PDF Upload → GPT-4.1 VISION (PDF) → Underwrite → Suggest → Redirect
// ============================================================================
module.exports = async function handler(req, res) {
  try {
    // CORS preflight
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

    // Parse the upload form with formidable
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
      return res.status(200).json(
        buildFallbackResult("No file detected. Please upload a credit report PDF.")
      );
    }

    const buffer = await fs.promises.readFile(file.filepath);

    // quick sanity check: extremely tiny PDFs are likely junk
    if (!buffer || buffer.length < 1000) {
      return res.status(200).json(
        buildFallbackResult(
          "This file is too small to be a full credit report. Please upload a different credit report PDF."
        )
      );
    }

    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    // ----------------------- LLM extraction -----------------------
    let extracted;
    try {
      extracted = await runCreditPdfLLM(buffer, file.originalFilename || file.newFilename);

      if (!extracted || typeof extracted !== "object") {
        return res.status(200).json(
          buildFallbackResult(
            "The analyzer could not understand this report. Please upload a different credit report PDF."
          )
        );
      }

      if (!("bureaus" in extracted)) {
        return res.status(200).json(
          buildFallbackResult(
            "Missing bureau data in this report. Please try another credit report PDF."
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

    // ----------------------- Normalize -----------------------
    const bureaus = {
      experian: normalizeBureau(extracted.bureaus?.experian),
      equifax: normalizeBureau(extracted.bureaus?.equifax),
      transunion: normalizeBureau(extracted.bureaus?.transunion)
    };

    // ----------------------- Underwrite -----------------------
    let uw;
    try {
      uw = computeUnderwrite(bureaus, businessAgeMonths);
    } catch (err) {
      logError("UNDERWRITE_CRASH", err, JSON.stringify(extracted).slice(0, 800));
      return res.status(200).json(
        buildFallbackResult(
          "Underwriting crashed on this file. Please upload a different credit report PDF."
        )
      );
    }

    // ----------------------- Suggestions -----------------------
    let suggestions;
    try {
      suggestions = buildSuggestions(bureaus, uw);
    } catch (err) {
      logError("SUGGESTION_ENGINE_CRASH", err);
      suggestions = {
        web_summary:
          "We analyzed your file but couldn't generate detailed suggestions.",
        email_summary:
          "The system analyzed your report but couldn't generate full suggestions.",
        actions: [],
        au_actions: []
      };
    }

    // ----------------------- Redirect Logic -----------------------
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

    // ----------------------- SUCCESS RESPONSE -----------------------
    return res.status(200).json({
      ok: true,
      bureaus,
      underwrite: uw,
      suggestions,
      redirect
    });

  } catch (err) {
    logError("FATAL_HANDLER", err);
    return res
      .status(200)
      .json(
        buildFallbackResult(
          "A system-level error occurred. Please upload a different credit report PDF."
        )
      );
  }
};
