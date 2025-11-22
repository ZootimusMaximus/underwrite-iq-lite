// ============================================================================
// UnderwriteIQ — SWITCHBOARD (Stage 2: Validation + Merge + Underwrite + Suggestions)
// ============================================================================

const fs = require("fs");
const formidable = require("formidable");

const { validateReports } = require("./validate-reports");
const { computeUnderwrite, getNumberField } = require("./underwriter");
const { aiGateCheck } = require("./ai-gatekeeper");

// NEW — external suggestion engine
const { buildSuggestions } = require("./suggestions");

// You can move this to an env var if needed
const PARSE_ENDPOINT =
  process.env.PARSE_ENDPOINT ||
  "https://underwrite-iq-lite.vercel.app/api/lite/parse-report";

const MIN_PDF_BYTES = 40 * 1024;

// ----------------------------------------------------------------------------
// Safe number helper
// ----------------------------------------------------------------------------
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ----------------------------------------------------------------------------
// Call parse-report for one PDF
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// Detect bureau codes inside parsed result
// ----------------------------------------------------------------------------
function detectBureauCodes(parsed) {
  const out = [];
  if (!parsed?.bureaus) return out;

  const b = parsed.bureaus;
  if (b.experian) out.push("EX");
  if (b.equifax) out.push("EQ");
  if (b.transunion) out.push("TU");

  return out;
}

// ----------------------------------------------------------------------------
// Merge bureaus from 1–3 files (no duplicates allowed)
// ----------------------------------------------------------------------------
function mergeBureausOrThrow(parsedResults) {
  const final = { experian: null, equifax: null, transunion: null };
  const seen = { EX: false, EQ: false, TU: false };

  for (const parsed of parsedResults) {
    if (!parsed?.ok || !parsed.bureaus) {
      throw new Error("One uploaded report failed to parse.");
    }

    const codes = detectBureauCodes(parsed);
    if (codes.length === 0) {
      throw new Error(
        "One of the uploaded PDFs does not contain a recognizable Experian, Equifax, or TransUnion section."
      );
    }

    const b = parsed.bureaus;
    for (const code of codes) {
      if (code === "EX") {
        if (seen.EX) throw new Error("Duplicate Experian detected.");
        seen.EX = true;
        final.experian = b.experian;
      } else if (code === "EQ") {
        if (seen.EQ) throw new Error("Duplicate Equifax detected.");
        seen.EQ = true;
        final.equifax = b.equifax;
      } else if (code === "TU") {
        if (seen.TU) throw new Error("Duplicate TransUnion detected.");
        seen.TU = true;
        final.transunion = b.transunion;
      }
    }
  }

  if (!final.experian && !final.equifax && !final.transunion) {
    throw new Error("No valid bureaus were found.");
  }

  return final;
}

// ----------------------------------------------------------------------------
// Build card tags (unchanged)
// ----------------------------------------------------------------------------
function buildCards(uw) {
  const cards = [];
  const opt = uw.optimization || {};
  const metrics = uw.metrics || {};

  if (opt.needs_util_reduction) cards.push("util_high");
  if (opt.needs_new_primary_revolving) cards.push("needs_revolving");
  if (opt.needs_inquiry_cleanup) cards.push("inquiries");
  if (opt.needs_negative_cleanup) cards.push("negatives");
  if (opt.needs_file_buildout) cards.push("file_buildout");

  if (!uw.fundable && (metrics.score || 0) >= 680) {
    cards.push("near_approval");
  }

  return cards;
}

// ============================================================================
// MAIN HANDLER
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

    // Parse files
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

    let raw = files?.file;
    let fileList = Array.isArray(raw) ? raw : raw ? [raw] : [];

    // Stage 1: structural validation
    const validation = await validateReports(fileList);
    if (!validation.ok) {
      return res.status(200).json({ ok: false, msg: validation.reason });
    }

    const validatedFiles = validation.files || fileList;
    if (validatedFiles.length === 0) {
      return res.status(200).json({ ok: false, msg: "No valid files." });
    }

    // Stage 1b: AI gatekeeper + parsing
    const parsedResults = [];
    for (const f of validatedFiles) {
      const buf = await fs.promises.readFile(f.filepath);

      if (!buf || buf.length < MIN_PDF_BYTES) {
        return res.status(200).json({
          ok: false,
          msg: "One PDF appears incomplete or corrupted."
        });
      }

      const gate = await aiGateCheck(buf, f.originalFilename);
      if (!gate.ok) {
        return res.status(200).json({ ok: false, msg: gate.reason });
      }

      const parsed = await callParseReport(buf, f.originalFilename);
      parsedResults.push(parsed);
    }

    // Stage 3: bureau merge
    let mergedBureaus;
    try {
      mergedBureaus = mergeBureausOrThrow(parsedResults);
    } catch (err) {
      return res.status(200).json({ ok: false, msg: err.message });
    }

    // Stage 4: underwriting
    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");
    const uw = computeUnderwrite(mergedBureaus, businessAgeMonths);

    const p = uw.personal || {};
    const b = uw.business || {};
    const t = uw.totals || {};
    const m = uw.metrics || {};
    const inq = m.inquiries || {};

    // Stage 5: cards + suggestions
    const cards = buildCards(uw);

    // NEW — LLC logic injected correctly
    const suggestions = buildSuggestions(uw, {
      hasLLC: fields.hasLLC === "true" || fields.hasLLC === true,
      llcAgeMonths: Number(fields.llcAgeMonths || 0)
    });

    // Stage 6: query params for frontend
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

    // Stage 7: redirect
    const redirect = {
      url: uw.fundable
        ? "https://fundhub.ai/funding-approved-analyzer-462533"
        : "https://fundhub.ai/fix-my-credit-analyzer",
      query
    };

    // Final response
    return res.status(200).json({
      ok: true,
      parsed: parsedResults,
      bureaus: mergedBureaus,
      underwrite: uw,
      optimization: uw.optimization || {},
      cards,
      suggestions,
      redirect
    });

  } catch (err) {
    console.error("SWITCHBOARD FATAL ERROR:", err);
    return res.status(200).json({ ok: false, msg: "System error in switchboard." });
  }
};
