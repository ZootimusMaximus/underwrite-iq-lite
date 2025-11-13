// ==================================================================================
// UnderwriteIQ LITE — TEXT + LLM Parser
// Option C: Retry + Repair + High Token Limit + Redirect
// Supports: negative_accounts + late_payment_events
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");

module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// -----------------------------------------------
// SYSTEM PROMPT (Compact JSON)
// -----------------------------------------------
const LLM_PROMPT = `
You are UnderwriteIQ, an AI credit analyst.
You will be given RAW TEXT extracted from a CREDIT REPORT PDF.
Return ONLY VALID COMPACT JSON (ONE LINE).
If unsure, use null or 0.

Fields:
score
score_model
utilization_pct
inquiries { ex, tu, eq }
negative_accounts
late_payment_events
tradelines[]
`;

// -----------------------------------------------
// JSON Extraction Helpers
// -----------------------------------------------
function extractJsonStringFromResponse(json) {
  if (json.output_text?.trim()) return json.output_text.trim();

  if (Array.isArray(json.output)) {
    for (const msg of json.output) {
      if (!msg?.content) continue;
      for (const chunk of msg.content) {
        if (
          (chunk.type === "output_text" || chunk.type === "summary_text") &&
          chunk.text?.trim()
        ) return chunk.text.trim();
      }
    }
  }

  if (json.choices?.[0]?.message?.content) {
    return json.choices[0].message.content.trim();
  }

  return null;
}

function tryParseJsonWithRepair(raw) {
  try { return JSON.parse(raw); } catch(e){}

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  }

  throw new Error("JSON parse failed. Preview: " + raw.slice(0,200));
}

// -----------------------------------------------
// Single OpenAI Call
// -----------------------------------------------
async function callOpenAIOnce(text) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const payload = {
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          { type: "input_text", text: text.slice(0,15000) }
        ]
      }
    ],
    temperature: 0,
    max_output_tokens: 4096
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok)
    throw new Error("LLM HTTP error: " + await resp.text());

  const json = await resp.json();

  if (json.refusal)
    throw new Error("LLM refusal: " + JSON.stringify(json.refusal));

  const raw = extractJsonStringFromResponse(json);
  if (!raw) throw new Error("LLM returned no output_text.");

  return tryParseJsonWithRepair(raw);
}

// -----------------------------------------------
// LLM Pipeline with Retry
// -----------------------------------------------
async function runCreditTextLLM(text) {
  let lastError = null;
  for (let i=1; i<=3; i++) {
    try {
      return await callOpenAIOnce(text);
    } catch (err) {
      lastError = err;
      const msg = String(err);
      console.error(`UnderwriteIQ LLM attempt ${i} failed:`, msg);

      if (
        msg.includes("HTTP") ||
        msg.includes("refusal") ||
        msg.includes("Missing")
      ) break;

      await new Promise(r => setTimeout(r, 150 * i));
    }
  }

  throw new Error("LLM failed after 3 attempts: " + String(lastError));
}

// -----------------------------------------------
// FUNDING LOGIC
// -----------------------------------------------
function computeFundingLogic(data) {
  const score = Number(data.score ?? 0);
  const util = Number(data.utilization_pct ?? 0);
  const neg  = Number(data.negative_accounts ?? 0);

  const inq = data.inquiries || { ex:0, tu:0, eq:0 };
  const totalInq = (inq.ex||0)+(inq.tu||0)+(inq.eq||0);

  const fundable =
    score >= 700 &&
    util <= 30 &&
    neg === 0 &&
    totalInq <= 6;

  let base = 0;
  for (const tl of data.tradelines || []) {
    if (tl?.limit && tl.limit > base)
      base = tl.limit;
  }

  const estimate = base
    ? Math.round((base * 5.5) / 1000) * 1000
    : 15000;

  return { fundable, estimate };
}

// -----------------------------------------------
// MAIN HANDLER
// -----------------------------------------------
module.exports = async function handler(req, res) {

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok:false, msg:"Method not allowed" });
  }

  try {
    // Parse file
    const form = formidable({
      multiples:false,
      keepExtensions:true,
      uploadDir:"/tmp",
      maxFileSize:25*1024*1024
    });

    const { files } = await new Promise((resolve, reject)=>
      form.parse(req, (err, fields, files)=>{
        if (err) reject(err);
        else resolve({ files });
      })
    );

    const file = files.file;
    if (!file?.filepath)
      return res.status(400).json({ ok:false, msg:"No file uploaded." });

    const buffer = await fs.promises.readFile(file.filepath);
    const parsedPDF = await pdfParse(buffer);

    const text = (parsedPDF.text || "")
      .replace(/\s+/g," ")
      .trim();

    if (text.length < 50)
      return res.status(400).json({
        ok:false,
        msg:"Unreadable PDF. Upload a real bureau report."
      });

    const extracted = await runCreditTextLLM(text);
    const uw = computeFundingLogic(extracted);

    // ⭐ Correct Redirect URLs for GoHighLevel
    const redirect = {
      url: uw.fundable
        ? "https://fundhub.ai/confirmation-page-296844-430611"             // FUNDING APPROVED
        : "https://fundhub.ai/confirmation-page-296844-430611-722950",     // FIX MY CREDIT
      query: {
        funding: uw.estimate,
        score: extracted.score,
        util: extracted.utilization_pct,
        inqEx: extracted.inquiries?.ex ?? 0,
        inqTu: extracted.inquiries?.tu ?? 0,
        inqEq: extracted.inquiries?.eq ?? 0,
        neg: extracted.negative_accounts,
        late: extracted.late_payment_events
      }
    };

    // SUCCESS
    return res.status(200).json({
      ok:true,
      inputs: extracted,
      outputs: {
        fundable: uw.fundable,
        banner_estimate: uw.estimate,
        negative_accounts: extracted.negative_accounts,
        negatives_count: extracted.negative_accounts,
        late_payment_events: extracted.late_payment_events
      },
      redirect
    });

  } catch(err) {
    console.error("❌ Parser error:", err);
    return res.status(500).json({
      ok:false,
      msg:"Parser failed",
      error:String(err)
    });
  }
};
