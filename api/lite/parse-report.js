// ==================================================================================
// UnderwriteIQ — CLEAN PARSER ONLY (v1)
// Endpoint: /api/lite/parse-report
//
// ❗ CRITICAL RULES FOR THIS FILE:
// - ONLY parses credit report PDF.
// - NO underwriting logic.
// - NO suggestions.
// - NO redirect logic.
// - NO business logic.
// - NO fundability logic.
// - NO display logic.
// - NO UWIQ logic.
//
// This file feeds:
//    ➜ /public/uwiq-switchboard.js (underwriting + distribution)
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");

// Vercel API
module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// ============================================================================
// ERROR LOGGER
// ============================================================================
function logError(tag, err, context = "") {
  const msg = `
==== ${new Date().toISOString()} — ${tag} ====
${context ? "Context:\n" + context + "\n" : ""}
${String(err && err.stack ? err.stack : err)}
---------------------------------------------
`;
  console.error(msg);
  try { fs.appendFileSync("/tmp/uwiq-errors.log", msg); } catch (_) {}
}

// ============================================================================
// FALLBACK RESULT (SAFE RETURN)
// ============================================================================
function buildFallbackResult(reason = "Analyzer failed") {
  return {
    ok: false,
    reason,
    bureaus: {
      experian: null,
      equifax: null,
      transunion: null
    },
    meta: { fallback: true }
  };
}

// ============================================================================
// STRICT SYSTEM PROMPT — LLM Schema
// ============================================================================
const LLM_PROMPT = `
You are UnderwriteIQ, a forensic-level credit report parser.

You will receive a full credit report PDF.

❗ Return ONLY this schema — no extras, no omissions:

{
  "bureaus": {
    "experian": {
      "score": number|null,
      "utilization_pct": number|null,
      "inquiries": number|null,
      "negatives": number|null,
      "late_payment_events": number|null,
      "names": string[],
      "addresses": string[],
      "employers": string[],
      "tradelines": [
        {
          "creditor": string|null,
          "type": "revolving"|"installment"|"auto"|"mortgage"|"other"|null,
          "status": string|null,
          "balance": number|null,
          "limit": number|null,
          "opened": "YYYY-MM"|"YYYY-MM-DD"|null,
          "closed": "YYYY-MM"|"YYYY-MM-DD"|null,
          "is_au": boolean|null
        }
      ]
    },
    "equifax": { SAME STRUCTURE },
    "transunion": { SAME STRUCTURE }
  }
}

NO commentary.
NO markdown.
NO invented values.
NO missing keys.
`;

// ============================================================================
// NORMALIZER HELPERS
// ============================================================================
function normalizeLLMOutput(str) {
  return String(str || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractJsonStringFromResponse(json) {
  // Responses API v1
  if (json.output_text) return json.output_text.trim();

  if (Array.isArray(json.output)) {
    for (const msg of json.output) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (
          (block.type === "output_text" || block.type === "summary_text") &&
          typeof block.text === "string"
        ) {
          return block.text.trim();
        }
      }
    }
  }

  // Legacy Chat API
  if (json.choices?.[0]?.message?.content) {
    return json.choices[0].message.content.trim();
  }

  return null;
}

// ============================================================================
// JSON REPAIR (STRICT)
// ============================================================================
function tryParseJsonWithRepair(raw) {
  if (!raw) throw new Error("EMPTY_OUTPUT");

  let cleaned = normalizeLLMOutput(raw);
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first === -1 || last === -1) {
    throw new Error("NO_JSON_OBJECT_FOUND");
  }

  let fixed = cleaned.slice(first, last + 1);

  // Remove trailing commas
  fixed = fixed.replace(/,\s*([}\]])/g, "$1");

  // Quote keys
  fixed = fixed.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

  // Quote dates
  fixed = fixed.replace(/:\s*(\d{4}-\d{2}(-\d{2})?)/g, ':"$1"');

  try {
    return JSON.parse(fixed);
  } catch (err) {
    logError("JSON_PARSE_FAIL", err, fixed.slice(0, 1000));
    throw err;
  }
}

// ============================================================================
// MULTIPASS GPT-4.1
// ============================================================================
async function callMultipass(pdfBuffer, filename) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing UNDERWRITE_IQ_VISION_KEY");

  const base64 = pdfBuffer.toString("base64");
  const dataUrl = `data:application/pdf;base64,${base64}`;

  // -------------------- PASS 1 --------------------
  const payload = {
    model: "gpt-4.1",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Extract credit report data." },
          { type: "input_file", filename, file_data: dataUrl }
        ]
      }
    ],
    temperature: 0,
    max_output_tokens: 6000
  };

  const r1 = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!r1.ok) throw new Error("LLM_ERROR: " + (await r1.text()));
  const j1 = await r1.json();
  const raw = extractJsonStringFromResponse(j1);
  return tryParseJsonWithRepair(raw);
}

// ============================================================================
// CLEAN BUREAU NORMALIZER (NO LOGIC)
// ============================================================================
function normalizeBureau(b) {
  if (!b || typeof b !== "object") {
    return {
      score: null,
      utilization_pct: null,
      inquiries: null,
      negatives: null,
      late_payment_events: null,
      names: [],
      addresses: [],
      employers: [],
      tradelines: []
    };
  }

  return {
    score: b.score ?? null,
    utilization_pct: b.utilization_pct ?? null,
    inquiries: b.inquiries ?? null,
    negatives: b.negatives ?? null,
    late_payment_events: b.late_payment_events ?? null,
    names: Array.isArray(b.names) ? b.names : [],
    addresses: Array.isArray(b.addresses) ? b.addresses : [],
    employers: Array.isArray(b.employers) ? b.employers : [],
    tradelines: Array.isArray(b.tradelines) ? b.tradelines : []
  };
}

// ============================================================================
// HANDLER — PURE PARSER
// ============================================================================
module.exports = async function handler(req, res) {
  try {
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

    // Parse upload
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { files } = await new Promise((resolve, reject) =>
      form.parse(req, (err, fields, files) =>
        err ? reject(err) : resolve({ files })
      )
    );

    const file = files.file;
    if (!file || !file.filepath) {
      return res.status(200).json(buildFallbackResult("No PDF uploaded"));
    }

    const buffer = await fs.promises.readFile(file.filepath);
    if (buffer.length < 1500) {
      return res.status(200).json(buildFallbackResult("File too small"));
    }

    // MULTIPASS PARSE
    let extracted;
    try {
      extracted = await callMultipass(buffer, file.originalFilename);
    } catch (err) {
      logError("LLM_CRASH", err);
      return res.status(200).json(buildFallbackResult("Could not parse PDF"));
    }

    // CLEAN NORMALIZATION
    const bureaus = {
      experian: normalizeBureau(extracted.bureaus?.experian),
      equifax: normalizeBureau(extracted.bureaus?.equifax),
      transunion: normalizeBureau(extracted.bureaus?.transunion)
    };

    // RETURN PURE PARSE
    return res.status(200).json({
      ok: true,
      bureaus,
      meta: {
        filename: file.originalFilename || null,
        size: buffer.length
      }
    });

  } catch (err) {
    logError("FATAL_ERROR", err);
    return res.status(200).json(buildFallbackResult("System error"));
  }
};
