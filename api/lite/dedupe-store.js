const crypto = require("crypto");
const { Redis } = require("@upstash/redis");
const { logError, logWarn, logInfo } = require("./logger");

const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const USER_PREFIX = "uwiq:u:";
const DEVICE_PREFIX = "uwiq:d:";
const REF_PREFIX = "uwiq:r:";

function normalizeEmail(email) {
  const val = (email || "").trim().toLowerCase();
  return val || null;
}

function normalizePhone(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  return digits || null;
}

function hashUserIdentity(email, phoneDigits) {
  if (!email || !phoneDigits) return null;
  return crypto.createHash("sha256").update(`${email}|${phoneDigits}`).digest("hex");
}

function buildUserKey(email, phone) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const hash = hashUserIdentity(normalizedEmail, normalizedPhone);
  return hash ? USER_PREFIX + hash : null;
}

function buildDeviceKey(deviceId) {
  const id = (deviceId || "").trim();
  return id ? DEVICE_PREFIX + id : null;
}

function buildRefKey(refId) {
  const id = (refId || "").trim();
  return id ? REF_PREFIX + id : null;
}

function deriveRefId({ userKey, deviceKey, providedRefId }) {
  if (providedRefId) return providedRefId;
  if (userKey && userKey.startsWith(USER_PREFIX)) return userKey.slice(USER_PREFIX.length);
  if (deviceKey && deviceKey.startsWith(DEVICE_PREFIX)) return deviceKey.slice(DEVICE_PREFIX.length);
  return null;
}

function createRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch (err) {
    logError("Failed to initialize Redis client", err);
    return null;
  }
}

async function readCachedRedirect(redis, key) {
  if (!redis || !key) return null;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

function computeDaysRemaining(lastUploadIso) {
  if (!lastUploadIso) return null;
  const last = new Date(lastUploadIso);
  if (Number.isNaN(last.getTime())) return null;
  const msElapsed = Date.now() - last.getTime();
  const daysElapsed = Math.floor(msElapsed / (1000 * 60 * 60 * 24));
  const remaining = 30 - daysElapsed;
  return remaining < 0 ? 0 : remaining;
}

async function writeCachedRedirect(redis, key, payload) {
  if (!redis || !key || !payload) return null;
  try {
    return await redis.set(key, JSON.stringify(payload), { ex: TTL_SECONDS });
  } catch (err) {
    logWarn("Failed to cache redirect", { key, error: err.message });
    return null;
  }
}

function prepareRedirectPayload(redirect, derivedRefId) {
  const refId = redirect?.refId || derivedRefId || null;
  const affiliateLink =
    redirect?.affiliateLink ||
    (refId ? `https://fundhub.ai/credit-analyzer.html?ref=${encodeURIComponent(refId)}` : null);

  const lastUpload = redirect?.lastUpload || new Date().toISOString();
  const daysRemaining = redirect?.daysRemaining ?? computeDaysRemaining(lastUpload) ?? 30;

  return {
    redirect: {
      ...(redirect || {}),
      refId,
      affiliateLink,
      lastUpload,
      daysRemaining
    },
    lastUpload
  };
}

async function checkDedupe(redis, { userKey, deviceKey, refKey }) {
  if (!redis) return null;

  const userHit = await readCachedRedirect(redis, userKey);
  if (userHit?.redirect) {
    const daysRemaining = computeDaysRemaining(userHit.redirect.lastUpload || userHit.lastUpload);
    if (daysRemaining != null) userHit.redirect.daysRemaining = daysRemaining;
    return { redirect: userHit.redirect, deduped: true, source: "user" };
  }

  const deviceHit = await readCachedRedirect(redis, deviceKey);
  if (deviceHit?.redirect) {
    const daysRemaining = computeDaysRemaining(deviceHit.redirect.lastUpload || deviceHit.lastUpload);
    if (daysRemaining != null) deviceHit.redirect.daysRemaining = daysRemaining;
    return { redirect: deviceHit.redirect, deduped: true, source: "device" };
  }

  const refHit = await readCachedRedirect(redis, refKey);
  if (refHit?.redirect) {
    const daysRemaining = computeDaysRemaining(refHit.redirect.lastUpload || refHit.lastUpload);
    if (daysRemaining != null) refHit.redirect.daysRemaining = daysRemaining;
    return { redirect: refHit.redirect, deduped: true, source: "ref" };
  }

  return null;
}

async function storeRedirect(redis, keys, redirect) {
  if (!redis || !redirect) return;
  const payload = prepareRedirectPayload(redirect, keys?.refId);

  const writes = [];
  if (keys?.userKey) writes.push(writeCachedRedirect(redis, keys.userKey, payload));
  if (keys?.deviceKey) writes.push(writeCachedRedirect(redis, keys.deviceKey, payload));
  if (keys?.refKey) writes.push(writeCachedRedirect(redis, keys.refKey, payload));

  await Promise.all(writes);
}

function buildDedupeKeys({ email, phone, deviceId, refId }) {
  const userKey = buildUserKey(email, phone);
  const deviceKey = buildDeviceKey(deviceId);
  const derivedRefId = deriveRefId({ userKey, deviceKey, providedRefId: refId });
  const refKey = buildRefKey(derivedRefId);

  return {
    userKey,
    deviceKey,
    refId: derivedRefId,
    refKey
  };
}

async function lookupByRef(redis, refId) {
  if (!redis) return null;
  const refKey = buildRefKey(refId);
  if (!refKey) return null;
  const hit = await readCachedRedirect(redis, refKey);
  if (!hit?.redirect) return null;
  const daysRemaining = computeDaysRemaining(hit.redirect.lastUpload || hit.lastUpload);
  if (daysRemaining != null) hit.redirect.daysRemaining = daysRemaining;
  return hit.redirect;
}

module.exports = {
  TTL_SECONDS,
  USER_PREFIX,
  DEVICE_PREFIX,
  REF_PREFIX,
  normalizeEmail,
  normalizePhone,
  buildUserKey,
  buildDeviceKey,
  buildDedupeKeys,
  buildRefKey,
  createRedisClient,
  checkDedupe,
  storeRedirect,
  lookupByRef,
  prepareRedirectPayload,
  computeDaysRemaining
};
