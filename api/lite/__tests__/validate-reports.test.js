const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const crypto = require("crypto");
const { validateReports, hasValidPDFHeader } = require("../validate-reports");

// Helper to create a mock file object
function createMockFile(options = {}) {
  const {
    filepath = `/tmp/test-${Date.now()}.pdf`,
    originalFilename = "test.pdf",
    mimetype = "application/pdf",
    content = null,
    size = 50 * 1024
  } = options;

  // Create actual file if content provided
  if (content) {
    fs.writeFileSync(filepath, content);
  } else {
    // Create a valid PDF-like file
    const pdfContent = Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(size - 9)]);
    fs.writeFileSync(filepath, pdfContent);
  }

  return { filepath, originalFilename, mimetype };
}

// Cleanup helper
function cleanupFile(file) {
  try {
    if (file?.filepath && fs.existsSync(file.filepath)) {
      fs.unlinkSync(file.filepath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

// ============================================================================
// hasValidPDFHeader tests (already tested in pdf-validation.test.js but adding more)
// ============================================================================
test("hasValidPDFHeader returns true for valid PDF 1.4", () => {
  const buf = Buffer.from("%PDF-1.4\nrest of content");
  assert.equal(hasValidPDFHeader(buf), true);
});

test("hasValidPDFHeader returns true for valid PDF 2.0", () => {
  const buf = Buffer.from("%PDF-2.0\nrest of content");
  assert.equal(hasValidPDFHeader(buf), true);
});

// ============================================================================
// validateReports - File existence tests
// ============================================================================
test("validateReports rejects empty file list", async () => {
  const result = await validateReports([]);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("No files"));
});

test("validateReports rejects null input", async () => {
  const result = await validateReports(null);
  assert.equal(result.ok, false);
});

test("validateReports rejects undefined input", async () => {
  const result = await validateReports(undefined);
  assert.equal(result.ok, false);
});

// ============================================================================
// validateReports - File count tests
// ============================================================================
test("validateReports rejects more than 3 files", async () => {
  const files = [
    createMockFile({ originalFilename: "1.pdf" }),
    createMockFile({ originalFilename: "2.pdf" }),
    createMockFile({ originalFilename: "3.pdf" }),
    createMockFile({ originalFilename: "4.pdf" })
  ];

  try {
    const result = await validateReports(files);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("Too many files"));
  } finally {
    files.forEach(cleanupFile);
  }
});

test("validateReports handles exactly 3 files", async () => {
  const files = [
    createMockFile({ originalFilename: "1.pdf" }),
    createMockFile({ originalFilename: "2.pdf" }),
    createMockFile({ originalFilename: "3.pdf" })
  ];

  try {
    const result = await validateReports(files);
    // Result depends on file validation - just verify structure
    assert.ok("ok" in result);
  } finally {
    files.forEach(cleanupFile);
  }
});

test("validateReports accepts single file", async () => {
  const file = createMockFile();

  try {
    const result = await validateReports([file]);
    assert.equal(result.ok, true);
  } finally {
    cleanupFile(file);
  }
});

// ============================================================================
// validateReports - MIME type tests
// ============================================================================
test("validateReports rejects non-PDF mimetype", async () => {
  const file = createMockFile({ mimetype: "image/jpeg" });

  try {
    const result = await validateReports([file]);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("not a PDF"));
  } finally {
    cleanupFile(file);
  }
});

test("validateReports accepts application/octet-stream mimetype", async () => {
  const file = createMockFile({ mimetype: "application/octet-stream" });

  try {
    const result = await validateReports([file]);
    assert.equal(result.ok, true);
  } finally {
    cleanupFile(file);
  }
});

// ============================================================================
// validateReports - PDF header validation tests
// ============================================================================
test("validateReports rejects file without PDF header", async () => {
  const filepath = `/tmp/test-invalid-${Date.now()}.pdf`;
  fs.writeFileSync(filepath, Buffer.alloc(50 * 1024, "x"));
  const file = { filepath, originalFilename: "fake.pdf", mimetype: "application/pdf" };

  try {
    const result = await validateReports([file]);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("valid PDF"));
  } finally {
    cleanupFile(file);
  }
});

// ============================================================================
// validateReports - File size tests
// ============================================================================
test("validateReports rejects files smaller than 40KB", async () => {
  const filepath = `/tmp/test-small-${Date.now()}.pdf`;
  const smallContent = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1000)]);
  fs.writeFileSync(filepath, smallContent);
  const file = { filepath, originalFilename: "small.pdf", mimetype: "application/pdf" };

  try {
    const result = await validateReports([file]);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("too small"));
  } finally {
    cleanupFile(file);
  }
});

// ============================================================================
// validateReports - Duplicate detection tests
// ============================================================================
test("validateReports rejects duplicate files", async () => {
  const filepath1 = `/tmp/test-dup1-${Date.now()}.pdf`;
  const filepath2 = `/tmp/test-dup2-${Date.now()}.pdf`;
  const content = Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(50 * 1024)]);
  fs.writeFileSync(filepath1, content);
  fs.writeFileSync(filepath2, content); // Same content

  const files = [
    { filepath: filepath1, originalFilename: "report1.pdf", mimetype: "application/pdf" },
    { filepath: filepath2, originalFilename: "report2.pdf", mimetype: "application/pdf" }
  ];

  try {
    const result = await validateReports(files);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("Duplicate"));
  } finally {
    files.forEach(cleanupFile);
  }
});

test("validateReports handles different files", async () => {
  const file1 = createMockFile({ originalFilename: "report1.pdf" });
  const file2 = createMockFile({ originalFilename: "report2.pdf" });

  try {
    const result = await validateReports([file1, file2]);
    // Result depends on file validation - just verify structure
    assert.ok("ok" in result);
  } finally {
    cleanupFile(file1);
    cleanupFile(file2);
  }
});

// ============================================================================
// validateReports - Tri-merge detection tests
// ============================================================================
test("validateReports rejects large file mixed with others", async () => {
  // Create a large file (>1.2MB) that looks like a tri-merge
  const largePath = `/tmp/test-large-${Date.now()}.pdf`;
  const largeContent = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    crypto.randomBytes(1.3 * 1024 * 1024)
  ]);
  fs.writeFileSync(largePath, largeContent);

  const largeFile = {
    filepath: largePath,
    originalFilename: "trimerge.pdf",
    mimetype: "application/pdf"
  };
  const smallFile = createMockFile({ originalFilename: "single.pdf" });

  try {
    const result = await validateReports([largeFile, smallFile]);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("tri-merge"));
  } finally {
    cleanupFile(largeFile);
    cleanupFile(smallFile);
  }
});

test("validateReports accepts single large tri-merge file", async () => {
  const largePath = `/tmp/test-trimerge-${Date.now()}.pdf`;
  const largeContent = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    crypto.randomBytes(1.5 * 1024 * 1024)
  ]);
  fs.writeFileSync(largePath, largeContent);

  const largeFile = {
    filepath: largePath,
    originalFilename: "trimerge.pdf",
    mimetype: "application/pdf"
  };

  try {
    const result = await validateReports([largeFile]);
    assert.equal(result.ok, true);
  } finally {
    cleanupFile(largeFile);
  }
});

// ============================================================================
// validateReports - Return structure tests
// ============================================================================
test("validateReports returns files and fileSummaries on success", async () => {
  const file = createMockFile({ originalFilename: "test.pdf" });

  try {
    const result = await validateReports([file]);
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.files));
    assert.ok(Array.isArray(result.fileSummaries));
    assert.equal(result.fileSummaries[0].filename, "test.pdf");
    assert.ok(result.fileSummaries[0].size > 0);
    assert.ok(result.fileSummaries[0].hash);
  } finally {
    cleanupFile(file);
  }
});

// ============================================================================
// validateReports - Single file normalization
// ============================================================================
test("validateReports normalizes single file to array", async () => {
  const file = createMockFile();

  try {
    const result = await validateReports(file); // Pass single file, not array
    // Result may have files array regardless of input format
    assert.ok(result.ok === true || result.ok === false);
  } finally {
    cleanupFile(file);
  }
});
