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
// MULTIPASS GPT-4.1
// ============================================================================
async function call4_1(pdfBuffer, filename) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing key");

  const base64 = pdfBuffer.toString("base64");
  const dataUrl = `data:application/pdf;base64,${base64}`;
  const safeName = filename || "credit.pdf";

  // ---- PASS 1
  const p1 = {
    model: "gpt-4.1",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Pass 1: Extract raw JSON." },
          { type: "input_file", filename: safeName, file_data: dataUrl }
        ]
      }
    ],
    temperature: 0,
    max_output_tokens: 6000
  };
  const r1 = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(p1)
  });
  if (!r1.ok) throw new Error(await r1.text());
  const raw1 = extractJsonFromResponse(await r1.json());
  const pass1 = repairJSON(raw1);

  // ---- PASS 2 (guided)
  const guidance = JSON.stringify(pass1).slice(0, 18000);
  const p2 = {
    model: "gpt-4.1",
    input: [
      { role: "system", content: LLM_PROMPT },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Pass 2: Improve accuracy using this guidance: " + guidance },
          { type: "input_file", filename: safeName, file_data: dataUrl }
        ]
      }
    ],
    temperature: 0
  };
  const r2 = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(p2)
  });
  if (!r2.ok) throw new Error(await r2.text());
  const raw2 = extractJsonFromResponse(await r2.json());
  const pass2 = repairJSON(raw2);

  // ---- PASS 3 (strict finalization)
  const p3 = {
    model: "gpt-4.1",
    input: [
      {
        role: "system",
        content: LLM_PROMPT + "\nRETURN STRICT SCHEMA ONLY."
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Pass 3: Final cleanup. Input: " + JSON.stringify(pass2).slice(0, 18000) }
        ]
      }
    ]
  };
  const r3 = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(p3)
  });
  if (!r3.ok) throw new Error(await r3.text());
  const raw3 = extractJsonFromResponse(await r3.json());
  return repairJSON(raw3);
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
      maxFileSize: 25 * 1024 * 1024
    });

    const { files } = await new Promise((resolve, reject) =>
      form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })))
    );

    const file = files.file;
    if (!file?.filepath) {
      return res.status(200).json(buildFallback("No file uploaded."));
    }

    const buf = await fs.promises.readFile(file.filepath);
    if (buf.length < 1000) return res.status(200).json(buildFallback("PDF too small."));

    let extracted;
    try {
      extracted = await call4_1(buf, file.originalFilename);
    } catch (err) {
      logError("LLM_CRASH", err);
      return res.status(200).json(buildFallback("Could not parse report."));
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
    return res.status(200).json(buildFallback("System error."));
  }
};
