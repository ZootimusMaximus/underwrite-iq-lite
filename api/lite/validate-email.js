// ============================================================================
// Email Validation (syntax + Cloudflare Email Security)
// ============================================================================

const fetch = require("node-fetch");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const body = req.body || {};
  const email = String(body.email || "").trim();

  // Basic RFC-ish pattern; not exhaustive but good enough for syntax screening.
  const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

  if (!emailRegex.test(email)) {
    return res.status(200).json({ ok: false, error: "Please enter a valid email address." });
  }

  const apiUrl = process.env.CLOUDFLARE_EMAIL_BASE;
  const apiKey = process.env.CLOUDFLARE_EMAIL_API_KEY;

  if (!apiUrl || !apiKey) {
    return res.status(200).json({ ok: false, error: "Email validation service unavailable." });
  }

  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email })
    });

    const data = await resp.json();

    if (!data?.result?.valid) {
      return res.status(200).json({
        ok: false,
        error: "Undeliverable or unsafe email address."
      });
    }
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "Email validation service unavailable."
    });
  }

  return res.status(200).json({ ok: true });
};
