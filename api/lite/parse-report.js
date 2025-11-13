// ==================================================================================
// UnderwriteIQ LITE — TEXT + LLM Parser (Option C: Auto-Repair + Retry)
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");

module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// -----------------------------------------------
// UnderwriteIQ SYSTEM PROMPT
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
// Helpers for LLM output extraction & JSON repair
// -----------------------------------------------

// Safely extract the JSON string from any Responses API shape
function extractJsonStringFromResponse(json) {
  // 1) Legacy/simple path (not used by your current response, but safe to keep)
  if (typeof json.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  // 2) New Responses API format: json.output is an array of message blocks
  if (Array.isArray(json.output)) {
    for (const msg of json.output) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const chunk of msg.content) {
        if (
          chunk &&
          (chunk.type === "output_text" || chunk.type === "summary_text") &&
          typeof chunk.text === "string" &&
          chunk.text.trim()
        ) {
          return chunk.text.trim();
        }
      }
    }
  }

  // 3) Old chat-style
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

// Try to parse JSON, with simple auto-repair for truncation/junk
function tryParseJsonWithRepair(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("No raw JSON string to parse");
  }

  // First attempt: direct parse
  try {
    return JSON.parse(raw);
  } catch (e) {
    // fall through to repair
  }

  // Repair attempt: slice between first '{' and last '}'
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const sliced = raw.slice(first, last + 1);
    try {
      return JSON.parse(sliced);
    } catch (e2) {
      // fall through
    }
  }

  // If still failing, throw with minimal leak (no full raw dump)
  const preview = raw.slice(0, 200).replace(/\s+/g, " ");
  throw new Error("JSON parse failed after repair attempts. Preview: " + preview);
}

// -----------------------------------------------
// LLM CALL with AUTO-REPAIR + RETRY (Option C)
// -----------------------------------------------
async function callOpenAIOnce(creditText) {
  const apiKey = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!apiKey) {
    throw new Error("Missing UNDERWRITE_IQ_VISION_KEY environment variable.");
  }

  const maxChars = 15000;
  const truncated = creditText.slice(0, maxChars);

  const payload = {
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: LLM_PROMPT // plain string system prompt
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
    max_output_tokens: 1200
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
    const errText = await response.text();
    throw new Error("LLM HTTP error: " + errText);
  }

  const json = await response.json();

  // If model explicitly refused, surface that
  if (json.refusal) {
    throw new Error("LLM refusal: " + JSON.stringify(json.refusal));
  }

  const raw = extractJsonStringFromResponse(json);
  if (!raw) {
    throw new Error("No usable output_text/summary_text found in LLM response.");
  }

  return tryParseJsonWithRepair(raw);
}

async function runCreditTextLLM(creditText) {
  const MAX_RETRIES = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < MAX_RETRIES) {
    try {
      return await callOpenAIOnce(creditText);
    } catch (err) {
      lastError = err;
      attempt += 1;

      // For HTTP / refusal errors, don't bother retrying multiple times
      const msg = String(err || "");
      const hardError =
        msg.includes("LLM HTTP error") ||
        msg.includes("LLM refusal") ||
        msg.includes("Missing UNDERWRITE_IQ_VISION_KEY");

      console.error(`UnderwriteIQ LLM attempt ${attempt} failed:`, msg);

      if (hardError || attempt >= MAX_RETRIES) {
        break;
      }

      // Small backoff
      const delayMs = 200 * attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(
    "LLM failed after retries. Last error: " + String(lastError || "Unknown")
  );
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
    if (tl && typeof tl.limit === "number" && tl.limit > base) {
      base = tl.limit;
    }
  }

  const estimate = base
    ? Math.round((base * 5.5) / 1000) * 1000
    : 15000;

  return { fundable, estimate };
}

// -----------------------------------------------
// MAIN HANDLER — FILE UPLOAD + PARSE + LLM
// -----------------------------------------------
module.exports = async function handler(req, res) {
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

  try {
    // -------- FORMIDABLE CONFIG --------
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const uploaded = files.file;
    if (!uploaded || !uploaded.filepath) {
      return res.status(400).json({
        ok: false,
        msg: "No file uploaded or missing file path"
      });
    }

    // -------- READ + PARSE PDF --------
    const rawPDF = await fs.promises.readFile(uploaded.filepath);
    const parsed = await pdfParse(rawPDF);

    let text = (parsed.text || "").replace(/\s+/g, " ").trim();
    if (!text || text.length < 50) {
      return res.status(400).json({
        ok: false,
        msg: "We couldn't read your PDF. Upload a text-based credit report (no photos or scans)."
      });
    }

    // -------- RUN LLM PIPELINE --------
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
    console.error("❌ Parser error:", err);
    return res.status(500).json({
      ok: false,
      msg: "Parser failed",
      error: String(err)
    });
  }
};
