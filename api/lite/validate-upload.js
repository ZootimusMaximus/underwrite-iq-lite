// api/lite/validate-upload.js
const formidable = require("formidable");

module.exports.config = { api: { bodyParser: false, sizeLimit: "25mb" } };

module.exports = async function handler(req, res) {
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

  const form = formidable({ multiples: true, keepExtensions: true, maxFileSize: 25 * 1024 * 1024 });
  form.parse(req, (err, fields, files) => {
    if (err) {
      return res.status(400).json({ ok: false, msg: "Upload parsing failed", detail: String(err) });
    }
    const up = files && (files.file ?? files["file"]);
    const arr = Array.isArray(up) ? up : (up ? [up] : []);
    if (!arr.length) return res.status(400).json({ ok: false, msg: "Attach at least one PDF." });

    const allPdf = arr.every(f => (f.originalFilename || "").toLowerCase().endsWith(".pdf"));
    if (!allPdf) return res.status(400).json({ ok: false, msg: "Only PDF credit reports are supported." });

    return res.status(200).json({ ok: true, msg: "Validated" });
  });
};
