# 文档索引 / Documentation

> Status: AUTHORITATIVE
> Last updated: 2026-11-27（Stable 2.0.0 结项清理）
> Last verified: 2026-11-27，核对 Stable 2.0.0 Release 身份、Stable 2.0.0 运行时基线和当前权威文档集合；未执行新的真实模型任务。
> Verified against: `dfee062e7c30261763f642106d9ae18b48ce1ae0`（`codex-zcode-bridge-v2.0.0`）

English users start at [README.md](../README.md). 中文产品说明见 [README.zh-CN.md](../README.zh-CN.md)。本目录只保留当前产品合同和维护入口。

## 当前入口 / Current references

| 主题 | 文档 |
|---|---|
| 当前发布事实、验收范围与限制 | [PROJECT_STATE.md](PROJECT_STATE.md) |
| 生产架构、生命周期、恢复与安全边界 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| MCP、Task、Result、Events、Cancel 与清理接口 | [INTERFACES.md](INTERFACES.md) |
| Core API、Host/Worker 打包与 fork 边界 | [SHARED_CORE.md](SHARED_CORE.md) |
| 官方 ZCode Runtime、Executor 恢复与 SQLite v14 | [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md) |
| 单页 Task Workspace 与 Diagnostics | [WEB_CONSOLE.md](WEB_CONSOLE.md) |
| 测试入口、影响力选择和 CI 门禁 | [testing/README.md](testing/README.md) |
| 插件安装、安全与第三方说明 | [插件 README](../plugins/codex-zcode-bridge/README.md)、[插件安全](../plugins/codex-zcode-bridge/SECURITY.md)、[根安全说明](../SECURITY.md) |

## 状态与历史 / Status and history

`AUTHORITATIVE` 表示当前有效合同。`PASS`、`BLOCKED`、`NOT_RUN`、`UNKNOWN` 和 `UNVERIFIED` 按各自文档标注使用，不互相替代。

历史研究、一次性交付、阶段审计、ADR 正文和旧 Preview 发布记录不再保存在工作树。需要追溯时使用 Git Commit、不可变 Tag 和 GitHub Release：

- [Stable 2.0.0 Release](https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-v2.0.0)
- `git log --decorate --all`、`git show <tag>` 和对应 GitHub PR/CI 记录

`docs/decisions/README.md` 与 `docs/research/master-skill-simplification-20261111.md` 仅保留给生产 Master Skill 的兼容路由，不含 ADR 正文或研究报告，也不代表新的历史目录。
