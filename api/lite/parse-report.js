// ==================================================================================
// UnderwriteIQ LITE — LLM-Powered Credit Report Parser
// Vercel Serverless Function
// Uses: process.env.UNDERWRITE_IQ_VISION_KEY
// Model: gpt-4o-mini (Vision capable, cheap & accurate)
// ==================================================================================

const fs = require("fs");
const { formidable } = require("formidable");

// Disable bodyParser so formidable can handle multipart form-data
module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// -----------------------------------------------
// AI PROMPT — Extract structured credit report JSON
// -----------------------------------------------
const LLM_PROMPT = `
You are UnderwriteIQ, an AI credit analyst.

You must extract 100% accurate CREDIT REPORT DATA from the PDF.
Return JSON ONLY. No text outside JSON. The JSON MUST be strictly valid.

Return the following structure:

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
- Prefer any FICO score (FICO 8 if available). If none, return any score given.
- Negative accounts include: collections, charge-offs, repossessions, foreclosures,
  public records, bankruptcies, judgments, liens, or any derogatory status.
- Late_payment_events counts EVERY late event (30/60/90/120/150/180).
- Return *only* JSON.
`;

// -----------------------------------------------
// VISION LLM CALL — uses OpenAI Responses API
// -----------------------------------------------
async function runVisionLLM(base64PDF) {
  const payload = {
    model: "gpt-4o-mini",
    reasoning: { effort: "medium" },
    input: [
      {
        role: "system",
        content: LLM_PROMPT
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Extract credit report data. Return ONLY JSON."
          },
          {
            type: "input_image",
            image_url: `data:application/pdf;base64,${base64PDF}`
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
    const err = await response.text();
    throw new Error("LLM request failed: " + err);
  }

  const json = await response.json();
  const content =
    json?.output_text ||
    json?.content ||
    json?.choices?.[0]?.message?.content ||
    "";

  if (!content) throw new Error("Empty LLM response");

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error("Invalid JSON from model: " + content);
  }
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
    (score >= 700) &&
    (util <= 30) &&
    (neg <= 0) &&
    (totalInq <= 6);

  let base = 0;
  for (const tl of data.tradelines || []) {
    if (tl.limit && tl.limit > base) base = tl.limit;
  }

  const estimate = base
    ? Math.round((base * 5.5) / 1000) * 1000
    : 15000;

  return {
    fundable,
    estimate
  };
}

// -----------------------------------------------
// MAIN HANDLER
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

  // Parse incoming multipart form-data
  const form = formidable({
    multiples: false,
    keepExtensions: true,
    uploadDir: "/tmp",
    maxFileSize: 25 * 1024 * 1024
  });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) {
        return res.status(400).json({
          ok: false,
          msg: "Upload error",
          detail: String(err)
        });
      }

      const f = files.file;
      if (!f) {
        return res.status(400).json({ ok: false, msg: "No file uploaded" });
      }

      // ------------------------------
      // Bulletproof Vercel file path fix
      // ------------------------------
      let pdfPath =
        f?.filepath ||
        f?.path ||
        f?._writeStream?.path ||
        null;

      if (!pdfPath) {
        return res.status(400).json({
          ok: false,
          msg: "Unable to locate uploaded file path"
        });
      }

      const raw = await fs.promises.readFile(pdfPath);
      const base64PDF = raw.toString("base64");

      // -------------------------------
      // Run Vision LLM
      // -------------------------------
      const extracted = await runVisionLLM(base64PDF);

      // -------------------------------
      // Compute underwriting
      // -------------------------------
      const uw = computeFundingLogic(extracted);

      return res.status(200).json({
        ok: true,
        inputs: extracted,
        outputs: {
          fundable: uw.fundable,
          banner_estimate: uw.estimate
        }
      });

    } catch (error) {
      console.error("Parse error:", error);
      return res.status(500).json({
        ok: false,
        msg: "Parser failed",
        error: String(error)
      });
    }
  });
};
