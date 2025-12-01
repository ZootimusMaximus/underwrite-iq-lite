// ============================================================================
// Company Validation — OpenCorporates-ready stub
// ----------------------------------------------------------------------------
// TODO: Integrate OpenCorporates API using OPENCORPORATES_API_KEY (and jurisdiction).
// ============================================================================

module.exports = function handler(req, res) {
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
  const companyName = String(body.companyName || "").trim();

  if (!companyName || companyName.length < 3) {
    return res.status(200).json({ ok: false, error: "Please enter a valid company name." });
  }

  // jurisdiction is accepted but unused for now
  return res.status(200).json({ ok: true });
};
