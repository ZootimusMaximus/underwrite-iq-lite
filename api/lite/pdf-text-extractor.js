// ==================================================================================
// PDF Text Extraction Module
// Uses pdf-parse to extract text from digitally-generated PDFs
// For credit reports from IdentityIQ, SmartCredit, MyScoreIQ
// ==================================================================================

const pdfParse = require("pdf-parse");
const { logInfo, logError } = require("./logger");

/**
 * Extract text from a PDF buffer
 * @param {Buffer} buffer - PDF file buffer
 * @param {Object} options - Options
 * @param {number} options.maxPages - Maximum pages to extract (default: 50)
 * @returns {Promise<{ok: boolean, text: string, pages?: number, error?: string}>}
 */
async function extractText(buffer, options = {}) {
  try {
    const startTime = Date.now();

    // pdf-parse options
    const parseOptions = {
      max: options.maxPages || 50 // Limit pages for speed
    };

    const data = await pdfParse(buffer, parseOptions);

    // Normalize whitespace but preserve line breaks for structure
    const text = (data.text || "")
      .replace(/\r\n|\r/g, "\n") // Normalize line endings
      .replace(/[ \t]+/g, " ") // Collapse horizontal whitespace
      .replace(/\n{3,}/g, "\n\n") // Max 2 consecutive newlines
      .trim();

    const elapsed = Date.now() - startTime;

    logInfo("PDF text extracted", {
      pages: data.numpages,
      textLength: text.length,
      elapsed_ms: elapsed
    });

    return {
      ok: true,
      text,
      pages: data.numpages,
      info: data.info || {}
    };
  } catch (err) {
    logError("PDF text extraction failed", { error: err.message });
    return {
      ok: false,
      error: err.message,
      text: ""
    };
  }
}

module.exports = { extractText };
