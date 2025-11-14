// /api/webhook/index.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Ensure only POST allowed
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, msg: "Method Not Allowed" });
    }

    // GHL sends JSON body
    const payload = req.body || {};

    console.log("🔔 Incoming GHL Webhook:", payload);

    // ------------------------------------------
    // STORE RAW PAYLOAD TO PROCESS LATER
    // ------------------------------------------
    // You can save this to DB, Firestore, Airtable, Supabase, etc.
    // For now we just return it back.
    // ------------------------------------------

    return res.status(200).json({
      ok: true,
      msg: "Webhook received",
      received: payload
    });

  } catch (err: any) {
    console.error("❌ Webhook Error:", err);
    return res.status(500).json({
      ok: false,
      msg: "Server Error",
      error: err?.message || err
    });
  }
}
