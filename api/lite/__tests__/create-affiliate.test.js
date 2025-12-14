const test = require("node:test");
const assert = require("node:assert/strict");

// Mock response object
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
  return res;
}

// ============================================================================
// CORS / OPTIONS tests
// ============================================================================
test("create-affiliate handles OPTIONS request", async () => {
  // Mock rate limiter
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  const handler = require("../create-affiliate");
  const req = { method: "OPTIONS" };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");
  assert.ok(res.headers["Access-Control-Allow-Methods"].includes("POST"));
  assert.equal(res.ended, true);

  // Restore
  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate rejects non-POST methods", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  // Clear cache to get fresh handler
  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = { method: "GET" };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.msg.includes("not allowed"));

  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate sets CORS headers", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = { method: "POST", body: {} };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.headers["Access-Control-Allow-Origin"], "*");

  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

// ============================================================================
// Validation tests
// ============================================================================
test("create-affiliate rejects missing email", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { name: "John Doe", phone: "1234567890" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.msg.includes("Email"));

  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate handles string body (JSON)", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: JSON.stringify({ name: "John Doe" }) // Missing email
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);
  assert.ok(res.body.msg.includes("Email"));

  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate handles empty body", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: {}
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate handles null body", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: null
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);

  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

// ============================================================================
// Rate limiting tests
// ============================================================================
test("create-affiliate respects rate limiting", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;

  // Mock rate limiter to return false (blocked)
  let rateLimitCalled = false;
  rateLimiter.rateLimitMiddleware = async (req, res) => {
    rateLimitCalled = true;
    res.status(429).json({ ok: false, msg: "Rate limited" });
    return false;
  };

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { email: "test@test.com" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(rateLimitCalled, true);
  assert.equal(res.statusCode, 429);

  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

// ============================================================================
// GHL integration tests (with mocked services)
// ============================================================================
test("create-affiliate uses existing contact if found", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  const ghlService = require("../ghl-contact-service");
  const originalFindContact = ghlService.findContactByEmail;
  const originalCreateAffiliate = ghlService.createAffiliate;

  // Mock finding existing contact
  ghlService.findContactByEmail = async () => ({
    id: "existing-contact-123",
    email: "test@test.com"
  });

  // Mock affiliate creation
  ghlService.createAffiliate = async () => ({
    ok: true,
    affiliateId: "affiliate-456",
    referralUrl: "https://fundhub.ai/ref/abc123"
  });

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { email: "test@test.com", name: "John Doe" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.contactId, "existing-contact-123");

  // Restore
  ghlService.findContactByEmail = originalFindContact;
  ghlService.createAffiliate = originalCreateAffiliate;
  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate creates new contact when not found", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  const ghlService = require("../ghl-contact-service");
  const originalFindContact = ghlService.findContactByEmail;
  const originalCreateOrUpdate = ghlService.createOrUpdateContact;
  const originalCreateAffiliate = ghlService.createAffiliate;

  // Mock no existing contact
  ghlService.findContactByEmail = async () => null;

  // Mock contact creation
  ghlService.createOrUpdateContact = async () => ({
    ok: true,
    contactId: "new-contact-789"
  });

  // Mock affiliate creation
  ghlService.createAffiliate = async () => ({
    ok: true,
    affiliateId: "affiliate-456"
  });

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { email: "new@test.com", name: "Jane Doe", phone: "5551234567" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.contactId, "new-contact-789");

  // Restore
  ghlService.findContactByEmail = originalFindContact;
  ghlService.createOrUpdateContact = originalCreateOrUpdate;
  ghlService.createAffiliate = originalCreateAffiliate;
  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate handles contact creation failure", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  const ghlService = require("../ghl-contact-service");
  const originalFindContact = ghlService.findContactByEmail;
  const originalCreateOrUpdate = ghlService.createOrUpdateContact;

  ghlService.findContactByEmail = async () => null;
  ghlService.createOrUpdateContact = async () => ({
    ok: false,
    error: "API error"
  });

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { email: "fail@test.com", name: "Fail User" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);
  assert.ok(res.body.msg.includes("Failed"));

  // Restore
  ghlService.findContactByEmail = originalFindContact;
  ghlService.createOrUpdateContact = originalCreateOrUpdate;
  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate handles affiliate creation failure", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  const ghlService = require("../ghl-contact-service");
  const originalFindContact = ghlService.findContactByEmail;
  const originalCreateAffiliate = ghlService.createAffiliate;

  ghlService.findContactByEmail = async () => ({
    id: "contact-123",
    email: "test@test.com"
  });
  ghlService.createAffiliate = async () => ({
    ok: false,
    error: "Affiliate API error"
  });

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { email: "test@test.com" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, false);
  assert.ok(res.body.msg.includes("affiliate"));

  // Restore
  ghlService.findContactByEmail = originalFindContact;
  ghlService.createAffiliate = originalCreateAffiliate;
  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate handles already existing affiliate", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  const ghlService = require("../ghl-contact-service");
  const originalFindContact = ghlService.findContactByEmail;
  const originalCreateAffiliate = ghlService.createAffiliate;

  ghlService.findContactByEmail = async () => ({
    id: "contact-123",
    email: "existing@test.com"
  });
  ghlService.createAffiliate = async () => ({
    ok: true,
    alreadyExists: true
  });

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { email: "existing@test.com" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.alreadyAffiliate, true);
  assert.ok(res.body.msg.includes("already"));

  // Restore
  ghlService.findContactByEmail = originalFindContact;
  ghlService.createAffiliate = originalCreateAffiliate;
  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate generates referral URL with refId", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  const ghlService = require("../ghl-contact-service");
  const originalFindContact = ghlService.findContactByEmail;
  const originalCreateAffiliate = ghlService.createAffiliate;

  ghlService.findContactByEmail = async () => ({
    id: "contact-123"
  });
  ghlService.createAffiliate = async () => ({
    ok: true,
    affiliateId: "aff-456"
  });

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { email: "test@test.com", refId: "custom-ref-id" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, true);
  assert.ok(res.body.referralUrl.includes("custom-ref-id"));

  // Restore
  ghlService.findContactByEmail = originalFindContact;
  ghlService.createAffiliate = originalCreateAffiliate;
  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

test("create-affiliate uses referralUrl from affiliate response", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  const ghlService = require("../ghl-contact-service");
  const originalFindContact = ghlService.findContactByEmail;
  const originalCreateAffiliate = ghlService.createAffiliate;

  ghlService.findContactByEmail = async () => ({
    id: "contact-123"
  });
  ghlService.createAffiliate = async () => ({
    ok: true,
    affiliateId: "aff-456",
    referralUrl: "https://custom.ghl.url/ref/xyz"
  });

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { email: "test@test.com" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.body.ok, true);
  assert.equal(res.body.referralUrl, "https://custom.ghl.url/ref/xyz");

  // Restore
  ghlService.findContactByEmail = originalFindContact;
  ghlService.createAffiliate = originalCreateAffiliate;
  rateLimiter.rateLimitMiddleware = originalMiddleware;
});

// ============================================================================
// Error handling tests
// ============================================================================
test("create-affiliate handles unexpected exceptions", async () => {
  const rateLimiter = require("../rate-limiter");
  const originalMiddleware = rateLimiter.rateLimitMiddleware;
  rateLimiter.rateLimitMiddleware = async () => true;

  const ghlService = require("../ghl-contact-service");
  const originalFindContact = ghlService.findContactByEmail;

  // Make findContactByEmail throw
  ghlService.findContactByEmail = async () => {
    throw new Error("Unexpected error");
  };

  delete require.cache[require.resolve("../create-affiliate")];
  const handler = require("../create-affiliate");

  const req = {
    method: "POST",
    body: { email: "test@test.com" }
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.msg.includes("Failed"));

  // Restore
  ghlService.findContactByEmail = originalFindContact;
  rateLimiter.rateLimitMiddleware = originalMiddleware;
});
