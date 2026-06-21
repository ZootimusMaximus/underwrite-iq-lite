"use strict";

/**
 * conversation-archive.js
 *
 * Shared helpers for GHL → Airtable conversation message sync.
 * Used by both scripts/backfill-conversations.js and
 * api/lite/conversation-sync.js.
 *
 * All network I/O is injected via deps so tests can mock cleanly.
 */

const AT_BASE = process.env.AIRTABLE_BASE_ID || "appXsq65yB9VuNup5";
const AT_TABLE = process.env.AIRTABLE_TABLE_CONVERSATION_MESSAGES || "tblPL17FxHaZrCxt4";
const GHL_BASE = "https://services.leadconnectorhq.com";

// ---------------------------------------------------------------------------
// Auth header builders — read env at call time (test-injectable via env)
// ---------------------------------------------------------------------------

function ghlHeaders() {
  return {
    Authorization: `Bearer ${process.env.GHL_PRIVATE_API_KEY || process.env.GHL_PIT || ""}`,
    Version: "2021-07-28",
    Accept: "application/json"
  };
}

function atHeaders(withBody = false) {
  const h = {
    Authorization: `Bearer ${process.env.AIRTABLE_API_KEY || ""}`,
    Accept: "application/json"
  };
  if (withBody) h["Content-Type"] = "application/json";
  return h;
}

// ---------------------------------------------------------------------------
// Channel / direction mapping
// ---------------------------------------------------------------------------

function mapChannel(messageType) {
  const t = (messageType || "").toUpperCase();
  if (t === "TYPE_SMS" || t === "TYPE_SMS_REVIEW_REQUEST") return "sms";
  if (t === "TYPE_EMAIL") return "email";
  if (t.startsWith("TYPE_FB") || t.startsWith("TYPE_IG") || t.startsWith("TYPE_GMB")) return "dm";
  if (t === "TYPE_LIVE_CHAT" || t === "TYPE_WEBCHAT") return "chat";
  if (t === "TYPE_CALL" || t === "TYPE_VOICEMAIL") return "call";
  return "other";
}

function mapDirection(dir) {
  if (!dir) return "outbound";
  return dir.toLowerCase() === "inbound" ? "inbound" : "outbound";
}

// ---------------------------------------------------------------------------
// HTML → plain text
// ---------------------------------------------------------------------------

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// GHL API helpers
// ---------------------------------------------------------------------------

/**
 * @param {Function} fetchFn - fetch-compatible function (real or mock)
 * @param {string} locationId
 * @param {string|null} [since] - ISO date; filter conversations updated after this
 */
async function getConversations(fetchFn, locationId, since) {
  let url = `${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&limit=100`;
  if (since) {
    url += `&startAfterDate=${encodeURIComponent(since)}`;
  }
  const resp = await fetchFn(url, { headers: ghlHeaders() });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GHL conversations fetch failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.conversations || [];
}

/**
 * @param {Function} fetchFn
 * @param {string} contactId
 * @param {string} locationId
 */
async function getContactConversations(fetchFn, contactId, locationId) {
  const url = `${GHL_BASE}/conversations/search?locationId=${encodeURIComponent(locationId)}&contactId=${encodeURIComponent(contactId)}&limit=100`;
  const resp = await fetchFn(url, { headers: ghlHeaders() });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GHL contact conversations fetch failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.conversations || [];
}

/**
 * @param {Function} fetchFn
 * @param {string} conversationId
 */
async function getMessages(fetchFn, conversationId) {
  const url = `${GHL_BASE}/conversations/${conversationId}/messages?limit=100`;
  const resp = await fetchFn(url, { headers: ghlHeaders() });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`GHL messages fetch failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  const inner = data.messages;
  if (Array.isArray(inner)) return inner;
  if (inner && Array.isArray(inner.messages)) return inner.messages;
  return [];
}

/**
 * @param {Function} fetchFn
 * @param {string} emailMessageId
 */
async function getEmailDetail(fetchFn, emailMessageId) {
  const url = `${GHL_BASE}/conversations/messages/email/${emailMessageId}`;
  try {
    const resp = await fetchFn(url, { headers: ghlHeaders() });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.emailMessage || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Airtable helpers
// ---------------------------------------------------------------------------

/**
 * Returns Set of message_ids already in Airtable for the given IDs.
 * @param {Function} fetchFn
 * @param {string[]} messageIds
 */
async function getExistingMessageIds(fetchFn, messageIds) {
  const existing = new Set();
  const chunkSize = 50;
  for (let i = 0; i < messageIds.length; i += chunkSize) {
    const chunk = messageIds.slice(i, i + chunkSize);
    const formula =
      chunk.length === 1
        ? `{message_id}="${chunk[0]}"`
        : "OR(" + chunk.map(id => `{message_id}="${id}"`).join(",") + ")";
    const url = `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}?filterByFormula=${encodeURIComponent(formula)}&fields[]=message_id`;
    try {
      const resp = await fetchFn(url, { headers: atHeaders() });
      if (resp.ok) {
        const data = await resp.json();
        for (const rec of data.records || []) {
          existing.add(rec.fields.message_id);
        }
      }
    } catch {
      // non-fatal — if dedupe check fails, we may insert duplicates
    }
    await sleep(200);
  }
  return existing;
}

/**
 * Insert records into Airtable (10 per request).
 * @param {Function} fetchFn
 * @param {object[]} records - array of field objects
 * @returns {number} count inserted
 */
async function batchInsert(fetchFn, records) {
  const chunkSize = 10;
  let inserted = 0;
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const body = JSON.stringify({ records: chunk.map(f => ({ fields: f })) });
    try {
      const resp = await fetchFn(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`, {
        method: "POST",
        headers: atHeaders(true),
        body
      });
      if (resp.ok) {
        inserted += chunk.length;
      }
    } catch {
      // partial failure — continue with remaining chunks
    }
    await sleep(200);
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Core sync: process one conversation
// ---------------------------------------------------------------------------

/**
 * Fetches messages for a conversation, dedupes, and upserts net-new.
 *
 * @param {object} opts
 * @param {Function} opts.fetchFn      - fetch-compatible function
 * @param {Function} opts.sleepFn      - sleep(ms) override (for tests)
 * @param {object}   opts.conv         - { id, contactId }
 * @param {object}   [opts.stats]      - mutable stats object { inserted, skipped, errors }
 * @returns {{ inserted: number, skipped: number }}
 */
async function syncConversation({ fetchFn, conv, stats = {} }) {
  const convId = conv.id;
  const contactId = conv.contactId || "";

  let messages;
  try {
    messages = await getMessages(fetchFn, convId);
  } catch (e) {
    if (stats) stats.errors = (stats.errors || 0) + 1;
    return { inserted: 0, skipped: 0, error: e.message };
  }

  if (!messages.length) return { inserted: 0, skipped: 0 };

  const allIds = messages.map(m => m.id);
  const existing = await getExistingMessageIds(fetchFn, allIds);
  const newMessages = messages.filter(m => !existing.has(m.id));

  if (!newMessages.length) {
    if (stats) stats.skipped = (stats.skipped || 0) + messages.length;
    return { inserted: 0, skipped: messages.length };
  }

  const records = [];
  for (const msg of newMessages) {
    const channel = mapChannel(msg.messageType);
    let body = msg.body || "";
    let emailSubject = "";

    if (channel === "email") {
      const emailMsgId =
        msg.meta && msg.meta.email && Array.isArray(msg.meta.email.messageIds)
          ? msg.meta.email.messageIds[0]
          : null;
      if (emailMsgId) {
        const detail = await getEmailDetail(fetchFn, emailMsgId);
        if (detail && detail.body) {
          emailSubject = detail.subject ? `[${detail.subject}] ` : "";
          if (!body || body.startsWith("[https://") || body.startsWith("[http://")) {
            body = stripHtml(detail.body);
          }
        }
        await sleep(300);
      }
    }

    records.push({
      message_id: msg.id,
      contact_id: contactId,
      conversation_id: convId,
      channel,
      direction: mapDirection(msg.direction),
      body: (emailSubject + body).slice(0, 100000),
      timestamp: msg.dateAdded || "",
      message_type: msg.messageType || ""
    });
  }

  const inserted = await batchInsert(fetchFn, records);
  if (stats) {
    stats.inserted = (stats.inserted || 0) + inserted;
    stats.skipped = (stats.skipped || 0) + existing.size;
  }

  return { inserted, skipped: existing.size };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  ghlHeaders,
  mapChannel,
  mapDirection,
  stripHtml,
  getConversations,
  getContactConversations,
  getMessages,
  getEmailDetail,
  getExistingMessageIds,
  batchInsert,
  syncConversation
};
