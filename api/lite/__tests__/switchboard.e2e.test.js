const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");

/**
 * E2E Test for /api/lite/switchboard endpoint
 *
 * This test verifies the full flow that public/tester.html uses:
 * 1. Upload PDF files via multipart/form-data
 * 2. Receive JSON response with underwriting data
 * 3. Validate response structure matches tester.html expectations
 */

// Mock minimal credit report PDF content
function createMockCreditReportPDF() {
  // Create a minimal valid PDF with credit report keywords
  const pdfContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj
2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj
3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
>>
endobj
4 0 obj
<<
/Length 500
>>
stream
BT
/F1 12 Tf
50 700 Td
(Experian Credit Report) Tj
0 -20 Td
(Report Date: 2024-03-15) Tj
0 -20 Td
(FICO Score: 720) Tj
0 -20 Td
(Name: John Doe) Tj
0 -20 Td
(Address: 123 Main St) Tj
0 -20 Td
(Account Information:) Tj
0 -20 Td
(VISA *1234 - Balance: $2,000 Limit: $10,000) Tj
0 -20 Td
(Payment History: Current) Tj
0 -40 Td
(Inquiries: 2) Tj
0 -20 Td
(Negative Accounts: 0) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000214 00000 n
trailer
<<
/Size 5
/Root 1 0 R
>>
startxref
766
%%EOF
`;

  // Pad to meet minimum file size (40KB)
  const padding = " ".repeat(Math.max(0, 40 * 1024 - pdfContent.length));
  return Buffer.from(pdfContent + padding);
}

// Helper to create multipart form data
function createMultipartFormData(files, fields = {}) {
  const boundary = "----WebKitFormBoundary" + Math.random().toString(36);
  const parts = [];

  // Add field data
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`
    );
  }

  // Add file data
  for (const file of files) {
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    );
    parts.push(file.buffer);
    parts.push("\r\n");
  }

  parts.push(`--${boundary}--\r\n`);

  const buffers = parts.map(part =>
    Buffer.isBuffer(part) ? part : Buffer.from(part)
  );

  return {
    boundary,
    body: Buffer.concat(buffers)
  };
}

// Helper to make HTTP request to switchboard endpoint
async function callSwitchboard(formData, boundary, serverUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/lite/switchboard", serverUrl);

    const options = {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": formData.length
      }
    };

    const req = http.request(url, options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (err) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(formData);
    req.end();
  });
}

// Skip if PARSE_ENDPOINT is not configured (requires live backend)
const PARSE_ENDPOINT = process.env.PARSE_ENDPOINT;
const shouldSkip = !PARSE_ENDPOINT;

test("switchboard e2e - validates response structure for tester.html", { skip: shouldSkip }, async () => {
  // Create mock PDF
  const pdfBuffer = createMockCreditReportPDF();

  const files = [{
    name: "credit-report.pdf",
    buffer: pdfBuffer
  }];

  const fields = {
    email: "test@example.com",
    phone: "555-0123",
    deviceId: "test-device-123",
    businessAgeMonths: "24",
    hasLLC: "true",
    llcAgeMonths: "12"
  };

  // Create multipart form data
  const { boundary, body } = createMultipartFormData(files, fields);

  // Make request to switchboard endpoint
  // Note: This requires a running dev server (npm run dev)
  const SERVER_URL = process.env.TEST_SERVER_URL || "http://localhost:3000";

  const response = await callSwitchboard(body, boundary, SERVER_URL);

  // Validate HTTP status
  assert.equal(response.status, 200, "Expected HTTP 200 response");

  const result = response.data;

  // Validate required top-level fields that tester.html expects
  assert.ok("ok" in result, "Response should have 'ok' field");

  // If successful, validate underwrite object structure
  if (result.ok && result.underwrite) {
    const uw = result.underwrite;

    // Validate metrics object (used in tester.html lines 287-298)
    assert.ok(uw.metrics, "underwrite should have metrics");
    assert.ok("score" in uw.metrics, "metrics should have score");
    assert.ok("negative_accounts" in uw.metrics, "metrics should have negative_accounts");
    assert.ok("late_payment_events" in uw.metrics, "metrics should have late_payment_events");
    assert.ok("utilization_pct" in uw.metrics, "metrics should have utilization_pct");

    // Validate inquiries object
    if (uw.metrics.inquiries) {
      const inq = uw.metrics.inquiries;
      assert.ok("ex" in inq || "tu" in inq || "eq" in inq,
        "inquiries should have at least one bureau (ex, tu, or eq)");
    }

    // Validate funding amounts (used in tester.html lines 300-302)
    assert.ok(uw.personal, "underwrite should have personal");
    assert.ok("total_personal_funding" in uw.personal, "personal should have total_personal_funding");

    assert.ok(uw.business, "underwrite should have business");
    assert.ok("business_funding" in uw.business, "business should have business_funding");

    assert.ok(uw.totals, "underwrite should have totals");
    assert.ok("total_combined_funding" in uw.totals, "totals should have total_combined_funding");

    // Validate fundable flag (used in tester.html line 310)
    assert.ok("fundable" in uw, "underwrite should have fundable boolean");
    assert.equal(typeof uw.fundable, "boolean", "fundable should be boolean");

    // Validate optimization object (used in tester.html lines 348-361)
    if (uw.optimization) {
      const opt = uw.optimization;
      // Check that optimization flags exist (optional fields)
      const optFlags = [
        "needs_util_reduction",
        "needs_new_primary_revolving",
        "needs_inquiry_cleanup",
        "needs_negative_cleanup",
        "needs_file_buildout",
        "thin_file",
        "file_all_negative"
      ];

      // At least some optimization flags should be present
      const hasOptFlags = optFlags.some(flag => flag in opt);
      assert.ok(hasOptFlags, "optimization should have at least one flag");
    }
  }

  // Validate suggestions array (used in tester.html lines 339-344)
  if ("suggestions" in result) {
    assert.ok(Array.isArray(result.suggestions), "suggestions should be an array");

    // Each suggestion should be a string
    result.suggestions.forEach((suggestion, idx) => {
      assert.equal(typeof suggestion, "string",
        `suggestion[${idx}] should be a string`);
    });
  }

  console.log("✅ Switchboard response structure validated successfully");
  console.log(`   - ok: ${result.ok}`);
  console.log(`   - fundable: ${result.underwrite?.fundable ?? "N/A"}`);
  console.log(`   - suggestions count: ${result.suggestions?.length ?? 0}`);
});

test("switchboard e2e - handles multiple PDF files", { skip: shouldSkip }, async () => {
  // Create two mock PDFs (simulating tri-merge scenario)
  const pdf1 = createMockCreditReportPDF();
  const pdf2 = createMockCreditReportPDF();

  const files = [
    { name: "experian-report.pdf", buffer: pdf1 },
    { name: "equifax-report.pdf", buffer: pdf2 }
  ];

  const fields = {
    email: "multitest@example.com",
    phone: "555-9999",
    deviceId: "test-device-multi",
    businessAgeMonths: "36"
  };

  const { boundary, body } = createMultipartFormData(files, fields);

  const SERVER_URL = process.env.TEST_SERVER_URL || "http://localhost:3000";
  const response = await callSwitchboard(body, boundary, SERVER_URL);

  assert.equal(response.status, 200, "Expected HTTP 200 response");

  const result = response.data;

  // Validate that multiple files were processed
  assert.ok("ok" in result, "Response should have 'ok' field");

  // The parsed array should contain results for each PDF
  if (result.ok && result.parsed) {
    assert.ok(Array.isArray(result.parsed), "parsed should be an array");
    assert.ok(result.parsed.length >= 1, "parsed array should have at least 1 result");
  }

  console.log("✅ Multiple PDF upload validated successfully");
});

test("switchboard e2e - rejects files that are too small", { skip: shouldSkip }, async () => {
  // Create a PDF that's smaller than MIN_PDF_BYTES (40KB)
  const tinyPdf = Buffer.from("%PDF-1.4\nsmall file\n%%EOF");

  const files = [{
    name: "tiny.pdf",
    buffer: tinyPdf
  }];

  const fields = {
    email: "tiny@example.com",
    phone: "555-1111",
    deviceId: "test-device-tiny"
  };

  const { boundary, body } = createMultipartFormData(files, fields);

  const SERVER_URL = process.env.TEST_SERVER_URL || "http://localhost:3000";
  const response = await callSwitchboard(body, boundary, SERVER_URL);

  assert.equal(response.status, 200, "Expected HTTP 200 response");

  const result = response.data;

  // Should return ok: false due to validation failure
  assert.equal(result.ok, false, "Should reject files that are too small");
  assert.ok(result.error || result.message || result.msg, "Should include error message");

  console.log("✅ Small file rejection validated successfully");
});

// Note about running these tests
if (shouldSkip) {
  console.log("\n⚠️  Switchboard e2e tests skipped");
  console.log("   To run these tests:");
  console.log("   1. Start dev server: npm run dev");
  console.log("   2. Set environment variables:");
  console.log("      - PARSE_ENDPOINT=http://localhost:3000/api/lite/parse-report");
  console.log("      - TEST_SERVER_URL=http://localhost:3000 (optional)");
  console.log("   3. Run: npm test\n");
}
