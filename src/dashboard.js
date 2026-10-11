"use strict";

// Server-rendered dashboard (no frontend build). Mounted at /dashboard.
// HTTP Basic Auth via DASHBOARD_USER / DASHBOARD_PASS; when unset, auth is
// skipped and a one-time warning is logged.

const express = require("express");
const config = require("./config");
const store = require("./store");

const router = express.Router();

let authWarningLogged = false;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — LicenseGate</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0; background: #f6f8fa; color: #24292f; }
  header { background: #161b22; color: #fff; padding: 16px 24px; }
  header h1 { margin: 0; font-size: 20px; }
  header a { color: #79c0ff; }
  main { max-width: 1000px; margin: 24px auto; padding: 0 16px; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px;
          padding: 16px 20px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eaeef2; }
  th { color: #57606a; font-weight: 600; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px;
          font-size: 12px; font-weight: 600; }
  .success { background: #dafbe1; color: #1a7f37; }
  .failure { background: #ffebe9; color: #cf222e; }
  .neutral { background: #eaeef2; color: #57606a; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: #57606a; }
  .btn { display: inline-block; padding: 6px 14px; border: 1px solid #d0d7de;
         border-radius: 6px; background: #f6f8fa; font-size: 13px; }
</style>
</head>
<body>
<header><h1>🛡️ LicenseGate 仪表盘</h1></header>
<main>${body}</main>
</body>
</html>`;
}

function conclusionPill(conclusion) {
  const cls =
    conclusion === "success"
      ? "success"
      : conclusion === "failure"
        ? "failure"
        : "neutral";
  const label =
    conclusion === "success"
      ? "通过"
      : conclusion === "failure"
        ? "未通过"
        : conclusion === "neutral"
          ? "跳过"
          : esc(conclusion || "-");
  return `<span class="pill ${cls}">${label}</span>`;
}

function checkBasicAuth(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
  return user === config.DASHBOARD_USER && pass === config.DASHBOARD_PASS;
}

router.use((req, res, next) => {
  if (!config.DASHBOARD_USER) {
    if (!authWarningLogged) {
      console.warn(
        "[dashboard] DASHBOARD_USER is not set — dashboard auth is DISABLED."
      );
      authWarningLogged = true;
    }
    return next();
  }
  if (checkBasicAuth(req)) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="LicenseGate"');
  return res.status(401).send("需要登录");
});

// GET /dashboard — list of orgs
router.get("/", (req, res) => {
  const orgs = store.getOrgs();
  const items = orgs
    .map((o) => `<li><a href="/dashboard/${esc(o)}">${esc(o)}</a></li>`)
    .join("\n");
  res.send(
    page(
      "组织列表",
      `<div class="card"><h2>组织</h2>` +
        (orgs.length
          ? `<ul>${items}</ul>`
          : `<p class="muted">暂无扫描记录。</p>`) +
        `</div>`
    )
  );
});

// GET /dashboard/:org — recent scans + top violated licenses
router.get("/:org", (req, res) => {
  const org = req.params.org;
  const scans = store.getRecentScans(org, 50);
  const top = store.getTopLicenses(org, 10);

  const scanRows = scans
    .map(
      (s) => `<tr>
        <td><a href="/dashboard/${esc(org)}">${esc(s.repo)}</a></td>
        <td>#${esc(String(s.pr_number))}</td>
        <td>${conclusionPill(s.conclusion)}</td>
        <td>${esc(String(s.violation_count))}</td>
        <td class="muted">${esc(s.created_at)}</td>
      </tr>`
    )
    .join("\n");

  const topRows = top
    .map(
      (t) => `<tr><td>${esc(t.license || "未声明")}</td><td>${esc(String(t.count))}</td></tr>`
    )
    .join("\n");

  res.send(
    page(
      org,
      `<div class="card">
         <h2>${esc(org)}</h2>
         <p><a class="btn" href="/dashboard/${esc(org)}/export.csv">⬇ 导出违规 CSV</a>
            <a class="btn" href="/dashboard">← 返回组织列表</a></p>
       </div>
       <div class="card"><h3>最近扫描</h3>
         ${
           scans.length
             ? `<table><thead><tr><th>仓库</th><th>PR</th><th>结论</th><th>违规数</th><th>扫描时间</th></tr></thead><tbody>${scanRows}</tbody></table>`
             : `<p class="muted">暂无扫描记录。</p>`
         }
       </div>
       <div class="card"><h3>违规最多的许可证 Top 10</h3>
         ${
           top.length
             ? `<table><thead><tr><th>许可证</th><th>次数</th></tr></thead><tbody>${topRows}</tbody></table>`
             : `<p class="muted">暂无违规记录。</p>`
         }
       </div>`
    )
  );
});

// GET /dashboard/:org/export.csv — CSV download of violations
router.get("/:org/export.csv", (req, res) => {
  const org = req.params.org;
  const rows = store.getViolations(org, 5000);
  const header = [
    "scanned_at",
    "repo",
    "pr_number",
    "name",
    "version",
    "ecosystem",
    "license",
    "manifest",
    "severity",
  ];
  const csvCell = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.scanned_at,
        r.repo,
        r.pr_number,
        r.name,
        r.version,
        r.ecosystem,
        r.license,
        r.manifest,
        r.severity,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="licensegate-${org}-violations.csv"`
  );
  res.send("\uFEFF" + lines.join("\n"));
});

module.exports = router;
