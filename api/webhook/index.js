module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, message: "Webhook is live." });
    }

    const data = req.body || {};

    console.log("Webhook received:", data);

    // respond OK to GHL
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
