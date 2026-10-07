# ADR-004 — 本地材料只作观察面，不作控制面

Status: Proposed（需要 Master 决策）
Date: 2026-10-07

## Context

ZCode 在本机留下多种材料：app-server 事件、CLI 的 metadata/output/model-io/rollout 文件、日志，以及 Desktop 的 `tasks-index.sqlite`。其中一部分结构已经在研究阶段被观测过，但都属于未公开、随版本变化的内部结构。

在 bridge 之外的历史讨论中已经出现过方向性结论：控制面走 app-server RPC，本地文件只用于观察，且 `task-index` 的写入是需要单独治理的既有例外。这一结论目前没有在仓库文档里形成决策记录，因此本条标为 Proposed。

## Proposed decision

- 控制面只使用 app-server 及其支持的 RPC。
- 本地 metadata、rollout、日志、Desktop 索引作为观察来源，读取只读、失败可降级，不得成为任务状态的事实来源。
- 观察来源的优先级低于 app-server 事件；本地读取必须在隐私边界内进行，不做原始 reasoning 或工具参数的转发。
- Desktop 索引同步保持 best effort 的旁路写入，明确不是权威数据；它是当前唯一的本地写入例外。

## Rationale

本地结构没有稳定性承诺。把它们当作控制面会让 Bridge 在 ZCode 升级后静默失效，也会把未验证的推断变成任务状态。

## Consequences

- 恢复与状态判定必须能用原生通道解释；本地材料只能提供线索，不能单独定论。
- 观察能力受安装版本影响，需要按版本标注并保留 NOT RUN 记录。
- 如果将来确实需要写本地结构，必须单独走决策，并说明兼容与回滚。

## Evidence

- `docs/ARCHITECTURE.md`："Desktop 索引同步是 best effort，事务内检查 schema 与 Bridge owner、更新有限状态字段，保留用户标题与额外 metadata。回归使用临时 SQLite。真实 Desktop schema/刷新/并发行为受安装版本影响，本轮未写入真实数据库。"
- `docs/INTERFACES.md`："公开进度 usage 仅保留数值 token/cost 字段，隐藏推理、未知 metadata 和原始 RPC error 不转发。"
- `docs/ZCODE_RUNTIME.md`：运行配置与发现逻辑只读官方 provider 配置，不复制、不改写、不把凭据写入任务 metadata。
