// ==================================================================================
// UnderwriteIQ LITE — Text + LLM Credit Report Parser (Vercel-safe)
// Uses: process.env.UNDERWRITE_IQ_VISION_KEY (OpenAI API key)
// Model: gpt-4o-mini (cheap & accurate, TEXT ONLY)
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");

// Disable bodyParser so Formidable handles multipart form-data
module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// -----------------------------------------------
// AI PROMPT — Extract structured credit report JSON
// -----------------------------------------------
const LLM_PROMPT = `
You are UnderwriteIQ, an AI credit analyst.

You will be given RAW TEXT extracted from a CREDIT REPORT PDF.
The text may be messy and out of order.
Your job is to reconstruct the report into CLEAN STRUCTURED JSON.

Return ONLY VALID JSON. NO markdown. NO commentary.
If a value is unknown, use null or 0 as appropriate.

JSON FORMAT:

{
  "score": <number or null>,
  "score_model": "<FICO8 | FICO9 | Vantage3 | Vantage4 | Other | null>",
  "utilization_pct": <number or null>,
  "inquiries": {
    "ex": <number>,
    "tu": <number>,
    "eq": <number>
  },
  "negative_accounts": <number>,
  "late_payment_events": <number>,
  "tradelines": [
    {
      "creditor": "<string>",
      "type": "<revolving|installment|other>",
      "status": "<open|closed|derogatory|chargeoff|collection|paid-collection|repossession|foreclosure|unknown>",
      "balance": <number>,
      "limit": <number or null>,
      "past_due": <number or null>,
      "opened": "<YYYY-MM or null>",
      "closed": "<YYYY-MM or null>",
      "payment_history_summary": {
        "late_30": <number>,
        "late_60": <number>,
        "late_90": <number>,
        "late_120": <number>,
        "late_150": <number>,
        "late_180": <number>
      }
    }
  ]
}

Rules:
- Prefer ANY FICO model. If multiple FICO scores appear, prefer FICO 8 if clearly labeled.
- If NO FICO model appears, use ANY score shown by the report (Vantage, etc).
- "negative_accounts" = count of unique tradelines or public records that are seriously derogatory:
  collections, charge-offs, paid charge-offs, repossessions, foreclosures, bankruptcies, judgments, tax liens, any "derogatory"/"negative" status.
- "late_payment_events" = total count of all late marks: 30/60/90/120/150/180 day late.
- "utilization_pct" = total revolving utilization if possible; if not, use whatever utilization is shown.
- If inquiries by bureau are not clear, approximate from the Inquiries section.
- The JSON MUST be valid and parseable.
`;

// -----------------------------------------------
// FIXED: CALL OpenAI GPT-4o-mini (TEXT ONLY)
// Correct Responses API schema
// -----------------------------------------------
async function runCreditTextLLM(creditText) {
  const maxChars = 15000;
  const truncated = creditText.slice(0, maxChars);

  const payload = {
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: LLM_PROMPT     // ✔ MUST be a plain string
      },
      {
        role: "user",
        content: [
          {
            type: "input_text", // ✔ correct type
            text: truncated
          }
        ]
      }
    ],
    max_output_tokens: 800,
    temperature: 0
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.UNDERWRITE_IQ_VISION_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error("LLM HTTP error: " + errText);
  }

  const json = await response.json();

  const raw = json?.output_text?.trim?.() || "";

  if (!raw) throw new Error("LLM returned empty output");

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("LLM returned invalid JSON: " + raw);
  }
}

// -----------------------------------------------
// SIMPLE FUNDING LOGIC (UnderwriteIQ LITE)
// -----------------------------------------------
function computeFundingLogic(data) {
  const score = Number(data.score || 0);
  const util = Number(data.utilization_pct || 0);
  const neg  = Number(data.negative_accounts || 0);

  const inq  = data.inquiries || { ex: 0, tu: 0, eq: 0 };
  const totalInq = (inq.ex || 0) + (inq.tu || 0) + (inq.eq || 0);

  const fundable =
    score >= 700 &&
    util <= 30 &&
    neg === 0 &&
    totalInq <= 6;

  let base = 0;
  for (const tl of data.tradelines || []) {
    if (tl.limit && tl.limit > base) base = tl.limit;
  }

  const estimate = base
    ? Math.round((base * 5.5) / 1000) * 1000
    : 15000;

  return { fundable, estimate };
}

// -----------------------------------------------
// MAIN HANDLER — UPLOAD + PARSE + LLM
// -----------------------------------------------
module.exports = async function handler(req, res) {

  // Preflight CORS
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

  try {
    // -------- FORMIDABLE CONFIG --------
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const uploaded = files.file;
    if (!uploaded || !uploaded.filepath) {
      return res.status(400).json({
        ok: false,
        msg: "No file uploaded or unable to locate file path"
      });
    }

    // -------- READ PDF --------
    const rawPDF = await fs.promises.readFile(uploaded.filepath);

    const parsed = await pdfParse(rawPDF);
    let text = (parsed.text || "").replace(/\s+/g, " ").trim();

    if (!text || text.length < 50) {
      return res.status(400).json({
        ok: false,
        msg: "We couldn't read your PDF. Upload a clearer bureau report PDF (no photos)."
      });
    }

    // -------- RUN LLM --------
    const extracted = await runCreditTextLLM(text);

    // -------- FUNDING LOGIC --------
    const uw = computeFundingLogic(extracted);

    return res.status(200).json({
      ok: true,
      inputs: extracted,
      outputs: {
        fundable: uw.fundable,
        banner_estimate: uw.estimate
      }
    });

  } catch (err) {
    console.error("Parser error:", err);
    return res.status(500).json({
      ok: false,
      msg: "Parser failed",
      error: String(err)
    });
  }
};
