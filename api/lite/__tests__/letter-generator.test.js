const test = require("node:test");
const assert = require("node:assert/strict");
const {
  generateLetters,
  generateDisputeLetters,
  generateInquiryLetters,
  generatePersonalInfoLetters,
  BUREAUS
} = require("../letter-generator");

// ============================================================================
// BUREAUS constant tests
// ============================================================================
test("BUREAUS contains all three bureaus", () => {
  assert.ok(BUREAUS.experian);
  assert.ok(BUREAUS.transunion);
  assert.ok(BUREAUS.equifax);
});

test("BUREAUS has correct prefixes", () => {
  assert.equal(BUREAUS.experian.prefix, "ex");
  assert.equal(BUREAUS.transunion.prefix, "tu");
  assert.equal(BUREAUS.equifax.prefix, "eq");
});

test("BUREAUS has correct names", () => {
  assert.equal(BUREAUS.experian.name, "Experian");
  assert.equal(BUREAUS.transunion.name, "TransUnion");
  assert.equal(BUREAUS.equifax.name, "Equifax");
});

test("BUREAUS has addresses", () => {
  assert.ok(BUREAUS.experian.address.includes("Allen, TX"));
  assert.ok(BUREAUS.transunion.address.includes("Chester, PA"));
  assert.ok(BUREAUS.equifax.address.includes("Atlanta, GA"));
});

// ============================================================================
// generateLetters tests (Dec 2025 - updated letter counts)
// ============================================================================
test("generateLetters generates 12 letters for repair path", async () => {
  const result = await generateLetters({
    path: "repair",
    bureaus: {
      experian: { score: 600, tradelines: [] },
      transunion: { score: 610, tradelines: [] },
      equifax: { score: 620, tradelines: [] }
    },
    personal: { name: "John Doe" },
    underwrite: { fundable: false }
  });

  // 9 dispute letters + 3 personal info letters (one per bureau) = 12
  assert.equal(result.length, 12);
});

test("generateLetters generates 6 letters for fundable path", async () => {
  const result = await generateLetters({
    path: "fundable",
    bureaus: {
      experian: { score: 750, inquiries: 2 },
      transunion: { score: 760, inquiries: 1 },
      equifax: { score: 770, inquiries: 0 }
    },
    personal: { name: "Jane Doe" },
    underwrite: { fundable: true }
  });

  // 3 inquiry letters + 3 personal info letters (one per bureau) = 6
  assert.equal(result.length, 6);
});

test("generateLetters returns buffers for each letter", async () => {
  const result = await generateLetters({
    path: "fundable",
    bureaus: {},
    personal: {},
    underwrite: {}
  });

  result.forEach(letter => {
    assert.ok(letter.filename);
    assert.ok(Buffer.isBuffer(letter.buffer));
  });
});

test("generateLetters handles empty bureaus", async () => {
  const result = await generateLetters({
    path: "repair",
    bureaus: {},
    personal: {},
    underwrite: {}
  });

  assert.equal(result.length, 12);
});

test("generateLetters handles null personal info", async () => {
  const result = await generateLetters({
    path: "fundable",
    bureaus: {},
    personal: null,
    underwrite: {}
  });

  assert.equal(result.length, 6);
});

// ============================================================================
// generateDisputeLetters tests
// ============================================================================
test("generateDisputeLetters generates 9 letters", async () => {
  const result = await generateDisputeLetters({
    bureaus: {
      experian: {},
      transunion: {},
      equifax: {}
    },
    personal: { name: "Test User" },
    underwrite: {}
  });

  assert.equal(result.length, 9);
});

test("generateDisputeLetters uses correct filenames", async () => {
  const result = await generateDisputeLetters({
    bureaus: {},
    personal: {},
    underwrite: {}
  });

  const filenames = result.map(r => r.filename);
  assert.ok(filenames.includes("ex_round1.pdf"));
  assert.ok(filenames.includes("ex_round2.pdf"));
  assert.ok(filenames.includes("ex_round3.pdf"));
  assert.ok(filenames.includes("tu_round1.pdf"));
  assert.ok(filenames.includes("tu_round2.pdf"));
  assert.ok(filenames.includes("tu_round3.pdf"));
  assert.ok(filenames.includes("eq_round1.pdf"));
  assert.ok(filenames.includes("eq_round2.pdf"));
  assert.ok(filenames.includes("eq_round3.pdf"));
});

test("generateDisputeLetters distributes accounts across rounds", async () => {
  const result = await generateDisputeLetters({
    bureaus: {
      experian: {
        tradelines: [
          { creditor: "Account1", status: "collection" },
          { creditor: "Account2", status: "charge-off" },
          { creditor: "Account3", status: "late" },
          { creditor: "Account4", status: "collection" },
          { creditor: "Account5", status: "derogatory" },
          { creditor: "Account6", status: "closed" }
        ]
      }
    },
    personal: { name: "Test" },
    underwrite: {}
  });

  assert.equal(result.length, 9);
  // Each PDF should be a valid buffer
  result.forEach(r => {
    assert.ok(Buffer.isBuffer(r.buffer));
    assert.ok(r.buffer.length > 0);
  });
});

// ============================================================================
// generateInquiryLetters tests (Dec 2025 - one per bureau)
// ============================================================================
test("generateInquiryLetters generates 3 letters (one per bureau)", async () => {
  const result = await generateInquiryLetters({
    bureaus: {
      experian: { inquiries: 5 },
      transunion: { inquiries: 3 },
      equifax: { inquiries: 2 }
    },
    personal: { name: "Test User" }
  });

  assert.equal(result.length, 3);
});

test("generateInquiryLetters uses correct filenames (per bureau)", async () => {
  const result = await generateInquiryLetters({
    bureaus: {},
    personal: {}
  });

  const filenames = result.map(r => r.filename);
  assert.ok(filenames.includes("inquiry_ex.pdf"));
  assert.ok(filenames.includes("inquiry_tu.pdf"));
  assert.ok(filenames.includes("inquiry_eq.pdf"));
});

test("generateInquiryLetters handles empty bureaus", async () => {
  const result = await generateInquiryLetters({
    bureaus: {},
    personal: {}
  });

  assert.equal(result.length, 3);
  result.forEach(r => {
    assert.ok(Buffer.isBuffer(r.buffer));
  });
});

// ============================================================================
// generatePersonalInfoLetters tests (Dec 2025 - one per bureau)
// ============================================================================
test("generatePersonalInfoLetters generates 3 letters (one per bureau)", async () => {
  const result = await generatePersonalInfoLetters({
    bureaus: {
      experian: {
        names: ["John Doe", "J Doe"],
        addresses: ["123 Main St", "456 Oak Ave"],
        employers: ["Acme Corp"]
      }
    },
    personal: { name: "John Doe" }
  });

  assert.equal(result.length, 3);
});

test("generatePersonalInfoLetters uses correct filenames (per bureau)", async () => {
  const result = await generatePersonalInfoLetters({
    bureaus: {},
    personal: {}
  });

  const filenames = result.map(r => r.filename);
  assert.ok(filenames.includes("personal_info_ex.pdf"));
  assert.ok(filenames.includes("personal_info_tu.pdf"));
  assert.ok(filenames.includes("personal_info_eq.pdf"));
});

test("generatePersonalInfoLetters gets variations per bureau", async () => {
  const result = await generatePersonalInfoLetters({
    bureaus: {
      experian: { names: ["Name1"], addresses: ["Addr1"] },
      transunion: { names: ["Name2"], addresses: ["Addr2"] },
      equifax: { names: ["Name3"], employers: ["Employer1"] }
    },
    personal: {}
  });

  assert.equal(result.length, 3);
  result.forEach(r => {
    assert.ok(Buffer.isBuffer(r.buffer));
    assert.ok(r.buffer.length > 0);
  });
});

test("generatePersonalInfoLetters handles missing arrays", async () => {
  const result = await generatePersonalInfoLetters({
    bureaus: {
      experian: { score: 700 } // No names, addresses, employers
    },
    personal: {}
  });

  assert.equal(result.length, 3);
});

// ============================================================================
// PDF content validation tests
// ============================================================================
test("generated PDFs have valid PDF header", async () => {
  const result = await generateLetters({
    path: "fundable",
    bureaus: {},
    personal: { name: "Test" },
    underwrite: {}
  });

  result.forEach(letter => {
    // PDF files start with %PDF
    const header = letter.buffer.slice(0, 4).toString();
    assert.equal(header, "%PDF");
  });
});

test("generated PDFs are non-trivial size", async () => {
  const result = await generateLetters({
    path: "repair",
    bureaus: {},
    personal: { name: "John Doe", address: "123 Main St" },
    underwrite: {}
  });

  result.forEach(letter => {
    // PDFs should be at least 1KB
    assert.ok(letter.buffer.length > 1000, `${letter.filename} is too small`);
  });
});
