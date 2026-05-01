"use strict";

/**
 * render-pdf-ssn.test.js
 *
 * Verifies that SSN appears in dispute letter PDFs (formatted as XXX-XX-XXXX)
 * and is NOT present in non-dispute letter PDFs (inquiry_removal, personal_info).
 *
 * Uses pdf-lib to generate real PDFs, then checks the raw byte content for the
 * SSN string — a reliable indicator that the text was drawn on the page.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");

const {
  renderLetterPDF,
  renderLetterBundlePDF,
  formatSsn
} = require("../crs/render-pdf");

// ---------------------------------------------------------------------------
// Helper: extract plain text from a pdf-lib generated PDF buffer
// ---------------------------------------------------------------------------

/**
 * Decompress all FlateDecode content streams from a PDF buffer and
 * decode hex-encoded text strings (<hex> Tj) into plain ASCII.
 * Returns concatenated text from all content streams.
 */
function extractPdfText(pdfBuf) {
  const latin1 = pdfBuf.toString("latin1");
  const allText = [];
  let pos = 0;
  while (true) {
    const si = latin1.indexOf("stream\n", pos);
    if (si === -1) break;
    const ei = latin1.indexOf("endstream", si);
    if (ei === -1) break;
    const streamBuf = Buffer.from(latin1.slice(si + 7, ei), "latin1");
    try {
      const decompressed = zlib.inflateSync(streamBuf).toString("latin1");
      const hexRe = /<([0-9A-Fa-f]+)>\s*T[jJ]/g;
      let m;
      while ((m = hexRe.exec(decompressed)) !== null) {
        try {
          allText.push(Buffer.from(m[1], "hex").toString("latin1"));
        } catch (_) { /* skip invalid hex */ }
      }
    } catch (_) { /* stream not zlib (e.g. image data) — skip */ }
    pos = ei + 9;
  }
  return allText.join(" ");
}

// ---------------------------------------------------------------------------
// formatSsn unit tests
// ---------------------------------------------------------------------------

test("formatSsn: formats 9-digit string as XXX-XX-XXXX", () => {
  assert.equal(formatSsn("123456789"), "123-45-6789");
});

test("formatSsn: handles already-formatted SSN (strips dashes first)", () => {
  assert.equal(formatSsn("123-45-6789"), "123-45-6789");
});

test("formatSsn: returns digits unchanged if not 9 digits", () => {
  assert.equal(formatSsn("12345"), "12345");
});

test("formatSsn: handles null gracefully", () => {
  const result = formatSsn(null);
  assert.equal(typeof result, "string");
});

// ---------------------------------------------------------------------------
// renderLetterPDF — dispute letter includes SSN
// ---------------------------------------------------------------------------

test("renderLetterPDF: dispute letter includes formatted SSN in output", async () => {
  const personal = {
    name: "Jane Smith",
    address: "456 Oak Ave, Dallas TX 75201",
    ssn: "987654321"
  };

  const buffer = await renderLetterPDF(
    "Dear Experian, I am disputing this account.",
    "dispute",
    "experian",
    1,
    personal,
    { furnisher: "Capital One", accountId: "1234" }
  );

  assert.ok(Buffer.isBuffer(buffer), "should return a Buffer");
  const text = extractPdfText(buffer);
  assert.ok(
    text.includes("987-65-4321"),
    `dispute letter PDF should contain formatted SSN 987-65-4321; got: ${text.slice(0, 300)}`
  );
  assert.ok(text.includes("SSN:"), "dispute letter PDF should contain SSN: label");
});

test("renderLetterPDF: dispute letter without SSN in personal → no SSN line rendered", async () => {
  const personal = {
    name: "Jane Smith",
    address: "456 Oak Ave, Dallas TX 75201"
    // no ssn field
  };

  const buffer = await renderLetterPDF(
    "Dear Experian, I am disputing this account.",
    "dispute",
    "experian",
    1,
    personal,
    { furnisher: "Capital One", accountId: "1234" }
  );

  assert.ok(Buffer.isBuffer(buffer));
  const text = extractPdfText(buffer);
  assert.ok(!text.includes("SSN:"), "no SSN: text when personal.ssn is absent");
});

// ---------------------------------------------------------------------------
// renderLetterPDF — non-dispute letters do NOT include SSN
// ---------------------------------------------------------------------------

test("renderLetterPDF: inquiry_removal letter does NOT include SSN even if personal.ssn is set", async () => {
  const personal = {
    name: "Jane Smith",
    address: "456 Oak Ave, Dallas TX 75201",
    ssn: "987654321"
  };

  const buffer = await renderLetterPDF(
    "Dear Experian, please remove these inquiries.",
    "inquiry_removal",
    "experian",
    null,
    personal
  );

  assert.ok(Buffer.isBuffer(buffer));
  const text = extractPdfText(buffer);
  assert.ok(!text.includes("987-65-4321"), "inquiry_removal letter must NOT contain SSN");
  assert.ok(!text.includes("SSN:"), "inquiry_removal letter must NOT contain SSN: label");
});

test("renderLetterPDF: personal_info letter does NOT include SSN even if personal.ssn is set", async () => {
  const personal = {
    name: "Jane Smith",
    address: "456 Oak Ave, Dallas TX 75201",
    ssn: "987654321"
  };

  const buffer = await renderLetterPDF(
    "Dear Experian, please correct my personal information.",
    "personal_info",
    "equifax",
    null,
    personal
  );

  assert.ok(Buffer.isBuffer(buffer));
  const text = extractPdfText(buffer);
  assert.ok(!text.includes("987-65-4321"), "personal_info letter must NOT contain SSN");
  assert.ok(!text.includes("SSN:"), "personal_info letter must NOT contain SSN: label");
});

// ---------------------------------------------------------------------------
// renderLetterBundlePDF — all letters in bundle include SSN
// ---------------------------------------------------------------------------

test("renderLetterBundlePDF: bundle dispute letters include SSN for each furnisher", async () => {
  const personal = {
    name: "Jane Smith",
    address: "456 Oak Ave, Dallas TX 75201",
    ssn: "987654321"
  };

  const letters = [
    { text: "Disputing Capital One account.", furnisher: "Capital One", accountId: "1234" },
    { text: "Disputing Midland Funding account.", furnisher: "Midland Funding", accountId: "5678" }
  ];

  const buffer = await renderLetterBundlePDF(letters, "experian", 1, personal);

  assert.ok(Buffer.isBuffer(buffer));
  const text = extractPdfText(buffer);
  assert.ok(
    text.includes("987-65-4321"),
    `bundle PDF should contain formatted SSN; got: ${text.slice(0, 300)}`
  );
});

test("renderLetterBundlePDF: bundle without SSN in personal → no SSN line", async () => {
  const personal = {
    name: "Jane Smith",
    address: "456 Oak Ave, Dallas TX 75201"
    // no ssn
  };

  const letters = [
    { text: "Disputing Capital One account.", furnisher: "Capital One", accountId: "1234" }
  ];

  const buffer = await renderLetterBundlePDF(letters, "experian", 1, personal);

  assert.ok(Buffer.isBuffer(buffer));
  const text = extractPdfText(buffer);
  assert.ok(!text.includes("SSN:"), "no SSN: text when personal.ssn is absent");
});
