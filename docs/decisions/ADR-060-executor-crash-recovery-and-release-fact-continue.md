# ADR-060：Executor 崩溃恢复与 Continue Release 事实

> Status: DECISION（Worker 不确定性 fail-closed 段落由 ADR-064 部分替代）
> Date: 2026-11-25
> Decision: Accepted（Owner 在 Preview.17 任务中明确批准）
> Baseline: `origin/preview` `6af69b55d7ecb660c2ad2c923888cf7f1e8886c8`
> Related: [ADR-045](ADR-045-async-executor-ownership.md)、[ADR-049](ADR-049-task-cli-control-surface.md)、[ADR-051](ADR-051-executor-wake-delivery.md)、[ADR-059](ADR-059-owner-binding-and-installed-auto-wake.md)

> Applicability: Lease/Owner 恢复与 Continue Release 事实继续适用。Preview.18 起，
> Worker/launch 不确定性按 Operation 保留且不再全局阻断启动；见
> [ADR-064](ADR-064-executor-startability-and-user-release.md)。

## Context

Preview.16 实际出现了两类生命周期缺口：

1. Executor 进程退出后，旧 Lease 仍保留。下一次 MCP 读取返回
   `EXECUTOR_UNAVAILABLE`，用户必须手工确认、归档 Lease 并重新启动
   Executor。
2. Operation 已可靠 Result、Cleanup 与 Release 后，Wake Observation 会推进
   Operation revision。Manager Continue 使用当前 revision，但 Store 错误地
   要求该 revision 恰好等于历史 `released` 事件的 sequence，因而返回
   `CONTINUE_PRIOR_NOT_RELEASED`。

这两项都属于现有 Executor/Lease/Release 生命周期的缺口，不需要第二套
Authority、Supervisor、Scheduler 或 Wake 状态机。

## Decision

### 1. Host 触发的自动恢复

- Thin MCP 在控制通道首次不可用时调用现有 Executor Recovery
  Coordinator；正常生产默认开启，不做持续后台轮询。
- 恢复前先探测现有 Executor。已有健康 Executor 时只复用，不 Spawn。
- 恢复协调使用现有跨进程 `withProcessLock`。锁位于 Host 设置目录
  （`<settingsDirectory>/executor-recovery.lock`），不写入 SQLite 根目录，
  避免破坏 Fresh Authority 的根条目合同。
- 旧 Lease Owner 必须由 PID、启动指纹、平台与身份版本共同核对。
  `alive` 但控制通道尚未就绪时只等待，不归档、不启动第二个 Executor。
- 仅当旧 Owner 被证明 `exited` 时，才检查持久 Worker 归属。Preview.17 将
  活动/未知 Worker 或缺 Receipt 视为全局启动阻断；该行为由 ADR-064 替代为
  Operation 级保留。历史正文保留原始决策边界。
- Worker 安全检查只读打开同一 SQLite Authority，检查活动 Operation 的
  Launch/Claim 身份；不创建第二数据库，不重写 Task/Attempt/Operation/
  Result/Event。
- 安全归档使用现有 `clearExecutorLease`，生成
  `executor-lease.cleared.json.<lease_id>`。随后使用与 Task CLI 相同的
  Executor Spawn 入口启动，并等待控制通道健康检查成功。
- 两个并发 MCP 请求由进程内 Promise 合并和跨进程恢复锁共同收敛；启动中
  再次到达的请求等待同一恢复结果。
- 恢复失败保持显式错误和诊断；归档结果未知时本次请求 Fail Closed，下一
  请求重新核对现场，不猜测成功。

### 2. Continue 的 Release 事实

- Release 是 Operation 已成立的持久事实，后续 Wake Observation 只追加
  通知生命周期 Event，不撤销 Release。
- Continue 的资格继续要求可靠 Result、已验证 Cleanup、已成立的 Release、
  没有活动 Worker 且 Workspace 可用。
- `createNextAttempt` 不再要求操作数 revision 等于 `released` Event 的精确
  sequence；只要该 Operation 在 `sequence <= expected_revision` 范围内存在
  `released` Event，Release 事实即成立。revision 的 CAS、generation、Claim、
  Worker identity、Result 与 Cleanup 证据检查保持不变。
- Continue 创建新 Attempt 时保留原 Attempt、Result Digest、Cleanup/Release
  证明和全部 Wake Event；不删除或改写历史。

### 3. 诊断开关

- `ZCODE_BRIDGE_EXECUTOR_AUTO_RECOVER=0|false|off` 只用于确定性传输诊断和
  测试，显式关闭自动启动；默认值始终为开启。
- 关闭自动恢复不改变已有 Executor 的连接复用，也不改变 Lease、Worker、
  Cleanup 或 Release 语义。

## Non-Changes

- 不新增 Supervisor 常驻进程、第二 Lease Authority、第二 SQLite
  Authority、分布式锁或逐任务授权。
- 不改变 Task 状态、MCP 工具名或公开 Schema。
- 不自动清除 Cleanup Hold，不放宽 Worker 身份、Workspace 或 Release
  证明。
- Worker 仍运行或身份不确定时，不允许恢复派发。

## Verification Status

- 真实 Store：Wake `intent → queued → turn_started` 后，以 Manager 当前
  revision Continue 成功，新 Attempt 创建且 3 条 Wake Event 保留。
- 真实进程：Executor 正常退出后重新启动；Executor 被 `SIGKILL` 后，
  同一 Thin MCP 会话下一次读取自动归档旧 Lease、启动新 Executor 并返回
  `TASK_NOT_FOUND`（而非 `EXECUTOR_UNAVAILABLE`）。
- 故障注入：并发恢复只 Spawn 一次、PID 复用、Owner unknown、归档结果
  未知、Worker 存活、`launch_intent` 无 Receipt、开放 SQLite Authority
  并发只读检查均有定向测试。
- 未验证：Windows 重启后的真实恢复、Desktop fully exited、notLoaded 与
  严格 Wake C/D 仍按 Preview.17 第二阶段延期项处理。
