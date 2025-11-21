// ==================================================================================
// UnderwriteIQ — Parse-Only Engine (v1)
// Endpoint: /api/lite/parse-report
//
// THIS VERSION DOES ONLY ONE JOB:
//
//   ✔ Accept PDF upload
//   ✔ Run gpt-4.1 multipass extraction
//   ✔ Output STRICT JSON:
//
//      {
//        ok: true,
//        bureaus: { experian, equifax, transunion },
//        raw_pdf_bytes: <optional>,
//        meta: { filename, size }
//      }
//
//   ❌ NO underwriting
//   ❌ NO suggestions
//   ❌ NO redirect
//   ❌ NO fundable logic
//   ❌ NO scoring logic
//
// UWIQ handles ALL LOGIC AFTER THIS.
//
// ==================================================================================

const fs = require("fs");
const formidable = require("formidable");

module.exports.config = {
  api: { bodyParser: false, sizeLimit: "30mb" }
};

// ==================================================================================
// UTIL: Write fatal errors to /tmp
// ==================================================================================
function logError(tag, err, ctx = "") {
  const msg = `
==== ${new Date().toISOString()} — ${tag} ====
${ctx ? "Context:\n" + ctx : ""}
${String(err?.stack || err)}
---------------------------------------------
`;
  console.error(msg);
  try { fs.appendFileSync("/tmp/uwiq-errors.log", msg); } catch (_) {}
}

// ==================================================================================
// CLIENT-SAFE FALLBACK (NO underwriting)
// ==================================================================================
function fallback(reason) {
  return {
    ok: false,
    reason,
    bureaus: {
      experian: null,
      equifax:  null,
      transunion: null
    }
  };
}

// ==================================================================================
// STRICT SYSTEM PROMPT — EXACTLY YOUR ORIGINAL SCHEMA
// ==================================================================================
const LLM_PROMPT = `
You are UnderwriteIQ, a forensic credit-report extractor.

You are given a PDF credit report.
Extract EXACT JSON per schema — NO extra keys.

Schema:
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
- No hallucination
- No guessing unknown values
- No markdown
- No commentary
- JSON ONLY
`;

// ==================================================================================
// CLEAN JSON HELPERS
// ==================================================================================
function normalizeLLM(str) {
  return String(str || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
}

function extractJsonString(resp) {
  if (resp.output_text) return resp.output_text.trim();

  if (Array.isArray(resp.output)) {
    for (const m of resp.output) {
      for (const c of (m.content || [])) {
        if ((c.type === "output_text" || c.type === "summary_text") && c.text)
          return c.text.trim();
      }
    }
  }

  if (resp.choices?.[0]?.message?.content)
    return resp.choices[0].message.content.trim();

  return null;
}

function tryParse(raw) {
  if (!raw) throw new Error("EMPTY_MODEL_OUTPUT");

  let s = normalizeLLM(raw);

  const first = s.indexOf("{");
  const last  = s.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("NO_JSON_FOUND");

  let fixed = s.substring(first, last + 1);
  fixed = fixed.replace(/,\s*([}\]])/g, "$1"); // trailing comma repair

  return JSON.parse(fixed);
}

// ==================================================================================
// MULTIPASS GPT-4.1
// ==================================================================================
async function runMultipass(pdfBuffer, filename) {
  const key = process.env.UNDERWRITE_IQ_VISION_KEY;
  if (!key) throw new Error("Missing API Key");

  const dataUrl = `data:application/pdf;base64,${pdfBuffer.toString("base64")}`;

  // -------- PASS 1 --------
  async function pass1() {
    const payload = {
      model: "gpt-4.1",
      input: [
        { role: "system", content: LLM_PROMPT },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Extract per schema." },
            { type: "input_file", filename, file_data: dataUrl }
          ]
        }
      ],
      temperature: 0,
      max_output_tokens: 6000
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) throw new Error(await r.text());
    return tryParse(extractJsonString(await r.json()));
  }

  // -------- PASS 2 --------
  async function pass2(guidance) {
    const payload = {
      model: "gpt-4.1",
      input: [
        { role: "system", content: LLM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Improve accuracy using guidance (no hallucination). Guidance: " +
                    JSON.stringify(guidance).slice(0, 18000)
            },
            { type: "input_file", filename, file_data: dataUrl }
          ]
        }
      ],
      temperature: 0,
      max_output_tokens: 6000
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) throw new Error(await r.text());
    return tryParse(extractJsonString(await r.json()));
  }

  // ---- RUN MULTIPASS ----
  const p1 = await pass1();
  const p2 = await pass2(p1);

  return p2;
}

// ==================================================================================
// HANDLER — Parse-only
// ==================================================================================
module.exports = async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method !== "POST")
      return res.status(405).json({ ok: false, msg: "Method not allowed" });

    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { files } = await new Promise((resolve, reject) =>
      form.parse(req, (err, fields, files) => err ? reject(err) : resolve({ files }))
    );

    const file = files.file;
    if (!file?.filepath)
      return res.status(200).json(fallback("No PDF uploaded"));

    const buffer = await fs.promises.readFile(file.filepath);
    if (buffer.length < 1500)
      return res.status(200).json(fallback("File too small to be a credit report"));

    // ---- RUN GPT MULTIPASS ----
    let bureaus;
    try {
      const extracted = await runMultipass(
        buffer,
        file.originalFilename || "credit.pdf"
      );

      bureaus = extracted?.bureaus;
      if (!bureaus) return res.status(200).json(fallback("Missing bureaus"));
    } catch (err) {
      logError("GPT_FAIL", err);
      return res.status(200).json(fallback("Could not extract report"));
    }

    // ---- SUCCESS ----
    return res.status(200).json({
      ok: true,
      bureaus,
      meta: {
        filename: file.originalFilename || null,
        size: buffer.length
      }
    });

  } catch (err) {
    logError("FATAL_HANDLER", err);
    return res.status(200).json(fallback("System error"));
  }
};
