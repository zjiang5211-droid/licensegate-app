"use strict";

// Tests for the GitHub Marketplace billing event path:
//   - marketplace_purchase webhook events persist the account's plan
//   - getPlan prefers the webhook-reported plan over a live API query
//   - bad signatures are rejected, unknown actions are ignored
//
// Env vars must be set BEFORE requiring the app modules.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "licensegate-mp-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.WEBHOOK_SECRET = "marketplace-test-secret";
process.env.BILLING_ENABLED = "true";
process.env.GITHUB_API_MOCK = "1";

const billing = require("../src/billing");
const store = require("../src/store");
const { app } = require("../src/index");

const ACCOUNT_ID = 4242;

function sign(body, secret) {
  return (
    "sha256=" +
    crypto
      .createHmac("sha256", secret === undefined ? process.env.WEBHOOK_SECRET : secret)
      .update(body)
      .digest("hex")
  );
}

function marketplacePayload(action, planName, accountId) {
  return {
    action,
    marketplace_purchase: {
      account: { id: accountId === undefined ? ACCOUNT_ID : accountId, type: "Organization", login: "acme" },
      plan: planName === undefined ? undefined : { id: 111, name: planName, monthly_price_in_cents: 900 },
    },
    sender: { login: "acme-bot" },
  };
}

let server;
let port;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

async function postWebhook(payload, event, secret) {
  const body = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${port}/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `delivery-${Date.now()}-${Math.random()}`,
      "x-hub-signature-256": sign(body, secret),
    },
    body,
  });
  return { res, json: await res.json() };
}

test("purchased Pro -> plan persisted for the account", async () => {
  const { res, json } = await postWebhook(
    marketplacePayload("purchased", "Pro"),
    "marketplace_purchase"
  );
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.handled, "marketplace_purchase");
  assert.equal(json.action, "purchased");
  assert.equal(json.plan, "pro");
  const stored = store.getAccountPlan(ACCOUNT_ID);
  assert.equal(stored.plan, "pro");
  assert.match(stored.source, /^webhook:purchased$/);
});

test("changed to Team -> plan updated", async () => {
  const { res, json } = await postWebhook(
    marketplacePayload("changed", "Team"),
    "marketplace_purchase"
  );
  assert.equal(res.status, 200);
  assert.equal(json.plan, "team");
  assert.equal(store.getAccountPlan(ACCOUNT_ID).plan, "team");
});

test("cancelled -> falls back to free", async () => {
  const { res, json } = await postWebhook(
    marketplacePayload("cancelled", "Team"),
    "marketplace_purchase"
  );
  assert.equal(res.status, 200);
  assert.equal(json.plan, "free");
  assert.equal(store.getAccountPlan(ACCOUNT_ID).plan, "free");
});

test("pending_change does not alter the active plan", async () => {
  await postWebhook(marketplacePayload("purchased", "Pro"), "marketplace_purchase");
  const { res, json } = await postWebhook(
    marketplacePayload("pending_change", "Team"),
    "marketplace_purchase"
  );
  assert.equal(res.status, 200);
  assert.equal(json.ignored, true);
  assert.equal(store.getAccountPlan(ACCOUNT_ID).plan, "pro");
});

test("unknown action and missing account are ignored, not 500", async () => {
  const { res, json } = await postWebhook(
    marketplacePayload("refunded", "Pro"),
    "marketplace_purchase"
  );
  assert.equal(res.status, 200);
  assert.equal(json.ignored, true);

  const noAccount = { action: "purchased", marketplace_purchase: {} };
  const r2 = await postWebhook(noAccount, "marketplace_purchase");
  assert.equal(r2.res.status, 200);
  assert.equal(r2.json.ignored, true);
});

test("bad signature -> 401", async () => {
  const { res } = await postWebhook(
    marketplacePayload("purchased", "Pro"),
    "marketplace_purchase",
    "wrong"
  );
  assert.equal(res.status, 401);
});

test("getPlan prefers the webhook-reported plan over the API", async () => {
  store.setAccountPlan(999001, "team", "webhook:purchased");
  let apiCalled = false;
  const plan = await billing.getPlan(999001, 50, {
    fetchMarketplace: async () => {
      apiCalled = true;
      throw new Error("API must not be called when a webhook plan exists");
    },
  });
  assert.equal(apiCalled, false);
  assert.equal(plan.plan, "team");
  assert.equal(plan.repoLimit, Number.POSITIVE_INFINITY);
  assert.equal(plan.billingActive, true);
});

test("getPlan falls back to the API when no webhook plan exists", async () => {
  const plan = await billing.getPlan(999002, 3, {
    fetchMarketplace: async () => ({
      marketplace_purchase: { plan: { name: "Pro" } },
    }),
  });
  assert.equal(plan.plan, "pro");
  assert.equal(plan.billingActive, true);
});

test("getPlan fails open to free when the API errors", async () => {
  const plan = await billing.getPlan(999003, 3, {
    fetchMarketplace: async () => {
      throw new Error("Marketplace down");
    },
  });
  assert.equal(plan.plan, "free");
  assert.equal(plan.billingActive, false);
});

test("handleMarketplacePurchase never throws on garbage input", () => {
  for (const bad of [null, undefined, {}, { action: "purchased" }, "x", 42]) {
    const r = billing.handleMarketplacePurchase(bad);
    assert.equal(r.ignored, true);
  }
});
