// ============================================================================
// Letter Delivery Service
// Orchestrates: Generate Letters → Upload to Storage → Update GHL
// ============================================================================

const { generateLetters } = require("./letter-generator");
const { uploadAllPdfs } = require("./storage");
const { updateLetterUrls, createOrUpdateContact } = require("./ghl-contact-service");
const { logInfo, logError, logWarn } = require("./logger");

/**
 * Full letter delivery pipeline
 * 1. Generate all dispute letter PDFs based on path
 * 2. Upload PDFs to Vercel Blob storage
 * 3. Update GHL contact with letter URLs
 *
 * @param {Object} params
 * @param {string} params.contactId - GHL contact ID (if already exists)
 * @param {Object} params.contactData - Contact data for creating/updating contact
 * @param {Object} params.bureaus - Parsed bureau data from analyzer
 * @param {Object} params.underwrite - Underwriting results
 * @param {Object} params.personal - Personal info (name, address, etc.)
 * @returns {Promise<Object>} Result with status and URLs
 */
async function deliverLetters({ contactId, contactData, bureaus, underwrite, personal }) {
  const startTime = Date.now();
  const path = underwrite?.fundable ? "fundable" : "repair";

  logInfo("Letter delivery started", {
    path,
    hasContactId: !!contactId,
    hasBureaus: !!bureaus
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
    logInfo("Generating letters", { path });

    const letters = await generateLetters({
      path,
      bureaus: bureaus || {},
      personal: personal || {},
      underwrite: underwrite || {}
    });

    logInfo("Letters generated", { count: letters.length });

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

      ghlUpdateResult = await updateLetterUrls(finalContactId, uploadResult.urls, path);

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
  deliverLettersAsync
};
