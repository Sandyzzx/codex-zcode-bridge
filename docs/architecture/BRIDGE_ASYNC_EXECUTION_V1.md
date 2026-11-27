# Bridge Async Execution Architecture v1

> Status: IMPLEMENTED — PREVIEW.16 CANDIDATE；Owner Binding、安装即生效的 Auto Wake、Console receipt link 已实现；真实 ZCode Desktop Host Completion Wake E2E、严格 C/D、Desktop fully exited、Official Runtime provenance 与非空工程交付为 `NOT_RUN`
> Decision status: [ADR-045](../decisions/ADR-045-async-executor-ownership.md) = ACCEPTED；[ADR-051](../decisions/ADR-051-executor-wake-delivery.md) = ACCEPTED（授权门禁部分由 ADR-059 替代）；[ADR-052](../decisions/ADR-052-async-master-handoff.md) = ACCEPTED；[ADR-059](../decisions/ADR-059-owner-binding-and-installed-auto-wake.md) = ACCEPTED；本文档记录目标合同与当前实现边界
> Date: 2026-11-23（Asia/Shanghai）
> Baseline: `origin/preview` `89ca334802f6e5c1e88b8284863f8151bf4be134`（ADR-055 审计基线）；historical full-matrix candidate `c75c34330287266702cab5949662bf897b74ed5a`；PR 2 base `f330b511270934fa40014006333aa7747dad684c`
> Evidence classification: 文中逐项标注 `VERIFIED`、`INFERRED`、`UNVERIFIED`；证据见 [PR 2 report](../reports/async-executor-pr2-20261122.md)、[PR 2.5 report](../reports/async-executor-pr2.5-20261122.md)、[PR 5 report](../reports/async-executor-pr5-20261122.md)、[PR 6 report](../reports/async-executor-pr6-20261122.md)、[统一 RC report](../reports/async-executor-release-candidate-20261122.md)、[Web real-process E2E](../reports/async-executor-web-real-host-e2e-20261122.md) 与 [trusted-local Wake evidence](../reports/trusted-local-wake-20261123.md)

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
| PR 2 base 的 `startBridge()` 在当前进程创建 `SqliteLifecycleMcpAuthority`，MCP Server 直接调用该对象 | VERIFIED | PR 2 base `f330b511` 的 `src/host/stdio.ts` |
| Manager 独占内存调度队列、active run、workspace fence 和 pump；SQLite 保存持久事实 | VERIFIED | `src/manager/sqlite-lifecycle-mcp-authority.ts` |
| Worker 通过 private pipes 与 Driver 通信，不通过 MCP stdio 提交 Result | VERIFIED | `src/manager/spawn-worker.ts`、`src/store/lifecycle-gate.ts` |
| stdin EOF 触发 Manager shutdown；已有 Worker 依赖 Manager 存续等待 Result/Release | VERIFIED | `src/host/stdio.ts` 与 2026-11-20 S2 审计 |
| 受控 stdin EOF 下 Worker 可完成、Result/Cleanup/Release 可持久化 | VERIFIED | 2026-11-20 隔离实验 |
| SDK/Host 强制结束 Manager 时，原 Worker 的 completed Result 可能丢失并进入恢复重排 | VERIFIED | 2026-11-20 隔离实验，`RESULT_DURABILITY=FAIL` |
| Desktop 运行且 owning backend loaded/idle 时，官方 Queue 能启动原 Thread 新 Turn | VERIFIED | 2026-11-21 B/C 实验 |
| CLI queue 参数能覆盖原 Thread 当前模型/effort | REFUTED | A 实验：实际仍为 Sol/xhigh |
| Queue 支持 notLoaded Thread 或 Desktop 全退 | UNVERIFIED | 严格 C/D 与 Desktop fully exited 均为 `NOT_RUN` |
| Queue ACK 与 Turn 启动是不同事实 | VERIFIED | CLI help 说明 Queue 使用 Thread 当前 model；PR 5 coordinator 以新 `inProgress` Turn 记录 `TURN_STARTED` |
| loaded/idle Thread + exact model/provider/effort preflight 可安全转成一次性 Queue 请求 | VERIFIED（合成客户端） | strict Wake 保持 fail closed；真实 App Server control socket 当前不存在 |
| 显式 trusted-local Owner 策略可在无私有 control socket 时提交一次 Queue | VERIFIED（REAL LOADED/IDLE） | 隔离 Host 真实完成 Queue ACK、新 Turn、Native MCP Result readback、Cleanup/Release、Master 生命周期独立验收与 Desktop Visible；各事实仅一次 |
| shipped MCP Host 进程退出后，独立 Executor 仍完成原 Attempt Result/Cleanup/Release | VERIFIED（synthetic Worker） | `executor-process-targeted-final.log`：Host 真实进程退出、Executor `active`、单次 Spawn/Result、Cleanup/Release 各一次，新 Host 重连读取同一 Result |
| 真实 Web Console + Chromium 观察动态 Deep Link，且 Host 退出后 Web/Executor 继续可用 | VERIFIED（real process / synthetic Worker） | [Web real-process E2E](../reports/async-executor-web-real-host-e2e-20261122.md)：running/completed 页面、真实 URL、Host 退出后 active、原 Attempt 单 Result/Cleanup/Release |
| 独立 Executor 能在真实 Codex Desktop 关闭后保持运行 | UNVERIFIED | Owner 当前 Desktop 未关闭；synthetic Worker 证据不能替代 |

当前集成基线为 `origin/preview@c7bfc28b1112dead95ae4179a00962de76051920`
（Preview.14 release candidate）；发布支持范围仍按现有文档限定为 Windows x64、
Node `24.16.0`、ZCode Desktop `3.18.2.10443`、SQLite v14 ONLY。PR #131 不扩大该范围，也不把
实验性 ADR-042 安装或 Token Efficiency 候选写成当前支持范围。

历史统一候选 `c75c34330287266702cab5949662bf897b74ed5a` 已通过 Windows
本地完整回归 1060 项（1058 pass / 0 fail / 2 existing skips）、注册压力矩阵
4/4、13 个生成物 Freshness 与插件结构校验。PR #131 的 Web/real-process 证据
已安全整合到包含终态 Result 行政释放的上游 Preview；Web
implementation/evidence candidate `02a9e81198cffc5b90077eaba00b5abbfd40f640`
随后继续合并 Preview.13，并由 PR #131 合并到 Preview。合并后 CI
`45124466655` 的 Windows、Ubuntu、SQLite 资源矩阵和 Cost Lab 均通过。
隔离 Host 的 loaded/idle trusted-local Wake、Native MCP Result readback、
Cleanup/Release、Master 生命周期独立验收与 Desktop Visible 为 `PASS — REAL`。
该结果不替代真实 Desktop fully exited、严格 Wake C/D、Official Runtime
provenance、非空工程交付或真实模型 Skill 遵循率。

### 2.1 PR 2 / PR 2.5 实施边界

PR 2 candidate 已在独立分支实现并通过合成/确定性证据：Authority Root
`executor-lease.json` lifetime lease、精确 PID/start fingerprint 仲裁、Idle-only
Shutdown、Named Pipe Control Client/Server、`ZCODE_BRIDGE_MCP_TRANSPORT=control`
Thin MCP、原 Attempt Result/Cleanup/Release 的跨进程 fake Worker E2E，以及
32 MiB Result IPC 回读。

PR 2.5 candidate 将 shipped MCP 入口收敛为单一 Thin MCP：`startBridge()` 只
创建 `ExecutorControlClient`、Task/MCP 与模型/Doctor Adapter，不再构造
Manager、Store、Worker 或 Official Runtime；`in_process` 控制模式已删除。
生产 Authority/Start Plan/model-routing/diagnostic composition 位于
`src/executor/production-composition.ts`，只由独立 Executor 持有。共享的
Task 输入、错误、Host profile、MCP-facing Doctor/model 契约和 IPC 类型分别
抽到无生命周期副作用的模块；静态边界测试锁定 MCP → Executor → Adapter →
ZCode 的依赖方向。原公共 MCP 工具名、Schema、SQLite v14、Manager、Worker、
Result/Cleanup/Recovery 合同未改变。生产 Executor 入口继续拒绝 Fake Adapter
与任意 Worker entry 测试参数。

测试专用 Host harness 仍可为了隔离合同测试保留 legacy Manager；它不是
shipped `bridge.mjs` 路径，也不是生产回退。公共 Core 中嵌入
`SqliteLifecycleMcpAuthority` 的能力仅为兼容调用方保留；正常插件与
`startBridge()` 必须连接 Executor。

当前验收已把 shipped MCP Host、Executor、Web Console 和 Chromium 作为真实
独立进程启动，在 Task 受理和 `launch_intent` 后终止 Host；隔离 Executor 与
Console 保持可用，浏览器继续观察同一 Deep Link，synthetic Worker 提交原
Attempt Result，Cleanup 与 Release 各持久化一次，新 Host 可重连读取同一
Result。该证据边界固定为 **REAL PROCESS + SYNTHETIC WORKER**。PR #131 已合并
到 Preview.14 release candidate，但真实 Codex Desktop fully exited 后原 Attempt
继续执行仍为 `NOT_RUN`；不得把 Host 进程测试冒充 Desktop fully exited，也不得
据此宣称严格 C/D 或 Official Runtime provenance 已通过。

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
| CLI | `list/status/events/result/cancel/reply/console-url` 管理客户端，以及 `executor start/status/stop` | 不直接打开可写 Store，不实现恢复；`console-url` 只返回经 live session/lease 验证的实际地址 |
| Web | 本地任务可视化、Deep Link、状态通知；经干净发现记录复用同一 Console；仅 loopback + Origin/CSRF | 不创建 Task、不调用模型、不写 SQLite、不暴露 Shell/SQLite/文件接口、不控制 Executor 生命周期 |

公共 MCP 工具名和 Schema 保持不变；IPC 是 Bridge 内部协议，不新增公共 MCP 工具。

Owner Thread 只来自 MCP handler 的 `ctx.mcpReq._meta.threadId`，不是
TaskPackage 字段。Task、首个 Attempt 与 Owner Binding 在同一 SQLite 事务
内写入；Continue 保持 Task 级归属。`zcode_task` / `zcode_continue` 的
receipt 在受理后附加经 Executor lease 与 live `/api/session` 验证的
`console_link`；链接失败不撤销已受理 Task。

#### 3.2.1 Task Console 发现与 Deep Link

每个 Authority Root 至多有一个活动 Task Console。Console 使用动态 loopback
端口启动，并在 Root 内写入非秘密 `task-console.json` 作为发现元数据；该文件
绑定 Console PID/start fingerprint、Authority digest、实际 URL/port 和记录
digest，不是第二套 Task/Result/Wake 数据库。第二个 Console 若发现安全存活的
同 Root Owner，只复用其 URL；若 Owner 未知、URL/session 不匹配或绑定不同
Executor lease，则 fail closed。发现记录以跨进程排除创建和 CAS 删除维护。

Task CLI 的 `task console-url <task_id>` 只在 Executor 可连接、Task 可读、
Console `/api/session` 与当前 Executor lease 一致时返回实际
`http://127.0.0.1:<actual-port>/?task_id=<task-id>`；不能取得时返回错误，
不输出猜测地址。页面按 `task_id` 自动选择，手动选择更新 URL，刷新保留选择，
并对第一页之外的任务通过有界 `/summary` 读取。

Task Status、Events、Result 和 Attention 独立读取。Result 尚未提交时，
`TASK_NOT_FINISHED` 只显示 pending；其他真实错误仍可见。页面轮询只刷新本地
Adapter，不取消 Task，也不构造新的通知权威。

### 3.3 Async Master Handoff

Master 的授权、Task Scope 与 Handoff Mechanism 是三个独立维度：

- 授权决定是否可以使用 Bridge，以及可执行的写入/外部操作范围；
- `whole_task`（默认）与 `staged`（真实阶段门）决定交付与验收边界；只读是权限范围；
- `async_wake` 与 `foreground` 决定当前 Master Turn 是否结束。

这些名称都不进入 MCP/TaskPackage schema，也不是 Task 状态。Async Handoff
只可在原 `task_id` 的受理回执可靠、Executor Authority 可核实、没有已知
Pending Interaction、启动错误或未决清理事实时使用。仅 Thread/Wake 绑定不可用时
使用 Web Notify 回退并结束 Turn；回执未知、Authority/授权边界无法确认或启动/清理
未决时留在当前 Turn 或保持未决。Master 在受理后记录 Task/Attempt、Authority
和已知 Thread 绑定，简洁报告，结束 Turn 并停止轮询。

Turn end、Host 断连、MCP Stop 或请求超时只结束等待，不取消已受理 Task。
回执未知时必须用原 `task_id` 对账，不能生成第二 ID/Attempt。Wake 到达后，
Master 先核对 Task、Attempt、Operation 与 Result digest，再读取 Result、
Cleanup/Release 和实际执行目录证据；Wake 本身不表示接收或验收。

Pending Interaction 始终是阻塞事实。结束 Turn 前发现 Pending 必须先处理；
Async Handoff 不新增 Pending Wake，之后的审批仍经 Web/CLI 或下一次用户
Turn 进入。决策与 Skill 合同见 [ADR-052](../decisions/ADR-052-async-master-handoff.md)
与 [ADR-055](../decisions/ADR-055-whole-task-staged-dispatch-and-prompt-contract.md)。

### 3.4 交付事实

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

- Executor 由用户显式启动，例如 CLI `zcode-bridge executor start --data-root <absolute-state-dir>`；首版不提供自动守护。
- 绑定规范化 Authority Root、Bridge/Worker build provenance、Node 版本、用户身份和当前 Windows 用户目录。
- 同 Root 已有活动 Executor 时，CLI 先连接现有 Control Pipe 并报告 `already_running`，不 Spawn；即使发生并发启动，Lifetime Lease 仍返回稳定 `EXECUTOR_ALREADY_ACTIVE`，不创建第二个 owner。
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
- 生产 composition 只能由 Executor 组装；Start Plan private auth、model
  routing registry、Worker diagnostics 和 Doctor 不得因通信层变化而降级或
  分叉。historical in-process Host 只保留在测试 harness，不是 shipped
  fallback；
- 幂等键复用 Task/Continue 现有规范化身份，不创建第二套幂等语义；
- 客户端断开只取消该请求等待，不取消 Task；
- 请求响应丢失返回 `SUBMISSION_UNKNOWN`，调用方必须按原 task/operation id 查询，不得换 id 重派；
- Executor 崩溃后由 SQLite Recovery 判定占用和 queued 事实，不做盲目重试。

### 4.4 生命周期

- Executor 正常退出不直接复用现有 `SqliteLifecycleMcpAuthority.shutdown()`。该方法的语义是 Host 收尾：会尝试取消 queued/running Task 并验证 Cleanup/Release，不适合后台 Executor 的默认退出。
- 首版采用 **Idle-only Shutdown**：
  1. 收到 shutdown 请求后先 fence 新的 Create/Continue/Cancel/Interaction Reply；
  2. 读取 SQLite snapshot 与内存 active run；
  3. 只要存在 queued Attempt、active run、pending interaction、cleanup pending/unverified/hold、未按 ADR-064 安全归档的 `WRITER_INTENT`、poison root、正在提交的 Result，或当前进程不是精确 lease owner，就拒绝退出并返回 `EXECUTOR_SHUTDOWN_NOT_IDLE`；
  4. 全部为空且所有历史 Operation 均 `released` 或 `cancelled_before_launch` 时，允许关闭；
  5. 若拒绝退出，返回 `EXECUTOR_SHUTDOWN_NOT_IDLE` 后撤销 Shutdown fence，恢复 Admission 与 Task/Interaction 控制并继续运行；
  6. 若允许退出，关闭顺序必须是：fence 新请求 → 关闭 named pipe listener → 确认无 active run → 关闭可写 Store → 成功确认 Store closed 后才写 released lease；
  7. Store 关闭失败、released lease 写入或原子 rename 失败时，不释放可写 Authority，状态为 `EXECUTOR_LEASE_RELEASE_UNKNOWN`；下一次启动必须按 stale lease 处理，不得自动夺取；
  8. 现有 60 秒 bounded Host shutdown 仅保留给旧 MCP Host 模式；Async Executor 不把“等待 active Worker 完成”伪装成正常 idle 退出。
- 空闲前用户可显式 `zcode_cancel` 单个任务；但这属于任务取消合同，不是 Executor 正常退出的自动动作。
- 强制终止后的遗留 lease、Hold、legacy/live/未知 `WRITER_INTENT` 保持 fail closed；只有 ADR-064 允许的 exact-absent 身份归档，且归档不删除证据。
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

PR 5 裁决采用 SQLite v14 事件记录，不新增 schema/表：

1. 已 `released` 的 terminal Operation 追加 bounded
   `observation_recorded` evidence，`reason=executor_wake`。
2. evidence 绑定 Task、Attempt、Operation、generation、Result digest、
   Result commit ref、Thread ID、delivery ID、policy digest、authorization
   digest、state、reason code、可选 Queue message ID 和 evidence digest；单条上限 2 KiB。
3. 同一 Operation 最多 5 条 Wake evidence。相同 observation 幂等；
   delivery/binding/transition 冲突、重复 Queue ACK、超过上限或非 `released`
   Operation 均 fail closed。
4. Wake 事件只允许 `released -> released`，不改变 Task、Result、Cleanup、
   Release、Capacity、Writer 或 Recovery projection。Web Notify 只在首次
   `web_notify` 事实持久化后触发；展示失败不回滚或重试 Queue。
5. 没有第二 SQLite/JSON/journal、Web 缓存权威或内存状态 Authority。

实现见 [ADR-051](../decisions/ADR-051-executor-wake-delivery.md)。持久化
兼容性覆盖 Release retry、Continue history、Administrative Release 和
Recovery；真实 Desktop UI acknowledgement 仍是 `UNKNOWN`。

## 6. 分阶段实施

| 阶段 | 范围 | 硬门槛 |
|---|---|---|
| PR 1 | 本文档 + ADR + 接口/测试矩阵 | Owner 批准 |
| PR 2 | Independent Executor + IPC + Thin MCP | 合成跨进程 Result/Cleanup/Release PASS；真实关闭 Codex 后原 Attempt 仍为 `NOT_RUN / BLOCKED` |
| PR 2.5 | MCP → Executor → Adapter → ZCode 四层收敛 | Thin MCP 不再构造 Authority；静态依赖边界、MCP schema parity、Executor IPC 与四层 fake Official Runtime E2E PASS；不新增执行路径 |
| PR 3 | Task CLI + shared Control Client | MCP/CLI 并发读写同一权威；CLI 分发不拥有 SQLite/Manager |
| PR 4 | Web Console | 已实现 loopback/Origin/CSRF、只读 Task/Event/Result/Attention、显式 Cancel/Reply、Root 级发现、`task console-url` 与 Deep Link；真实 Chromium 在 Host 退出前后观察同一 Task，页面关闭不影响 Executor |
| PR 5 | Queue Wake Adapter | 默认 strict loaded/idle exact-config；显式 trusted-local 允许无 control socket 单次 Queue，并保留 Turn 未确认的 Web fallback；严格 C/D 独立验收 |
| PR 6 | Async Master Skill & Dispatch Workflow | 已实现可靠受理后 Turn 结束/停止轮询、未知回执原 ID 对账、Wake 身份核对与独立验收；真实模型遵循率和真实 Host Wake `NOT_RUN / BLOCKED` |

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
| Task CLI 已运行检测 | 已有活动 Executor 不触发第二次 Spawn |
| Task CLI 历史 Authority transition | 仅显式一次性标志；不能绕过已知活动旧 owner |
| Task CLI bounded list/Result | Cursor/limit 与 Result stdout 文件预算生效，不直接打开 SQLite |
| Web Console 本地边界 | 非 loopback/Host/Origin/CSRF 请求拒绝；完整 Result 超过 2 MiB 不截断 |
| Web Console 生命周期 | 页面/HTTP 关闭不改 Task 或 Executor Lease；只关闭可视化 Adapter |
| Web Console 发现 | 同 Authority Root 二进程复用同一实际 URL；异常/未知/lease mismatch fail closed；发现文件不是 Task/Result Authority |
| Web Task Deep Link | `task_id` 自动选择、URL 同步、刷新保留、跨页 summary 可取、URL 不含 CSRF/凭据 |
| Web 未完成 Result | Status/Events 独立显示；`TASK_NOT_FINISHED` 只显示 pending，不掩盖其他有效证据 |
| Wake 授权 | 无 `wake-policy.json`、Owner Grant、模型/Provider/Effort 匹配、Control Socket 或 loaded/idle 前置门禁；安装并启用插件即接受本机 Auto Wake，默认开启，可在 WebUI Settings 关闭 |
| Auto Wake | Binding 为 `bound` 时 Result/Cleanup/Release 后写 `intent` 并调用一次官方 `codex queue`；Binding 缺失只写 `web_notify` + `owner_thread_unavailable`，不得使用 Runtime Session ID |
| Queue / Turn 语义 | `queued` 含 `queue_message_id` 但 ACK 不等于 `turn_started`；观察到新 in-progress Turn 才记 `turn_started`，否则保留 Queue 事实并写 `turn_start_unverified` Web fallback |
| Release Wake recovery | 启动恢复对没有 `executor_wake` fact 的已发布非取消 Result 复用现有 Wake coordinator；不重跑 Worker，不改写历史，不批量唤醒。ADR-059 Late Wake Compensation 不再有生产创建者，历史事实只读保留 |
| Web Notify 可发现性 | CLI/Web 从现有 SQLite `executor_wake` Event 投影 state/reason/at，不新增通知权威 |
| Async Handoff 决策合同 | 授权、Scope、Mechanism、受理、未知回执、Pending、Turn end、Wake 与验收分别判定 |
| Async Handoff 负例 | 断连/Turn end 不取消；Wake identity mismatch 不验收；静默合同测试不能冒充真实模型遵循 |

### 7.2 五个生命周期 E2E

1. Codex Desktop 关闭：Executor/Worker 继续执行，原 Attempt 提交 Result，Cleanup/Release 完成。
2. ZCode Desktop UI 关闭：独立 Official Runtime 继续执行或给出明确失败，不产生假 Result。
3. Codex Stop 当前 Turn / MCP 断连：Task 不被自动取消；显式 Cancel 才走取消合同。
4. Web/CLI/MCP 显式取消：原有身份绑定、Cleanup、Release 合同完全保持。
5. 重开 Codex/Executor：读取原 Task/Attempt/Result，可继续工作，不重复执行。

### 7.3 Wake 验收

- strict：loaded/idle exact-config Queue 投递后必须区分 `QUEUED` 与 `TURN_STARTED`，`TURN_COMPLETED`
  另行由 Thread 事件/后续验收观察，不能由 Queue ACK 推断。
- trusted-local：无同 Owner 控制面时，Adapter 只记录 `QUEUED` 或
  `trusted_local_turn_start_unverified`，不得声称 loaded/idle 或当前模型匹配。
  独立观察取得新 Turn 证据时可另行记录 `TURN_STARTED`；Queue 只提交一次，
  失败/未知不自动重试。
- notLoaded：严格 C，普通 Queue 与 `--resume` 分别验证。
- Desktop 全退：D 场景验证是否持久排队或由独立 owner 消费。
- 模型失控负例：当前 model/effort/budget 未确认时 fail-closed 转 Web Notify。
- 多 writer、版本漂移、提交未知：不自动重发。
- Desktop visible：没有显式 UI acknowledgement 时固定为 `UNKNOWN`。
- Native Host readback：Queue 后必须由 Host 已注册的原生 `zcode_status` /
  `zcode_result(view="summary", expected_attempt=...)` 读取原 Attempt；
  `exec_command`/PowerShell/Node 启动的 Thin MCP 或 Task CLI 不是受支持的
  readback 证据。安装版仍指向旧 in-process Manager 时，
  `NATIVE_MCP_READBACK=BLOCKED_BY_INSTALLED_HOST_VERSION`；Preview.14
  隔离部署已实际加载 Thin MCP，并由 Host 原生工具读取原 Attempt，结果为
  `PASS — REAL`。

当前确定性证据：

- `test/executor-wake.test.ts`：12/12，覆盖 strict 策略缺失/失效、disabled、
  App Server 不可用、notLoaded/active/systemError/direct-input、workspace/model/
  provider/effort 不匹配、trusted-local 显式授权、一次性 intent、message ID、
  ACK lost、Turn observation 与 fallback。
- `test/sqlite-candidate/wp6c/executor-wake.test.mjs`：5/5，覆盖 SQLite v14
  evidence、Queue message ID、幂等/冲突、Web fallback、Release retry 与
  Continue 兼容。
- `test/executor-process.test.ts` 的 fake Worker E2E：Result -> Cleanup ->
  Release -> Wake -> Web fallback 通过，原 Attempt Result 与 release 未被改写。
- shipped MCP Host 进程在 `launch_intent` 后退出，Executor 保持 active；
  synthetic Worker 只 Spawn 一次并提交原 Attempt Result，Cleanup/Release
  各一次，新 Host 重连读取同一 Result。
- 真实 Web Console、Chromium 与 `task console-url` 使用同一动态 URL；Host
  退出后浏览器继续可见 `ACTIVE`，最终页面显示 `completed` 和 Result。
- 2026-11-23 的隔离真实 E2E 证明 loaded/idle trusted-local Queue、Queue
  message ID、新 Turn、Host 原生 MCP Result readback、Result digest、
  Cleanup/Release、Master 生命周期独立验收与 Desktop Visible 均为
  `PASS — REAL`；只出现一次 Queue、Worker、Turn、Result、Cleanup 与 Release。
- 早期受限 shell readback 失败与旧 Host 版本阻断保留在
  [trusted-local Wake evidence](../reports/trusted-local-wake-20261123.md)，
  不改写为未发生；后续修复使用 Host 原生 MCP，不新增 Result 服务或第二权威。

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

- strict 仅 loaded/idle 实验版可先开放；trusted-local 只用于显式单用户本地
  Owner policy，且必须记录 Turn/模型未证明。正式版仍须补严格 C/D、多 writer
  和版本漂移。
- strict 在未确认 model/effort/budget 时一律 Web Notify；trusted-local 的模型
  风险必须由 Owner 在 policy 中显式接受，不能由代码自动升级。
- Queue 失败/未知不得影响 Result/Cleanup/Release；Desktop visible 不得由
  Queue ACK 推断。

### Async Master Skill

- 可靠 Task 受理后才可结束 Master Turn；`SUBMISSION_UNKNOWN` 必须用原
  `task_id` 对账，不得换 ID。
- Turn end、MCP Stop、客户端断开或请求超时不得触发 Task Cancel。
- Wake 后必须核对身份并独立检查 Result、Cleanup、Release、diff 与测试。
- Pending Interaction 不得自动批准，也不得被报告为完成。
- 当前确定性 Skill policy 测试只证明 Markdown 决策合同；真实 Host 的模型
  遵循率属于单独发布风险，`NOT_RUN` 时不得宣称 Async Master 已验收。

### Preview integration

- Executor 开发期使用 T0、受影响测试和关键 E2E；`FULL_SUITE` 在开发门禁明确延期，不得当作通过。完整 Ubuntu/Windows/Stress 只在 Preview Release Candidate、Owner 明确要求或重大跨模块不确定性时运行；整合 terminal-result Preview 后的最终候选仍须执行一次 exact-head Release Gate。
- 真实模型测试须单独授权，使用隔离 Thread 和低成本模型；费用不可观察时报告不可观察。
- Token Efficiency 试点与 Async 架构实验分开记账。

## 9. 已知风险与未验证项

1. 真实 Codex Desktop 关闭后的 Windows 进程存活：`NOT_RUN / BLOCKED_BY_OWNER_ENVIRONMENT`。已通过的真实边界是 shipped MCP Host 进程被终止后，隔离 Executor 与 synthetic Worker 继续完成原 Attempt Result/Cleanup/Release；这不是 Desktop 全退证据。
2. SDK 强制终止导致原 Worker Result 丢失：VERIFIED；S2 必须先解决 owner，再考虑持久化交接。
3. Executor IPC 的同用户安全边界使用 Windows named pipe；确定性单实例/断连/帧边界测试已通过，真实多用户隔离仍未验证。
4. MCP 等待请求与 Executor 控制请求的生命周期已在 PR 2/2.5 candidate 中实现并覆盖 `REQUEST_CANCELLED`、`TASK_CANCEL_REQUESTED`、`SUBMISSION_UNKNOWN`、`EXECUTOR_UNAVAILABLE`；真实 Host 行为仍待 E2E。
5. Thin MCP 已删除 `in_process` 分支；仍依赖客户端在 Executor 未启动时明确得到 `EXECUTOR_UNAVAILABLE`，而不是自动拉起 Executor。
6. Web 列表投影的扫描规模与 Token 输出仍需基准，不得无界读取全部事件。
7. loaded/idle trusted-local Queue、Turn Started、Master Native MCP Result
   readback 与 Desktop Visible 已真实通过；strict C/D 与 Desktop fully
   exited 仍为 `NOT_RUN`。trusted-local Adapter 本身仍不证明 Thread 当前
   loaded 或模型匹配，真实测试观察也不能提升为实时模型预检。
8. A 实验 Sol/xhigh 费用/额度变化不可观察，不估算。
9. Token Efficiency 架构敏感候选保持冻结；本架构不得预设其结果。
10. Master 生命周期独立验收已通过一次真实 Host E2E；Async Handoff 仍由 Skill
    行为约束，不是服务端强制鉴权。真实模型 Skill 遵循率 A/B 与非空工程交付
    验收仍为 `NOT_RUN`，不得据单次生命周期通过宣称所有模型都会可靠遵循。

## 10. Owner 批准记录

1. `ACCEPTED`：独立用户级 Executor、Authority Root lifetime lease 和 Windows named pipe IPC 作为 S2 首版。
2. `ACCEPTED`：MCP/CLI/Web 共用 Executor Control Client，公共 MCP 工具面保持不变。
3. `ACCEPTED`：Queue Wake 作为可选阶段 5；strict 仅支持已授权 loaded/idle Thread，显式 trusted-local 允许本地单用户 Owner 接受当前模型风险后单次 Queue，Web Notify 是默认安全回退。
4. `ACCEPTED`：本验收矩阵作为实施和发布门槛。真实 Desktop 关闭和严格 C/D 分别作为独立门禁。

## 11. 外部实验证据

本提案只读取以下隔离证据，未修改生产实现：

- `D:\codex-zcode-bridge\.run\worker-lifecycle-reliability-20261120\docs\research\worker-lifecycle-reliability-20261120\REPORT.md`
- `D:\codex-zcode-bridge\.run\worker-lifecycle-reliability-20261120\docs\research\worker-lifecycle-reliability-20261120\DECISION.md`
- `D:\codex-zcode-bridge\.run\codex-desktop-wake-ab-20261121\CODEX_DESKTOP_WAKE_AB.md`
- `D:\codex-zcode-bridge\.run\codex-desktop-wake-ab-20261121\S2_QUEUE_WAKE_ARCHITECTURE_UPDATE.md`

这些路径位于主工作区的 `.run`，不随本文档提交。若后续 PR 引用其结论，应在 PR 描述中复制必要证据摘要，并注明 Desktop/CLI 版本与 `VERIFIED/UNVERIFIED` 边界。
