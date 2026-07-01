"use strict";
/* global AbortSignal */

// ============================================================================
// Handler: fundhub.sale.closed
//
// Fires when payment + contract are complete. Finalizes the sale data.
//
// Required payload: service_selected, contract_value, deposit_credit_applied
//
// Actions:
//   1. Upsert client
//   2. Compute cf_engagement_face_value
//      - For funding: always 3000 (spec hardcoded; contract_value is stored too)
//      - For repair: contract_value as provided
//   3. Compute cf_engagement_remaining_due = face_value - deposit_credit_applied
//   4. Detect cross-lane deposit mismatch:
//      If cf_booking_lane = funding BUT service_selected = repair (or vice versa),
//      move deposit into cf_unapplied_credit_amount and create an ops task.
//      This is the safe default per spec section 11 until policy is approved.
//   5. Set cf_last_canonical_event + cf_last_canonical_event_ts
//
// Spec billing rules (section 11):
//   - Funding engagement face value = 3000
//   - SLO payments are credits toward the 3000 engagement
//   - engagement_remaining_due = 3000 - precall_deposit_credit_amount
//   - Cross-lane: move to cf_unapplied_credit_amount + create ops task
//   - Never touch Funding Fee Percent for this math
//
// See: FundHub Modular Event System Developer Handoff, sections 5, 11.
// ============================================================================

const { logInfo, logWarn, logError } = require("../../lite/logger");
const { upsertClient } = require("./client-upsert");
const { updateContactCustomFields, addContactTags } = require("../../lite/ghl-contact-service");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FUNDING_ENGAGEMENT_FACE_VALUE = 3000;

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const TABLE_TASKS = process.env.AIRTABLE_TABLE_TASKS || "Tasks";

const GHL_API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// ---------------------------------------------------------------------------
// GHL: Read current booking lane and deposit totals
// ---------------------------------------------------------------------------

async function readContactFields(ghlContactId) {
  const key = process.env.GHL_PRIVATE_API_KEY || process.env.GHL_API_KEY;
  if (!key || !ghlContactId) return {};

  try {
    const resp = await fetch(`${GHL_API_BASE}/contacts/${ghlContactId}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Version: GHL_API_VERSION
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) return {};

    const data = await resp.json();
    const contact = data.contact || data;
    const customFields = contact.customFields || [];

    const find = fieldKey => customFields.find(f => f.key === fieldKey)?.value || null;

    return {
      bookingLane: find("cf_booking_lane"),
      precallDepositCreditAmount: parseFloat(find("cf_precall_deposit_credit_amount") || "0") || 0
    };
  } catch (err) {
    logWarn("sale-closed: could not read contact fields", {
      ghlContactId,
      error: err.message
    });
    return {};
  }
}

// ---------------------------------------------------------------------------
// Airtable: Create ops task for cross-lane deposit mismatch
// ---------------------------------------------------------------------------

async function createOpsTask(fields) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    logWarn("sale-closed: Airtable not configured, cannot create ops task");
    return { ok: false, error: "Airtable not configured" };
  }

  try {
    const url = `${AIRTABLE_API_BASE}/${AIRTABLE_BASE_ID}/${encodeURIComponent(TABLE_TASKS)}`;
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
      logWarn("sale-closed: ops task creation failed", {
        status: resp.status,
        body: text.slice(0, 200)
      });
      return { ok: false, error: `Airtable error: ${resp.status}` };
    }

    const data = await resp.json();
    logInfo("sale-closed: ops task created for cross-lane deposit", { recordId: data.id });
    return { ok: true, recordId: data.id };
  } catch (err) {
    logError("sale-closed: ops task creation exception", err);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Resolve face value and lane
// ---------------------------------------------------------------------------

/**
 * Returns which service family a service_selected value belongs to.
 * Handles both "funding" and "repair" service types.
 *
 * @param {string} serviceSelected
 * @returns {"funding" | "repair" | "unknown"}
 */

// Maps a service family to the EXACT GHL "Sales Outcome" (sales_outcome) picklist
// value that drives the post-call workflows (S-06 funding close, S-07 repair
// close). Strings must match the GHL Single-Options field exactly — GHL silently
// drops an unknown picklist value, which would make the close fire nothing.
// (Full option set in GHL: "Funding Purchased", "Repair Purchased",
//  "Funding Didn’t Buy", "Repair Didn’t Buy" — the didn't-buy cases are not
//  emitted by this handler; a sale.closed event always represents a purchase.)
const SALES_OUTCOME_BY_FAMILY = {
  funding: "Funding Purchased",
  repair: "Repair Purchased"
};

function resolveServiceFamily(serviceSelected) {
  if (!serviceSelected) return "unknown";
  const lower = serviceSelected.toLowerCase();

  if (lower.includes("funding") || lower.includes("fund") || lower === "funding_engagement") {
    return "funding";
  }

  if (lower.includes("repair") || lower.includes("credit_repair") || lower === "repair_program") {
    return "repair";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} event - Full event envelope
 * @returns {Promise<{ ok: boolean, action: string, ghlContactId: string, crossLaneFlag: boolean }>}
 */
async function handle(event) {
  const { contact, payload, adapter, event_id, correlation_id } = event;

  const {
    service_selected,
    contract_value,
    deposit_credit_applied,
    payment_method,
    contract_id,
    sales_rep_id
  } = payload;

  logInfo("sale-closed: processing", {
    event_id,
    service_selected,
    contract_value,
    deposit_credit_applied,
    email: contact?.email
  });

  // ---- 1. Upsert client ----
  const identity = await upsertClient(contact, adapter);
  if (!identity.ok) {
    throw new Error(`client-upsert failed: ${identity.error}`);
  }

  const { ghlContactId, airtableClientRecordId, clientMasterKey } = identity;
  const now = new Date().toISOString();

  // ---- 2. Read current GHL state ----
  const { bookingLane, precallDepositCreditAmount: _precallDepositCreditAmount } =
    await readContactFields(ghlContactId);

  // ---- 3. Determine face value and service family ----
  const serviceFamily = resolveServiceFamily(service_selected);
  const contractValueNum = Number(contract_value) || 0;
  const depositCreditApplied = Number(deposit_credit_applied) || 0;

  // Per spec section 11: funding face value is always 3000.
  // Repair face value uses contract_value as provided (policy not yet finalized).
  const faceValue = serviceFamily === "funding" ? FUNDING_ENGAGEMENT_FACE_VALUE : contractValueNum;

  const remainingDue = Math.max(0, faceValue - depositCreditApplied);

  // ---- 4. Detect cross-lane deposit mismatch ----
  // Safe default: if a lead paid a funding deposit but bought repair (or vice versa),
  // move the credit into cf_unapplied_credit_amount and create an ops task.
  // This holds until Chris approves the exact repair-credit policy in writing.
  // See spec section 11 and section 15 (open decision).

  let crossLaneFlag = false;
  let opsTaskRecordId = null;

  const depositedForFunding = bookingLane === "funding" || !bookingLane;
  const boughtRepair = serviceFamily === "repair";
  const boughtFunding = serviceFamily === "funding";
  const depositedForRepair = bookingLane === "repair";

  const isCrossLane =
    (depositedForFunding && boughtRepair && depositCreditApplied > 0) ||
    (depositedForRepair && boughtFunding && depositCreditApplied > 0);

  if (isCrossLane) {
    crossLaneFlag = true;
    logWarn("sale-closed: cross-lane deposit detected", {
      ghlContactId,
      bookingLane,
      service_selected,
      depositCreditApplied
    });

    // Create ops task
    const taskFields = {
      task_type: "cross_lane_deposit_review",
      priority: "high",
      status: "open",
      ghl_contact_id: ghlContactId,
      client_master_key: clientMasterKey || "",
      description: [
        `Cross-lane deposit detected on sale close.`,
        `Lead was in ${bookingLane || "unknown"} lane but purchased: ${service_selected}.`,
        `Deposit credit applied: $${depositCreditApplied}.`,
        `Action required: Apply or refund per approved policy.`,
        `Event ID: ${event_id}`
      ].join(" "),
      created_at: now,
      correlation_id: correlation_id || ""
    };

    if (airtableClientRecordId) {
      taskFields["Client"] = [airtableClientRecordId];
    }

    const taskResult = await createOpsTask(taskFields);
    opsTaskRecordId = taskResult.recordId || null;
  }

  // ---- 5. Build GHL field writes ----
  const customFields = {
    cf_engagement_face_value: String(faceValue),
    cf_engagement_remaining_due: String(remainingDue),
    cf_service_selected: service_selected,
    cf_contract_value: String(contractValueNum),
    cf_sale_closed_at: now,
    cf_last_canonical_event: "fundhub.sale.closed",
    cf_last_canonical_event_ts: now
  };

  // Sales Outcome is the MASTER post-call trigger: GHL workflows S-06 (funding
  // close), S-07 (repair close), S-08/S-09 (didn't buy) all key off this single
  // dropdown — nothing listens to the cf_* fields above. So we must write
  // `sales_outcome` with an EXACT GHL picklist value or the close fires nothing.
  // S-06 then runs full intake only when its other gates are also true (Contract
  // Funding Signed, CRS Paid, Funding Fee Percent — set by the sale process, not
  // this event); otherwise S-06 drops an ops task. That gating is intentional and
  // lives in GHL, so we only own writing the outcome here.
  const salesOutcomeValue = SALES_OUTCOME_BY_FAMILY[serviceFamily];
  if (salesOutcomeValue) {
    customFields.sales_outcome = salesOutcomeValue;
  } else {
    // Q1 (2026-07-01): products are only funding or repair. An unrecognized one
    // shouldn't happen — but never let a weird sale fail silently. Tag it +
    // create an ops task so a human catches it (not just a log line).
    logWarn("sale-closed: unrecognized service_selected — flagging for human review", {
      ghlContactId,
      serviceFamily,
      service_selected
    });
    await addContactTags(ghlContactId, ["error:sale-unknown-product"]);
    const unknownTaskFields = {
      task_type: "sale_unknown_product_review",
      priority: "high",
      status: "open",
      ghl_contact_id: ghlContactId,
      client_master_key: clientMasterKey || "",
      description: [
        `Sale closed with an unrecognized product: "${service_selected}".`,
        `Expected funding or repair. sales_outcome was NOT written, so S-06/S-07 did not fire.`,
        `Action required: confirm the product + record the correct sale.`,
        `Event ID: ${event_id}`
      ].join(" "),
      created_at: now,
      correlation_id: correlation_id || ""
    };
    if (airtableClientRecordId) unknownTaskFields["Client"] = [airtableClientRecordId];
    const unknownTask = await createOpsTask(unknownTaskFields);
    opsTaskRecordId = opsTaskRecordId || unknownTask.recordId || null;
  }

  if (crossLaneFlag) {
    customFields.cf_unapplied_credit_amount = String(depositCreditApplied);
  }

  if (contract_id) {
    customFields.cf_contract_id = contract_id;
  }

  if (payment_method) {
    customFields.cf_payment_method = payment_method;
  }

  if (sales_rep_id) {
    customFields.cf_sales_rep_id = sales_rep_id;
  }

  const updateResult = await updateContactCustomFields(ghlContactId, customFields);
  if (!updateResult.ok) {
    logWarn("sale-closed: GHL field update failed", {
      ghlContactId,
      error: updateResult.error
    });
  }

  logInfo("sale-closed: complete", {
    event_id,
    ghlContactId,
    service_selected,
    faceValue,
    remainingDue,
    crossLaneFlag,
    opsTaskRecordId
  });

  return {
    ok: true,
    action: "sale_closed",
    ghlContactId,
    airtableClientRecordId,
    clientMasterKey,
    service_selected,
    service_family: serviceFamily,
    face_value: faceValue,
    remaining_due: remainingDue,
    deposit_credit_applied: depositCreditApplied,
    cross_lane_flag: crossLaneFlag,
    ops_task_record_id: opsTaskRecordId
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { handle, resolveServiceFamily, SALES_OUTCOME_BY_FAMILY };
