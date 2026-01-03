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
 * Process a single page: convert to image and run OCR
 * @param {number} page - Page number (1-indexed)
 * @param {Function} converter - pdf2pic converter instance
 * @param {Object} client - Google Vision client
 * @returns {Promise<{page: number, text: string, ok: boolean}>}
 */
async function processPage(page, converter, client) {
  try {
    const img = await converter(page, { responseType: "buffer" });

    if (!img || !img.buffer) {
      return { page, text: "", ok: false, noPage: true };
    }

    const [result] = await client.documentTextDetection({
      image: { content: img.buffer.toString("base64") }
    });

    const text = result.fullTextAnnotation?.text || "";
    return { page, text, ok: true };
  } catch (err) {
    // Check if this is an "out of range" error (no more pages)
    if (
      err.message.includes("page") ||
      err.message.includes("range") ||
      err.message.includes("Invalid")
    ) {
      return { page, text: "", ok: false, noPage: true };
    }
    // Other errors - mark as failed but don't throw
    return { page, text: "", ok: false, error: err.message };
  }
}

/**
 * Run Google Cloud Vision OCR on a PDF buffer (parallelized)
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {Object} options - Options
 * @param {number} options.maxPages - Maximum pages to OCR (default: 25)
 * @returns {Promise<{ok: boolean, text: string, pages?: number, error?: string}>}
 */
async function googleOCR(pdfBuffer, options = {}) {
  const startTime = Date.now();
  const maxPages = options.maxPages || 25;

  try {
    // Step 1: Convert PDF pages to images
    const converter = fromBuffer(pdfBuffer, {
      density: 150, // DPI (balance quality vs size)
      format: "png",
      width: 1200,
      height: 1600
    });

    const client = createClient();

    logInfo("Starting Google OCR (parallel)", { maxPages });

    // Step 2: Process all pages in parallel
    const pagePromises = [];
    for (let page = 1; page <= maxPages; page++) {
      pagePromises.push(processPage(page, converter, client));
    }

    const results = await Promise.all(pagePromises);

    // Step 3: Filter successful results and sort by page number
    const successfulPages = results.filter(r => r.ok && r.text).sort((a, b) => a.page - b.page);

    // Log summary
    const failedCount = results.filter(r => !r.ok && !r.noPage).length;
    const lastValidPage =
      successfulPages.length > 0 ? successfulPages[successfulPages.length - 1].page : 0;

    if (failedCount > 0) {
      logInfo("Some pages failed OCR", { failedCount, totalPages: lastValidPage });
    }

    // Step 4: Combine text in page order
    const allText = successfulPages.map(r => r.text);
    const text = allText.join("\n\n");
    const elapsed = Date.now() - startTime;

    logInfo("Google OCR completed (parallel)", {
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
