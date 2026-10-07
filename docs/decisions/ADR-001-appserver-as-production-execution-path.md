# ADR-001 — 生产执行路径使用 ZCode app-server

Status: Accepted
Date: 2026-10-07（记录日期，决策早于此）

## Context

Bridge 早期通过历史 CLI `--prompt --json` 与 ZCode 交互。当前生产路径改为 `node zcode.cjs app-server --stdio`。两套路径的协议、事件模型和取消语义不同。

## Decision

- 生产任务使用 `ZCodeAppServerAdapter`。
- 历史 CLI adapter、envelope、loader 与 `GitWorktreeProvider` 保留为 legacy 模块及其测试，不从共享公共入口导出，也不参与生产任务路径。
- 不把 legacy CLI 的重试、快照排除或 worktree 创建语义套用到当前生产路径。

## Rationale

app-server 是 ZCode 桌面宿主实际使用的运行通道，能提供 session 事件、交互（权限/输入）、模型选择与 usage 等能力；CLI 路径没有等价信息，无法支撑任务生命周期与可观测性需求。

## Consequences

- app-server 协议是私有且随安装版本变化，Bridge 必须按版本观测能力，不能依赖跨版本稳定契约。
- 任何"当前 ZCode 支持什么"的结论都要标注观测版本，未实跑的部分保持 NOT RUN。
- legacy 模块仍然需要维护与测试，但不承担生产职责。

## Evidence

- `docs/ARCHITECTURE.md`："生产执行使用 ZCodeAppServerAdapter。历史 CLI adapter、envelope、loader 和 GitWorktreeProvider 保留为 legacy 模块及其测试，不从共享公共入口导出，也不参与生产任务路径。"
- `docs/ZCODE_RUNTIME.md`："当前生产路径是 `node zcode.cjs app-server --stdio`，不是历史 CLI `--prompt --json`。"
