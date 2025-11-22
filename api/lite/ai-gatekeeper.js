// ============================================================================
// UnderwriteIQ — SWITCHBOARD (Stage 2: Validation + AI Gate + Parse + Merge)
// ============================================================================

const fs = require("fs");
const formidable = require("formidable");

// FIXED: Import correctly with named export OR default fallback
const gateModule = require("./ai-gatekeeper");
const aiGateCheck = gateModule.aiGateCheck || gateModule.default || gateModule;

const { validateReports } = require("./validate-reports");
const { computeUnderwrite, getNumberField } = require("./underwriter");

const PARSE_ENDPOINT =
  process.env.PARSE_ENDPOINT ||
  "https://underwrite-iq-lite.vercel.app/api/lite/parse-report";

const MIN_PDF_BYTES = 40 * 1024;

// Safe number for URLs
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------- GPT Parser Call ----------
async function callParseReport(buffer, filename) {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: "application/pdf" });
  formData.append("file", blob, filename || "report.pdf");

  const resp = await fetch(PARSE_ENDPOINT, {
    method: "POST",
    body: formData
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`parse-report HTTP error: ${resp.status} ${text}`);
  }

  return await resp.json();
}

// ---------- Bureau Detection ----------
function detectBureauCodes(parsed) {
  const out = [];
  if (!parsed?.bureaus) return out;
  const b = parsed.bureaus;

  if (b.experian) out.push("EX");
  if (b.equifax) out.push("EQ");
  if (b.transunion) out.push("TU");

  return out;
}

// ---------- Merge Bureau Results ----------
function mergeBureausOrThrow(parsedResults) {
  const final = { experian: null, equifax: null, transunion: null };
  const seen = { EX: false, EQ: false, TU: false };

  for (const parsed of parsedResults) {
    if (!parsed?.ok || !parsed.bureaus)
      throw new Error("One of the reports could not be parsed.");

    const b = parsed.bureaus;
    const codes = detectBureauCodes(parsed);

    if (codes.length === 0)
      throw new Error("Uploaded PDF does not contain recognizable bureaus.");

    for (const code of codes) {
      if (code === "EX") {
        if (seen.EX) throw new Error("Duplicate Experian detected.");
        seen.EX = true;
        final.experian = b.experian;
      }
      if (code === "EQ") {
        if (seen.EQ) throw new Error("Duplicate Equifax detected.");
        seen.EQ = true;
        final.equifax = b.equifax;
      }
      if (code === "TU") {
        if (seen.TU) throw new Error("Duplicate TransUnion detected.");
        seen.TU = true;
        final.transunion = b.transunion;
      }
    }
  }

  if (!final.experian && !final.equifax && !final.transunion) {
    throw new Error("No valid bureaus found.");
  }

  return final;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================
module.exports = async function handler(req, res) {
  try {
    // ---------- CORS ----------
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

    // ---------- Parse form-data ----------
    const form = formidable({
      multiples: true,
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { files, fields } = await new Promise((resolve, reject) =>
      form.parse(req, (err, flds, fls) =>
        err ? reject(err) : resolve({ fields: flds, files: fls })
      )
    );

    const rawFiles = files?.file;
    const fileList = Array.isArray(rawFiles)
      ? rawFiles
      : rawFiles
      ? [rawFiles]
      : [];

    // ========================================================================
    // STAGE 1 — VALIDATE FILES
    // ========================================================================
    const validation = await validateReports(fileList);

    if (!validation.ok) {
      return res.status(200).json({ ok: false, msg: validation.reason });
    }

    const validatedFiles = validation.files || fileList;

    if (!validatedFiles.length) {
      return res.status(200).json({ ok: false, msg: "No valid PDFs." });
    }

    // ========================================================================
    // STAGE 1.5 — AI GATEKEEPER
    // ========================================================================
    for (const f of validatedFiles) {
      const buf = await fs.promises.readFile(f.filepath);

      // FIXED: aiGateCheck ALWAYS exists here
      const gate = await aiGateCheck(buf, f.originalFilename);

      if (!gate.ok) {
        return res.status(200).json({
          ok: false,
          msg: gate.reason || "File rejected by AI gatekeeper."
        });
      }
    }

    // ========================================================================
    // STAGE 2 — GPT PARSE
    // ========================================================================
    const parsedResults = [];

    for (const f of validatedFiles) {
      const buf = await fs.promises.readFile(f.filepath);

      if (buf.length < MIN_PDF_BYTES) {
        return res.status(200).json({
          ok: false,
          msg: "One PDF is too small or corrupted."
        });
      }

      const parsed = await callParseReport(buf, f.originalFilename);
      parsedResults.push(parsed);
    }

    // ========================================================================
    // STAGE 3 — MERGE BUREAUS
    // ========================================================================
    let mergedBureaus;

    try {
      mergedBureaus = mergeBureausOrThrow(parsedResults);
    } catch (err) {
      return res.status(200).json({ ok: false, msg: err.message });
    }

    // ========================================================================
    // STAGE 4 — UNDERWRITING ENGINE
    // ========================================================================
    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");
    const uw = computeUnderwrite(mergedBureaus, businessAgeMonths);

    const p = uw.personal || {};
    const b = uw.business || {};
    const t = uw.totals || {};
    const m = uw.metrics || {};
    const inq = m.inquiries || {};
    const opt = uw.optimization || {};

    // ========================================================================
    // STAGE 5 — SUGGESTION CARDS
    // ========================================================================
    const suggestionCards = [];

    if (opt.needs_util_reduction) suggestionCards.push("util_high");
    if (opt.needs_new_primary_revolving) suggestionCards.push("needs_revolving");
    if (opt.needs_inquiry_cleanup) suggestionCards.push("inquiries");
    if (opt.needs_negative_cleanup) suggestionCards.push("negatives");
    if (opt.needs_file_buildout || opt.thin_file || opt.file_all_negative)
      suggestionCards.push("build_file");

    // ========================================================================
    // STAGE 6 — FRONTEND QUERY PARAMS
    // ========================================================================
    const query = {
      personalTotal: safeNum(p.total_personal_funding),
      businessTotal: safeNum(b.business_funding),
      totalCombined: safeNum(t.total_combined_funding),

      score: safeNum(m.score),
      util: safeNum(m.utilization_pct),

      inqEx: safeNum(inq.ex),
      inqTu: safeNum(inq.tu),
      inqEq: safeNum(inq.eq),

      neg: safeNum(m.negative_accounts),
      late: safeNum(m.late_payment_events)
    };

    // ========================================================================
    // STAGE 7 — REDIRECT SELECTION
    // ========================================================================
    const redirect = {
      url: uw.fundable
        ? "https://fundhub.ai/funding-approved-analyzer-462533"
        : "https://fundhub.ai/fix-my-credit-analyzer",
      query
    };

    // ========================================================================
    // FINAL RESPONSE
    // ========================================================================
    return res.status(200).json({
      ok: true,
      parsed: parsedResults,
      bureaus: mergedBureaus,
      underwrite: uw,
      optimization: opt,
      cards: suggestionCards,
      redirect
    });

  } catch (err) {
    console.error("SWITCHBOARD ERROR:", err);
    return res.status(200).json({
      ok: false,
      msg: "System error in switchboard."
    });
  }
};
