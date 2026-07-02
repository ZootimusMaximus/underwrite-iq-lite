"use strict";

// Handler retired 2026-07-02 — GHL owns this stage in the new model.
// The router still dispatches here; we return a no-op marker so stray
// events get a 200 instead of a 501 HANDLER_NOT_AVAILABLE.

async function handle() {
  // Retired: fundhub.sale.closed — GHL owns this stage in the new model.
  return {
    ok: true,
    retired: true,
    event: "fundhub.sale.closed",
    note: "handler retired 2026-07-02 — GHL owns this stage in the new model"
  };
}

function resolveServiceFamily(serviceSelected) {
  if (!serviceSelected) return "unknown";
  const lower = serviceSelected.toLowerCase();
  if (lower.includes("funding") || lower.includes("fund") || lower === "funding_engagement")
    return "funding";
  if (lower.includes("repair") || lower.includes("credit_repair") || lower === "repair_program")
    return "repair";
  return "unknown";
}

const SALES_OUTCOME_BY_FAMILY = {
  funding: "Funding Purchased",
  repair: "Repair Purchased"
};

module.exports = { handle, resolveServiceFamily, SALES_OUTCOME_BY_FAMILY };
