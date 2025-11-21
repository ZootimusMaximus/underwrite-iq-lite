// ============================================================================
// UnderwriteIQ — SWITCHBOARD (v5 • FULL PIPELINE ORCHESTRATOR)
// Purpose:
// ✔ Accept PDF upload
// ✔ Basic validate PDF (size)
// ✔ Extract bureaus (parse-report.js via HTTP call)
// ✔ Run underwriting (underwriter.js)
// ✔ Build redirect object for frontend
// ✔ Return ALL DATA the frontend approved/repair pages expect
// ============================================================================

const formidable = require("formidable");
const fs = require("fs");
const { computeUnderwrite, getNumberField } = require("./underwriter");

// --- minimum size for a real credit report (~50 KB)
const MIN_PDF_SIZE_BYTES = 50 * 1024;

// --------------------------------------------------------------------------
// SAFE NUMBER FOR URL PARAMS
// --------------------------------------------------------------------------
function safe(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// --------------------------------------------------------------------------
// SEND TO PARSER (internal via HTTP, using the existing parse-report route)
// --------------------------------------------------------------------------
async function callParser(buffer, filename) {
  // Node 18+ / Vercel have global FormData + Blob
  const form = new FormData();
  const blob = new Blob([buffer], { type: "application/pdf" });

  form.append("file", blob, filename || "credit.pdf");

  const resp = await fetch(
    "https://underwrite-iq-lite.vercel.app/api/lite/parse-report",
    {
      method: "POST",
      body: form
    }
  );

  const json = await resp.json();
  return json;
}

// --------------------------------------------------------------------------
// MAIN SWITCHBOARD ROUTE
// --------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  try {
    // ----- CORS / preflight -----
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    }

    res.setHeader("Access-Control-Allow-Origin", "*");

    // ----- Method guard -----
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, msg: "Method not allowed" });
    }

    // ----- Parse multipart/form-data -----
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
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
        msg: "No file uploaded"
      });
    }

    const buffer = await fs.promises.readFile(file.filepath);

    // ----- 1) Basic PDF validation (size only for now) -----
    if (!buffer || buffer.length < MIN_PDF_SIZE_BYTES) {
      return res.status(200).json({
        ok: false,
        msg:
          "The file looks too small to be a full credit report. " +
          "Please upload the complete PDF from Experian, Equifax, or TransUnion."
      });
    }

    // ----- 2) PARSE REPORT -----
    const parsed = await callParser(buffer, file.originalFilename);
    if (!parsed || !parsed.ok || !parsed.bureaus) {
      return res.status(200).json({
        ok: false,
        msg: "Parsing failed"
      });
    }

    // ----- 3) UNDERWRITE -----
    const bureaus = parsed.bureaus;
    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");
    const uw = computeUnderwrite(bureaus, businessAgeMonths);

    const p = uw.personal || {};
    const b = uw.business || {};
    const t = uw.totals || {};
    const m = uw.metrics || {};
    const inq = m.inquiries || {};

    // ----- 4) BUILD QUERY OBJECT FOR FRONTEND -----
    const query = {
      personalTotal: safe(p.total_personal_funding),
      businessTotal: safe(b.business_funding),
      totalCombined: safe(t.total_combined_funding),
      score: safe(m.score),
      util: safe(m.utilization_pct),
      inqEx: safe(inq.ex),
      inqTu: safe(inq.tu),
      inqEq: safe(inq.eq),
      neg: safe(m.negative_accounts),
      late: safe(m.late_payment_events)
    };

    // ----- 5) DECIDE REDIRECT PAGE -----
    const redirect = {};

    if (uw.fundable) {
      // ✅ Approved route (your final URL)
      redirect.url =
        "https://fundhub.ai/funding-approved-analyzer-462533";
      redirect.query = query;
    } else {
      // 🧼 Repair route (your final URL)
      redirect.url =
        "https://fundhub.ai/fix-my-credit-analyzer";
      redirect.query = query;
    }

    // ----- 6) RESPOND TO BROWSER -----
    return res.status(200).json({
      ok: true,
      parsed,
      underwrite: uw,
      redirect
    });
  } catch (err) {
    console.error("SWITCHBOARD ERROR", err);
    return res.status(200).json({
      ok: false,
      msg: "System error"
    });
  }
};
