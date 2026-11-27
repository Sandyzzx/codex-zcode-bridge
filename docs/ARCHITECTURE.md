# 当前架构

> Status: AUTHORITATIVE
> Last updated: 2026-11-27（Stable 2.0.0 结项清理）
> Last verified: 2026-11-27，核对 Stable 2.0.0 Release、已登记 Release Gate、本地完整门禁与发布资产；未执行新的真实模型任务。
> Verified against: `dfee062e7c30261763f642106d9ae18b48ce1ae0`（`codex-zcode-bridge-v2.0.0`）

本文件描述 Stable 2.0.0 的生产架构。公开字段与错误语义以 [INTERFACES.md](INTERFACES.md) 为准；宿主接入、运行配置和 Web Console 分别见 [SHARED_CORE.md](SHARED_CORE.md)、[ZCODE_RUNTIME.md](ZCODE_RUNTIME.md) 与 [WEB_CONSOLE.md](WEB_CONSOLE.md)。

## 稳定不变量

| 领域 | 当前合同 |
|---|---|
| 生产链 | 安装版官方 AppServer 是唯一 Worker 执行路径；Host 准备执行目录；Bridge 不创建或删除 Worktree |
| Authority | SQLite v14 是唯一任务 Authority；控制面、持久事实和补充观察分离 |
| 生命周期 | Executor 持有 Manager、SQLite Writer、Worker IPC、官方 Runtime 与 Recovery；Attempt Claim 防止重放 |
| 事实边界 | Result、进程退出、Cleanup、Release、Queue ACK、Turn Started 与 Master Accepted 是独立事实 |
| 恢复 | 精确进程身份、Launch/Claim、recorded tree、resource closure 和 CAS 共同决定恢复或保留占用；未知状态 fail closed |
| 委派 | TaskPackage 表示一个完整、可独立验收的交付；Master 负责目标、验收和返工决策；Staged 仅作显式例外 |
| 模型与套餐 | Provider、Model 和 Reasoning 不被静默改写；官方运行期目录精确匹配；折扣验证不阻断生产执行 |
| 通知 | Owner Thread 只来自 MCP `_meta.threadId`；单次 Queue 不等于 Turn 启动，Turn 启动不等于 Master Accepted |
| 数据边界 | 单用户受信任本机执行；路径、Worktree、Prompt 和 `yolo` 不是 OS 沙箱 |
| 发布 | 插件 manifest、MCP version、Schema、BOM、Official Host 与图标资产来自同一发布提交 |

## 单一生产链

```text
Host startBridge -> Fresh SQLite Bootstrap -> SqliteLifecycleMcpAuthority
MCP tools                                      │ queue / cancel / read-only recovery
                                               ▼
                                 lifecycle-gate + SQLite Lifecycle Port
                                               │ Admission / Intent / CAS / permanent Claim
                                               ▼
                        spawnClaimOnlyWorker -> worker-main private pipes
                                               │
                         OfficialAppServerWorkerAdapter
                          / shared Official Host session factory
                                               │
              fixed official-host-runtime.mjs -> ZCodeAgentProcessManager
                                               │
             installed official AppServer + builtin provider config + runtime-host
                                               │
                                TaskResult -> SQLite v14
                                               │
                              independent Cleanup proof -> Release
```

Stable 2.0.0 的 shipped MCP 入口是 Thin MCP。`ExecutorControlClient` 连接独立 Executor，生产 `SqliteLifecycleMcpAuthority`、SQLite writer、Worker IPC、Official Runtime 和 Recovery 均由 Executor 持有；测试专用 legacy Host harness 不进入生产包。`lifecycle-gate.ts` 负责 Bootstrap、进程身份、私有 Claim/Result/Interaction 管道、Schema 校验和清理证明；SQLite Store 负责事务、Task/Attempt/Operation、Result digest、Capacity 和不可覆盖事件。

Thin MCP 在首次收到控制通道 `EXECUTOR_UNAVAILABLE` 时触发一次性恢复，不增加常驻 Supervisor 或后台轮询。恢复协调器复用 Lifetime Lease、精确进程身份和现有跨进程锁；锁位于 Host 设置目录，不污染 Authority 根。Owner 已退出时先只读检查同一 SQLite Authority 的活动 Launch/Claim Worker；live/未知 Worker、缺 Receipt 的 `launch_intent` 或其他启动不确定性保留在对应 Operation，并由 Workspace fence 阻止同路径新派发。Owner 存活时不归档、不 Spawn 第二个 Executor。恢复锁只接受平台 exact `absent` 身份证据，PID 复用或查询未知继续 fail closed。并发请求最多收敛为一次 Spawn，历史 Task/Attempt/Operation/Result/Event 不重建。

Runtime observation 写入同一 Authority 的 additive `runtime_task_events`，不引入 Event Broker、第二状态机或 Companion IPC。Worker 通过一次性 fd14 发送规范化观察；Manager 只从持久 Task/Attempt/Generation/Claim 派生身份绑定，Worker 不能自报权威身份。Store 按 Worker sequence 幂等并拒绝 stale Attempt，再把 Runtime row 映射到既有单调 public cursor。`zcode_events`、`zcode_feedback` 和 `buildTaskResult()` 从同一持久事实读取 Usage、Model Profile、Timing、Tool Activity 与 Feedback；Lifecycle Event 与 Runtime Event 分属不同表。省略 `max_bytes` 的 Event 读取默认受 32 KiB 页预算约束，持久历史不裁剪，调用方按 `has_more`、`scan_incomplete` 与 cursor 读至结束。

生产 Worker 只接受 Windows x64 的 `OfficialAppServerWorkerAdapter`。Linux、macOS、Windows 非 x64 与其他组合在构造 Adapter 前以 `unsupported_worker_platform` fail closed。direct stdio 实现只保留为 `ZCodeAppServerTestAdapter` 与 `testOnlyLegacyDirectAdapter`，服务协议、帧、期限和 Cleanup 合成回归，不是生产备用路径；环境变量、TaskPackage、MCP 参数、持久配置或测试参数都不能改变正式 Worker 的 Adapter 类型。

`OfficialAppServerWorkerAdapter` 与模型设置共用 `createInstalledOfficialHostSessionFactory`：同一个 Runtime Resolver、Official Host 模块、ProcessManager、ProtocolClient、认证回调和 Close 所有权。安装安全是唯一执行门禁，Manifest 匹配和静态 capability 只作诊断；不安全安装、无效签名、非 x64、混合根和不支持 Node 仍 hard block。Provider capability 在 `session/create` 后按 Runtime 实际报告的 Provider/Model 重新分类，并在 `session/subscribe`/`session/send` 前完成门禁。生产 Official Host 缺少 Provider Runtime Auth resolver 或 resolver 拒绝时 fail closed，不读取持久化 API Key 回退；静态凭据回包只存在于显式 Test Adapter。

## 生命周期与身份

TaskPackage 经 SQLite Manager 校验后创建 queued Attempt。Admission 事务绑定执行路径与 Capacity；同路径或重叠路径不会并行入场。派发前最终校验 source workspace 与 execution worktree，再持久化 Launch Intent。确定性 pre-Intent 拒绝可通过 queued Cancel CAS 终结 untouched reservation；Intent 后视为可能已 Spawn，不因缺 Receipt、句柄、timeout 或回调异常重派。

Worker 接收私有 Bootstrap，经精确 OS 进程身份、Launch/Claim 绑定后进入一次执行。永久 Claim 不重放。Spawner 持续消费 stderr，不在内存累积无人订阅的日志。Worker 只有私有 SQLite 握手入口；旧 `dataRoot taskId attempt` JSON 执行入口已删除。

合法 Result 经完整帧和绑定验证后先提交 SQLite，随后才验证 Worker 退出、Adapter proof、进程树和资源。Result、进程退出、Cleanup 与 Release 是独立事实。完整 canonical TaskResult 最大 32 MiB，Worker envelope 另留容量；COMMIT 不确定继续保留 poison，禁止猜测替代 Result 或重派。Task Continue 以当前 Operation revision 做 CAS，但 Release 证明按该 revision 及其之前存在 `released` Event 判断。原 Attempt、Result digest、Cleanup/Release 证明和全部 Wake Event 均保留。活动 Worker、Workspace 占用、Cleanup 未验证或未知提交仍按原规则拒绝或先核对。

Continue 与 Session Resume 分离：Manager 只从同一 Task 的已提交 Result 有界回溯同一 Session；没有可验证历史时创建新 Session，被官方拒绝有效 resume 时以 `session_not_resumable` 失败且不回退新建 Session。Continue 在创建新 Attempt 前用当前 AppServer 目录精确校验持久化的 Provider、Model 和 Reasoning，不满足时 `provider_config_invalid`，不重路由、不切换套餐。

## Recovery、取消与清理

Recovery 由 SQLite 持久事实和当前 Host 共同协调，并可在 Host 存活期间重复执行。没有 Result 的 running Attempt 只有在持久 Claim 的精确 Worker 已退出、recorded-tree claimant scan clean、Adapter Cleanup 证明完整、没有 Runtime 执行事件、无未回答交互，且当前 Host 不触碰另一个 Host 的存活进程时，才可能原子中断并创建同 Task ID 的新 Attempt。当前生产 Adapter 不提供满足该门槛的独立 Cleanup Proof，因此真实 Result-less Attempt 默认停在 Operation/Workspace Hold，`zcode_status.execution_observation.state=interrupted_without_result`，审计原因为 `adapter_cleanup_unverified`；只有合成 Adapter 测试能走到成功重派分支。不得用 OS PID/tree 扫描替代 Adapter resource facts。

显式 `zcode_cancel` 先复用持久 Claim、取消 intent、termination 与 CAS。身份不明或树不干净时默认保留占用，重复恢复不 Spawn、不重复 Release。Recovery Observation 对相同材料事实去重并返回既有 Evidence Digest；材料变化必须追加不可覆盖 Event。旧 v14 Trigger 只在可写打开时按精确 DDL 事务升级，不提升 Schema Version，只读 Recovery 不修改数据库。

行政释放只适用于既有终态 Result 或可核实的取消场景，并绑定原 Result commit/digest、Claim、Worker identity 与 Recovery evidence。带持久 Receipt 的异常 preclaim 必须由用户显式提供 `user_authorized_unverified_release` 与 `accept_worker_risk=true`；Store 以 CAS 追加 `user_authorized_release_unverified`，不伪造 `cleanup_verified`，旧 Result/Event 保留。live/unknown/term-fail/probe-fail/live-descendant、脏树或 quarantine 保持容量与 Workspace 占用。`zcode_status`/Doctor 只读报告 queued 阻塞的 Task/Operation/phase/Workspace 与时长；所有写入仍经唯一 Authority。

执行、交付与清理期限由 Manager 一次解析 Task/Host 默认执行预算，Worker/Adapter 使用相同快照；执行结束即停止执行 timer，Adapter 清理使用独立预算。迟到或缺失 Cleanup proof 不自动释放路径。

## 官方 Host、账户与认证

发布包携带固定 `official-host-runtime.mjs`、官方签名 runtime-host helper、keyring native closure、许可和 BOM；不携带 `app-server/zcode.cjs` 或 `app-server/provider/zcode-builtin.json`。生产模型执行资产来自安装版同根资产。Windows helper 是官方 Desktop `3.18.2.10443` 的 Authenticode 签名产物，来源、PE x64、大小与 SHA-256 固化在 BOM、Build Provenance 和运行时资源校验常量；Bridge 不编译或另建 Windows 原生实现。支持构建基线为 Windows x64 与 Node.js `24.16.0`；其他 Node 24 patch level、平台和 Desktop 安装组合保持 `NOT_VERIFIED`，非 Windows x64 在构造官方 Host 路径时 fail closed。

官方 `ZCodeAgentProcessManager` 独占正常 Runtime/AppServer/helper 生命周期。Bridge 单独捕获官方 Runtime root PID 和精确 fingerprint，并在 close 后独立验证原 Worker identity 与 recorded process tree。官方 close status/stage、错误 code/name、manager residual process count、tree-scan status 与 Bridge Cleanup outcome 分开保存；有界 close 诊断进入 execution proof 和 SQLite `cleanup_verified` 事件，任意错误 message 不持久化。`dispose()` 或带错误的 `close()` resolved 不能单独生成 `cleanup_verified`。

正常 Cleanup 复用 exact Worker identity、Worker-root recorded-tree scan、resource facts、Cleanup Digest 与 Release CAS。可接受证明包括“Adapter 未启动”和“原根已退出且 recorded-tree claimant scan clean”；任一证明都绑定 Operation/Attempt/generation/Claim，且最终仍需现有 Release CAS。Windows 异常终止使用 identity-bound tree termination，不能把 PID 存活或 shell 状态当成等价证明。

官方 transport 显式使用 16 MiB raw UTF-8 stdout frame 上限。超限立即结束 pending RPC 和 turn，清理缓冲并 fail closed；LF 不计入预算、CR 计入预算、多字节 UTF-8 跨越 chunk 时按 raw bytes 计算。可见文本捕获另有独立上限；这些 Bridge 侧守卫不约束 app-server 内部实现。

Start Plan 每任务只执行一次权威 Billing GET，后续 Private Lease 复用同一 account/provider/model/credential 绑定的 verdict；凭据、Provider 或模型变化必须重新授权。Coding Plan 保持官方账户/API Key 路径，不经过 Start Plan Billing。Private Lease/HANDLE/ACK、fail-closed 和不跨任务缓存继续有效。已安装 3.18.2 Bundle 中的 Start Plan transport 不需要 Coding Plan Client Signing；该离线结论不证明真实 Start Plan 权益或优惠。

固定 Official Host 拥有 credential format、keyring、OAuth refresh、登录主体、BigModel/Z.ai/`zai_cn` 映射和请求认证；Bridge 只消费一次任务所需的 Start Plan 投影，并继续拥有 Billing verdict、Private Lease 和全部任务生命周期。Host 的只读路径使用官方 cipher/repo，禁止未授权的 v1→v2 migration、credentials 写回、source marker 变更和新 key 创建。过期 JWT 的 refresh 才走账户 refresh 协调：profile-scoped lock、获取锁后重读、单次网络刷新、expected-snapshot/CAS 发布、timeout/stale-lock 恢复、不重试可能已消费的一次性 token，以及 live runtime-header 更新。合成矩阵已验证该协调；真实 OAuth refresh、账户轮换和生产凭据 mutation 仍为 `NOT_RUN`。

## Workspace 与发布边界

Task Workspace 是单一 loopback 单页 Task Console：主导航只保留 Tasks，Task 列表与同页详情读取 Task、Attempt、Result、Attention/Hold、Wake、Cleanup、Release 与逐 Attempt Usage。Cost Lab 与 Runtime 能力保留在 Diagnostics；same-origin `/api/cost-lab/*` 复用既有服务，不创建第二个长期 Web 后端或第二套任务 Authority。Task 事实只经 `ExecutorControlClient`/`RemoteTaskManager` 读取，Cancel/Reply/Continue/Rework/Cleanup recovery 由服务端重读权威 capability。语言和主题偏好只存在本地，页面加载、导航、历史读取和普通刷新不触发模型、Runtime 探针或官方 Billing 请求。

Runtime Auto-Learn 是 Console 的只读证据 Adapter，而不是新 Authority：它复用 `OfficialAppServerRuntimeResolver`、安装安全合同、精确指纹和 Cost Lab Protocol Smoke，把 static、零模型、真实 Provider 与 Billing 观察按 fingerprint 写入 `<Authority Root>/.run/bridge-console/runtime-compatibility.json`。不同 fingerprint 不继承结论，Candidate Report 不修改生产 Manifest，页面不会自动发起付费请求。

Fresh root 通过 stage SQLite、pending marker 和原子 publication 初始化；已有 v14 Authority、历史迁移记录、WAL、Recovery、Cleanup 和 Release 合同保持。当前支持声明为 `SQLite v14 ONLY`。Store 在任何可写 SQLite 句柄之前进行只读 `PRAGMA user_version` 预检；v13、未知 Schema、损坏库、writer 活跃或未解释现场均以明确错误 fail closed，不自动升级、离线复制、恢复或回滚，也不把未完成 Marker 当作 Fresh Install。

发布包包含 Bridge、Worker、Thin Waiter、当前 v14 Schema、Administrative Recovery CLI、浏览器后端、Original E 图标资产，以及固定的 Official Host 模块与 helper 资源；不包含 v13 Schema、`upgrade-sqlite-v14` CLI 或第二套 AppServer Runtime。运行时校验 `ARTIFACT_BOM.json` 与 shipped files；固定 3.18.2 构建重放三项有序 patch，并要求生成树与实际源码树完全相同。`@napi-rs/keyring` 与 `keyring-win32-x64-msvc` 的 native closure/license/metadata 通过精确 `.gitignore` 例外纳入包。插件两个 manifest 分别引用 `assets/logo.png` 与 `assets/icon.png`；validator 固定尺寸、字节数与 SHA-256。

Stable `2.0.0` 的 `package.json`、`package-lock.json`、插件 manifest、MCP server version、固定官方 Host、BOM、Runtime Events Schema、图标资产与 Administrative Recovery CLI 必须来自同一发布提交。当前支持声明为 Windows x64 和 Node.js `24.16.0`；其他安全安装可按当前安装合同尝试，但不保证兼容。Stable 保持 v14 数据合同（`task_owner_bindings` 为同一 Authority 的加性扩展），并包含独立 Executor、Thin MCP、单页 Task Console、Host 请求触发的崩溃恢复、持久 Owner Binding、安装即生效的 Auto Wake（默认开启，可关闭）、Async Master Handoff 与验收驱动返工。

真实验收范围、已知限制和 `NOT_RUN`/`UNKNOWN` 项以 [PROJECT_STATE.md](PROJECT_STATE.md) 为准；架构说明不把离线测试、CI 或进程可见性提升为真实 Provider、Desktop 关闭或 Master Accepted 证据。
