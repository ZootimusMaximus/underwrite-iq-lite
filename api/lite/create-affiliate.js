// ============================================================================
// UnderwriteIQ — Create Affiliate Endpoint
// Triggered when user clicks Share button - creates GHL affiliate
// ============================================================================

const { logError, logWarn } = require("./logger");
const { rateLimitMiddleware } = require("./rate-limiter");
const {
  createOrUpdateContact,
  createAffiliate,
  findContactByEmail,
  parseFullName
} = require("./ghl-contact-service");

module.exports = async function handler(req, res) {
  // ----- CORS -----
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, msg: "Method not allowed" });
  }

  // ----- Rate limiting -----
  const rateLimitAllowed = await rateLimitMiddleware(req, res);
  if (!rateLimitAllowed) {
    return; // Response already sent
  }

  try {
    // Parse request body
    let body;
    if (typeof req.body === "string") {
      body = JSON.parse(req.body);
    } else {
      body = req.body || {};
    }

    const { email, phone, name, refId, businessName } = body;

    // Validate required fields
    if (!email) {
      return res.status(200).json({
        ok: false,
        msg: "Email is required to create affiliate"
      });
    }

    // Check if contact already exists
    let contactId = null;
    const existingContact = await findContactByEmail(email);

    if (existingContact) {
      contactId = existingContact.id;
    } else {
      // Create new contact if doesn't exist
      const { firstName, lastName } = parseFullName(name);
      const contactResult = await createOrUpdateContact({
        firstName,
        lastName,
        email,
        phone,
        businessName,
        refId
      });

      if (!contactResult.ok) {
        logWarn("Failed to create contact for affiliate", {
          email,
          error: contactResult.error
        });
        return res.status(200).json({
          ok: false,
          msg: "Failed to create affiliate profile",
          error: contactResult.error
        });
      }

      contactId = contactResult.contactId;
    }

    // Create affiliate from contact
    const affiliateResult = await createAffiliate(contactId);

    if (!affiliateResult.ok && !affiliateResult.alreadyExists) {
      logWarn("Failed to create affiliate", {
        contactId,
        email,
        error: affiliateResult.error
      });
      return res.status(200).json({
        ok: false,
        msg: "Failed to create affiliate",
        error: affiliateResult.error
      });
    }

    // Generate referral URL
    const baseUrl = process.env.REDIRECT_BASE_URL || "https://fundhub.ai";
    const referralUrl =
      affiliateResult.referralUrl ||
      `${baseUrl}/credit-analyzer.html?ref=${encodeURIComponent(refId || contactId)}`;

    return res.status(200).json({
      ok: true,
      affiliateCreated: !affiliateResult.alreadyExists,
      alreadyAffiliate: affiliateResult.alreadyExists || false,
      contactId,
      affiliateId: affiliateResult.affiliateId,
      referralUrl,
      msg: affiliateResult.alreadyExists
        ? "You're already an affiliate!"
        : "Affiliate profile created successfully"
    });
  } catch (err) {
    logError("Create affiliate endpoint error", err);
    return res.status(200).json({
      ok: false,
      msg: "Failed to create affiliate profile"
    });
  }
};
