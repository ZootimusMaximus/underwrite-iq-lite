"use strict";

/**
 * oxylabs-proxy.js — Build an Oxylabs residential-proxy connection targeted to a
 * client's city. The pure, CLI-testable core of the "one-click proxy door"
 * (self-improving dashboard Part 1): given a client city, produce the proxy
 * connection the advisor's browser launches through, so an application's exit IP
 * looks local to the client instead of the office.
 *
 * Geo-targeting is encoded in the Oxylabs USERNAME:
 *   customer-<sub>-cc-<COUNTRY>-city-<city>
 * e.g. customer-fundhub_uiyg4-cc-US-city-mesa
 *
 * Verified live 2026-06-29: a "-city-mesa" request exits on a Mesa, AZ IP.
 *
 * SECURITY: the proxy password is read from env (OXYLABS_PROXY_PASSWORD) and is
 * NEVER returned in any logging-safe shape. Callers that need the auth string
 * pull `.password` / `.authString` explicitly and must not log them.
 */

const DEFAULT_HOST = process.env.OXYLABS_PROXY_HOST || "pr.oxylabs.io";
const DEFAULT_PORT = process.env.OXYLABS_PROXY_PORT || "7777";
const DEFAULT_USER = process.env.OXYLABS_PROXY_USER || "customer-fundhub_uiyg4";

/**
 * Normalize a free-text city into the token Oxylabs expects: lowercase, spaces
 * and separators collapsed to single underscores, only [a-z0-9_]. Returns "" for
 * empty/unusable input so the caller can fall back to country-only targeting.
 */
function sanitizeCity(city) {
  if (!city || typeof city !== "string") return "";
  return city
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_") // any run of non-alnum → single underscore
    .replace(/^_+|_+$/g, ""); // trim leading/trailing underscores
}

/**
 * Build the Oxylabs proxy connection for a given city.
 *
 * @param {string} city - client city (free text; sanitized internally)
 * @param {Object} [opts]
 * @param {string} [opts.country="US"] - 2-letter country code
 * @param {string} [opts.password] - override env password (tests)
 * @returns {{
 *   host: string, port: string, username: string, password: string,
 *   authString: string, proxyUrl: string, country: string,
 *   city: string|null, cityTargeted: boolean
 * }}
 * @throws if no proxy password is configured (env unset and no override)
 */
function buildProxyForCity(city, opts = {}) {
  const country = (opts.country || "US").toUpperCase();
  const password = opts.password || process.env.OXYLABS_PROXY_PASSWORD;
  if (!password) {
    throw new Error("OXYLABS_PROXY_PASSWORD not configured");
  }

  const cityToken = sanitizeCity(city);
  // Username carries the geo flags. City is optional — fall back to country-only.
  const username = cityToken
    ? `${DEFAULT_USER}-cc-${country}-city-${cityToken}`
    : `${DEFAULT_USER}-cc-${country}`;

  // `authString` is the raw user:pass for clients that take credentials
  // separately (e.g. curl -U, or a browser proxy-auth prompt). `proxyUrl`
  // embeds them in URL userinfo, so it MUST be percent-encoded — the real
  // password contains "+", which several HTTP/proxy clients decode to a space
  // in unencoded userinfo (and "@"/":"/"/"" would break the URL outright).
  // encodeURIComponent is a no-op for ordinary alphanumerics, so this is safe
  // for every password while fixing the special-char case.
  const authString = `${username}:${password}`;
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${DEFAULT_HOST}:${DEFAULT_PORT}`;
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    username,
    password,
    authString,
    proxyUrl,
    country,
    city: cityToken || null,
    cityTargeted: Boolean(cityToken)
  };
}

module.exports = { sanitizeCity, buildProxyForCity, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_USER };
