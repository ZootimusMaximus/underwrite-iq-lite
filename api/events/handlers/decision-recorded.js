"use strict";

// Handler retired 2026-07-02 — GHL owns this stage in the new model.
// The router still dispatches here; we return a no-op marker so stray
// events get a 200 instead of a 501 HANDLER_NOT_AVAILABLE.

async function handle() {
  // Retired: fundhub.decision.recorded — GHL owns this stage in the new model.
  return {
    ok: true,
    retired: true,
    event: "fundhub.decision.recorded",
    note: "handler retired 2026-07-02 — GHL owns this stage in the new model"
  };
}

module.exports = { handle };
