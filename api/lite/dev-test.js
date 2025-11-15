// =======================================================================
// UnderwriteIQ — Dev Endpoint
// Purpose: Show RAW bureau parsing for debugging (NO redirects, NO UW).
// =======================================================================

const fs = require("fs");
const formidable = require("formidable");
const pdfParse = require("pdf-parse");

module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// =========================================================
// Helper: Safe fallback (never breaks frontend)
// =========================================================
function fallback(reason) {
  return {
    ok: true,
    dev: true,
    fallback: true,
    reason,
    bureaus: {
      experian: {},
      equifax: {},
      transunion: {}
    }
  };
}

// =========================================================
// Helper: Extract JSON string from OpenAI responses
// =========================================================
function extractJsonStringFromResponse(json) {

  if (json.output_text && json.output_text.trim()) {
    return json.output_text.trim();
  }

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
  try { return JSON.parse(raw); } catch (_) {}

  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) {
    try { return JSON.parse(raw.slice(a, b + 1)); } catch (_) {}
  }

  throw new Error("JSON parse failed");
}

// =========================================================
// LLM PROMPT — EXACT MATCH TO production parse-report.js
// (but without underwriting)
// =========================================================
const LLM_PROMPT = `
You are UnderwriteIQ, an AI credit analyst.
Parse RAW CREDIT REPORT TEXT into separate bureaus.

Output JSON:
{
  "bureaus": {
    "experian": {
      "present": boolean,
      "score": number or null,
      "utilization_pct": number or null,
      "negative_accounts": number,
      "late_payment_events": number,
      "inquiries_count": number,
      "names": [],
      "addresses": [],
      "employers": [],
      "inquiries": [],
      "accounts": [],
      "tradelines": []
    },
    "equifax": { same fields... },
    "transunion": { same fields... }
  }
}

Rules:
- Only JSON. One line. No commentary.
- Do NOT mix bureaus.
- If unsure, leave empty arrays or null.
`;

// =========================================================
// Call OpenAI (single attempt for dev mode)
// =========================================================
async function callOpenAI(text) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const payload = {
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [{ type: "input_text", text: text.slice(0, 15000) }]
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

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("HTTP Error: " + t);
  }

  const json = await resp.json();

  const raw = extractJsonStringFromResponse(json);
  if (!raw) throw new Error("No output_text from LLM");

  return tryParseJsonWithRepair(raw);
}

// =========================================================
// Normalizer (matches production behavior)
// =========================================================
function normalize(b, key) {
  const safe = b && typeof b === "object" ? b : {};
  return {
    bureau: key,
    present: Boolean(safe.present),
    score: safe.score ?? null,
    utilization_pct: safe.utilization_pct ?? null,
    negative_accounts: safe.negative_accounts ?? 0,
    late_payment_events: safe.late_payment_events ?? 0,
    inquiries_count: safe.inquiries_count ?? 0,
    names: Array.isArray(safe.names) ? safe.names : [],
    addresses: Array.isArray(safe.addresses) ? safe.addresses : [],
    employers: Array.isArray(safe.employers) ? safe.employers : [],
    inquiries: Array.isArray(safe.inquiries) ? safe.inquiries : [],
    accounts: Array.isArray(safe.accounts) ? safe.accounts : [],
    tradelines: Array.isArray(safe.tradelines) ? safe.tradelines : []
  };
}

// =======================================================================
// MAIN DEV ENDPOINT
// =======================================================================
module.exports = async function handler(req, res) {
  try {
    // Preflight
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

    // Parse upload
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { files } = await new Promise((resolve, reject) =>
      form.parse(req, (err, _fields, files) => {
        if (err) reject(err);
        else resolve({ files });
      })
    );

    const file = files.file;
    if (!file?.filepath) return res.status(200).json(fallback("No file uploaded"));

    // PDF → text
    const buffer = await fs.promises.readFile(file.filepath);
    const parsedPDF = await pdfParse(buffer);
    const text = (parsedPDF.text || "").replace(/\s+/g, " ").trim();

    if (!text || text.length < 200) {
      return res.status(200).json(fallback("Not enough text extracted"));
    }

    // LLM call
    let extracted;
    try {
      extracted = await callOpenAI(text);
    } catch (err) {
      return res.status(200).json(fallback("LLM error: " + String(err)));
    }

    const rawB = extracted.bureaus || {};
    const bureaus = {
      experian: normalize(rawB.experian, "experian"),
      equifax: normalize(rawB.equifax, "equifax"),
      transunion: normalize(rawB.transunion, "transunion")
    };

    // DEV OUTPUT — full, unfiltered data
    return res.status(200).json({
      ok: true,
      dev: true,
      message: "Raw bureau parsing output",
      bureaus,
      raw_llm: extracted
    });

  } catch (err) {
    console.error("Fatal dev endpoint error:", err);
    return res.status(200).json(fallback("Fatal dev error"));
  }
};
