import { PDFDocument, StandardFonts } from "pdf-lib";

export default async function handler(req, res) {
  try {
    const body = req.body;

    // Extract JSON from UnderwriteIQ (your parsed report)
    const { name, email, score, neg, late, inquiries, addresses, employers } = body;

    // Pick dummy templates for now
    const templates = selectTemplates({ neg, late, inquiries });

    // Generate PDFs
    const pdfs = await Promise.all(
      templates.map(async t => {
        return await createPdfLetter(name, t.bureau, t.text);
      })
    );

    // Convert PDFs to base64 for GHL upload
    const files = pdfs.map((pdf, i) => ({
      filename: `Round1-${templates[i].bureau}.pdf`,
      content: pdf.toString("base64")
    }));

    // Return to GHL webhook
    return res.status(200).json({
      ok: true,
      files,
      user: { name, email }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ---------------------
// TEMPLATE SELECTOR
// ---------------------
function selectTemplates(data) {
  const output = [];

  // ALWAYS generate 3 letters (EX, TU, EQ)
  const bureaus = ["Experian", "TransUnion", "Equifax"];

  bureaus.forEach(b => {
    output.push({
      bureau: b,
      text: `This is a placeholder dispute letter for ${b}. 
      
      Negative: ${data.neg}
      Late: ${data.late}
      Inquiries: ${data.inquiries}
      
      (Real template goes here.)`
    });
  });

  return output;
}

// ---------------------
// PDF CREATOR FUNCTION
// ---------------------
async function createPdfLetter(name, bureau, text) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]); // standard letter

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 12;

  const wrapped = wrapText(text, font, fontSize, 570);

  page.drawText(`${name}`, { x: 40, y: 740, size: 14, font });
  page.drawText(`${bureau}`, { x: 40, y: 720, size: 14, font });
  page.drawText(wrapped, { x: 40, y: 680, size: 12, font, lineHeight: 14 });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// ---------------------
// TEXT WRAP HELPER
// ---------------------
function wrapText(text, font, size, maxWidth) {
  const words = text.split(" ");
  let line = "";
  let lines = "";

  words.forEach(word => {
    const w = font.widthOfTextAtSize(line + word, size);
    if (w < maxWidth) {
      line += word + " ";
    } else {
      lines += line + "\n";
      line = word + " ";
    }
  });
  lines += line;

  return lines;
}
