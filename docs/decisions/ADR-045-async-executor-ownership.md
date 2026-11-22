# ADR-045：独立 Async Executor 所有权

> Status: ACCEPTED（Owner 条件批准；架构方向已接受）
> Implementation status: PARTIAL / BLOCKED — PR 2/2.5/3/4/5 candidate；未合入 Preview，未发布
> Date: 2026-11-22
> Baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1`
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

## PR 2 Implementation Record

PR 2 candidate 已实现 lifetime lease、精确 PID/start fingerprint、legacy Host
互斥、Idle-only Shutdown、Named Pipe IPC、Thin MCP control transport，以及
fake Worker 跨进程 Result/Cleanup/Release E2E。确定性 IPC、Lease、单实例、
32 MiB Result 和 reconnect 测试通过。PR #120 remediation 进一步让 legacy Host
与 Executor 共用生产 Authority/Start Plan/model-routing/diagnostics composition，
把模型工具和完整 Doctor 经 Executor IPC 代理，并关闭生产 Executor 的测试参数
入口；启动失败按精确 Lease 与 Store close 证据回滚或 fail closed。

开发门禁采用 `Local Verification During Development, Full CI Before Release`：
普通功能提交只跑 typecheck、构建所需产物、受影响测试和关键 E2E；延期
`FULL_SUITE` 必须先执行直接变更与受影响域的安全测试，且不得报告为完整回归
PASS。完整 Windows/Ubuntu/Stress 统一在 Executor 功能链的 Release Candidate
边界执行。

真实 Codex Desktop 关闭后的 E2E 仍未运行，原因是不得关闭 Owner 当前正在使用的
Desktop；真实 Official Runtime 也没有新的付费模型授权。因此 ADR-045 的
`Validation Gate` 尚未满足，PR 2 只能以 `PARTIAL / BLOCKED` 提交评审，不得
合入 Preview、发布或迁移 CLI/Web/Wake。

## PR 2.5 Implementation Record

PR 2.5 把 shipped `bridge.mjs` 收敛为单一 Thin MCP：

- `src/host/stdio.ts` 只注册 MCP 工具并通过 `ExecutorControlClient` 调用
  Executor；不构造 Manager、Store、Worker、Adapter、Official Runtime 或
  本地 SQLite Authority。
- `in_process` MCP transport 已删除，`ZCODE_BRIDGE_MCP_TRANSPORT` 只接受
  `control`；Executor 未启动时返回 `EXECUTOR_UNAVAILABLE`。
- `src/executor/production-composition.ts` 是唯一生产 Authority composition，
  负责现有 Manager、Start Plan private auth、动态 model routing、Worker
  diagnostics、Doctor 和 model settings。
- MCP 输入 Schema、TaskManager 错误、Host profile、MCP-facing Doctor/model
  契约和 pipe 名为共享模块；MCP、Executor、Adapter、Worker 的静态依赖边界
  由测试锁定。
- 测试专用 legacy lifecycle Host harness 保留在 `test/fixtures/`，不进入
  shipped plugin，也不是生产回退路径。

四层 fake Official Runtime E2E（Thin MCP → Executor → Worker → Official
Adapter）、Thin MCP disconnect/reconnect、完整 MCP schema snapshot、Lease、
IPC、单实例、Result/Cleanup/Release 与 32 MiB Result 回读均通过。真实 Codex
Desktop 关闭后的 E2E、真实 Official ZCode Runtime/provider E2E 和严格 Wake
C/D 仍未运行；PR 2.5 因此保持 `IMPLEMENTED — PARTIAL / BLOCKED`，不得合入
Preview 或发布。公共 MCP 工具面、SQLite v14、Worker 私有 IPC、Result/
Cleanup/Recovery 合同保持不变；正常插件不得通过嵌入式 Manager 绕过
Executor。

## PR 3 Implementation Record

PR 3 增加 [ADR-049](ADR-049-task-cli-control-surface.md) 定义的 Task CLI：
`executor start/status/stop`、Lease 只读/显式清理，以及
`task list/status/events/result/cancel/reply` 全部经 `ExecutorControlClient`
调用同一 Executor。CLI 不打开 SQLite、不创建 Manager，也不实现第二套恢复。
插件生成 `dist/task-cli.mjs` 与 `dist/executor.mjs`，二者通过同一 Named Pipe
合同通信。定向测试覆盖已有 Executor 不重复 Spawn、一次性未 Lease 过渡、
Shutdown unknown 非零、bounded list、Result 输出预算和 MCP/CLI 并发。

该实现仍是 stacked candidate。完整回归、真实 Desktop 关闭和真实 Official
Runtime 未因 PR 3 自动获得通过，不能据此合入 Preview 或发布。

## PR 4 Implementation Record

PR 4 按 [ADR-050](ADR-050-local-task-web-console.md) 增加 loopback-only Task
Web Console。它通过同一 `ExecutorControlClient`/`RemoteTaskManager` 读取
Task、Event 和 Result，并仅转发显式 Cancel/Interaction Reply；不提供 Task
创建、模型设置、SQLite、Shell、文件或 Executor Shutdown API。HTTP 层要求
精确 Host、同源 Origin、会话 CSRF 和有界 JSON body。关闭页面或 Console
进程只关闭本地 Adapter，不影响 Executor 或已受理 Task。

插件生成 `dist/web-console.mjs`。定向 HTTP、安全、Architecture Boundary 和
打包校验通过；真实多用户隔离、Desktop 关闭和付费 Runtime 仍未验证。

## PR 5 Implementation Record

PR 5 按 [ADR-051](ADR-051-executor-wake-delivery.md) 在 Executor 内增加
post-Release、一次性 Wake Adapter。Queue 仅用于已经由 App Server 确认
loaded、idle、可接收 direct input，且 workspace、model、provider、reasoning
effort 与 Owner 单 Turn 授权完全一致的 Thread。任何不确定条件转
`web_notify`。Queue 不附加 `--resume`，不重试；非零/信号/timeout 记为
`submission_unknown`，只有观察到 baseline 之外的新 `inProgress` Turn 才记
`turn_started`。

Wake Intent/Delivery 复用 SQLite v14 terminal Operation 的 bounded
`observation_recorded` evidence，不新增表或 schema。Wake 事实不改变
Task/Result/Cleanup/Release/Capacity/Recovery，只追加 `released -> released`
observation。跨进程 fake Worker Result/Cleanup/Release -> Wake -> Web fallback
E2E 与 coordinator fail-closed 矩阵通过。

真实 App Server control socket、真实 Queue、严格 notLoaded C、Desktop 全退 D
和真实付费模型均未在候选验证中运行；这些门禁保持 `NOT_RUN / BLOCKED`。
Queue Wake 仍不得扩展为发布承诺，持久化结果与安全回退也不能以 F5 代替。
