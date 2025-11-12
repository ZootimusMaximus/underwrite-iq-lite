const formidable = require("formidable");
const sharp = require("sharp");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, msg: "Method not allowed" });
    return;
  }

  const form = formidable({ multiples: false, keepExtensions: true });

  form.parse(req, async (err, _fields, files) => {
    try {
      if (err || !files.file) {
        res.status(400).json({ ok: false, msg: "Upload failed" });
        return;
      }

      const f = Array.isArray(files.file) ? files.file[0] : files.file;
      const name = (f.originalFilename || "").toLowerCase();

      const isPDF = /\.pdf$/.test(name);
      const isIMG = /\.(jpg|jpeg|png)$/.test(name);
      if (!isPDF && !isIMG) {
        res.status(400).json({ ok: false, msg: "Upload a PDF (preferred) or a clear image." });
        return;
      }

      const sizeMB = f.size / (1024 * 1024);
      if (sizeMB < 0.05 || sizeMB > 15) {
        res.status(400).json({ ok: false, msg: "Invalid file size." });
        return;
      }

      if (isIMG) {
        const img = sharp(f.filepath);
        const meta = await img.metadata();
        if (!meta.width || !meta.height || meta.width < 800 || meta.height < 800) {
          res.status(400).json({ ok: false, msg: "Image too small—please upload a clearer photo or a PDF." });
          return;
        }

        const raw = await img.greyscale().raw().toBuffer({ resolveWithObject: true });
        const data = raw.data;
        const mean = data.reduce((a, b) => a + b, 0) / data.length;
        const variance = data.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / data.length;
        if (variance < 50) {
          res.status(400).json({ ok: false, msg: "Image looks blurry—try a clearer shot." });
          return;
        }
      }

      res.status(200).json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, msg: "Validation error" });
    }
  });
};
