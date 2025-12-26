// ==================================================================================
// UnderwriteIQ — Parse-Only Engine (v1 • CLEAN VERSION)
// Endpoint: /api/lite/parse-report
//
// THIS FILE *ONLY* DOES ONE JOB:
//
//   ✔ Accept PDF upload
//   ✔ Run gpt-4.1 multipass extraction
//   ✔ Output STRICT JSON:
//
//      {
//        ok: true,
//        bureaus: { experian, equifax, transunion },
//        meta: { filename, size }
//      }
//
//   ❌ NO underwriting
//   ❌ NO suggestions
//   ❌ NO redirect
//   ❌ NO decision logic
//
// The next step happens in underwriter.js + switchboard.js
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");
const { googleOCR } = require("./google-ocr.js");
const { validateConfig } = require("./config-validator");
const { logError, logInfo, logWarn } = require("./logger");
const { fetchOpenAI } = require("./fetch-utils");

// Validate configuration on module load
try {
  validateConfig();
} catch (err) {
  logError("Configuration validation failed", err);
  // Allow module to load but will fail on first request
}

module.exports.config = {
  api: { bodyParser: false, sizeLimit: "20mb" }
};

// ============================================================================
// FALLBACK RESULT — safe for clients
// ============================================================================
function buildFallback(reason = "Analyzer failed") {
  return {
    ok: false,
    reason,
    bureaus: {
      experian: null,
      equifax: null,
      transunion: null
    }
  };
}

// ============================================================================
// STRICT SYSTEM PROMPT (schema from your original code)
// ============================================================================
const LLM_PROMPT = `
You are UnderwriteIQ, a forensic-level credit report analyzer.

You receive a FULL CONSUMER CREDIT REPORT PDF.
Extract ONLY the data defined in this schema:

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

RULES:
- No invented values
- No missing keys
- No markdown
- No commentary
- If unknown → null
`;

// ============================================================================
// NORMALIZATION HELPERS
// ============================================================================
function normalizeOut(str) {
  return String(str || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractJsonFromResponse(r) {
  if (r.output_text) return r.output_text.trim();

  if (Array.isArray(r.output)) {
    for (const msg of r.output) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "output_text" && typeof block.text === "string") {
          return block.text.trim();
        }
      }
    }
  }

  if (r.choices?.[0]?.message?.content) {
    return r.choices[0].message.content.trim();
  }

  return null;
}

function repairJSON(raw) {
  let txt = normalizeOut(raw);

  const first = txt.indexOf("{");
  const last = txt.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("NO_JSON_FOUND");
  txt = txt.substring(first, last + 1);

  txt = txt.replace(/,\s*([}\]])/g, "$1");
  txt = txt.replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

  return JSON.parse(txt);
}

// ============================================================================
// SINGLE-PASS GPT-4.1 (OPTIMIZED FOR SPEED)
// Goal: <10 seconds total
// ============================================================================
async function call4_1(pdfBuffer, filename) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing key");

  const base64 = pdfBuffer.toString("base64");
  const dataUrl = `data:application/pdf;base64,${base64}`;
  const safeName = filename || "credit.pdf";

  // Use faster model for large PDFs to avoid timeout (> 3MB but < 6MB)
  // Very large files (> 6MB) use gpt-4.1 as gpt-4o-mini may fail on complex PDFs
  const LARGE_FILE_THRESHOLD = 3 * 1024 * 1024; // 3MB
  const VERY_LARGE_THRESHOLD = 6 * 1024 * 1024; // 6MB
  const isLargeFile = pdfBuffer.length > LARGE_FILE_THRESHOLD;
  const isVeryLargeFile = pdfBuffer.length > VERY_LARGE_THRESHOLD;

  // gpt-4o-mini for 3-6MB files (faster), gpt-4.1 for <3MB or >6MB (more capable)
  let defaultModel;
  if (isVeryLargeFile) {
    defaultModel = "gpt-4.1"; // More capable for complex large files
  } else if (isLargeFile) {
    defaultModel = "gpt-4o-mini"; // Fast for medium files
  } else {
    defaultModel = "gpt-4.1"; // Best quality for small files
  }
  const model = process.env.PARSE_MODEL || defaultModel;

  if (isLargeFile || isVeryLargeFile) {
    logInfo("Model selection for large file", {
      filename: safeName,
      isVeryLarge: isVeryLargeFile,
      size_mb: (pdfBuffer.length / 1024 / 1024).toFixed(2),
      model
    });
  }

  const startTime = Date.now();

  // SINGLE PASS - optimized prompt for accuracy in one shot
  const payload = {
    model,
    input: [
      {
        role: "system",
        content: LLM_PROMPT + "\n\nCRITICAL: Return valid JSON in ONE pass. Be thorough but fast."
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Extract all credit data from this report. Return STRICT JSON only."
          },
          { type: "input_file", filename: safeName, file_data: dataUrl }
        ]
      }
    ],
    temperature: 0,
    max_output_tokens: 8000
  };

  const response = await fetchOpenAI("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    logError("OpenAI API error", {
      status: response.status,
      error: errorText.slice(0, 500),
      filename: safeName,
      size_mb: (pdfBuffer.length / 1024 / 1024).toFixed(2)
    });
    throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const responseData = await response.json();
  const rawJson = extractJsonFromResponse(responseData);

  if (!rawJson) {
    logError("No JSON in OpenAI response", {
      filename: safeName,
      responseKeys: Object.keys(responseData || {}),
      outputType: typeof responseData?.output
    });
    throw new Error("No extractable JSON in OpenAI response");
  }

  let parsed;
  try {
    parsed = repairJSON(rawJson);
  } catch (jsonErr) {
    logError("JSON parse/repair failed", {
      filename: safeName,
      error: jsonErr.message,
      rawJsonPreview: rawJson?.slice(0, 300)
    });
    throw jsonErr;
  }

  const elapsed = Date.now() - startTime;
  logInfo("Parse completed", { model, elapsed_ms: elapsed, filename: safeName });

  return parsed;
}

// ============================================================================
// MAIN HANDLER (Parse Only)
// ============================================================================
module.exports = async function handler(req, res) {
  try {
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

    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 20 * 1024 * 1024
    });

    const { files } = await new Promise((resolve, reject) =>
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })))
    );

    const file = files.file;
    if (!file?.filepath) {
      return res
        .status(200)
        .json(buildFallback("No file was received. Please select a PDF file and try again."));
    }

    const buf = await fs.promises.readFile(file.filepath);
    if (buf.length < 1000)
      return res
        .status(200)
        .json(
          buildFallback(
            "This PDF file is too small to be a valid credit report. Please upload a complete credit report PDF."
          )
        );

    // Run OCR in background (non-blocking) to save time
    if (process.env.IDENTITY_VERIFICATION_ENABLED !== "false") {
      googleOCR(buf)
        .then(r => logInfo("Google OCR completed", { note: r.note || "OK" }))
        .catch(e => logWarn("Google OCR failed", { error: e.message }));
    }

    let extracted;
    try {
      extracted = await call4_1(buf, file.originalFilename);
    } catch (err) {
      logError("LLM_CRASH", err);
      return res
        .status(200)
        .json(
          buildFallback(
            "We couldn't read this credit report. Please make sure you're uploading an official PDF credit report and try again."
          )
        );
    }

    return res.status(200).json({
      ok: true,
      bureaus: extracted.bureaus || { experian: null, equifax: null, transunion: null },
      meta: {
        filename: file.originalFilename || "",
        size: buf.length
      }
    });
  } catch (err) {
    logError("FATAL", err);
    return res
      .status(200)
      .json(
        buildFallback(
          "Something went wrong while processing your file. Please try again or upload a different credit report."
        )
      );
  }
};

/**
 * Direct parsing function (bypasses HTTP, avoids payload size limits)
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} filename - Original filename
 * @returns {Promise<{ok: boolean, bureaus: object, meta?: object, reason?: string}>}
 */
module.exports.parseBuffer = async function parseBuffer(pdfBuffer, filename) {
  try {
    const extracted = await call4_1(pdfBuffer, filename);
    return {
      ok: true,
      bureaus: extracted.bureaus || { experian: null, equifax: null, transunion: null },
      meta: { filename: filename || "", size: pdfBuffer.length }
    };
  } catch (err) {
    logError("parseBuffer error", err);
    const fallback = buildFallback(
      "We couldn't read this credit report. Please try a different file."
    );
    // Include error type for debugging (visible in job status)
    fallback.debug = err.message?.slice(0, 100) || "unknown_error";
    return fallback;
  }
};
