# ADR-037：Stable Host 内恢复与 Adapter Cleanup 证据

> Status: DECISION
> Date: 2026-11-13
> Decision: Accepted for the Stable master hotfix candidate; merge and release remain separate authorizations

## Context

Stable 1.7.1 的 Manager 只在启动时执行一次 Recovery。Host 仍存活时，
`recoverTasks()` 会拒绝再次读取 SQLite，因此已经持久化的 Cleanup、Release
或可恢复队列事实只能通过重启 Manager 才被重新处理。

ADR-024 把“精确 Worker 身份已退出 + recorded-tree/claimant scan clean”
作为普通 Cleanup Recovery 的本地闭合条件。该证据能证明 Worker 进程树消失，
不能单独证明 ZCode AppServer Adapter 管理的浏览器或其他执行资源已经关闭。
Stable 也没有 Preview R7 的完整 Runtime Events，不能把“没有观察到事件”
解释为“没有发生模型、工具或 Workspace 副作用”。

## Decision

1. `recoverTasks()` 是 Host 生命周期内可重复调用的只读快照协调操作，不再是
   startup-only。同一 Manager 的并发调用共享同一个进行中的 Promise；恢复完成
   后下一次调用重新读取 SQLite 最新状态。不创建第二个 Manager 或 Recovery
   后台服务。
2. 已经由本 Host 持有的 active run 在恢复扫描中延后，不终止、不重复派发。
   Worker alive、identity unknown、进程树未验证或资源未关闭继续保留
   Operation/Workspace/Capacity 占用。
3. 恢复继续复用现有 Scheduler、Workspace Occupancy 和 queued Attempt 路径。
   一个 Operation 的 Hold 只限制其自身执行路径；无关 Workspace 继续派发。
4. Result 已提交后的 Recovery 只做 Cleanup/Release，不改写 Result，不创建新
   Attempt。生产路径只有在已持久 Cleanup evidence 已验证，或能够验证完整的
   Adapter Cleanup Proof 时才能写 `cleanup_verified`。仅凭 root PID 退出、
   PID 不存在或进程树 clean 不得合成 `cleanup_verified`。
5. 缺少 Adapter Cleanup Proof 时持久记录 `cleanup_incomplete` 的
   Operation-scoped Recovery Hold，并在诊断中标记
   `adapter_cleanup_unverified`。`zcode_cancel` 可对已有终态 Result 的
   `result_committed`、`cleanup_pending`、`cleanup_verified` 或
   `cleanup_unverified` 发起 cleanup-only Recovery，但仍须通过原有 SQLite
   Result/Claim/Revision CAS；证据不足时拒绝伪造 Release。
6. Stable 生产路径没有足够可信证据证明 Result-less 执行未产生外部副作用，
   因此不自动重新执行 running/Result-less Attempt。此类 Operation 保持原
   Task/Attempt/Claim 历史，由 Master 使用既有 `zcode_cancel`、Continue 或
   ADR-018 管理路径决策。
7. 隔离测试可以使用 atomic `interruptAndRequeue()` 验证“旧 Attempt 中断结果、
   已验证 Cleanup/Release 和新 queued Attempt”在同一事务提交。该能力必须同时
   显式启用 `testOnlyFakeAdapter` 与 `testOnlyAutomaticRecoveryRequeue`，不能由
   公共 MCP、TaskPackage、Host 配置或环境变量启用；自动恢复最多一次，重复调用
   不得产生第二个续 Attempt。
8. 本决策不新增公共 MCP Tool/schema、Task 状态、SQLite schema 版本或 R7
   Runtime Events。v13→v14 升级、Result 32 MiB、ADR-009 身份终止和
   ADR-018 行政兜底保持有效。

## Consequences

Host 存活期间的重复 Recovery、已持久 Cleanup/Release 和未执行 queued Attempt
可由同一 Manager 继续处理，不需要关闭 Codex 或重启 Windows。Result 已提交的
任务不会被重新执行。

缺少可信 Adapter Cleanup Proof 或可能已经产生不可重复副作用的任务保持
`MASTER_DECISION_REQUIRED`。自动 requeue 只作为隔离 fake-Adapter 回归能力存在，
不构成 Stable 生产副作用安全证明。
