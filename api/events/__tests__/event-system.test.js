"use strict";

const { describe, it, before, beforeEach, afterEach: _afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

// ============================================================================
// Shared mock infrastructure
// ============================================================================

// Mock logger — no-op for all levels
const mockLogger = {
  logInfo: mock.fn(),
  logWarn: mock.fn(),
  logError: mock.fn()
};

// Mock Redis state
let mockRedisData = {}; // key → value
let mockRedisError = null; // if set, throws on get/set

const _mockRedis = {
  get: mock.fn(async key => {
    if (mockRedisError) throw mockRedisError;
    return mockRedisData[key] !== undefined ? mockRedisData[key] : null;
  }),
  set: mock.fn(async (key, value) => {
    if (mockRedisError) throw mockRedisError;
    mockRedisData[key] = value;
    return "OK";
  })
};

// Mock fetch calls tracker
let mockFetchCalls = [];
let mockFetchResponses = {}; // url-pattern → response

const _originalFetch = global.fetch;
global.fetch = async (url, opts) => {
  mockFetchCalls.push({ url, opts });
  for (const [pattern, response] of Object.entries(mockFetchResponses)) {
    if (url.includes(pattern)) return response;
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "{}"
  };
};

// ============================================================================
// Module loader helpers
// ============================================================================

/**
 * Load normalize.js with mocked logger.
 */
function loadNormalize() {
  const logPath = require.resolve("../../lite/logger");
  const normPath = require.resolve("../utils/normalize");
  delete require.cache[normPath];
  delete require.cache[logPath];
  require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: mockLogger
  };
  return require("../utils/normalize");
}

/**
 * Load emit.js with mocked logger (and cleared router cache to avoid side effects).
 */
function loadEmit() {
  const logPath = require.resolve("../../lite/logger");
  const emitPath = require.resolve("../utils/emit");
  delete require.cache[emitPath];
  delete require.cache[logPath];
  require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: mockLogger
  };
  return require("../utils/emit");
}

/**
 * Load router.js with:
 *  - mocked logger
 *  - mocked idempotency module (uses mockRedis state)
 *  - mocked normalize (pass-through, real implementation)
 *  - optional handlerOverrides: { eventName: handlerFn }
 */
function loadRouter(handlerOverrides = {}) {
  const logPath = require.resolve("../../lite/logger");
  const idempPath = require.resolve("../utils/idempotency");
  const normPath = require.resolve("../utils/normalize");
  const routerPath = require.resolve("../router");

  // Clear all relevant caches
  delete require.cache[routerPath];
  delete require.cache[idempPath];
  delete require.cache[normPath];
  delete require.cache[logPath];

  // Inject mock logger
  require.cache[logPath] = {
    id: logPath,
    filename: logPath,
    loaded: true,
    exports: mockLogger
  };

  // Inject mock idempotency that uses mockRedis state
  require.cache[idempPath] = {
    id: idempPath,
    filename: idempPath,
    loaded: true,
    exports: {
      checkIdempotency: mock.fn(async key => {
        if (mockRedisError) throw mockRedisError;
        return mockRedisData["evt:" + key] !== undefined;
      }),
      markProcessed: mock.fn(async (key, meta) => {
        if (mockRedisError) throw mockRedisError;
        mockRedisData["evt:" + key] = JSON.stringify(meta);
        return true;
      }),
      _resetForTesting: () => {}
    }
  };

  // Load normalize normally (it requires logger which is already mocked)
  require.cache[normPath] = undefined; // ensure fresh load with mocked logger
  delete require.cache[normPath];

  const router = require("../router");

  // Patch handler cache for any overrides AFTER loading
  if (Object.keys(handlerOverrides).length > 0) {
    // Access the internal handlerCache by monkey-patching loadHandler behavior
    // We inject overrides via the module's internal require cache
    for (const [eventName, handlerFn] of Object.entries(handlerOverrides)) {
      // Get the handler module path from EVENT_HANDLERS
      const handlerModulePath = router.EVENT_HANDLERS[eventName];
      if (handlerModulePath) {
        try {
          const resolvedPath = require.resolve(handlerModulePath, {
            paths: [require.resolve("../router").replace(/router\.js$/, "")]
          });
          require.cache[resolvedPath] = {
            id: resolvedPath,
            filename: resolvedPath,
            loaded: true,
            exports: { handle: handlerFn }
          };
        } catch (_) {
          // Handler module path not resolvable yet — inject via fake resolved path
          // We'll use the string as-is with path resolution relative to router dir
          const path = require("path");
          const routerDir = path.dirname(require.resolve("../router"));
          const abs = path.resolve(routerDir, handlerModulePath);
          require.cache[abs] = {
            id: abs,
            filename: abs,
            loaded: true,
            exports: { handle: handlerFn }
          };
        }
      }
    }
    // Clear router cache again and reload so it picks up handler cache entries
    delete require.cache[routerPath];
    return require("../router");
  }

  return router;
}

// ============================================================================
// Fixtures
// ============================================================================

/** Minimal valid envelope for a known event */
function makeEnvelope(overrides = {}) {
  return {
    event_name: "fundhub.entry.captured",
    event_version: 1,
    event_id: "evt_test_abc123",
    idempotency_key: "entry.captured:test@example.com",
    occurred_at: new Date().toISOString(),
    source_system: "underwrite_iq_lite",
    contact: { email: "test@example.com" },
    payload: { entry_mode: "slo_deposit", offer_family: "slo" },
    ...overrides
  };
}

// ============================================================================
// SECTION 1 — normalize.js
// ============================================================================

describe("normalize.js", () => {
  let normalize;

  before(() => {
    normalize = loadNormalize();
  });

  // --------------------------------------------------------------------------
  // normalizeEmail
  // --------------------------------------------------------------------------
  describe("normalizeEmail", () => {
    it("lowercases and trims an email", () => {
      const { normalizeEmail } = normalize;
      assert.equal(normalizeEmail("  TEST@EXAMPLE.COM  "), "test@example.com");
    });

    it("lowercases mixed-case email", () => {
      const { normalizeEmail } = normalize;
      assert.equal(normalizeEmail("User.Name+TAG@Example.ORG"), "user.name+tag@example.org");
    });

    it("returns null for empty string", () => {
      const { normalizeEmail } = normalize;
      assert.equal(normalizeEmail(""), null);
    });

    it("returns null for whitespace-only string", () => {
      const { normalizeEmail } = normalize;
      assert.equal(normalizeEmail("   "), null);
    });

    it("returns null for null input", () => {
      const { normalizeEmail } = normalize;
      assert.equal(normalizeEmail(null), null);
    });

    it("returns null for undefined input", () => {
      const { normalizeEmail } = normalize;
      assert.equal(normalizeEmail(undefined), null);
    });

    it("returns null for non-string input", () => {
      const { normalizeEmail } = normalize;
      assert.equal(normalizeEmail(42), null);
    });
  });

  // --------------------------------------------------------------------------
  // normalizePhone
  // --------------------------------------------------------------------------
  describe("normalizePhone", () => {
    it("normalizes formatted US phone (555) 555-0123 → +15555550123", () => {
      const { normalizePhone } = normalize;
      assert.equal(normalizePhone("(555) 555-0123"), "+15555550123");
    });

    it("normalizes 10-digit number → +1XXXXXXXXXX", () => {
      const { normalizePhone } = normalize;
      assert.equal(normalizePhone("5555550123"), "+15555550123");
    });

    it("normalizes 11-digit with leading 1 → +1XXXXXXXXXX", () => {
      const { normalizePhone } = normalize;
      assert.equal(normalizePhone("15555550123"), "+15555550123");
    });

    it("passes through already-normalized +1XXXXXXXXXX", () => {
      const { normalizePhone } = normalize;
      assert.equal(normalizePhone("+15555550123"), "+15555550123");
    });

    it("strips dashes from 555-555-0123", () => {
      const { normalizePhone } = normalize;
      assert.equal(normalizePhone("555-555-0123"), "+15555550123");
    });

    it("returns null for too-short number (< 10 digits)", () => {
      const { normalizePhone } = normalize;
      assert.equal(normalizePhone("12345"), null);
    });

    it("returns null for empty string", () => {
      const { normalizePhone } = normalize;
      assert.equal(normalizePhone(""), null);
    });

    it("returns null for null input", () => {
      const { normalizePhone } = normalize;
      assert.equal(normalizePhone(null), null);
    });

    it("returns null for non-string input", () => {
      const { normalizePhone } = normalize;
      assert.equal(normalizePhone(5555550123), null);
    });
  });

  // --------------------------------------------------------------------------
  // validateEventPayload — all 8 canonical events
  // --------------------------------------------------------------------------
  describe("validateEventPayload", () => {
    it("fundhub.entry.captured: ok with entry_mode + offer_family", () => {
      const r = normalize.validateEventPayload("fundhub.entry.captured", {
        entry_mode: "slo_deposit",
        offer_family: "slo"
      });
      assert.equal(r.ok, true);
    });

    it("fundhub.entry.captured: fails when offer_family missing", () => {
      const r = normalize.validateEventPayload("fundhub.entry.captured", {
        entry_mode: "slo_deposit"
      });
      assert.equal(r.ok, false);
      assert.equal(r.error, "MISSING_PAYLOAD_FIELDS");
      assert.ok(r.details.missing.includes("offer_family"));
    });

    it("fundhub.entry.captured: fails when payload is null", () => {
      const r = normalize.validateEventPayload("fundhub.entry.captured", null);
      assert.equal(r.ok, false);
      assert.equal(r.error, "MISSING_PAYLOAD");
    });

    it("fundhub.deposit.paid: ok with transaction_id + gross_amount + credit_amount", () => {
      const r = normalize.validateEventPayload("fundhub.deposit.paid", {
        transaction_id: "TXN_123",
        gross_amount: 997,
        credit_amount: 0
      });
      assert.equal(r.ok, true);
    });

    it("fundhub.deposit.paid: fails when transaction_id missing", () => {
      const r = normalize.validateEventPayload("fundhub.deposit.paid", {
        gross_amount: 997,
        credit_amount: 0
      });
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("transaction_id"));
    });

    it("fundhub.analysis.requested: ok with analysis_request_id + method", () => {
      const r = normalize.validateEventPayload("fundhub.analysis.requested", {
        analysis_request_id: "ANL_123",
        method: "soft_pull"
      });
      assert.equal(r.ok, true);
    });

    it("fundhub.analysis.requested: fails when method missing", () => {
      const r = normalize.validateEventPayload("fundhub.analysis.requested", {
        analysis_request_id: "ANL_123"
      });
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("method"));
    });

    it("fundhub.analysis.completed: ok with recommendation + letters_ready", () => {
      const r = normalize.validateEventPayload("fundhub.analysis.completed", {
        recommendation: "FULL_FUNDING",
        letters_ready: true
      });
      assert.equal(r.ok, true);
    });

    it("fundhub.analysis.completed: fails when recommendation missing", () => {
      const r = normalize.validateEventPayload("fundhub.analysis.completed", {
        letters_ready: false
      });
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("recommendation"));
    });

    it("fundhub.booking.lane.decided: ok with booking_lane + reason", () => {
      const r = normalize.validateEventPayload("fundhub.booking.lane.decided", {
        booking_lane: "high_ticket",
        reason: "score_above_700"
      });
      assert.equal(r.ok, true);
    });

    it("fundhub.booking.lane.decided: fails when both fields missing", () => {
      const r = normalize.validateEventPayload("fundhub.booking.lane.decided", {});
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("booking_lane"));
      assert.ok(r.details.missing.includes("reason"));
    });

    it("fundhub.call.booked: ok with booking_id + appointment_start", () => {
      const r = normalize.validateEventPayload("fundhub.call.booked", {
        booking_id: "BOOK_456",
        appointment_start: "2026-04-10T14:00:00Z"
      });
      assert.equal(r.ok, true);
    });

    it("fundhub.call.booked: fails when appointment_start is empty string", () => {
      const r = normalize.validateEventPayload("fundhub.call.booked", {
        booking_id: "BOOK_456",
        appointment_start: ""
      });
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("appointment_start"));
    });

    it("fundhub.decision.recorded: ok with decision_status", () => {
      const r = normalize.validateEventPayload("fundhub.decision.recorded", {
        decision_status: "approved"
      });
      assert.equal(r.ok, true);
    });

    it("fundhub.decision.recorded: fails when decision_status is null", () => {
      const r = normalize.validateEventPayload("fundhub.decision.recorded", {
        decision_status: null
      });
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("decision_status"));
    });

    it("fundhub.sale.closed: ok with all three required fields", () => {
      const r = normalize.validateEventPayload("fundhub.sale.closed", {
        service_selected: "credit_repair",
        contract_value: 1997,
        deposit_credit_applied: 997
      });
      assert.equal(r.ok, true);
    });

    it("fundhub.sale.closed: fails when contract_value + deposit_credit_applied missing", () => {
      const r = normalize.validateEventPayload("fundhub.sale.closed", {
        service_selected: "credit_repair"
      });
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("contract_value"));
      assert.ok(r.details.missing.includes("deposit_credit_applied"));
    });

    it("unknown event: returns ok=true (unknown events pass through)", () => {
      const r = normalize.validateEventPayload("fundhub.unknown.event", { foo: "bar" });
      assert.equal(r.ok, true);
    });
  });

  // --------------------------------------------------------------------------
  // validateContactIdentity
  // --------------------------------------------------------------------------
  describe("validateContactIdentity", () => {
    it("ok when ghl_contact_id is provided", () => {
      const r = normalize.validateContactIdentity({ ghl_contact_id: "abc123" });
      assert.equal(r.ok, true);
    });

    it("ok when email is provided", () => {
      const r = normalize.validateContactIdentity({ email: "test@example.com" });
      assert.equal(r.ok, true);
    });

    it("ok when phone is provided", () => {
      const r = normalize.validateContactIdentity({ phone: "+15555550123" });
      assert.equal(r.ok, true);
    });

    it("ok when all three identifiers are provided", () => {
      const r = normalize.validateContactIdentity({
        ghl_contact_id: "abc",
        email: "test@example.com",
        phone: "+15555550123"
      });
      assert.equal(r.ok, true);
    });

    it("fails when contact is an empty object", () => {
      const r = normalize.validateContactIdentity({});
      assert.equal(r.ok, false);
      assert.equal(r.error, "NO_CONTACT_IDENTITY");
    });

    it("fails when contact is null", () => {
      const r = normalize.validateContactIdentity(null);
      assert.equal(r.ok, false);
      assert.equal(r.error, "MISSING_CONTACT");
    });

    it("fails when contact is not an object", () => {
      const r = normalize.validateContactIdentity("not-an-object");
      assert.equal(r.ok, false);
      assert.equal(r.error, "MISSING_CONTACT");
    });

    it("fails when all identifiers are empty strings", () => {
      const r = normalize.validateContactIdentity({
        ghl_contact_id: "",
        email: "",
        phone: ""
      });
      assert.equal(r.ok, false);
      assert.equal(r.error, "NO_CONTACT_IDENTITY");
    });
  });
});

// ============================================================================
// SECTION 2 — emit.js
// ============================================================================

describe("emit.js", () => {
  let emit;

  before(() => {
    emit = loadEmit();
  });

  // --------------------------------------------------------------------------
  // generateEventId
  // --------------------------------------------------------------------------
  describe("generateEventId", () => {
    it("starts with evt_", () => {
      const { generateEventId } = emit;
      const id = generateEventId();
      assert.ok(id.startsWith("evt_"), `Expected evt_ prefix, got: ${id}`);
    });

    it("generates unique IDs on successive calls", () => {
      const { generateEventId } = emit;
      const ids = new Set(Array.from({ length: 20 }, () => generateEventId()));
      assert.equal(ids.size, 20, "Expected all 20 IDs to be unique");
    });

    it("has the format evt_{base36}_{hex}", () => {
      const { generateEventId } = emit;
      const id = generateEventId();
      // format: evt_<timestamp-base36>_<12-char-hex>
      assert.match(id, /^evt_[0-9a-z]+_[0-9a-f]{12}$/);
    });
  });

  // --------------------------------------------------------------------------
  // generateIdempotencyKey
  // --------------------------------------------------------------------------
  describe("generateIdempotencyKey", () => {
    it("strips fundhub. prefix and appends entityId", () => {
      const { generateIdempotencyKey } = emit;
      const key = generateIdempotencyKey("fundhub.analysis.completed", "ANL_123");
      assert.equal(key, "analysis.completed:ANL_123");
    });

    it("is deterministic for the same inputs", () => {
      const { generateIdempotencyKey } = emit;
      const key1 = generateIdempotencyKey("fundhub.deposit.paid", "TXN_456");
      const key2 = generateIdempotencyKey("fundhub.deposit.paid", "TXN_456");
      assert.equal(key1, key2);
    });

    it("produces different keys for different entityIds", () => {
      const { generateIdempotencyKey } = emit;
      const key1 = generateIdempotencyKey("fundhub.deposit.paid", "TXN_001");
      const key2 = generateIdempotencyKey("fundhub.deposit.paid", "TXN_002");
      assert.notEqual(key1, key2);
    });

    it("produces different keys for different event names", () => {
      const { generateIdempotencyKey } = emit;
      const key1 = generateIdempotencyKey("fundhub.deposit.paid", "ID_123");
      const key2 = generateIdempotencyKey("fundhub.analysis.completed", "ID_123");
      assert.notEqual(key1, key2);
    });

    it("works without fundhub. prefix", () => {
      const { generateIdempotencyKey } = emit;
      const key = generateIdempotencyKey("entry.captured", "john@example.com");
      assert.equal(key, "entry.captured:john@example.com");
    });
  });

  // --------------------------------------------------------------------------
  // buildEnvelope
  // --------------------------------------------------------------------------
  describe("buildEnvelope", () => {
    it("fills default event_version=1 when not provided", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: { email: "a@b.com" },
        payload: {}
      });
      assert.equal(env.event_version, 1);
    });

    it("auto-generates event_id with evt_ prefix", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {},
        payload: {}
      });
      assert.ok(env.event_id.startsWith("evt_"));
    });

    it("preserves provided event_id", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {},
        payload: {},
        event_id: "evt_custom_id_001"
      });
      assert.equal(env.event_id, "evt_custom_id_001");
    });

    it("auto-generates occurred_at as ISO string", () => {
      const { buildEnvelope } = emit;
      const before = new Date();
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {},
        payload: {}
      });
      const after = new Date();
      const ts = new Date(env.occurred_at);
      assert.ok(!Number.isNaN(ts.getTime()), "occurred_at should be a valid date");
      assert.ok(ts >= before && ts <= after, "occurred_at should be between before and after");
    });

    it("preserves provided occurred_at", () => {
      const { buildEnvelope } = emit;
      const ts = "2026-01-01T00:00:00.000Z";
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {},
        payload: {},
        occurred_at: ts
      });
      assert.equal(env.occurred_at, ts);
    });

    it("auto-generates idempotency_key from event_name + contact.email", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: { email: "test@example.com" },
        payload: {}
      });
      assert.equal(env.idempotency_key, "entry.captured:test@example.com");
    });

    it("preserves provided idempotency_key", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {},
        payload: {},
        idempotency_key: "custom:key:123"
      });
      assert.equal(env.idempotency_key, "custom:key:123");
    });

    it("sets correlation_id to null when not provided", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {},
        payload: {}
      });
      assert.equal(env.correlation_id, null);
    });

    it("preserves correlation_id when provided", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {},
        payload: {},
        correlation_id: "journey_ABC123"
      });
      assert.equal(env.correlation_id, "journey_ABC123");
    });

    it("includes adapter block when provided", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {},
        payload: {},
        adapter: { entry_mode: "slo_deposit", funnel_family: "slo" }
      });
      assert.deepEqual(env.adapter, { entry_mode: "slo_deposit", funnel_family: "slo" });
    });

    it("omits adapter key when not provided", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {},
        payload: {}
      });
      assert.equal("adapter" in env, false);
    });

    it("throws when event_name is missing", () => {
      const { buildEnvelope } = emit;
      assert.throws(
        () => buildEnvelope({ source_system: "test", contact: {}, payload: {} }),
        /event_name is required/
      );
    });

    it("throws when source_system is missing", () => {
      const { buildEnvelope } = emit;
      assert.throws(
        () => buildEnvelope({ event_name: "fundhub.entry.captured", contact: {}, payload: {} }),
        /source_system is required/
      );
    });

    it("defaults empty payload to {}", () => {
      const { buildEnvelope } = emit;
      const env = buildEnvelope({
        event_name: "fundhub.entry.captured",
        source_system: "test_system",
        contact: {}
      });
      assert.deepEqual(env.payload, {});
    });
  });
});

// ============================================================================
// SECTION 3 — router.js (validateEnvelope + routeEvent)
// ============================================================================

describe("router.js", () => {
  let router;

  beforeEach(() => {
    // Reset shared state before each test
    mockRedisData = {};
    mockRedisError = null;
    mockFetchCalls = [];
    mockFetchResponses = {};
    // Reset logger mocks
    mockLogger.logInfo.mock.resetCalls();
    mockLogger.logWarn.mock.resetCalls();
    mockLogger.logError.mock.resetCalls();
  });

  // --------------------------------------------------------------------------
  // validateEnvelope — envelope shape checks
  // --------------------------------------------------------------------------
  describe("validateEnvelope", () => {
    before(() => {
      router = loadRouter();
    });

    it("ok for a valid envelope", () => {
      const env = makeEnvelope();
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, true);
    });

    it("fails for null input", () => {
      const r = router.validateEnvelope(null);
      assert.equal(r.ok, false);
      assert.equal(r.error, "INVALID_ENVELOPE");
    });

    it("fails when event_name is missing", () => {
      const env = makeEnvelope({ event_name: "" });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "MISSING_FIELDS");
      assert.ok(r.details.missing.includes("event_name"));
    });

    it("fails when event_version is missing", () => {
      const env = makeEnvelope({ event_version: null });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "MISSING_FIELDS");
      assert.ok(r.details.missing.includes("event_version"));
    });

    it("fails when event_id is missing", () => {
      const env = makeEnvelope({ event_id: "" });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("event_id"));
    });

    it("fails when idempotency_key is missing", () => {
      const env = makeEnvelope({ idempotency_key: "" });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("idempotency_key"));
    });

    it("fails when occurred_at is missing", () => {
      const env = makeEnvelope({ occurred_at: "" });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("occurred_at"));
    });

    it("fails when source_system is missing", () => {
      const env = makeEnvelope({ source_system: "" });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.ok(r.details.missing.includes("source_system"));
    });

    it("fails for unknown event_name", () => {
      const env = makeEnvelope({ event_name: "fundhub.completely.unknown" });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "UNKNOWN_EVENT");
    });

    it("fails when event_version is 0", () => {
      const env = makeEnvelope({ event_version: 0 });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "INVALID_VERSION");
    });

    it("fails when event_version is negative", () => {
      const env = makeEnvelope({ event_version: -1 });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "INVALID_VERSION");
    });

    it("fails when event_version is a float", () => {
      const env = makeEnvelope({ event_version: 1.5 });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "INVALID_VERSION");
    });

    it("fails when event_version is a string", () => {
      const env = makeEnvelope({ event_version: "1" });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "INVALID_VERSION");
    });

    it("fails when occurred_at is not a valid ISO string", () => {
      const env = makeEnvelope({ occurred_at: "not-a-date" });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "INVALID_TIMESTAMP");
    });

    it("fails when contact is missing", () => {
      const env = makeEnvelope({ contact: null });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "MISSING_CONTACT");
    });

    it("fails when contact is not an object", () => {
      const env = makeEnvelope({ contact: "string-contact" });
      const r = router.validateEnvelope(env);
      assert.equal(r.ok, false);
      assert.equal(r.error, "MISSING_CONTACT");
    });

    it("passes for all 8 known canonical event names", () => {
      const knownEvents = [
        "fundhub.entry.captured",
        "fundhub.deposit.paid",
        "fundhub.analysis.requested",
        "fundhub.analysis.completed",
        "fundhub.booking.lane.decided",
        "fundhub.call.booked",
        "fundhub.decision.recorded",
        "fundhub.sale.closed"
      ];
      for (const event_name of knownEvents) {
        const env = makeEnvelope({ event_name });
        const r = router.validateEnvelope(env);
        assert.equal(r.ok, true, `validateEnvelope should pass for ${event_name}`);
      }
    });
  });

  // --------------------------------------------------------------------------
  // routeEvent — duplicate detection via Redis
  // --------------------------------------------------------------------------
  describe("routeEvent — idempotency (duplicate skip)", () => {
    it("returns status=duplicate when idempotency key is already in Redis", async () => {
      // Pre-seed mockRedisData so checkIdempotency returns true
      const key = "entry.captured:test@example.com";
      mockRedisData["evt:" + key] = JSON.stringify({ event_id: "evt_previous" });

      router = loadRouter();
      const env = makeEnvelope({ idempotency_key: key });
      const result = await router.routeEvent(env);

      assert.equal(result.ok, true);
      assert.equal(result.status, "duplicate");
      assert.match(result.message, /already processed/i);
    });

    it("proceeds to dispatch when key is NOT in Redis", async () => {
      // No handler will be available (stubs not built), so we expect HANDLER_NOT_AVAILABLE
      mockRedisData = {};
      router = loadRouter();
      const env = makeEnvelope();
      const result = await router.routeEvent(env);

      // Not a duplicate — should have tried to dispatch
      assert.notEqual(result.status, "duplicate");
    });
  });

  // --------------------------------------------------------------------------
  // routeEvent — validation errors propagate
  // --------------------------------------------------------------------------
  describe("routeEvent — envelope validation errors", () => {
    before(() => {
      router = loadRouter();
    });

    it("returns error when event_name is missing", async () => {
      const env = makeEnvelope({ event_name: "" });
      const result = await router.routeEvent(env);
      assert.equal(result.ok, false);
      assert.equal(result.error, "MISSING_FIELDS");
    });

    it("returns UNKNOWN_EVENT for unrecognized event_name", async () => {
      const env = makeEnvelope({ event_name: "fundhub.not.real" });
      const result = await router.routeEvent(env);
      assert.equal(result.ok, false);
      assert.equal(result.error, "UNKNOWN_EVENT");
    });

    it("returns INVALID_VERSION for event_version=0", async () => {
      const env = makeEnvelope({ event_version: 0 });
      const result = await router.routeEvent(env);
      assert.equal(result.ok, false);
      assert.equal(result.error, "INVALID_VERSION");
    });

    it("returns INVALID_TIMESTAMP for non-ISO occurred_at", async () => {
      const env = makeEnvelope({ occurred_at: "yesterday" });
      const result = await router.routeEvent(env);
      assert.equal(result.ok, false);
      assert.equal(result.error, "INVALID_TIMESTAMP");
    });

    it("returns MISSING_FIELDS when multiple required fields absent", async () => {
      const result = await router.routeEvent({
        event_name: "fundhub.entry.captured",
        contact: {},
        payload: {}
        // missing: event_version, event_id, idempotency_key, occurred_at, source_system
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "MISSING_FIELDS");
    });
  });

  // --------------------------------------------------------------------------
  // routeEvent — dispatches to correct handler
  // --------------------------------------------------------------------------
  describe("routeEvent — handler dispatch", () => {
    it("calls the registered handler and returns its result", async () => {
      const mockHandlerResult = { action_taken: "contact_updated", ghl_contact_id: "CTX_001" };
      const mockHandlerFn = mock.fn(async () => mockHandlerResult);

      router = loadRouter({ "fundhub.entry.captured": mockHandlerFn });

      const env = makeEnvelope();
      const result = await router.routeEvent(env);

      assert.equal(result.ok, true);
      assert.equal(result.status, "processed");
      assert.deepEqual(result.result, mockHandlerResult);
      assert.equal(mockHandlerFn.mock.calls.length, 1);
    });

    it("passes the full envelope to the handler", async () => {
      let capturedEnvelope = null;
      const mockHandlerFn = mock.fn(async envelope => {
        capturedEnvelope = envelope;
        return { ok: true };
      });

      router = loadRouter({ "fundhub.entry.captured": mockHandlerFn });

      const env = makeEnvelope({
        correlation_id: "journey_XYZ999",
        payload: { entry_mode: "slo_deposit", offer_family: "slo" }
      });
      await router.routeEvent(env);

      assert.ok(capturedEnvelope !== null);
      assert.equal(capturedEnvelope.correlation_id, "journey_XYZ999");
      assert.equal(capturedEnvelope.payload.entry_mode, "slo_deposit");
    });

    it("loadHandler returns null for a nonexistent event module", () => {
      // The HANDLER_NOT_AVAILABLE path in routeEvent is exercised when loadHandler() returns null.
      // We verify this indirectly by confirming loadHandler returns null for a module that
      // doesn't exist on disk. We do this by temporarily patching EVENT_HANDLERS in a fresh router
      // instance to point to a non-existent path.
      const _path = require("path");
      const routerPath = require.resolve("../router");
      delete require.cache[routerPath];
      const freshRouter = require("../router");

      // Directly call the exposed loadHandler with an event that maps to a bogus path.
      // We achieve this by temporarily overriding EVENT_HANDLERS (the exported object is the
      // same reference used internally).
      const origPath = freshRouter.EVENT_HANDLERS["fundhub.entry.captured"];
      freshRouter.EVENT_HANDLERS["fundhub.entry.captured"] = "./handlers/__nonexistent__";

      const result = freshRouter.loadHandler("fundhub.entry.captured");

      // Restore
      freshRouter.EVENT_HANDLERS["fundhub.entry.captured"] = origPath;

      assert.equal(result, null, "loadHandler should return null for a non-existent module");
    });

    it("returns HANDLER_ERROR when handler throws", async () => {
      const throwingHandler = mock.fn(async () => {
        throw new Error("handler blew up");
      });

      router = loadRouter({ "fundhub.entry.captured": throwingHandler });

      const env = makeEnvelope();
      const result = await router.routeEvent(env);

      assert.equal(result.ok, false);
      assert.equal(result.error, "HANDLER_ERROR");
      assert.match(result.message, /handler blew up/);
      assert.equal(result.status, 500);
    });

    it("marks event as processed in Redis after successful handler", async () => {
      mockRedisData = {};
      const mockHandlerFn = mock.fn(async () => ({ done: true }));
      router = loadRouter({ "fundhub.entry.captured": mockHandlerFn });

      const env = makeEnvelope({ idempotency_key: "entry.captured:mark-test" });
      await router.routeEvent(env);

      const stored = mockRedisData["evt:entry.captured:mark-test"];
      assert.ok(stored, "Expected idempotency key to be stored after successful handler");
    });

    it("continues processing even when Redis throws on checkIdempotency", async () => {
      mockRedisError = new Error("Redis connection refused");
      const mockHandlerFn = mock.fn(async () => ({ done: true }));

      router = loadRouter({ "fundhub.entry.captured": mockHandlerFn });
      const env = makeEnvelope();

      // Should NOT throw — router degrades gracefully
      const result = await router.routeEvent(env);
      // Handler should still be called (or HANDLER_NOT_AVAILABLE, not a Redis error)
      assert.notEqual(result.error, "REDIS_ERROR");
    });
  });

  // --------------------------------------------------------------------------
  // routeEvent — payload validation is enforced
  // --------------------------------------------------------------------------
  describe("routeEvent — payload validation", () => {
    before(() => {
      router = loadRouter();
    });

    it("rejects fundhub.entry.captured with missing offer_family", async () => {
      const env = makeEnvelope({
        payload: { entry_mode: "slo_deposit" } // missing offer_family
      });
      const result = await router.routeEvent(env);
      assert.equal(result.ok, false);
      assert.equal(result.error, "MISSING_PAYLOAD_FIELDS");
    });

    it("accepts fundhub.entry.captured with all required payload fields", async () => {
      const env = makeEnvelope({
        payload: { entry_mode: "slo_deposit", offer_family: "slo" }
      });
      // No handler available, but validation should pass first
      const result = await router.routeEvent(env);
      // Either HANDLER_NOT_AVAILABLE or processed — not a payload error
      assert.notEqual(result.error, "MISSING_PAYLOAD_FIELDS");
    });
  });
});
