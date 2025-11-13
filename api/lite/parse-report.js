// ==================================================================================
// UnderwriteIQ LITE — FINAL WORKING VERCEL VERSION (PDF + Vision)
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");

// Disable Next.js bodyParser for uploads
module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// -----------------------------------------------
// AI PROMPT (kept short for reliability)
// -----------------------------------------------
const LLM_PROMPT = `
You are UnderwriteIQ, an AI credit analyst.

Extract this CREDIT REPORT into structured JSON. ONLY return valid JSON.

Required fields:
{
  "score": <number|null>,
  "score_model": "<string|null>",
  "utilization_pct": <number|null>,
  "inquiries": { "ex":number, "tu":number, "eq":number },
  "negative_accounts": <number>,
  "late_payment_events": <number>,
  "tradelines": [
     {
       "creditor": "<string>",
       "type": "<revolving|installment|other>",
       "status": "<string>",
       "balance": <number>,
       "limit": <number|null>,
       "past_due": <number|null>,
       "opened": "<YYYY-MM|null>",
       "closed": "<YYYY-MM|null>",
       "payment_history_summary":{
          "late_30":number,"late_60":number,"late_90":number,
          "late_120":number,"late_150":number,"late_180":number
       }
     }
  ]
}

Rules:
- Prefer FICO 8 if available, then any FICO, otherwise any score shown.
- negative_accounts = count of collections/chargeoffs/public records/derogs.
- late_payment_events = total count of all late events.
- JSON ONLY. No comments, no text outside JSON.
`;

// -----------------------------------------------
// CALL OPENAI GPT-4o-mini WITH PDF SUPPORT
// -----------------------------------------------
async function runVisionLLM(base64PDF) {
  const payload = {
    model: "gpt-4o-mini",
    reasoning: { effort: "medium" },
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Extract ALL credit report data. Return ONLY JSON."
          },
          {
            type: "input_file",
            file_data: {
              data: base64PDF,
              mime_type: "application/pdf"
            }
          }
        ]
      }
    ]
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
    throw new Error(await response.text());
  }

  const json = await response.json();

  const txt =
    json?.output_text ||
    json?.content ||
    json?.choices?.[0]?.message?.content ||
    "";

  return JSON.parse(txt);
}

// -----------------------------------------------
// UNDERWRITING LOGIC
// -----------------------------------------------
function computeFundingLogic(data) {
  const score = Number(data.score || 0);
  const util = Number(data.utilization_pct || 0);
  const neg = Number(data.negative_accounts || 0);
  const inq = data.inquiries || { ex: 0, tu: 0, eq: 0 };
  const totalInq = inq.ex + inq.tu + inq.eq;

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
// MAIN HANDLER — FILE UPLOAD + AI PIPELINE
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
    // -------- FORMIDABLE CONFIG (Vercel-compatible) --------
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
      throw new Error("No file or invalid file path");
    }

    // Read PDF from /tmp
    const raw = await fs.promises.readFile(uploaded.filepath);
    const base64PDF = raw.toString("base64");

    // Run Vision LLM
    const extracted = await runVisionLLM(base64PDF);

    // Underwriting
    const uw = computeFundingLogic(extracted);

    // Success response
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
