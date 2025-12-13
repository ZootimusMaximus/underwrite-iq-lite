// ============================================================================
// PDF Magic Byte Validation Tests
// ============================================================================

const test = require("node:test");
const assert = require("node:assert/strict");

const { hasValidPDFHeader } = require("../validate-reports");

test("hasValidPDFHeader accepts valid PDF header", () => {
  const validPDF = Buffer.from("%PDF-1.4\n...");
  assert.equal(hasValidPDFHeader(validPDF), true);
});

test("hasValidPDFHeader accepts PDF 1.7 header", () => {
  const validPDF = Buffer.from("%PDF-1.7\n...");
  assert.equal(hasValidPDFHeader(validPDF), true);
});

test("hasValidPDFHeader rejects non-PDF file", () => {
  const notPDF = Buffer.from("This is not a PDF file");
  assert.equal(hasValidPDFHeader(notPDF), false);
});

test("hasValidPDFHeader rejects empty buffer", () => {
  const emptyBuffer = Buffer.from("");
  assert.equal(hasValidPDFHeader(emptyBuffer), false);
});

test("hasValidPDFHeader rejects buffer that is too small", () => {
  const smallBuffer = Buffer.from("PDF");
  assert.equal(hasValidPDFHeader(smallBuffer), false);
});

test("hasValidPDFHeader rejects null buffer", () => {
  assert.equal(hasValidPDFHeader(null), false);
});

test("hasValidPDFHeader rejects undefined buffer", () => {
  assert.equal(hasValidPDFHeader(undefined), false);
});

test("hasValidPDFHeader rejects HTML file", () => {
  const htmlFile = Buffer.from("<!DOCTYPE html><html>...");
  assert.equal(hasValidPDFHeader(htmlFile), false);
});

test("hasValidPDFHeader rejects text file", () => {
  const textFile = Buffer.from("This is a text file\nwith multiple lines");
  assert.equal(hasValidPDFHeader(textFile), false);
});

test("hasValidPDFHeader rejects JPEG file", () => {
  const jpegFile = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  assert.equal(hasValidPDFHeader(jpegFile), false);
});

test("hasValidPDFHeader rejects PNG file", () => {
  const pngFile = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
  assert.equal(hasValidPDFHeader(pngFile), false);
});

test("hasValidPDFHeader rejects ZIP file", () => {
  const zipFile = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
  assert.equal(hasValidPDFHeader(zipFile), false);
});
