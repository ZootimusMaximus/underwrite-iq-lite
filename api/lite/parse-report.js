// ==================================================================================
// UnderwriteIQ — FULL PRO VERSION (Patch v7.0)
// Includes:
// - GPT-4o model
// - AnnualCreditReport handling
// - Score sanitizer
// - Bureau availability logic
// - Massive JSON repair engine
// - Stronger type classifier
// - Error logging subsystem
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");
const path = require("path");

module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// ============================================================================
// ERROR LOGGER — writes to /tmp/uwiq-errors.log (survives runtime on Vercel)
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
// FALLBACK RESULT — returned anytime we cannot trust output
// ============================================================================
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

// ============================================================================
// GPT-4o SYSTEM PROMPT (UPGRADED)
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
// NORMALIZER — strips markdown/noise
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
// JSON EXTRACTOR — supports Responses API / Chat API
// ============================================================================
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
    json.choices[0] &&
    json.choices[0].message &&
    typeof json.choices[0].message.content === "string"
  ) {
    return json.choices[0].message.content.trim();
  }

  return null;
}

// ============================================================================
// MASSIVE JSON REPAIR ENGINE
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

  // --- Core repairs ---
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");                     // remove trailing commas
  fixed = fixed.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":'); // quote keys
  fixed = fixed.replace(/:\s*(\d{4}-\d{2}(-\d{2})?)/g, ':"$1"');      // quote dates

  // auto-quote simple unquoted strings
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
    logError("JSON_PARSE_REPAIR_FAIL", err, fixed.slice(0, 300));
    throw new Error("JSON parse failed: " + err.message);
  }
}

// ============================================================================
// BUREAU NORMALIZER — handles missing bureaus
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
// SCORE SANITIZER — fixes cases like 8516, 8548, 9350
// ============================================================================
function sanitizeScore(score) {
  if (score == null) return null;
  let s = Number(score);

  // Fix 8500/85000 format
  if (s > 9000) s = Math.floor(s / 10);
  if (s > 850) s = 850;
  if (s < 300) return null;

  return s;
}

// ============================================================================
// GPT-4o CALL (Upgraded from gpt-4o-mini)
// ============================================================================
async function callOpenAIOnce(text) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const payload = {
    model: "gpt-4o",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [{ type: "input_text", text: text.slice(0, 18000) }]
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
// LLM RETRY WRAPPER
// ============================================================================
async function runCreditTextLLM(text) {
  let error = null;

  for (let i = 1; i <= 3; i++) {
    try {
      return await callOpenAIOnce(text);
    } catch (err) {
      error = err;
      logError("LLM_ATTEMPT_FAIL_" + i, err);
      await new Promise(r => setTimeout(r, 150 * i));
    }
  }

  throw new Error("LLM failed after 3 attempts: " + error);
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

  return (now.getFullYear() - opened.getFullYear()) * 12 +
         (now.getMonth() - opened.getMonth());
}

// ============================================================================
// >>>>>>>>>> STOP HERE — THIS IS THE END OF PART 1 <<<<<<<<<<
// Wait until you say “second half”
// ============================================================================
// ============================================================================
// PRO UNDERWRITING ENGINE (Per Bureau + Aggregate)
// ============================================================================
function computeUnderwrite(bureaus, businessAgeMonthsRaw) {
  const safe = bureaus || {};

  const ex = normalizeBureau(safe.experian);
  const eq = normalizeBureau(safe.equifax);
  const tu = normalizeBureau(safe.transunion);

  // sanitize scores (fix weird 8516/9350 shit)
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
    let fileAllNegative = false;

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

      if (
        type === "installment" ||
        type === "auto" ||
        type === "mortgage"
      ) {
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

    // basic fundability for THIS bureau
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

  // pick primary: highest score among AVAILABLE bureaus, fallback to first
  let primary = bureauSummaries[0];
  for (const b of bureauSummaries) {
    if (!b.available) continue;
    if (!primary.available || b.score > primary.score) {
      primary = b;
    }
  }

  const businessAgeMonths =
    typeof businessAgeMonthsRaw === "number" && Number.isFinite(businessAgeMonthsRaw)
      ? businessAgeMonthsRaw
      : null;

  const fundableBureaus = bureauSummaries.filter(
    (b) => b.available && b.fundable
  );
  const fundableCount = fundableBureaus.length;

  const totalCardFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.available ? (b.cardFunding || 0) : 0),
    0
  );
  const totalLoanFundingBase = bureauSummaries.reduce(
    (sum, b) => sum + (b.available ? (b.loanFunding || 0) : 0),
    0
  );

  // scaling if only 1 bureau is fundable
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

  // minimum banner so lander never looks "empty"
  if (!liteBannerFunding && primary.score && primary.score >= 700) {
    liteBannerFunding = 15000;
  }
  if (!liteBannerFunding) {
    liteBannerFunding = 15000;
  }

  // global fundable flag (for routing)
  const fundable =
    primary.score != null &&
    primary.score >= 700 &&
    (primary.util == null || primary.util <= 30) &&
    primary.neg === 0 &&
    totalPersonalFunding >= 0; // you will loosen this later

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
      total_business_funding: totalBusinessFunding,
      total_combined_funding: totalCombinedFunding
    },
    optimization,
    lite_banner_funding: liteBannerFunding
  };
}

// ============================================================================
// SUGGESTION ENGINE (Layer A + B foundation)
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

  // Utilization — human & technical, with null-safe handling
  if (typeof util === "number" && Number.isFinite(util)) {
    if (util > 30) {
      actions.push(
        `Your utilization is about ${util}%. To maximize approvals, bring each card down into the 3–10% range before you apply for new funding.`
      );
    } else {
      actions.push(
        `Your utilization is in a solid range. Keeping each card between 3–10% will help you qualify for higher starting limits and stronger approvals.`
      );
    }
  } else {
    actions.push(
      `We couldn't confidently read utilization from this PDF, but the rule is simple: keep each card between 3–10% before you submit new applications.`
    );
  }

  if (negatives > 0) {
    actions.push(
      `You have ${negatives} negative account(s). Removing or repairing these will boost approval odds and reduce automatic denials.`
    );
  }

  if (inquiries > 0) {
    actions.push(
      `You have ${inquiries} total inquiries. Cleaning up recent, unproductive inquiries before applying will help you avoid score dings and “too many inquiries” denials.`
    );
  }

  // AU logic (remove bad AUs, over-utilized AUs)
  const allTradelines = [
    ...(bureaus.experian?.tradelines || []),
    ...(bureaus.equifax?.tradelines || []),
    ...(bureaus.transunion?.tradelines || [])
  ];

  for (const tl of allTradelines) {
    if (!tl || typeof tl !== "object") continue;
    if (tl.is_au !== true) continue;

    const bal = numOrZero(tl.balance);
    const lim = numOrZero(tl.limit) || 1;
    const ratio = (bal / lim) * 100;
    const creditor = tl.creditor || "an authorized user account";
    const status = String(tl.status || "").toLowerCase();

    if (ratio > 30) {
      au_actions.push(
        `Authorized user account "${creditor}" is around ${ratio.toFixed(
          1
        )}% utilized. Have the primary cardholder pay this down or remove you as an AU to instantly improve your utilization.`
      );
    }

    if (
      status.includes("charge") ||
      status.includes("collection") ||
      status.includes("derog") ||
      status.includes("delinquent")
    ) {
      au_actions.push(
        `Authorized user account "${creditor}" is reporting negative history. Ask the primary cardholder to remove you as an AU so the negative history stops reporting under your profile.`
      );
    }
  }

  if (uw.optimization.needs_file_buildout) {
    actions.push(
      `Your file is “thin.” Adding 1–2 new primary accounts (or carefully selected authorized users with low utilization and perfect history) will make you look much stronger to lenders.`
    );
  }

  if (
    negatives === 0 &&
    inquiries === 0 &&
    (typeof util !== "number" || util <= 30)
  ) {
    actions.push(
      `You’re in a good position to request credit limit increases. Do this only after your balances are paid down, so your bank sees low utilization and a clean recent history.`
    );
  }

  const webSummary = (() => {
    let s = `Your strongest bureau for funding right now is ${primaryKey.toUpperCase()}. `;
    if (!uw.fundable) {
      s += `You're close — here’s what to fix next so you can unlock the highest possible approvals:`;
    } else {
      s += `You’re already fundable based on your current profile. Here’s how to squeeze the maximum limits from banks:`;
    }
    return s;
  })();

  const emailSummary = `
Your strongest funding bureau is **${primaryKey.toUpperCase()}**.

Here is your at-a-glance snapshot:

- Score (for this bureau): ${score ?? "not available"}
- Utilization (overall): ${util != null && Number.isFinite(util) ? util + "%" : "not clearly readable from this PDF"}
- Negative accounts: ${negatives}
- Total inquiries: ${inquiries}
- Recent late payments: ${late}

The fastest way to increase your approvals and limits is to:
1) Bring each active card into the 3–10% utilization window.
2) Clean up any negative items and unnecessary recent inquiries.
3) Remove or fix any authorized user accounts that are maxed out or reporting late/negative history.
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
    if (!file || !file.filepath) {
      return res.status(200).json(buildFallbackResult("No file uploaded"));
    }

    const buffer = await fs.promises.readFile(file.filepath);
    const pdf = await pdfParse(buffer);
    const rawText = pdf.text || "";

    // Very light normalization; keep structure for 4o
    const text = rawText.replace(/\s+/g, " ").trim();

    if (!text || text.length < 200) {
      return res
        .status(200)
        .json(buildFallbackResult("Not enough text extracted from PDF"));
    }

    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    let extracted;
    try {
      extracted = await runCreditTextLLM(text);

      if (!extracted || typeof extracted !== "object") {
        return res
          .status(200)
          .json(buildFallbackResult("Analyzer returned invalid JSON"));
      }

      if (!("bureaus" in extracted)) {
        return res
          .status(200)
          .json(buildFallbackResult("Analyzer failed: missing bureaus object"));
      }
    } catch (err) {
      logError("ANALYZER_CRASH", err);
      return res
        .status(200)
        .json(buildFallbackResult("Analyzer crashed: " + String(err)));
    }

    const bureaus = {
      experian: normalizeBureau(extracted.bureaus?.experian),
      equifax: normalizeBureau(extracted.bureaus?.equifax),
      transunion: normalizeBureau(extracted.bureaus?.transunion)
    };

    let uw;
    try {
      uw = computeUnderwrite(bureaus, businessAgeMonths);
    } catch (err) {
      logError("UNDERWRITE_CRASH", err, JSON.stringify(extracted).slice(0, 500));
      return res
        .status(200)
        .json(buildFallbackResult("Underwriting engine crashed"));
    }

    let suggestions;
    try {
      suggestions = buildSuggestions(bureaus, uw);
    } catch (err) {
      logError("SUGGESTION_ENGINE_CRASH", err);
      // if suggestions die, still return underwriting
      suggestions = {
        web_summary:
          "We analyzed your file but could not generate detailed suggestions automatically.",
        email_summary:
          "Our system analyzed your file but hit an internal error while generating suggestions. You can still review your funding profile on the website.",
        actions: [],
        au_actions: []
      };
    }

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

    return res.status(200).json({
      ok: true,
      bureaus,
      underwrite: uw,
      suggestions,
      redirect
    });
  } catch (err) {
    logError("FATAL_HANDLER", err);
    return res.status(200).json(buildFallbackResult("Fatal analyzer error"));
  }
};
