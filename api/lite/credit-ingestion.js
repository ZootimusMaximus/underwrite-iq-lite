const crypto = require("crypto");
const pdfParse = require("pdf-parse");

const BUREAU_KEYS = ["experian", "equifax", "transunion"];
const TRI_MERGE_WARNING = "tri_merge_detection_failed";

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectPrimaryBureau(text) {
  const lower = text.toLowerCase();
  if (lower.includes("experian")) return "experian";
  if (lower.includes("equifax")) return "equifax";
  if (lower.includes("transunion")) return "transunion";
  return "unknown";
}

function extractScore(text) {
  const match = text.match(/(?:fico|score)[^0-9]{0,12}([3-8]\d{2})/i) || text.match(/\b([3-8]\d{2})\b/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function parseDateString(value) {
  if (!value) return null;
  const trimmed = String(value).trim();

  const isoMatch = trimmed.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (isoMatch) {
    const [_, y, m, d] = isoMatch;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  const yMMatch = trimmed.match(/^(\d{4})[-/](\d{2})$/);
  if (yMMatch) {
    const [_, y, m] = yMMatch;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  const slashMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (slashMatch) {
    let [_, m, d, y] = slashMatch;
    if (y.length === 2) y = "20" + y;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  return null;
}

function extractReportDate(text) {
  const dateMatch = text.match(/(?:report\s*date|date\s*opened|as\s*of)[:\s]+([^\s]{6,})/i);
  if (dateMatch) {
    const parsed = parseDateString(dateMatch[1]);
    if (parsed) return parsed;
  }

  const fallback = text.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/);
  if (fallback) {
    const parsed = parseDateString(fallback[1]);
    if (parsed) return parsed;
  }

  return null;
}

function baseBureauShape() {
  return {
    available: true,
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

function hydrateMetadata(bureau, meta) {
  const scoreValue = bureau.score;
  const scoreDetails = { value: scoreValue, available: scoreValue != null };

  return {
    ...baseBureauShape(),
    ...bureau,
    score: scoreValue,
    scoreDetails,
    sourceType: meta.sourceType,
    derivedFromMerged: !!meta.derivedFromMerged,
    mergedDocumentId: meta.mergedDocumentId || null,
    parsingWarnings: meta.parsingWarnings || []
  };
}

function parseSingleBureau(text, opts = {}) {
  const normalized = normalizeWhitespace(text);
  const bureauKey = opts.bureauKey || detectPrimaryBureau(normalized);
  const score = extractScore(normalized);
  const reportDate = extractReportDate(normalized);

  return hydrateMetadata(
    {
      bureau: bureauKey,
      score,
      reportDate
    },
    {
      sourceType: opts.sourceType || "single_bureau",
      derivedFromMerged: !!opts.derivedFromMerged,
      mergedDocumentId: opts.mergedDocumentId,
      parsingWarnings: opts.parsingWarnings || []
    }
  );
}

function parseAsSingleBureau(text) {
  return parseSingleBureau(text, { sourceType: "single_bureau" });
}

function parseAnnualDisclosure(text) {
  const parsed = parseSingleBureau(text, { sourceType: "annual_disclosure" });
  if (parsed.score == null && parsed.scoreDetails) {
    parsed.scoreDetails.available = false;
  }
  return parsed;
}

function hashMergedText(text) {
  return crypto.createHash("sha256").update(text || "").digest("hex");
}

function parseTriMerge(text) {
  const normalized = normalizeWhitespace(text);

  const anchors = BUREAU_KEYS
    .map(key => ({ key, idx: normalized.toLowerCase().indexOf(key) }))
    .filter(entry => entry.idx !== -1)
    .sort((a, b) => a.idx - b.idx);

  if (anchors.length < 3) {
    return {
      bureaus: {},
      sourceType: "tri_merge",
      parsingWarnings: [TRI_MERGE_WARNING]
    };
  }

  const mergedDocumentId = hashMergedText(normalized);
  const bureaus = {};

  anchors.forEach((anchor, i) => {
    const next = anchors[i + 1];
    const start = anchor.idx;
    const end = next ? next.idx : normalized.length;
    const slice = normalized.slice(start, end).trim();

    if (!slice || slice.length < 40) return;

    const parsed = parseSingleBureau(slice, {
      bureauKey: anchor.key,
      sourceType: "tri_merge",
      derivedFromMerged: true,
      mergedDocumentId
    });

    bureaus[anchor.key] = parsed;
  });

  return {
    bureaus,
    sourceType: "tri_merge",
    mergedDocumentId,
    parsingWarnings: []
  };
}

function isNewerDate(incoming, existing) {
  if (!incoming) return false;
  const incomingDate = new Date(incoming);
  if (Number.isNaN(incomingDate.getTime())) return false;

  if (!existing) return true;
  const existingDate = new Date(existing);
  if (Number.isNaN(existingDate.getTime())) return true;

  return incomingDate.getTime() > existingDate.getTime();
}

function enforceBureauSlots(existingMap = {}, incomingMap = {}) {
  const out = { ...existingMap };
  const rejected = [];

  for (const [key, bureau] of Object.entries(incomingMap)) {
    if (!bureau) continue;
    const existing = out[key];

    if (existing) {
      if (isNewerDate(bureau.reportDate, existing.reportDate)) {
        out[key] = bureau;
      } else {
        rejected.push({ bureau: key, reason: "stale_report" });
      }
      continue;
    }

    if (Object.keys(out).length >= 3) {
      rejected.push({ bureau: key, reason: "max_bureaus_reached" });
      continue;
    }

    out[key] = bureau;
  }

  return { bureaus: out, rejected };
}

async function ingestCreditReport(buffer, opts = {}) {
  const text = opts.textOverride
    ? normalizeWhitespace(opts.textOverride)
    : normalizeWhitespace((await pdfParse(buffer)).text);

  const lower = text.toLowerCase();
  const hasAllBureaus = BUREAU_KEYS.every(key => lower.includes(key));
  const isAnnual = /annualcreditreport/i.test(lower) || /annualcreditreport\.com/i.test(lower);

  if (hasAllBureaus) {
    const tri = parseTriMerge(text);
    const bureauCount = Object.keys(tri.bureaus || {}).length;
    if (bureauCount >= 2) {
      const enforced = enforceBureauSlots({}, tri.bureaus);
      return { ...tri, bureaus: enforced.bureaus, rejected: enforced.rejected };
    }

    const fallback = parseAsSingleBureau(text);
    fallback.parsingWarnings = [...(fallback.parsingWarnings || []), TRI_MERGE_WARNING];
    const enforced = enforceBureauSlots({}, { [fallback.bureau || detectPrimaryBureau(text)]: fallback });
    return { bureaus: enforced.bureaus, sourceType: "single_bureau", rejected: enforced.rejected };
  }

  if (isAnnual) {
    const parsed = parseAnnualDisclosure(text);
    const enforced = enforceBureauSlots({}, { [parsed.bureau || detectPrimaryBureau(text)]: parsed });
    return {
      bureaus: enforced.bureaus,
      sourceType: "annual_disclosure",
      rejected: enforced.rejected
    };
  }

  const single = parseAsSingleBureau(text);
  const enforced = enforceBureauSlots({}, { [single.bureau || detectPrimaryBureau(text)]: single });
  return {
    bureaus: enforced.bureaus,
    sourceType: "single_bureau",
    rejected: enforced.rejected
  };
}

module.exports = {
  TRI_MERGE_WARNING,
  normalizeWhitespace,
  ingestCreditReport,
  parseTriMerge,
  parseAnnualDisclosure,
  parseAsSingleBureau,
  enforceBureauSlots
};
