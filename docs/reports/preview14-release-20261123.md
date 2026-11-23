# Preview 2.0.0-preview.14 Release

> Status: RESEARCH
> Date: 2026-11-23
> Preview base: `c7bfc28b1112dead95ae4179a00962de76051920`
> Source PR: #131
> Release PR: #133

## Release Scope

Preview.14 将 Async Executor PR 2–6 合并到 Preview：

- Authority Root Lifetime Lease、精确 PID/start fingerprint、单 Root 单实例
  仲裁与 Idle-only Shutdown。
- 独立 Executor、bounded Named Pipe IPC、Thin MCP、Control-only Task CLI
  与 loopback Operations Console。
- MCP 断连、Codex Stop 或 Turn 结束只结束请求等待，不取消已受理 Task。
- trusted-local loaded/idle 一次性 Queue Wake，复用 SQLite v14 Wake evidence，
  Queue 失败或未知时不自动重试。
- Async Master Handoff：可靠受理后结束 Turn，Wake 后读取原 Attempt Result、
  Cleanup/Release 并独立验收。

本版本没有新增第二任务数据库、Supervisor、第二状态机、第二 Worker 执行路径
或公共 MCP 工具。SQLite 仍为 v14 ONLY。

## Verification

PR #131 合并提交：
`c7bfc28b1112dead95ae4179a00962de76051920`。

合并后 CI [run 45124466655](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/45124466655)：

- Ubuntu Verify、Windows Verify 两 shard、Windows 聚合 Verify PASS。
- Ubuntu 与 Windows SQLite resource matrix PASS。
- Cost Lab PASS。
- PR-only impact、Fast 与 Integration gates 按 push 事件跳过。

Release Prep 本地验证：

- `npm ci`、`npm run typecheck`、`npm run build`、`npm run validate:plugin`
  与 `git diff --check` PASS。
- `npm run check:generated` 在生成物提交后 PASS，14 个 tracked artifact fresh。
- package、lockfile、两份插件 manifest、MCP server version 均为
  `2.0.0-preview.14`。
- 修改文档的本地 Markdown 链接检查 PASS。
- `plugins/codex-zcode-bridge/dist/bridge.mjs` SHA-256：
  `700d121c1450bcc914feb26cd708834fda929ec34fbb78121e19a317f61ad5b7`。
- `npm ci` 仍报告 3 个 high severity advisories；与当前依赖基线一致，本发布
  准备不修改依赖或宣称已修复。

Release Prep PR #133 CI [run 45129786440](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/45129786440)：

- Impact selection、Fast PR gate、Integration gate、Ubuntu Verify、Windows
  两 shard、Windows 聚合 Verify 与两平台 SQLite resource matrix PASS。
- Cost Lab 按 impact selector skipped。

合并后 Preview push CI [run 45130689135](https://github.com/Sandyzzx/codex-zcode-bridge/actions/runs/45130689135)：

- Cost Lab、Ubuntu Verify、Windows 两 shard、Windows 聚合 Verify 与两平台
  SQLite resource matrix PASS。

2026-11-23 隔离真实 Host E2E：

- loaded/idle trusted-local 自动 Wake：`PASS — REAL`。
- Queue ACK 与新 Turn：`PASS — REAL`，各一次。
- Native MCP Result readback：`PASS — REAL`。
- Result digest、Cleanup verified、Operation released：`PASS — REAL`。
- Master 生命周期独立验收：`PASS — REAL`。
- Desktop Visible：`PASS — REAL`。
- 重复 Worker、Queue、Turn、Result、Cleanup、Release：`NONE`。

证据见
[trusted-local Wake report](trusted-local-wake-20261123.md)。
早期受限 shell readback 失败与旧 Host 版本阻断保留在该报告，不改写为未发生。

## Not Run

- 严格 Wake C（`notLoaded`）：`NOT_RUN`。
- 严格 Wake D / Desktop fully exited：`NOT_RUN`。
- Official Runtime provenance（当前安装 `3.19.0.10774`）：`NOT_RUN`。
- 非空真实工程交付验收：`NOT_RUN`。
- Async Master Skill 真实模型遵循率 A/B：`NOT_RUN`。

## Release Identity

```text
PREVIEW_RELEASED: YES
PREVIEW_VERSION: 2.0.0-preview.14
PREVIEW_BASE: c7bfc28b1112dead95ae4179a00962de76051920
RELEASE_COMMIT: 8d58e9e377a0c47d2523cd179e9c814139308e4e
RELEASE_TREE: e758a0b160e73dd92ddcc9c5eb9f307d794d94fc
TAG: codex-zcode-bridge-preview-v2.0.0-preview.14
TAG_OBJECT: 813dd563cfdf909a4e28a015a87910e7b8806874
RELEASE_URL: https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.14
ZIP_BYTES: 4531996
ZIP_SHA256: ca9aa4c813dfd52b7840fe70f10621dce5426701d3e6fbc78c1282a1ccf97ae3
POST_MERGE_CI: PASS, run 45130689135
LATEST_RELEASE: codex-zcode-bridge-v1.7.2 (Stable, unchanged)
```

## Release Asset Verification

- Annotated Tag peeled commit 与 `RELEASE_COMMIT` 一致；Release 为
  `draft=false`、`prerelease=true`，未设为 Latest。
- GitHub asset digest、回下载 ZIP、`.sha256` 资产和本地构建 ZIP 的 SHA-256
  四方一致；ZIP 可完整解压。
- ZIP 根目录是插件结构，包含 56 个文件；两份 Manifest 与 MCP server version
  均为 `2.0.0-preview.14`。
- 回解压后的 `dist/bridge.mjs` SHA-256 为
  `700d121c1450bcc914feb26cd708834fda929ec34fbb78121e19a317f61ad5b7`；
  隔离 stdio `initialize` 与 `tools/list` PASS，注册 13 个工具。
- ZIP 不包含 `.run`、本地数据库、凭据命名文件、高置信度凭据模式或个人绝对
  路径。

## Repository Boundary

发布准备不修改 `master`，不删除历史 Worktree/分支，不接触生产 SQLite、Executor
Lease 或正在运行的 Bridge Task。历史归档与清理只能在 `PREVIEW_RELEASED=YES`
之后开始。发布后文档回填只记录已发生事实，不移动 Release Tag，也不改变
Stable。
