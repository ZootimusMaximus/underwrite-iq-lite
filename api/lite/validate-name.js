// ============================================================================
// Name Validation (simple syntax check)
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
  const firstName = (body.firstName || body.firstname || "").trim();
  const lastName = (body.lastName || body.lastname || "").trim();

  const nameRegex = /^[A-Za-z' -]+$/;

  if (!firstName || !lastName) {
    return res.status(200).json({ ok: false, error: "First and last name are required." });
  }

  if (!nameRegex.test(firstName) || !nameRegex.test(lastName)) {
    return res.status(200).json({
      ok: false,
      error: "Names can only contain letters, spaces, hyphens, or apostrophes."
    });
  }

  return res.status(200).json({ ok: true });
};
