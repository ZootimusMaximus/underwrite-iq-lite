// ============================================================================
// Lite Business Name Validation (basic length placeholder)
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

  const name = String(req.body?.business || req.body?.businessName || "").trim();

  if (!name) {
    // Optional field: treat empty as ok so frontend can allow blank submissions.
    return res.status(200).json({ ok: true });
  }

  if (name.length < 2) {
    return res.status(200).json({ ok: false, msg: "Please enter a valid business name." });
  }

  // Placeholder passes if length is reasonable; future: enrich with registry lookup.
  return res.status(200).json({ ok: true });
};
