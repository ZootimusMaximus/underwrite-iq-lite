"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { extractEvent, routeFor, nameMatches } = require("../commas-payment");

// ---------------------------------------------------------------------------
// extractEvent — normalizes varied processor payload shapes.
// NOTE: the exact Commas shape is confirmed against a real sandbox payload; these
// cover the defensive paths the adapter handles today.
// ---------------------------------------------------------------------------

test("extractEvent: flat shape (type/product_name/amount/email)", () => {
  const evt = extractEvent({
    type: "payment.succeeded",
    product_name: "Business Financial Assessment",
    amount: 32,
    email: "Client@Example.com"
  });
  assert.equal(evt.type, "payment.succeeded");
  assert.equal(evt.name, "Business Financial Assessment");
  assert.equal(evt.amount, 32);
  assert.equal(evt.email, "client@example.com"); // lowercased + trimmed
});

test("extractEvent: nested data.object with line_items + customer", () => {
  const evt = extractEvent({
    event: "payment.succeeded",
    data: {
      object: {
        line_items: [{ name: "Consulting Services Deposit" }],
        amount_total: 3000,
        customer: { email: "a@b.com" }
      }
    }
  });
  assert.equal(evt.name, "Consulting Services Deposit");
  assert.equal(evt.amount, 3000);
  assert.equal(evt.email, "a@b.com");
});

test("extractEvent: minor-unit (cents) amount is downscaled", () => {
  const evt = extractEvent({ type: "payment.succeeded", amount_cents: 3200, email: "x@y.com" });
  assert.equal(evt.amount, 32);
});

test("extractEvent: variable dollar deposit is trusted as-is (not downscaled)", () => {
  const evt = extractEvent({ type: "payment.succeeded", amount: 5000, email: "x@y.com" });
  assert.equal(evt.amount, 5000);
});

test("extractEvent: missing email yields empty string, missing amount yields null", () => {
  const evt = extractEvent({ type: "payment.failed", product_name: "Whatever" });
  assert.equal(evt.email, "");
  assert.equal(evt.amount, null);
});

// ---------------------------------------------------------------------------
// routeFor — pure routing decision (per Chris 2026-07-15).
// ---------------------------------------------------------------------------

const base = { type: "payment.succeeded", email: "c@x.com", name: "", amount: null };

test("routeFor: CRS matches by product name", () => {
  assert.equal(routeFor({ ...base, name: "Business Financial Assessment", amount: 32 }), "crs");
});

test("routeFor: CRS matches by amount 32 even if name differs", () => {
  assert.equal(routeFor({ ...base, name: "diagnostic", amount: 32 }), "crs");
});

test("routeFor: deposit matches by name (variable amount)", () => {
  assert.equal(routeFor({ ...base, name: "Consulting Services Deposit", amount: 4500 }), "deposit");
});

test("routeFor: success fee matches by name", () => {
  assert.equal(routeFor({ ...base, name: "Consulting Success Fee", amount: 1200 }), "success_fee");
});

test("routeFor: DIY matches by product name", () => {
  assert.equal(routeFor({ ...base, name: "DIY Letters", amount: 1000 }), "diy");
});

test("routeFor: DIY matches by amount 1000 even if name differs", () => {
  assert.equal(routeFor({ ...base, name: "downsell", amount: 1000 }), "diy");
});

test("routeFor: unmatched product", () => {
  assert.equal(routeFor({ ...base, name: "Some Other Product", amount: 99 }), "unmatched");
});

test("routeFor: non-succeeded event is ignored", () => {
  assert.equal(
    routeFor({ ...base, type: "payment.failed", name: "Consulting Services Deposit" }),
    "ignored"
  );
});

test("routeFor: succeeded but no email cannot route", () => {
  assert.equal(routeFor({ ...base, email: "", name: "Business Financial Assessment" }), "no_email");
});

// ---------------------------------------------------------------------------
// nameMatches — case-insensitive substring.
// ---------------------------------------------------------------------------

test("nameMatches: case-insensitive substring, null-safe", () => {
  assert.equal(nameMatches("CONSULTING Services Deposit", "consulting services deposit"), true);
  assert.equal(nameMatches(null, "x"), false);
});
