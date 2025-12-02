// ============================================================================
// Lite Phone Validation (basic digits + length placeholder)
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

  const raw = String(req.body?.phone || "").trim();
  const digits = raw.replace(/\D+/g, "");

  if (!digits) {
    return res.status(200).json({ ok: false, msg: "Phone number is required." });
  }

  if (digits.length < 10 || digits.length > 15) {
    return res.status(200).json({ ok: false, msg: "Enter a valid phone number." });
  }

  // Placeholder passes if digit length is plausible; future: carrier/line-type check.
  return res.status(200).json({ ok: true });
};
