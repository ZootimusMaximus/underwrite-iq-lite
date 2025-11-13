// ==================================================================================
// UnderwriteIQ LITE — TEXT + LLM Diagnostic Version (Vercel-safe)
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
Your job is to reconstruct the report into CLEAN STRUCTURED JSON.

Return ONLY VALID JSON. NO markdown. If unsure, use null or 0.

FIELDS:
- score
- score_model
- utilization_pct
- inquiries: ex, tu, eq
- negative_accounts
- late_payment_events
- tradelines[] with creditor, type, status, balance, limit, past_due, opened, closed, payment_history_summary{}
`;

// -----------------------------------------------
// FIXED + DIAGNOSTIC VERSION OF LLM CALL
// -----------------------------------------------
async function runCreditTextLLM(creditText) {
  const truncated = creditText.slice(0, 15000);

  const payload = {
    model: "gpt-4o-mini",
    input: [
      {
        role: "system",
        content: LLM_PROMPT // MUST be plain string
      },
      {
        role: "user",
        content: [
          {
            type: "input_text", // MUST be input_text
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
      "Authorization": `Bearer ${process.env.UNDERWRITE_IQ_VISION_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  // HTTP error?
  if (!response.ok) {
    const errText = await response.text();
    throw new Error("LLM HTTP error: " + errText);
  }

  const json = await response.json();

  // 🔥 LOG EVERYTHING to Vercel for diagnosis
  console.log("🔥 RAW RESPONSE FROM OPENAI:", JSON.stringify(json, null, 2));

  // -----------------------------------------------
  // EXTRACT OUTPUT (catch ALL OpenAI formats)
  // -----------------------------------------------

  // 1) Standard Responses API output
  if (json.output_text && json.output_text.trim()) {
    try { return JSON.parse(json.output_text); }
    catch { /* fall through */ }
  }

  // 2) New format: array of output blocks
  if (Array.isArray(json.output)) {
    for (const block of json.output) {
      if (block.type === "output_text" && block.text?.trim()) {
        try { return JSON.parse(block.text); }
        catch { /* fall */ }
      }
      if (block.type === "summary_text" && block.text?.trim()) {
        try { return JSON.parse(block.text); }
        catch { /* fall */ }
      }
    }
  }

  // 3) Old chat-format
  if (json.choices?.[0]?.message?.content) {
    const text = json.choices[0].message.content.trim();
    try { return JSON.parse(text); }
    catch {}
  }

  // 4) Model refused
  if (json.refusal) {
    throw new Error("LLM refusal: " + JSON.stringify(json.refusal));
  }

  // 5) NOTHING usable — return full JSON to error logs
  throw new Error(
    "LLM returned empty or unparseable output. Full response logged above."
  );
}

// -----------------------------------------------
// FUNDING LOGIC
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
// MAIN HANDLER — FILE UPLOAD + PARSE + LLM
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

    const rawPDF = await fs.promises.readFile(uploaded.filepath);
    const parsed = await pdfParse(rawPDF);
    let text = (parsed.text || "").replace(/\s+/g, " ").trim();

    if (!text || text.length < 50) {
      return res.status(400).json({
        ok: false,
        msg: "Could not read PDF. Upload a text-based credit report (no photos)."
      });
    }

    const extracted = await runCreditTextLLM(text);
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
