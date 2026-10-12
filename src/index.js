"use strict";

// LicenseGate GitHub App: fails PR checks when new dependencies introduce
// disallowed open-source licenses.
//
// Webhook verification uses @octokit/webhooks (Webhooks#verify, HMAC-SHA256
// over the raw body, compared against x-hub-signature-256).

const express = require("express");
const { Webhooks } = require("@octokit/webhooks");
const config = require("./config");
const policy = require("./policy");
const github = require("./github");
const billing = require("./billing");
const store = require("./store");
const dashboard = require("./dashboard");

const app = express();

// ---------------------------------------------------------------------------
// Webhook endpoint. Registered BEFORE express.json() so we keep the raw body
// needed for HMAC signature verification.
// ---------------------------------------------------------------------------
app.post(
  "/webhooks",
  express.raw({ type: "application/json", limit: "2mb" }),
  async (req, res) => {
    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch (err) {
      return res.status(400).json({ ok: false, error: "invalid JSON body" });
    }

    // Verify the HMAC signature (fail closed; never crash on bad input).
    // The Webhooks instance is built lazily so placeholder secrets don't
    // break process startup — verification only runs when a webhook arrives.
    let signatureOk = false;
    try {
      const webhooks = new Webhooks({ secret: config.WEBHOOK_SECRET || "unset" });
      signatureOk = await webhooks.verify(
        req.body.toString("utf8"),
        req.headers["x-hub-signature-256"]
      );
    } catch (err) {
      signatureOk = false;
    }
    if (!signatureOk) {
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    const event = req.headers["x-github-event"];
    if (event === "ping") return res.json({ ok: true, pong: true });
    if (event === "marketplace_purchase") {
      // Paid-plan lifecycle: purchased / changed / cancelled. Handled by
      // billing.js; never throws (malformed payloads are ignored, not 500s).
      try {
        const result = await billing.handleMarketplacePurchase(payload);
        return res.json(
          Object.assign({ ok: true, handled: "marketplace_purchase" }, result)
        );
      } catch (err) {
        console.error("[webhook] marketplace_purchase handling failed:", err);
        return res
          .status(500)
          .json({ ok: false, error: (err && err.message) || String(err) });
      }
    }
    if (
      event !== "pull_request" ||
      !["opened", "synchronize", "reopened"].includes(payload.action)
    ) {
      return res.json({ ok: true, ignored: true });
    }

    try {
      await handlePullRequest(payload);
      return res.json({ ok: true });
    } catch (err) {
      // The scan already tried to leave a neutral check run; report but
      // never crash the server.
      console.error("[webhook] pull_request handling failed:", err);
      return res
        .status(500)
        .json({ ok: false, error: (err && err.message) || String(err) });
    }
  }
);

// JSON body parsing for the remaining routes.
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// Shared backend for the MCP package: scan an arbitrary dependency list.
// No auth here — restrict at the network layer in production.
// ---------------------------------------------------------------------------
app.post("/api/v1/check", (req, res) => {
  const deps = (req.body && req.body.dependencies) || [];
  const result = policy.evaluateDependencies(deps, policy.DEFAULT_POLICY);
  res.json(result);
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

app.use("/dashboard", dashboard);

// ---------------------------------------------------------------------------
// PR scan pipeline
// ---------------------------------------------------------------------------

function summarizeEvaluation(evaluation, depCount) {
  const v = evaluation.violations.length;
  const w = evaluation.warnings.length;
  if (evaluation.verdict === "fail") {
    return {
      conclusion: "failure",
      summary: `发现 ${v} 个许可证违规 — 请替换或取得例外后重新推送。`,
      text:
        `本次 PR 新增/更新了 ${depCount} 个依赖，其中 ${v} 个违反许可证策略。\n\n` +
        evaluation.violations
          .map((x) => `- ${x.name}@${x.version || "?"} (${x.license || "未声明"}): ${x.reason}`)
          .join("\n"),
    };
  }
  if (evaluation.verdict === "warn") {
    return {
      conclusion: "success",
      summary: `通过，但有 ${w} 个弱 copyleft / 未知许可证警告，请人工复核。`,
      text:
        `本次 PR 新增/更新了 ${depCount} 个依赖，无阻断性违规，但有 ${w} 个警告：\n\n` +
        evaluation.warnings
          .map((x) => `- ${x.name}@${x.version || "?"} (${x.license || "未声明"}): ${x.reason}`)
          .join("\n"),
    };
  }
  return {
    conclusion: "success",
    summary: `全部 ${depCount} 个新增/更新依赖通过许可证检查。`,
    text: "未发现许可证违规。",
  };
}

async function handlePullRequest(payload) {
  const installationId =
    payload.installation && payload.installation.id;
  const repoFull = payload.repository || {};
  const owner = (repoFull.owner || {}).login;
  const repo = repoFull.name;
  const prNumber = payload.pull_request.number;
  const headSha = payload.pull_request.head.sha;
  const baseSha = payload.pull_request.base.sha;

  const octokit = await github.getInstallationOctokit(installationId);

  let checkRunId = null;
  try {
    const checkRun = await github.createCheckRun(octokit, {
      owner,
      repo,
      head_sha: headSha,
    });
    checkRunId = checkRun.id;

    const basehead = `${baseSha}...${headSha}`;
    const changes = await github.getDependencyChanges(
      octokit,
      owner,
      repo,
      basehead
    );
    const policyCfg = await github.getRepoConfig(octokit, owner, repo, headSha);
    const evaluation = policy.evaluateDependencies(changes, policyCfg);

    // Billing gate: free plan covers 1 repo per installation.
    // NOTE: the Marketplace account id is the org/user id (repository owner),
    // not the app installation id — the plan lookup keys on the account.
    const accountId = (repoFull.owner && repoFull.owner.id) || installationId;
    const alreadyTracked = store.hasRepo(installationId, repo);
    const repoCount =
      store.countDistinctRepos(installationId) + (alreadyTracked ? 0 : 1);
    const plan = await billing.getPlan(accountId, repoCount);

    let summary, text, conclusion;
    if (repoCount > plan.repoLimit) {
      conclusion = "neutral";
      summary = "Free plan covers 1 repo — upgrade to Pro";
      text =
        `当前为 Free 计划，仅覆盖 1 个仓库。` +
        `该安装已扫描 ${repoCount} 个仓库，超出部分本次跳过检查。` +
        `升级到 Pro 可解锁全部仓库。`;
    } else {
      ({ conclusion, summary, text } = summarizeEvaluation(
        evaluation,
        changes.length
      ));
    }

    await github.updateCheckRun(octokit, {
      owner,
      repo,
      check_run_id: checkRunId,
      conclusion,
      summary,
      text,
    });

    await github.upsertPrComment(
      octokit,
      owner,
      repo,
      prNumber,
      github.buildPrComment(evaluation)
    );

    store.recordScan(
      {
        installation_id: installationId,
        org: owner,
        repo,
        pr_number: prNumber,
        head_sha: headSha,
        base_sha: baseSha,
        conclusion,
        violation_count: evaluation.violations.length,
      },
      evaluation.violations
    );
  } catch (err) {
    // Never leave the PR hanging: mark the check neutral with the error.
    const message =
      err && err.code === "DEPENDENCY_GRAPH_UNAVAILABLE"
        ? err.message
        : `LicenseGate 扫描失败：${(err && err.message) || String(err)}`;
    try {
      if (checkRunId) {
        await github.updateCheckRun(octokit, {
          owner,
          repo,
          check_run_id: checkRunId,
          conclusion: "neutral",
          summary: "LicenseGate 未能完成扫描",
          text: message,
        });
      }
    } catch (inner) {
      console.error("[webhook] failed to mark check run neutral:", inner);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log(`LicenseGate listening on port ${config.PORT}`);
  });
}

module.exports = { app, handlePullRequest };
