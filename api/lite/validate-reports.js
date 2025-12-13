// ============================================================================
// validate-reports.js  (Stage 1 — Pre-Parse Structural Validator)
// ----------------------------------------------------------------------------
// This module validates uploaded PDFs BEFORE calling GPT-4.1 Vision.
// It does NOT inspect PDF contents. That happens AFTER parse-report.
//
// RESPONSIBILITIES:
//   ✔ Ensure files exist
//   ✔ Enforce max count rules
//   ✔ Enforce file size > minimum threshold
//   ✔ Enforce MIME type is PDF
//   ✔ Detect duplicates by hashing
//   ✔ Enforce tri-merge count rules (but NOT bureau identity)
//   ✔ Produce clear error messages
//
// NOT RESPONSIBLE FOR:
//   ✖ Determining bureau (EX/EQ/TU)
//   ✖ Detecting tri-merge content
//   ✖ Detecting duplicate-bureau uploads
//   ✖ Any GPT calls
//
// Switchboard will run Stage 2 after parse-report.
// ============================================================================

const fs = require("fs");
const crypto = require("crypto");

// Minimum realistic credit report size (40–50 KB). Prevents trash uploads.
const MIN_PDF_BYTES = 40 * 1024;

// Max number of allowed PDFs (1 tri-merge OR up to 3 single reports)
const MAX_FILES = 3;

// ----------------------------------------------------------------------------
// Hash a file buffer to detect EXACT duplicates
// ----------------------------------------------------------------------------
function hashBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// ----------------------------------------------------------------------------
// LEGIT MIME TYPES (frontends sometimes send octet-stream for PDFs)
// ----------------------------------------------------------------------------
function isProbablyPDF(file) {
  if (!file.mimetype) return false;
  return (
    file.mimetype === "application/pdf" ||
    file.mimetype === "application/octet-stream"
  );
}

// ----------------------------------------------------------------------------
// PDF MAGIC BYTE VALIDATION
// Check for "%PDF-" header (PDF specification requirement)
// Prevents wasted API calls on non-PDF files
// ----------------------------------------------------------------------------
function hasValidPDFHeader(buf) {
  if (!buf || buf.length < 5) return false;
  const header = buf.slice(0, 5).toString("ascii");
  return header === "%PDF-";
}

// ----------------------------------------------------------------------------
// MAIN VALIDATOR
// ----------------------------------------------------------------------------
async function validateReports(files) {
  try {
    // ——————————————————————————————————————————
    // 0) Normalize to array
    // ——————————————————————————————————————————
    let list = [];
    if (Array.isArray(files)) list = files;
    else if (files) list = [files];

    // ——————————————————————————————————————————
    // 1) Ensure files exist
    // ——————————————————————————————————————————
    if (list.length === 0) {
      return {
        ok: false,
        reason: "No files uploaded. Please upload 1–3 credit report PDFs."
      };
    }

    // ——————————————————————————————————————————
    // 2) Enforce max file count BEFORE parsing
    // ——————————————————————————————————————————
    if (list.length > MAX_FILES) {
      return {
        ok: false,
        reason: `Too many files. Upload up to ${MAX_FILES} PDFs only.`
      };
    }

    // ——————————————————————————————————————————
    // 3) Validate PDF structure (size, mime)
    // ——————————————————————————————————————————
    const fileSummaries = [];

    for (const f of list) {
      if (!isProbablyPDF(f)) {
        return {
          ok: false,
          reason: "One of the uploaded files is not a PDF. Only PDF credit reports are accepted."
        };
      }

      const buf = await fs.promises.readFile(f.filepath);

      // Validate PDF magic bytes
      if (!hasValidPDFHeader(buf)) {
        return {
          ok: false,
          reason: "One of the uploaded files is not a valid PDF. The file header is missing or corrupted."
        };
      }

      if (!buf || buf.length < MIN_PDF_BYTES) {
        return {
          ok: false,
          reason:
            "One of the PDFs appears incomplete or corrupted. Full credit reports are typically 200KB–2MB."
        };
      }

      fileSummaries.push({
        filename: f.originalFilename || "file.pdf",
        size: buf.length,
        hash: hashBuffer(buf)
      });
    }

    // ——————————————————————————————————————————
    // 4) Detect exact duplicate files by SHA-256 hash
    // ——————————————————————————————————————————
    const seen = new Set();
    for (const f of fileSummaries) {
      if (seen.has(f.hash)) {
        return {
          ok: false,
          reason:
            `Duplicate file detected (“${f.filename}”). Please upload distinct reports only.`
        };
      }
      seen.add(f.hash);
    }

    // ——————————————————————————————————————————
    // 5) Tri-merge count rule (content unknown pre-parse)
    //    Here we can only enforce:
    //      - If user uploads >1 file, none can be “too large” (tri-merge clue)
    //      - True bureau detection is Stage 2 (post-parse)
    // ——————————————————————————————————————————
    if (list.length > 1) {
      // A hint-based check — tri-merge PDFs are usually > 1MB.
      const possibleTriMerge = fileSummaries.filter(f => f.size > 1.2 * 1024 * 1024);
      if (possibleTriMerge.length > 0) {
        return {
          ok: false,
          reason:
            "A tri-merge report appears to be included. A tri-merge must be uploaded alone, not with other files."
        };
      }
    }

    // ——————————————————————————————————————————
    // All preliminary validation passed
    // ——————————————————————————————————————————
    return {
      ok: true,
      files: list,
      fileSummaries
    };
  } catch (err) {
    console.error("validateReports ERROR:", err);
    return {
      ok: false,
      reason: "Unexpected error during validation."
    };
  }
}

module.exports = {
  validateReports,
  hasValidPDFHeader
};
