const test = require("node:test");
const assert = require("node:assert/strict");

const { mapUrlsToGhlFields, URL_EXPIRATION_SECONDS } = require("../storage");

// ============================================================================
// URL_EXPIRATION_SECONDS tests
// ============================================================================
test("URL_EXPIRATION_SECONDS is 72 hours in seconds", () => {
  assert.equal(URL_EXPIRATION_SECONDS, 72 * 60 * 60);
  assert.equal(URL_EXPIRATION_SECONDS, 259200);
});

// ============================================================================
// mapUrlsToGhlFields tests - Repair path (Dec 2025 field names)
// ============================================================================
test("mapUrlsToGhlFields maps all repair path URLs correctly", () => {
  const urls = {
    ex_round1: "https://blob.vercel.com/ex1.pdf",
    ex_round2: "https://blob.vercel.com/ex2.pdf",
    ex_round3: "https://blob.vercel.com/ex3.pdf",
    eq_round1: "https://blob.vercel.com/eq1.pdf",
    eq_round2: "https://blob.vercel.com/eq2.pdf",
    eq_round3: "https://blob.vercel.com/eq3.pdf",
    tu_round1: "https://blob.vercel.com/tu1.pdf",
    tu_round2: "https://blob.vercel.com/tu2.pdf",
    tu_round3: "https://blob.vercel.com/tu3.pdf",
    personal_info_ex: "https://blob.vercel.com/pi_ex.pdf",
    personal_info_eq: "https://blob.vercel.com/pi_eq.pdf",
    personal_info_tu: "https://blob.vercel.com/pi_tu.pdf"
  };

  const result = mapUrlsToGhlFields(urls, "repair");

  // Check all Experian round fields
  assert.equal(result.repair_letter_round_1_ex, "https://blob.vercel.com/ex1.pdf");
  assert.equal(result.repair_letter_round_2_ex, "https://blob.vercel.com/ex2.pdf");
  assert.equal(result.repair_letter_round_3_ex, "https://blob.vercel.com/ex3.pdf");

  // Check all Equifax round fields
  assert.equal(result.repair_letter_round_1_eq, "https://blob.vercel.com/eq1.pdf");
  assert.equal(result.repair_letter_round_2_eq, "https://blob.vercel.com/eq2.pdf");
  assert.equal(result.repair_letter_round_3_eq, "https://blob.vercel.com/eq3.pdf");

  // Check all TransUnion round fields
  assert.equal(result.repair_letter_round_1_tu, "https://blob.vercel.com/tu1.pdf");
  assert.equal(result.repair_letter_round_2_tu, "https://blob.vercel.com/tu2.pdf");
  assert.equal(result.repair_letter_round_3_tu, "https://blob.vercel.com/tu3.pdf");

  // Check personal info fields (one per bureau)
  assert.equal(result.repair_letter_personal_info_ex, "https://blob.vercel.com/pi_ex.pdf");
  assert.equal(result.repair_letter_personal_info_eq, "https://blob.vercel.com/pi_eq.pdf");
  assert.equal(result.repair_letter_personal_info_tu, "https://blob.vercel.com/pi_tu.pdf");

  // Check state flags
  assert.equal(result.analyzer_path, "repair");
  assert.equal(result.letters_ready, "true");
  assert.equal(result.analyzer_status, "complete");
});

// ============================================================================
// mapUrlsToGhlFields tests - Fundable path (Dec 2025 field names)
// ============================================================================
test("mapUrlsToGhlFields maps fundable path URLs correctly", () => {
  const urls = {
    personal_info_ex: "https://blob.vercel.com/pi_ex.pdf",
    personal_info_eq: "https://blob.vercel.com/pi_eq.pdf",
    personal_info_tu: "https://blob.vercel.com/pi_tu.pdf",
    inquiry_ex: "https://blob.vercel.com/inq_ex.pdf",
    inquiry_eq: "https://blob.vercel.com/inq_eq.pdf",
    inquiry_tu: "https://blob.vercel.com/inq_tu.pdf"
  };

  const result = mapUrlsToGhlFields(urls, "fundable");

  // Check personal info fields (one per bureau)
  assert.equal(result.funding_letter_personal_info_ex, "https://blob.vercel.com/pi_ex.pdf");
  assert.equal(result.funding_letter_personal_info_eq, "https://blob.vercel.com/pi_eq.pdf");
  assert.equal(result.funding_letter_personal_info_tu, "https://blob.vercel.com/pi_tu.pdf");

  // Check inquiry fields (one per bureau)
  assert.equal(result.funding_letter_inquiry_ex, "https://blob.vercel.com/inq_ex.pdf");
  assert.equal(result.funding_letter_inquiry_eq, "https://blob.vercel.com/inq_eq.pdf");
  assert.equal(result.funding_letter_inquiry_tu, "https://blob.vercel.com/inq_tu.pdf");

  // Check state flags
  assert.equal(result.analyzer_path, "fundable");
  assert.equal(result.letters_ready, "true");
  assert.equal(result.analyzer_status, "complete");
});

// ============================================================================
// mapUrlsToGhlFields tests - Edge cases
// ============================================================================
test("mapUrlsToGhlFields handles empty URLs object", () => {
  const result = mapUrlsToGhlFields({}, "repair");

  assert.equal(result.analyzer_path, "repair");
  assert.equal(result.letters_ready, "true");
  // No URL fields should be set
  assert.equal(result.repair_letter_round_1_ex, undefined);
  assert.equal(result.repair_letter_round_1_tu, undefined);
  assert.equal(result.repair_letter_round_1_eq, undefined);
});

test("mapUrlsToGhlFields only includes provided URLs", () => {
  const urls = {
    ex_round1: "https://blob.vercel.com/ex1.pdf"
  };

  const result = mapUrlsToGhlFields(urls, "repair");

  assert.equal(result.repair_letter_round_1_ex, "https://blob.vercel.com/ex1.pdf");
  assert.equal(result.repair_letter_round_2_ex, undefined);
  assert.equal(result.repair_letter_round_3_ex, undefined);
  assert.equal(result.repair_letter_round_1_tu, undefined);
});

test("mapUrlsToGhlFields sets path to fundable", () => {
  const result = mapUrlsToGhlFields({}, "fundable");
  assert.equal(result.analyzer_path, "fundable");
});

test("mapUrlsToGhlFields always sets letters_ready to true", () => {
  const result1 = mapUrlsToGhlFields({}, "repair");
  const result2 = mapUrlsToGhlFields({}, "fundable");

  assert.equal(result1.letters_ready, "true");
  assert.equal(result2.letters_ready, "true");
});

test("mapUrlsToGhlFields handles partial repair path URLs", () => {
  const urls = {
    ex_round1: "https://blob.vercel.com/ex1.pdf",
    tu_round2: "https://blob.vercel.com/tu2.pdf",
    eq_round3: "https://blob.vercel.com/eq3.pdf"
  };

  const result = mapUrlsToGhlFields(urls, "repair");

  assert.equal(result.repair_letter_round_1_ex, "https://blob.vercel.com/ex1.pdf");
  assert.equal(result.repair_letter_round_2_ex, undefined);
  assert.equal(result.repair_letter_round_1_tu, undefined);
  assert.equal(result.repair_letter_round_2_tu, "https://blob.vercel.com/tu2.pdf");
  assert.equal(result.repair_letter_round_3_eq, "https://blob.vercel.com/eq3.pdf");
});

// ============================================================================
// uploadPdf tests - No token configured
// ============================================================================
test("uploadPdf returns error when token not configured", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  // Re-require to get fresh module
  delete require.cache[require.resolve("../storage")];
  const { uploadPdf } = require("../storage");

  const result = await uploadPdf(Buffer.from("test"), "contact123", "test.pdf");

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.ok, false);
  assert.equal(result.error, "Blob storage not configured");
});

// ============================================================================
// deletePdf tests - No token configured
// ============================================================================
test("deletePdf returns error when token not configured", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  delete require.cache[require.resolve("../storage")];
  const { deletePdf } = require("../storage");

  const result = await deletePdf("https://blob.vercel.com/test.pdf");

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.ok, false);
  assert.equal(result.error, "Blob storage not configured");
});

// ============================================================================
// uploadAllPdfs tests - No token configured
// ============================================================================
test("uploadAllPdfs returns all failures when token missing", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  delete require.cache[require.resolve("../storage")];
  const { uploadAllPdfs } = require("../storage");

  const files = [
    { buffer: Buffer.from("pdf1"), filename: "ex_round1.pdf" },
    { buffer: Buffer.from("pdf2"), filename: "tu_round1.pdf" }
  ];

  const result = await uploadAllPdfs(files, "contact123");

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.ok, false);
  assert.equal(result.uploadedCount, 0);
  assert.equal(result.failedCount, 2);
  assert.ok(result.errors);
  assert.equal(result.errors.length, 2);
});

test("uploadAllPdfs maps filenames correctly in URLs object", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  delete require.cache[require.resolve("../storage")];
  const { uploadAllPdfs } = require("../storage");

  const files = [
    { buffer: Buffer.from("pdf1"), filename: "ex_round1.pdf" },
    { buffer: Buffer.from("pdf2"), filename: "personal_info_ex.pdf" }
  ];

  const result = await uploadAllPdfs(files, "contact123");

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // URLs should be empty since uploads failed, but errors should have correct filenames
  assert.ok(result.errors.find(e => e.filename === "ex_round1.pdf"));
  assert.ok(result.errors.find(e => e.filename === "personal_info_ex.pdf"));
});
