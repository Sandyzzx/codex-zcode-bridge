# ADR-024：SQLite Hold 工作区化与本机清理恢复

> Status: DECISION
> Date: 2026-11-04
> Decision: Accepted for this worktree; production integration remains a separate authorization
> Partially superseded: ADR-037 replaces the startup-only Recovery assumption and
> narrows the OS-scan-only Cleanup closure for the Stable 1.7.1 Host hotfix.

## Context

SQLite 迁移把进程身份、清理证据和事务审计做得比 JSON 时代更强，但
Manager 的启动 Recovery 把任意 Operation 的 Hold 升级成当前 Manager 的
read-only 栅栏，内存调度又用单一 active 标志串行化全部任务。一个
`D:\LumeCAE` Worker 的普通模型请求失败或 cleanup 证据缺失会阻塞其他
工作区，行政结案看起来要求关闭 Host/Writer，恢复体验退化。

SQLite 的真实必要边界不是“全库停止”，而是：持久 Task/Attempt、原子
Claim/Capacity、精确进程身份防 PID 复用、同一执行路径最多一个可能写入的
Worker、终态和审计不可覆盖。

## Decision

本决策取代 ADR-019 第 5–8 条的 Manager Recovery/dispatch fence；ADR-019
第 1–4 条本地信任与授权边界继续有效。

1. Recovery Hold 只限制出问题的 Operation 及其执行路径；不同执行路径
   继续派发。SQLite 根只在一致性读取失败或损坏时 read-only。
2. Manager 调度允许多个 active Worker，直到 SQLite Capacity 上限；派发前
   用 Recovery snapshot 中的 occupied `workspace_ref` 做路径重叠检查。
  重叠路径按有界 1 秒 retry 暂缓，不写入全局 Hold。
3. `cleanup_unverified` 的 failed Task 可继续使用 `zcode_cancel` 触发
   evidence-only Recovery。精确身份仍存活时，此次显式操作可调用已有
   identity-bound process-tree termination，再 probe 原身份并重新扫描；
   startup Recovery 不擅自终止 Worker。该路径不重放 prompt、不新建
   Attempt、不改写 Result，也不清除审计事件。
   同一 Node Bridge 进程内，对同一 SQLite Authority/Operation 的并发
   Recovery 共享一个身份绑定的停止 Promise；停止失败时允许后续重试，
   验证成功后保留到 SQLite Release，避免竞争 Manager 重复发出进程树信号。
   这是进程内协调，不提供跨独立 Bridge 进程的 termination mutex；key 使用
   `path.resolve`，同一 SQLite 文件若通过不同路径别名打开也不会合并。当前
   决策以单 Bridge Host 和同一配置 dataRoot 为运行边界。
4. 每个 Admission transaction 检查活动 Operation 的执行路径重叠；竞争者
   不创建 Operation/Worker，Attempt 保持 queued 并延迟重试。这补足不同
   Manager 内存路径锁无法覆盖的 admission race。
5. 清理 Recovery 的本地可信闭合条件是：Claim 与 Launch 的 PID/start
   fingerprint 精确一致；fresh probe 证明该精确身份 exited；recorded-tree
   claimant scan 为 clean 且无 live PID；无 unresolved interaction。满足后
   可原子写 verified cleanup evidence 并释放 Capacity。仅 PID 消失、
   fingerprint mismatch、alive/unknown、scan false/rejected/timeout 都保留
   operation/workspace Hold。
6. 普通 provider 失败和 Worker 清理失败分离。Provider 失败产生普通 failed
   Result；只有执行路径清理占用会限制同一路径新派发。
7. Hold 触发规则按证据范围限定：正常 Worker 是 Occupied；正常退出或非零退出且
   cleanup verified 都 Release；只有 Worker 可能仍在写入而身份、进程树或
   interaction 状态不能验证时，才将 Hold 限定到 Operation/重叠路径。PID 与
   start fingerprint 不匹配、probe/scan 失败、终止失败、未解决 interaction、
   Observation 上限 8 或 Recovery CAS 竞争均不释放；CAS 冲突必须重读权威状态。
   Admission 路径重叠和 Capacity 满只排队。SQLite root 完整性损坏才进入全局只读。
8. `zcode_cancel` 对 held Operation 是可能终止仍存活 Worker 的显式动作。Master
   必须先报告 Task/Attempt/workspace/原因并取得用户明确授权；接口仍为
   `{ task_id }`，无 dry-run 参数。成功恢复不重放 Prompt、不新建 Attempt，重复调用
   不得重复 Release 或覆盖既有 evidence。
9. 当前 app-server 没有可验证的 Provider 未接受标记；`retryable` 或
   `attribution.statusCode` 不足以证明未接受。故 HTTP 429、5xx、网络错误或接受状态
   unknown 均不自动重发。只有未来协议提供可信未接受证据时，才允许同一
   Worker/Attempt 有限重试并遵守有界 `Retry-After`；观察到 turn-start 后始终不重试。

## Hold 触发矩阵

| 观察事实 | 状态与动作 |
|---|---|
| Worker 正常运行 | Running / Occupied；不是故障 Hold |
| 正常退出，cleanup verified | Release |
| 非零退出，cleanup verified | failed Result + Release |
| 崩溃且进程树状态未知 | Operation Hold，保留路径占用 |
| 原 Worker 仍存活 | 保持占用；Recovery 未获授权不得终止 |
| PID/start fingerprint 不匹配 | Hold；拒绝触碰该 PID |
| identity probe 失败/超时，或 tree termination 失败 | Hold |
| recorded-tree scan 不干净/失败，或 interaction unresolved | Hold |
| Recovery CAS 冲突 | 不释放；重读 snapshot，确认当前状态后才返回 |
| Operation Observation 达到 8 | 停止自动 Recovery，保持 Hold 并报告诊断 |
| Admission 路径重叠 / Capacity 满 | 保持 queued，稍后重试；不是 Hold |
| SQLite root 一致性损坏 | Root Quarantine / 全局只读 |

## 启动与崩溃阶段矩阵

| 崩溃边界 | 可能有 Worker/写入 | 允许重派 | 重启后动作 |
|---|---|---|---|
| Admission 后、Launch 前 | 若无 Launch intent/receipt 可证明未创建；否则按可能启动处理 | 仅权威记录确认未启动时可重派同一 queued Attempt | 重读 SQLite；不重复创建 Operation |
| Launch intent 后、进程创建前后 | 可能已创建，可能开始写入 | 否，直到精确身份和树清理验证 | reconcile Launch/Claim；unknown 保持占用 |
| Worker 启动后、Claim 写入前 | 可能已写入，Claim/启动记录可不完整 | 否，除非可证明从未创建 Worker | 通过启动票据/身份证据恢复；不确定时 Hold |
| Claim 写入后、Manager 收到结果前 | Worker 可能仍在写 | 否；永久 Claim 的 Attempt 不重放 | 保留 Claim，probe/scan；只清理或保持 Hold |
| Result 提交后、Cleanup 前 | Worker 可能仍活跃，但任务执行已终结 | 否 | 只恢复 Cleanup/Release，不重复 Prompt |
| Cleanup 完成后、Release 前 | Worker 应已验证退出 | 否 | 复用已持久 Cleanup evidence，事务性 Release；只写一次 Release event |

以上状态转换由 SQLite Authority 与持久 Claim/CAS 驱动；若观察缺少足以区分
“未启动”和“可能已启动”的证据，采取后者。重启只触发本机 reconcile，不是
常规恢复前提。实际运行的六阶段 fault injection 结果如下；测试使用真实 Windows
Manager 子进程、SQLite Driver 和 Worker 进程，Worker Adapter 为 test-only fake，
不代表真实 Provider 或 Codex GUI E2E。

| 硬退出注入点 | SQLite 崩溃快照 | Worker 可能存活/写入 | 重派 | 重启 Recovery 实际动作 | 最终 Capacity / Workspace |
|---|---|---|---|---|---|
| Admission 后、Launch intent 前 | `reserved`，无 receipt | 否 | 是，仅同一 queued Attempt | 恢复 reserved Operation 并启动该 Attempt 一次 | cleanup verified 后 Release |
| Launch intent 后、Spawn 前 | `launch_intent`，无 receipt | Authority 无法证明；按可能启动处理 | 否 | 保持 Hold，不创建第二个进程 | 占用保持 |
| Worker 已启动并报告、Claim 前 | `launch_intent`，receipt 存在、Claim 缺失 | 是或未知 | 否 | 不授予 Worker 执行权，不 Spawn 第二个 | 占用保持 |
| Claim 后、Result 前 | `running`，永久 Claim 存在 | 是或未知 | 否 | probe 原身份；Result 缺失时保持 Hold | 占用保持 |
| Result 后、Cleanup 前 | `result_committed` | Result 已提交；Worker 已结束执行 | 否，不重放 Prompt | 验证原 Worker/tree、提交 Cleanup 与 Release | verified Release 后空闲 |
| Cleanup verified 后、Release 前 | `cleanup_verified` 与证据已持久 | 否，原 Worker/tree 已确认清理 | 否 | 复用 Cleanup evidence，仅提交 Release | Release 后空闲 |

证据由 `ADR-024 six lifecycle crash boundaries` 定向测试产生：外部测试进程观察
Manager 子进程在指定 callback 处以 exit code 86 硬退出，再启动新 Manager 并检查
持久快照、dispatch 次数、生命周期事件和容量。GUI 重启与真实 Provider 未运行。

## Consequences

Task79 这类已有失败 Result、Worker 精确身份已退出且 claimant clean 的
Hold，可通过普通 cancel 在不重启 Bridge/Codex/Windows 的情况下释放。
无法证明 exited/clean 时，`D:\LumeCAE` 仍保留占用，但其他工作区不阻塞。

Claimant scan 不能观察未记录的中间祖先。该残留风险只在单用户可信本机
接受；不得把该证据宣传为对抗性进程谱系的完整证明。行政 abandon 保留为
scan 长期失败、证据损坏或人工决策的最后手段。
