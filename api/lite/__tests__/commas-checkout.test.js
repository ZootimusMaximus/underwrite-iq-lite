"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { createCheckoutLink, baseUrl } = require("../commas-checkout");

const originalFetch = global.fetch;
const okResp = body => ({ ok: true, status: 200, json: async () => body });
const errResp = (status, body) => ({ ok: false, status, json: async () => body });

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

test("createCheckoutLink: missing API key -> NO_API_KEY", async () => {
  await withEnv({ FANBASIS_CHECKOUT_API_KEY: undefined }, async () => {
    const r = await createCheckoutLink({
      amountCents: 300000,
      productTitle: "Consulting Services Deposit"
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, "NO_API_KEY");
  });
});

test("createCheckoutLink: bad amount -> BAD_AMOUNT", async () => {
  const r = await createCheckoutLink({ apiKey: "k", amountCents: 0, productTitle: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "BAD_AMOUNT");
});

test("createCheckoutLink: missing title -> NO_PRODUCT_TITLE", async () => {
  const r = await createCheckoutLink({ apiKey: "k", amountCents: 1000, productTitle: "  " });
  assert.equal(r.ok, false);
  assert.equal(r.error, "NO_PRODUCT_TITLE");
});

test("createCheckoutLink: success — correct body, x-api-key auth, returns payment_link", async () => {
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, opts };
    return okResp({
      status: "success",
      data: { checkout_session_id: 42, payment_link: "https://pay.fanbasis.com/abc" }
    });
  };
  try {
    const r = await createCheckoutLink({
      apiKey: "sk_test_123",
      amountCents: 300000,
      applicationFee: 25000,
      productTitle: "Consulting Services Deposit",
      metadata: { contact_id: "c1" },
      webhookUrl: "https://x/api/lite/commas-payment"
    });
    assert.equal(r.ok, true);
    assert.equal(r.paymentLink, "https://pay.fanbasis.com/abc");
    assert.equal(r.checkoutSessionId, 42);
    // auth header is x-api-key, NOT Authorization/Bearer
    assert.equal(captured.opts.headers["x-api-key"], "sk_test_123");
    assert.ok(!captured.opts.headers.Authorization);
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.amount_cents, 300000);
    assert.equal(body.application_fee, 25000);
    assert.equal(body.product.title, "Consulting Services Deposit");
    assert.equal(body.type, "onetime_non_reusable");
    assert.deepEqual(body.metadata, { contact_id: "c1" });
    assert.match(captured.url, /\/checkout-sessions$/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("createCheckoutLink: API error status -> COMMAS_ERROR with status", async () => {
  global.fetch = async () => errResp(422, { message: "invalid product" });
  try {
    const r = await createCheckoutLink({ apiKey: "k", amountCents: 1000, productTitle: "x" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "COMMAS_ERROR");
    assert.equal(r.status, 422);
  } finally {
    global.fetch = originalFetch;
  }
});

test("createCheckoutLink: response without payment_link -> NO_PAYMENT_LINK", async () => {
  global.fetch = async () => okResp({ status: "success", data: { checkout_session_id: 7 } });
  try {
    const r = await createCheckoutLink({ apiKey: "k", amountCents: 1000, productTitle: "x" });
    assert.equal(r.ok, false);
    assert.equal(r.error, "NO_PAYMENT_LINK");
  } finally {
    global.fetch = originalFetch;
  }
});

test("baseUrl: sandbox / production / override", async () => {
  await withEnv(
    {
      FANBASIS_CHECKOUT_BASE_URL: undefined,
      FANBASIS_ENVIRONMENT: "sandbox",
      COMMAS_ENV: undefined
    },
    () => {
      assert.equal(baseUrl(), "https://qa.dev-fan-basis.com/public-api");
    }
  );
  await withEnv(
    {
      FANBASIS_CHECKOUT_BASE_URL: undefined,
      FANBASIS_ENVIRONMENT: "production",
      COMMAS_ENV: undefined
    },
    () => {
      assert.equal(baseUrl(), "https://www.fanbasis.com/public-api");
    }
  );
  await withEnv(
    {
      FANBASIS_CHECKOUT_BASE_URL: "https://x/v2/",
      FANBASIS_ENVIRONMENT: undefined,
      COMMAS_ENV: undefined
    },
    () => {
      assert.equal(baseUrl(), "https://x/v2");
    }
  );
});
