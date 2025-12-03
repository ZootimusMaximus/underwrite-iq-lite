const DEFAULT_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store"
};

function withCors(headers = {}) {
  return { ...DEFAULT_CORS_HEADERS, ...headers };
}

function jsonResponse(body, init = {}) {
  const status = init.status || 200;
  const headers = withCors({
    "Content-Type": "application/json",
    ...(init.headers || {})
  });
  return new Response(JSON.stringify(body), { status, headers });
}

function preflightResponse(methods = "GET,POST,OPTIONS") {
  const headers = withCors({
    "Access-Control-Allow-Methods": methods
  });
  return new Response(null, { status: 200, headers });
}

module.exports = {
  jsonResponse,
  preflightResponse,
  withCors
};
