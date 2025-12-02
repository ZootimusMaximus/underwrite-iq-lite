// ============================================================================
// UnderwriteIQ — SWITCHBOARD (Stage 2: Validation + Merge + Underwrite + Suggestions)
// ============================================================================

const fs = require("fs");
const formidable = require("formidable");

const { validateReports } = require("./validate-reports");
const { computeUnderwrite, getNumberField } = require("./underwriter");
const { aiGateCheck } = require("./ai-gatekeeper");
const {
  buildDedupeKeys,
  createRedisClient,
  checkDedupe,
  storeRedirect,
  TTL_SECONDS
} = require("./dedupe-store");

// 🔥 NEW — modular suggestion engine
const { buildSuggestions } = require("./suggestions");

// Parser endpoint
const PARSE_ENDPOINT =
  process.env.PARSE_ENDPOINT ||
  "https://underwrite-iq-lite.vercel.app/api/lite/parse-report";

const MIN_PDF_BYTES = 40 * 1024;
const AFFILIATE_ENABLED = process.env.AFFILIATE_DASHBOARD_ENABLED === "true";
const IDENTITY_ENABLED = process.env.IDENTITY_VERIFICATION_ENABLED !== "false";

// Safe number helper
function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getFieldValue(fields, key) {
  if (!fields || fields[key] == null) return null;
  const raw = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
  if (typeof raw === "string") return raw;
  if (raw == null) return null;
  return String(raw);
}

function formatSuggestions(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item, idx) => {
    if (typeof item === "string") {
      return { title: `Action ${idx + 1}`, description: item };
    }
    if (item && typeof item === "object") return item;
    return { title: `Action ${idx + 1}`, description: String(item || "") };
  });
}

// ----------------------------------------------------------------------------
// Call parse-report for a single PDF buffer
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
// Merge bureaus from multiple parsed results, enforcing "no duplicates"
// ----------------------------------------------------------------------------
function mergeBureausOrThrow(parsedResults) {
  const final = { experian: null, equifax: null, transunion: null };
  const seen = { EX: false, EQ: false, TU: false };

  for (const parsed of parsedResults) {
    if (!parsed || !parsed.ok || !parsed.bureaus) {
      throw new Error("One of the reports could not be parsed.");
    }

    const codes = detectBureauCodes(parsed);
    const b = parsed.bureaus;

    if (codes.length === 0) {
      throw new Error("One uploaded PDF has no recognizable Experian, Equifax, or TransUnion sections.");
    }

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

// ----------------------------------------------------------------------------
// Build cards (tags only — used by front-end)
// ----------------------------------------------------------------------------
function buildCards(uw) {
  const cards = [];
  const o = uw.optimization || {};
  const m = uw.metrics || {};

  if (o.needs_util_reduction) cards.push("util_high");
  if (o.needs_new_primary_revolving) cards.push("needs_revolving");
  if (o.needs_inquiry_cleanup) cards.push("inquiries");
  if (o.needs_negative_cleanup) cards.push("negatives");
  if (o.needs_file_buildout) cards.push("file_buildout");

  if (!uw.fundable && (m.score || 0) >= 680) {
    cards.push("near_approval");
  }

  return cards;
}

// ----------------------------------------------------------------------------
// MAIN HANDLER
// ----------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  try {
    // ----- CORS -----
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

    // ----- Parse multipart -----
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

    const dedupeClient = createRedisClient();
    const dedupeKeys = buildDedupeKeys({
      email: getFieldValue(fields, "email"),
      phone: getFieldValue(fields, "phone"),
      deviceId: getFieldValue(fields, "deviceId"),
      refId: getFieldValue(fields, "refId")
    });

    if (!AFFILIATE_ENABLED) {
      dedupeKeys.refKey = null;
      dedupeKeys.refId = null;
    }

    if (dedupeClient && (dedupeKeys.userKey || dedupeKeys.deviceKey || dedupeKeys.refKey)) {
      const cached = await checkDedupe(dedupeClient, dedupeKeys);
      if (cached?.redirect) {
        return res.status(200).json({ ok: true, redirect: cached.redirect, deduped: true });
      }
    }

    const rawFiles = files?.file;
    const fileList = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];

    // ----- Stage 1: structural validation -----
    const validation = await validateReports(fileList);
    if (!validation.ok) {
      return res.status(200).json({ ok: false, msg: validation.reason });
    }

    const validatedFiles = validation.files || fileList;
    if (!validatedFiles.length) {
      return res.status(200).json({ ok: false, msg: "No valid PDFs." });
    }

    // ----- Stage 1b: AI gatekeeper -----
    const parsedResults = [];
    for (const f of validatedFiles) {
      const buf = await fs.promises.readFile(f.filepath);

      if (!buf || buf.length < MIN_PDF_BYTES) {
        return res.status(200).json({
          ok: false,
          msg: "One PDF appears incomplete or corrupted."
        });
      }

      if (IDENTITY_ENABLED) {
        const gate = await aiGateCheck(buf, f.originalFilename);
        if (!gate.ok) {
          return res.status(200).json({ ok: false, msg: gate.reason });
        }
      }

      // ----- Stage 2: expensive GPT parse -----
      const parsed = await callParseReport(buf, f.originalFilename);
      parsedResults.push(parsed);
    }

    // ----- Stage 3: bureau merge -----
    let mergedBureaus;
    try {
      mergedBureaus = mergeBureausOrThrow(parsedResults);
    } catch (err) {
      return res.status(200).json({ ok: false, msg: err.message });
    }

    // ----- Stage 4: underwriting -----
    const businessAgeMonths = getNumberField(fields, "businessAgeMonths");
    const uw = computeUnderwrite(mergedBureaus, businessAgeMonths);

    const p = uw.personal || {};
    const b = uw.business || {};
    const t = uw.totals || {};
    const m = uw.metrics || {};
    const inq = m.inquiries || {};

    // ----- Stage 5: modular suggestions -----
    const suggestions = buildSuggestions(uw, {
      hasLLC: fields.hasLLC === "true",
      llcAgeMonths: Number(fields.llcAgeMonths || 0)
    });

    const cards = buildCards(uw);

    // ----- Stage 6: redirect query -----
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

    // ----- Stage 7: redirect -----
    const baseUrl = uw.fundable
      ? "https://fundhub.ai/funding-approved-analyzer-462533"
      : "https://fundhub.ai/fix-my-credit-analyzer";

    const qs = new URLSearchParams(query || {}).toString();
    const resultUrl = baseUrl + (qs ? "?" + qs : "");

    const refId =
      dedupeKeys.refId ||
      getFieldValue(fields, "refId") ||
      `ref-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;

    const suggestionObjects = formatSuggestions(suggestions);
    const nowIso = new Date().toISOString();
    const daysRemaining = Math.max(0, Math.ceil(TTL_SECONDS / (60 * 60 * 24)));

    const redirect = {
      resultType: uw.fundable ? "funding" : "repair",
      resultUrl,
      url: resultUrl,
      query,
      suggestions: suggestionObjects,
      lastUpload: nowIso,
      daysRemaining,
      refId,
      affiliateLink: `https://fundhub.ai/credit-analyzer.html?ref=${encodeURIComponent(refId)}`
    };

    if (dedupeClient && (dedupeKeys.userKey || dedupeKeys.deviceKey || dedupeKeys.refKey)) {
      try {
        await storeRedirect(dedupeClient, dedupeKeys, redirect);
      } catch (err) {
        console.error("[dedupe] failed to write redirect", err);
      }
    }

    // ----- FINAL RESPONSE -----
    return res.status(200).json({
      ok: true,
      deduped: false,
      parsed: parsedResults,
      bureaus: mergedBureaus,
      underwrite: uw,
      optimization: uw.optimization,
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
