// api/lite/parse-report.js
// CommonJS serverless function (works with @vercel/node).

const { formidable } = require("formidable");
const pdfParse       = require("pdf-parse");
const fs             = require("fs");

// Vercel / Next API config if ever used via pages/api
module.exports.config = {
  api: { bodyParser: false, sizeLimit: "25mb" }
};

/** ======= POLICY / TUNABLES ======= **/
const CONFIG = {
  // bureau weights (normalized automatically for 1–2 bureau uploads)
  weights: { EX: 1.5, TU: 1.2, EQ: 1.0 },

  // score/util outlier clipping (Winsorize vs mean if delta > threshold)
  outlierScoreDelta: 100,
  outlierUtilDelta: 25,

  // "seasoned" = at least this many months old
  seasoningMonths: 24,

  // comparable-credit multipliers (caps) by grade
  cardMultipliers: { A: 8, B: 6, C: 3, D: 1 },
  loanMultipliers: { A: 6, B: 5, C: 2, D: 1 },

  // business funding, conservative default = duplicate of personal total (1.0x)
  businessMultiplierDefault: 1.0,

  // base ranges by grade (before comparable-credit realism)
  baseCardRanges: {
    A: { min: 15000, max: 30000 },
    B: { min:  8000, max: 20000 },
    C: { min:  2000, max: 10000 },
    D: { min:     0, max:  2000 }
  },
  baseLoanRanges: {
    A: { min: 20000, max: 40000 },
    B: { min: 10000, max: 25000 },
    C: { min:  5000, max: 15000 },
    D: { min:     0, max:  5000 }
  },

  // MVP fundable gate (boolean)
  gate: {
    minScore: 700,
    maxUtil: 30,
    maxInquiriesTotal: 6,
    maxNegatives: 0,
  },

  maxFileSizeBytes: 25 * 1024 * 1024
};

/** ======= HELPERS ======= **/
const asInt = (s) => {
  if (s == null) return null;
  const v = Number(String(s).replace(/[^\d]/g, ""));
  return Number.isFinite(v) ? v : null;
};

const monthsSince = (d) =>
  (new Date().getFullYear() - d.getFullYear()) * 12 +
  (new Date().getMonth() - d.getMonth());

const parseOpenedDate = (s) => {
  if (!s) return null;
  const m1 = s.match(/(\d{1,2})[-\/](\d{4})/);
  if (m1) return new Date(Number(m1[2]), Number(m1[1]) - 1, 1);
  const m2 = s.match(/([A-Za-z]{3,9})\s+(\d{4})/);
  if (m2) {
    const mo = new Date(`${m2[1]} 1, ${m2[2]}`).getMonth();
    if (!Number.isNaN(mo)) return new Date(Number(m2[2]), mo, 1);
  }
  return null;
};

const normalizeWeights = (arr) => {
  const sum = arr.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
  return arr.map((x) => (x > 0 ? x / sum : 0));
};

const dampenOutliers = (values, delta) => {
  const nums = values.filter((v) => v != null);
  if (nums.length < 3) return values;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return values.map((v) =>
    v == null ? null : Math.abs(v - mean) > delta ? mean : v
  );
};

const weightedAverageSafe = (values, weights) => {
  const pairs = values
    .map((v, i) => (v != null && weights[i] > 0 ? { v, w: weights[i] } : null))
    .filter(Boolean);
  if (!pairs.length) return null;
  const W = pairs.reduce((a, b) => a + b.w, 0);
  return Math.round(pairs.reduce((a, b) => a + b.v * b.w, 0) / W);
};

const gradeFromPoints = (n) =>
  n >= 11 ? "A" : n >= 9 ? "B" : n >= 7 ? "C" : "D";

const downgrade = (g) =>
  (["A","B","C","D"])[Math.min(["A","B","C","D"].indexOf(g) + 1, 3)];

/** ======= PER-BUREAU EXTRACTION ======= **/
function extractFrom(text) {
  const SCORE_RE = /(fico|score)\D{0,6}(\d{3})/i;
  const UTIL_RE  = /(utilization|utilisation|util)\D{0,10}(\d{1,3})\s?%/i;
  const INQ_RE   = /(inquiries|inq)[^a-zA-Z0-9]+ex\D*(\d+)\D+tu\D*(\d+)\D+eq\D*(\d+)/i;
  const NEG_RE   = /(collection|charge[-\s]?off|late payment|30[-\s]?day|60[-\s]?day|90[-\s]?day|delinquent|public\s+record|bankruptcy)/gi;
  const OPENED   = /(opened|open\s+date|date\s+opened)\D{0,12}((\d{1,2}[-\/]\d{2,4})|([A-Za-z]{3,9}\s+\d{4}))?/gi;
  const STATUS   = /(status|account\s+status)\D{0,12}(open|opened)/gi;

  const mS = text.match(SCORE_RE);
  const score = mS ? asInt(mS[2]) : null;

  const mU = text.match(UTIL_RE);
  const util = mU ? asInt(mU[2]) : null;

  let ex = 0, tu = 0, eq = 0;
  const mI = text.match(INQ_RE);
  if (mI) {
    ex = asInt(mI[2]) ?? 0;
    tu = asInt(mI[3]) ?? 0;
    eq = asInt(mI[4]) ?? 0;
  }

  const negLines = (text.match(NEG_RE) || [])
    .slice(0,64)
    .map(s => s.toLowerCase());

  const negatives_count = negLines.length;

  const AAOA = /(average\s+age\s+of\s+accounts|average\s+account\s+age|aaoa)\D{0,20}(\d{1,2})\D{0,8}(year|yr|years)?\D{0,8}(\d{1,2})?\D{0,8}(month|mo|months)?/i;
  let avgAgeYears = null;
  const a = text.match(AAOA);
  if (a) {
    const y = asInt(a[2]) ?? 0;
    const m = asInt(a[4]) ?? 0;
    avgAgeYears = +((y) + (m/12)).toFixed(2);
  }

  const LIMIT_RE = /(credit\s+limit|high\s+credit|highest\s+credit\s+limit)\D{0,12}\$?\s?([\d,]{2,9})/gi;
  const LOAN_RE  = /(original\s+loan\s+amount|loan\s+amount|largest\s+(original\s+)?loan)\D{0,12}\$?\s?([\d,]{2,9})/gi;

  let highestCardLimit = 0,
      seasonedHighestCardLimit = 0,
      m;

  while ((m = LIMIT_RE.exec(text)) !== null) {
    const val = Number(String(m[2]).replace(/[^\d]/g, ""));
    if (!val) continue;
    if (val > highestCardLimit) highestCardLimit = val;
    const near = text.slice(Math.max(0, m.index - 200), m.index + 200);
    const opened = [...near.matchAll(OPENED)].map(x => x[2]).find(Boolean);
    const d = opened ? parseOpenedDate(opened) : null;
    const seasoned = d ? monthsSince(d) >= CONFIG.seasoningMonths : false;
    if (seasoned && val > seasonedHighestCardLimit) {
      seasonedHighestCardLimit = val;
    }
  }

  let largestUnsecuredInstallment = 0,
      seasonedLargestUnsecuredInstallment = 0;

  while ((m = LOAN_RE.exec(text)) !== null) {
    const val = Number(String(m[2]).replace(/[^\d]/g, ""));
    if (!val) continue;
    const near = text.slice(Math.max(0, m.index - 200), m.index + 200);
    const looksSecured = /(auto|vehicle|mortgage|heloc|home\s+equity|student)/i.test(near);
    if (!looksSecured) {
      if (val > largestUnsecuredInstallment) largestUnsecuredInstallment = val;
      const opened = [...near.matchAll(OPENED)].map(x => x[2]).find(Boolean);
      const d = opened ? parseOpenedDate(opened) : null;
      const seasoned = d ? monthsSince(d) >= CONFIG.seasoningMonths : false;
      if (seasoned && val > seasonedLargestUnsecuredInstallment) {
        seasonedLargestUnsecuredInstallment = val;
      }
    }
  }

  const newAccounts12mo = [...text.matchAll(OPENED)]
    .map(x => x[2])
    .filter((dt) => {
      const d = dt ? parseOpenedDate(dt) : null;
      return d && monthsSince(d) <= 12;
    }).length;

  const openAccounts = (text.match(STATUS) || []).length;

  return {
    score,
    util,
    inq: { ex, tu, eq },
    negatives_count,
    negLines,
    avgAgeYears,
    highestCardLimit,
    seasonedHighestCardLimit,
    largestUnsecuredInstallment,
    seasonedLargestUnsecuredInstallment,
    newAccounts12mo,
    openAccounts
  };
}

/** ======= API HANDLER ======= **/
module.exports = async function handler(req, res) {
  // CORS / preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, msg: "Method not allowed" });
  }

  // ✅ Formidable v3+ init + Vercel temp dir
  const form = formidable({
    multiples: true,
    keepExtensions: true,
    maxFileSize: CONFIG.maxFileSizeBytes,
    uploadDir: "/tmp" // Vercel's only writable directory
  });

  try {
    form.parse(req, async (err, fields, files) => {
      try {
        if (err) {
          return res.status(400).json({
            ok: false,
            code: "parse_error",
            msg: "Upload parsing failed",
            detail: String(err)
          });
        }

        const up = files && (files.file ?? files["file"]);
        const fileArr = Array.isArray(up) ? up : (up ? [up] : []);
        if (!fileArr.length) {
          return res.status(400).json({
            ok: false,
            code: "no_files",
            msg: "Please upload 1–3 bureau PDF reports."
          });
        }

        // Optional business fields
        const businessNameRaw = fields && fields.businessName;
        const businessAgeRaw  = fields && fields.businessAgeMonths;
        const businessName = Array.isArray(businessNameRaw)
          ? (businessNameRaw[0] || "")
          : (businessNameRaw || "");
        const businessAgeMonths = Array.isArray(businessAgeRaw)
          ? asInt(businessAgeRaw[0])
          : asInt(businessAgeRaw);

        const hasBusiness = !!(businessName && String(businessName).trim().length > 1);

        // ---------- Read PDFs ----------
        const texts = [];
        for (const f of fileArr) {
          const p = f && (f.filepath || f.path);
          if (!p) {
            return res.status(400).json({
              ok: false,
              code: "file_missing",
              msg: "Uploaded file is missing path."
            });
          }
          const buf = await fs.promises.readFile(p);
          const parsed = await pdfParse(buf);

          // 🔥 SANITIZE UNICODE / WEIRD CHARS BEFORE PARSING
          let t = (parsed.text || "")
            .replace(/[\u2010-\u2015]/g, "-")   // all dash types → ASCII dash
            .replace(/\u2212/g, "-")           // minus sign → dash
            .replace(/\u00AD/g, "")            // soft hyphen
            .replace(/\u2028|\u2029/g, " ")    // line separators
            .replace(/[^\x00-\x7F]/g, " ")     // drop other non-ASCII
            .replace(/\s+/g, " ")
            .trim();

          if (t.length < 20) {
            return res.status(400).json({
              ok: false,
              code: "empty_pdf",
              msg: "We couldn’t read your PDF. Please upload a clear bureau report PDF (no photos or scans)."
            });
          }

          texts.push(t);
        }

        // ---------- Merge + bureau detection ----------
        const merged = texts.join(" ");
        const low = merged.toLowerCase();
        const hasEX = low.includes("experian");
        const hasTU = low.includes("transunion");
        const hasEQ = low.includes("equifax");

        const exData = hasEX ? extractFrom(merged) : null;
        const tuData = hasTU ? extractFrom(merged) : null;
        const eqData = hasEQ ? extractFrom(merged) : null;
        const fbData = (!exData && !tuData && !eqData) ? extractFrom(merged) : null;

        // ---------- Composite metrics ----------
        const scoreVals = [exData?.score,  tuData?.score,  eqData?.score];
        const utilVals  = [exData?.util,   tuData?.util,   eqData?.util ];
        const scoreClean = dampenOutliers(scoreVals, CONFIG.outlierScoreDelta);
        const utilClean  = dampenOutliers(utilVals,  CONFIG.outlierUtilDelta);

        let wEX = exData ? CONFIG.weights.EX : 0;
        let wTU = tuData ? CONFIG.weights.TU : 0;
        let wEQ = eqData ? CONFIG.weights.EQ : 0;
        if (!exData && !tuData && !eqData && fbData) wEX = 1;
        [wEX, wTU, wEQ] = normalizeWeights([wEX, wTU, wEQ]);

        const score = weightedAverageSafe(
          (exData || tuData || eqData) ? scoreClean : [fbData?.score ?? null],
          (exData || tuData || eqData) ? [wEX,wTU,wEQ] : [1]
        );
        const util  = weightedAverageSafe(
          (exData || tuData || eqData) ? utilClean  : [fbData?.util ?? null],
          (exData || tuData || eqData) ? [wEX,wTU,wEQ] : [1]
        );

        const inquiries = {
          ex: exData?.inq?.ex ?? 0,
          tu: tuData?.inq?.tu ?? 0,
          eq: eqData?.inq?.eq ?? 0
        };
        const totalInquiries = inquiries.ex + inquiries.tu + inquiries.eq;

        const negatives_count = Math.max(
          exData?.negatives_count ?? 0,
          tuData?.negatives_count ?? 0,
          eqData?.negatives_count ?? 0,
          fbData?.negatives_count ?? 0
        );

        const avgAgeYearsArr = [
          exData?.avgAgeYears,
          tuData?.avgAgeYears,
          eqData?.avgAgeYears,
          fbData?.avgAgeYears
        ].filter(v => v != null);

        const avgAgeYears = avgAgeYearsArr.length
          ? +(avgAgeYearsArr.reduce((a,b)=>a+b,0)/avgAgeYearsArr.length).toFixed(2)
          : null;

        const highestCardLimit = Math.max(
          exData?.highestCardLimit ?? 0,
          tuData?.highestCardLimit ?? 0,
          eqData?.highestCardLimit ?? 0,
          fbData?.highestCardLimit ?? 0
        );
        const seasonedHighestCardLimit = Math.max(
          exData?.seasonedHighestCardLimit ?? 0,
          tuData?.seasonedHighestCardLimit ?? 0,
          eqData?.seasonedHighestCardLimit ?? 0
        );

        const largestUnsecuredInstallment = Math.max(
          exData?.largestUnsecuredInstallment ?? 0,
          tuData?.largestUnsecuredInstallment ?? 0,
          eqData?.largestUnsecuredInstallment ?? 0,
          fbData?.largestUnsecuredInstallment ?? 0
        );
        const seasonedLargestUnsecuredInstallment = Math.max(
          exData?.seasonedLargestUnsecuredInstallment ?? 0,
          tuData?.seasonedLargestUnsecuredInstallment ?? 0,
          eqData?.seasonedLargestUnsecuredInstallment ?? 0
        );

        const newAccounts12mo = Math.max(
          exData?.newAccounts12mo ?? 0,
          tuData?.newAccounts12mo ?? 0,
          eqData?.newAccounts12mo ?? 0,
          fbData?.newAccounts12mo ?? 0
        );
        const openAccounts = Math.max(
          exData?.openAccounts ?? 0,
          tuData?.openAccounts ?? 0,
          eqData?.openAccounts ?? 0,
          fbData?.openAccounts ?? 0
        );

        // ---------- Fundable gate ----------
        const gate = CONFIG.gate;
        const fundable =
          (score != null && score >= gate.minScore) &&
          (util == null || util <= gate.maxUtil) &&
          negatives_count <= gate.maxNegatives &&
          totalInquiries <= gate.maxInquiriesTotal;

        // ---------- Pillars (PH, UT, DA, NR) ----------
        const allNegLines = []
          .concat(exData?.negLines || [], tuData?.negLines || [], eqData?.negLines || [], fbData?.negLines || []);

        const hasBK = allNegLines.some(s => s.includes("bankruptcy") || s.includes("public record"));
        const has90Late = allNegLines.some(s => s.includes("90") && s.includes("late"));

        let dataQualityConstrained = false;

        const PH = (() => {
          if (negatives_count === 0) return 3;
          if (hasBK) return 1;
          const anyColl = allNegLines.some(s => s.includes("collection") || s.includes("charge-off"));
          const count30 = allNegLines.filter(s => s.includes("30") && s.includes("late")).length;
          return (!anyColl && count30 <= 1) ? 2 : 1;
        })();

        const UT = (() => {
          if (util == null) { dataQualityConstrained = true; return 2; }
          if (util < 10) return 3;
          if (util <= 30) return 2;
          return util > 50 ? 1 : 2;
        })();

        const DA = (() => {
          if (avgAgeYears == null) { dataQualityConstrained = true; return openAccounts > 3 ? 2 : 1; }
          if (avgAgeYears >= 5 && openAccounts >= 5) return 3;
          if (avgAgeYears >= 3) return 2;
          return 1;
        })();

        const NR = (() => {
          if (newAccounts12mo == null) { dataQualityConstrained = true; return 2; }
          if (newAccounts12mo === 0) return 3;
          if (newAccounts12mo <= 2) return 2;
          return 1;
        })();

        const toGrade = (forCards) => {
          const weighted = forCards
            ? (PH*2 + UT*2 + DA + NR)
            : (PH*2 + DA*2 + UT + NR);

          const scaled = Math.round((weighted / 18) * 12);
          let g = gradeFromPoints(scaled);
          const cap = hasBK ? "D" : (has90Late ? "C" : null);
          if (cap) {
            const ord = ["A","B","C","D"];
            if (ord.indexOf(g) < ord.indexOf(cap)) g = cap;
          }
          if (dataQualityConstrained) g = downgrade(g);
          return g;
        };

        let gradeCard = toGrade(true);
        let gradeLoan = toGrade(false);

        const guardrail =
          ((util ?? 0) > 70 && newAccounts12mo >= 3) ||
          ((avgAgeYears ?? 99) < 2 && openAccounts <= 3);

        if (guardrail) {
          gradeCard = downgrade(gradeCard);
          gradeLoan = downgrade(gradeLoan);
        }

        const baseCard = CONFIG.baseCardRanges[gradeCard];
        const baseLoan = CONFIG.baseLoanRanges[gradeLoan];

        const seasonedCard  = seasonedHighestCardLimit || highestCardLimit || 0;
        const seasonedUnsec = seasonedLargestUnsecuredInstallment || largestUnsecuredInstallment || 0;

        const cardCap = seasonedCard * CONFIG.cardMultipliers[gradeCard];
        const loanCap = seasonedUnsec > 0
          ? seasonedUnsec * CONFIG.loanMultipliers[gradeLoan]
          : Math.min(CONFIG.baseLoanRanges[gradeLoan].max, 10000);

        const cardRangeMax = Math.max(
          0,
          Math.min(baseCard.max, Math.round((cardCap || baseCard.max)/1000)*1000)
        );
        const loanRangeMax = Math.max(
          0,
          Math.min(baseLoan.max, Math.round((loanCap || baseLoan.max)/1000)*1000)
        );
        const cardRangeMin = Math.min(baseCard.min, cardRangeMax);
        const loanRangeMin = Math.min(baseLoan.min, loanRangeMax);

        const likelihood = (g) =>
          g === "A" ? "High" :
          g === "B" ? "Moderate" :
          g === "C" ? "Low" :
          "Unlikely";

        const personal_card = {
          grade: gradeCard,
          likelihood: likelihood(gradeCard),
          range_min: cardRangeMin,
          range_max: cardRangeMax
        };
        const personal_loan = {
          grade: gradeLoan,
          likelihood: likelihood(gradeLoan),
          range_min: loanRangeMin,
          range_max: loanRangeMax
        };

        const personal_total_max = cardRangeMax + loanRangeMax;

        const business_multiplier = hasBusiness
          ? CONFIG.businessMultiplierDefault
          : 0;

        const business_total_max = Math.round(
          personal_total_max * business_multiplier / 1000
        ) * 1000;

        const banner_estimate = personal_total_max + business_total_max;

        return res.status(200).json({
          ok: true,
          outputs: {
            fundable,
            banner_estimate,
            personal_total_max,
            business_total_max,
            personal_card,
            personal_loan,
            meta: {
              score_estimate:   score,
              utilization_pct:  util,
              inquiries,
              negatives_count,
              avg_age_years:    avgAgeYears
            }
          }
        });
      } catch (innerErr) {
        console.error("Handler inner error:", innerErr);
        return res.status(500).json({
          ok: false,
          msg: "Parser error",
          error: String(innerErr && innerErr.message || innerErr)
        });
      }
    });
  } catch (topErr) {
    console.error("Top-level error:", topErr);
    return res.status(500).json({
      ok: false,
      msg: "Unexpected server error",
      detail: String(topErr && topErr.message || topErr)
    });
  }
};
