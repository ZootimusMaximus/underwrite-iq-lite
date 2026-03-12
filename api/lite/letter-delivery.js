// ============================================================================
// Letter Delivery Service
// Orchestrates: Generate Letters → Upload to Storage → Update GHL
// ============================================================================

const { generateLetters } = require("./letter-generator");
const { uploadAllPdfs } = require("./storage");
const { updateLetterUrls, createOrUpdateContact } = require("./ghl-contact-service");
const { logInfo, logError, logWarn } = require("./logger");
const { generateAllSummaryDocuments } = require("./crs/summary-doc-generator");

/**
 * Full letter delivery pipeline
 * 1. Generate all dispute letter PDFs based on path
 * 2. Upload PDFs to Vercel Blob storage
 * 3. Update GHL contact with letter URLs
 *
 * Supports two modes:
 * - Legacy (PDF-upload): bureaus + underwrite → generateLetters()
 * - CRS: crsDocuments.letters[] specs → generateLettersFromCRS()
 *
 * @param {Object} params
 * @param {string} params.contactId - GHL contact ID (if already exists)
 * @param {Object} params.contactData - Contact data for creating/updating contact
 * @param {Object} params.bureaus - Parsed bureau data from analyzer (legacy path)
 * @param {Object} params.underwrite - Underwriting results
 * @param {Object} params.personal - Personal info (name, address, etc.)
 * @param {Object} [params.crsDocuments] - CRS document specs from build-documents.js
 * @param {Object} [params.crsResult] - Full CRS engine result (for summary doc generation)
 * @returns {Promise<Object>} Result with status and URLs
 */
async function deliverLetters({
  contactId,
  contactData,
  bureaus,
  underwrite,
  personal,
  crsDocuments,
  crsResult
}) {
  const startTime = Date.now();
  const isCRS = !!crsDocuments?.letters?.length;
  const path = isCRS
    ? crsDocuments.package === "funding"
      ? "fundable"
      : crsDocuments.package || "repair"
    : underwrite?.fundable
      ? "fundable"
      : "repair";

  logInfo("Letter delivery started", {
    path,
    mode: isCRS ? "crs" : "legacy",
    hasContactId: !!contactId,
    letterCount: isCRS ? crsDocuments.letters.length : undefined
  });

  try {
    // Step 1: Ensure we have a contact ID
    let finalContactId = contactId;

    if (!finalContactId && contactData?.email) {
      logInfo("Creating/updating GHL contact for letter delivery");
      const contactResult = await createOrUpdateContact(contactData);

      if (contactResult.ok) {
        finalContactId = contactResult.contactId;
      } else {
        logWarn("Could not create GHL contact, continuing without GHL sync", {
          error: contactResult.error
        });
      }
    }

    // Step 2: Generate letters
    let letters;
    let fieldKeyMap = null; // CRS: maps filename → GHL field key

    if (isCRS) {
      logInfo("Generating CRS letters", { specs: crsDocuments.letters.length });
      const crsResult = await generateLettersFromCRS(crsDocuments.letters, personal || {});
      letters = crsResult.letters;
      fieldKeyMap = crsResult.fieldKeyMap;
    } else {
      logInfo("Generating letters", { path });
      letters = await generateLetters({
        path,
        bureaus: bureaus || {},
        personal: personal || {},
        underwrite: underwrite || {}
      });
    }

    logInfo("Letters generated", { count: letters.length });

    // Step 2b: Generate summary documents (CRS path only)
    let summaryDocs = [];
    if (isCRS && crsDocuments.summaryDocuments?.length > 0 && crsResult) {
      try {
        summaryDocs = await generateAllSummaryDocuments(
          crsDocuments.summaryDocuments,
          crsResult,
          personal
        );
        logInfo("Summary documents generated", { count: summaryDocs.length });
        // Add summary docs to the upload list
        letters.push(...summaryDocs);
      } catch (err) {
        logWarn("Summary document generation failed", { error: err.message });
      }
    }

    // Step 3: Upload to storage
    logInfo("Uploading letters to storage");

    // Use contact ID or generate a temporary ID for storage
    const storageId = finalContactId || `temp_${Date.now()}`;

    const uploadResult = await uploadAllPdfs(letters, storageId);

    if (!uploadResult.ok) {
      logError("Some letters failed to upload", null, {
        errors: uploadResult.errors
      });
    }

    logInfo("Letters uploaded", {
      uploaded: uploadResult.uploadedCount,
      failed: uploadResult.failedCount
    });

    // Step 4: Update GHL with letter URLs
    let ghlUpdateResult = { ok: false, skipped: true };

    if (finalContactId && uploadResult.urls) {
      logInfo("Updating GHL with letter URLs", { contactId: finalContactId });

      if (isCRS && fieldKeyMap) {
        // CRS path: map uploaded URLs using fieldKey from document specs
        ghlUpdateResult = await updateLetterUrlsFromCRS(
          finalContactId,
          uploadResult.urls,
          fieldKeyMap,
          path
        );
      } else {
        ghlUpdateResult = await updateLetterUrls(finalContactId, uploadResult.urls, path);
      }

      if (ghlUpdateResult.ok) {
        logInfo("GHL updated with letter URLs", {
          contactId: finalContactId,
          updatedFields: ghlUpdateResult.updatedFields
        });
      } else {
        logWarn("GHL update failed", { error: ghlUpdateResult.error });
      }
    } else if (!finalContactId) {
      logWarn("No contact ID available, skipping GHL update");
    }

    const duration = Date.now() - startTime;

    logInfo("Letter delivery complete", { duration });

    return {
      ok: true,
      path,
      contactId: finalContactId,
      letters: {
        generated: letters.length,
        uploaded: uploadResult.uploadedCount,
        failed: uploadResult.failedCount
      },
      urls: uploadResult.urls,
      ghlUpdated: ghlUpdateResult.ok,
      ghlSkipped: ghlUpdateResult.skipped,
      duration
    };
  } catch (err) {
    logError("Letter delivery failed", err);

    return {
      ok: false,
      error: err.message,
      path,
      duration: Date.now() - startTime
    };
  }
}

// ---------------------------------------------------------------------------
// CRS-specific letter generation
// ---------------------------------------------------------------------------

/**
 * Generate letters from CRS document specs.
 * Uses existing PDF generators but driven by CRS letter specs instead of raw bureau data.
 *
 * @param {Array<{type, bureau, round, fieldKey}>} letterSpecs - From buildDocuments()
 * @param {Object} personal - { name, address }
 * @returns {Promise<{ letters: Array<{filename, buffer}>, fieldKeyMap: Object }>}
 */
async function generateLettersFromCRS(letterSpecs, personal) {
  const { BUREAUS } = require("./letter-generator");

  const letters = [];
  const fieldKeyMap = {}; // filename (no .pdf) → GHL field key

  // Group specs by type for efficient generation
  const disputeSpecs = letterSpecs.filter(s => s.type === "dispute");
  const inquirySpecs = letterSpecs.filter(s => s.type === "inquiry_removal");
  const personalSpecs = letterSpecs.filter(s => s.type === "personal_info");

  // Generate dispute letters (repair path)
  for (const spec of disputeSpecs) {
    const bureauKey = spec.bureau;
    const bureauInfo = BUREAUS[bureauKey];
    if (!bureauInfo) continue;

    const filename = `${bureauInfo.prefix}_round${spec.round}.pdf`;
    const buffer = await createCRSDisputeLetter({
      bureau: bureauInfo,
      personal,
      round: spec.round
    });
    letters.push({ filename, buffer });
    fieldKeyMap[filename.replace(".pdf", "")] = spec.fieldKey;
  }

  // Generate inquiry removal letters (funding path)
  for (const spec of inquirySpecs) {
    const bureauKey = spec.bureau;
    const bureauInfo = BUREAUS[bureauKey];
    if (!bureauInfo) continue;

    const filename = `inquiry_${bureauInfo.prefix}.pdf`;
    const buffer = await createCRSInquiryLetter({ bureau: bureauInfo, personal });
    letters.push({ filename, buffer });
    fieldKeyMap[filename.replace(".pdf", "")] = spec.fieldKey;
  }

  // Generate personal info letters
  for (const spec of personalSpecs) {
    const bureauKey = spec.bureau;
    const bureauInfo = BUREAUS[bureauKey];
    if (!bureauInfo) continue;

    const filename = `personal_info_${bureauInfo.prefix}.pdf`;
    const buffer = await createCRSPersonalInfoLetter({ bureau: bureauInfo, personal });
    letters.push({ filename, buffer });
    fieldKeyMap[filename.replace(".pdf", "")] = spec.fieldKey;
  }

  return { letters, fieldKeyMap };
}

/**
 * Create a CRS dispute letter PDF (uses same format as legacy, but without parsed bureau data).
 */
async function createCRSDisputeLetter({ bureau, personal, round }) {
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const leftMargin = 50;
  const lineHeight = 14;
  const name = personal?.name || "[CONSUMER NAME]";
  const address = personal?.address || "[CONSUMER ADDRESS]";

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  page.drawText(today, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;
  page.drawText(name, { x: leftMargin, y, size: 11, font });
  y -= lineHeight;
  page.drawText(address, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;
  page.drawText(bureau.name, { x: leftMargin, y, size: 11, font: boldFont });
  y -= lineHeight;
  for (const line of bureau.address.split("\n")) {
    page.drawText(line, { x: leftMargin, y, size: 11, font });
    y -= lineHeight;
  }
  y -= lineHeight;
  page.drawText(`Re: Dispute of Inaccurate Information - Round ${round}`, {
    x: leftMargin,
    y,
    size: 12,
    font: boldFont
  });
  y -= lineHeight * 2;

  const body = [
    "To Whom It May Concern:",
    "",
    "I am writing to dispute inaccurate information appearing on my credit report. Under the Fair Credit Reporting Act (FCRA), I have the right to dispute incomplete or inaccurate information.",
    "",
    "I am requesting that you investigate all accounts on my credit file that contain inaccurate, incomplete, or unverifiable information and remove or correct them within 30 days as required by the FCRA.",
    "",
    "Please send me written notification of the results of your investigation.",
    "",
    "Sincerely,",
    "",
    name
  ];

  for (const line of body) {
    if (line === "") {
      y -= lineHeight;
      continue;
    }
    page.drawText(line, { x: leftMargin, y, size: 11, font });
    y -= lineHeight;
  }

  return Buffer.from(await pdfDoc.save());
}

/**
 * Create a CRS inquiry removal letter PDF.
 */
async function createCRSInquiryLetter({ bureau, personal }) {
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const leftMargin = 50;
  const lineHeight = 14;
  const name = personal?.name || "[CONSUMER NAME]";
  const address = personal?.address || "[CONSUMER ADDRESS]";

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  page.drawText(today, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;
  page.drawText(name, { x: leftMargin, y, size: 11, font });
  y -= lineHeight;
  page.drawText(address, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;
  page.drawText(bureau.name, { x: leftMargin, y, size: 11, font: boldFont });
  y -= lineHeight;
  for (const line of bureau.address.split("\n")) {
    page.drawText(line, { x: leftMargin, y, size: 11, font });
    y -= lineHeight;
  }
  y -= lineHeight;
  page.drawText("Re: Inquiry Removal Request", { x: leftMargin, y, size: 12, font: boldFont });
  y -= lineHeight * 2;

  const body = [
    "To Whom It May Concern:",
    "",
    `I am writing to request the removal of unauthorized inquiries from my ${bureau.name} credit report. Under the FCRA, inquiries made without my consent or permissible purpose should be removed.`,
    "",
    "Please investigate and remove any unauthorized inquiries within 30 days as required by the FCRA.",
    "",
    "Sincerely,",
    "",
    name
  ];

  for (const line of body) {
    if (line === "") {
      y -= lineHeight;
      continue;
    }
    page.drawText(line, { x: leftMargin, y, size: 11, font });
    y -= lineHeight;
  }

  return Buffer.from(await pdfDoc.save());
}

/**
 * Create a CRS personal info dispute letter PDF.
 */
async function createCRSPersonalInfoLetter({ bureau, personal }) {
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const leftMargin = 50;
  const lineHeight = 14;
  const name = personal?.name || "[CONSUMER NAME]";
  const address = personal?.address || "[CONSUMER ADDRESS]";

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  page.drawText(today, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;
  page.drawText(name, { x: leftMargin, y, size: 11, font });
  y -= lineHeight;
  page.drawText(address, { x: leftMargin, y, size: 11, font });
  y -= lineHeight * 2;
  page.drawText(bureau.name, { x: leftMargin, y, size: 11, font: boldFont });
  y -= lineHeight;
  for (const line of bureau.address.split("\n")) {
    page.drawText(line, { x: leftMargin, y, size: 11, font });
    y -= lineHeight;
  }
  y -= lineHeight;
  page.drawText("Re: Personal Information Correction Request", {
    x: leftMargin,
    y,
    size: 12,
    font: boldFont
  });
  y -= lineHeight * 2;

  const body = [
    "To Whom It May Concern:",
    "",
    `I am writing to request correction of inaccurate personal information on my ${bureau.name} credit file.`,
    "",
    "Please update my file to reflect only my correct personal information and remove any outdated or inaccurate variations within 30 days as required by the FCRA.",
    "",
    "Sincerely,",
    "",
    name
  ];

  for (const line of body) {
    if (line === "") {
      y -= lineHeight;
      continue;
    }
    page.drawText(line, { x: leftMargin, y, size: 11, font });
    y -= lineHeight;
  }

  return Buffer.from(await pdfDoc.save());
}

/**
 * Update GHL with letter URLs using CRS fieldKey mapping.
 *
 * @param {string} contactId - GHL contact ID
 * @param {Object} urls - { filename_key: url }
 * @param {Object} fieldKeyMap - { filename_key: ghl_field_name }
 * @param {string} path - "fundable" or "repair"
 */
async function updateLetterUrlsFromCRS(contactId, urls, fieldKeyMap, path) {
  const fields = {};
  for (const [fileKey, url] of Object.entries(urls)) {
    const ghlField = fieldKeyMap[fileKey];
    if (ghlField) {
      fields[ghlField] = url;
    }
  }
  fields.analyzer_path = path === "fundable" ? "funding" : path;
  fields.letters_ready = "true";
  fields.analyzer_status = "complete";

  return updateLetterUrls(contactId, fields, null);
}

/**
 * Fire-and-forget version for non-blocking delivery
 * Returns immediately, processes in background
 */
function deliverLettersAsync(params) {
  // Don't await - let it run in background
  deliverLetters(params)
    .then(result => {
      if (result.ok) {
        logInfo("Async letter delivery completed", {
          path: result.path,
          letters: result.letters,
          ghlUpdated: result.ghlUpdated
        });
      } else {
        logError("Async letter delivery failed", new Error(result.error));
      }
    })
    .catch(err => {
      logError("Async letter delivery exception", err);
    });

  return { ok: true, async: true, message: "Letter delivery started in background" };
}

module.exports = {
  deliverLetters,
  deliverLettersAsync,
  generateLettersFromCRS
};
