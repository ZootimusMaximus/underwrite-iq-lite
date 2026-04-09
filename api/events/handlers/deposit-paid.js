"use strict";

// ============================================================================
// Handler: fundhub.deposit.paid
//
// Fires when a checkout succeeds (SLO funnel or any future checkout).
// SLO funnel payments are deposits that credit toward the $3,000 funding
// engagement. Upsells send additional deposit.paid events — they must not
// change core booking logic.
//
// Required payload: transaction_id, gross_amount, credit_amount
//
// Actions:
//   1. Upsert client
//   2. Accumulate cf_precall_deposit_paid_total (add gross_amount to existing)
//   3. Accumulate cf_precall_deposit_credit_amount (add credit_amount to existing)
//   4. Write record to Airtable COMMERCE_TRANSACTIONS
//   5. Set cf_last_canonical_event + cf_last_canonical_event_ts
//
// Spec rules:
//   - SLO funnel payments are deposits/credits toward the $3,000 engagement.
//   - Store deposit totals separately from commission fields (Funding Fee Percent).
//   - Funding engagement face value = 3000.
//
// See: FundHub Modular Event System Developer Handoff, sections 5, 7, 11.
// ============================================================================

const { logInfo, logWarn, logError } = require("../../lite/logger");
const { upsertClient } = require("./client-upsert");
const { updateContactCustomFields } = require("../../lite/ghl-contact-service");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const TABLE_COMMERCE_TRANSACTIONS =
  process.env.AIRTABLE_TABLE_COMMERCE_TRANSACTIONS || "Commerce Transactions";
const GHL_API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// ---------------------------------------------------------------------------
// GHL: Read current deposit totals
// ---------------------------------------------------------------------------

async function getExistingDepositTotals(ghlContactId) {
  const key = process.env.GHL_PRIVATE_API_KEY || process.env.GHL_API_KEY;
  if (!key || !ghlContactId) return { paidTotal: 0, creditTotal: 0 };

  try {
    const resp = await fetch(`${GHL_API_BASE}/contacts/${ghlContactId}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Version: GHL_API_VERSION
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return { paidTotal: 0, creditTotal: 0 };

    const data = await resp.json();
    const contact = data.contact || data;
    const customFields = contact.customFields || [];

    const find = key => {
      const field = customFields.find(f => f.key === key);
      return parseFloat(field?.value || "0") || 0;
    };

    return {
      paidTotal: find("cf_precall_deposit_paid_total"),
      creditTotal: find("cf_precall_deposit_credit_amount")
    };
  } catch (err) {
    logWarn("deposit-paid: could not read existing totals", { ghlContactId, error: err.message });
    return { paidTotal: 0, creditTotal: 0 };
  }
}

// ---------------------------------------------------------------------------
// Airtable: Write COMMERCE_TRANSACTIONS record
// ---------------------------------------------------------------------------

async function writeCommerceTransaction(fields) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    logWarn("deposit-paid: Airtable not configured, skipping COMMERCE_TRANSACTIONS write");
    return { ok: false, error: "Airtable not configured" };
  }

  try {
    const url = `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_COMMERCE_TRANSACTIONS)}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields }),
      signal: AbortSignal.timeout(15000)
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logWarn("deposit-paid: Airtable COMMERCE_TRANSACTIONS write failed", {
        status: resp.status,
        body: text.slice(0, 200)
      });
      return { ok: false, error: `Airtable error: ${resp.status}` };
    }

    const data = await resp.json();
    logInfo("deposit-paid: COMMERCE_TRANSACTIONS record created", { recordId: data.id });
    return { ok: true, recordId: data.id };
  } catch (err) {
    logError("deposit-paid: COMMERCE_TRANSACTIONS write exception", err);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} event - Full event envelope
 * @returns {Promise<{ ok: boolean, action: string, ghlContactId: string, transactionRecordId: string }>}
 */
async function handle(event) {
  const { contact, payload, adapter, event_id, correlation_id } = event;

  const { transaction_id, gross_amount, credit_amount, currency, product_id, product_name } =
    payload;

  logInfo("deposit-paid: processing", {
    event_id,
    transaction_id,
    gross_amount,
    credit_amount,
    email: contact?.email
  });

  // ---- 1. Upsert client ----
  const identity = await upsertClient(contact, adapter);
  if (!identity.ok) {
    throw new Error(`client-upsert failed: ${identity.error}`);
  }

  const { ghlContactId, airtableClientRecordId, clientMasterKey } = identity;
  const now = new Date().toISOString();

  // ---- 2. Accumulate deposit totals ----
  const { paidTotal, creditTotal } = await getExistingDepositTotals(ghlContactId);

  const newPaidTotal = paidTotal + Number(gross_amount);
  const newCreditTotal = creditTotal + Number(credit_amount);

  // ---- 3. Update GHL fields ----
  const customFields = {
    cf_precall_deposit_paid_total: String(newPaidTotal),
    cf_precall_deposit_credit_amount: String(newCreditTotal),
    cf_last_canonical_event: "fundhub.deposit.paid",
    cf_last_canonical_event_ts: now
  };

  const updateResult = await updateContactCustomFields(ghlContactId, customFields);
  if (!updateResult.ok) {
    logWarn("deposit-paid: GHL field update failed", {
      ghlContactId,
      error: updateResult.error
    });
  }

  // ---- 4. Write COMMERCE_TRANSACTIONS record ----
  const transactionFields = {
    transaction_id: transaction_id || "",
    gross_amount: Number(gross_amount),
    credit_amount: Number(credit_amount),
    currency: currency || "USD",
    product_id: product_id || "",
    product_name: product_name || "",
    ghl_contact_id: ghlContactId,
    client_master_key: clientMasterKey || "",
    event_id: event_id || "",
    correlation_id: correlation_id || "",
    occurred_at: event.occurred_at || now,
    recorded_at: now,
    funnel_family: adapter?.funnel_family || "",
    offer_family: adapter?.offer_family || payload.offer_family || ""
  };

  // Link to CLIENTS record if available
  if (airtableClientRecordId) {
    transactionFields["Client"] = [airtableClientRecordId];
  }

  const txResult = await writeCommerceTransaction(transactionFields);

  logInfo("deposit-paid: complete", {
    event_id,
    ghlContactId,
    transaction_id,
    newPaidTotal,
    newCreditTotal,
    transactionRecordId: txResult.recordId || null
  });

  return {
    ok: true,
    action: "deposit_paid",
    ghlContactId,
    airtableClientRecordId,
    clientMasterKey,
    transaction_id,
    gross_amount: Number(gross_amount),
    credit_amount: Number(credit_amount),
    new_paid_total: newPaidTotal,
    new_credit_total: newCreditTotal,
    transactionRecordId: txResult.recordId || null
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { handle };
