"use strict";

// GitHub API layer built on @octokit/app.
//
// Test seam: tests call setClientFactory(fn) (or run with GITHUB_API_MOCK=1
// and a createMockGithub fixture) so no real HTTP is made. In production the
// factory is unset and real installation Octokit clients are returned
// (with installation tokens cached by @octokit/app).

const fs = require("fs");
const yaml = require("yaml");
const { App } = require("@octokit/app");
const config = require("./config");
const { DEFAULT_POLICY } = require("./policy");

const CHECK_NAME = "LicenseGate";
const COMMENT_MARKER = "<!-- licensegate -->";
const CONFIG_PATH = ".github/licensegate.yml";

let app = null;
let clientFactory = null;

/** Test seam: override how API clients are created. */
function setClientFactory(fn) {
  clientFactory = fn;
}

/** Lazily builds the @octokit/app instance (fail-lazy on bad credentials). */
function getApp() {
  if (app) return app;
  let privateKey = config.PRIVATE_KEY || "";
  if (!privateKey && config.PRIVATE_KEY_PATH) {
    privateKey = fs.readFileSync(config.PRIVATE_KEY_PATH, "utf8");
  }
  app = new App({ appId: config.APP_ID, privateKey });
  return app;
}

/** Installation-scoped Octokit client (or the mock when a factory is set). */
async function getInstallationOctokit(installationId) {
  if (clientFactory) return clientFactory(installationId);
  return getApp().getInstallationOctokit(installationId);
}

/** App-level (JWT) Octokit client, used for Marketplace billing lookups. */
async function getAppOctokit() {
  if (clientFactory) return clientFactory(null);
  return getApp().octokit;
}

class DependencyGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = "DependencyGraphError";
    this.code = "DEPENDENCY_GRAPH_UNAVAILABLE";
  }
}

/**
 * Fetch the dependency diff between base and head via the Dependency Review
 * API: GET /repos/{owner}/{repo}/dependency-review/{basehead}.
 *
 * Returns [{change_type, ecosystem, name, version, license, manifest, scope}]
 * for change_type "added", plus "updated" entries (the API response does not
 * include the previous version, so every "updated" entry is treated as
 * changed and re-scanned).
 *
 * Throws a coded DEPENDENCY_GRAPH_UNAVAILABLE error on 404/403/422
 * (dependency graph disabled, or missing Advanced Security on private repos).
 */
async function getDependencyChanges(octokit, owner, repo, basehead) {
  let data;
  try {
    const res = await octokit.request(
      "GET /repos/{owner}/{repo}/dependency-review/{basehead}",
      { owner, repo, basehead }
    );
    data = res.data;
  } catch (err) {
    if (err && [404, 403, 422].includes(err.status)) {
      throw new DependencyGraphError(
        `Dependency graph unavailable for ${owner}/${repo} (HTTP ${err.status}). ` +
          "Enable the dependency graph on this repository to use LicenseGate."
      );
    }
    throw err;
  }
  const changes = Array.isArray(data) ? data : [];
  return changes
    .filter((c) => c.change_type === "added" || c.change_type === "updated")
    .map((c) => ({
      change_type: c.change_type,
      ecosystem: c.ecosystem || null,
      name: c.name || null,
      version: c.version || null,
      license: c.license || null,
      manifest: c.manifest || null,
      scope: c.scope || null,
    }));
}

/**
 * Load per-repo policy overrides from .github/licensegate.yml at the given
 * ref, merged over the defaults. Missing file -> defaults.
 */
async function getRepoConfig(octokit, owner, repo, ref) {
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: CONFIG_PATH,
      ref,
    });
    if (!res.data || Array.isArray(res.data) || !res.data.content) {
      return Object.assign({}, DEFAULT_POLICY);
    }
    const text = Buffer.from(res.data.content, "base64").toString("utf8");
    const parsed = yaml.parse(text) || {};
    return Object.assign({}, DEFAULT_POLICY, parsed);
  } catch (err) {
    if (err && err.status === 404) return Object.assign({}, DEFAULT_POLICY);
    throw err;
  }
}

async function createCheckRun(octokit, { owner, repo, head_sha }) {
  const res = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: CHECK_NAME,
    head_sha,
    status: "in_progress",
    started_at: new Date().toISOString(),
  });
  return res.data;
}

async function updateCheckRun(
  octokit,
  { owner, repo, check_run_id, conclusion, summary, text }
) {
  const res = await octokit.request(
    "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    {
      owner,
      repo,
      check_run_id,
      status: "completed",
      completed_at: new Date().toISOString(),
      conclusion,
      output: { title: CHECK_NAME, summary, text },
    }
  );
  return res.data;
}

/** Render the PR comment body (always contains COMMENT_MARKER). */
function buildPrComment(evaluation) {
  const lines = [];
  lines.push(COMMENT_MARKER);
  lines.push("## LicenseGate 扫描结果");

  const badge =
    evaluation.verdict === "fail"
      ? "❌ 未通过"
      : evaluation.verdict === "warn"
        ? "⚠️ 通过（有警告）"
        : "✅ 通过";
  lines.push(`**结论：${badge}**`);
  lines.push("");

  const table = (items, title) => {
    lines.push(`### ${title}`);
    lines.push(
      "| 包 | 版本 | 许可证 | 清单文件 | 级别 | 建议 |"
    );
    lines.push("|---|---|---|---|---|---|");
    for (const v of items) {
      const cells = [
        v.name || "-",
        v.version || "-",
        v.license || "未声明",
        v.manifest || "-",
        v.severity || "-",
        v.suggestion || "-",
      ].map((c) => String(c).replace(/\|/g, "\\|"));
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  };

  if (evaluation.violations.length > 0) {
    table(evaluation.violations, `违规 (${evaluation.violations.length})`);
  }
  if (evaluation.warnings.length > 0) {
    table(evaluation.warnings, `警告 (${evaluation.warnings.length})`);
  }
  if (
    evaluation.violations.length === 0 &&
    evaluation.warnings.length === 0
  ) {
    lines.push("本次 PR 引入的依赖全部通过许可证策略检查。");
    lines.push("");
  }
  lines.push(
    "_由 LicenseGate 自动扫描。如需调整策略，请在仓库中添加 `.github/licensegate.yml`。_"
  );
  return lines.join("\n");
}

/**
 * Create or update the LicenseGate PR comment (idempotent via the marker).
 */
async function upsertPrComment(octokit, owner, repo, prNumber, body) {
  const { data: comments } = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }
  );
  const existing = (comments || []).find(
    (c) => c.body && c.body.includes(COMMENT_MARKER)
  );
  if (existing) {
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    return { action: "updated", id: existing.id };
  }
  const res = await octokit.request(
    "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner,
      repo,
      issue_number: prNumber,
      body,
    }
  );
  return { action: "created", id: res.data && res.data.id };
}

// --- Mock mode ---------------------------------------------------------------

/**
 * Build a mock GitHub API client for tests.
 * fixture: { dependencyChanges, config, configMissing, existingComments }
 * The returned mock records every call on mock.calls.
 */
function createMockGithub(fixture) {
  const f = fixture || {};
  const calls = { requests: [], checkRuns: [], checkRunUpdates: [], comments: [] };
  const existingComments = (f.existingComments || []).map((c) => Object.assign({}, c));
  let nextCommentId = 1000;
  let nextCheckRunId = 2000;

  const mock = {
    calls,
    request: async (route, params) => {
      calls.requests.push({ route, params });
      if (String(route).includes("dependency-review")) {
        return { data: f.dependencyChanges || [] };
      }
      if (String(route).includes("marketplace_listing")) {
        if (f.marketplaceError) {
          throw Object.assign(new Error("Marketplace unavailable"), { status: 500 });
        }
        return { data: f.marketplaceAccount || { marketplace_purchase: { plan: { name: "Free" } } } };
      }
      // check-runs + issue comments go through octokit.request in production
      // (the @octokit/app v16 client exposes only .request), so the mock
      // routes them here too and records them in the same call logs.
      if (route === "POST /repos/{owner}/{repo}/check-runs") {
        const id = nextCheckRunId++;
        calls.checkRuns.push(params);
        return { data: Object.assign({ id }, params) };
      }
      if (route === "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}") {
        calls.checkRunUpdates.push(params);
        return { data: params };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        if (f.configMissing) {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }
        const content = Buffer.from(
          yaml.stringify(f.config || {}),
          "utf8"
        ).toString("base64");
        return { data: { content, encoding: "base64", path: CONFIG_PATH } };
      }
      if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        return { data: existingComments.slice() };
      }
      if (route === "POST /repos/{owner}/{repo}/issues/{issue_number}/comments") {
        const id = nextCommentId++;
        calls.comments.push(Object.assign({ action: "created" }, params));
        existingComments.push({ id, body: params.body });
        return { data: { id } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}") {
        calls.comments.push(Object.assign({ action: "updated" }, params));
        return { data: { id: params.comment_id } };
      }
      throw Object.assign(new Error("not mocked: " + route), { status: 404 });
    },
    repos: {
      getContent: async () => {
        if (f.configMissing) {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        }
        const content = Buffer.from(
          yaml.stringify(f.config || {}),
          "utf8"
        ).toString("base64");
        return { data: { content, encoding: "base64", path: CONFIG_PATH } };
      },
    },
    checks: {
      create: async (params) => {
        const id = nextCheckRunId++;
        calls.checkRuns.push(params);
        return { data: Object.assign({ id }, params) };
      },
      update: async (params) => {
        calls.checkRunUpdates.push(params);
        return { data: params };
      },
    },
    issues: {
      listComments: async () => ({ data: existingComments.slice() }),
      createComment: async (params) => {
        const id = nextCommentId++;
        calls.comments.push(Object.assign({ action: "created" }, params));
        existingComments.push({ id, body: params.body });
        return { data: { id } };
      },
      updateComment: async (params) => {
        calls.comments.push(Object.assign({ action: "updated" }, params));
        return { data: { id: params.comment_id } };
      },
    },
  };
  return mock;
}

module.exports = {
  CHECK_NAME,
  COMMENT_MARKER,
  setClientFactory,
  getApp,
  getInstallationOctokit,
  getAppOctokit,
  getDependencyChanges,
  getRepoConfig,
  createCheckRun,
  updateCheckRun,
  buildPrComment,
  upsertPrComment,
  createMockGithub,
  DependencyGraphError,
};
