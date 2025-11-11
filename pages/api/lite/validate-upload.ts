import type { NextApiRequest, NextApiResponse } from "next";
import formidable from "formidable";
import sharp from "sharp";

export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, msg: "Method not allowed" });

  const form = formidable({ multiples: false, keepExtensions: true });
  form.parse(req, async (err, fields, files) => {
    try {
      if (err || !files.file) return res.status(400).json({ ok: false, msg: "Upload failed" });
      const f = Array.isArray(files.file) ? files.file[0] : (files.file as any);
      const name = (f.originalFilename || "").toLowerCase();

      const isPDF = /\.pdf$/.test(name);
      const isIMG = /\.(jpg|jpeg|png)$/.test(name);
      if (!isPDF && !isIMG) return res.status(400).json({ ok: false, msg: "Upload a PDF (preferred) or a clear image." });

      const sizeMB = f.size / (1024 * 1024);
      if (sizeMB < 0.05 || sizeMB > 15) return res.status(400).json({ ok: false, msg: "Invalid file size." });

      if (isIMG) {
        const img = sharp(f.filepath);
        const meta = await img.metadata();
        if (!meta.width || !meta.height || meta.width < 800 || meta.height < 800)
          return res.status(400).json({ ok: false, msg: "Image too small—please upload a clearer photo or a PDF." });

        const raw = await img.greyscale().raw().toBuffer({ resolveWithObject: true });
        const data = raw.data as Uint8Array;
        const mean = data.reduce((a, b) => a + b, 0) / data.length;
        const variance = data.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / data.length;
        if (variance < 50) return res.status(400).json({ ok: false, msg: "Image looks blurry—try a clearer shot." });
      }

      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ ok: false, msg: "Validation error" });
    }
  });
}
