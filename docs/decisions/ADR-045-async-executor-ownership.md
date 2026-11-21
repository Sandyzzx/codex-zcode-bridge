# ADR-045：独立 Async Executor 所有权

> Status: ACCEPTED（Owner 条件批准；架构方向已接受，实现与发布仍按本 ADR 验收门执行）
> Date: 2026-11-21
> Baseline: `origin/preview` `1f9ff9ef37528205e76156e13fe06ed2b1fd3711`
> Related architecture: [BRIDGE_ASYNC_EXECUTION_V1.md](../architecture/BRIDGE_ASYNC_EXECUTION_V1.md)

## Context

Preview.10 的 `SqliteLifecycleMcpAuthority` 在 MCP stdio Host 进程内运行。SQLite 已是唯一持久事实，Worker 也通过私有管道提交 Result，但调度队列、active run、Worker 句柄、交互通道、Runtime Event channel 和 Start Plan 私有认证仍由这个 Host 内 Manager 持有。受控 stdin EOF 可以让 Worker 完成；但 SDK/Host 强制结束 Manager 时，原 Worker 的 completed Result 可能被 Recovery 替换为 `worker_exited_without_result`。

因此问题不是缺少第二个状态机，而是执行所有权绑定在可随 Codex Turn 消失的通信进程上。

## Decision

1. 每个规范化 Authority Root 只允许一个用户级 Background Executor 持有现有 Manager、SQLite writer、Worker IPC、Official Runtime、Cancellation、Cleanup 和 Recovery。
2. MCP stdio 进程降为通信 Adapter。MCP 断开、请求取消或 Codex Turn 结束只结束该请求等待，不取消已受理 Task；显式 Task Cancel 仍走原合同。
3. CLI 与 Web Console 使用同一 Executor Control Client。它们不初始化 Manager，不打开可写 Store，不实现第二套调度/恢复。
4. 首版 Executor 显式启动、同用户本地 IPC、单 Root 单实例。不做 Windows Service、Supervisor、自动拉起、空闲退出或远程访问。
5. 单实例所有权由 Authority Root 内的 Executor Lifetime Lease 保证：原子创建、精确 PID + start fingerprint 存活验证、bounded heartbeat、显式 stale lease 清理；Bootstrap lock、Admission CAS 和 named pipe 存在性均不是 lifetime owner 证据。
6. 后台 Executor 正常退出采用 Idle-only Shutdown：存在 queued Attempt、active run、pending interaction、cleanup pending/unverified/hold、`WRITER_INTENT`、poison root 或 lease 释放未知时拒绝退出。返回 `EXECUTOR_SHUTDOWN_NOT_IDLE` 后必须撤销本次 Shutdown fence，恢复 Admission 和正常任务控制。不得复用现有 `Manager.shutdown()` 的主动取消语义作为 Executor 正常退出。
7. Lifetime Lease 覆盖 Manager/SQLite Store 的整个可写生命周期。退出顺序必须是关闭 named pipe 与可写 Store、确认 Store closed 之后才写 released lease；Store 或 lease 释放失败保持 `EXECUTOR_LEASE_RELEASE_UNKNOWN` 并 fail closed，不得创建第二个 Authority。
8. Wake Intent/Delivery 的持久化必须复用现有 SQLite v14 Authority：优先作为 terminal Operation 的 bounded `observation_recorded` 事实记录；若 evidence/schema 无法安全承载，PR 5 前单独裁决。禁止为 Wake 创建第二任务持久化权威。
9. SQLite v14、Task/Attempt/Operation/Result/Cleanup/Release、官方 ZCode Runtime 和现有 Recovery 合同保持不变。
10. Wake Adapter 独立于 Executor 生命周期；Queue 失败或未知不影响已持久化 Result 与 Cleanup/Release。

## Rejection

- 不引入第二数据库、第二状态机、第二 Worker 执行引擎或独立 Web 调度器。
- 不把 Web Notify 当作唤醒成功。
- 不用 detached 子进程标志推断 Windows 进程树安全；必须有真实 Host E2E。
- 不修改 Codex/ZCode 私有状态或凭据。

## Validation Gate

实施首阶段必须证明：真实 Codex Host 关闭后，已受理 Attempt 继续执行并提交原 Result，随后按现有合同完成 Cleanup 与 Release。若失败，停止 CLI/Web/Wake 功能迁移，先修复执行所有权。
