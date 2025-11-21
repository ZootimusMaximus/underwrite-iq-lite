// ============================================================================
// UnderwriteIQ — AI Gatekeeper (gpt-4o-mini)
// ----------------------------------------------------------------------------
// Purpose:
//   A cheap classifier to reject obvious NON–credit reports BEFORE expensive
//   GPT-4.1 Vision parsing.
//
// Responsibilities:
//   ✔ Detect obvious fake PDF uploads
//   ✔ Detect bank statements, IDs, screenshots, tax forms, blank docs
//   ✔ Detect “not a credit report”
//   ✔ Return STRICT JSON only
//   ✔ Fail open (do NOT block) if AI check fails unexpectedly
//
// NOTES:
//   - gpt-4o-mini costs ~1/20th of Vision
//   - Only first ~200 KB of PDF is sent
//   - This is SAFE and DOES NOT affect parse quality
//
// Use:
//   const { aiGateCheck } = require("./ai-gatekeeper");
//   const gate = await aiGateCheck(buffer, filename);
//
//   if (!gate.ok) reject upload early.
// ============================================================================

function extractTextFromResponse(r) {
  if (!r) return null;

  if (r.output_text && typeof r.output_text === "string") {
    return r.output_text.trim();
  }

  if (Array.isArray(r.output)) {
    for (const msg of r.output) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === "output_text" && typeof block.text === "string") {
          return block.text.trim();
        }
      }
    }
  }

  if (r.choices?.[0]?.message?.content) {
    return String(r.choices[0].message.content).trim();
  }

  return null;
}

async function aiGateCheck(buffer, filename) {
  try {
    const key = process.env.UNDERWRITE_IQ_VISION_KEY;
    if (!key) {
      return { ok: true, reason: "No AI key configured; skipped." };
    }

    // Only send beginning of PDF (cheap + safer)
    const base64 = buffer.toString("base64");
    const head = base64.slice(0, 200_000); // ~200 KB
    const dataUrl = `data:application/pdf;base64,${head}`;
    const safeName = filename || "report.pdf";

    const systemPrompt = `
You are a strict classifier for a credit report analyzer.

You MUST decide whether an uploaded PDF is a REAL consumer credit report
from Experian, Equifax, TransUnion, or tri-merge.

Return STRICT JSON ONLY in this schema:

{
  "likely_credit_report": true | false,
  "reason": "short explanation",
  "suspected_bureaus": ["experian" | "equifax" | "transunion"] | []
}

Rules:
- If content looks like bank statements, paystubs, IDs, letters, tax docs,
  or random screenshots → likely_credit_report = false.
- If layout, headers, terminology match credit reports → true.
- NEVER output anything except the JSON object.
`;

    const body = {
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "input_text", text: "Classify this PDF upload." },
            {
              type: "input_file",
              filename: safeName,
              file_data: dataUrl
            }
          ]
        }
      ],
      temperature: 0,
      max_output_tokens: 300
    };

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      // AI check failed → DO NOT BLOCK → fail open
      return { ok: true, reason: "AI gate network error; skipped." };
    }

    const json = await resp.json();
    const txt = extractTextFromResponse(json);

    if (!txt) {
      return { ok: true, reason: "AI gate empty response; skipped." };
    }

    let verdict;
    try {
      verdict = JSON.parse(txt);
    } catch (err) {
      // AI returned weird stuff → DO NOT BLOCK
      return { ok: true, reason: "AI gate JSON parse failed; skipped." };
    }

    const likely = !!verdict.likely_credit_report;
    const reason = String(verdict.reason || "").slice(0, 300);

    if (!likely) {
      return {
        ok: false,
        reason:
          reason ||
          "This file does not appear to be a real consumer credit report."
      };
    }

    return {
      ok: true,
      reason: reason || "Looks like a real credit report.",
      suspected_bureaus: verdict.suspected_bureaus || []
    };
  } catch (err) {
    console.error("AI_GATEKEEPER ERROR:", err);
    // Fail open to avoid blocking
    return { ok: true, reason: "AI gate exception; skipped." };
  }
}

module.exports = {
  aiGateCheck
};
