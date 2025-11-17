// ==================================================================================
// UnderwriteIQ — PERFECTION PIPELINE v1 (FINAL BUILD)
// Patch v9.0 — Ultra-Stable GPT-4.1 VISION Pipeline
// - JSON Repair v4
// - Input_file sanitizer
// - Dead-zone PDF detection
// - Absolute Vercel compatibility
// - Crash-proof fallback engine
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");

// ============================================================================
// Vercel API Config — handles file uploads + large PDFs
// ============================================================================
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
${String(err)}
---------------------------------------------
`;
  console.error(msg);
  try { fs.appendFileSync("/tmp/uwiq-errors.log", msg); } catch (_) {}
}

// ============================================================================
// BUILT-IN FALLBACK RESULT
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
        "We couldn't clearly read this credit report file. Please upload a different credit report PDF (Experian, Equifax, TransUnion, or AnnualCreditReport.com)."
    },
    issues: [],
    dispute_groups: [],
    funding_estimate: { low: null, high: null, confidence: 0 },
    suggestions: {
      web_summary:
        "We had trouble reading this specific credit report file. Please upload a standard credit report PDF.",
      email_summary:
        "Our system couldn't reliably read the file uploaded. Please upload a standard credit report PDF.",
      actions: [],
      au_actions: []
    }
  };
}

// ============================================================================
// BASE SYSTEM PROMPT — clean & strict
// ============================================================================
const LLM_PROMPT = `
You are UnderwriteIQ. Extract the FULL per-bureau data from a consumer credit report.

Rules:
- VALID JSON ONLY
- NO markdown
- NO commentary
- NO invented tradelines
- Null ANYTHING missing
- Follow schema EXACTLY

Schema:
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
// JSON Normalizer
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
// Extract LLM JSON text
// ============================================================================
function extractJsonStringFromResponse(json) {
  if (json.output_text && typeof json.output_text === "string")
    return json.output_text.trim();

  if (Array.isArray(json.output)) {
    for (const msg of json.output) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (
          (block.type === "output_text" || block.type === "summary_text") &&
          typeof block.text === "string"
        ) return block.text.trim();
      }
    }
  }

  if (
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    typeof json.choices[0].message.content === "string"
  ) return json.choices[0].message.content.trim();

  return null;
}

// ============================================================================
// JSON Repair v4 — strongest version
// ============================================================================
function tryParseJsonWithRepair(raw) {
  if (!raw) throw new Error("EMPTY_RAW");

  let cleaned = normalizeLLMOutput(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("NO_JSON_OBJECT");

  let fixed = cleaned.substring(first, last + 1);

  fixed = fixed.replace(/,\s*([}\]])/g, "$1");
  fixed = fixed.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');
  fixed = fixed.replace(/:\s*(\d{4}-\d{2}(-\d{2})?)/g, ':"$1"');

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
    logError("JSON_REPAIR_FAIL", err, fixed.slice(0, 500));
    throw new Error("JSON_PARSE_FAILED");
  }
}

// ============================================================================
// Bureau Normalizer
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
// Score Sanitizer
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
// Call GPT-4.1 Vision with PDF (input_file)
// ============================================================================
async function callOpenAIOnce(pdfBuffer, filename) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("NO_API_KEY");

  const dataUrl = `data:application/pdf;base64,${pdfBuffer.toString("base64")}`;
  const safeFilename = filename || "credit-report.pdf";

  const payload = {
    model: "gpt-4.1",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extract per-bureau data." },
          { type: "input_file", filename: safeFilename, file_data: dataUrl }
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

  if (!resp.ok) throw new Error(await resp.text());

  const json = await resp.json();
  const raw = extractJsonStringFromResponse(json);
  if (!raw) throw new Error("NO_RAW_JSON");

  return tryParseJsonWithRepair(raw);
}

// ============================================================================
// Retry Wrapper — 3 tries, backoff
// ============================================================================
async function runCreditPdfLLM(pdfBuffer, filename) {
  let lastErr = null;
  for (let i = 1; i <= 3; i++) {
    try {
      return await callOpenAIOnce(pdfBuffer, filename);
    } catch (err) {
      lastErr = err;
      logError("ATTEMPT_" + i, err);
      await new Promise(r => setTimeout(r, 100 * i));
    }
  }
  throw new Error("LLM_FAILED_THREE_TIMES: " + lastErr);
}

// ============================================================================
// PART 1 ENDS HERE
// ============================================================================
// ============================================================================
// DATE + NUMBER HELPERS
// ============================================================================
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

  const y = Number(m[1]);
  const mo = Number(m[2]);

  const opened = new Date(y, mo - 1, 1);
  const now = new Date();

  return (
    (now.getFullYear() - opened.getFullYear()) * 12 +
    (now.getMonth() - opened.getMonth())
  );
}

// ============================================================================
// UNDERWRITING ENGINE (stable version)
// ============================================================================
function computeUnderwrite(bureaus, businessAgeMonthsRaw) {
  const ex = normalizeBureau(bureaus.experian);
  const eq = normalizeBureau(bureaus.equifax);
  const tu = normalizeBureau(bureaus.transunion);

  ex.score = sanitizeScore(ex.score);
  eq.score = sanitizeScore(eq.score);
  tu.score = sanitizeScore(tu.score);

  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const build = (key, label, b) => {
    const score = sanitizeScore(b.score);
    const util = b.utilization_pct == null ? null : Number(b.utilization_pct);
    const neg = num(b.negatives);
    const lates = num(b.late_payment_events);
    const inquiries = num(b.inquiries);

    let highestRev = 0;
    let highestInst = 0;
    let hasRev = false;
    let hasInst = false;
    let positives = 0;

    for (const tl of b.tradelines) {
      if (!tl || typeof tl !== "object") continue;

      const type = String(tl.type || "").toLowerCase();
      const status = String(tl.status || "").toLowerCase();
      const limit = num(tl.limit);
      const balance = num(tl.balance);
      const age = monthsSince(tl.opened);

      const derog =
        status.includes("charge") ||
        status.includes("collection") ||
        status.includes("derog") ||
        status.includes("repo") ||
        status.includes("foreclosure");

      if (!derog) positives++;

      const seasoned = age != null && age >= 24;

      if (type === "revolving") {
        hasRev = true;
        if (status.includes("open") && seasoned && limit > highestRev)
          highestRev = limit;
      }

      if (["installment", "auto", "mortgage"].includes(type)) {
        hasInst = true;
        const amt = limit || balance;
        if (amt > 0 && seasoned && !derog) {
          if (amt > highestInst) highestInst = amt;
        }
      }
    }

    const thin = positives < 3;
    const fileNeg = positives === 0 && neg > 0;

    const canCard = hasRev && highestRev >= 5000;
    const canLoan = hasInst && highestInst >= 10000 && lates === 0;

    const cardFunding = canCard ? highestRev * 5.5 : 0;
    const loanFunding = canLoan ? highestInst * 3 : 0;

    const fundable =
      score != null &&
      score >= 700 &&
      (util == null || util <= 30) &&
      neg === 0;

    return {
      key,
      label,
      available: b.available,
      score,
      util,
      neg,
      lates,
      inquiries,
      tradelines: b.tradelines,
      highestRevolvingLimit: highestRev,
      highestInstallmentAmount: highestInst,
      hasAnyRevolving: hasRev,
      hasAnyInstallment: hasInst,
      thinFile: thin,
      fileAllNegative: fileNeg,
      canCardStack: canCard,
      canLoanStack: canLoan,
      canDualStack: canCard && canLoan,
      cardFunding,
      loanFunding,
      totalPersonalFunding: cardFunding + loanFunding,
      fundable,
      positiveTradelinesCount: positives
    };
  };

  const exSum = build("experian", "Experian", ex);
  const eqSum = build("equifax", "Equifax", eq);
  const tuSum = build("transunion", "TransUnion", tu);

  const bureausArr = [exSum, eqSum, tuSum];

  let primary = bureausArr.find(b => b.available) || exSum;
  for (const b of bureausArr) {
    if (b.available && b.score > primary.score) primary = b;
  }

  const businessAgeMonths =
    Number.isFinite(businessAgeMonthsRaw) ? businessAgeMonthsRaw : null;

  const fundableCount = bureausArr.filter(b => b.fundable).length;

  const totalCard = bureausArr.reduce(
    (s, b) => s + (b.available ? b.cardFunding : 0),
    0
  );
  const totalLoan = bureausArr.reduce(
    (s, b) => s + (b.available ? b.loanFunding : 0),
    0
  );

  let scale = fundableCount === 1 ? 1 / 3 : 1;

  const cardFunding = totalCard * scale;
  const loanFunding = totalLoan * scale;
  const totalPersonalFunding = cardFunding + loanFunding;

  let businessMultiplier = 0;
  if (businessAgeMonths != null && primary.cardFunding > 0) {
    if (businessAgeMonths < 12) businessMultiplier = 0.5;
    else if (businessAgeMonths < 24) businessMultiplier = 1;
    else businessMultiplier = 2;
  }

  const businessFunding = primary.cardFunding * businessMultiplier;
  const totalCombinedFunding = totalPersonalFunding + businessFunding;

  const needsUtil = primary.util != null && primary.util > 30;
  const needsRev = !primary.hasAnyRevolving || primary.highestRevolvingLimit < 5000;
  const needsNeg = primary.neg > 0;
  const needsInq = exSum.inquiries + eqSum.inquiries + tuSum.inquiries > 0;
  const needsBuild = primary.thinFile || primary.fileAllNegative;

  const optimization = {
    needs_util_reduction: needsUtil,
    target_util_pct: needsUtil ? 30 : null,
    needs_new_primary_revolving: needsRev,
    needs_inquiry_cleanup: needsInq,
    needs_negative_cleanup: needsNeg,
    needs_file_buildout: needsBuild,
    thin_file: primary.thinFile,
    file_all_negative: primary.fileAllNegative
  };

  const liteBannerFunding = primary.cardFunding || cardFunding || 15000;

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
        ex: exSum.inquiries,
        eq: eqSum.inquiries,
        tu: tuSum.inquiries,
        total: exSum.inquiries + eqSum.inquiries + tuSum.inquiries
      }
    },
    per_bureau: {
      experian: exSum,
      equifax: eqSum,
      transunion: tuSum
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
      can_business_fund: businessMultiplier > 0,
      business_multiplier: businessMultiplier,
      business_funding: businessFunding
    },
    totals: {
      total_personal_funding,
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
  const p = uw.primary_bureau.toUpperCase();
  const m = uw.metrics;

  const score = m.score;
  const util = m.utilization_pct;
  const negatives = m.negative_accounts;
  const inquiries = m.inquiries.total;
  const late = m.late_payment_events;

  const actions = [];
  const au_actions = [];

  if (util != null) {
    if (util > 30)
      actions.push(
        `Your utilization is about ${util}%. Pay balances down to 3–10% for max approvals.`
      );
    else
      actions.push(
        `Your utilization is solid. Keep cards between 3–10% for strongest approvals.`
      );
  } else {
    actions.push(`Utilization unreadable — target 3–10%.`);
  }

  if (negatives > 0)
    actions.push(`You have ${negatives} negative account(s). Clean-up will help.`);

  if (inquiries > 0)
    actions.push(
      `${inquiries} inquiries found — removing recent or unnecessary ones improves approvals.`
    );

  const allTL = [
    ...(bureaus.experian.tradelines || []),
    ...(bureaus.equifax.tradelines || []),
    ...(bureaus.transunion.tradelines || [])
  ];

  for (const tl of allTL) {
    if (!tl || !tl.is_au) continue;

    const lim = Number(tl.limit || 1);
    const bal = Number(tl.balance || 0);
    const ratio = (bal / lim) * 100;
    const creditor = tl.creditor || "AU account";
    const status = String(tl.status || "").toLowerCase();

    if (ratio > 30)
      au_actions.push(
        `AU "${creditor}" is ${ratio.toFixed(1)}% utilized — pay down or remove.`
      );

    if (
      status.includes("charge") ||
      status.includes("collection") ||
      status.includes("derog") ||
      status.includes("delinquent")
    )
      au_actions.push(
        `AU "${creditor}" is reporting negative history — remove from report.`
      );
  }

  if (uw.optimization.needs_file_buildout)
    actions.push(`File is thin — add 1–2 primary or low-utilization AU accounts.`);

  const webSummary = `Strongest bureau: ${p}. ${
    uw.fundable
      ? "You are fundable — here’s how to maximize limits:"
      : "You're close — improve these items next:"
  }`;

  const emailSummary = `
Strongest bureau: ${p}

Score: ${score ?? "N/A"}
Utilization: ${util != null ? util + "%" : "N/A"}
Negatives: ${negatives}
Inquiries: ${inquiries}
Late Payments: ${late}

Key Improvements:
1. Keep all revolving accounts at 3–10%.
2. Remove negatives & high-impact inquiries.
3. Fix/remove AU accounts with high utilization or derogatory history.
`.trim();

  return { web_summary: webSummary, email_summary: emailSummary, actions, au_actions };
}

// ============================================================================
// MAIN HANDLER — Perfection Pipeline
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
      form.parse(req, (e, flds, fls) => (e ? reject(e) : resolve({ fields: flds, files: fls })))
    );

    const file = files.file;
    if (!file || !file.filepath) {
      return res.status(200).json(buildFallbackResult("No file detected."));
    }

    const buffer = await fs.promises.readFile(file.filepath);
    if (!buffer || buffer.length < 1000) {
      return res.status(200).json(buildFallbackResult("PDF too small."));
    }

    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    let extracted;
    try {
      extracted = await runCreditPdfLLM(buffer, file.originalFilename || file.newFilename);

      if (!extracted || typeof extracted !== "object")
        return res.status(200).json(buildFallbackResult("Unreadable credit report."));

      if (!("bureaus" in extracted))
        return res.status(200).json(buildFallbackResult("Missing bureau data."));
    } catch (err) {
      logError("LLM_FAIL", err);
      return res.status(200).json(buildFallbackResult("PDF could not be analyzed."));
    }

    const bureaus = {
      experian: normalizeBureau(extracted.bureaus.experian),
      equifax: normalizeBureau(extracted.bureaus.equifax),
      transunion: normalizeBureau(extracted.bureaus.transunion)
    };

    let uw;
    try {
      uw = computeUnderwrite(bureaus, businessAgeMonths);
    } catch (err) {
      logError("UW_FAIL", err);
      return res.status(200).json(buildFallbackResult("Underwriting crashed."));
    }

    let suggestions;
    try {
      suggestions = buildSuggestions(bureaus, uw);
    } catch (err) {
      logError("SUGGEST_FAIL", err);
      suggestions = {
        web_summary: "Suggestions unavailable.",
        email_summary: "Suggestions unavailable.",
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
    logError("FATAL", err);
    return res.status(200).json(buildFallbackResult("Fatal system error."));
  }
};
