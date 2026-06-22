"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const handler = require("../health-monitor");
const { validateCronAuth, runHealthChecks, sendHealthAlert } = handler;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(method, headers = {}) {
  return { method, headers };
}

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = code => {
    res._status = code;
    return res;
  };
  res.json = body => {
    res._body = body;
    return res;
  };
  return res;
}

function mockFetchAll200() {
  return async (_url, _opts, _timeout) => ({ status: 200, ok: true });
}

// ─── validateCronAuth ─────────────────────────────────────────────────────────

describe("validateCronAuth", () => {
  let savedSecret;

  beforeEach(() => {
    savedSecret = process.env.CRON_SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = savedSecret;
    }
  });

  it("allows when CRON_SECRET unset", () => {
    delete process.env.CRON_SECRET;
    const result = validateCronAuth(makeReq("GET", {}));
    assert.equal(result.ok, true);
  });

  it("allows valid Bearer token", () => {
    process.env.CRON_SECRET = "testsecret";
    const result = validateCronAuth(makeReq("GET", { authorization: "Bearer testsecret" }));
    assert.equal(result.ok, true);
  });

  it("rejects missing token", () => {
    process.env.CRON_SECRET = "testsecret";
    const result = validateCronAuth(makeReq("GET", {}));
    assert.equal(result.ok, false);
  });

  it("rejects wrong token", () => {
    process.env.CRON_SECRET = "testsecret";
    const result = validateCronAuth(makeReq("GET", { authorization: "Bearer wrongtoken" }));
    assert.equal(result.ok, false);
  });
});

// ─── runHealthChecks — all pass ───────────────────────────────────────────────

describe("runHealthChecks — all pass", () => {
  let savedEnv = {};

  beforeEach(() => {
    savedEnv = {
      AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
      AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
      GHL_LOCATION_ID: process.env.GHL_LOCATION_ID,
      GHL_PRIVATE_API_KEY: process.env.GHL_PRIVATE_API_KEY,
      CONTEXT_FETCHER_SECRET: process.env.CONTEXT_FETCHER_SECRET
    };
    process.env.AIRTABLE_BASE_ID = "appTestBase";
    process.env.AIRTABLE_API_KEY = "key_test";
    process.env.GHL_LOCATION_ID = "loc_test";
    process.env.GHL_PRIVATE_API_KEY = "ghl_test";
    process.env.CONTEXT_FETCHER_SECRET = "ctx_test";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns 5 checks all ok when all fetches return 200", async () => {
    const checks = await runHealthChecks(mockFetchAll200());
    assert.equal(checks.length, 5);
    for (const c of checks) {
      assert.equal(c.ok, true, `Expected ${c.name} to be ok`);
      assert.ok("name" in c);
      assert.ok("ok" in c);
      assert.ok("detail" in c);
      assert.ok("latencyMs" in c);
    }
    assert.equal(
      checks.every(c => c.ok),
      true
    );
  });
});

// ─── runHealthChecks — one check fails ───────────────────────────────────────

describe("runHealthChecks — one check fails", () => {
  let savedEnv = {};

  beforeEach(() => {
    savedEnv = {
      AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
      AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
      GHL_LOCATION_ID: process.env.GHL_LOCATION_ID,
      GHL_PRIVATE_API_KEY: process.env.GHL_PRIVATE_API_KEY,
      CONTEXT_FETCHER_SECRET: process.env.CONTEXT_FETCHER_SECRET,
      IRA_BASE_URL: process.env.IRA_BASE_URL
    };
    process.env.AIRTABLE_BASE_ID = "appTestBase";
    process.env.AIRTABLE_API_KEY = "key_test";
    process.env.GHL_LOCATION_ID = "loc_test";
    process.env.GHL_PRIVATE_API_KEY = "ghl_test";
    process.env.CONTEXT_FETCHER_SECRET = "ctx_test";
    process.env.IRA_BASE_URL = "https://inquiry-removal-ai-sigma.vercel.app";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("marks InquiryRemovalAI as failing when it returns 500", async () => {
    const mockFetch = async (url, _opts, _timeout) => {
      if (url.includes("inquiry-removal-ai")) return { status: 500, ok: false };
      return { status: 200, ok: true };
    };

    const checks = await runHealthChecks(mockFetch);
    const iraCheck = checks.find(c => c.name === "InquiryRemovalAI");
    assert.ok(iraCheck, "InquiryRemovalAI check not found");
    assert.equal(iraCheck.ok, false);

    const otherFetchChecks = checks.filter(
      c => c.name !== "InquiryRemovalAI" && c.name !== "RequiredEnvVars"
    );
    for (const c of otherFetchChecks) {
      assert.equal(c.ok, true, `Expected ${c.name} to be ok`);
    }

    const failing = checks.filter(c => !c.ok);
    assert.ok(failing.length >= 1);
  });

  it("treats IRA 404 as ok (non-5xx = up)", async () => {
    const mockFetch = async (url, _opts, _timeout) => {
      if (url.includes("inquiry-removal-ai")) return { status: 404, ok: false };
      return { status: 200, ok: true };
    };

    const checks = await runHealthChecks(mockFetch);
    const iraCheck = checks.find(c => c.name === "InquiryRemovalAI");
    assert.equal(iraCheck.ok, true);
  });
});

// ─── runHealthChecks — fetch throws ──────────────────────────────────────────

describe("runHealthChecks — fetch throws", () => {
  let savedEnv = {};

  beforeEach(() => {
    savedEnv = {
      AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
      AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
      GHL_LOCATION_ID: process.env.GHL_LOCATION_ID,
      GHL_PRIVATE_API_KEY: process.env.GHL_PRIVATE_API_KEY,
      CONTEXT_FETCHER_SECRET: process.env.CONTEXT_FETCHER_SECRET
    };
    process.env.AIRTABLE_BASE_ID = "appTestBase";
    process.env.AIRTABLE_API_KEY = "key_test";
    process.env.GHL_LOCATION_ID = "loc_test";
    process.env.GHL_PRIVATE_API_KEY = "ghl_test";
    process.env.CONTEXT_FETCHER_SECRET = "ctx_test";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("marks Airtable as failing when fetch throws", async () => {
    const mockFetch = async (url, _opts, _timeout) => {
      if (url.includes("airtable.com")) throw new Error("network error");
      return { status: 200, ok: true };
    };

    const checks = await runHealthChecks(mockFetch);
    const atCheck = checks.find(c => c.name === "Airtable");
    assert.ok(atCheck, "Airtable check not found");
    assert.equal(atCheck.ok, false);
    assert.ok(atCheck.detail.includes("network error"), `detail was: ${atCheck.detail}`);
  });
});

// ─── runHealthChecks — RequiredEnvVars ───────────────────────────────────────

describe("runHealthChecks — RequiredEnvVars check", () => {
  let savedEnv = {};

  beforeEach(() => {
    savedEnv = {
      AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
      AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY,
      GHL_LOCATION_ID: process.env.GHL_LOCATION_ID,
      GHL_PRIVATE_API_KEY: process.env.GHL_PRIVATE_API_KEY,
      CONTEXT_FETCHER_SECRET: process.env.CONTEXT_FETCHER_SECRET
    };
    process.env.AIRTABLE_BASE_ID = "appTestBase";
    process.env.AIRTABLE_API_KEY = "key_test";
    process.env.GHL_LOCATION_ID = "loc_test";
    process.env.GHL_PRIVATE_API_KEY = "ghl_test";
    process.env.CONTEXT_FETCHER_SECRET = "ctx_test";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("fails when AIRTABLE_API_KEY missing", async () => {
    delete process.env.AIRTABLE_API_KEY;
    const checks = await runHealthChecks(mockFetchAll200());
    const envCheck = checks.find(c => c.name === "RequiredEnvVars");
    assert.ok(envCheck, "RequiredEnvVars check not found");
    assert.equal(envCheck.ok, false);
    assert.ok(envCheck.detail.includes("AIRTABLE_API_KEY"), `detail was: ${envCheck.detail}`);
  });

  it("passes when all vars present", async () => {
    const checks = await runHealthChecks(mockFetchAll200());
    const envCheck = checks.find(c => c.name === "RequiredEnvVars");
    assert.ok(envCheck, "RequiredEnvVars check not found");
    assert.equal(envCheck.ok, true);
  });
});

// ─── sendHealthAlert ──────────────────────────────────────────────────────────

describe("sendHealthAlert", () => {
  const sampleFailing = [{ name: "Airtable", ok: false, detail: "500", latencyMs: 123 }];

  it("skips when MAILGUN_API_KEY missing", async () => {
    const result = await sendHealthAlert(
      sampleFailing,
      { alertEmail: "test@test.com" },
      mockFetchAll200()
    );
    assert.equal(result.sent, false);
  });

  it("skips when ALERT_EMAIL missing", async () => {
    const result = await sendHealthAlert(
      sampleFailing,
      { mailgunApiKey: "testkey" },
      mockFetchAll200()
    );
    assert.equal(result.sent, false);
  });

  it("sends correct Mailgun payload", async () => {
    let capturedUrl, capturedOpts;
    const captureFetch = async (url, opts) => {
      capturedUrl = url;
      capturedOpts = opts;
      return { ok: true, status: 200 };
    };

    const result = await sendHealthAlert(
      sampleFailing,
      {
        mailgunDomain: "mg.test.com",
        mailgunApiKey: "testkey",
        alertEmail: "ops@fundhub.ai",
        now: "2026-06-22T00:00:00Z"
      },
      captureFetch
    );

    assert.equal(result.sent, true);
    assert.equal(capturedUrl, "https://api.mailgun.net/v3/mg.test.com/messages");
    assert.equal(capturedOpts.method, "POST");
    assert.ok(
      capturedOpts.headers.Authorization.startsWith("Basic "),
      `Authorization was: ${capturedOpts.headers.Authorization}`
    );
    assert.ok(capturedOpts.body.includes("Airtable"), `body was: ${capturedOpts.body}`);
    assert.ok(
      capturedOpts.body.includes("ops%40fundhub.ai") ||
        capturedOpts.body.includes("ops@fundhub.ai"),
      `body was: ${capturedOpts.body}`
    );
    assert.ok(
      capturedOpts.body.includes("1+check%28s%29+failing") ||
        capturedOpts.body.includes("1 check(s) failing") ||
        capturedOpts.body.includes("check"),
      `body was: ${capturedOpts.body}`
    );
  });

  it("returns sent:true on mailgun 200", async () => {
    const result = await sendHealthAlert(
      sampleFailing,
      { mailgunDomain: "mg.test.com", mailgunApiKey: "testkey", alertEmail: "ops@fundhub.ai" },
      async () => ({ ok: true, status: 200 })
    );
    assert.equal(result.sent, true);
  });

  it("returns sent:false on mailgun 4xx", async () => {
    const result = await sendHealthAlert(
      sampleFailing,
      { mailgunDomain: "mg.test.com", mailgunApiKey: "testkey", alertEmail: "ops@fundhub.ai" },
      async () => ({ ok: false, status: 400 })
    );
    assert.equal(result.sent, false);
  });
});

// ─── handler — auth ───────────────────────────────────────────────────────────

describe("handler — auth", () => {
  let savedSecret;

  beforeEach(() => {
    savedSecret = process.env.CRON_SECRET;
  });

  afterEach(() => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
  });

  it("returns 405 for POST", async () => {
    delete process.env.CRON_SECRET;
    const req = makeReq("POST", {});
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 405);
  });

  it("returns 401 without valid secret", async () => {
    process.env.CRON_SECRET = "abc";
    const req = makeReq("GET", { authorization: "Bearer wrongtoken" });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 401);
    assert.equal(res._body.ok, false);
  });

  it("returns 401 with no auth header", async () => {
    process.env.CRON_SECRET = "abc";
    const req = makeReq("GET", {});
    const res = makeRes();
    await handler(req, res);
    assert.equal(res._status, 401);
  });
});
