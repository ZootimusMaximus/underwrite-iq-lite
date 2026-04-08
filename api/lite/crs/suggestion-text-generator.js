"use strict";

/**
 * suggestion-text-generator.js — AI Text Enhancement for Suggestions
 *
 * Takes structured findings with template text and rewrites them using
 * OpenAI in Chris's style: 5th grade reading level, name every account,
 * exact dollar amounts, conversational tone.
 *
 * Falls back to template text on AI failure.
 */

const { logInfo, logWarn, logError } = require("../logger");

const SYSTEM_PROMPT = `You are a credit advisor writing suggestions for clients. Follow these rules exactly:

1. 5th grade reading level. No jargon. No acronyms unless explained. Short sentences.
2. Talk like a person, not a machine. "Your Chase card is almost maxed out" not "Your revolving utilization exceeds optimal threshold."
3. Name every account by creditor name. Never say "your revolving accounts."
4. Give exact numbers — current balance AND target. "Pay your Chase card down from $8,700 to $1,000."
5. Explain WHY it matters in one sentence.
6. Tell them what happens when they fix it.
7. If they are going for funding, NEVER suggest opening new accounts first. New accounts lower average credit age and add hard inquiries.
8. Utilization target is always under 10%, not 30%.

You will receive a JSON array of findings. For each finding, rewrite the "problem", "whyItMatters", and "action" fields in this conversational style. Keep the same meaning but make it sound like a trusted advisor talking to a friend.

Return a JSON array with the same structure, same number of items, same "code" field, but with rewritten text fields.`;

/**
 * enrichSuggestionsWithAI(findings, options)
 *
 * @param {Array} findings - fullSuggestions array from buildSuggestions
 * @param {Object} [options]
 * @param {string} [options.apiKey] - OpenAI API key (falls back to env)
 * @param {string} [options.model] - OpenAI model (default: gpt-4o-mini)
 * @param {number} [options.timeoutMs] - Timeout in ms (default: 15000)
 * @returns {Array} findings with AI-enhanced text (or originals on failure)
 */
async function enrichSuggestionsWithAI(findings, options = {}) {
  if (!findings || findings.length === 0) return findings;

  const apiKey =
    options.apiKey || process.env.UNDERWRITE_IQ_VISION_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logWarn("suggestion-text-generator: No OpenAI API key, using template text");
    return findings;
  }

  const model = options.model || "gpt-4o-mini";
  const timeoutMs = options.timeoutMs || 15000;

  // Prepare input — only send customer-safe findings, limit to essential fields
  const input = findings.map(f => ({
    code: f.code,
    category: f.category,
    severity: f.severity,
    problem: f.problem,
    whyItMatters: f.whyItMatters,
    action: f.action,
    accountData: f.accountData || null
  }));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Rewrite these ${input.length} credit suggestions. Return ONLY a JSON array, no markdown:\n\n${JSON.stringify(input)}`
          }
        ],
        temperature: 0.7,
        max_tokens: 4000
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logWarn("suggestion-text-generator: OpenAI API error", {
        status: resp.status,
        body: text.substring(0, 200)
      });
      return findings;
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      logWarn("suggestion-text-generator: Empty OpenAI response");
      return findings;
    }

    // Parse JSON from response (strip markdown fences if present)
    const jsonStr = content
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const enhanced = JSON.parse(jsonStr);

    if (!Array.isArray(enhanced) || enhanced.length !== findings.length) {
      logWarn("suggestion-text-generator: AI response length mismatch", {
        expected: findings.length,
        got: Array.isArray(enhanced) ? enhanced.length : "not array"
      });
      return findings;
    }

    // Merge AI text back into original findings (preserve all original fields)
    const result = findings.map((original, i) => {
      const ai = enhanced[i];
      if (!ai || ai.code !== original.code) return original;
      return {
        ...original,
        problem: ai.problem || original.problem,
        whyItMatters: ai.whyItMatters || original.whyItMatters,
        action: ai.action || original.action,
        aiEnhanced: true
      };
    });

    logInfo("suggestion-text-generator: AI enhancement complete", {
      count: result.filter(r => r.aiEnhanced).length,
      model
    });

    return result;
  } catch (err) {
    if (err.name === "AbortError") {
      logWarn("suggestion-text-generator: OpenAI timeout", { timeoutMs });
    } else {
      logError("suggestion-text-generator: AI enhancement failed", {
        error: err.message
      });
    }
    return findings;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { enrichSuggestionsWithAI, SYSTEM_PROMPT };
