"use strict";

// Environment configuration. All values are read lazily-friendly: requiring
// this module never throws, even when every variable is a placeholder.
// Secrets/credentials are only consumed at request time (fail-lazy).
require("dotenv").config();
const path = require("path");

module.exports = {
  // GitHub App identity
  APP_ID: process.env.APP_ID || "",
  PRIVATE_KEY: process.env.PRIVATE_KEY || "",
  PRIVATE_KEY_PATH: process.env.PRIVATE_KEY_PATH || "",

  // Webhook HMAC secret (x-hub-signature-256)
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "",

  PORT: parseInt(process.env.PORT || "3000", 10),

  // Dashboard HTTP basic auth; if unset, auth is skipped (with a warning)
  DASHBOARD_USER: process.env.DASHBOARD_USER || "",
  DASHBOARD_PASS: process.env.DASHBOARD_PASS || "",

  // "true" enables GitHub Marketplace plan lookups
  BILLING_ENABLED: process.env.BILLING_ENABLED || "false",

  DATABASE_PATH:
    process.env.DATABASE_PATH ||
    path.join(process.cwd(), "data", "licensegate.db"),

  // Test seam: "1" switches the GitHub layer to fixtures (tests only)
  GITHUB_API_MOCK: process.env.GITHUB_API_MOCK === "1",
};
