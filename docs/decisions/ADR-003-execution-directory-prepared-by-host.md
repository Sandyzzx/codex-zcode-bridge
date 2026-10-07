# ADR-003 — 执行目录由调用宿主准备，Bridge 不创建也不删除

Status: Accepted
Date: 2026-10-07（记录日期，决策早于此）

## Context

任务需要隔离的执行目录才能安全修改代码。是否隔离、隔离多深、以及何时清理，属于调用宿主的工程判断；Bridge 无法知道宿主的工作区所有权、代码托管方式与保留策略。

## Decision

- `workspace` 是绝对项目路径，同时作为 ZCode Desktop 的项目身份。
- `worktree_path` 是可选的、由调用宿主准备的实际执行目录。
- Bridge 不创建、不选择、不删除 worktree。

## Rationale

把破坏性文件系统操作留给拥有上下文的调用方。Bridge 只负责在给定目录内执行任务，避免在不知道宿主意图的情况下创建或删除工作树。

## Consequences

- 隔离性由调用宿主保证；Bridge 不能承诺任务之间互不影响。
- 同一可变目录上的任务被串行化；不同项目根可并发。
- 任务记录里的执行目录可能被宿主之后移除，历史记录不因此失效。

## Evidence

- `docs/INTERFACES.md`："`workspace` 是绝对项目路径；`worktree_path` 是宿主已准备的执行目录。Bridge 不创建或删除 worktree。"
- `docs/ARCHITECTURE.md`：说明历史 `GitWorktreeProvider` 属于 legacy，不在生产路径上。
