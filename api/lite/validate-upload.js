// api/lite/validate-upload.js
const formidable = require("formidable");

module.exports.config = { api: { bodyParser: false, sizeLimit: "20mb" } };

// Minimum size for a real credit report PDF (~50 KB)
const MIN_PDF_SIZE_BYTES = 50 * 1024;

module.exports = function handler(req, res) {
  // --- CORS preflight ---
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  // --- Method guard ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, msg: "Method not allowed" });
  }

  // --- Form parsing ---
  const form = formidable({
    multiples: true,
    keepExtensions: true,
    maxFileSize: 20 * 1024 * 1024
  });

  form.parse(req, (err, fields, files) => {
    if (err) {
      return res.status(400).json({
        ok: false,
        msg: "Upload parsing failed",
        detail: String(err)
      });
    }

    // extract uploaded file(s)
    const up = files && (files.file ?? files["file"]);
    const arr = Array.isArray(up) ? up : up ? [up] : [];

    if (!arr.length) {
      return res.status(400).json({
        ok: false,
        msg: "Attach at least one PDF."
      });
    }

    // --- Check file extension ---
    const allPdf = arr.every(f => (f.originalFilename || "").toLowerCase().endsWith(".pdf"));

    if (!allPdf) {
      return res.status(400).json({
        ok: false,
        msg: "Only PDF credit reports are supported."
      });
    }

    // --- NEW: bad-file detection by size ----
    const tooSmall = arr.some(f => (f.size || 0) < MIN_PDF_SIZE_BYTES);

    if (tooSmall) {
      return res.status(400).json({
        ok: false,
        msg:
          "The file looks too small to be a full credit report. " +
          "Please upload the complete PDF from Experian, Equifax, or TransUnion."
      });
    }

    // --- Passed all checks ---
    return res.status(200).json({ ok: true, msg: "Validated" });
  });
};
