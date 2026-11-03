# ADR-022：Doctor 绑定当前生命周期权威

> Status: DECISION
> Date: 2026-11-03
> Decision: 本次缺陷修复采用；不改变任务生命周期与恢复授权

## Context

远程 master `879568c2` 的生产入口使用 SQLite，doctor 却重新打开 JSON
TaskStore 并检查 `.tasks/.recovery.lock`。Task78 已有 SQLite Recovery Hold 时，
doctor 仍报告无任务、无锁，无法用于判断是否可以重新派发。

## Decision

生产 Host 将同一个 SQLite Authority 的只读诊断回调传给 doctor。诊断读取
同一事务内的 Task 投影、Operation、Recovery 分类和一致性校验结果，同时
报告该 Manager 的启动恢复围栏。失败时报告 unknown/error，禁止回退 JSON。

Recovery snapshot 增加内部 `task_projections`，覆盖尚未分配 Operation 的 queued
任务，不改变 SQLite schema。显式 JSON 观察入口继续支持原有离线工具与测试；
仅提供 SQLite dataRoot 而未绑定 Authority 时必须报告未绑定，不能扫描 JSON。

公共 MCP 工具名、输入输出 schema、任务状态、Claim/Capacity 与 Hold 语义保持。
不因 PID 不在、doctor 报告或升级自动删除 Hold；既有 Hold 仍按 ADR-018/019
处理，生产行政结案仍需单独授权。

## Consequences

doctor 能定位持久 Hold、排队和清理占用；它不证明 OS 清理完成，也不执行恢复。
回归须覆盖空根、queued、持久 Hold、Manager 围栏、读取失败及 JSON 误导数据。
