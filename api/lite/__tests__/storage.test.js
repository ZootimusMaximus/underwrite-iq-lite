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
// mapUrlsToGhlFields tests - Repair path
// ============================================================================
test("mapUrlsToGhlFields maps all repair path URLs correctly", () => {
  const urls = {
    ex_round1: "https://blob.vercel.com/ex1.pdf",
    ex_round2: "https://blob.vercel.com/ex2.pdf",
    ex_round3: "https://blob.vercel.com/ex3.pdf",
    tu_round1: "https://blob.vercel.com/tu1.pdf",
    tu_round2: "https://blob.vercel.com/tu2.pdf",
    tu_round3: "https://blob.vercel.com/tu3.pdf",
    eq_round1: "https://blob.vercel.com/eq1.pdf",
    eq_round2: "https://blob.vercel.com/eq2.pdf",
    eq_round3: "https://blob.vercel.com/eq3.pdf",
    personal_info_round1: "https://blob.vercel.com/pi1.pdf",
    personal_info_round2: "https://blob.vercel.com/pi2.pdf"
  };

  const result = mapUrlsToGhlFields(urls, "repair");

  // Check all Experian fields
  assert.equal(result.cf_uq_ex_round1_url, "https://blob.vercel.com/ex1.pdf");
  assert.equal(result.cf_uq_ex_round2_url, "https://blob.vercel.com/ex2.pdf");
  assert.equal(result.cf_uq_ex_round3_url, "https://blob.vercel.com/ex3.pdf");

  // Check all TransUnion fields
  assert.equal(result.cf_uq_tu_round1_url, "https://blob.vercel.com/tu1.pdf");
  assert.equal(result.cf_uq_tu_round2_url, "https://blob.vercel.com/tu2.pdf");
  assert.equal(result.cf_uq_tu_round3_url, "https://blob.vercel.com/tu3.pdf");

  // Check all Equifax fields
  assert.equal(result.cf_uq_eq_round1_url, "https://blob.vercel.com/eq1.pdf");
  assert.equal(result.cf_uq_eq_round2_url, "https://blob.vercel.com/eq2.pdf");
  assert.equal(result.cf_uq_eq_round3_url, "https://blob.vercel.com/eq3.pdf");

  // Check personal info fields
  assert.equal(result.cf_uq_personal_info_round1_url, "https://blob.vercel.com/pi1.pdf");
  assert.equal(result.cf_uq_personal_info_round2_url, "https://blob.vercel.com/pi2.pdf");

  // Check state flags
  assert.equal(result.cf_uq_path, "repair");
  assert.equal(result.cf_uq_letters_ready, "true");
});

// ============================================================================
// mapUrlsToGhlFields tests - Fundable path
// ============================================================================
test("mapUrlsToGhlFields maps fundable path URLs correctly", () => {
  const urls = {
    personal_info_round1: "https://blob.vercel.com/pi1.pdf",
    personal_info_round2: "https://blob.vercel.com/pi2.pdf",
    inquiries_round1: "https://blob.vercel.com/inq1.pdf",
    inquiries_round2: "https://blob.vercel.com/inq2.pdf"
  };

  const result = mapUrlsToGhlFields(urls, "fundable");

  assert.equal(result.cf_uq_personal_info_round1_url, "https://blob.vercel.com/pi1.pdf");
  assert.equal(result.cf_uq_personal_info_round2_url, "https://blob.vercel.com/pi2.pdf");
  assert.equal(result.cf_uq_inquiry_round1_url, "https://blob.vercel.com/inq1.pdf");
  assert.equal(result.cf_uq_inquiry_round2_url, "https://blob.vercel.com/inq2.pdf");
  assert.equal(result.cf_uq_path, "fundable");
  assert.equal(result.cf_uq_letters_ready, "true");
});

// ============================================================================
// mapUrlsToGhlFields tests - Edge cases
// ============================================================================
test("mapUrlsToGhlFields handles empty URLs object", () => {
  const result = mapUrlsToGhlFields({}, "repair");

  assert.equal(result.cf_uq_path, "repair");
  assert.equal(result.cf_uq_letters_ready, "true");
  // No URL fields should be set
  assert.equal(result.cf_uq_ex_round1_url, undefined);
  assert.equal(result.cf_uq_tu_round1_url, undefined);
  assert.equal(result.cf_uq_eq_round1_url, undefined);
});

test("mapUrlsToGhlFields only includes provided URLs", () => {
  const urls = {
    ex_round1: "https://blob.vercel.com/ex1.pdf"
  };

  const result = mapUrlsToGhlFields(urls, "repair");

  assert.equal(result.cf_uq_ex_round1_url, "https://blob.vercel.com/ex1.pdf");
  assert.equal(result.cf_uq_ex_round2_url, undefined);
  assert.equal(result.cf_uq_ex_round3_url, undefined);
  assert.equal(result.cf_uq_tu_round1_url, undefined);
});

test("mapUrlsToGhlFields sets path to fundable", () => {
  const result = mapUrlsToGhlFields({}, "fundable");
  assert.equal(result.cf_uq_path, "fundable");
});

test("mapUrlsToGhlFields always sets letters_ready to true", () => {
  const result1 = mapUrlsToGhlFields({}, "repair");
  const result2 = mapUrlsToGhlFields({}, "fundable");

  assert.equal(result1.cf_uq_letters_ready, "true");
  assert.equal(result2.cf_uq_letters_ready, "true");
});

test("mapUrlsToGhlFields handles partial repair path URLs", () => {
  const urls = {
    ex_round1: "https://blob.vercel.com/ex1.pdf",
    tu_round2: "https://blob.vercel.com/tu2.pdf",
    eq_round3: "https://blob.vercel.com/eq3.pdf"
  };

  const result = mapUrlsToGhlFields(urls, "repair");

  assert.equal(result.cf_uq_ex_round1_url, "https://blob.vercel.com/ex1.pdf");
  assert.equal(result.cf_uq_ex_round2_url, undefined);
  assert.equal(result.cf_uq_tu_round1_url, undefined);
  assert.equal(result.cf_uq_tu_round2_url, "https://blob.vercel.com/tu2.pdf");
  assert.equal(result.cf_uq_eq_round3_url, "https://blob.vercel.com/eq3.pdf");
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
    { buffer: Buffer.from("pdf2"), filename: "personal_info_round1.pdf" }
  ];

  const result = await uploadAllPdfs(files, "contact123");

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // URLs should be empty since uploads failed, but errors should have correct filenames
  assert.ok(result.errors.find(e => e.filename === "ex_round1.pdf"));
  assert.ok(result.errors.find(e => e.filename === "personal_info_round1.pdf"));
});
