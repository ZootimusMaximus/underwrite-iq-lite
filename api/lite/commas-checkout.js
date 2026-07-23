"use strict";

/**
 * Commas (FanBasis) checkout-link generator.
 *
 * Creates a per-client hosted checkout link with a VARIABLE price + optional
 * success fee — never hardcode amounts (Chris rule). Pairs with the receiver
 * `commas-payment.js`.
 *
 * Spec is VERBATIM from @fanbasis/checkout-sdk@0.7.0 (2026-07-23), not guessed:
 *   POST {base}/checkout-sessions
 *   Auth header:  x-api-key: <FANBASIS_CHECKOUT_API_KEY>   (NOT Bearer)
 *   Base URLs:    production  https://www.fanbasis.com/public-api
 *                 sandbox     https://qa.dev-fan-basis.com/public-api
 *   Body:  { amount_cents, application_fee?, product:{title, description?},
 *            type:'onetime_non_reusable'|'onetime_reusable'|'subscription',
 *            success_url?, webhook_url?, metadata? }
 *   Resp:  { data:{ checkout_session_id, payment_link }, message, status }
 *
 * Usage as a module:
 *   const { createCheckoutLink } = require("./commas-checkout");
 *   const { paymentLink } = await createCheckoutLink({ amountCents, productTitle });
 *
 * Usage as an endpoint (for GHL / the dashboard):
 *   POST /api/lite/commas-checkout  { amount_cents, product_title, ... }  (auth: shared secret)
 */

const { logInfo, logError } = require("./logger");
const { fetchWithTimeout } = require("./fetch-utils");

const BASE_URLS = {
  production: "https://www.fanbasis.com/public-api",
  sandbox: "https://qa.dev-fan-basis.com/public-api"
};

function baseUrl() {
  if (process.env.FANBASIS_CHECKOUT_BASE_URL)
    return process.env.FANBASIS_CHECKOUT_BASE_URL.replace(/\/+$/, "");
  const env = (
    process.env.FANBASIS_ENVIRONMENT ||
    process.env.COMMAS_ENV ||
    "production"
  ).toLowerCase();
  return BASE_URLS[env] || BASE_URLS.production;
}

/**
 * Create a hosted checkout session and return its payment link.
 * @param {object} o
 * @param {number} o.amountCents        Variable price in cents (required).
 * @param {string} o.productTitle       Product name shown at checkout (required).
 * @param {number} [o.applicationFee]   Success fee (platform fee), in the API's units.
 * @param {string} [o.productDescription]
 * @param {string} [o.type]             Default "onetime_non_reusable".
 * @param {string} [o.successUrl]
 * @param {string} [o.webhookUrl]
 * @param {object} [o.metadata]         e.g. { contact_id, client_id }.
 * @param {string} [o.apiKey]           Override FANBASIS_CHECKOUT_API_KEY.
 * @returns {Promise<{ok:true, paymentLink:string, checkoutSessionId:number, raw:object}
 *                    | {ok:false, error:string, message:string, status?:number}>}
 */
async function createCheckoutLink(o = {}) {
  const apiKey = o.apiKey || process.env.FANBASIS_CHECKOUT_API_KEY;
  if (!apiKey)
    return {
      ok: false,
      error: "NO_API_KEY",
      message: "FANBASIS_CHECKOUT_API_KEY not set (access still pending?)."
    };

  const amount = Number(o.amountCents);
  if (!Number.isFinite(amount) || amount <= 0)
    return {
      ok: false,
      error: "BAD_AMOUNT",
      message: "amountCents must be a positive integer (cents)."
    };
  if (!o.productTitle || !String(o.productTitle).trim())
    return { ok: false, error: "NO_PRODUCT_TITLE", message: "productTitle is required." };

  const body = {
    amount_cents: Math.round(amount),
    product: { title: String(o.productTitle).trim() },
    type: o.type || "onetime_non_reusable"
  };
  if (o.productDescription) body.product.description = String(o.productDescription);
  if (o.applicationFee != null) body.application_fee = Number(o.applicationFee);
  if (o.successUrl) body.success_url = String(o.successUrl);
  if (o.webhookUrl) body.webhook_url = String(o.webhookUrl);
  if (o.metadata && typeof o.metadata === "object") body.metadata = o.metadata;

  const url = `${baseUrl()}/checkout-sessions`;
  try {
    const resp = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(body)
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      logError("Commas checkout create failed", {
        status: resp.status,
        message: json && json.message
      });
      return {
        ok: false,
        error: "COMMAS_ERROR",
        status: resp.status,
        message: (json && json.message) || `HTTP ${resp.status}`
      };
    }
    const data = json.data || {};
    if (!data.payment_link)
      return {
        ok: false,
        error: "NO_PAYMENT_LINK",
        message: "Commas returned no payment_link.",
        status: resp.status
      };
    logInfo("Commas checkout link created", {
      checkoutSessionId: data.checkout_session_id,
      amount_cents: body.amount_cents,
      product: body.product.title
    });
    return {
      ok: true,
      paymentLink: data.payment_link,
      checkoutSessionId: data.checkout_session_id,
      raw: json
    };
  } catch (err) {
    logError("Commas checkout request threw", { error: err.message });
    return { ok: false, error: "REQUEST_FAILED", message: err.message };
  }
}

// --- Endpoint handler -------------------------------------------------------
async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });

  // Shared-secret auth (same pattern as the other lite endpoints).
  const secret = process.env.COMMAS_CHECKOUT_SECRET || process.env.CONTEXT_FETCHER_SECRET;
  if (secret) {
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (bearer !== secret) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  }

  const b = req.body || {};
  const result = await createCheckoutLink({
    amountCents: b.amount_cents ?? b.amountCents,
    productTitle: b.product_title ?? b.productTitle,
    productDescription: b.product_description ?? b.productDescription,
    applicationFee: b.application_fee ?? b.applicationFee,
    type: b.type,
    successUrl: b.success_url ?? b.successUrl,
    webhookUrl: b.webhook_url ?? b.webhookUrl,
    metadata: b.metadata
  });
  return res.status(result.ok ? 200 : result.status || 400).json(result);
}

module.exports = handler;
module.exports.createCheckoutLink = createCheckoutLink;
module.exports.baseUrl = baseUrl;
