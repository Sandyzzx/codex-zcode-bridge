# Preview 2.0.0-preview.14 Release

> Status: RESEARCH
> Date: 2026-11-23
> Preview base: `c7bfc28b1112dead95ae4179a00962de76051920`
> Source PR: #131
> Release PR: pending

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
PREVIEW_VERSION: 2.0.0-preview.14
PREVIEW_BASE: c7bfc28b1112dead95ae4179a00962de76051920
RELEASE_COMMIT: PENDING
RELEASE_TREE: PENDING
TAG: codex-zcode-bridge-preview-v2.0.0-preview.14
RELEASE_URL: PENDING
ZIP_SHA256: PENDING
```

## Repository Boundary

发布准备不修改 `master`，不删除历史 Worktree/分支，不接触生产 SQLite、Executor
Lease 或正在运行的 Bridge Task。历史归档与清理只能在 `PREVIEW_RELEASED=YES`
之后开始。
