const formidable = require("formidable");
const pdfParse = require("pdf-parse");
const fs = require("fs");

const SCORE_RE = /(fico|score)\D{0,5}(\d{3})/i;
const UTIL_RE  = /(utilization|utilisation|util)\D{0,10}(\d{1,3})\s?%/i;
const INQ_RE   = /(inquiries|inq)\D+ex\D*(\d+)\D+tu\D*(\d+)\D+eq\D*(\d+)/i;
const NEG_RE   = /(collection|charge[-\s]?off|late payment|delinquent|public record|bankruptcy)[^\.]{0,120}/gi;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, msg: "Method not allowed" });
    return;
  }

  const form = formidable({ multiples: false, keepExtensions: true });

  form.parse(req, async (err, _fields, files) => {
    try {
      if (err || !files.file) {
        res.status(400).json({ ok: false, msg: "No file uploaded" });
        return;
      }

      const f = Array.isArray(files.file) ? files.file[0] : files.file;
      const name = (f.originalFilename || "").toLowerCase();
      if (!/\.pdf$/.test(name)) {
        res.status(400).json({ ok: false, msg: "Please upload a PDF for parsing (images later)." });
        return;
      }

      const buf = await fs.promises.readFile(f.filepath);
      const parsed = await pdfParse(buf);
      const text = (parsed.text || "").replace(/\s+/g, " ").trim();

      const score = pickInt(text.match(SCORE_RE), 2);
      const util  = pickInt(text.match(UTIL_RE), 2);

      let ex = 0, tu = 0, eq = 0;
      const inq = text.match(INQ_RE);
      if (inq) { ex = asInt(inq[2]); tu = asInt(inq[3]); eq = asInt(inq[4]); }

      const negatives_list = (text.match(NEG_RE) || []).slice(0, 12).map(l => l.toLowerCase());
      const negatives_count = negatives_list.length;

      const fundable = isFundable(score, util, negatives_count, { ex, tu, eq });
      const est = estimateRange(score, util, negatives_count);

      const analysis =
        `${score ? `Estimated score ${score}. ` : ""}`+
        `${util !== null ? `Utilization ${util}%. ` : ""}`+
        `Inquiries EX ${ex} • TU ${tu} • EQ ${eq}. `+
        `${negatives_count ? `${negatives_count} negatives flagged. ` : "No negatives detected. "}`+
        `${est ? `Estimated funding range $${est.min.toLocaleString()}–$${est.max.toLocaleString()}.` : ""}`;

      res.status(200).json({
        ok: true,
        outputs: {
          score_estimate: score ?? null,
          utilization_pct: util ?? null,
          inquiries: { ex, tu, eq },
          negatives_count,
          negatives_list,
          estimate_min: est?.min ?? null,
          estimate_max: est?.max ?? null,
          fundable,
          analysis
        }
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, msg: "Parse error" });
    }
  });
};

// ---- Helpers ----
function pickInt(m, idx){ if(!m) return null; const n = parseInt(m[idx],10); return isNaN(n)?null:n; }
function asInt(s){ const n = parseInt(s||"0",10); return isNaN(n)?0:n; }

function isFundable(score, util, negs, inquiries) {
  const MIN_SCORE = 700, MAX_UTIL = 30, MAX_INQ = 6, MAX_NEGS = 0;
  if (score === null || score < MIN_SCORE) return false;
  if (util !== null && util > MAX_UTIL) return false;
  if (negs > MAX_NEGS) return false;
  if ((inquiries.ex + inquiries.tu + inquiries.eq) > MAX_INQ) return false;
  return true;
}

function estimateRange(score, util, negs){
  if(score===null) return null;
  let base = score >= 760 ? 120000 : score >= 720 ? 90000 : 60000;
  if (util!==null) base *= util <= 10 ? 1.1 : util <= 30 ? 1.0 : 0.8;
  if ((negs||0) > 0) base *= 0.5;
  const min = Math.round(base*0.8/1000)*1000;
  const max = Math.round(base*1.2/1000)*1000;
  return { min, max };
}
