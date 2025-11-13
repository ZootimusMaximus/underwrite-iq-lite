// ==================================================================================
// UnderwriteIQ LITE — TEXT + LLM Parser (Option C: Auto-Repair + Retry + Expanded)
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");

module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// -----------------------------------------------
// UnderwriteIQ SYSTEM PROMPT (with COMPACT JSON instruction)
// -----------------------------------------------
const LLM_PROMPT = `
You are UnderwriteIQ, an AI credit analyst.

You will be given RAW TEXT extracted from a CREDIT REPORT PDF.
The text may be messy and out of order.
Your job is to reconstruct the report into CLEAN STRUCTURED JSON.

Return ONLY VALID JSON. NO markdown. NO commentary.
If a value is unknown, use null or 0 as appropriate.

ALWAYS OUTPUT **COMPACT JSON**:
- No spaces
- No new lines
- No indentation
- No formatting
- One-line JSON only

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
`;

// -----------------------------------------------
// HELPERS — Extract JSON from any OpenAI Response
// -----------------------------------------------
function extractJsonStringFromResponse(json) {
  // 1) Simple path
  if (json.output_text && json.output_text.trim()) {
    return json.output_text.trim();
  }

  // 2) Responses API standard block (THIS IS WHERE YOUR DATA WAS)
  if (Array.isArray(json.output)) {
    for (const msg of json.output) {
      if (!msg || !Array.isArray(msg.content)) continue;

      for (const chunk of msg.content) {
        if (
          (chunk.type === "output_text" || chunk.type === "summary_text") &&
          typeof chunk.text === "string" &&
          chunk.text.trim()
        ) {
          return chunk.text.trim();
        }
      }
    }
  }

  // 3) Chat-style fallback
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

function tryParseJsonWithRepair(raw) {
  if (!raw) throw new Error("No raw JSON string to parse");

  // First attempt
  try { return JSON.parse(raw); } catch(e) {}

  // Repair by slicing the outer braces
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");

  if (first !== -1 && last !== -1 && last > first) {
    const slice = raw.slice(first, last + 1);
    try { return JSON.parse(slice); } catch(e2) {}
  }

  const preview = raw.slice(0, 200).replace(/\s+/g, " ");
  throw new Error("JSON parse failed after repair attempts. Preview: " + preview);
}

// -----------------------------------------------
// LLM CALL — Auto-Repair + Retry (Option C)
// -----------------------------------------------
async function callOpenAIOnce(creditText) {
  const apiKey = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!apiKey) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const truncated = creditText.slice(0, 15000);

  const payload = {
    model: "gpt-4o-mini",
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
            text: truncated
          }
        ]
      }
    ],
    temperature: 0,
    max_output_tokens: 4096 // ⭐ FIXED: No more truncation
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("LLM HTTP error: " + (await response.text()));
  }

  const json = await response.json();

  if (json.refusal) {
    throw new Error("LLM refusal: " + JSON.stringify(json.refusal));
  }

  const raw = extractJsonStringFromResponse(json);
  if (!raw) throw new Error("No output_text or summary_text returned");

  return tryParseJsonWithRepair(raw);
}

async function runCreditTextLLM(creditText) {
  let last = null;

  for (let i = 1; i <= 3; i++) {
    try {
      return await callOpenAIOnce(creditText);
    } catch (err) {
      last = err;
      console.error(`UnderwriteIQ LLM attempt ${i} failed: ${String(err)}`);

      // Hard fails shouldn’t retry
      const msg = String(err);
      if (
        msg.includes("HTTP") ||
        msg.includes("refusal") ||
        msg.includes("Missing")
      ) break;

      // Backoff
      await new Promise((r) => setTimeout(r, 150 * i));
    }
  }

  throw new Error("LLM failed after 3 attempts: " + String(last));
}

// -----------------------------------------------
// FUNDING LOGIC
// -----------------------------------------------
function computeFundingLogic(data) {
  const score = Number(data.score || 0);
  const util = Number(data.utilization_pct || 0);
  const neg = Number(data.negative_accounts || 0);

  const inq = data.inquiries || { ex: 0, tu: 0, eq: 0 };
  const totalInq = (inq.ex || 0) + (inq.tu || 0) + (inq.eq || 0);

  const fundable =
    score >= 700 &&
    util <= 30 &&
    neg === 0 &&
    totalInq <= 6;

  let base = 0;
  for (const tl of data.tradelines || []) {
    if (tl && typeof tl.limit === "number" && tl.limit > base) base = tl.limit;
  }

  const estimate = base
    ? Math.round((base * 5.5) / 1000) * 1000
    : 15000;

  return { fundable, estimate };
}

// -----------------------------------------------
// MAIN HANDLER — Upload + Parse + LLM
// -----------------------------------------------
module.exports = async function handler(req, res) {
  // CORS
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
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ files });
      });
    });

    const uploaded = files.file;
    if (!uploaded?.filepath) {
      return res.status(400).json({ ok: false, msg: "No file uploaded" });
    }

    // PDF → text
    const rawPDF = await fs.promises.readFile(uploaded.filepath);
    const pdf = await pdfParse(rawPDF);
    const text = (pdf.text || "").replace(/\s+/g, " ").trim();

    if (text.length < 50) {
      return res.status(400).json({
        ok: false,
        msg: "Unreadable PDF. Upload a text-based bureau credit report."
      });
    }

    // LLM pipeline
    const extracted = await runCreditTextLLM(text);

    // Funding logic
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
    console.error("❌ Parser error:", err);
    return res.status(500).json({
      ok: false,
      msg: "Parser failed",
      error: String(err)
    });
  }
};
