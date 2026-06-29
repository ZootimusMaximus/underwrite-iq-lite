"use strict";

/**
 * POST /api/lite/proxy-door
 *
 * The "one-click door" backend (self-improving dashboard Part 1). Given a
 * contactId, reads the client's city off their GHL record and returns an Oxylabs
 * residential-proxy connection geo-targeted to that city — so the advisor's
 * browser can launch the bank application through an IP local to the client,
 * instead of every application firing from the office.
 *
 * Request body: { contactId: string }
 * Response: { ok, contactId, city, cityTargeted, proxy: { host, port, username, authString, proxyUrl } }
 *
 * Auth: Authorization: Bearer <PROXY_DOOR_SECRET || CONTEXT_FETCHER_SECRET>.
 * Requires OXYLABS_PROXY_PASSWORD (the proxy returns credentials, so the caller
 * MUST be the trusted dashboard — never expose this endpoint publicly).
 *
 * NOTE: the desktop side (actually launching the browser through the proxy) lives
 * on the advisor's machine; this endpoint is the city → proxy resolution it calls.
 */

const { logInfo, logWarn, logError } = require("./logger");
const { getGHLContact } = require("./ghl-contact-service");
const { buildProxyForCity } = require("./oxylabs-proxy");

function validateAuth(req) {
  const secret = process.env.PROXY_DOOR_SECRET || process.env.CONTEXT_FETCHER_SECRET;
  if (!secret) {
    // FAIL CLOSED in production — this endpoint returns proxy credentials, so
    // never serve it unauthenticated on a live deploy. Dev/local (no
    // NODE_ENV=production) keeps the open path for convenience.
    if (process.env.NODE_ENV === "production") {
      logError("proxy-door: no secret configured — refusing to serve in production");
      return { ok: false };
    }
    logWarn("proxy-door: no secret set — running unauthenticated (dev mode only)");
    return { ok: true };
  }
  const bearer = req.headers["authorization"] || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : null;
  const headerSecret = req.headers["x-proxy-door-secret"] || null;
  if ((token && token === secret) || (headerSecret && headerSecret === secret)) {
    return { ok: true };
  }
  return { ok: false };
}

module.exports = async function handler(req, res) {
  // No wildcard CORS — this endpoint returns credentials. Only echo an allowed
  // dashboard origin (set DASHBOARD_ORIGIN). Server-to-server callers don't need
  // CORS at all, so the default (no Allow-Origin) is the safe one.
  const allowedOrigin = process.env.DASHBOARD_ORIGIN;
  if (allowedOrigin && req.headers.origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-proxy-door-secret");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!validateAuth(req).ok) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const body = req.body || {};
  const contactId =
    body.contactId || body.contact_id || (body.customData && body.customData.contactId);
  if (!contactId) {
    return res.status(400).json({ ok: false, error: "contactId is required" });
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(contactId)) {
    return res.status(400).json({ ok: false, error: "Invalid contactId" });
  }

  if (!process.env.OXYLABS_PROXY_PASSWORD) {
    logError("proxy-door: OXYLABS_PROXY_PASSWORD not configured");
    return res.status(500).json({ ok: false, error: "Proxy not configured" });
  }

  let city = "";
  try {
    const ghl = await getGHLContact(contactId);
    if (!ghl || !ghl.ok) {
      logWarn("proxy-door: GHL contact lookup failed", { contactId, error: ghl && ghl.error });
      return res.status(502).json({ ok: false, error: "Contact lookup failed" });
    }
    city = (ghl.contact && ghl.contact.city) || "";
  } catch (err) {
    logError("proxy-door: GHL lookup threw", { contactId, error: err.message });
    return res.status(502).json({ ok: false, error: "Contact lookup failed" });
  }

  // No city on the record → fall back to country-only targeting (still US-local,
  // just not city-precise). The advisor can still apply; logged so we can chase
  // missing-city records later.
  const proxy = buildProxyForCity(city);
  if (!proxy.cityTargeted) {
    logWarn("proxy-door: contact has no city — country-only proxy", { contactId });
  }
  logInfo("proxy-door: resolved proxy", {
    contactId,
    city: proxy.city,
    cityTargeted: proxy.cityTargeted
  });

  return res.status(200).json({
    ok: true,
    contactId,
    city: proxy.city,
    cityTargeted: proxy.cityTargeted,
    proxy: {
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      authString: proxy.authString,
      proxyUrl: proxy.proxyUrl
    }
  });
};
