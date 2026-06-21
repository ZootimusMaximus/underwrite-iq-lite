#!/usr/bin/env node
/**
 * backfill-conversations.js
 *
 * Backfills GHL conversation messages into Airtable CONVERSATION_MESSAGES table.
 * Idempotent: dedupes on message_id.
 *
 * Credentials are read from .env.pulled (preferred) or process.env.
 * Run:
 *   node scripts/backfill-conversations.js              # full backfill
 *   node scripts/backfill-conversations.js --smoke      # single conversation only
 *   SMOKE_CONV_ID=<id> node scripts/backfill-conversations.js --smoke
 */

const fs = require("fs");
const path = require("path");

// ── Env Bootstrap ─────────────────────────────────────────────────────────────
// Load .env.pulled BEFORE requiring shared module so it reads correct config

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const projectRoot = path.resolve(__dirname, "..");
loadEnvFile(path.join(projectRoot, ".env.pulled"));
loadEnvFile(path.join(projectRoot, ".env.local"));

// Validate required env vars before requiring shared module
const GHL_LOC = process.env.GHL_LOCATION_ID;

if (!process.env.GHL_PRIVATE_API_KEY && !process.env.GHL_PIT)
  throw new Error("Missing GHL_PRIVATE_API_KEY");
if (!process.env.AIRTABLE_API_KEY) throw new Error("Missing AIRTABLE_API_KEY");
if (!GHL_LOC) throw new Error("Missing GHL_LOCATION_ID");

// Import shared conversation helpers (reads process.env set above)
const {
  mapChannel,
  mapDirection,
  stripHtml,
  getConversations,
  getMessages,
  getEmailDetail,
  getExistingMessageIds,
  batchInsert
} = require("../api/lite/conversation-archive");

// ── CLI Config ────────────────────────────────────────────────────────────────

const SMOKE_CONV_ID = process.env.SMOKE_CONV_ID || "nxkQjdV4o9ntSRrgT5YG";
const IS_SMOKE = process.argv.includes("--smoke");

// ── Native Fetch Wrapper ──────────────────────────────────────────────────────
// Node 22 has native fetch; wrap it to match conversation-archive.js expectations

async function fetchWrapper(url, options = {}) {
  const resp = await fetch(url, {
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body
  });
  // conversation-archive expects Response-like object with ok, status, json(), text()
  return resp;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Process a single conversation ─────────────────────────────────────────────

async function processConversation(conv, stats) {
  const convId = conv.id;
  const contactId = conv.contactId || "";

  let messages;
  try {
    messages = await getMessages(fetchWrapper, convId);
  } catch (e) {
    console.error(`  [GHL] failed to fetch messages for ${convId}:`, e.message);
    stats.convErrors++;
    return;
  }

  if (!messages.length) {
    console.log(`  ${convId}: 0 messages`);
    return;
  }

  const allIds = messages.map(m => m.id);
  const existing = await getExistingMessageIds(fetchWrapper, allIds);
  const newMessages = messages.filter(m => !existing.has(m.id));

  if (!newMessages.length) {
    console.log(`  ${convId}: ${messages.length} messages, all already in Airtable — skipping`);
    stats.skipped += messages.length;
    return;
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
        const detail = await getEmailDetail(fetchWrapper, emailMsgId);
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

    stats.channels[channel] = (stats.channels[channel] || 0) + 1;
  }

  const inserted = await batchInsert(fetchWrapper, records);
  stats.inserted += inserted;
  stats.skipped += existing.size;
  console.log(
    `  ${convId}: ${messages.length} msgs | ${existing.size} skipped | ${inserted} inserted`
  );

  await sleep(2000);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const stats = { inserted: 0, skipped: 0, convErrors: 0, channels: {} };

  if (IS_SMOKE) {
    console.log(`\n=== SMOKE TEST: conversation ${SMOKE_CONV_ID} ===\n`);
    const conv = { id: SMOKE_CONV_ID, contactId: null };
    try {
      const convs = await getConversations(fetchWrapper, GHL_LOC);
      const found = convs.find(c => c.id === SMOKE_CONV_ID);
      if (found) conv.contactId = found.contactId;
    } catch (e) {
      console.error("Failed to fetch conversations:", e.message);
    }
    await processConversation(conv, stats);
  } else {
    console.log("\n=== FULL BACKFILL ===\n");
    let conversations;
    try {
      conversations = await getConversations(fetchWrapper, GHL_LOC);
    } catch (e) {
      console.error("[GHL] Failed to fetch conversations:", e.message);
      process.exit(1);
    }
    console.log(`Found ${conversations.length} conversations\n`);
    for (const conv of conversations) {
      await processConversation(conv, stats);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Inserted : ${stats.inserted}`);
  console.log(`Skipped  : ${stats.skipped} (already in Airtable)`);
  console.log(`Conv err : ${stats.convErrors}`);
  console.log("Channels :", JSON.stringify(stats.channels, null, 2));
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
