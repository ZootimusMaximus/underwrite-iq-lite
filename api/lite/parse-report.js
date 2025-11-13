// ==================================================================================
// UnderwriteIQ LITE — LLM-Powered Credit Report Parser
// Vercel Serverless Function — FINAL VERSION FOR FORMIDABLE 2.1.1
// ==================================================================================

const fs = require("fs");
const path = require("path");
const formidable = require("formidable");

// Disable bodyParser
module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// ================================
// FIXED FILE UPLOAD HANDLER
// ================================
function vercelFileHandler(part) {
  const uploadDir = "/tmp";
  const filePath = path.join(uploadDir, part.originalFilename || "upload.pdf");
  const writeStream = fs.createWriteStream(filePath);
  part.pipe(writeStream);
  part.on("end", () => writeStream.end());
  return { filePath };
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      maxFileSize: 25 * 1024 * 1024,
      fileWriteStreamHandler: vercelFileHandler
    });

    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      const file = files.file;

      if (!file || !file.filepath) {
        return reject(new Error("Unable to locate uploaded file path"));
      }

      resolve({ filePath: file.filepath, fields });
    });
  });
}

// ================================
// AI PROMPT
// ================================
const LLM_PROMPT = `
You are UnderwriteIQ. Extract ALL credit report data. ONLY return JSON.
...
`;

// ================================
// AI CALL
// ================================
async function runVisionLLM(base64PDF) {
  const payload = {
    model: "gpt-4o-mini",
    reasoning: { effort: "medium" },
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extract credit report data. JSON only." },
          { type: "input_image", image_url: `data:application/pdf;base64,${base64PDF}` }
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

  if (!response.ok) throw new Error(await response.text());

  const json = await response.json();
  const text =
    json?.output_text ||
    json?.content ||
    json?.choices?.[0]?.message?.content ||
    "";

  return JSON.parse(text);
}

// ================================
// UNDERWRITING LOGIC
// ================================
function computeFundingLogic(data) {
  const score = Number(data.score || 0);
  const util = Number(data.utilization_pct || 0);
  const neg = Number(data.negative_accounts || 0);
  const inq = data.inquiries || { ex: 0, tu: 0, eq: 0 };
  const totalInq = inq.ex + inq.tu + inq.eq;

  const fundable =
    score >= 700 && util <= 30 && neg <= 0 && totalInq <= 6;

  let base = 0;
  for (const tl of data.tradelines || []) {
    if (tl.limit && tl.limit > base) base = tl.limit;
  }

  const estimate = base
    ? Math.round(base * 5.5 / 1000) * 1000
    : 15000;

  return { fundable, estimate };
}

// ================================
// MAIN HANDLER
// ================================
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, msg: "Method not allowed" });
  }

  try {
    const { filePath } = await parseMultipart(req);
    const raw = await fs.promises.readFile(filePath);
    const base64PDF = raw.toString("base64");

    const extracted = await runVisionLLM(base64PDF);
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
