// ============================================================================
// Lite Email Validation (syntax-only placeholder)
// ============================================================================

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, msg: "Method not allowed" });
  }

  const email = String(req.body?.email || "").trim();

  if (!email) {
    return res.status(200).json({ ok: false, msg: "Email is required." });
  }

  const emailRegex = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
  if (!emailRegex.test(email)) {
    return res.status(200).json({ ok: false, msg: "Please enter a valid email address." });
  }

  // Placeholder passes if syntax looks good; future: Cloudflare email intel.
  return res.status(200).json({ ok: true });
};
