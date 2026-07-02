"use strict";

// ============================================================================
// Handler: fundhub.deposit.paid
// RETIRED 2026-07-02 — GHL owns Stage 1 (intake) in the new model.
// This handler is a no-op. The router still dispatches here so the
// /api/events endpoint returns 200 for any stray event; no writes happen.
// ============================================================================

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(_event) {
  // Retired: GHL owns Stage 1 (deposit/intake). No GHL or Airtable writes.
  return {
    ok: true,
    retired: true,
    event: "fundhub.deposit.paid",
    note: "handler retired 2026-07-02 — GHL owns this stage in the new model"
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { handle };
