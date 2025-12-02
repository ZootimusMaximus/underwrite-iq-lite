const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  TTL_SECONDS,
  normalizeEmail,
  normalizePhone,
  buildDedupeKeys,
  checkDedupe,
  storeRedirect,
  lookupByRef,
  computeDaysRemaining
} = require("../dedupe-store");

class FakeRedis {
  constructor() {
    this.store = new Map();
    this.ttls = new Map();
  }

  async get(key) {
    const entry = this.store.get(key);
    return entry ? entry.value : null;
  }

  async set(key, value, opts) {
    if (opts?.ex) this.ttls.set(key, opts.ex);
    this.store.set(key, { value });
    return "OK";
  }
}

test("normalization and key hashing uses lowercase email and digits-only phone", () => {
  const email = "Test+User@Email.com ";
  const phone = "(555) 123-4567";
  const keys = buildDedupeKeys({ email, phone, deviceId: "device-1" });

  const expectedHash = crypto
    .createHash("sha256")
    .update(`${normalizeEmail(email)}|${normalizePhone(phone)}`)
    .digest("hex");

  assert.ok(keys.userKey.endsWith(expectedHash));
  assert.ok(keys.deviceKey.endsWith("device-1"));
});

test("user dedupe hit short-circuits before device", async () => {
  const redis = new FakeRedis();
  const redirect = { resultUrl: "https://fundhub.ai/result", query: { score: 720 }, refId: "contact-1" };
  const keys = buildDedupeKeys({ email: "me@site.com", phone: "5551112222", deviceId: "abc" });

  await storeRedirect(redis, keys, redirect);

  const hit = await checkDedupe(redis, keys);
  assert.equal(hit?.deduped, true);
  assert.equal(hit.redirect.refId, "contact-1");
  assert.equal(hit.redirect.resultUrl, redirect.resultUrl);
  assert.equal(hit.redirect.daysRemaining, 30);
  assert.equal(redis.ttls.get(keys.userKey), TTL_SECONDS);
});

test("device dedupe works when user identity changes", async () => {
  const redis = new FakeRedis();
  const redirect = { resultUrl: "https://fundhub.ai/result", query: { util: 25 } };
  const deviceKeys = buildDedupeKeys({ email: null, phone: null, deviceId: "device-xyz" });

  await storeRedirect(redis, deviceKeys, redirect);

  const hit = await checkDedupe(redis, { userKey: null, deviceKey: deviceKeys.deviceKey });
  assert.equal(hit?.source, "device");
  assert.equal(hit.redirect.resultUrl, redirect.resultUrl);
  assert.ok(hit.redirect.refId);
});

test("different device and user do not dedupe", async () => {
  const redis = new FakeRedis();
  const redirect = { url: "https://fundhub.ai/result" };
  const keys = buildDedupeKeys({ email: "one@test.com", phone: "5553334444", deviceId: "device-1" });
  await storeRedirect(redis, keys, redirect);

  const miss = await checkDedupe(redis, buildDedupeKeys({
    email: "two@test.com",
    phone: "5559998888",
    deviceId: "device-2"
  }));

  assert.equal(miss, null);
});

test("ref lookup fetches cached redirect and updates daysRemaining", async () => {
  const redis = new FakeRedis();
  const redirect = { resultUrl: "https://fundhub.ai/result", lastUpload: new Date().toISOString(), refId: "ref-123" };
  const keys = buildDedupeKeys({ email: "x@y.com", phone: "5554447777", deviceId: "dev", refId: "ref-123" });

  await storeRedirect(redis, keys, redirect);
  const hit = await lookupByRef(redis, "ref-123");
  assert.equal(hit.refId, "ref-123");
  assert.equal(hit.resultUrl, redirect.resultUrl);
  assert.ok(hit.daysRemaining <= 30);
});

test("computeDaysRemaining handles invalid input", () => {
  assert.equal(computeDaysRemaining("not-a-date"), null);
});
