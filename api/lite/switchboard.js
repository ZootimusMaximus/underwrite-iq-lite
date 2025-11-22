// ============================================================================
// UnderwriteIQ — SWITCHBOARD (Stage 2: Validation + Merge + Underwrite + Suggestions)
// ----------------------------------------------------------------------------
// Responsibilities:
//   ✔ Accept 1–3 uploaded PDFs
//   ✔ Run Stage 1 structural validation (validate-reports.js)
//   ✔ Optional cheap AI gate (ai-gatekeeper.js) to reject obvious non-reports
//   ✔ Call parse-report.js ONCE PER FILE (GPT-4.1) to extract bureaus
//   ✔ Enforce business rules about bureau combinations:
//        - Allow 1–3 reports total
//        - Allow any mix of EX/EQ/TU
//        - ❌ No duplicate bureaus (e.g. 2 Experian reports)
//        - Tri-merge is naturally forced to be alone because it contains all 3
//   ✔ Merge all bureaus into one { experian, equifax, transunion } object
//   ✔ Run computeUnderwrite(mergedBureaus, businessAgeMonths)
//   ✔ Build cards + suggestions
//   ✔ Decide Approved vs Repair + redirect
//   ✔ Return redirect object + data for frontend / tester
//
// NOT responsible for:
//   ✖ Parsing PDFs directly (that's parse-report.js)
//   ✖ Low-level file validation (that's validate-reports.js)
//   ✖ UI changes
//   ✖ Email / PDF generation (later)
// ============================================================================

const fs = require("fs");
const formidable = require("formidable");

const { validateReports } = require("./validate-reports");
const { computeUnderwrite, getNumberField } = require("./underwriter");
const { aiGateCheck } = require("./ai-gatekeeper");

// You can move this to an env var if you want later.
const PARSE_ENDPOINT =
  process.env.PARSE_ENDPOINT ||
  "https://underwrite-iq-lite.vercel.app/api/lite/parse-report";

// Minimum bytes for a realistic credit report (safety net, but Stage 1 already checks)
const MIN_PDF_BYTES = 40 * 1024;

// ----------------------------------------------------------------------------
// Safe number helper for URL params
// ----------------------------------------------------------------------------
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ----------------------------------------------------------------------------
// Call parse-report for a single PDF buffer
// ----------------------------------------------------------------------------
async function callParseReport(buffer, filename) {
  // Node 18+ / Vercel: FormData + Blob are globally available
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

  const json = await resp.json();
  return json;
}

// ----------------------------------------------------------------------------
// Detect which bureaus exist in a parsed result
// ----------------------------------------------------------------------------
function detectBureauCodes(parsed) {
  const out = [];
  if (!parsed || !parsed.bureaus) return out;
  const b = parsed.bureaus;

  if (b.experian) out.push("EX");
  if (b.equifax) out.push("EQ");
  if (b.transunion) out.push("TU");

  return out;
}

// ----------------------------------------------------------------------------
// Merge bureaus from multiple parsed results, enforcing "no duplicates" rule
// ----------------------------------------------------------------------------
function mergeBureausOrThrow(parsedResults) {
  const final = {
    experian: null,
    equifax: null,
    transunion: null
  };

  const seen = {
    EX: false,
    EQ: false,
    TU: false
  };

  for (const parsed of parsedResults) {
    if (!parsed || !parsed.ok || !parsed.bureaus) {
      throw new Error("One of the reports could not be parsed.");
    }

    const b = parsed.bureaus;
    const codes = detectBureauCodes(parsed);

    // If this file has no recognized bureaus at all, error
    if (codes.length === 0) {
      throw new Error(
        "One of the uploaded PDFs does not appear to contain a recognizable Experian, Equifax, or TransUnion section."
      );
    }

    for (const code of codes) {
      if (code === "EX") {
        if (seen.EX) {
          throw new Error(
            "Duplicate Experian data detected across multiple reports. Upload only one Experian report."
          );
        }
        seen.EX = true;
        final.experian = b.experian;
      } else if (code === "EQ") {
        if (seen.EQ) {
          throw new Error(
            "Duplicate Equifax data detected across multiple reports. Upload only one Equifax report."
          );
        }
        seen.EQ = true;
        final.equifax = b.equifax;
      } else if (code === "TU") {
        if (seen.TU) {
          throw new Error(
            "Duplicate TransUnion data detected across multiple reports. Upload only one TransUnion report."
          );
        }
        seen.TU = true;
        final.transunion = b.transunion;
      }
    }
  }

  // Require at least one bureau
  if (!final.experian && !final.equifax && !final.transunion) {
    throw new Error(
      "No valid bureaus were found in the uploaded reports. Please upload a full Experian, Equifax, or TransUnion credit report."
    );
  }

  return final;
}

// ----------------------------------------------------------------------------
// Build card tags (for front-end “card” components)
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

  // Could also add score buckets etc later if you want
  if (!uw.fundable && (metrics.score || 0) >= 680) {
    cards.push("near_approval");
  }

  return cards;
}

// ----------------------------------------------------------------------------
// Build smart suggestions (English text) from underwriting result
// ----------------------------------------------------------------------------
function buildSuggestions(uw) {
  const out = [];

  const o = uw.optimization || {};
  const m = uw.metrics || {};
  const p = uw.personal || {};
  const b = uw.business || {};

  const util = m.utilization_pct;
  const totalInq = (m.inquiries && m.inquiries.total) || 0;
  const neg = m.negative_accounts || 0;

  // UTILIZATION
  if (o.needs_util_reduction) {
    if (util >= 80) {
      out.push("Your utilization is extremely high (80%+). Paying balances down aggressively will unlock a large jump in scores and approvals.");
    } else if (util >= 50) {
      out.push("Your utilization is high (50–80%). Reducing revolving balances under 30% will significantly improve approval odds and limits.");
    } else {
      out.push("Lower your revolving utilization below ~30% for optimal approval odds and limit assignments.");
    }
  }

  // REVOLVING PRIMARY
  if (o.needs_new_primary_revolving) {
    out.push("Add a strong primary revolving account (not AU) with a $5,000+ limit to anchor your profile before stacking.");
  }

  // INQUIRIES
  if (o.needs_inquiry_cleanup) {
    if (totalInq > 12) {
      out.push("You have a high number of recent hard inquiries. Cleaning these up will prevent auto-declines and open up better approvals.");
    } else {
      out.push("Removing unnecessary or duplicate hard inquiries will improve automated underwriting scores and limit increases.");
    }
  }

  // NEGATIVE ITEMS
  if (o.needs_negative_cleanup) {
    if (neg > 5) {
      out.push("You have multiple negative accounts. Prioritize charge-offs and collections first to unlock the biggest score gains.");
    } else {
      out.push("You have some negative accounts. Targeted disputes and settlement strategy will help remove them from your reports.");
    }
  }

  // FILE BUILD-OUT
  if (o.needs_file_buildout) {
    if (o.file_all_negative) {
      out.push("Your file is mostly negative or very thin. Add 1–2 new primary tradelines and a small installment account to rebuild your foundation.");
    } else if (p.highest_revolving_limit === 0 && p.highest_installment_amount === 0) {
      out.push("Your file is thin. Add at least one primary credit card and one small installment loan to establish depth.");
    } else {
      out.push("Add a couple of additional positive tradelines to strengthen your profile and unlock higher funding tiers.");
    }
  }

  // BUSINESS FUNDING CONTEXT
  if (!b.can_business_fund && p.card_funding > 0) {
    out.push("Once your personal profile is optimized, aging your LLC and adding business banking relationships can unlock business funding.");
  }

  // SAFETY: if for some reason nothing fired
  if (out.length === 0) {
    if (uw.fundable) {
      out.push("Your profile is in a strong position. The main focus now is sequencing and lender selection to maximize total funding.");
    } else {
      out.push("You are close to being fundable. A few targeted optimizations to utilization and inquiries will push you into approval range.");
    }
  }

  return out;
}

// ----------------------------------------------------------------------------
// MAIN HANDLER
// ----------------------------------------------------------------------------
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
      multiples: true, // allow 1–3 files under the same "file" field
      keepExtensions: true,
      uploadDir: "/tmp",
      maxFileSize: 25 * 1024 * 1024
    });

    const { files, fields } = await new Promise((resolve, reject) =>
      form.parse(req, (err, flds, fls) =>
        err ? reject(err) : resolve({ fields: flds, files: fls })
      )
    );

    // Normalize "files.file" (can be single or array)
    let rawFiles = files && files.file;
    let fileList = [];
    if (Array.isArray(rawFiles)) fileList = rawFiles;
    else if (rawFiles) fileList = [rawFiles];

    // ----- Stage 1: structural validation (no GPT) -----
    const validation = await validateReports(fileList);

    if (!validation.ok) {
      return res.status(200).json({
        ok: false,
        msg: validation.reason || "Upload validation failed."
      });
    }

    const validatedFiles = validation.files || fileList;

    // Safety net: ensure we still have files
    if (!validatedFiles || validatedFiles.length === 0) {
      return res.status(200).json({
        ok: false,
        msg: "No valid files found after validation."
      });
    }

    // ----- Stage 1b: cheap AI gate (optional, but safe) -----
    const parsedResults = [];

    for (const f of validatedFiles) {
      const buf = await fs.promises.readFile(f.filepath);

      if (!buf || buf.length < MIN_PDF_BYTES) {
        return res.status(200).json({
          ok: false,
          msg:
            "One of the PDFs appears incomplete or corrupted. Full credit reports are typically 200KB–2MB."
        });
      }

      // Cheap classifier before expensive vision
      const gate = await aiGateCheck(buf, f.originalFilename);
      if (!gate.ok) {
        return res.status(200).json({
          ok: false,
          msg: gate.reason || "This file does not appear to be a real credit report."
        });
      }

      // ----- Stage 2: parse each file with parse-report.js (GPT-4.1) -----
      const parsed = await callParseReport(buf, f.originalFilename);
      parsedResults.push(parsed);
    }

    // ----- Stage 3: bureau-level validation & merge (no duplicate bureaus) -----
    let mergedBureaus;
    try {
      mergedBureaus = mergeBureausOrThrow(parsedResults);
    } catch (err) {
      console.error("SWITCHBOARD MERGE ERROR:", err);
      return res.status(200).json({
        ok: false,
        msg: err.message || "Could not combine bureaus from reports."
      });
    }

    // ----- Stage 4: Underwriting -----
    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");
    const uw = computeUnderwrite(mergedBureaus, businessAgeMonths);

    const p = uw.personal || {};
    const b = uw.business || {};
    const t = uw.totals || {};
    const m = uw.metrics || {};
    const inq = m.inquiries || {};

    // ----- Stage 5: Build cards + suggestions -----
    const cards = buildCards(uw);
    const suggestions = buildSuggestions(uw);

    // ----- Stage 6: Build query params for frontend (minimal) -----
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

    // ----- Stage 7: Decide redirect -----
    const redirect = {};

    if (uw.fundable) {
      // ✅ Approved URL you confirmed
      redirect.url =
        "https://fundhub.ai/funding-approved-analyzer-462533";
      redirect.query = query;
    } else {
      // 🧼 Repair URL you confirmed
      redirect.url =
        "https://fundhub.ai/fix-my-credit-analyzer";
      redirect.query = query;
    }

    // ----- Final response -----
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
    return res.status(200).json({
      ok: false,
      msg: "System error in switchboard."
    });
  }
};
