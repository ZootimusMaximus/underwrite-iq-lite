// ============================================================================
// Google Cloud Vision OCR for Scanned PDFs
// ----------------------------------------------------------------------------
// Converts PDF pages to images using pdf2pic, then runs OCR on each page
// using Google Cloud Vision's documentTextDetection API.
//
// Env vars needed:
//   - GOOGLE_PROJECT_ID
//   - GOOGLE_CLIENT_EMAIL
//   - GOOGLE_PRIVATE_KEY
// ============================================================================

const vision = require("@google-cloud/vision");
const { fromBuffer } = require("pdf2pic");
const { logInfo, logError } = require("./logger");

/**
 * Create Google Cloud Vision client from env vars
 */
function createClient() {
  const projectId = process.env.GOOGLE_PROJECT_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Google Cloud credentials (GOOGLE_PROJECT_ID, GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY)"
    );
  }

  const credentials = {
    project_id: projectId,
    client_email: clientEmail,
    private_key: privateKey
  };

  return new vision.ImageAnnotatorClient({ credentials });
}

/**
 * Run Google Cloud Vision OCR on a PDF buffer
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {Object} options - Options
 * @param {number} options.maxPages - Maximum pages to OCR (default: 10)
 * @returns {Promise<{ok: boolean, text: string, pages?: number, error?: string}>}
 */
async function googleOCR(pdfBuffer, options = {}) {
  const startTime = Date.now();
  const maxPages = options.maxPages || 10;

  try {
    // Step 1: Convert PDF pages to images
    const converter = fromBuffer(pdfBuffer, {
      density: 150, // DPI (balance quality vs size)
      format: "png",
      width: 1200,
      height: 1600
    });

    const allText = [];
    const client = createClient();

    logInfo("Starting Google OCR", { maxPages });

    // Step 2: OCR each page
    for (let page = 1; page <= maxPages; page++) {
      try {
        const img = await converter(page, { responseType: "buffer" });

        if (!img || !img.buffer) {
          logInfo("No more pages in PDF", { lastPage: page - 1 });
          break;
        }

        const [result] = await client.documentTextDetection({
          image: { content: img.buffer.toString("base64") }
        });

        const pageText = result.fullTextAnnotation?.text || "";

        if (pageText) {
          allText.push(pageText);
          logInfo("OCR page complete", { page, textLength: pageText.length });
        }
      } catch (pageErr) {
        // Stop if we've exceeded the page count
        if (
          pageErr.message.includes("page") ||
          pageErr.message.includes("range") ||
          pageErr.message.includes("Invalid")
        ) {
          logInfo("Reached end of PDF", { lastPage: page - 1 });
          break;
        }
        // Re-throw other errors
        throw pageErr;
      }
    }

    const text = allText.join("\n\n");
    const elapsed = Date.now() - startTime;

    logInfo("Google OCR completed", {
      pages: allText.length,
      textLength: text.length,
      elapsed_ms: elapsed
    });

    return {
      ok: true,
      text,
      pages: allText.length
    };
  } catch (err) {
    logError("Google OCR failed", { error: err.message });
    return {
      ok: false,
      error: err.message,
      text: ""
    };
  }
}

/**
 * Check if Google OCR is available (credentials configured)
 */
function isGoogleOCRAvailable() {
  return !!(
    process.env.GOOGLE_PROJECT_ID &&
    process.env.GOOGLE_CLIENT_EMAIL &&
    process.env.GOOGLE_PRIVATE_KEY
  );
}

module.exports = { googleOCR, isGoogleOCRAvailable };
