// ============================================================================
// Google OCR Stub
// ----------------------------------------------------------------------------
// TODO: Wire up Google Cloud Vision PDF/Text detection here.
// TODO: Use an env var like GOOGLE_CLOUD_PROJECT/GOOGLE_APPLICATION_CREDENTIALS
//       when integrating the real client.
// ============================================================================

async function googleOCR(buffer) {
  // Placeholder response; no external call yet.
  return {
    ok: true,
    pages: [],
    note: "Google OCR not wired yet"
  };
}

module.exports = { googleOCR };
