"use strict";

// Billing: maps a GitHub App installation to a LicenseGate plan.
//
// When BILLING_ENABLED !== "true" (default), every installation is on the
// free plan and no Marketplace call is made. When enabled, the plan is read
// from GET /marketplace_listing/accounts/{account_id} with the app JWT;
// ANY error falls back to the free plan (fail-open for scans, billed later).

const config = require("./config");
const github = require("./github");

const FREE_PLAN = { plan: "free", repoLimit: 1, billingActive: false };

function planFromMarketplaceAccount(data) {
  const planName =
    (data && data.marketplace_purchase && data.marketplace_purchase.plan && data.marketplace_purchase.plan.name) || "";
  if (/pro/i.test(planName)) {
    return { plan: "pro", repoLimit: Number.POSITIVE_INFINITY, billingActive: true };
  }
  return { plan: "free", repoLimit: 1, billingActive: true };
}

async function defaultFetchMarketplace(installationId) {
  const octokit = await github.getAppOctokit();
  const { data } = await octokit.request(
    "GET /marketplace_listing/accounts/{account_id}",
    { account_id: installationId }
  );
  return data;
}

/**
 * @param {number|string} installationId
 * @param {number} repoCount - distinct repos scanned under this installation
 * @param {{fetchMarketplace}} [deps] - injectable for tests
 * @returns {{plan:"free"|"pro", repoLimit:number, billingActive:boolean}}
 */
async function getPlan(installationId, repoCount, deps) {
  if (config.BILLING_ENABLED !== "true") {
    return Object.assign({}, FREE_PLAN);
  }
  try {
    const fetchMarketplace =
      (deps && deps.fetchMarketplace) || defaultFetchMarketplace;
    const data = await fetchMarketplace(installationId);
    return planFromMarketplaceAccount(data);
  } catch (err) {
    // Marketplace hiccup, private listing, or no purchase record:
    // degrade to free instead of breaking scans.
    return Object.assign({}, FREE_PLAN);
  }
}

module.exports = { getPlan, FREE_PLAN };
