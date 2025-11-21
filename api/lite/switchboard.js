// ============================================================================
// UnderwriteIQ — SWITCHBOARD (v5 • FULL PIPELINE ORCHESTRATOR)
// Purpose:
//   ✔ Accept PDF upload
//   ✔ Validate PDF (validate-upload.js)
//   ✔ Extract bureaus (parse-report.js)
//   ✔ Run underwriting (underwriter.js)
//   ✔ Build redirect object for frontend
//   ✔ Return ALL DATA the frontend approved/repair pages expect
// ============================================================================

const formidable = require("formidable");
const fs = require("fs");

const validateUpload = require("./validate-upload");
const { computeUnderwrite, getNumberField } = require("./underwriter");

// ============================================================================
// SAFE NUMBER FOR URL PARAMS
// ============================================================================
function safe(v) {
  if (v == null || isNaN(v)) return 0;
  return Number(v);
}

// ============================================================================
// SEND TO PARSER (internal)
// ============================================================================
async function callParser(buffer, filename) {
  const r = await fetch(
    "https://underwrite-iq-lite.vercel.app/api/lite/parse-report",
    {
      method: "POST",
      headers: {},
      body: buffer, // raw stream from our switchboard
    }
  );

  const json = await r.json();
  return json;
}

// ============================================================================
// MAIN SWITCHBOARD ROUTE
// ============================================================================
module.exports = async function handler(req, res) {
  try {
    // ---------------------------------------------------------------
    // CORS
    // ---------------------------------------------------------------
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");

    // ---------------------------------------------------------------
    // Require POST
    // ---------------------------------------------------------------
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, msg: "Method not allowed" });
    }

    // ---------------------------------------------------------------
    // Parse incoming multipart/form upload
    // ---------------------------------------------------------------
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024,
    });

    const { files, fields } = await new Promise((resolve, reject) =>
      form.parse(req, (err, flds, fls) =>
        err ? reject(err) : resolve({ fields: flds, files: fls })
      )
    );

    const file = files.file;
    if (!file?.filepath) {
      return res.status(200).json({
        ok: false,
        msg: "No file uploaded",
      });
    }

    const buffer = await fs.promises.readFile(file.filepath);

    // ---------------------------------------------------------------
    // 1) VALIDATE PDF
    // ---------------------------------------------------------------
    const validation = validateUpload(buffer);
    if (!validation.ok) {
      return res.status(200).json({
        ok: false,
        msg: validation.msg || "Invalid PDF",
      });
    }

    // ---------------------------------------------------------------
    // 2) PARSE REPORT
    // ---------------------------------------------------------------
    const parsed = await callParser(buffer, file.originalFilename);

    if (!parsed.ok || !parsed.bureaus) {
      return res.status(200).json({
        ok: false,
        msg: "Parsing failed",
      });
    }

    // ---------------------------------------------------------------
    // 3) UNDERWRITE
    // ---------------------------------------------------------------
    const bureaus = parsed.bureaus;
    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");

    const uw = computeUnderwrite(bureaus, businessAgeMonths);
    const p = uw.personal || {};
    const b = uw.business || {};
    const t = uw.totals || {};
    const m = uw.metrics || {};
    const inq = m.inquiries || {};

    // ---------------------------------------------------------------
    // 4) BUILD URL PARAMS FOR FRONTEND
    // ---------------------------------------------------------------
    const params = new URLSearchParams({
      personalTotal: safe(p.total_personal_funding),
      businessTotal: safe(b.business_funding),
      totalCombined: safe(t.total_combined_funding),

      score: safe(m.score),
      util: safe(m.utilization_pct),

      inqEx: safe(inq.ex),
      inqTu: safe(inq.tu),
      inqEq: safe(inq.eq),

      neg: safe(m.negative_accounts),
      late: safe(m.late_payment_events),
    });

    // ---------------------------------------------------------------
    // 5) DECIDE REDIRECT PAGE
    // ---------------------------------------------------------------
    let redirect = {};

    if (uw.fundable) {
      redirect.url = "https://fundhub.ai/funding-approved";
      redirect.query = params;
    } else {
      redirect.url = "https://fundhub.ai/funding-repair";
      redirect.query = params;
    }

    // ---------------------------------------------------------------
    // RESPOND TO BROWSER
    // ---------------------------------------------------------------
    return res.status(200).json({
      ok: true,
      parsed,
      underwrite: uw,
      redirect,
    });
  } catch (err) {
    console.error("SWITCHBOARD ERROR", err);
    return res.status(200).json({
      ok: false,
      msg: "System error",
    });
  }
};
