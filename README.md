# LicenseGate

PR 开源许可证合规门禁 —— 轻量版 FOSSA。GitHub App 监听 Pull Request，
当 PR 引入「坏许可证」依赖时让 Check 失败，并在 PR 下自动留言说明。

## 它做什么

1. 监听 `pull_request`（opened / synchronize / reopened）。
2. 创建 `LicenseGate` Check Run（in_progress）。
3. 调 GitHub **Dependency Review API** 取 base…head 的依赖 diff（只看新增 + 更新）。
4. 读仓库 `.github/licensegate.yml` 的策略覆盖，评估每个依赖的许可证：
   - **deny**（强 copyleft / 网络 copyleft / source-available：GPL*/AGPL*/SSPL/EUPL/OSL）→ 违规，Check **failure**
   - **warn**（弱 copyleft：LGPL*/MPL*/EPL*/CDDL*）→ 警告，Check 照常 success 但提示复核
   - **unknown**（未声明 / NOASSERTION / 无法识别）→ 默认视为违规（`fail_on_unknown: true`）
   - **allow**（MIT / Apache-2.0 / BSD / ISC / CC0 等）→ 通过
5. 更新 Check Run、在 PR 下创建/更新留言（含 `<!-- licensegate -->` 标记实现幂等），并把扫描结果写入 SQLite。
6. 任何一步出错 → Check 标记为 **neutral** 并写明原因，服务永不崩溃。

## 本地运行

```bash
cd app
npm install
cp .env.example .env   # 填入真实值；占位值也能启动，收到 webhook 时才真正鉴权
npm start              # 默认 :3000
npm test               # node --test test/*.test.js
```

创建真实 GitHub App 时需要：

- **权限**：`checks:write`、`pull_requests:write`、`contents:read`（读依赖图 + 策略文件）、`metadata:read`
- **Webhook 事件**：只需订阅 `pull_request`
- **Webhook secret**：填入 `WEBHOOK_SECRET`，回调地址指向 `https://你的域名/webhooks`

## Webhook 签名校验原理

GitHub 每次回调都在 `x-hub-signature-256` 头里带上
`sha256=<HMAC_SHA256(WEBHOOK_SECRET, 原始请求体)>`。

服务端用 `express.raw()` 保留原始 body（**不能**先过 `express.json()`，
否则 HMAC 对不上），再用 `@octokit/webhooks` 的 `Webhooks#verify()`
做常量时间比较。校验失败 → `401`，不做任何处理。

> 注意：代码里用的是 `Webhooks` 类的实例方法 `verify(payload, signature)`，
> 因为 `@octokit/webhooks` v14 不再顶层导出 `verify` 函数。

## 仓库策略文件（可选）

在仓库根目录放 `.github/licensegate.yml`，在默认策略上做覆盖：

```yaml
# 额外拒绝 / 额外放行的 SPDX id（显式名单优先于内置分类）
deny: []
allow: ["GPL-3.0-only"]   # 例：公司已购商业授权的 GPL 组件可放行
fail_on_unknown: true     # 未知许可证是否阻断，默认 true
fail_on_warning: false    # 弱 copyleft 是否阻断，默认 false
ignore_scopes: ["development"]  # 跳过的依赖 scope，默认跳过 dev 依赖
```

## API：`POST /api/v1/check`

给 MCP 包用的无状态扫描接口（默认无鉴权，生产环境请在网关层限制来源 IP）：

请求：

```json
{
  "dependencies": [
    {"name": "left-pad", "version": "1.3.0", "license": "MIT", "ecosystem": "npm"},
    {"name": "some-gpl-lib", "version": "1.0", "license": "GPL-3.0-only", "ecosystem": "npm"}
  ]
}
```

响应（始终用默认策略评估）：

```json
{
  "verdict": "fail",
  "violations": [
    {
      "name": "some-gpl-lib", "version": "1.0", "license": "GPL-3.0-only",
      "ecosystem": "npm", "manifest": null, "severity": "deny",
      "reason": "License \"GPL-3.0-only\" is denied (strong copyleft / source-available).",
      "suggestion": "Replace with an MIT/Apache-2.0 licensed alternative."
    }
  ],
  "warnings": []
}
```

`verdict` 为 `pass` / `warn` / `fail` 之一；每条违规/警告都带 `severity`、
`reason`（中文场景可直接展示）、`suggestion`（英文，给开发者看的修复建议）。

其他端点：`GET /healthz` → `{"ok":true}`；`GET /dashboard` → 扫描仪表盘。

## 仪表盘

`GET /dashboard`（HTTP Basic Auth：`DASHBOARD_USER` / `DASHBOARD_PASS`，
留空则免密并在日志里告警一次）：

- `/dashboard` —— 组织列表
- `/dashboard/:org` —— 最近 50 次扫描（仓库 / PR / 结论 / 违规数 / 时间）+
  违规最多的许可证 Top 10
- `/dashboard/:org/export.csv` —— 违规明细 CSV 下载

服务端直出 HTML + 内联 CSS，无前端构建。

## 计费

- `BILLING_ENABLED=false`（默认）：全部按免费版，**每个安装限 1 个仓库**；
  超出仓库的扫描结论为 `neutral`，提示 "Free plan covers 1 repo — upgrade to Pro"。
- `BILLING_ENABLED=true`：用 App JWT 调
  `GET /marketplace_listing/accounts/{account_id}` 查订阅，plan 名含 "pro"
  即为 Pro（仓库不限量）。任何异常都降级为免费版，扫描不受影响。

## Dependency Review API 的假设

实现基于 `GET /repos/{owner}/{repo}/dependency-review/{basehead}`，
返回数组，每项含 `change_type`（added / updated / removed）、`ecosystem`、
`name`、`version`、`license`（SPDX id 或表达式）、`manifest`、`scope`。

做出的假设（见 `src/github.js` 注释）：

1. **404 / 403 / 422 → 依赖图不可用**：抛 `DEPENDENCY_GRAPH_UNAVAILABLE`
   编码错误，Check 标 neutral。私有仓库需要开启依赖图（Review API 需
   Advanced Security / 依赖图启用）。
2. **`updated` 条目没有旧版本号**：该接口不返回变更前的版本，
   因此所有 `updated` 条目都视为「已变更」重新扫描。
3. **`license` 字段是单个 SPDX id 或表达式**（如 `"MIT"`、`"GPL-3.0-only OR MIT"`）；
   `NOASSERTION` / 空值按 unknown 处理。

## 目录结构

```
app/
  src/
    index.js      # Express 接线：/webhooks、/api/v1/check、/healthz、/dashboard
    config.js     # 环境变量（启动时永不因占位值崩溃，鉴权全部 lazy）
    policy.js     # 纯函数：classifyLicense / evaluateDependencies（可单测）
    github.js     # @octokit/app 封装 + setClientFactory/createMockGithub 测试缝
    store.js      # better-sqlite3：scans / violations 两张表
    billing.js    # 免费版 vs Marketplace Pro 计划判定
    dashboard.js  # 服务端渲染的中文仪表盘
  test/
    policy.test.js   # 策略单测
    webhook.test.js  # 全链路集成测试（GitHub API 全 mock）
  .env.example
```

## 测试说明

`test/webhook.test.js` 用 `github.setClientFactory(() => mock)` 把整个
GitHub API 层换成 `createMockGithub(fixture)`，在随机端口启动真实 Express，
发送带正确 HMAC 签名的 `pull_request` payload，断言：Check Run 先创建后更新
（failure / success）、PR 留言含包名+许可证+`<!-- licensegate -->` 标记、
扫描落库。另覆盖：坏签名 → 401 且零 API 调用；依赖图 404 → neutral 且服务存活。
