// ==================================================================================
// UnderwriteIQ LITE — LLM-Powered Credit Report Parser
// Vercel Serverless Function
// Uses: process.env.UNDERWRITE_IQ_VISION_KEY
// Model: GPT-4o-mini Vision (cheapest + accurate)
// NOTES:
//  - No SDK imports (pure fetch) — safest for Vercel
//  - Handles all PDF types: Experian, Equifax, TU, PrivacyGuard, etc
//  - Extracts tradelines, negatives, lates, utilization, inquiries, score
//  - Runs full UnderwriteIQ funding logic
// ==================================================================================

const fs = require("fs");
const pdfParse = require("pdf-parse");
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

INSTRUCTIONS FOR YOU:

1. Identify ANY FICO score:
   - Prefer FICO 8 if available
   - Otherwise any FICO model
   - If NO FICO present, return any score the report provides (VantageScore)

2. Utilization:
   - Compute total revolving utilization from tradelines if available
   - If not computable, read the utilization % shown on the report

3. Negative accounts:
   Count ANY of the following:
     - Collections
     - Charge-offs
     - Paid charge-offs
     - Repossessions
     - Foreclosures
     - Public records (bankruptcy, judgment, tax lien)
     - Derogatory / negative statuses
     - Accounts with multiple severe late payments (count the account ONCE)

4. Late payment events:
   Count EVERY individual:
     - 30-day late
     - 60-day late
     - 90-day late
     - 120-day late
     - 150-day late
     - 180-day late

5. Returned JSON MUST BE VALID.
   NO explanations. NO markdown. JSON ONLY.
`;

// -----------------------------------------------
// UTILITY: Run GPT-4o-mini Vision On The Base64 PDF
// -----------------------------------------------
async function runVisionLLM(base64PDF) {
  const payload = {
    model: "gpt-4o-mini",   // inexpensive + accurate vision model
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
            text: "Extract credit report data from this PDF. Return ONLY JSON."
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

  // Extract model output text (should be pure JSON)
  const content = json?.output_text || json?.content || "";
  if (!content) throw new Error("Empty LLM response");

  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error("LLM returned invalid JSON: " + content);
  }
}

// -----------------------------------------------
// UNDERWRITING LOGIC (your existing engine)
// -----------------------------------------------
function computeFundingLogic(data) {
  const score = Number(data.score || 0);
  const util  = Number(data.utilization_pct || 0);
  const neg   = Number(data.negative_accounts || 0);
  const inq   = data.inquiries || { ex: 0, tu: 0, eq: 0 };
  const totalInq = inq.ex + inq.tu + inq.eq;

  const fundable =
    (score >= 700) &&
    (util <= 30) &&
    (neg <= 0) &&
    (totalInq <= 6);

  // Compute max funding (rough estimate)
  let base = 0;

  for (const tl of data.tradelines || []) {
    if (tl.limit && tl.limit > base) base = tl.limit;
  }

  const estimate = base ? Math.round(base * 5.5 / 1000) * 1000 : 15000;

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

  // Formidable to parse file
  const form = formidable({
    multiples: false,
    keepExtensions: true,
    uploadDir: "/tmp",
    maxFileSize: 25 * 1024 * 1024
  });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) {
        return res.status(400).json({ ok: false, msg: "Upload error", detail: String(err) });
      }

      const uploaded = files.file;
      if (!uploaded) {
        return res.status(400).json({ ok: false, msg: "No file uploaded" });
      }

      const pdfPath = uploaded.filepath || uploaded.path;
      const raw = await fs.promises.readFile(pdfPath);
      const base64PDF = raw.toString("base64");

      // -------------------------------
      // RUN LLM EXTRACTION
      // -------------------------------
      const extracted = await runVisionLLM(base64PDF);

      // -------------------------------
      // UNDERWRITING DECISION
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
