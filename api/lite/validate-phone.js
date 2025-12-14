// ============================================================================
// Phone Validation — Twilio Lookup
// ============================================================================

const { logError, logWarn } = require("./logger");

// Lazy initialization of Twilio client (prevents crash if credentials missing)
let twilioClient = null;

function getTwilioClient() {
  if (twilioClient) return twilioClient;

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    logWarn("Twilio credentials not configured - phone validation disabled");
    return null;
  }

  try {
    twilioClient = require("twilio")(sid, token);
    return twilioClient;
  } catch (err) {
    logError("Failed to initialize Twilio client", err);
    return null;
  }
}

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
  const raw = String(body.phone || "").trim();
  const digits = raw.replace(/\D+/g, "");

  if (digits.length < 10 || digits.length > 15) {
    return res.status(200).json({ ok: false, error: "Please enter a valid phone number." });
  }

  const twilio = getTwilioClient();
  if (!twilio) {
    // Twilio not configured - return success without validation
    return res.status(200).json({
      ok: true,
      normalized: digits,
      carrier: null,
      callerName: null,
      warning: "Phone validation service not configured"
    });
  }

  let lookup;
  try {
    lookup = await twilio.lookups.v1
      .phoneNumbers(digits)
      .fetch({ type: ["carrier", "caller-name"] });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: "Invalid or unreachable phone number."
    });
  }

  if (lookup?.carrier && lookup.carrier.type === "voip") {
    return res.status(200).json({
      ok: false,
      error: "VoIP numbers are not allowed."
    });
  }

  return res.status(200).json({
    ok: true,
    normalized: digits,
    carrier: lookup?.carrier || null,
    callerName: lookup?.callerName || null
  });
};
