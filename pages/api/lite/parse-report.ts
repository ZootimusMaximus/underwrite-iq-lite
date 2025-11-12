// /pages/api/lite/parse-report.ts
import type { NextApiRequest, NextApiResponse } from "next";
import formidable, { File as FormidableFile } from "formidable";
import pdfParse from "pdf-parse";
import fs from "fs";

// Next.js API must disable body parsing for formidable
export const config = { api: { bodyParser: false } };

// -----------------------------
// Regex helpers (robust to messy text)
// -----------------------------
const SCORE_RE = /(fico|score)\D{0,6}(\d{3})/i;
const UTIL_RE = /(utilization|utilisation|util)\D{0,10}(\d{1,3})\s?%/i;
const INQ_RE = /(inquiries|inq)[^a-zA-Z0-9]+ex\D*(\d+)\D+tu\D*(\d+)\D+eq\D*(\d+)/i;
const NEG_LINE_RE = /(collection|charge[-\s]?off|late payment|30[-\s]?day|60[-\s]?day|90[-\s]?day|delinquent|public\s+record|bankruptcy)[^.]{0,120}/gi;
const AVG_AGE_RE = /(average\s+age\s+of\s+accounts|average\s+account\s+age|aaoa)\D{0,20}(\d{1,2})\D{0,8}(year|yr|years)?\D{0,8}(\d{1,2})?\D{0,8}(month|mo|months)?/i;
const HIGHEST_CARD_LIMIT_RE = /(highest\s+credit\s+limit|high\s+credit|credit\s+limit)\D{0,10}\$?\s?([\d,]{2,9})/gi;
const LARGEST_INSTALLMENT_RE = /(largest\s+(original\s+)?loan|original\s+loan\s+amount|loan\s+amount)\D{0,10}\$?\s?([\d,]{2,9})/gi;
const OPENED_DATE_RE = /(opened|open\s+date|date\s+opened)\D{0,12}((\d{1,2}[-\/]\d{2,4})|([A-Za-z]{3,9}\s+\d{4}))?/gi;
const OPEN_STATUS_RE = /(status|account\s+status)\D{0,12}(open|opened)/gi;

type BureauKey = "experian" | "transunion" | "equifax";
type Grade = "A" | "B" | "C" | "D";

// Utility
const asInt = (s: any) => {
  const n = typeof s === "string" ? s.replace(/[^\d]/g, "") : s;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
};
const pickInt = (m: RegExpMatchArray | null, idx: number) => (m && m[idx] ? asInt(m[idx]) : null);
const moneyToInt = (s: string) => asInt(s);

const monthsSince = (d: Date) => {
  const now = new Date();
  return (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
};
const parseOpenedDate = (s: string): Date | null => {
  // supports MM/YYYY, M/YYYY, or "Month YYYY"
  const mmYYYY = s.match(/(\d{1,2})[-\/](\d{4})/);
  if (mmYYYY) {
    const m = asInt(mmYYYY[1])! - 1;
    const y = asInt(mmYYYY[2])!;
    return new Date(y, m, 1);
  }
  const monthYYYY = s.match(/([A-Za-z]{3,9})\s+(\d{4})/);
  if (monthYYYY) {
    const y = asInt(monthYYYY[2])!;
    const m = new Date(`${monthYYYY[1]} 1, ${y}`).getMonth();
    if (!Number.isNaN(m)) return new Date(y, m, 1);
  }
  return null;
};

// -----------------------------
// Core handler
// -----------------------------
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, msg: "Method not allowed" });

  const form = formidable({ multiples: true, keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    try {
      const uploaded = files.file;
      const fileArr: FormidableFile[] = Array.isArray(uploaded)
        ? uploaded as FormidableFile[]
        : uploaded ? [uploaded as FormidableFile] : [];

      if (!fileArr.length) return res.status(400).json({ ok: false, msg: "No file(s) uploaded" });

      // Parse all PDFs → text
      const bureaus: Partial<Record<BureauKey, string>> = {};
      const texts: string[] = [];

      for (const f of fileArr) {
        const name = (f.originalFilename || "").toLowerCase();
        if (!/\.pdf$/.test(name)) {
          return res.status(400).json({ ok: false, msg: "Please upload PDF reports (images/OCR coming in ULTRA)" });
        }
        const buf = await fs.promises.readFile(f.filepath);
        const parsed = await pdfParse(buf);
        const text = (parsed.text || "").replace(/\s+/g, " ").trim();
        texts.push(text);

        // crude bureau detection; tolerate combined reports
        const lower = text.toLowerCase();
        if (lower.includes("experian")) bureaus.experian = text;
        if (lower.includes("transunion")) bureaus.transunion = text;
        if (lower.includes("equifax")) bureaus.equifax = text;
        // for combined 3‑bureau PDFs, we keep the whole text in each that is detected
      }

      // If we didn't detect any bureau names (odd formats), still analyze merged text
      const mergedText = texts.join(" \n ");

      // -----------------------------
      // per-bureau extraction
      // -----------------------------
      function extractFrom(text: string) {
        const score = pickInt(text.match(SCORE_RE), 2);
        const util = pickInt(text.match(UTIL_RE), 2);

        let ex = 0, tu = 0, eq = 0;
        const inq = text.match(INQ_RE);
        if (inq) { ex = asInt(inq[2]) ?? 0; tu = asInt(inq[3]) ?? 0; eq = asInt(inq[4]) ?? 0; }

        const negLines = (text.match(NEG_LINE_RE) || []).slice(0, 32).map(s => s.toLowerCase());
        const negatives_count = negLines.length;

        // average age of accounts (years + months)
        let avgAgeYears: number | null = null;
        const aaoa = text.match(AVG_AGE_RE);
        if (aaoa) {
          const years = asInt(aaoa[2]) ?? 0;
          const months = asInt(aaoa[4]) ?? 0;
          avgAgeYears = +(years + months / 12).toFixed(2);
        }

        // comparable-credit anchors
        let highestCardLimit = 0;
        let m: RegExpExecArray | null;
        while ((m = HIGHEST_CARD_LIMIT_RE.exec(text)) !== null) {
          const val = moneyToInt(m[2]);
          if (val && val > highestCardLimit) highestCardLimit = val;
        }

        let largestInstallment = 0;
        while ((m = LARGEST_INSTALLMENT_RE.exec(text)) !== null) {
          const val = moneyToInt(m[2]);
          if (val && val > largestInstallment) largestInstallment = val;
        }

        // new accounts last 12 mo (heuristic)
        let newAccounts12mo = 0;
        const opened = text.matchAll(OPENED_DATE_RE);
        for (const o of opened) {
          const dtStr = o[2] || "";
          const d = parseOpenedDate(dtStr);
          if (d && monthsSince(d) <= 12) newAccounts12mo++;
        }

        // open accounts count (heuristic)
        const openAccounts = (text.match(OPEN_STATUS_RE) || []).length;

        return {
          score, util, inq: { ex, tu, eq }, negatives_count, negLines,
          avgAgeYears,
          highestCardLimit,
          largestInstallment,
          newAccounts12mo,
          openAccounts
        };
      }

      const exData = bureaus.experian ? extractFrom(bureaus.experian) : null;
      const tuData = bureaus.transunion ? extractFrom(bureaus.transunion) : null;
      const eqData = bureaus.equifax ? extractFrom(bureaus.equifax) : null;

      // Fallback: if nothing detected, extract from merged
      const fbData = (!exData && !tuData && !eqData) ? extractFrom(mergedText) : null;

      // -----------------------------
      // Aggregate metrics
      // -----------------------------
      const scores = [exData?.score, tuData?.score, eqData?.score, fbData?.score].filter(v => v != null) as number[];
      const utils = [exData?.util, tuData?.util, eqData?.util, fbData?.util].filter(v => v != null) as number[];
      const negCounts = [exData?.negatives_count ?? 0, tuData?.negatives_count ?? 0, eqData?.negatives_count ?? 0, fbData?.negatives_count ?? 0];

      const score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      const util = utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null;

      const ex = (exData?.inq.ex ?? 0) + (fbData ? 0 : 0);
      const tu = (tuData?.inq.tu ?? 0) + (fbData ? 0 : 0);
      const eq = (eqData?.inq.eq ?? 0) + (fbData ? 0 : 0);
      const negatives_count = Math.max(...negCounts);

      const avgAgeYears = [exData?.avgAgeYears, tuData?.avgAgeYears, eqData?.avgAgeYears, fbData?.avgAgeYears]
        .filter(v => v != null) as number[];
      const avgAge = avgAgeYears.length ? +(avgAgeYears.reduce((a, b) => a + b, 0) / avgAgeYears.length).toFixed(2) : null;

      const highestCardLimit = Math.max(exData?.highestCardLimit ?? 0, tuData?.highestCardLimit ?? 0, eqData?.highestCardLimit ?? 0, fbData?.highestCardLimit ?? 0);
      const largestInstallment = Math.max(exData?.largestInstallment ?? 0, tuData?.largestInstallment ?? 0, eqData?.largestInstallment ?? 0, fbData?.largestInstallment ?? 0);
      const newAccounts12mo = Math.max(exData?.newAccounts12mo ?? 0, tuData?.newAccounts12mo ?? 0, eqData?.newAccounts12mo ?? 0, fbData?.newAccounts12mo ?? 0);
      const openAccounts = Math.max(exData?.openAccounts ?? 0, tuData?.openAccounts ?? 0, eqData?.openAccounts ?? 0, fbData?.openAccounts ?? 0);

      const negLines = [
        ...(exData?.negLines || []),
        ...(tuData?.negLines || []),
        ...(eqData?.negLines || []),
        ...(fbData?.negLines || []),
      ].slice(0, 32);

      // -----------------------------
      // Fundable (your MVP boolean gate)
      // -----------------------------
      function isFundable(
        score: number | null,
        util: number | null,
        negs: number,
        inquiries: { ex: number; tu: number; eq: number }
      ) {
        const MIN_SCORE = 700;
        const MAX_UTILIZATION = 30;
        const MAX_INQUIRIES = 6; // across EX+TU+EQ last 12 mo
        const MAX_NEGATIVES = 0;

        if (score === null) return false;
        if (score < MIN_SCORE) return false;
        if (util !== null && util > MAX_UTILIZATION) return false;
        if (negs > MAX_NEGATIVES) return false;

        const totalInq = (inquiries.ex || 0) + (inquiries.tu || 0) + (inquiries.eq || 0);
        if (totalInq > MAX_INQUIRIES) return false;

        return true;
      }

      const fundable = isFundable(score, util, negatives_count, { ex, tu, eq }); // :contentReference[oaicite:0]{index=0}

      // -----------------------------
      // Underwrite IQ LITE – Pillars → Grade
      // -----------------------------
      type Pillar = 1 | 2 | 3; // Weak=1, Adequate=2, Strong=3

      // Hard pre-checks
      const hasBK = negLines.some(l => l.includes("bankruptcy") || l.includes("public record"));
      const has90Late = negLines.some(l => l.includes("90") && l.includes("late"));
      let dataQualityConstrained = false;

      // Pillar scoring (plain thresholds from your spec)
      const scorePaymentHistory = (): Pillar => {
        if (negatives_count === 0) return 3;
        if (hasBK) return 1;
        // single minor late: treat as adequate if no collection/charge-off
        const anyCollection = negLines.some(l => l.includes("collection") || l.includes("charge-off"));
        const count30 = negLines.filter(l => l.includes("30") && l.includes("late")).length;
        if (!anyCollection && count30 <= 1) return 2;
        return 1;
      };

      const scoreUtilization = (): Pillar => {
        if (util == null) { dataQualityConstrained = true; return 2; }
        if (util < 10) return 3;
        if (util <= 30) return 2;
        if (util > 50) return 1;
        return 2; // 31–50 = adequate
      };

      const scoreDepthAge = (): Pillar => {
        if (avgAge == null) { dataQualityConstrained = true; return (openAccounts > 3 ? 2 : 1); }
        if (avgAge >= 5 && openAccounts >= 5) return 3;
        if (avgAge >= 3) return 2;
        return 1;
      };

      const scoreRecency = (): Pillar => {
        if (newAccounts12mo == null) { dataQualityConstrained = true; return 2; }
        if (newAccounts12mo === 0) return 3;
        if (newAccounts12mo <= 2) return 2;
        return 1;
      };

      const PH = scorePaymentHistory();         // payment history pillar
      const UT = scoreUtilization();            // utilization pillar
      const DA = scoreDepthAge();               // depth & age pillar
      const NR = scoreRecency();                // new credit behavior pillar

      // Overall (unweighted) points out of 12 → A/B/C/D
      const total12 = PH + UT + DA + NR;

      function gradeFrom12(n: number): Grade {
        if (n >= 11) return "A";
        if (n >= 9) return "B";
        if (n >= 7) return "C";
        return "D";
      }

      // Pre-check caps
      let preCap: Grade | null = null;
      if (hasBK) preCap = "D";
      else if (has90Late) preCap = "C";

      // Product‑specific weighting (cards: PH×2 + UT×2 + DA + NR; loans: PH×2 + DA×2 + UT + NR)
      function weightedToGrade(cards: boolean): Grade {
        const weighted = cards ? (PH * 2 + UT * 2 + DA + NR) : (PH * 2 + DA * 2 + UT + NR);
        const scaledTo12 = Math.round((weighted / 18) * 12); // scale 6..18 → 0..12
        let g = gradeFrom12(scaledTo12);
        if (preCap && (preCap > g)) g = preCap; // "D" > "C" > "B" > "A" lexicographically, but we’ll enforce manually
        if (preCap) {
          const order: Grade[] = ["A", "B", "C", "D"];
          const maxIdx = order.indexOf(preCap);
          const curIdx = order.indexOf(g);
          if (curIdx < maxIdx) g = preCap;
        }
        if (dataQualityConstrained) {
          // reduce 1 tier when critical fields missing
          const order: Grade[] = ["A", "B", "C", "D"];
          const idx = Math.min(order.indexOf(g) + 1, order.length - 1);
          g = order[idx];
        }
        return g;
      }

      let gradeCard = weightedToGrade(true);
      let gradeLoan = weightedToGrade(false);

      // Guardrails – downgrade if utilization very high & many new accounts; thin and young
      const guardrailDowngrade =
        ((util != null && util > 70) && newAccounts12mo >= 3) ||
        ((avgAge != null && avgAge < 2) && openAccounts <= 3);

      if (guardrailDowngrade) {
        const order: Grade[] = ["A", "B", "C", "D"];
        const dcard = Math.min(order.indexOf(gradeCard) + 1, order.length - 1);
        const dloan = Math.min(order.indexOf(gradeLoan) + 1, order.length - 1);
        gradeCard = order[dcard];
        gradeLoan = order[dloan];
      }

      // Map grade → base ranges (USD)
      function baseRangeFor(grade: Grade, product: "card" | "loan") {
        if (product === "card") {
          if (grade === "A") return { min: 15000, max: 30000 };
          if (grade === "B") return { min: 8000, max: 20000 };
          if (grade === "C") return { min: 2000, max: 10000 };
          return { min: 0, max: 2000 };
        } else {
          if (grade === "A") return { min: 20000, max: 40000 };
          if (grade === "B") return { min: 10000, max: 25000 };
          if (grade === "C") return { min: 5000, max: 15000 };
          return { min: 0, max: 5000 };
        }
      }

      let cardRange = baseRangeFor(gradeCard, "card");
      let loanRange = baseRangeFor(gradeLoan, "loan");

      // Comparable‑credit realism caps
      // Cards: cap upper to ~1.5× highest existing limit if base implies a big leap
      if (highestCardLimit > 0) {
        const cap = Math.round((highestCardLimit * 1.5) / 1000) * 1000;
        if (cap < cardRange.max && cap < Math.max(cardRange.max, cardRange.min * 2)) {
          // Only compress when base clearly leaps far beyond proven limit
          cardRange.max = Math.max(cardRange.min, cap);
        }
        // Small boost if already at high limits and very low util
        if (util != null && util <= 10 && highestCardLimit >= cardRange.max) {
          cardRange.max = Math.round(cardRange.max * 1.1 / 1000) * 1000;
        }
      }

      // Loans: if no prior installment, cap <= $10k; else cap ≈ 1.5× largest prior
      if (largestInstallment > 0) {
        const cap = Math.round((largestInstallment * 1.5) / 1000) * 1000;
        if (cap < loanRange.max) loanRange.max = Math.max(loanRange.min, cap);
      } else {
        loanRange.max = Math.min(loanRange.max, 10000);
      }

      // Likelihood labels
      const likelihoodFrom = (g: Grade) => (g === "A" ? "High" : g === "B" ? "Moderate" : g === "C" ? "Low" : "Unlikely");

      // Key reasons (top 3–5)
      const reasons: string[] = [];
      if (PH === 3) reasons.push("Clean 24‑month payment history");
      if (PH === 1) reasons.push("Delinquencies/derogatories present");
      if (UT === 3) reasons.push("Very low revolving utilization");
      if (UT === 1) reasons.push("High revolving utilization");
      if (DA === 3) reasons.push("Seasoned credit depth & mix");
      if (DA === 1) reasons.push("Thin/young credit file");
      if (NR === 3) reasons.push("No new accounts in last 12 months");
      if (NR === 1) reasons.push("Multiple recent new accounts");
      if (highestCardLimit > 0) reasons.push(`Highest card limit $${highestCardLimit.toLocaleString()}`);
      if (largestInstallment > 0) reasons.push(`Largest prior installment $${largestInstallment.toLocaleString()}`);
      if (guardrailDowngrade) reasons.push("Guardrail applied (utilization/recency or thin‑file)");

      const flags: string[] = [];
      if (hasBK) flags.push("Recent/Active bankruptcy or public record");
      if (has90Late) flags.push("Recent severe delinquency (90‑day late)");
      if (dataQualityConstrained) flags.push("Data Quality Constraint");
      if ((util ?? 0) > 70 && newAccounts12mo >= 3) flags.push("High util + many new accounts");
      if ((avgAge ?? 99) < 2 && openAccounts <= 3) flags.push("Very young & sparse file");

      // Analysis summary
      const analysis = [
        score != null ? `Estimated score ${score}.` : "",
        util != null ? `Utilization ${util}%.` : "",
        `Inquiries EX ${ex} • TU ${tu} • EQ ${eq}.`,
        negatives_count ? `${negatives_count} negative item(s) detected.` : "No negatives detected.",
        avgAge != null ? `Avg age ${avgAge} yrs.` : "",
      ].filter(Boolean).join(" ");

      // Final output payload
      const payload = {
        ok: true,
        outputs: {
          fundable,
          score_estimate: score,
          utilization_pct: util,
          inquiries: { ex, tu, eq },
          negatives_count,
          meta: {
            avg_age_years: avgAge,
            highest_card_limit: highestCardLimit || null,
            largest_installment: largestInstallment || null,
            new_accounts_12mo: newAccounts12mo || 0,
            open_accounts: openAccounts || 0,
            flags
          },
          personal_card: {
            grade: gradeCard,
            likelihood: likelihoodFrom(gradeCard),
            range_min: cardRange.min,
            range_max: cardRange.max,
            key_reasons: reasons.slice(0, 5),
          },
          personal_loan: {
            grade: gradeLoan,
            likelihood: likelihoodFrom(gradeLoan),
            range_min: loanRange.min,
            range_max: loanRange.max,
            key_reasons: reasons.slice(0, 5),
          },
          analysis
        }
      };

      return res.status(200).json(payload);

    } catch (e: any) {
      console.error(e);
      return res.status(500).json({ ok: false, msg: "Parser error", error: e?.message || "unknown" });
    }
  });
}
