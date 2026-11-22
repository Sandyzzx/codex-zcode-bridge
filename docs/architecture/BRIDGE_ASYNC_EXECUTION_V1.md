# Bridge Async Execution Architecture v1

> Status: IMPLEMENTED — PR 2 REMEDIATION CANDIDATE（feature branch candidate；未合入 Preview，不可发布）
> Decision status: [ADR-045](../decisions/ADR-045-async-executor-ownership.md) = ACCEPTED；本文档记录目标合同与 PR 2 当前实现边界
> Date: 2026-11-22（Asia/Shanghai）
> Baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1`；implementation branch `codex/async-executor-pr2`
> Evidence classification: 文中逐项标注 `VERIFIED`、`INFERRED`、`UNVERIFIED`；PR 2 证据报告见 [2026-11-22 report](../reports/async-executor-pr2-20261122.md)

## 1. 目标与非目标

### 目标

1. 把执行所有权从单个 MCP stdio 连接移到用户级独立 Executor。
2. MCP、CLI、Web 复用同一 SQLite v14 Authority 和同一 Executor Control Client。
3. Codex 当前 Turn 结束、MCP 断连或 Codex Desktop 关闭后，已受理 Bridge Task 继续执行。
4. 保持官方 ZCode Runtime、Task、Result、Cleanup、Release 和 SQLite v14 合同不变。
5. 在任务 Result 已持久化且通知事实一致时，用官方 Codex Queue 唤醒已授权的原 Codex Thread。

### 非目标

- 不新增第二套任务数据库、任务状态机、Recovery Engine 或 Worker 执行路径。
- 不改官方 ZCode 认证、Billing、设备身份、签名或 Provider 路由。
- 不把 Wake 当作 Result/Cleanup/Release 的依赖，也不把 Master 验收自动化。
- 首版不做 Windows Service、全局 Supervisor、自动拉起 Executor、空闲退出策略、多用户授权或远程访问。
- 不修改 Codex Desktop 私有数据库、IPC、凭据或配置。

## 2. 现状证据

| 事实 | 状态 | 证据 |
|---|---|---|
| `startBridge()` 在当前进程创建 `SqliteLifecycleMcpAuthority`，MCP Server 直接调用该对象 | VERIFIED | `src/host/stdio.ts` |
| Manager 独占内存调度队列、active run、workspace fence 和 pump；SQLite 保存持久事实 | VERIFIED | `src/manager/sqlite-lifecycle-mcp-authority.ts` |
| Worker 通过 private pipes 与 Driver 通信，不通过 MCP stdio 提交 Result | VERIFIED | `src/manager/spawn-worker.ts`、`src/store/lifecycle-gate.ts` |
| stdin EOF 触发 Manager shutdown；已有 Worker 依赖 Manager 存续等待 Result/Release | VERIFIED | `src/host/stdio.ts` 与 2026-11-20 S2 审计 |
| 受控 stdin EOF 下 Worker 可完成、Result/Cleanup/Release 可持久化 | VERIFIED | 2026-11-20 隔离实验 |
| SDK/Host 强制结束 Manager 时，原 Worker 的 completed Result 可能丢失并进入恢复重排 | VERIFIED | 2026-11-20 隔离实验，`RESULT_DURABILITY=FAIL` |
| Desktop 运行且 owning backend loaded/idle 时，官方 Queue 能启动原 Thread 新 Turn | VERIFIED | 2026-11-21 B/C 实验 |
| CLI queue 参数能覆盖原 Thread 当前模型/effort | REFUTED | A 实验：实际仍为 Sol/xhigh |
| Queue 支持 notLoaded Thread 或 Desktop 全退 | UNVERIFIED | 严格 C/D 未执行 |
| 独立 Executor 能在真实 Codex Desktop 关闭后保持运行 | UNVERIFIED | 需阶段 1 Host E2E |

当前集成基线为 `origin/preview@1bf039fda2ccfd17a992458a871bddd7b48b38c1`
（Preview.11）；发布支持范围仍按现有文档限定为 Windows x64、Node `24.16.0`、
ZCode Desktop `3.18.2.10443`、SQLite v14 ONLY。PR 2 branch 不扩大该范围，也不把
实验性 ADR-042 安装或 Token Efficiency 候选写成当前支持范围。

### 2.1 PR 2 实施边界

PR 2 candidate 已在独立分支实现并通过合成/确定性证据：Authority Root
`executor-lease.json` lifetime lease、精确 PID/start fingerprint 仲裁、Idle-only
Shutdown、Named Pipe Control Client/Server、`ZCODE_BRIDGE_MCP_TRANSPORT=control`
Thin MCP、原 Attempt Result/Cleanup/Release 的跨进程 fake Worker E2E，以及
32 MiB Result IPC 回读。legacy in-process MCP Host 与独立 Executor 现在共用
同一生产 Authority/Start Plan/model-routing/diagnostic composition；Thin MCP
的模型工具和完整 Doctor 也经 Executor IPC 代理，不再降级为本地占位实现。
生产 Executor 入口拒绝 Fake Adapter 与任意 Worker entry 测试参数。legacy
in-process MCP Host 仍是默认路径；`control` transport 是显式 feature flag。

真实 Codex Desktop 关闭后原 Attempt 继续执行、原 Result 提交、Cleanup/Release
完成尚为 `NOT_RUN / BLOCKED_BY_OWNER_ENVIRONMENT`；未关闭 Owner 当前正在使用的
Desktop，未发起付费模型请求。不得把 PR 2 合入 Preview、声明发布通过或对外宣称
Desktop 关闭场景已验证。

## 3. 目标架构

```text
Codex MCP Adapter ┐
Task CLI          ├─ Executor IPC ─→ Single Background Executor
Web Console        ┘                     │
                                       SQLite v14 Authority
                                       Manager / Admission / CAS / Recovery
                                       Worker private IPC
                                       Official ZCode Runtime
                                       Result / Cleanup / Release
                                              │
                                        Wake Adapter (optional, one-shot)
                                              │
                                      authorized Codex Thread / Web Notify
```

### 3.1 单一 Executor

每个规范化 Authority Root 最多一个活动 Executor。Executor 独占：

- `SqliteLifecycleMcpAuthority`；
- SQLite 生命周期写入；
- Worker spawn 与调度；
- Admission、Workspace Occupancy、Claim、CAS；
- Worker Result 与 Runtime Events；
- Cancellation、Cleanup、Recovery；
- Official ZCode Runtime 生命周期。

并发启动不得依赖短时 SQLite Bootstrap lock、单次 Admission CAS 或 named pipe 存在性。首版必须引入 **Executor Lifetime Lease**，并把 lease 作为打开可写 Store 前的启动门。

#### 3.1.1 Lifetime Lease 合同

Lease 存放在现有 Authority Root 内，而不是项目/安装目录外的第二权威：

```text
<authority-root>/executor-lease.json
```

字段绑定：

- `lease_id`：一次性 UUID；
- `authority_root_digest`：规范化 Root 的 SHA-256；
- `protocol_version`；
- `executor_pid`、`executor_start_fingerprint`、`platform`；
- `bridge_sha256`、`worker_sha256`；
- `started_at`、`heartbeat_at`；
- `pipe_name`；
- `state`：`active / stale_unknown / released`；
- `lease_digest`：以上字段 canonical JSON 的 SHA-256。

获取与释放规则：

1. 用 `openSync(..., 'wx', 0o600)` 原子创建 lease；已存在则读取并校验 digest。
2. 对 `active` lease 执行进程身份 probe：PID + start fingerprint 精确匹配才视为存活。
3. 精确 owner 存活时，新进程返回 `EXECUTOR_ALREADY_ACTIVE` 与现有 endpoint，不打开可写 Store。
4. PID 已换代、不可探测或 lease 损坏时，不能直接夺取；标记 `stale_unknown` 并 fail closed，要求用户显式 `executor lease clear --authority-root <root>`。该命令只处理这一个 lease 文件，不触碰 SQLite/Hold/Result。
5. 精确 owner 已退出且 lease 文件完整时，才允许原子 rename 到 `executor-lease.released.json`，随后原子创建新 lease。rename 和 create 不是无锁间隙；若 create 失败，新进程必须终止并不打开 Store。
6. Executor 每隔固定间隔刷新 `heartbeat_at`。心跳失败或无法写回 lease 时进入 `stale_unknown`，拒绝新的 Task Create/Continue/Cancel/Interaction Reply；只读查询可继续。
7. Lifetime Lease 必须覆盖 Manager/SQLite Store 的整个可写生命周期。Executor 只有在 Store 成功关闭、named pipe listener 已关闭之后，才原子写入 released lease；不得先释放 lease 再关闭 Store。
8. Idle-only Shutdown 被拒绝并返回 `EXECUTOR_SHUTDOWN_NOT_IDLE` 后，必须撤销本次 Shutdown fence 并恢复 Admission、pump 和正常任务控制；不得留下永久停机状态。
9. Store 关闭失败或 released lease 写入失败时保持 fail closed：lease 留在 `active` 或标记 `stale_unknown`，可写 Store 保持打开或进入只读诊断，后续启动按 `EXECUTOR_LEASE_RELEASE_UNKNOWN` 处理，不得创建第二个 owner。
10. Executor 异常退出后遗留 lease 属于 `stale_unknown`，重启必须走显式清理/精确退出核对路径。

Named pipe 仍可作为客户端连接提示，但**不是所有权证据**。SQLite Bootstrap lock 只用于 Fresh Bootstrap；Admission CAS 只仲裁单个 Task/Operation，二者都不是 Executor 存活期单实例机制。

验证必须覆盖：

- 第二进程遇到精确存活 owner：`EXECUTOR_ALREADY_ACTIVE`，SQLite 打开次数为 0；
- owner PID 复用但 start fingerprint 不同：fail closed；
- lease 损坏：fail closed；
- kill Executor 后重启：不自动删除，不打开 Store，先要求显式处理；
- 正常退出释放后再启动：成功且只有一个 Manager；
- lease 写失败：Executor 进入只读诊断，不创建新 owner；
- 并发两个启动进程：只有一个原子 `wx` 成功，失败方不打开可写 Store。
- 旧 MCP Manager 与新 Executor 混用：旧 Host 精确存活时新 Executor fail closed；旧 Host 非存活/换代时同样不允许无证据接管；
- 手动 Lease Clear 重复执行或针对活动 owner：必须通过精确存活检查拒绝，不得误删除活动 Owner。

### 3.2 MCP / CLI / Web 职责

| 客户端 | 职责 | 禁止 |
|---|---|---|
| MCP | 派发、查询、Continue、Cancel、交互回复的协议适配 | 不创建 Manager，不因连接断开取消 Task |
| CLI | `list/status/events/result/cancel/reply` 管理客户端 | 不直接打开可写 Store，不实现恢复 |
| Web | 本地任务可视化、取消、交互回复、状态通知 | 不调度任务、不写 SQLite、不暴露 Shell/文件接口 |

公共 MCP 工具名和 Schema 保持不变；IPC 是 Bridge 内部协议，不新增公共 MCP 工具。

### 3.3 交付事实

这些事实必须独立展示，不能互相冒充：

1. Task accepted；
2. Worker started；
3. Result committed；
4. Cleanup verified；
5. Operation released；
6. completion notification generated；
7. Wake queued；
8. Codex Turn started；
9. Turn completed；
10. Desktop visible；
11. Master accepted。

`completed` 仍只表示执行与报告归一化完成，不表示 Owner 验收。

## 4. Executor 进程与 IPC

### 4.1 启动和身份

- Executor 由用户显式启动，例如 CLI `executor start --data-dir <absolute-state-dir>`；首版不提供自动守护。
- 绑定规范化 Authority Root、Bridge/Worker build provenance、Node 版本、用户身份和当前 Windows 用户目录。
- 同 Root 已有活动 Executor 时，新启动返回现有 endpoint 或稳定 `EXECUTOR_ALREADY_ACTIVE`，不创建第二个 owner。
- 不同 Root 允许各自一个 Executor；Capacity 与 workspace overlap 继续由 SQLite 全局仲裁。

### 4.2 IPC 选择

首版选择 Windows named pipe + Node.js stream framing，原因：

- 同用户本地、无需 TCP 端口；
- Cost Lab 已验证 loopback Web 安全经验，但 Executor IPC 不应把本地任务控制暴露给浏览器网络栈；
- 可用有界 JSON frame 复用现有协议思维，避免引入重依赖。

Pipe name 绑定规范化 Root digest，例如 `codex-zcode-bridge-executor-v1-<sha256(root)>`。首版只接受同用户连接。

### 4.3 协议合同

```text
ControlRequest  { protocol_version, request_id, method, params, idempotency_key? }
ControlResponse { protocol_version, request_id, ok, result | error, executor_state }
```

要求：

- `protocol_version=1`；
- request id 必须唯一，有界；
- 每个 frame 有原始 UTF-8 byte 上限。PR 2 Control frame budget 为 33 MiB，
  用于容纳既有 32 MiB canonical Result 和协议 envelope；普通控制消息仍受同一
  上限保护，超限在 Manager dispatch 前 fail closed；
- 控制方法只覆盖现有 MCP 生命周期操作、模型设置、Doctor 和只读列表查询；
- legacy MCP Host 与 Executor 必须调用同一生产 composition；Start Plan
  private auth、model routing registry、Worker diagnostics 和 Doctor 不得因
  Authority 宿主变化而降级或分叉；
- 幂等键复用 Task/Continue 现有规范化身份，不创建第二套幂等语义；
- 客户端断开只取消该请求等待，不取消 Task；
- 请求响应丢失返回 `SUBMISSION_UNKNOWN`，调用方必须按原 task/operation id 查询，不得换 id 重派；
- Executor 崩溃后由 SQLite Recovery 判定占用和 queued 事实，不做盲目重试。

### 4.4 生命周期

- Executor 正常退出不直接复用现有 `SqliteLifecycleMcpAuthority.shutdown()`。该方法的语义是 Host 收尾：会尝试取消 queued/running Task 并验证 Cleanup/Release，不适合后台 Executor 的默认退出。
- 首版采用 **Idle-only Shutdown**：
  1. 收到 shutdown 请求后先 fence 新的 Create/Continue/Cancel/Interaction Reply；
  2. 读取 SQLite snapshot 与内存 active run；
  3. 只要存在 queued Attempt、active run、pending interaction、cleanup pending/unverified/hold、`WRITER_INTENT`、poison root、正在提交的 Result，或当前进程不是精确 lease owner，就拒绝退出并返回 `EXECUTOR_SHUTDOWN_NOT_IDLE`；
  4. 全部为空且所有历史 Operation 均 `released` 或 `cancelled_before_launch` 时，允许关闭；
  5. 若拒绝退出，返回 `EXECUTOR_SHUTDOWN_NOT_IDLE` 后撤销 Shutdown fence，恢复 Admission 与 Task/Interaction 控制并继续运行；
  6. 若允许退出，关闭顺序必须是：fence 新请求 → 关闭 named pipe listener → 确认无 active run → 关闭可写 Store → 成功确认 Store closed 后才写 released lease；
  7. Store 关闭失败、released lease 写入或原子 rename 失败时，不释放可写 Authority，状态为 `EXECUTOR_LEASE_RELEASE_UNKNOWN`；下一次启动必须按 stale lease 处理，不得自动夺取；
  8. 现有 60 秒 bounded Host shutdown 仅保留给旧 MCP Host 模式；Async Executor 不把“等待 active Worker 完成”伪装成正常 idle 退出。
- 空闲前用户可显式 `zcode_cancel` 单个任务；但这属于任务取消合同，不是 Executor 正常退出的自动动作。
- 强制终止后的遗留 lease、Hold、`WRITER_INTENT` 均保持 fail closed，不得自动清除。
现有 60 秒 bounded Host shutdown 仅保留给旧 MCP Host 模式；Async Executor 不把“等待 active Worker 完成”伪装成正常 idle 退出。
- Executor 未运行时，MCP/CLI/Web 只能读只读 Attention/状态，或提示用户显式启动 Executor。
- 升级前后必须正常 shutdown；强制结束后的恢复沿用现有 Hold/Recovery 合同。
- 不用 `detached:true` 推断真实 Host 脱离；真实 Job Object/进程组行为是阶段 1 E2E 项。

## 5. SQLite 与历史兼容

- SQLite v14 是唯一 Authority；不新增 schema，不改变 Task/Attempt/Operation/Result 状态。
- 旧任务、Result、事件和 Hold 仍按 v14 读取；不迁移、不改写、不清锁。
- Executor 启动执行既有 `recoverTasks()`：active run 优先，running 无 Result 保持 Hold 或按 ADR-036 条件处理；queued attempt 只派发一次。
- Web/CLI 列表需要新增只读投影方法，但读取同一 Authority；不新增 Web 数据库或缓存权威。
- Runtime Events/Usage 继续使用 `runtime_task_events` 和 `zcode_feedback` 投影，不复制 Event Broker。

### 5.1 Wake Intent / Delivery 持久化

Wake 不新增第二套持久化权威。PR 5 前必须先完成一次 schema 裁决：

1. **优先方案 A：SQLite v14 事件记录**。为已释放的 terminal Operation 追加一条 bounded `observation_recorded` 事件，把 Wake Intent/Delivery 的事实摘要写入受验证的 evidence JSON，并用 `evidence_digest` 绑定 Task、Attempt、Operation、Result digest、Thread ID、delivery ID、授权来源和状态。该方案需要扩展现有 evidence allowlist 与事件校验，属于受控 schema/校验变更，不新增表和第二状态机。
2. **方案 B：Authority Root 下的私有 append-only journal**。只有方案 A 无法在 2 KiB evidence 限制内表达必要事实且无法安全修改校验时才评估。仍必须位于同一 Authority Root、绑定 Result digest、原子写入、无 schema 变更；不得变成任务调度事实源。
3. **禁止**：独立 SQLite/JSON 任务库、Web 侧缓存权威、把 Wake 状态混入 Task 状态、或仅依赖 Web 进程内存。
4. 若 PR 5 无法证明方案 A 的 evidence 结构、幂等和审核边界，Wake 持久化保持 `INCONCLUSIVE`，只允许 Web Notify，不开放自动 Queue。

该问题不阻塞 PR 2/3/4。

## 6. 分阶段实施

| 阶段 | 范围 | 硬门槛 |
|---|---|---|
| PR 1 | 本文档 + ADR + 接口/测试矩阵 | Owner 批准 |
| PR 2 | Independent Executor + IPC + Thin MCP | 合成跨进程 Result/Cleanup/Release PASS；真实关闭 Codex 后原 Attempt 仍为 `NOT_RUN / BLOCKED` |
| PR 2.5 | MCP → Executor → Adapter → ZCode 四层收敛 | 职责与行为兼容；不新增执行路径 |
| PR 3 | Task CLI + shared Control Client | MCP/CLI 并发读写同一权威 |
| PR 4 | Web Console | 本地安全、无模型调用、页面关闭不影响 Task |
| PR 5 | Queue Wake Adapter | 已加载 idle Thread 交付确认；严格 C/D 独立验收 |
| PR 6 | Async Master Skill & Dispatch Workflow | Master Turn 结束、通知、恢复与独立验收 |

允许按依赖合并 PR，但每阶段不得扩大到重构生产合同。统一 Release Candidate
在 PR 2-6 功能链完成后集中执行完整本地与 CI 门禁，而不是在每个普通 PR
更新时重复完整矩阵。

## 7. 测试矩阵

### 7.1 合成与隔离测试

| 场景 | 判定 |
|---|---|
| Executor 单实例仲裁 | 第二启动不创建 owner |
| Executor lifetime lease 精确存活 | PID 换代、心跳失败、lease 损坏均 fail closed |
| Idle-only shutdown | 活动任务/排队任务/Hold/提交未知时拒绝退出 |
| Shutdown 被拒绝后恢复运行 | `EXECUTOR_SHUTDOWN_NOT_IDLE` 后 Admission 和任务控制可用 |
| Lease/Store 关闭顺序 | Store 关闭前 lease 保持 active；释放未知不建第二 owner |
| 旧 MCP Manager 与新 Executor 混用 | 旧 Host 精确存活时新 Executor fail closed |
| 手动 Lease Clear 活动 Owner | 拒绝，不删除活动 lease |
| MCP dispatch response lost | 原查询 id 幂等，无重复 Task |
| MCP client disconnect | 当前请求等待结束，Task 不取消 |
| CLI/Web/MCP 并发 | 同一状态，无重复 Release |
| Task Continue 竞争 | 原 CAS/operation id 仲裁 |
| Cancel vs Result race | Result 优先，Cleanup/Release 按原合同 |
| Executor 正常关闭 | 仅空闲允许；lease 释放未知时不关闭可写 Store |
| Executor 异常崩溃 | Recovery 不伪造 Result/Release |
| IPC frame 超限/畸形 | fail closed，不破坏 Authority |
| Interaction reply ACK unknown | 不重放，保留待确认 |
| legacy Host/Executor 生产组装一致性 | Start Plan、动态 routing、Worker diagnostics、Doctor、模型设置同源 |
| Thin MCP 模型与 Doctor | set/get/clear/list 经 IPC；Doctor 保留完整检查，不返回本地占位 |
| Executor 启动失败 | pipe/Authority 启动失败按精确 Lease 与 Store close 证明回滚或 fail closed |

### 7.2 五个生命周期 E2E

1. Codex Desktop 关闭：Executor/Worker 继续执行，原 Attempt 提交 Result，Cleanup/Release 完成。
2. ZCode Desktop UI 关闭：独立 Official Runtime 继续执行或给出明确失败，不产生假 Result。
3. Codex Stop 当前 Turn / MCP 断连：Task 不被自动取消；显式 Cancel 才走取消合同。
4. Web/CLI/MCP 显式取消：原有身份绑定、Cleanup、Release 合同完全保持。
5. 重开 Codex/Executor：读取原 Task/Attempt/Result，可继续工作，不重复执行。

### 7.3 Wake 验收

- loaded/idle：Queue 投递后必须有 `TURN_STARTED` 与终态证据。
- notLoaded：严格 C，普通 Queue 与 `--resume` 分别验证。
- Desktop 全退：D 场景验证是否持久排队或由独立 owner 消费。
- 模型失控负例：当前 model/effort/budget 未确认时 fail-closed 转 Web Notify。
- 多 writer、版本漂移、提交未知：不自动重发。

## 8. 发布门槛

### PR 2 / S2 Lite

- 关闭真实 Codex Host 后，原 Attempt 继续执行并完成 Result/Cleanup/Release。
- 真实 Windows 进程 owner 证据，不用 `detached:true` 代替。
- SQLite v14 历史任务只读兼容。
- 不出现双 Manager、重复 Spawn 或无证据 Release。

### Web / CLI

- 多客户端并发只读与控制；页面/CLI 关闭不影响任务。
- loopback、Origin、CSRF 与同用户边界通过；无任意 Shell/文件/SQLite 接口。
- Pending Interaction 和 Cleanup Hold 可见且操作符合原授权。

### Wake

- 仅 loaded/idle 实验版可先开放；正式版必须补严格 C/D、多 writer 和版本漂移。
- A 类模型失控必须有负例测试；未确认 model/effort/budget 一律 Web Notify。

### Preview integration

- Executor 开发期使用 T0、受影响测试和关键 E2E；`FULL_SUITE` 在开发门禁明确延期，不得当作通过。完整 Ubuntu/Windows/Stress 只在 Preview Release Candidate、Owner 明确要求或重大跨模块不确定性时运行。
- 真实模型测试须单独授权，使用隔离 Thread 和低成本模型；费用不可观察时报告不可观察。
- Token Efficiency 试点与 Async 架构实验分开记账。

## 9. 已知风险与未验证项

1. 独立 Executor 在真实 Codex Desktop 关闭后的 Windows 进程存活：`NOT_RUN / BLOCKED_BY_OWNER_ENVIRONMENT`；合成进程与 fake Worker 路径已通过。
2. SDK 强制终止导致原 Worker Result 丢失：VERIFIED；S2 必须先解决 owner，再考虑持久化交接。
3. Executor IPC 的同用户安全边界使用 Windows named pipe；确定性单实例/断连/帧边界测试已通过，真实多用户隔离仍未验证。
4. MCP 等待请求与 Executor 控制请求的生命周期已在 PR 2 candidate 中实现并覆盖 `REQUEST_CANCELLED`、`TASK_CANCEL_REQUESTED`、`SUBMISSION_UNKNOWN`、`EXECUTOR_UNAVAILABLE`；真实 Host 行为仍待 E2E。
5. Web 列表投影的扫描规模与 Token 输出仍需基准，不得无界读取全部事件。
6. Queue 只证明 loaded/idle；notLoaded 与 Desktop 全退 UNVERIFIED。Queue Adapter 属于后续 PR 5，不在 PR 2 实现。
7. A 实验 Sol/xhigh 费用/额度变化不可观察，不估算。
8. Token Efficiency 架构敏感候选保持冻结；本架构不得预设其结果。

## 10. Owner 批准记录

1. `ACCEPTED`：独立用户级 Executor、Authority Root lifetime lease 和 Windows named pipe IPC 作为 S2 首版。
2. `ACCEPTED`：MCP/CLI/Web 共用 Executor Control Client，公共 MCP 工具面保持不变。
3. `ACCEPTED`：Queue Wake 作为可选阶段 5，且仅支持已授权 loaded/idle Thread；Web Notify 是默认安全回退。
4. `ACCEPTED`：本验收矩阵作为实施和发布门槛。真实 Desktop 关闭和严格 C/D 分别作为独立门禁。

## 11. 外部实验证据

本提案只读取以下隔离证据，未修改生产实现：

- `D:\codex-zcode-bridge\.run\worker-lifecycle-reliability-20261120\docs\research\worker-lifecycle-reliability-20261120\REPORT.md`
- `D:\codex-zcode-bridge\.run\worker-lifecycle-reliability-20261120\docs\research\worker-lifecycle-reliability-20261120\DECISION.md`
- `D:\codex-zcode-bridge\.run\codex-desktop-wake-ab-20261121\CODEX_DESKTOP_WAKE_AB.md`
- `D:\codex-zcode-bridge\.run\codex-desktop-wake-ab-20261121\S2_QUEUE_WAKE_ARCHITECTURE_UPDATE.md`

这些路径位于主工作区的 `.run`，不随本文档提交。若后续 PR 引用其结论，应在 PR 描述中复制必要证据摘要，并注明 Desktop/CLI 版本与 `VERIFIED/UNVERIFIED` 边界。
