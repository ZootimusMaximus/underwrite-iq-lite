"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Mock runSweep before requiring the cron handler
// ---------------------------------------------------------------------------

// We intercept the require cache so the cron module picks up our mock.
// Node's module system is synchronous — override before first require.

let mockRunSweep;

// Save and restore require cache around each test group so env var mutations
// don't leak across test isolation.
function buildMocks({ runSweepImpl } = {}) {
  mockRunSweep = runSweepImpl || (async () => ({ scored: 5, errors: 1 }));

  // Stub behavior-score module in require cache
  const behaviorScorePath = require.resolve("../behavior-score");
  const cronPath = require.resolve("../behavior-score-cron");

  // Clear both from cache so we get a fresh require with our stub
  delete require.cache[behaviorScorePath];
  delete require.cache[cronPath];

  // Install stub
  require.cache[behaviorScorePath] = {
    id: behaviorScorePath,
    filename: behaviorScorePath,
    loaded: true,
    exports: Object.assign(async () => {}, { runSweep: (...args) => mockRunSweep(...args) })
  };

  return require("../behavior-score-cron");
}

function cleanup() {
  delete require.cache[require.resolve("../behavior-score")];
  delete require.cache[require.resolve("../behavior-score-cron")];
}

// ---------------------------------------------------------------------------
// Minimal res mock
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    }
  };
  return res;
}

function makeReq({ method = "GET", authHeader } = {}) {
  const headers = {};
  if (authHeader !== undefined) headers["authorization"] = authHeader;
  return { method, headers };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("behavior-score-cron", () => {
  const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

  afterEach(() => {
    // Restore env + cache
    if (ORIGINAL_CRON_SECRET === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
    }
    cleanup();
  });

  // ── Auth: CRON_SECRET set, no Authorization header → 401 ─────────────────

  it("returns 401 when CRON_SECRET is set and Authorization header is missing", async () => {
    process.env.CRON_SECRET = "test-secret-abc";
    const handler = buildMocks();

    const req = makeReq({ method: "GET" }); // no authHeader
    const res = makeRes();

    await handler(req, res);

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { ok: false, error: "Unauthorized" });
  });

  // ── Auth: wrong secret → 401 ─────────────────────────────────────────────

  it("returns 401 when Authorization header has wrong secret", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const handler = buildMocks();

    const req = makeReq({ method: "GET", authHeader: "Bearer wrong-secret" });
    const res = makeRes();

    await handler(req, res);

    assert.equal(res._status, 401);
    assert.deepEqual(res._body, { ok: false, error: "Unauthorized" });
  });

  // ── Auth: correct secret → 200 + summary ─────────────────────────────────

  it("returns 200 with scored/errors summary when secret is correct", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const handler = buildMocks({ runSweepImpl: async () => ({ scored: 10, errors: 2 }) });

    const req = makeReq({ method: "GET", authHeader: "Bearer correct-secret" });
    const res = makeRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { ok: true, scored: 10, errors: 2 });
  });

  // ── Sweep is invoked when auth passes ────────────────────────────────────

  it("invokes runSweep exactly once when auth passes", async () => {
    process.env.CRON_SECRET = "s3cr3t";
    let calls = 0;
    const handler = buildMocks({
      runSweepImpl: async () => {
        calls++;
        return { scored: 3, errors: 0 };
      }
    });

    const req = makeReq({ method: "GET", authHeader: "Bearer s3cr3t" });
    const res = makeRes();

    await handler(req, res);

    assert.equal(calls, 1);
    assert.equal(res._status, 200);
  });

  // ── 500 on sweep throw ────────────────────────────────────────────────────

  it("returns 500 when runSweep throws", async () => {
    process.env.CRON_SECRET = "s3cr3t";
    const handler = buildMocks({
      runSweepImpl: async () => {
        throw new Error("Airtable exploded");
      }
    });

    const req = makeReq({ method: "GET", authHeader: "Bearer s3cr3t" });
    const res = makeRes();

    await handler(req, res);

    assert.equal(res._status, 500);
    assert.equal(res._body.ok, false);
    assert.equal(res._body.error, "Airtable exploded");
  });

  // ── Dev mode: CRON_SECRET unset → allow ──────────────────────────────────

  it("allows request without Authorization when CRON_SECRET is unset (dev mode)", async () => {
    delete process.env.CRON_SECRET;
    const handler = buildMocks({ runSweepImpl: async () => ({ scored: 7, errors: 0 }) });

    const req = makeReq({ method: "GET" }); // no auth header, no secret set
    const res = makeRes();

    await handler(req, res);

    assert.equal(res._status, 200);
    assert.deepEqual(res._body, { ok: true, scored: 7, errors: 0 });
  });

  // ── Wrong HTTP method → 405 ───────────────────────────────────────────────

  it("returns 405 for non-GET requests", async () => {
    process.env.CRON_SECRET = "s3cr3t";
    const handler = buildMocks();

    const req = makeReq({ method: "POST", authHeader: "Bearer s3cr3t" });
    const res = makeRes();

    await handler(req, res);

    assert.equal(res._status, 405);
    assert.deepEqual(res._body, { ok: false, error: "Method not allowed" });
  });
});
