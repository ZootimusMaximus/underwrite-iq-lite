"use strict";

// Handler retired 2026-07-02 — GHL owns this stage in the new model.
// The router still dispatches here; we return a no-op marker so stray
// events get a 200 instead of a 501 HANDLER_NOT_AVAILABLE.

async function handle() {
  // Retired: fundhub.booking.lane.decided — GHL owns this stage in the new model.
  return {
    ok: true,
    retired: true,
    event: "fundhub.booking.lane.decided",
    note: "handler retired 2026-07-02 — GHL owns this stage in the new model"
  };
}

module.exports = { handle };
