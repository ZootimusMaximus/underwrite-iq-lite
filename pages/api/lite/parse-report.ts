import type { NextApiRequest, NextApiResponse } from "next";
import formidable, { File as FormidableFile } from "formidable";
import pdfParse from "pdf-parse";
import fs from "fs";

/**
 * Underwrite IQ — LITE (no Airtable)
 * Upload 1–3 PDF credit reports -> parse -> trimeric composite -> grades -> ranges -> comparable-credit -> business add-on
 *
 * TEST THROUGH YOUR SITE (upload form). The response structure is stable for your UI.
 */

export const config = {
  api: { bodyParser: false, sizeLimit: "25mb" },
};

// ---------- Tunables / Policy ----------
type Grade = "A" | "B" | "C" | "D";
const CONFIG = {
  // bureau weights (normalized automatically for 1–2 bureau uploads)
  weights: { EX: 1.5, TU: 1.2, EQ: 1.0 },

  // score/util outlier clipping (Winsorize vs mean if delta > threshold)
  outlierScoreDelta: 100,
  outlierUtilDelta: 25,

  // "seasoned" = at least this many months old
  seasoningMonths: 24,

  // comparable-credit multipliers (caps) by grade
  cardMultipliers: { A: 8, B: 6, C: 3, D: 1 },       // ≈ 5–8× seasoned highest card limit
  loanMultipliers: { A: 6, B: 5, C: 2, D: 1 },       // ≈ 5–6× seasoned largest unsecured loan

  // business funding, conservative default = duplicate of personal total (1.0x)
  businessMultiplierDefault: 1.0,

  // base ranges by grade (before comparable-credit realism)
  baseCardRanges: {
    A: { min: 15000, max: 30000 },
    B: { min: 8000,  max: 20000 },
    C: { min: 2000,  max: 10000 },
    D: { min: 0,     max: 2000  },
  },
  baseLoanRanges: {
    A: { min: 20000, max: 40000 },
    B: { min: 10000, max: 25000 },
    C: { min: 5000,  max: 15000 },
    D: { min: 0,     max: 5000  },
  },

  // MVP fundable gate (boolean)
  gate: {
    minScore: 700,
    maxUtil: 30,
    maxInquiriesTotal: 6,
    maxNegatives: 0,
  },
};

// ---------- Regex helpers (robust-ish; OK for MVP PDFs) ----------
const SCORE_RE = /(fico|score)\D{0,6}(\d{3})/i;
const UTIL_RE = /(utilization|utilisation|util)\D{0,10}(\d{1,3})\s?%/i;
const INQ_RE  = /(inquiries|inq)[^a-zA-Z0-9]+ex\D*(\d+)\D+tu\D*(\d+)\D+eq\D*(\d+)/i;

const NEG_LINE_RE = /(collection|charge[-\s]?off|late payment|30[-\s]?day|60[-\s]?day|90[-\s]?day|delinquent|public\s+record|bankruptcy)/gi;

const AVG_AGE_RE = /(average\s+age\s+of\s+accounts|average\s+account\s+age|aaoa)\D{0,20}(\d{1,2})\D{0,8}(year|yr|years)?\D{0,8}(\d{1,2})?\D{0,8}(month|mo|months)?/i;

const LIMIT_RE = /(credit\s+limit|high\s+credit|highest\s+credit\s+limit)\D{0,12}\$?\s?([\d,]{2,9})/gi;
const LOAN_AMT_RE = /(original\s+loan\s+amount|loan\s+amount|largest\s+(original\s+)?loan)\D{0,12}\$?\s?([\d,]{2,9})/gi;

const OPENED_DATE_RE = /(opened|open\s+date|date\s+opened)\D{0,12}((\d{1,2}[-\/]\d{2,4})|([A-Za-z]{3,9}\s+\d{4}))?/gi;
const OPEN_STATUS_RE = /(status|account\s+status)\D{0,12}(open|opened)/gi;

const SECURED_HINT_RE = /(auto|vehicle|mortgage|heloc|home\s+equity|student)/i;

// ---------- utils ----------
const asInt = (s: any) => {
  const n = typeof s === "string" ? s.replace(/[^\d]/g, "") : s;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};
const moneyToInt = (s: string) => asInt(s);
const monthsSince = (d: Date) => {
  const now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
};
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

// ---------- core parse of a single bureau text ----------
function extractFrom(text: string) {
  const score = (() => {
    const m = text.match(SCORE_RE);
    return m ? asInt(m[2]) : null;
  })();

  const util = (() => {
    const m = text.match(UTIL_RE);
    return m ? asInt(m[2]) : null;
  })();

  // per-bureau inq slice (if present as EX/TU/EQ triple)
  let ex = 0, tu = 0, eq = 0;
  const inq = text.match(INQ_RE);
  if (inq) { ex = asInt(inq[2]) ?? 0; tu = asInt(inq[3]) ?? 0; eq = asInt(inq[4]) ?? 0; }

  const negLines = (text.match(NEG_LINE_RE) || []).slice(0, 64).map(s => s.toLowerCase());
  const negatives_count = negLines.length;

  // AAoA (years+months)
  let avgAgeYears: number | null = null;
  const aaoa = text.match(AVG_AGE_RE);
  if (aaoa) {
    const years = asInt(aaoa[2]) ?? 0;
    const months = asInt(aaoa[4]) ?? 0;
    avgAgeYears = +(years + months / 12).toFixed(2);
  }

  // highest card limit + "seasoned" version (within 250 chars of an opened date >= 24 mo)
  let highestCardLimit = 0;
  let seasonedHighestCardLimit = 0;

  let limMatch: RegExpExecArray | null;
  while ((limMatch = LIMIT_RE.exec(text)) !== null) {
    const val = moneyToInt(limMatch[2] || "");
    if (!val) continue;
    highestCardLimit = Math.max(highestCardLimit, val);

    // try to find nearby opened date to judge seasoning
    const start = Math.max(0, limMatch.index - 250);
    const end = Math.min(text.length, limMatch.index + (limMatch[0]?.length || 0) + 250);
    const nearby = text.slice(start, end);
    const od = [...nearby.matchAll(OPENED_DATE_RE)].map(m => m[2]).find(Boolean);
    const d = od ? parseOpenedDate(od) : null;
    const seasoned = d ? monthsSince(d) >= CONFIG.seasoningMonths : false;
    if (seasoned) seasonedHighestCardLimit = Math.max(seasonedHighestCardLimit, val);
  }

  // largest unsecured installment + seasoned
  let largestInstallment = 0;
  let largestUnsecuredInstallment = 0;
  let seasonedLargestUnsecuredInstallment = 0;

  let loanMatch: RegExpExecArray | null;
  while ((loanMatch = LOAN_AMT_RE.exec(text)) !== null) {
    const val = moneyToInt(loanMatch[2] || "");
    if (!val) continue;
    largestInstallment = Math.max(largestInstallment, val);

    // local context to filter secured loans
    const start = Math.max(0, loanMatch.index - 200);
    const end = Math.min(text.length, loanMatch.index + (loanMatch[0]?.length || 0) + 200);
    const ctx = text.slice(start, end);
    const looksSecured = SECURED_HINT_RE.test(ctx);

    if (!looksSecured) {
      largestUnsecuredInstallment = Math.max(largestUnsecuredInstallment, val);
      const od = [...ctx.matchAll(OPENED_DATE_RE)].map(m => m[2]).find(Boolean);
      const d = od ? parseOpenedDate(od) : null;
      const seasoned = d ? monthsSince(d) >= CONFIG.seasoningMonths : false;
      if (seasoned) {
        seasonedLargestUnsecuredInstallment = Math.max(seasonedLargestUnsecuredInstallment, val);
      }
    }
  }

  // new accounts / open accounts (heuristic)
  let newAccounts12mo = 0;
  for (const o of text.matchAll(OPENED_DATE_RE)) {
    const dtStr = o[2] || "";
    const d = parseOpenedDate(dtStr);
    if (d && monthsSince(d) <= 12) newAccounts12mo++;
  }
  const openAccounts = (text.match(OPEN_STATUS_RE) || []).length;

  return {
    score, util, inq: { ex, tu, eq }, negatives_count, negLines,
    avgAgeYears,
    highestCardLimit,
    seasonedHighestCardLimit,
    largestInstallment,
    largestUnsecuredInstallment,
    seasonedLargestUnsecuredInstallment,
    newAccounts12mo,
    openAccounts,
  };
}

// ---------- light math helpers ----------
const normalizeWeights = (w: number[]) => {
  const s = w.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
  return w.map(x => (x > 0 ? x / s : 0));
};
function dampenOutliers(values: (number | null)[], maxDelta: number) {
  const arr = values.filter(v => v != null) as number[];
  if (arr.length < 3) return values; // not enough to establish a mean reliably
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return values.map(v => (v == null ? null : Math.abs(v - mean) > maxDelta ? mean : v));
}
function weightedAverageSafe(values: (number | null)[], weights: number[]) {
  const pairs = values.map((v, i) => (v != null && weights[i] > 0 ? { v, w: weights[i] } : null)).filter(Boolean) as { v: number, w: number }[];
  if (!pairs.length) return null;
  const W = pairs.reduce((a, b) => a + b.w, 0);
  return Math.round(pairs.reduce((a, b) => a + b.v * b.w, 0) / W);
}

// ---------- grading & funding ----------
function gradeFromPoints(n: number): Grade {
  if (n >= 11) return "A";
  if (n >= 9)  return "B";
  if (n >= 7)  return "C";
  return "D";
}
const order: Grade[] = ["A", "B", "C", "D"];
const maxGrade = (g1: Grade, cap: Grade) => {
  // enforce "no better than cap"
  return order.indexOf(g1) <= order.indexOf(cap) ? cap : g1; // not used; we’ll clamp with indices explicitly where needed
};
const downgrade = (g: Grade) => order[Math.min(order.indexOf(g) + 1, order.length - 1)];

// ---------- API handler ----------
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, code: "method_not_allowed", msg: "Method not allowed" });

  const form = formidable({ multiples: true, keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) return res.status(400).json({ ok: false, code: "parse_error", msg: "Upload parsing failed" });

      const uploaded = files.file;
      const fileArr: FormidableFile[] = Array.isArray(uploaded) ? uploaded as FormidableFile[] : uploaded ? [uploaded as FormidableFile] : [];
      if (!fileArr.length) return res.status(400).json({ ok: false, code: "no_files", msg: "Please upload 1–3 bureau PDF reports." });

      // Optional business inputs (from your UI)
      const businessName = (fields.businessName as string) || "";
      const businessAgeMonths = asInt(fields.businessAgeMonths as string) ?? null;
      const hasBusiness = !!businessName && businessName.trim().length > 1;

      // Read all PDFs -> text
      const texts: string[] = [];
      for (const f of fileArr) {
        const name = (f.originalFilename || "").toLowerCase();
        if (!/\.pdf$/.test(name)) {
          return res.status(400).json({ ok: false, code: "bad_type", msg: "Only PDF credit reports are supported right now." });
        }
        const buf = await fs.promises.readFile(f.filepath);
        const parsed = await pdfParse(buf);
        texts.push((parsed.text || "").replace(/\s+/g, " ").trim());
      }

      // Bureau detection (very tolerant; for mixed/combined PDFs we just run 3 extracts & merge)
      const mergedText = texts.join(" \n ");
      const textLower = mergedText.toLowerCase();
      const hasEX = textLower.includes("experian");
      const hasTU = textLower.includes("transunion");
      const hasEQ = textLower.includes("equifax");

      // Run extract on each (fallback to merged if not distinctly present)
      const exData = hasEX ? extractFrom(mergedText) : null;
      const tuData = hasTU ? extractFrom(mergedText) : null;
      const eqData = hasEQ ? extractFrom(mergedText) : null;
      const fbData = (!exData && !tuData && !eqData) ? extractFrom(mergedText) : null;

      // Collect raw series
      const scoreVals = [exData?.score, tuData?.score, eqData?.score] as (number|null)[];
      const utilVals  = [exData?.util,  tuData?.util,  eqData?.util]  as (number|null)[];

      // dampen outliers (3-bureau only)
      const scoreClean = dampenOutliers(scoreVals, CONFIG.outlierScoreDelta);
      const utilClean  = dampenOutliers(utilVals,  CONFIG.outlierUtilDelta);

      // weights (normalize for whatever set is present)
      let wEX = exData ? CONFIG.weights.EX : 0;
      let wTU = tuData ? CONFIG.weights.TU : 0;
      let wEQ = eqData ? CONFIG.weights.EQ : 0;
      if (!exData && !tuData && !eqData && fbData) { wEX = 1; } // single composite
      [wEX, wTU, wEQ] = normalizeWeights([wEX, wTU, wEQ]);

      const score = weightedAverageSafe(
        exData || tuData || eqData ? scoreClean : [fbData?.score ?? null],
        exData || tuData || eqData ? [wEX, wTU, wEQ] : [1]
      );
      const util = weightedAverageSafe(
        exData || tuData || eqData ? utilClean : [fbData?.util ?? null],
        exData || tuData || eqData ? [wEX, wTU, wEQ] : [1]
      );

      // Inquiries & negatives
      const exInq = exData?.inq.ex ?? 0;
      const tuInq = tuData?.inq.tu ?? 0;
      const eqInq = eqData?.inq.eq ?? 0;
      const inquiries = { ex: exInq, tu: tuInq, eq: eqInq };
      const totalInquiries = exInq + tuInq + eqInq;

      const negatives_count = Math.max(
        exData?.negatives_count ?? 0,
        tuData?.negatives_count ?? 0,
        eqData?.negatives_count ?? 0,
        fbData?.negatives_count ?? 0
      );
      const negLines = [
        ...(exData?.negLines || []),
        ...(tuData?.negLines || []),
        ...(eqData?.negLines || []),
        ...(fbData?.negLines || []),
      ].slice(0, 48);

      // Other signals (use “best available”)
      const avgAgeYears = (() => {
        const arr = [exData?.avgAgeYears, tuData?.avgAgeYears, eqData?.avgAgeYears, fbData?.avgAgeYears].filter(v => v != null) as number[];
        return arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
      })();
      const highestCardLimit = Math.max(exData?.highestCardLimit ?? 0, tuData?.highestCardLimit ?? 0, eqData?.highestCardLimit ?? 0, fbData?.highestCardLimit ?? 0);
      const seasonedHighestCardLimit = Math.max(exData?.seasonedHighestCardLimit ?? 0, tuData?.seasonedHighestCardLimit ?? 0, eqData?.seasonedHighestCardLimit ?? 0);
      const largestInstallment = Math.max(exData?.largestInstallment ?? 0, tuData?.largestInstallment ?? 0, eqData?.largestInstallment ?? 0, fbData?.largestInstallment ?? 0);
      const largestUnsecuredInstallment = Math.max(exData?.largestUnsecuredInstallment ?? 0, tuData?.largestUnsecuredInstallment ?? 0, eqData?.largestUnsecuredInstallment ?? 0);
      const seasonedLargestUnsecuredInstallment = Math.max(exData?.seasonedLargestUnsecuredInstallment ?? 0, tuData?.seasonedLargestUnsecuredInstallment ?? 0, eqData?.seasonedLargestUnsecuredInstallment ?? 0);

      const newAccounts12mo = Math.max(exData?.newAccounts12mo ?? 0, tuData?.newAccounts12mo ?? 0, eqData?.newAccounts12mo ?? 0, fbData?.newAccounts12mo ?? 0);
      const openAccounts     = Math.max(exData?.openAccounts ?? 0, tuData?.openAccounts ?? 0, eqData?.openAccounts ?? 0, fbData?.openAccounts ?? 0);

      // ---------------- Fundable gate (MVP) ----------------
      const gate = CONFIG.gate;
      const fundable =
        (score != null && score >= gate.minScore) &&
        (util == null || util <= gate.maxUtil) &&
        negatives_count <= gate.maxNegatives &&
        totalInquiries <= gate.maxInquiriesTotal;

      // ---------------- Pillars ----------------
      const hasBK = negLines.some(l => l.includes("bankruptcy") || l.includes("public record"));
      const has90Late = negLines.some(l => l.includes("90") && l.includes("late"));

      let dataQualityConstrained = false;
      const PH = (() => {            // Payment history
        if (negatives_count === 0) return 3;
        if (hasBK) return 1;
        const anyCollection = negLines.some(l => l.includes("collection") || l.includes("charge-off"));
        const count30 = negLines.filter(l => l.includes("30") && l.includes("late")).length;
        return (!anyCollection && count30 <= 1) ? 2 : 1;
      })();
      const UT = (() => {            // Utilization
        if (util == null) { dataQualityConstrained = true; return 2; }
        if (util < 10) return 3;
        if (util <= 30) return 2;
        return util > 50 ? 1 : 2; // 31–50 adequate
      })();
      const DA = (() => {            // Depth & Age
        if (avgAgeYears == null) { dataQualityConstrained = true; return (openAccounts > 3 ? 2 : 1); }
        if (avgAgeYears >= 5 && openAccounts >= 5) return 3;
        if (avgAgeYears >= 3) return 2;
        return 1;
      })();
      const NR = (() => {            // New credit behavior
        if (newAccounts12mo == null) { dataQualityConstrained = true; return 2; }
        if (newAccounts12mo === 0) return 3;
        if (newAccounts12mo <= 2) return 2;
        return 1;
      })();

      const total12 = PH + UT + DA + NR;

      // product-specific weighting
      const toGrade = (forCards: boolean): Grade => {
        const weighted = forCards ? (PH * 2 + UT * 2 + DA + NR) : (PH * 2 + DA * 2 + UT + NR);
        const scaled = Math.round((weighted / 18) * 12);
        let g = gradeFromPoints(scaled);
        // pre-caps
        const hardCap: Grade | null = hasBK ? "D" : (has90Late ? "C" : null);
        if (hardCap) {
          const cIdx = order.indexOf(hardCap);
          const gIdx = order.indexOf(g);
          if (gIdx < cIdx) g = hardCap;
        }
        if (dataQualityConstrained) g = downgrade(g);
        return g;
      };

      let gradeCard = toGrade(true);
      let gradeLoan = toGrade(false);

      // Guardrails
      const guardrail = ((util ?? 0) > 70 && newAccounts12mo >= 3) || ((avgAgeYears ?? 99) < 2 && openAccounts <= 3);
      if (guardrail) {
        gradeCard = downgrade(gradeCard);
        gradeLoan = downgrade(gradeLoan);
      }

      // Base ranges from grade
      const baseCard = CONFIG.baseCardRanges[gradeCard];
      const baseLoan = CONFIG.baseLoanRanges[gradeLoan];

      // Comparable-credit realism caps
      const seasonedCard = seasonedHighestCardLimit || highestCardLimit || 0;
      const seasonedUnsec = seasonedLargestUnsecuredInstallment || largestUnsecuredInstallment || 0;

      const cardCap = seasonedCard * CONFIG.cardMultipliers[gradeCard];
      const loanCap = seasonedUnsec > 0
        ? seasonedUnsec * CONFIG.loanMultipliers[gradeLoan]
        : Math.min(CONFIG.baseLoanRanges[gradeLoan].max, 10000); // no unsecured history → conservative cap

      // Apply caps to base ranges (cap the max; ensure min <= max)
      const cardRangeMax = Math.max(0, Math.min(baseCard.max, Math.round(cardCap / 1000) * 1000 || baseCard.max));
      const loanRangeMax = Math.max(0, Math.min(baseLoan.max, Math.round(loanCap / 1000) * 1000 || baseLoan.max));

      const cardRangeMin = Math.min(baseCard.min, cardRangeMax);
      const loanRangeMin = Math.min(baseLoan.min, loanRangeMax);

      const likelihood = (g: Grade) => (g === "A" ? "High" : g === "B" ? "Moderate" : g === "C" ? "Low" : "Unlikely");

      // PERSONAL subtotals & banner for personal
      const personal_card = { grade: gradeCard, likelihood: likelihood(gradeCard), range_min: cardRangeMin, range_max: cardRangeMax };
      const personal_loan = { grade: gradeLoan, likelihood: likelihood(gradeLoan), range_min: loanRangeMin, range_max: loanRangeMax };
      const personal_total_max = cardRangeMax + loanRangeMax;

      // BUSINESS (optional): conservative default = duplicate personal total
      const business_multiplier = hasBusiness ? CONFIG.businessMultiplierDefault : 0;
      const business_total_max = Math.round(personal_total_max * business_multiplier / 1000) * 1000;

      // Banner estimate = personal + business
      const banner_estimate = personal_total_max + business_total_max;

      // Debug/Explain
      const reasons: string[] = [];
      if (PH === 3) reasons.push("Clean recent payment history");
      if (PH === 1) reasons.push("Delinquencies/derogatories present");
      if (UT === 3) reasons.push("Very low revolving utilization");
      if (UT === 1) reasons.push("High revolving utilization");
      if (DA === 3) reasons.push("Seasoned depth and mix");
      if (DA === 1) reasons.push("Thin or young credit file");
      if (NR === 3) reasons.push("No new accounts in the last 12 months");
      if (NR === 1) reasons.push("Multiple recent new accounts");
      if (seasonedCard) reasons.push(`Seasoned highest card limit $${seasonedCard.toLocaleString()}`);
      if (seasonedUnsec) reasons.push(`Seasoned largest unsecured loan $${seasonedUnsec.toLocaleString()}`);
      if (guardrail) reasons.push("Guardrail applied (utilization/recency or thin file)");

      const flags: string[] = [];
      if (hasBK) flags.push("Bankruptcy or public record");
      if (has90Late) flags.push("Recent severe delinquency (90‑day late)");
      if (dataQualityConstrained) flags.push("Data quality constrained");
      if ((util ?? 0) > 70 && newAccounts12mo >= 3) flags.push("High utilization with many new accounts");
      if ((avgAgeYears ?? 99) < 2 && openAccounts <= 3) flags.push("Very young & sparse file");

      // final response
      return res.status(200).json({
        ok: true,
        inputs: {
          business: hasBusiness ? { name: businessName, age_months: businessAgeMonths } : null,
          composite: {
            score, util, inquiries, negatives_count,
            active_weights: { EX: wEX, TU: wTU, EQ: wEQ },
          },
        },
        outputs: {
          fundable,
          banner_estimate,                 // what you show big in the UI
          personal_total_max,              // personal-only max (cards + loan)
          business_total_max,              // if business included
          personal_card,
          personal_loan,
          meta: {
            score_estimate: score,
            utilization_pct: util,
            inquiries,
            negatives_count,
            avg_age_years: avgAgeYears,
            highest_card_limit: highestCardLimit || null,
            seasoned_highest_card_limit: seasonedHighestCardLimit || null,
            largest_installment: largestInstallment || null,
            largest_unsecured_installment: largestUnsecuredInstallment || null,
            seasoned_largest_unsecured_installment: seasonedLargestUnsecuredInstallment || null,
            new_accounts_12mo: newAccounts12mo || 0,
            open_accounts: openAccounts || 0,
            flags,
            reasons: reasons.slice(0, 6),
          },
        },
      });
    } catch (e: any) {
      console.error(e);
      return res.status(500).json({
        ok: false,
        code: "parser_error",
        msg: "We couldn’t read your PDF(s). Please upload clear Experian/TransUnion/Equifax reports.",
        detail: e?.message || "unknown",
        tips: [
          "Export a fresh PDF (not a photo).",
          "Upload up to 3 PDFs — one per bureau is fine.",
          "If it still fails, try uploading just Experian first.",
        ],
      });
    }
  });
}
