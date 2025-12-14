// ============================================================================
// Email Validation (format only - no paid service)
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
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const body = req.body || {};
  const email = String(body.email || "")
    .trim()
    .toLowerCase();

  // Basic RFC-ish pattern
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

  if (!emailRegex.test(email)) {
    return res.status(200).json({ ok: false, error: "Please enter a valid email address." });
  }

  // Check for obviously fake/test domains
  const domain = email.split("@")[1];
  const blockedDomains = [
    "test.com",
    "example.com",
    "fake.com",
    "asdf.com",
    "mailinator.com",
    "tempmail.com",
    "throwaway.com"
  ];

  if (blockedDomains.includes(domain)) {
    return res.status(200).json({ ok: false, error: "Please use a real email address." });
  }

  // Check minimum domain requirements (has valid TLD)
  const domainParts = domain.split(".");
  if (domainParts.length < 2 || domainParts[domainParts.length - 1].length < 2) {
    return res.status(200).json({ ok: false, error: "Please enter a valid email address." });
  }

  return res.status(200).json({ ok: true });
};
