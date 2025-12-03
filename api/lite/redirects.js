let cachedBaseUrl = null;

function normalizeBaseUrl(raw) {
  const url = new URL(raw);
  let normalized = url.origin;
  if (url.pathname && url.pathname !== "/") {
    normalized += url.pathname.replace(/\/$/, "");
  }
  return normalized.replace(/\/$/, "");
}

function getFrontendBaseUrl() {
  if (cachedBaseUrl) return cachedBaseUrl;
  const raw = process.env.FRONTEND_BASE_URL;
  if (!raw) {
    throw new Error("FRONTEND_BASE_URL is not configured");
  }
  cachedBaseUrl = normalizeBaseUrl(raw);
  return cachedBaseUrl;
}

function normalizePath(pathname) {
  if (!pathname || typeof pathname !== "string") return "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function buildFrontendUrl(pathname = "/", query = {}) {
  const base = getFrontendBaseUrl();
  const normalizedPath = normalizePath(pathname);
  const url = new URL(`${base}${normalizedPath}`);
  if (query && typeof query === "object") {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

function buildAffiliateLink(refId) {
  if (!refId) return null;
  return buildFrontendUrl("/credit-analyzer.html", { ref: refId });
}

function buildRedirectResponse(pathname, query) {
  const location = buildFrontendUrl(pathname, query);
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store"
    }
  });
}

function redirectFromRecord(record) {
  if (!record) {
    return buildRedirectResponse("/", null);
  }
  const path = record.resultPath || "/";
  return buildRedirectResponse(path, record.query || {});
}

module.exports = {
  getFrontendBaseUrl,
  buildFrontendUrl,
  buildAffiliateLink,
  buildRedirectResponse,
  redirectFromRecord
};
