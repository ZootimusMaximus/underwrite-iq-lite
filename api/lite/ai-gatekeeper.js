// ============================================================================
// UnderwriteIQ — AI Gatekeeper (gpt-4o-mini)
// ----------------------------------------------------------------------------
// Purpose: Cheap classifier to reject non–credit reports BEFORE GPT-4 Vision.
// ============================================================================

const { logError, logWarn, logInfo } = require("./logger");
const { fetchWithTimeout } = require("./fetch-utils");

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

    // Only send first ~200kb to save money
    const base64 = buffer.toString("base64");
    const head = base64.slice(0, 200_000);
    const dataUrl = `data:application/pdf;base64,${head}`;
    const safeName = filename || "report.pdf";

    const systemPrompt = `
You are a strict classifier for a credit-report analyzer.

Return STRICT JSON ONLY:
{
  "likely_credit_report": true | false,
  "reason": "short explanation",
  "suspected_bureaus": []
}

Reject: bank statements, screenshots, IDs, W2s, tax forms, letters.
Accept: Experian, Equifax, TransUnion, or tri-merge credit reports.
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
      max_output_tokens: 200
    };

    const resp = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }, 30000); // 30 second timeout for gatekeeper

    if (!resp.ok) {
      return { ok: true, reason: "AI gate network error; skipped." };
    }

    const json = await resp.json();
    const txt = extractTextFromResponse(json);
    if (!txt) return { ok: true, reason: "AI gate empty response; skipped." };

    let verdict = null;
    try {
      verdict = JSON.parse(txt);
    } catch {
      return { ok: true, reason: "AI gate parse fail; skipped." };
    }

    // Validate verdict is an object with expected shape
    if (!verdict || typeof verdict !== "object") {
      return { ok: true, reason: "AI gate invalid response; skipped." };
    }

    if (!verdict.likely_credit_report) {
      return {
        ok: false,
        reason:
          verdict.reason ||
          "This does not appear to be a real consumer credit report.",
        suspected_bureaus: []
      };
    }

    return {
      ok: true,
      reason: verdict.reason || "Looks like a real credit report.",
      suspected_bureaus: verdict.suspected_bureaus || []
    };
  } catch (err) {
    logError("AI gatekeeper failed", err, { filename });
    return { ok: true, reason: "AI gate exception; skipped." };
  }
}

module.exports = { aiGateCheck };
