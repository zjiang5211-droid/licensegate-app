"use strict";

// Billing: maps a GitHub App installation to a LicenseGate plan.
//
// When BILLING_ENABLED !== "true" (default), every installation is on the
// free plan and no Marketplace call is made. When enabled, the plan is read
// from GET /marketplace_listing/accounts/{account_id} with the app JWT —
// OR from the plan last reported by a marketplace_purchase webhook event,
// which takes precedence (the webhook is the source of truth for plan
// changes, incl. cancellations). ANY error falls back to the free plan
// (fail-open for scans, billed later).
//
// GitHub sends marketplace_purchase events with actions: purchased,
// changed, cancelled, pending_change, pending_change_cancelled. The app
// must subscribe to this event once it has paid Marketplace plans.
// pending_change only announces a future change — the active plan stays
// until the `changed` event arrives on the effective date.

const config = require("./config");
const github = require("./github");
const store = require("./store");

const FREE_PLAN = { plan: "free", repoLimit: 1, billingActive: false };

const MARKETPLACE_ACTIONS = [
  "purchased",
  "changed",
  "cancelled",
  "pending_change",
  "pending_change_cancelled",
];

function normalizePlanName(name) {
  if (/team/i.test(name || "")) return "team";
  if (/pro/i.test(name || "")) return "pro";
  return "free";
}

function recordForPlan(plan) {
  if (plan === "team") {
    return { plan: "team", repoLimit: Number.POSITIVE_INFINITY, billingActive: true };
  }
  if (plan === "pro") {
    return { plan: "pro", repoLimit: Number.POSITIVE_INFINITY, billingActive: true };
  }
  return { plan: "free", repoLimit: 1, billingActive: true };
}

function planFromMarketplaceAccount(data) {
  const planName =
    (data && data.marketplace_purchase && data.marketplace_purchase.plan && data.marketplace_purchase.plan.name) || "";
  return recordForPlan(normalizePlanName(planName));
}

/**
 * Handle a marketplace_purchase webhook payload: persist the account's plan
 * so the next PR scan enforces the right repo limit without another API call.
 * Never throws on malformed input — returns {ignored:true} instead.
 *
 * @returns {{action, accountId, plan?, ignored?, note?}}
 */
function handleMarketplacePurchase(payload) {
  const action = payload && payload.action;
  const mp = payload && payload.marketplace_purchase;
  const account = mp && mp.account;
  const accountId = account && account.id;
  if (!MARKETPLACE_ACTIONS.includes(action) || accountId == null) {
    return { action: action || null, accountId: accountId || null, ignored: true };
  }
  if (action === "pending_change" || action === "pending_change_cancelled") {
    // Scheduled future change: keep the active plan until `changed` arrives.
    return {
      action,
      accountId,
      ignored: true,
      note: "pending change announced; active plan unchanged until changed event",
    };
  }
  const planName = (mp.plan && mp.plan.name) || "";
  const plan = action === "cancelled" ? "free" : normalizePlanName(planName);
  store.setAccountPlan(accountId, plan, "webhook:" + action);
  return { action, accountId, plan };
}

async function defaultFetchMarketplace(accountId) {
  const octokit = await github.getAppOctokit();
  const { data } = await octokit.request(
    "GET /marketplace_listing/accounts/{account_id}",
    { account_id: accountId }
  );
  return data;
}

/**
 * @param {number|string} accountId - GitHub Marketplace account id (the
 *   org/user id, NOT the app installation id)
 * @param {number} repoCount - distinct repos scanned under this installation
 * @param {{fetchMarketplace}} [deps] - injectable for tests
 * @returns {{plan:"free"|"pro"|"team", repoLimit:number, billingActive:boolean}}
 */
async function getPlan(accountId, repoCount, deps) {
  if (config.BILLING_ENABLED !== "true") {
    return Object.assign({}, FREE_PLAN);
  }
  try {
    // Webhook-reported plan wins over a live API query.
    const stored = store.getAccountPlan(accountId);
    if (stored && stored.plan) {
      return recordForPlan(stored.plan);
    }
    const fetchMarketplace =
      (deps && deps.fetchMarketplace) || defaultFetchMarketplace;
    const data = await fetchMarketplace(accountId);
    return planFromMarketplaceAccount(data);
  } catch (err) {
    // Marketplace hiccup, private listing, or no purchase record:
    // degrade to free instead of breaking scans.
    return Object.assign({}, FREE_PLAN);
  }
}

module.exports = { getPlan, handleMarketplacePurchase, FREE_PLAN };
