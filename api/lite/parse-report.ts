// api/lite/parse-report.ts
import formidable, { File as FormidableFile } from "formidable";
import pdfParse from "pdf-parse";
import fs from "fs";

export const config = {
  api: { bodyParser: false, sizeLimit: "25mb" },
};

// ---------- Config ----------
type Grade = "A" | "B" | "C" | "D";
const CONFIG = {
  weights: { EX: 1.5, TU: 1.2, EQ: 1.0 },
  outlierScoreDelta: 100,
  outlierUtilDelta: 25,
  seasoningMonths: 24,
  cardMultipliers: { A: 8, B: 6, C: 3, D: 1 },
  loanMultipliers: { A: 6, B: 5, C: 2, D: 1 },
  businessMultiplierDefault: 1.0,
  baseCardRanges: {
    A: { min: 15000, max: 30000 },
    B: { min: 8000, max: 20000 },
    C: { min: 2000, max: 10000 },
    D: { min: 0, max: 2000 },
  },
  baseLoanRanges: {
    A: { min: 20000, max: 40000 },
    B: { min: 10000, max: 25000 },
    C: { min: 5000, max: 15000 },
    D: { min: 0, max: 5000 },
  },
  gate: { minScore: 700, maxUtil: 30, maxInquiriesTotal: 6, maxNegatives: 0 },
  maxFileSizeBytes: 25 * 1024 * 1024,
};

// ---------- Helpers ----------
const asInt = (s: any) => {
  if (s == null) return null;
  const n = String(s).replace(/[^\d]/g, "");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};
const moneyToInt = (s: string) => asInt(s);
const monthsSince = (d: Date) =>
  (new Date().getFullYear() - d.getFullYear()) * 12 +
  (new Date().getMonth() - d.getMonth());
const parseOpenedDate = (s: string): Date | null => {
  const mmYYYY = s.match(/(\d{1,2})[-\/](\d{4})/);
  if (mmYYYY) return new Date(Number(mmYYYY[2]), Number(mmYYYY[1]) - 1, 1);
  const monthYYYY = s.match(/([A-Za-z]{3,9})\s+(\d{4})/);
  if (monthYYYY) {
    const m = new Date(`${monthYYYY[1]} 1, ${monthYYYY[2]}`).getMonth();
    if (!Number.isNaN(m)) return new Date(Number(monthYYYY[2]), m, 1);
  }
  return null;
};
const normalizeWeights = (w: number[]) => {
  const s = w.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
  return w.map((x) => (x > 0 ? x / s : 0));
};
function dampenOutliers(values: (number | null)[], maxDelta: number) {
  const arr = values.filter((v) => v != null) as number[];
  if (arr.length < 3) return values;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return values.map((v) =>
    v == null ? null : Math.abs(v - mean) > maxDelta ? mean : v
  );
}
function weightedAverageSafe(values: (number | null)[], weights: number[]) {
  const pairs = values
    .map((v, i) => (v != null && weights[i] > 0 ? { v, w: weights[i] } : null))
    .filter(Boolean) as { v: number; w: number }[];
  if (!pairs.length) return null;
  const W = pairs.reduce((a, b) => a + b.w, 0);
  return Math.round(pairs.reduce((a, b) => a + b.v * b.w, 0) / W);
}
function gradeFromPoints(n: number): Grade {
  if (n >= 11) return "A";
  if (n >= 9) return "B";
  if (n >= 7) return "C";
  return "D";
}
const order: Grade[] = ["A", "B", "C", "D"];
const downgrade = (g: Grade) =>
  order[Math.min(order.indexOf(g) + 1, order.length - 1)];

// ---------- Extraction ----------
function extractFrom(text: string) {
  const SCORE_RE = /(fico|score)\D{0,6}(\d{3})/i;
  const UTIL_RE = /(utilization|utilisation|util)\D{0,10}(\d{1,3})\s?%/i;
  const INQ_RE =
    /(inquiries|inq)[^a-zA-Z0-9]+ex\D*(\d+)\D+tu\D*(\d+)\D+eq\D*(\d+)/i;
  const NEG_LINE_RE =
    /(collection|charge[-\s]?off|late payment|30[-\s]?day|60[-\s]?day|90[-\s]?day|delinquent|public\s+record|bankruptcy)/gi;
  const OPENED_DATE_RE =
    /(opened|open\s+date|date\s+opened)\D{0,12}((\d{1,2}[-\/]\d{2,4})|([A-Za-z]{3,9}\s+\d{4}))?/gi;
  const OPEN_STATUS_RE = /(status|account\s+status)\D{0,12}(open|opened)/gi;

  const score = (() => {
    const m = text.match(SCORE_RE);
    return m ? asInt(m[2]) : null;
  })();
  const util = (() => {
    const m = text.match(UTIL_RE);
    return m ? asInt(m[2]) : null;
  })();

  let ex = 0,
    tu = 0,
    eq = 0;
  const inq = text.match(INQ_RE);
  if (inq) {
    ex = asInt(inq[2]) ?? 0;
    tu = asInt(inq[3]) ?? 0;
    eq = asInt(inq[4]) ?? 0;
  }

  const negLines = (text.match(NEG_LINE_RE) || [])
    .slice(0, 64)
    .map((s) => s.toLowerCase());
  const negatives_count = negLines.length;

  // average age
  const AVG_AGE_RE =
    /(average\s+age\s+of\s+accounts|average\s+account\s+age|aaoa)\D{0,20}(\d{1,2})\D{0,8}(year|yr|years)?\D{0,8}(\d{1,2})?\D{0,8}(month|mo|months)?/i;
  let avgAgeYears: number | null = null;
  const aaoa = text.match(AVG_AGE_RE);
  if (aaoa) {
    const years = asInt(aaoa[2]) ?? 0;
    const months = asInt(aaoa[4]) ?? 0;
    avgAgeYears = +(years + months / 12).toFixed(2);
  }

  const LIMIT_RE =
    /(credit\s+limit|high\s+credit|highest\s+credit\s+limit)\D{0,12}\$?\s?([\d,]{2,9})/gi;
  const LOAN_AMT_RE =
    /(original\s+loan\s+amount|loan\s+amount|largest\s+(original\s+)?loan)\D{0,12}\$?\s?([\d,]{2,9})/gi;

  let highestCardLimit = 0,
    seasonedHighestCardLimit = 0;
  let m: RegExpExecArray | null;
  while ((m = LIMIT_RE.exec(text)) !== null) {
    const val = moneyToInt(m[2]);
    if (!val) continue;
    highestCardLimit = Math.max(highestCardLimit, val);
    const nearby = text.slice(Math.max(0, m.index - 200), m.index + 200);
    const od = [...nearby.matchAll(OPENED_DATE_RE)].map((x) => x[2]).find(Boolean);
    const d = od ? parseOpenedDate(od) : null;
    const seasoned = d ? monthsSince(d) >= CONFIG.seasoningMonths : false;
    if (seasoned) seasonedHighestCardLimit = Math.max(seasonedHighestCardLimit, val);
  }

  let largestUnsecuredInstallment = 0,
    seasonedLargestUnsecuredInstallment = 0;
  while ((m = LOAN_AMT_RE.exec(text)) !== null) {
    const val = moneyToInt(m[2]);
    if (!val) continue;
    const nearby = text.slice(Math.max(0, m.index - 200), m.index + 200);
    const od = [...nearby.matchAll(OPENED_DATE_RE)].map((x) => x[2]).find(Boolean);
    const d = od ? parseOpenedDate(od) : null;
    const seasoned = d ? monthsSince(d) >= CONFIG.seasoningMonths : false;
    if (seasoned)
      seasonedLargestUnsecuredInstallment = Math.max(
        seasonedLargestUnsecuredInstallment,
        val
      );
    largestUnsecuredInstallment = Math.max(largestUnsecuredInstallment, val);
  }

  const newAccounts12mo = [...text.matchAll(OPENED_DATE_RE)]
    .map((x) => x[2])
    .filter((dt) => {
      const d = dt ? parseOpenedDate(dt) : null;
      return d && monthsSince(d) <= 12;
    }).length;
  const openAccounts = (text.match(OPEN_STATUS_RE) || []).length;

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
    openAccounts,
  };
}

// ---------- API Handler ----------
export default async function handler(req: any, res: any) {
  // --- CORS & OPTIONS ---
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

  const form = formidable({ multiples: true, keepExtensions: true });

  try {
    form.parse(req, async (err, fields, files) => {
      try {
        if (err)
          return res
            .status(400)
            .json({ ok: false, msg: "Upload parsing failed", detail: String(err) });

        const uploaded = (files as any).file;
        const fileArr: FormidableFile[] = Array.isArray(uploaded)
          ? uploaded
          : uploaded
          ? [uploaded]
          : [];
        if (!fileArr.length)
          return res
            .status(400)
            .json({ ok: false, msg: "Please upload 1–3 bureau PDF reports." });

        const businessNameRaw = (fields as any).businessName;
        const businessAgeRaw = (fields as any).businessAgeMonths;
        const businessName = Array.isArray(businessNameRaw)
          ? businessNameRaw[0]
          : businessNameRaw || "";
        const businessAgeMonths = Array.isArray(businessAgeRaw)
          ? asInt(businessAgeRaw[0])
          : asInt(businessAgeRaw);
        const hasBusiness = !!businessName && businessName.trim().length > 1;

        const texts: string[] = [];
        for (const f of fileArr) {
          const path = (f as any).filepath || (f as any).path;
          const buf = await fs.promises.readFile(path);
          const parsed = await pdfParse(buf);
          texts.push((parsed.text || "").replace(/\s+/g, " ").trim());
        }

        const mergedText = texts.join(" ");
        const lower = mergedText.toLowerCase();
        const hasEX = lower.includes("experian");
        const hasTU = lower.includes("transunion");
        const hasEQ = lower.includes("equifax");

        const exData = hasEX ? extractFrom(mergedText) : null;
        const tuData = hasTU ? extractFrom(mergedText) : null;
        const eqData = hasEQ ? extractFrom(mergedText) : null;
        const fbData = !exData && !tuData && !eqData ? extractFrom(mergedText) : null;

        const scoreVals = [exData?.score, tuData?.score, eqData?.score] as (
          | number
          | null
        )[];
        const utilVals = [exData?.util, tuData?.util, eqData?.util] as (
          | number
          | null
        )[];
        const scoreClean = dampenOutliers(scoreVals, CONFIG.outlierScoreDelta);
        const utilClean = dampenOutliers(utilVals, CONFIG.outlierUtilDelta);
        let wEX = exData ? CONFIG.weights.EX : 0;
        let wTU = tuData ? CONFIG.weights.TU : 0;
        let wEQ = eqData ? CONFIG.weights.EQ : 0;
        if (!exData && !tuData && !eqData && fbData) wEX = 1;
        [wEX, wTU, wEQ] = normalizeWeights([wEX, wTU, wEQ]);

        const score = weightedAverageSafe(
          exData || tuData || eqData ? scoreClean : [fbData?.score ?? null],
          exData || tuData || eqData ? [wEX, wTU, wEQ] : [1]
        );
        const util = weightedAverageSafe(
          exData || tuData || eqData ? utilClean : [fbData?.util ?? null],
          exData || tuData || eqData ? [wEX, wTU, wEQ] : [1]
        );

        const exInq = exData?.inq.ex ?? 0;
        const tuInq = tuData?.inq.tu ?? 0;
        const eqInq = eqData?.inq.eq ?? 0;
        const totalInquiries = exInq + tuInq + eqInq;
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
          fbData?.avgAgeYears,
        ].filter((v) => v != null) as number[];
        const avgAgeYears = avgAgeYearsArr.length
          ? +(avgAgeYearsArr.reduce((a, b) => a + b, 0) / avgAgeYearsArr.length).toFixed(2)
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

        // ---- Funding logic ----
        const gate = CONFIG.gate;
        const fundable =
          (score != null && score >= gate.minScore) &&
          (util == null || util <= gate.maxUtil) &&
          negatives_count <= gate.maxNegatives &&
          totalInquiries <= gate.maxInquiriesTotal;

        const PH = negatives_count === 0 ? 3 : 1;
        const UT = util == null ? 2 : util < 10
          ? 3
          : util <= 30
          ? 2
          : util > 50
          ? 1
          : 2;
        const DA =
          avgAgeYears == null
            ? openAccounts > 3
              ? 2
              : 1
            : avgAgeYears >= 5 && openAccounts >= 5
            ? 3
            : avgAgeYears >= 3
            ? 2
            : 1;
        const NR =
          newAccounts12mo == null
            ? 2
            : newAccounts12mo === 0
            ? 3
            : newAccounts12mo <= 2
            ? 2
            : 1;

        const toGrade = (forCards: boolean): Grade => {
          const weighted = forCards
            ? PH * 2 + UT * 2 + DA + NR
            : PH * 2 + DA * 2 + UT + NR;
          const scaled = Math.round((weighted / 18) * 12);
          const g = gradeFromPoints(scaled);
          return g;
        };

        let gradeCard = toGrade(true);
        let gradeLoan = toGrade(false);

        const baseCard = CONFIG.baseCardRanges[gradeCard];
        const baseLoan = CONFIG.baseLoanRanges[gradeLoan];

        const seasonedCard =
          seasonedHighestCardLimit || highestCardLimit || 0;
        const seasonedUnsec =
          seasonedLargestUnsecuredInstallment ||
          largestUnsecuredInstallment ||
          0;

        const cardCap = seasonedCard * CONFIG.cardMultipliers[gradeCard];
        const loanCap =
          seasonedUnsec > 0
            ? seasonedUnsec * CONFIG.loanMultipliers[gradeLoan]
            : Math.min(CONFIG.baseLoanRanges[gradeLoan].max, 10000);

        const cardRangeMax = Math.max(
          0,
          Math.min(
            baseCard.max,
            Math.round(cardCap / 1000) * 1000 || baseCard.max
          )
        );
        const loanRangeMax = Math.max(
          0,
          Math.min(
            baseLoan.max,
            Math.round(loanCap / 1000) * 1000 || baseLoan.max
          )
        );

        const cardRangeMin = Math.min(baseCard.min, cardRangeMax);
        const loanRangeMin = Math.min(baseLoan.min, loanRangeMax);
        const likelihood = (g: Grade) =>
          g === "A"
            ? "High"
            : g === "B"
            ? "Moderate"
            : g === "C"
            ? "Low"
            : "Unlikely";

        const personal_card = {
          grade: gradeCard,
          likelihood: likelihood(gradeCard),
          range_min: cardRangeMin,
          range_max: cardRangeMax,
        };
        const personal_loan = {
          grade: gradeLoan,
          likelihood: likelihood(gradeLoan),
          range_min: loanRangeMin,
          range_max: loanRangeMax,
        };

        const personal_total_max = cardRangeMax + loanRangeMax;
        const business_multiplier = hasBusiness
          ? CONFIG.businessMultiplierDefault
          : 0;
        const business_total_max =
          Math.round((personal_total_max * business_multiplier) / 1000) * 1000;
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
              score_estimate: score,
              utilization_pct: util,
              negatives_count,
              avg_age_years: avgAgeYears,
            },
          },
        });
      } catch (innerErr: any) {
        console.error("Handler inner error:", innerErr);
        return res.status(500).json({
          ok: false,
          msg: "Parser error",
          error: innerErr?.message || "unknown",
        });
      }
    });
  } catch (topErr: any) {
    console.error("Handler top-level error:", topErr);
    return res.status(500).json({
      ok: false,
      msg: "Unexpected server error",
      detail: topErr?.message || "unknown",
    });
  }
}
