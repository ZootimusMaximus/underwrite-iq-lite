"use strict";

/**
 * GET /api/lite/crs-sandbox-data
 *
 * Serves embedded Stitch Credit sandbox test responses for the CRS tester UI.
 * Only available in non-production environments.
 */

const TU_RESPONSE = require("./crs/sandbox/tu.json");
const EXP_RESPONSE = require("./crs/sandbox/exp.json");
const EFX_RESPONSE = require("./crs/sandbox/efx.json");

module.exports = async function handler(req, res) {
  // Block in production
  if (process.env.NODE_ENV === "production" && !process.env.ALLOW_SANDBOX_DATA) {
    return res.status(403).json({ error: "Not available in production" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=86400");

  const bureau = req.query && req.query.bureau;
  if (bureau === "tu") return res.json(TU_RESPONSE);
  if (bureau === "exp") return res.json(EXP_RESPONSE);
  if (bureau === "efx") return res.json(EFX_RESPONSE);

  // Return all 3
  return res.json({ tu: TU_RESPONSE, exp: EXP_RESPONSE, efx: EFX_RESPONSE });
};
