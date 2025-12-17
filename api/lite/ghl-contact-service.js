// ============================================================================
// GHL Contact & Affiliate Service
// Creates contacts and affiliates in GoHighLevel
// ============================================================================

const { logError, logWarn } = require("./logger");

const DEFAULT_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

function getApiBase() {
  return process.env.GHL_API_BASE || DEFAULT_BASE;
}

function getApiKey() {
  return process.env.GHL_PRIVATE_API_KEY || process.env.GHL_API_KEY || null;
}

function getLocationId() {
  return process.env.GHL_LOCATION_ID || null;
}

// ----------------------------------------------------------------------------
// Create or Update Contact in GHL
// ----------------------------------------------------------------------------
async function createOrUpdateContact(contactData) {
  const key = getApiKey();
  const locationId = getLocationId();

  if (!key) {
    logWarn("GHL API key not configured, skipping contact creation");
    return { ok: false, error: "GHL API key not configured" };
  }

  if (!locationId) {
    logWarn("GHL Location ID not configured, skipping contact creation");
    return { ok: false, error: "GHL Location ID not configured" };
  }

  const base = getApiBase();
  const url = `${base}/contacts/`;

  // Build contact payload
  const payload = {
    locationId,
    firstName: contactData.firstName || "",
    lastName: contactData.lastName || "",
    email: contactData.email || "",
    phone: contactData.phone || "",
    source: "UnderwriteIQ Analyzer",
    tags: ["underwriteiq", "credit-analyzer"]
  };

  // Add business info as custom fields if provided
  if (contactData.businessName) {
    payload.companyName = contactData.businessName;
  }

  // Add custom fields for business age and analyzer results
  const customFields = [];

  if (contactData.businessAgeMonths !== undefined) {
    customFields.push({
      key: "business_age_months",
      field_value: String(contactData.businessAgeMonths)
    });
  }

  if (contactData.resultType) {
    customFields.push({
      key: "analyzer_result_type",
      field_value: contactData.resultType
    });
  }

  if (contactData.creditScore) {
    customFields.push({
      key: "credit_score",
      field_value: String(contactData.creditScore)
    });
  }

  if (contactData.totalFunding) {
    customFields.push({
      key: "total_funding_estimate",
      field_value: String(contactData.totalFunding)
    });
  }

  if (contactData.refId) {
    customFields.push({
      key: "referral_id",
      field_value: contactData.refId
    });
  }

  if (customFields.length > 0) {
    payload.customFields = customFields;
  }

  try {
    // First, try to find existing contact by email
    const existingContact = await findContactByEmail(contactData.email);

    if (existingContact) {
      // Update existing contact
      return await updateContact(existingContact.id, payload);
    }

    // Create new contact
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Version: API_VERSION
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logError("GHL contact creation failed", new Error(text), {
        status: resp.status,
        email: contactData.email
      });
      return { ok: false, error: `GHL API error: ${resp.status}` };
    }

    const result = await resp.json();
    return {
      ok: true,
      contactId: result.contact?.id || result.id,
      contact: result.contact || result
    };
  } catch (err) {
    logError("GHL contact creation exception", err, { email: contactData.email });
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------------------
// Find Contact by Email
// ----------------------------------------------------------------------------
async function findContactByEmail(email) {
  if (!email) return null;

  const key = getApiKey();
  const locationId = getLocationId();
  if (!key || !locationId) return null;

  const base = getApiBase();
  const url = `${base}/contacts/?locationId=${locationId}&query=${encodeURIComponent(email)}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Version: API_VERSION
      }
    });

    if (!resp.ok) return null;

    const result = await resp.json();
    const contacts = result.contacts || [];

    // Find exact email match
    return contacts.find(c => c.email?.toLowerCase() === email.toLowerCase()) || null;
  } catch (err) {
    logWarn("GHL contact lookup failed", { email, error: err.message });
    return null;
  }
}

// ----------------------------------------------------------------------------
// Update Existing Contact
// ----------------------------------------------------------------------------
async function updateContact(contactId, updateData) {
  const key = getApiKey();
  if (!key) return { ok: false, error: "No API key" };

  const base = getApiBase();
  const url = `${base}/contacts/${contactId}`;

  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Version: API_VERSION
      },
      body: JSON.stringify(updateData)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `Update failed: ${resp.status} ${text}` };
    }

    const result = await resp.json();
    return {
      ok: true,
      contactId: contactId,
      contact: result.contact || result,
      updated: true
    };
  } catch (err) {
    logError("GHL contact update exception", err, { contactId });
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------------------
// Create Affiliate from Contact
// ----------------------------------------------------------------------------
async function createAffiliate(contactId, campaignId = null) {
  const key = getApiKey();
  if (!key) {
    return { ok: false, error: "GHL API key not configured" };
  }

  const base = getApiBase();

  // GHL Affiliate Manager API endpoint
  const url = `${base}/affiliate-manager/affiliate`;

  const payload = {
    contactId
  };

  // If a specific campaign is configured, use it
  if (campaignId || process.env.GHL_AFFILIATE_CAMPAIGN_ID) {
    payload.campaignId = campaignId || process.env.GHL_AFFILIATE_CAMPAIGN_ID;
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Version: API_VERSION
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");

      // Check if affiliate already exists (409 Conflict or similar)
      if (resp.status === 409 || text.includes("already exists")) {
        return {
          ok: true,
          alreadyExists: true,
          contactId
        };
      }

      logError("GHL affiliate creation failed", new Error(text), {
        status: resp.status,
        contactId
      });
      return { ok: false, error: `Affiliate API error: ${resp.status}` };
    }

    const result = await resp.json();
    return {
      ok: true,
      affiliateId: result.affiliate?.id || result.id,
      affiliate: result.affiliate || result,
      referralUrl: result.affiliate?.referralUrl || result.referralUrl
    };
  } catch (err) {
    logError("GHL affiliate creation exception", err, { contactId });
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------------------
// Combined: Create Contact + Make them an Affiliate
// ----------------------------------------------------------------------------
async function createContactAndAffiliate(contactData) {
  // First create/update contact
  const contactResult = await createOrUpdateContact(contactData);

  if (!contactResult.ok) {
    return {
      ok: false,
      error: contactResult.error,
      contactCreated: false,
      affiliateCreated: false
    };
  }

  // Then create affiliate from that contact
  const affiliateResult = await createAffiliate(contactResult.contactId);

  return {
    ok: true,
    contactId: contactResult.contactId,
    contact: contactResult.contact,
    contactCreated: true,
    affiliateCreated: affiliateResult.ok,
    affiliateError: affiliateResult.ok ? null : affiliateResult.error,
    affiliateId: affiliateResult.affiliateId,
    referralUrl: affiliateResult.referralUrl,
    alreadyAffiliate: affiliateResult.alreadyExists
  };
}

// ----------------------------------------------------------------------------
// Parse full name into first/last
// ----------------------------------------------------------------------------
function parseFullName(fullName) {
  if (!fullName || typeof fullName !== "string") {
    return { firstName: "", lastName: "" };
  }

  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }

  const firstName = parts[0];
  const lastName = parts.slice(1).join(" ");
  return { firstName, lastName };
}

// ----------------------------------------------------------------------------
// Update Contact Custom Fields (for letter URLs)
// ----------------------------------------------------------------------------
async function updateContactCustomFields(contactId, customFields) {
  const key = getApiKey();
  if (!key) {
    logWarn("GHL API key not configured, skipping custom field update");
    return { ok: false, error: "GHL API key not configured" };
  }

  if (!contactId) {
    return { ok: false, error: "Contact ID is required" };
  }

  const base = getApiBase();
  const url = `${base}/contacts/${contactId}`;

  // Convert custom fields object to GHL format
  // GHL expects: customFields: [{ key: "field_name", field_value: "value" }]
  const customFieldsArray = Object.entries(customFields).map(([key, value]) => ({
    key,
    field_value: String(value)
  }));

  const payload = {
    customFields: customFieldsArray
  };

  try {
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Version: API_VERSION
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logError("GHL custom field update failed", new Error(text), {
        status: resp.status,
        contactId,
        fieldCount: customFieldsArray.length
      });
      return { ok: false, error: `GHL API error: ${resp.status}` };
    }

    const result = await resp.json();
    return {
      ok: true,
      contactId,
      updatedFields: Object.keys(customFields).length,
      contact: result.contact || result
    };
  } catch (err) {
    logError("GHL custom field update exception", err, { contactId });
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------------------
// Update Letter URLs for a Contact
// Convenience function specifically for dispute letter URLs
// Uses new GHL field names (Dec 2025 update)
// ----------------------------------------------------------------------------
async function updateLetterUrls(contactId, urls, path) {
  // Build the custom fields object with GHL field names
  const customFields = {};

  if (path === "repair") {
    // Repair path - Personal info dispute letters
    if (urls.personal_info_ex) customFields.repair_letter_personal_info_ex = urls.personal_info_ex;
    if (urls.personal_info_eq) customFields.repair_letter_personal_info_eq = urls.personal_info_eq;
    if (urls.personal_info_tu) customFields.repair_letter_personal_info_tu = urls.personal_info_tu;

    // Repair path - Round 1 dispute letters
    if (urls.ex_round1) customFields.repair_letter_round_1_ex = urls.ex_round1;
    if (urls.eq_round1) customFields.repair_letter_round_1_eq = urls.eq_round1;
    if (urls.tu_round1) customFields.repair_letter_round_1_tu = urls.tu_round1;

    // Repair path - Round 2 dispute letters
    if (urls.ex_round2) customFields.repair_letter_round_2_ex = urls.ex_round2;
    if (urls.eq_round2) customFields.repair_letter_round_2_eq = urls.eq_round2;
    if (urls.tu_round2) customFields.repair_letter_round_2_tu = urls.tu_round2;

    // Repair path - Round 3 dispute letters
    if (urls.ex_round3) customFields.repair_letter_round_3_ex = urls.ex_round3;
    if (urls.eq_round3) customFields.repair_letter_round_3_eq = urls.eq_round3;
    if (urls.tu_round3) customFields.repair_letter_round_3_tu = urls.tu_round3;
  } else {
    // Funding path - Personal info cleanup letters
    if (urls.personal_info_ex) customFields.funding_letter_personal_info_ex = urls.personal_info_ex;
    if (urls.personal_info_eq) customFields.funding_letter_personal_info_eq = urls.personal_info_eq;
    if (urls.personal_info_tu) customFields.funding_letter_personal_info_tu = urls.personal_info_tu;

    // Funding path - Inquiry cleanup letters
    if (urls.inquiry_ex) customFields.funding_letter_inquiry_ex = urls.inquiry_ex;
    if (urls.inquiry_eq) customFields.funding_letter_inquiry_eq = urls.inquiry_eq;
    if (urls.inquiry_tu) customFields.funding_letter_inquiry_tu = urls.inquiry_tu;
  }

  // State flags
  customFields.analyzer_path = path;
  customFields.letters_ready = "true";
  customFields.analyzer_status = "complete";

  return updateContactCustomFields(contactId, customFields);
}

module.exports = {
  createOrUpdateContact,
  findContactByEmail,
  updateContact,
  createAffiliate,
  createContactAndAffiliate,
  parseFullName,
  updateContactCustomFields,
  updateLetterUrls
};
