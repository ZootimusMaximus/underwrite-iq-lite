// ============================================================================
// PDF Storage Service - Vercel Blob
// Uploads dispute letter PDFs and generates expiring signed URLs
// ============================================================================

// Load env vars from .env.local for local development (skip in test environment)
if (process.env.NODE_ENV !== "test") {
  require("dotenv").config({ path: ".env.local" });
}

const { put, del } = require("@vercel/blob");
const { logError, logWarn } = require("./logger");

// URL expiration: 72 hours (in seconds)
const URL_EXPIRATION_SECONDS = 72 * 60 * 60;

/**
 * Upload a PDF buffer to Vercel Blob storage
 * @param {Buffer} pdfBuffer - The PDF file as a buffer
 * @param {string} contactId - GHL contact ID for organizing files
 * @param {string} filename - Name of the file (e.g., "ex_round1.pdf")
 * @returns {Promise<{ok: boolean, url?: string, error?: string}>}
 */
async function uploadPdf(pdfBuffer, contactId, filename) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!token) {
    logWarn("BLOB_READ_WRITE_TOKEN not configured, skipping upload");
    return { ok: false, error: "Blob storage not configured" };
  }

  try {
    const pathname = `letters/${contactId}/${filename}`;

    // Add timeout wrapper (30s)
    const uploadPromise = put(pathname, pdfBuffer, {
      access: "public",
      contentType: "application/pdf",
      token
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Upload timeout after 30s")), 30000)
    );

    const blob = await Promise.race([uploadPromise, timeoutPromise]);

    return {
      ok: true,
      url: blob.url,
      pathname: blob.pathname
    };
  } catch (err) {
    logError("PDF upload failed", err, { contactId, filename });
    return { ok: false, error: err.message };
  }
}

/**
 * Upload multiple PDFs and return all URLs
 * @param {Array<{buffer: Buffer, filename: string}>} files - Array of PDF files
 * @param {string} contactId - GHL contact ID
 * @returns {Promise<{ok: boolean, urls?: Object, errors?: Array}>}
 */
async function uploadAllPdfs(files, contactId) {
  const results = await Promise.all(
    files.map(async file => {
      const result = await uploadPdf(file.buffer, contactId, file.filename);
      return {
        filename: file.filename,
        ...result
      };
    })
  );

  const urls = {};
  const errors = [];

  results.forEach(r => {
    if (r.ok) {
      // Map filename to URL
      // e.g., "ex_round1.pdf" -> urls.ex_round1 = "https://..."
      const key = r.filename.replace(".pdf", "");
      urls[key] = r.url;
    } else {
      errors.push({ filename: r.filename, error: r.error });
    }
  });

  return {
    ok: errors.length === 0,
    urls,
    errors: errors.length > 0 ? errors : undefined,
    uploadedCount: Object.keys(urls).length,
    failedCount: errors.length
  };
}

/**
 * Delete a PDF from storage
 * @param {string} url - The blob URL to delete
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function deletePdf(url) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!token) {
    return { ok: false, error: "Blob storage not configured" };
  }

  try {
    await del(url, { token });
    return { ok: true };
  } catch (err) {
    logError("PDF deletion failed", err, { url });
    return { ok: false, error: err.message };
  }
}

/**
 * Map uploaded URLs to GHL custom field names
 * Uses new GHL field names (Dec 2025 update)
 * @param {Object} urls - Object with filename keys and URL values
 * @param {string} path - "repair" or "fundable"
 * @returns {Object} - Object with GHL field names as keys
 */
function mapUrlsToGhlFields(urls, path) {
  const fields = {};

  if (path === "repair") {
    // Repair path - Personal info dispute letters
    if (urls.personal_info_ex) fields.repair_letter_personal_info_ex = urls.personal_info_ex;
    if (urls.personal_info_eq) fields.repair_letter_personal_info_eq = urls.personal_info_eq;
    if (urls.personal_info_tu) fields.repair_letter_personal_info_tu = urls.personal_info_tu;

    // Repair path - Round dispute letters
    if (urls.ex_round1) fields.repair_letter_round_1_ex = urls.ex_round1;
    if (urls.eq_round1) fields.repair_letter_round_1_eq = urls.eq_round1;
    if (urls.tu_round1) fields.repair_letter_round_1_tu = urls.tu_round1;

    if (urls.ex_round2) fields.repair_letter_round_2_ex = urls.ex_round2;
    if (urls.eq_round2) fields.repair_letter_round_2_eq = urls.eq_round2;
    if (urls.tu_round2) fields.repair_letter_round_2_tu = urls.tu_round2;

    if (urls.ex_round3) fields.repair_letter_round_3_ex = urls.ex_round3;
    if (urls.eq_round3) fields.repair_letter_round_3_eq = urls.eq_round3;
    if (urls.tu_round3) fields.repair_letter_round_3_tu = urls.tu_round3;
  } else {
    // Funding path - Personal info cleanup letters
    if (urls.personal_info_ex) fields.funding_letter_personal_info_ex = urls.personal_info_ex;
    if (urls.personal_info_eq) fields.funding_letter_personal_info_eq = urls.personal_info_eq;
    if (urls.personal_info_tu) fields.funding_letter_personal_info_tu = urls.personal_info_tu;

    // Funding path - Inquiry cleanup letters
    if (urls.inquiry_ex) fields.funding_letter_inquiry_ex = urls.inquiry_ex;
    if (urls.inquiry_eq) fields.funding_letter_inquiry_eq = urls.inquiry_eq;
    if (urls.inquiry_tu) fields.funding_letter_inquiry_tu = urls.inquiry_tu;
  }

  // State flags
  fields.analyzer_path = path;
  fields.letters_ready = "true";
  fields.analyzer_status = "complete";

  return fields;
}

/**
 * Download a PDF from a URL (Vercel Blob or any public URL)
 * @param {string} url - The URL to download from
 * @returns {Promise<Buffer>} The file contents as a buffer
 */
async function downloadBlob(url) {
  if (!url) {
    throw new Error("No URL provided for download");
  }

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    logError("Blob download failed", err, { url });
    throw err;
  }
}

/**
 * Delete a blob by URL (alias for deletePdf with better naming)
 * @param {string} url - The blob URL to delete
 * @returns {Promise<void>}
 */
async function deleteBlob(url) {
  const result = await deletePdf(url);
  if (!result.ok) {
    logWarn("Blob deletion failed", { url, error: result.error });
  }
}

module.exports = {
  uploadPdf,
  uploadAllPdfs,
  deletePdf,
  deleteBlob,
  downloadBlob,
  mapUrlsToGhlFields,
  URL_EXPIRATION_SECONDS
};
