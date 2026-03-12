const test = require("node:test");
const assert = require("node:assert/strict");

const {
  deliverLetters,
  deliverLettersAsync,
  generateLettersFromCRS
} = require("../letter-delivery");

// ============================================================================
// deliverLetters - path determination tests
// ============================================================================
test("deliverLetters returns repair path for non-fundable", async () => {
  // This will fail at GHL contact creation due to missing API key,
  // but we can still verify path determination
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.GHL_PRIVATE_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    bureaus: {},
    underwrite: { fundable: false },
    personal: {}
  });

  // Restore
  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.path, "repair");
});

test("deliverLetters returns fundable path for fundable", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.GHL_PRIVATE_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    bureaus: {},
    underwrite: { fundable: true },
    personal: {}
  });

  // Restore
  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.path, "fundable");
});

test("deliverLetters defaults to repair path when underwrite is empty", async () => {
  const originalKey = process.env.GHL_PRIVATE_API_KEY;
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.GHL_PRIVATE_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalKey) process.env.GHL_PRIVATE_API_KEY = originalKey;
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.path, "repair");
});

// ============================================================================
// deliverLetters - letter generation tests
// ============================================================================
test("deliverLetters generates correct number of letters for repair path", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: { fundable: false },
    personal: { name: "Test User" }
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Repair path: 9 dispute + 3 personal info (one per bureau) = 12 letters
  assert.equal(result.letters.generated, 12);
});

test("deliverLetters generates correct number of letters for fundable path", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: { fundable: true },
    personal: { name: "Test User" }
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Fundable path: 3 inquiry + 3 personal info (one per bureau) = 6 letters
  assert.equal(result.letters.generated, 6);
});

// ============================================================================
// deliverLetters - upload failure handling
// ============================================================================
test("deliverLetters reports upload failures when token missing", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: { fundable: true },
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.letters.uploaded, 0);
  assert.equal(result.letters.failed, 6); // All 6 fundable letters should fail
});

// ============================================================================
// deliverLetters - GHL skip handling
// ============================================================================
test("deliverLetters skips GHL update when no contactId and no contactData", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    contactData: null,
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.ghlSkipped, true);
  assert.equal(result.ghlUpdated, false);
});

// ============================================================================
// deliverLetters - result structure tests
// ============================================================================
test("deliverLetters includes duration in result", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: null,
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.ok(typeof result.duration === "number");
  assert.ok(result.duration >= 0);
});

test("deliverLetters includes urls object in result", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-id",
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.ok(result.urls !== undefined);
  assert.ok(typeof result.urls === "object");
});

// ============================================================================
// deliverLettersAsync tests
// ============================================================================
test("deliverLettersAsync returns immediately with async flag", () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = deliverLettersAsync({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.ok, true);
  assert.equal(result.async, true);
  assert.ok(result.message.includes("background"));
});

test("deliverLettersAsync does not block execution", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const start = Date.now();
  const result = deliverLettersAsync({
    contactId: "test-contact-id",
    bureaus: {},
    underwrite: {},
    personal: {}
  });
  const elapsed = Date.now() - start;

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Should return in less than 50ms (not waiting for letter generation)
  assert.ok(elapsed < 50);
  assert.equal(result.ok, true);
});

// ============================================================================
// deliverLetters - error handling tests
// ============================================================================
test("deliverLetters handles null bureaus gracefully", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-id",
    bureaus: null,
    underwrite: {},
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Should still work, using empty bureaus
  assert.equal(result.ok, true);
  assert.ok(result.letters.generated > 0);
});

test("deliverLetters handles null personal gracefully", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-id",
    bureaus: {},
    underwrite: {},
    personal: null
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Should still work, using empty personal
  assert.equal(result.ok, true);
  assert.ok(result.letters.generated > 0);
});

test("deliverLetters handles null underwrite gracefully", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-id",
    bureaus: {},
    underwrite: null,
    personal: {}
  });

  // Restore
  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Should default to repair path
  assert.equal(result.ok, true);
  assert.equal(result.path, "repair");
});

// ============================================================================
// CRS Letter Delivery Tests
// ============================================================================

test("deliverLetters uses CRS path when crsDocuments provided", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const crsDocuments = {
    package: "funding",
    letters: [
      {
        type: "inquiry_removal",
        bureau: "experian",
        round: null,
        fieldKey: "funding_letter_inquiry_ex"
      },
      {
        type: "personal_info",
        bureau: "experian",
        round: null,
        fieldKey: "funding_letter_personal_info_ex"
      },
      {
        type: "personal_info",
        bureau: "transunion",
        round: null,
        fieldKey: "funding_letter_personal_info_tu"
      }
    ]
  };

  const result = await deliverLetters({
    contactId: "test-crs",
    crsDocuments,
    personal: { name: "Test User", address: "123 Main St" }
  });

  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.ok, true);
  assert.equal(result.path, "fundable");
  assert.equal(result.letters.generated, 3);
});

test("deliverLetters uses CRS repair path correctly", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const crsDocuments = {
    package: "repair",
    letters: [
      { type: "dispute", bureau: "experian", round: 1, fieldKey: "repair_letter_round_1_ex" },
      { type: "dispute", bureau: "transunion", round: 1, fieldKey: "repair_letter_round_1_tu" },
      { type: "dispute", bureau: "equifax", round: 1, fieldKey: "repair_letter_round_1_eq" },
      { type: "dispute", bureau: "experian", round: 2, fieldKey: "repair_letter_round_2_ex" },
      { type: "dispute", bureau: "transunion", round: 2, fieldKey: "repair_letter_round_2_tu" },
      { type: "dispute", bureau: "equifax", round: 2, fieldKey: "repair_letter_round_2_eq" },
      { type: "dispute", bureau: "experian", round: 3, fieldKey: "repair_letter_round_3_ex" },
      { type: "dispute", bureau: "transunion", round: 3, fieldKey: "repair_letter_round_3_tu" },
      { type: "dispute", bureau: "equifax", round: 3, fieldKey: "repair_letter_round_3_eq" },
      {
        type: "personal_info",
        bureau: "experian",
        round: null,
        fieldKey: "repair_letter_personal_info_ex"
      },
      {
        type: "personal_info",
        bureau: "transunion",
        round: null,
        fieldKey: "repair_letter_personal_info_tu"
      },
      {
        type: "personal_info",
        bureau: "equifax",
        round: null,
        fieldKey: "repair_letter_personal_info_eq"
      }
    ]
  };

  const result = await deliverLetters({
    contactId: "test-crs-repair",
    crsDocuments,
    personal: { name: "Test User" }
  });

  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  assert.equal(result.ok, true);
  assert.equal(result.path, "repair");
  assert.equal(result.letters.generated, 12);
});

test("generateLettersFromCRS produces correct filenames and fieldKeyMap", async () => {
  const specs = [
    {
      type: "inquiry_removal",
      bureau: "experian",
      round: null,
      fieldKey: "funding_letter_inquiry_ex"
    },
    {
      type: "personal_info",
      bureau: "transunion",
      round: null,
      fieldKey: "funding_letter_personal_info_tu"
    },
    { type: "dispute", bureau: "equifax", round: 2, fieldKey: "repair_letter_round_2_eq" }
  ];

  const { letters, fieldKeyMap } = await generateLettersFromCRS(specs, { name: "Test" });

  assert.equal(letters.length, 3);
  // Order: disputes first, then inquiry, then personal
  assert.equal(letters[0].filename, "eq_round2.pdf");
  assert.equal(letters[1].filename, "inquiry_ex.pdf");
  assert.equal(letters[2].filename, "personal_info_tu.pdf");

  assert.equal(fieldKeyMap["eq_round2"], "repair_letter_round_2_eq");
  assert.equal(fieldKeyMap["inquiry_ex"], "funding_letter_inquiry_ex");
  assert.equal(fieldKeyMap["personal_info_tu"], "funding_letter_personal_info_tu");
});

test("generateLettersFromCRS produces valid PDF buffers", async () => {
  const specs = [{ type: "inquiry_removal", bureau: "experian", round: null, fieldKey: "test" }];

  const { letters } = await generateLettersFromCRS(specs, {
    name: "Jane Doe",
    address: "456 Oak Ave"
  });

  assert.equal(letters.length, 1);
  assert.ok(Buffer.isBuffer(letters[0].buffer));
  assert.ok(letters[0].buffer.length > 100); // PDF should be > 100 bytes
  // Check PDF magic bytes
  assert.equal(letters[0].buffer.slice(0, 5).toString(), "%PDF-");
});

test("generateLettersFromCRS skips unknown bureaus", async () => {
  const specs = [
    { type: "dispute", bureau: "unknown_bureau", round: 1, fieldKey: "test" },
    { type: "inquiry_removal", bureau: "experian", round: null, fieldKey: "test2" }
  ];

  const { letters } = await generateLettersFromCRS(specs, {});

  assert.equal(letters.length, 1); // only experian letter generated
  assert.equal(letters[0].filename, "inquiry_ex.pdf");
});

test("deliverLetters ignores crsDocuments when letters array is empty", async () => {
  const originalToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const result = await deliverLetters({
    contactId: "test-empty-crs",
    crsDocuments: { package: "hold", letters: [] },
    bureaus: {},
    underwrite: { fundable: true },
    personal: {}
  });

  if (originalToken) process.env.BLOB_READ_WRITE_TOKEN = originalToken;

  // Should fall back to legacy path since crsDocuments.letters is empty
  assert.equal(result.ok, true);
  assert.equal(result.path, "fundable");
  assert.equal(result.letters.generated, 6); // legacy fundable = 6 letters
});
