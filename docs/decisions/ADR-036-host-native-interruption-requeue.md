# ADR-036：Host 内中断与单次自动重派发

> Status: DECISION
> Date: 2026-11-13
> Decision: Accepted for the isolated Host Recovery candidate; merge, release and live Authority migration remain separate authorizations
> Applicability: SQLite v14 Host Recovery for claimed Attempts without a committed Result
> Verified against: `77990f3a840e7b1f3a75afc151c58ca2cef5f28a` plus this candidate diff

## Context

现有 SQLite Authority 已保存 Task、Attempt、Result、Operation 事件、永久 Claim、
精确 Worker identity 和 Cleanup 证据。问题不在持久化事实不足，而在 Host Recovery
过去主要绑定 Manager 启动：运行中的 Result-less Attempt 即使原 Worker 已退出，
仍可能保持占用；普通恢复因此退化为重启 Host 或使用 `ADMIN-ABANDON`。

不能通过删除数据库行、清除锁文件或再建一套 Recovery Authority 解决。重派发必须
保留旧 Attempt 历史，并且只有在新 Worker 不可能与原 Worker 同时写入同一工作区时
才能发生。

## Decision

### 1. Host 拥有运行与恢复

SQLite 继续是唯一持久事实来源。Manager/Host 负责 Worker 生命周期、清理、恢复和
调度；`recoverTasks()` 是可在 Host 存活期间重复执行的协调入口，不增加后台常驻
扫描进程。并发调用共享同一个 Recovery Promise，完成后可再次读取最新 Authority
状态。

### 2. 精确退出后才允许中断

对 `running` 且没有 Result 的 Operation，仅当以下事实全部成立时才允许自动恢复：

1. 持久 Claim 与 Launch 的 root PID、start fingerprint 精确一致；
2. fresh probe 证明该精确 Worker identity 已 exited；
3. Worker-root recorded-tree claimant scan 为 clean，且没有 live PID；
4. 没有未回答的 interaction request，也没有 cancellation intent；
5. Host 没有发现相同 Operation 仍有不同 PID 的本地活动句柄。

Worker 存活但不由当前 Host 管理时返回 Operation-scoped Hold，不终止可能属于另一个
Host 的进程。只有当前 Host 持有同一 Operation、同一精确 PID 的句柄时，才允许既有
identity-bound process-tree termination。

### 3. 原子 `interruptAndRequeue`

Store 提供一个内部原子操作，不新增公共 MCP Tool 或公共 Task 状态：

- 用 Operation ID、Task ID、Attempt、Generation、Revision、Claim 和 Worker digest
  执行 CAS；
- 保留旧 Attempt、Claim、Result 和事件；
- 为旧 Attempt 写 failed Result、显式 interruption evidence、Cleanup 与 Release；
- 在同一事务中把 Task 的 current Attempt 推进一次并只插入一个 queued Attempt；
- Task ID 不变，下一 Generation 仍由既有 Admission 分配；
- 重复调用返回已持久化的中断、Result 和 Cleanup digest，不创建第二个 Attempt；
- 任一步失败整体回滚。

成功提交后，由现有 Scheduler 派发下一 Attempt。

### 4. 自动重试预算

自动中断只允许一次。下一 Attempt 的 continuation 指向前一 failed Result；若该
Result 已带 `interruption_evidence:<digest>`，Host 不再自动制造第三次 Attempt。
Provider/HTTP/业务失败仍产生普通 failed Result，不因本决策自动重试。

`result_outcome_unknown` 不作为可自动重派发状态。只有 `result_rejected` 或本 Host
已观察到 Worker 退出的 `result_outcome_unknown` 才进入 Recovery 探测；探测本身
仍必须满足第 2 节全部安全事实。

### 5. 升级与清理边界

- 实际完成 v13→v14 升级的 Host 对 Result-less running Attempt 使用
  `interrupted_by_upgrade`。
- Worker 异常退出使用 `worker_exited_without_result`；当前 Host 已验证终止使用
  `worker_terminated_without_result`。
- 已提交 Result 的 Cleanup pending/unverified 只恢复 Cleanup，不重新执行任务。
- `adapter_cleanup_unverified` 不能由 OS PID/tree 扫描替代 Adapter resource facts，
  必须保留 Hold。
- 无法证明 Worker 退出、进程树 clean、交互已解决或资源已关闭时，只保留相关工作区
  的 Hold，不影响其他工作区。

### 6. 不扩张合同

本决策不新增公共状态枚举、MCP timeout/force 参数、管理员确认字符串、第二套
Recovery Store 或跨 Host termination mutex。`ADMIN-ABANDON` 继续只处理无法自动确认
的少数管理恢复场景。

## 状态处理

| 持久状态/观察 | 处理 |
|---|---|
| completed + Result committed | 保留 Result 与历史 |
| failed / cancelled 终态 | 保持原终态 |
| queued 且未启动 | 保持 queued，由 Scheduler 恢复派发 |
| running，无 Result，精确 Worker 已退出且 tree clean | 旧 Attempt 中断归档，创建一个新 Attempt |
| running，无 Result，Worker alive/unknown 或 tree 不 clean | 保留当前 Operation/Workspace Hold |
| running，无 Result，存在未回答 interaction | 保持 Hold，不创建新 Attempt |
| Worker 仍存活且由另一个 Host 管理 | 不终止，保持 Operation-scoped Hold |
| Result committed，Cleanup pending/unverified | 保留 Result，只恢复 Cleanup |
| Cleanup 缺 Adapter resource facts | 保持 Hold，不以 OS tree proof 代替 |
| v13→v14 升级遇到可安全中断的 running Attempt | 以 `interrupted_by_upgrade` 中断并重派发 |

## Consequences

普通 Result-less Worker 退出不再要求重启 Codex/Windows 或手工 `ADMIN-ABANDON`。
新旧 Worker 的 Workspace 单 Writer 保证由精确身份、tree proof、Cleanup/Release CAS、
路径占用和原子重派发共同维持。

无法确认 OS 身份、进程树、交互状态、Adapter 资源或 Cleanup 的场景仍不能自动恢复。
这些边界是数据安全取舍，不用更激进的清理换自动恢复率。
