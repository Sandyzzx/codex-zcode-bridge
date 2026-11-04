# SQLite Hold 简化与 JSON 行为对照（2026-11-04）

> Status: REPORT（本轮候选实现、静态调查及验收记录；生产集成尚未执行）
> 基线：`77dd5f14`；候选 worktree：`codex/sqlite-hold-simplify-20261104`。
> 证据边界：只读检查生产 SQLite；未迁移或改写生产记录。测试结论只填已实际运行的 Node/Windows 结果。

## 结论摘要

JSON 时代也有任务级 `cleanup_unverified`、进程身份检查、记录树 claimant scan 和同目录串行保护。因此“JSON 简单”不等于没有安全门。主要差异是 JSON TaskManager 按任务 reconcile、按执行路径占用；SQLite 又增加了 Operation/Generation/Revision、Recovery observation、Hold/Quarantine 分类和 root 状态，再由 Manager 用全局 `pumpFailure` 阻断后续派发。SQLite 的事务并没有要求把一个 Operation 的恢复故障升级为全库停止。

候选实现保留 SQLite Authority、事务、Task/Attempt/Operation 历史、原子 Admission/Claim、精确进程身份及同路径单 Worker 约束；普通 Hold 只占用其 Operation 和重叠执行路径。已退出 Worker 的清理失败可从 `zcode_cancel` 发起新的 evidence-only Recovery；无法证明时只继续占住相关路径。当前 app-server 没有可信的 Provider 未接受证据，因此不自动重发 Provider 请求，也不改变 Operation 的资源 Hold。

上一轮基线全量验收为 818 项（816 PASS、0 FAIL、2 SKIP）；本轮修正并发 stop 路径后重新运行定向测试和完整套件。真实 Codex GUI 重启和中断时部分源码 WIP 保留仍没有 E2E 证据，Task79 未执行恢复。没有 SQLite schema 变化，故无 Migration。

## 生命周期差异及故障链

| 范围 | JSON TaskManager | SQLite 生命周期 | 本轮处理 |
|---|---|---|---|
| 权威事实 | 每 Task 的 JSON 状态、结果、事件与 Attempt 文件；原子临时文件 rename | SQLite Task/Attempt/Operation 投影、append-only lifecycle events、事务/CAS | SQLite 保留为唯一 Authority，不恢复 JSON Authority |
| 认领 | manager/process lock、Attempt 状态和永久 `execution.claim` | 原子 Admission、Launch、Worker Claim 和 revision CAS；Worker 仍有 Attempt claim | 保留数据库认领，增加派发期路径占用，避免并发 pump 竞争 |
| 执行并发 | FIFO 调度按活动执行目录重叠检查 | Worker Capacity 加 Operation 占用；原 Manager pump/root gate 会把 Hold 扩成全局停止 | Hold 在 Operation/路径范围；不同路径可并发 |
| 故障恢复 | reconcile 单个 Task；运行进程不明或 cleanup 未验证时该目录保持占用；其他健康且不重叠的任务可继续 | startup Recovery 还要分类 Hold/Quarantine、验证事件链和 revision；全局 gate 会阻断 admission/dispatch | 整库损坏仍全局 fail closed；单个 Operation 状态不确定只占路径 |
| 重试 | Manager 可重试未开始 Worker；已 claim 的 Worker 不重放 Attempt | 已 claim Worker 同样不可重放；Provider 错误是否可重试须先证明请求未被接受 | 当前协议不能提供可信未接受证据，因此 429、5xx、网络错误、ACK 丢失均不自动重发；若未来补齐证据，才在同一 Worker/Attempt 内有限重试 |

### 为什么 JSON 没有同类全局阻塞

JSON 的任务扫描把状态和占用映射到单 Task/执行目录；调度跳过被占用或损坏的目标，继续处理其他目录可证安全的任务。它没有 SQLite Recovery root 分类和 Manager 的 `pumpFailure` 全局闸门。JSON 仍会在任务状态/执行范围无法解释、共享数据根锁损坏等情况下 fail closed。

### Task78 与 Task79

- Task78：本轮只读查询时已于 2026-11-04 01:07:59 记录为 `admin_abandoned` 并进入 `released`。因此它不是当前仍 Hold 的任务，也不能当成本轮恢复实现的验证样本。
- Task79：本轮只读查询为 `D:\LumeCAE`、Attempt 1、Task `failed`、Result `zcode_nonzero_exit`、Operation `cleanup_unverified`，历史包含 `cleanup_incomplete` Hold，记录的 Worker PID 为 18164。已有材料不能证明该 Provider/运行时非零退出的具体上游原因；也不能仅凭 PID 推断 Worker 或其后代已清理。没有对 Task79 发起 cancel、Recovery 或数据库写入。
- 目标恢复链：Master 对 Task79 调用普通 `zcode_cancel` → Manager 精确读取 Operation/Attempt/Claim 及 Worker start fingerprint → probe 原精确身份 → 若仍 alive，此显式 cancel 才调用现有 identity-bound process-tree termination 并重新 probe；startup Recovery 不会擅自停止 Worker → 对已记录树重新做 claimant scan → 检查 interaction 与 revision → 单一 SQLite Recovery 事务提交新增 cleanup evidence 和 Release。若任何一步 alive/unknown、扫描失败或 CAS 竞争，则保留 Task79 路径占用，其他路径继续派发。历史 `cleanup_incomplete` 仍在事件审计中，不改写成 verified。此方案在候选代码上可审查；尚未对生产 Task79 执行。

## Hold 机制逐项评估

| 机制 | 决定 | 必要性及候选行为 | 删除/简化后的残余风险 |
|---|---|---|---|
| Hold / Quarantine monotonic latch | 简化 | 保留单 Operation 的 `cleanup_unverified` 和完整审计单调性；移除把单 Operation Hold 升级成 Manager/SQLite 根停派的效果。Quarantine 仍用于数据库损坏或冲突证据 | 路径范围外的读取/调度可继续；若数据库根完整性不可信，仍全局只读 |
| OS 全局 claimant scan | 删除“全 OS 扫描”的解释；保留记录树扫描 | 只验证保存于该 Attempt 的 Worker/运行时 PID 身份及其 recorded-tree claimant 闭包。它防 PID 复用/后代仍存活；不扫描或锁住无关进程 | 未记录的中间祖先/脱离进程组后代不可完全证明，已有 ADR-009 风险边界仍成立 |
| 每 Operation observation 上限 | 保留有限上限（当前 8 条） | 阻止无限增长与恢复事件放大；证据摘要和 revision 仍可审计。它不应变成每次常规进程扫描的层层 observation 流程 | 超出上限需要保持该 Operation 占用并人工诊断；单用户本机发生概率低但仍需明确失败 |
| Native Runtime Auth | 删除为当前生产派发前提 | 当前生产执行由 ZCode app-server 自身处理 Provider 身份；当前 Authority/Worker 路径未发现 Native Runtime Auth lease/token 握手 | 不提供独立 Native Provider 凭据通道；未来增加此路径属于隐私/运行时合同变更 |
| FD10–13 专用继承管道 | 删除其生产必要性 | 当前源码未发现 FD10–13 生产使用。Worker 启动仍有其 bootstrap 描述符（如 FD3）；测试 harness 的 interaction pipe 也不是 Provider Auth 通道 | 不再维护未被生产派发消费的专用认证传输。必须基于当前实际实现，不从 Start Plan 实验推断生产能力 |
| Operation-scoped CAS | 保留并减少冗余读写 | 保护同一 Operation 的 Claim、结果、Cleanup、Recovery、Release 与并发 Recovery；SQLite transaction/revision/Claim 身份联合防 stale update 和重复释放。它不是全局锁 | 同库多个 Manager 仍可竞争，但 stale CAS 只允许一个提交；CAS 失败必须重读，不可释放路径 |
| 行政结案 CLI | 简化为最后兜底，保留兼容 | ADR-018 的 `admin_abandoned` 不等同 Cleanup Verified。普通 clean Recovery 可走 `zcode_cancel`；只有证据损坏、claimant 长期未知或需人工接受风险时才需要 CLI | 极少数不可证明状态仍需人工作出不可逆行政决定；正常 worker 故障不走该路 |
| 系统重启门槛 | 删除常规要求 | 普通恢复用新鲜精确进程探测、已绑定句柄清理、记录树扫描及 SQLite CAS；不要求重启 Windows/Codex/Bridge | 若 OS 清理 API 或进程证据持续不可用，Operation 路径继续占用，等本机条件恢复或用行政兜底 |

### C3B、身份与重复 Worker

真实防重复边界是 SQLite 的 Operation/Attempt 唯一性、Admission 事务内的 active workspace overlap fence、Worker 的永久 Attempt `execution.claim`、精确 PID + start fingerprint、Manager 内路径占用和 Operation revision CAS。即使两个 Bridge Manager 同时检查空闲路径，Admission 事务也只允许一个进入；竞争者保留 queued Attempt 并延迟重试。它们各自覆盖“同 Task 多次启动”“PID 复用”“并发 Recovery 重复提交”和“同路径/重叠路径两个写者”。SQLite WAL/事务本身不管理已启动外部进程；所以不删除进程身份核验，也不以 PID 消失作为 Cleanup Verified。

Operation-scoped CAS 有实际价值，但不能成为重复 observation/身份握手的理由。每次 Recovery 的 probe、清理、scan 应复用同一已绑定 Operation/Claim/Worker 身份，并在最终写入时 CAS；不需要全 OS claimant inventory 或反复创建新的 Recovery 管理层。

## 本轮合同收束：Hold、启动边界与 `zcode_cancel`

Hold 触发矩阵和六个启动崩溃阶段已固化在 [ADR-024](../decisions/ADR-024-scoped-sqlite-hold-and-local-cleanup-recovery.md)。正常运行和已验证退出属于 Occupied/Release；只有进程可能仍写入而身份/树/interaction/事务状态无法验证时才保留 Operation 路径；Admission 冲突与 Capacity 满保持 queued；SQLite 根损坏才全局只读。

实际 MCP 调用链是 `zcode_cancel({task_id})` → `SqliteLifecycleMcpAuthority.cancelTask()` → SQLite lifecycle driver `recoverOperation(operation_id, {stopAliveWorker:true})` → fresh identity probe / 必要时身份绑定 tree termination / recorded-tree scan / interaction 与 revision 校验 → SQLite CAS evidence 与 Release。公开输出是 Task status record，没有单独 Recovery 结果或 dry-run 参数。MCP 没有 Task 枚举工具，`zcode_status` 不返回 workspace；Master 只能主动检查已知/当前跟踪的 Task，并从原始 Task 请求或事件取 Workspace。来源缺失时必须报告 unknown。由于 held Worker 仍可能存活，Master Skill 要求先报告可确认的范围并取得用户明确授权，再调用并复查 `zcode_status`。

幂等证据包括：`test/sqlite-candidate/wp6b-wiring/composition.test.ts` 现从两个独立 MCP Host/Manager 对同一 held Task 并发发起 `zcode_cancel`，并让两者在相同 SQLite revision 写前同步。单个 Manager 内相同 Task/Attempt 的 Recovery promise 合并，只调用一次实际身份绑定 Windows process-tree termination；跨 Manager 的 CAS 竞争只产生一个 `cleanup_reverified`、一个 `cleanup_verified` 和一个 `released` event。CAS 失败方重新读取 SQLite Authority，两个 Host 都返回与持久 failed + released 状态一致的结果。测试保留并逐字比较旧 `cleanup_unverified` evidence digest。`test/sqlite-scoped-hold-scheduler.test.ts` 另覆盖已 Release 后重复 cancel 只读返回。

### Provider 自动重试安全表

| 证据 | 自动动作 |
|---|---|
| 当前 app-server 的 HTTP 429/5xx/网络错误 | 不重发；现有字段不足以验证 Provider 未接受 |
| 请求已写出但 RPC ACK 丢失 | 接受状态 unknown；不重发，保留既有生命周期结果与 Cleanup |
| 已观察 turn-start | 不重发 |
| 未来协议提供可信 Provider 未接受证据 | 可同一 Worker/Attempt 有限重试，并遵守有界 Retry-After |

已运行的定向 Provider 测试验证：429 与 `retryable` 字段不足以触发重发、5xx 单次 send、发送后 ACK 丢失且存在 runtime 副作用时单次 send。修复 fake app-server fixture 的事件身份与序号后，`L3e` 真实 adapter/Worker 集成测试确认绑定匹配 `sessionId`/`turnId` 的 `turn.started` 被 Worker 持久记录；随后 429、503 与 app-server 连接关闭各只发送一次 `session/send`，不产生新 Attempt。这里是本机 fake app-server 集成验证，不是真实 Provider E2E。当前没有可验证拒绝来源的重试场景，故 Retry-After 正向遵循测试不适用/未运行。

### 六阶段 Manager 硬崩溃注入

`ADR-024 six lifecycle crash boundaries` 定向测试在 Windows 上用独立 Manager 子进程执行实际 SQLite Driver/Worker 生命周期，在每个阶段以 `process.exit(86)` 硬退出，再用新 Manager/Host 执行 Recovery。Worker 使用 test-only fake adapter，不调用真实 Provider；这里报告为真实 Windows 子进程故障注入，不称为生产 Provider 或 Codex GUI E2E。

| 注入点 | 崩溃前持久状态 | 可能有 Worker/写入 | 允许重派 | 新 Manager 实际动作 | 最终 Capacity / Workspace |
|---|---|---|---|---|---|
| Admission 已提交、Launch 前 | `reserved`，无 Launch intent | 否 | 是，仅恢复同一 queued Attempt | 恢复既有 reserved Operation，Spawn 一次并完成 | verified Release 后空闲 |
| Launch intent 后、Spawn 前 | `launch_intent`，无 receipt | Authority 无法证明；按可能启动处理 | 否 | 保持 Operation Hold，不 Spawn | Capacity 与 Workspace 保持占用 |
| Worker 已启动并报告、Claim 前 | `launch_intent`，receipt 有效，Claim 缺失 | 是或状态未知 | 否 | 不授予执行权、不 Spawn 第二 Worker；保留占用 | Capacity 与 Workspace 保持占用 |
| Claim 已提交、Result 前 | `running`，永久 Claim 存在 | 是或状态未知 | 否 | probe 原身份；没有 Result 时保持 Hold | Capacity 与 Workspace 保持占用 |
| Result 后、Cleanup 前 | `result_committed`，Result 持久 | Result 已提交；Worker 不再执行 | 否，不重放 Prompt | 验证原 Worker/tree，追加 cleanup evidence 并 Release | verified Release 后空闲 |
| Cleanup verified 后、Release 前 | `cleanup_verified`，evidence 持久 | 否，原 Worker/tree 已确认清理 | 否 | 复用已有 cleanup evidence，只提交 Release | verified Release 后空闲 |

每项断言都读取 SQLite 的崩溃前后状态、Claim/Result/Release 事件数和恢复 Spawn 次数。另有真实 Codex GUI 重启和真实 Provider E2E 未运行。

## 状态机

```text
queued -> reserved -> launch_intent -> running -> result_committed
                                              -> cleanup_pending
                                                 -> cleanup_verified -> released
                                                 -> cleanup_unverified
                                                    -> cleanup_reverified
                                                       -> cleanup_verified -> released
```

候选差异：`cleanup_unverified` 不再触发全局 `pumpFailure`；仍占同一 `workspace_ref` 的派发资格。普通 cancel Recovery 的成功以新 probe/scan 产生新证据，然后经 CAS `cleanup_reverified -> cleanup_verified -> released`。失败仍停在原 Hold，不清除旧事件。并发 Recovery 中只有一个 revision CAS 能释放 Capacity。当前 Provider 错误缺少可信的未接受证据，429/5xx/网络错误均不自动重发；最终失败仍走 Result、Cleanup，不新增 Hold 状态。

## 最小源码范围与 Migration

- `src/manager/sqlite-lifecycle-mcp-authority.ts`：按 active Operation/path 调度；路径在异步 Claim 窗口占用；局部 Recovery，不让 Operation Hold 污染全局 pump。
- `src/store/lifecycle-gate.ts` 与 `src/sqlite-candidate/wp6b2b1/store.mjs`：复用已有精确身份、recorded-tree scan 与 SQLite Recovery/CAS；在 `admitOperation` 事务内拒绝与活动 Operation 重叠的路径；允许 `cleanup_unverified` 走 evidence-only Recovery，未知仍占用。
- `src/adapters/zcode-app-server-adapter.ts`：缺少可信 Provider 未接受证据时关闭自动重发；只为未来可验证证据保留有界重试门控。
- 对应 lifecycle/adapter 测试、插件生成 bundle、权威文档和 ADR-024。
- 当前没有改变表、索引、事件 schema 或持久化字段的必要，因此**无 SQLite Migration**。历史 Hold 事件不回写、不重命名、不伪造证据。

## 验收矩阵

| 验收项 | 当前证据/状态 |
|---|---|
| Provider 网络错误自动恢复 | 不自动重发：当前协议无法证明请求未被接受；避免可能重复执行 |
| HTTP 5xx 安全重试 | 不重发：5xx 不证明请求未被接受；`L3c1` 验证单次 send |
| HTTP 429 / Retry-After | 不重发：status/retryable 字段没有已验证的 Provider 拒绝来源；`L3b`/`L3b2` 验证单次 send。可信未接受证据的 Retry-After 正向测试未运行 |
| Worker 正常退出不产生 Hold | PASS：SQLite Composition 正常 Result → Cleanup → Release 事件顺序；无 Hold |
| Worker 崩溃后 Recovery | PASS：Composition/Manager 重启、Worker 已退出和 cleanup 未完成恢复场景通过；真实 OS crash E2E 未运行 |
| Worker 仍存活禁止同路径派发 | PASS：occupied path 不启动第二 Worker；identity unknown 时仍占用 |
| 一个 Workspace Hold 不影响另一 Workspace | PASS：`test/sqlite-scoped-hold-scheduler.test.ts`，独立路径继续派发 |
| Bridge 重启自动恢复 | PASS（合成/Composition）：SQLite Host/Manager restart 保留活 Worker 占用并恢复已验证退出的 Operation；生产实例未操作 |
| Codex 重启自动恢复 | NOT RUN：未重启 Codex GUI；Host/Manager restart 测试不能替代 GUI E2E |
| 部分源码写入时保留 WIP | NOT RUN（真实中断场景）：实现和 diff 未调用 reset/clean/覆盖源码；未执行真实 Worker 写入中断验收 |
| 同一 Task 不重复派发 | PASS：同 Task 永久 Claim/Operation CAS 与 Claim CAS rejection 场景通过；C 使用独立 workspace 以确保到达真实 Claim CAS |
| 并发 Recovery 不重复释放 | PASS：revision CAS 并发和唯一 Release 断言通过 |
| MCP 并发 `zcode_cancel` | PASS：双 MCP Host、双 Manager；同进程共享 identity-bound stop Promise；真实 Windows 终止器只调用一次并验证进程树信号；Cleanup CAS 竞争后重读 Authority；历史 cleanup evidence digest 不变 |
| 六阶段启动崩溃注入 | PASS：上表六个阶段均由 Windows Manager 子进程硬退出并经新 Manager Recovery 核验；使用 test-only fake adapter，不冒充真实 Provider E2E |
| `turn.started` 后 Provider 失败不重试 | PASS：匹配 session/turn 的事件被持久记录；429、503、app-server 连接关闭均仅一次 send；ACK 丢失不重发由既有 A2 覆盖 |
| Master Skill 主动 Recovery 合同 | PARTIAL：Skill 明文要求 known/tracked Task 触发报告、cancel 前授权、成功后复查 status、检查 WIP 后才讨论新 Attempt；policy test 只验证文本合同，不模拟模型行为。MCP 无 Task enumeration 且 status 无 Workspace，不能发现所有未知全局 Hold |
| PID 复用不误杀 | PASS：Windows wrong fingerprint 零信号、PID reuse 与 recorded-tree 精确身份测试通过 |
| Worker 状态无法验证时保留占用 | PASS：`alive/unknown/scan failed` Composition 分支均保持 Operation/Capacity 占用 |
| 显式 Recovery 遇到仍存活 Worker | PASS（Recovery seam）：显式 cancel 使用保存的 PID/start fingerprint stop，再 probe/scan；真实终止能力另由 Windows process-tree 全量用例验证 |
| 显式 stop 失败仍占用 | PASS（Recovery seam）：stop reject 后 identity unknown，Operation 保持 `cleanup_unverified`、Capacity 不释放 |

### 本轮最终 Windows 验收记录

- 环境：Windows，Node `v24.16.0`。
- 命令：`npm run test`；结果 **822 tests，820 pass，0 fail，2 skipped**，测试运行器报告耗时 `1,942,924.9294 ms`。两个 skip 为 Windows ACL 不适用的 POSIX mode 检查，以及 Windows 上不适用的注入场景。
- 后续 `npm run build`、`npm run validate:plugin` 和 `git diff --check` 均通过。B3-05 压力档在本轮完整套件中通过；本轮没有单独重跑 `npm run test:inventory`，不以旧轮次 inventory 数字作为本轮验收证据。
- permission reply/continuation 用例初次在全量负载中触发了超时诊断路径；诊断目录缺失使 `ENOENT` 遮蔽 Worker 超时。测试现在创建诊断目录、将退出等待预算提高至 15 秒；该单项、完整 `runtime-remediation` 文件（7/7）及最终全量回归均通过。产品 Worker 生命周期没有为此改变。
- 本轮定向验证：MCP 双 Host 并发 cancel、六阶段 Manager 子进程硬崩溃、`turn.started` 后 429/503/连接关闭及 Master Skill policy 测试通过。并发测试使用真实 Windows identity-bound terminator；Master 模型行为本身未进行 E2E 验收。
- Codex GUI 重启、真实 Worker 写入部分源码后被强制中断、生产 Provider、生产 Task79 Recovery 均 NOT RUN。Windows 重启未执行，也不作为候选正常 Recovery 的步骤。

验证环境为 Windows + Node `v24.16.0`。完整 `npm run test` 本轮 PASS。并发停止协调限于同一 Node Bridge 进程、同一 dataRoot/database/operation key；独立 Bridge 进程或指向同一文件的路径别名不共享内存 stop Promise。真实 Provider 与生产 Task79 恢复不属于合成测试结果。

### Final gap closure verdict

| Gate | Result | Evidence boundary |
|---|---|---|
| `MCP_CANCEL_CONCURRENCY` | PASS | Real Windows process-tree termination; two MCP Hosts/Managers; one in-process stop; CAS loser rereads Authority |
| `STARTUP_CRASH_MATRIX` | PASS | Six real Windows Manager hard exits and restart Recovery; test-only fake adapter |
| `PROVIDER_TURN_START_NO_RETRY` | PASS | Real adapter/Worker with controlled fake app-server; no production Provider E2E |
| `MASTER_PROACTIVE_RECOVERY` | PARTIAL | Skill policy text and policy test pass; no model behavior E2E or MCP Task enumeration |
| `FULL_TESTS` | PASS | Windows Node 24.16.0, 822 total / 820 pass / 0 fail / 2 skipped |
| `INDEPENDENT_REVIEW` | PARTIAL | Reviewer accepts single-process P0 closure; Master behavior remains unverified |
| `PRODUCTION_DB_MODIFIED` | NO | Candidate tests use isolated fixture databases |
| `TASK79_RECOVERY_EXECUTED` | NO | No Task79 cancel/recovery call was made |
| `GIT_PUSH_MERGE_RELEASE` | NO | No push, merge, tag or release |

**Final candidate verdict: CHANGES_REQUIRED**, because Master proactive behavior is specified and text-checked but not behaviorally verified. Production integration is not proposed in this report.

## 尚保留的约束

1. 同一路径或词法/真实路径重叠路径最多一个可能写入的 Worker；身份 unknown 时路径继续占用。
2. 不以 PID 不存在作为完整清理证据；仍验证 PID 与启动指纹，并扫描已记录树。
3. Claim 和 Attempt 历史永久保留；Cleanup/Release 只通过事务与 revision CAS。
4. 不自动 reset、clean、checkout 覆盖或移除已有 WIP；Provider 错误不触发重复 Prompt，既有源码 diff 保留给 Master 检视。
5. SQLite 是唯一 Authority；不重建 JSON Authority，不改生产 DB，不清除 Task79 Hold。
