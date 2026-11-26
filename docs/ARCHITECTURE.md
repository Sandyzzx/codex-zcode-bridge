# 当前架构

> Status: AUTHORITATIVE

> 2026-11-16 本地候选修订：[ADR-039](decisions/ADR-039-host-authorized-cancellation.md) 将取消授权与清理事实分离。queued + Launch Intent 无 Claim 时允许原子持久化取消并禁止迟到 Claim，未证明的进程/资源占用保留；Running 的 cleanup-only Hold 可经新鲜取消树证明追加消解记录，再继续原 CAS。此修复不增加 MCP 工具、Schema、重派或第二套恢复引擎。
> Last updated: 2026-11-26（Preview.18 候选：ADR-064 Executor 启动能力、Writer Intent 身份恢复与用户授权释放）
> Last verified: 2026-11-26，核对 Executor recovery 真实进程 13/13、SQLite writer intent 35/35、forced cleanup Store、Result paging、Web HTTP 清理与 process-lock PID reuse 定向测试。完整回归、Windows/Ubuntu Release Gate 与真实 Host 场景在集成/发布阶段记录。
> Verified against: `57e0a70b` 基线上的候选工作树；提交后由最终报告记录候选 SHA。

本文件描述当前 Preview.17 候选的生产架构。Windows x64 已默认切换到官方 Host 路径，R7 Runtime Events/Usage 复用同一 SQLite Authority；候选保留 ZCode 3.18.2 Host 模块、官方 Start Plan 认证投影与官方签名 runtime host，并完成 ADR-041 的 Thin Official Host 收敛。PR #116 已在 `450c18af` 合入 opt-in Result 摘要/默认完整 Result 与 Event Attempt 归属；PR #121 已在 `f51e965e` 合入无固定次数的 Recovery 观察去重与历史 v14 Hold 兼容；PR #129 已合入完整已捕获响应的 AgentReport 扫描；PR #130 已合入四种终态 Result 的统一 `zcode_cancel` 行政释放；PR #131 已合入独立 Executor、Thin MCP、Task CLI/Web 与 Async Master Handoff；ADR-059 已用持久 Owner Binding 与安装即生效 Auto Wake 取代专用 Wake 授权。Preview.17 增加 Host 请求触发的 Executor 恢复、Release 事实驱动的 Continue、Master 验收驱动返工和单页 Task Console。公开合同继续以 [INTERFACES.md](INTERFACES.md) 为准，宿主和运行配置分别见 [SHARED_CORE.md](SHARED_CORE.md) 与 [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md)。

> 2026-11-24 架构状态：Owner 已接受 [ADR-045](decisions/ADR-045-async-executor-ownership.md) 与 Async Executor 总体架构，并以 [ADR-059](decisions/ADR-059-owner-binding-and-installed-auto-wake.md) 确定 Owner Binding 与 Auto Wake 合同。PR #131 的 Lifetime Lease、IPC、Thin MCP、Control-only CLI、loopback Web 与 Async Master Handoff 继续有效；`wake-policy.json`、Owner Grant、模型/Provider/Effort 匹配与 loaded/idle 前置门禁已退役。Task 受理时把 Host `_meta.threadId` 与 Task、首个 Attempt 同事务持久化，Release 后最多提交一次官方 Codex Queue；`web_notify`、ACK、`turn_started` 与 Master Accepted 分别记录。真实安装制品 + 真实 Codex Host 的非空工程 Auto Wake 闭环为 `PASS — REAL`；strict C/D、Desktop fully exited、notLoaded、Official Runtime provenance 与真实模型 Skill 遵循率仍为 `NOT_RUN`。

[ADR-062](decisions/ADR-062-single-page-task-console.md) 把 Preview.17
Console 收敛为单一 loopback 单页 Task Console：主导航只保留 Tasks，
Task 列表与同一页面内展开的详情读取 Task、Attempt、Result、Attention/
Hold、Wake、Cleanup、Release 与逐 Attempt Usage。Cost Lab 与 Runtime
不再占独立主导航，但底层能力保留在 Diagnostics；same-origin
`/api/cost-lab/*` 继续复用既有服务，不创建第二个长期 Web 后端或第二套
任务 Authority。Task 事实仍只经 `ExecutorControlClient`/
`RemoteTaskManager` 读取，Cancel/Reply/Continue/Rework/Cleanup recovery
仍显式转发并由服务端重读权威 capability。语言与主题偏好只存在浏览器本地，
页面加载、导航、主题/语言切换和历史读取不触发模型、Runtime 探针或官方
Billing 请求。

Runtime Auto-Learn 是 Console 的只读证据 Adapter，而不是新的 Task
Authority：它复用 `OfficialAppServerRuntimeResolver`、ADR-054 安装安全
检查、精确指纹和 Cost Lab Protocol Smoke，把 static、零模型、真实 Provider
与 Billing 观察按 fingerprint 写入
`<Authority Root>/.run/bridge-console/runtime-compatibility.json`。不同
fingerprint 不继承能力结论，Candidate Report 不修改生产 Manifest，页面
不会自动发起付费请求。完整合同见 [ADR-053](decisions/ADR-053-runtime-auto-learn-compatibility.md)。

2026-11-19 的集成候选应用 [ADR-040](decisions/ADR-040-installed-official-appserver-runtime.md) 与 [ADR-041](decisions/ADR-041-thin-official-host-end-state.md)：所有受支持 Provider 在通过精确 Manifest 校验后，统一使用用户已安装的官方 AppServer Bundle、同根 builtin Provider 配置和 runtime host；Provider 只决定认证/权益能力，不再选择 AppServer 来源。未知安装版不再仅因不在 Manifest 中永久拒绝：[ADR-042](decisions/ADR-042-unknown-runtime-experimental-authorization.md) 先完成完整安装安全检查与指纹计算，只有精确指纹获得本地显式授权后才进入 `OFFICIAL_RUNTIME_EXPERIMENTAL`。授权按 `coding_plan_probe`、`start_plan_probe`、`other_provider_probe` 分 scope；不安全安装、无效签名、非 x64、混合根和不支持 Node 仍 hard block。实验态不自动提升 Manifest、Provider 能力或折扣状态，也不存在静默回退到打包 AppServer 的路径。Provider capability 在 `session/create` 后按 Runtime 实际报告的 Provider/Model 重新分类，并在 `session/subscribe`/`session/send` 前完成门禁；显式与隐式选择走同一检查点。

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

当前 Preview 中 `SqliteLifecycleMcpAuthority` 仍由 MCP Host 进程持有。PR 2.5 candidate 不改变这个历史事实，但把候选分支的 shipped MCP 入口收窄为 Thin MCP：`ExecutorControlClient` 连接独立 Executor，生产 `SqliteLifecycleMcpAuthority`、SQLite writer、Worker IPC、Official Runtime 和 Recovery 均迁入 Executor；测试专用 legacy Host harness 不进入生产包。`lifecycle-gate.ts` 负责 Bootstrap、进程身份、私有 Claim/Result/Interaction 管道、Schema 校验和清理证明；SQLite Store 负责事务、Task/Attempt/Operation、Result digest、Capacity 和不可覆盖事件。

[ADR-060](decisions/ADR-060-executor-crash-recovery-and-release-fact-continue.md) 在 Thin MCP 首次收到控制通道
`EXECUTOR_UNAVAILABLE` 时触发一次性恢复，不增加常驻 Supervisor 或后台轮询。
恢复协调器复用 Lifetime Lease、精确进程身份和现有跨进程锁：锁位于 Host
设置目录，不污染 Authority 根；Owner 已退出时先只读检查同一 SQLite
Authority 的活动 Launch/Claim Worker。[ADR-064](decisions/ADR-064-executor-startability-and-user-release.md)
把 live/未知 Worker 或缺 Receipt 的 `launch_intent` 保留在对应 Operation，
输出 retained operations，不再全局阻断恢复；SQLite Workspace fence 阻止
同一 Workspace 新派发。Owner 存活时不归档、不 Spawn 第二个 Executor。
恢复锁只接受平台 exact `absent` 身份证据，PID 复用或查询未知继续 fail
closed。恢复成功后重新连接同一控制
通道；并发请求只收敛到一次 Spawn，历史 Task/Attempt/Operation/Result/
Event 不重建。

R7 在同一 Authority 内增加 additive `runtime_task_events`，不新增 Event Broker、第二状态机或 Companion IPC。Worker 通过一次性 fd14 发送规范化 Runtime observation；Manager 只从持久 Task/Attempt/Generation/Claim 派生身份绑定，Worker 不能自报权威身份。Store 以 Worker sequence 幂等、拒绝 stale Attempt，并把 Runtime row 映射到既有单调 public cursor。`zcode_events`、`zcode_feedback` 和 `buildTaskResult()` 从同一持久事实读取 Usage、Model Profile、Timing、Tool Activity 与 Feedback；Lifecycle Event 与 Runtime Event 仍分属不同表。ADR-048 只把省略 `max_bytes` 的读取限制为默认 32 KiB 页，持久 Event 不裁剪，调用方按 `has_more`/`scan_incomplete` 与 cursor 读至结束。

生产 Worker 的 `zcode_app_server` 模式按 [ADR-035](decisions/ADR-035-worker-platform-adapter-selection.md) 选择 Adapter。只有 `win32/x64` 实例化 `OfficialAppServerWorkerAdapter`；Linux、macOS、Windows 非 x64 与其他组合都在构造 Adapter 前以 `unsupported_worker_platform` fail closed。direct stdio 实现已收敛为显式 `ZCodeAppServerTestAdapter` 与 `testOnlyLegacyDirectAdapter`，只服务协议、帧、期限和 Cleanup 合成回归，不是生产备用路径。选择只读取 platform/arch，环境变量、TaskPackage、MCP 参数、持久配置和测试参数都不能改变正式 Worker 的 Adapter 类型。正式 Adapter 沿用 `CodingAgentAdapter` 的完成、取消、交互、结果、期限和 Cleanup 合同，没有新增公开 Adapter Mode、持久配置或平行 RuntimeAdapter。

`OfficialAppServerWorkerAdapter` 与 `ZCodeModelSettings` 共用 `createInstalledOfficialHostSessionFactory`：同一个 Runtime Resolver、Official Host 模块、ProcessManager、ProtocolClient、认证回调和 Close 所有权。Coding Plan、Start Plan 与其他 Provider 的认证/权益门禁仍各自独立；Start Plan 的 Live Entitlement、Private Lease、HANDLE/ACK 与脱敏没有合并。动态 capability 分类读取官方 Provider registry 与当前账户配置，不靠 Provider ID 字符串推断；Coding Plan 未验证、Start Plan 非 `OFFLINE_COMPATIBLE` 或注册/模型不一致时均在 send 前 fail closed。ADR-054 退役了实验授权机制：安装安全是唯一执行门禁，静态 capability 事实只作诊断（`officialProviderCapabilityWarning`），不把 `OFFICIAL_DISCOUNT_NOT_VERIFIED` 改写为优惠通过，也不把实验 Start Plan 观测改写为兼容。生产 Official Host 缺少 Provider Runtime Auth resolver 或 resolver 拒绝时只返回不可用，不读取持久化 API Key 回退；静态凭据回包仅保留给显式 Test Adapter。任何 Provider 都不能静默使用旧打包 AppServer。

## 生命周期与身份

TaskPackage 经 SQLite Manager 校验后创建 queued Attempt。Admission 事务绑定执行路径与 Capacity；同路径或重叠路径不会并行入场。派发前最终校验 source workspace 与 execution worktree，再持久化 Launch Intent。确定性 pre-Intent 拒绝可通过 queued Cancel CAS 终结 untouched reservation；Intent 后视为可能已 Spawn，不因缺 Receipt、句柄、timeout 或回调异常重派。

Worker 接收私有 Bootstrap，经精确 OS 进程身份、Launch/Claim 绑定后进入一次执行。永久 Claim 不重放。Spawner 持续消费 stderr，不在内存累积无人订阅的日志。Worker 只有私有 SQLite 握手入口；旧 `dataRoot taskId attempt` JSON 执行入口已删除。

合法 Result 经完整帧和绑定验证后先提交 SQLite，随后才验证 Worker 退出、Adapter proof、进程树和资源。Result、进程退出、Cleanup 与 Release 是独立事实。32 MiB canonical Result 和 v14 保持 [ADR-026](decisions/ADR-026-sqlite-result-contract.md)；COMMIT 不确定继续保留 poison，禁止猜测替代 Result 或重派。带不可验证 Spawn 证据的已取消 preclaim Attempt 可由 [ADR-064](decisions/ADR-064-executor-startability-and-user-release.md) 的用户显式授权释放；证据与 unverified 状态保留。

Release 一旦由持久 `released` Event 成立，后续 Wake `intent`、`queued`、
`submission_unknown`、`turn_started` 或 `web_notify` Observation 只推进
通知 revision，不撤销 Result、Cleanup 或 Release。Continue 以当前
Operation revision 做 CAS，但 Release 证明按“该 revision 及其之前存在
`released` Event”判断；原 Attempt、Result Digest、Cleanup/Release 证明和
全部 Wake Event 均保留。活动 Worker、Workspace 占用、Cleanup 未验证或
未知提交仍按原规则拒绝或先核对。

执行、交付与清理期限保持 [ADR-027](decisions/ADR-027-execution-and-cleanup-deadlines.md)。Manager 一次解析 Task/Host 默认执行预算，Worker/Adapter 使用相同快照；执行结束即停止执行 timer，Adapter 清理使用独立预算。迟到或缺失 Cleanup proof 不自动释放路径。

Recovery 由 SQLite 持久事实和当前 Host 共同协调，并可在 Host 存活期间重复执行。[ADR-036](decisions/ADR-036-host-native-interruption-requeue.md) 定义了没有 Result 的 running Attempt 的原子中断/重派门槛与合成实现：持久 Claim 的精确 Worker 已退出、recorded-tree claimant scan clean、Adapter Cleanup 证明完整、没有 Runtime 执行事件、无未回答交互，并且当前 Host 不触碰另一个 Host 的存活进程。当前生产 Adapter 不提供满足该门槛的独立 Cleanup Proof，因此真实 Result-less Attempt 默认停在 Operation/Workspace Hold，`zcode_status.execution_observation.state` 为 `interrupted_without_result`，恢复审计原因为 `adapter_cleanup_unverified`；只有 `testOnlyFakeAdapter` 合成测试能走到成功重派分支。不得用 OS PID/tree 扫描替代 Adapter resource facts，也不得把该合成分支宣传为已具备生产能力。显式 `zcode_cancel` 先复用持久 Claim、取消 intent、termination 与 CAS；身份不明或树不干净时默认保留占用，重复恢复不 Spawn、不重复 Release。Recovery Observation 不再按 Operation 固定 8 条截断：相同材料事实（身份状态、probe 原因、进程/树证据与 phase）重复出现时不新增 Revision/Event，返回既有持久 Evidence Digest；材料变化必须追加事件。超过 8 条 Cleanup/Cancel Hold 的消解以 count/root 承诺完整事件集合，旧 digest 数组仍兼容校验。既有 v14 的旧 Trigger 在只读 Recovery 中按精确 DDL 识别并继续读取；可写打开时才精确匹配并事务升级，不提升 Schema Version，只读 Recovery 不修改数据库。ADR-039 只允许无 Launch Receipt/Identity 的已取消历史 `launch_intent` 行政释放；`completed`/`failed`/`waiting_for_master`/`cancelled` 终态的 `cleanup_unverified` 走同一取消入口，还要求 exact identity exited、tree scan clean 与无 live PID，才能对缺失 Adapter closure 执行行政释放。新释放证据统一绑定 Result/Claim/Worker/Recovery，旧取消证明仅作历史读取兼容。live/unknown/term-fail/probe-fail/live-descendant 保持占用；唯一 Store 以 CAS 追加 `user_authorized_release_unverified`，不伪造 `cleanup_verified`，旧 Result/事件保留。`zcode_status`/Doctor 只读报告 queued 阻塞的 Task/Operation/phase/Workspace 与时长；所有写入仍经唯一 Authority，与 ADR-045 Executor Lease 兼容。

## 官方 Host、账户与清理

候选包只携带固定 `official-host-runtime.mjs`、官方签名 runtime-host helper、keyring native closure、许可和 BOM；不再携带 `app-server/zcode.cjs` 或 `app-server/provider/zcode-builtin.json`。生产支持路径的模型执行资产来自安装版同根资产；ADR-040/041 的精确 Manifest 验证自 ADR-054 起降为诊断信号，安全安装（OFFICIAL_INSTALLATION_SAFE）即可调用，未验证版本不阻断，已验证版本由 README 声明。Windows helper 是官方 Desktop `3.18.2.10443` 的 Authenticode 签名产物，来源、PE x64、大小与 SHA-256 固化在 BOM、Build Provenance 和运行时资源校验常量；Bridge 不编译或另建 Windows 原生实现。当前发布候选只在 Windows x64、Node `24.16.0` 上完成构建、加载、clean-install 与 ProcessManager smoke；其他 Node 24 patch level、平台和 Desktop 安装组合保持 `NOT_VERIFIED`，非 Windows x64 在构造官方 Host 路径时 fail closed。

官方 `ZCodeAgentProcessManager` 独占正常 Runtime/AppServer/helper 生命周期。Bridge 单独捕获官方 Runtime root PID 和精确 fingerprint，并在 close 后独立验证原 Worker identity 与 recorded process tree。官方 close status/stage、错误 code/name、manager residual process count、tree-scan status 与 Bridge Cleanup outcome 分开保存；有界 close 诊断进入 execution proof 和 SQLite `cleanup_verified` 事件，任意错误 message 不持久化。`dispose()` 或带错误的 `close()` resolved 不能单独生成 `cleanup_verified`。

正常 Cleanup 遵守 [ADR-034](decisions/ADR-034-normal-cleanup-worker-tree-proof.md)：关闭后复用 exact Worker identity、Worker-root recorded-tree scan、resource facts、Cleanup Digest 与 Release CAS。可接受证明包括“Adapter 未启动”和“原根已退出且 recorded-tree claimant scan clean”；任一证明都绑定 Operation/Attempt/generation/Claim，且最终仍需现有 Release CAS。Windows 异常终止继续遵守 [ADR-009](decisions/ADR-009-windows-identity-bound-tree-termination.md)。

官方 transport 显式使用 16 MiB raw UTF-8 stdout frame 上限。超限立即结束 pending RPC 和 turn，清理缓冲并 fail closed；LF 不计入预算、CR 计入预算、多字节 UTF-8 跨越 chunk 时按 raw bytes 计算。

Start Plan 每任务只执行一次权威 Billing GET，后续 Private Lease 复用同一 account/provider/model/credential 绑定的 verdict；凭据、Provider 或模型变化必须重新授权。Coding Plan 保持官方账户/API Key 路径，不经过 Start Plan Billing；ADR-040 只改变其模型执行 Runtime 来源。ADR-030 的 Private Lease/HANDLE/ACK、fail-closed 和不跨任务缓存继续有效。Start Plan 的官方模型 transport 在已安装 3.18.2 Bundle 中不需要 Coding Plan 的 Client Signing；该离线结论不等于真实 Start Plan E2E 或优惠已验证。

[ADR-037](decisions/ADR-037-official-zcode-authentication-reuse.md) 已接受且 Preview.7 保留该认证所有权：固定 ZCode 3.18.2 Host 统一拥有 credential format、keyring、OAuth refresh、登录主体、BigModel/Z.ai/`zai_cn` 映射和请求认证；Bridge 只消费一次任务所需的 Start Plan 投影，并继续拥有 Billing verdict、Private Lease 和全部任务生命周期。该 Host 的只读路径使用官方 cipher/repo，禁止 v1→v2 migration、credentials 写回、source marker 变更和新 key 创建；过期 JWT 的 refresh 才经过 ADR-033 事务。v1、v2:env、v2:os、损坏容器、未知格式和冷进程字节不变已有合成证据；Windows native keyring 隔离只读、真实 Coding Plan 和真实 Start Plan 核心功能路径已通过。真实 OAuth refresh/账户轮换仍未单独验收；历史 Start Plan 完整 E2E 因 Workspace 边界保持 `FAIL`。

[ADR-033](decisions/ADR-033-official-account-refresh-coordination.md) 的账户 refresh 协调已进入固定上游 patch：independent profile-scoped lock、获取锁后重读、网络请求前 dispatch marker、单次网络刷新、expected-snapshot/CAS 发布、timeout 与 stale-lock 恢复、不重试可能已消费的一次性 token、live runtime-header 更新，以及 A→B→A 和迟到响应隔离。该行为在合成矩阵中通过；真实 Coding Plan/Start Plan 模型请求已经执行，但真实 OAuth refresh/账户轮换与生产凭据 mutation 仍为 `NOT_RUN`。

## 安装、构建与升级

Fresh root 继续通过 stage SQLite、pending marker 和原子 publication 初始化；已有 v14 Authority、历史迁移记录、WAL、Recovery、Cleanup 和 Release 合同保持。当前支持声明为 `SQLite v14 ONLY`（ADR-043）。

Store 在任何可写 SQLite 句柄之前执行只读 `PRAGMA user_version` 预检。v13 返回稳定的 `unsupported_sqlite_schema` / `SQLite v14 ONLY`，数据库、WAL、SHM 和已存在的 v13→v14 pending Marker 均保持不变。生产 Lifecycle Gate 传播该错误，不尝试自动升级、离线复制、恢复或回滚，也不把未完成 Marker 当作 Fresh Install。未知 Schema、损坏库、未解释现场和 writer 活跃状态继续 fail closed。

发布包包含 Bridge、Worker、Thin Waiter、当前 v14 Schema、Administrative Recovery CLI、浏览器后端、Original E 图标资产，以及固定的 Official Host 模块与 helper 资源；不包含 v13 Schema、`upgrade-sqlite-v14` CLI 或第二套 AppServer Runtime。运行时会校验 `ARTIFACT_BOM.json` 与 shipped files；当前 3.18.2 候选构建仍把三项有序 patch 重放到固定源码 HEAD，并要求生成的树与实际源码树完全相同，随后记录 aggregate diff。发布包外，未知但安全的安装可按 ADR-054 直接调用，Manifest/指纹只作诊断；这不会改变发布 BOM、固定 Host patch 或支持矩阵。`@napi-rs/keyring` 与 `keyring-win32-x64-msvc` 的 6 个 native closure/license/metadata 文件通过精确 `.gitignore` 例外纳入包。官方签名 runtime host 由 Owner 确认再分发权利，纳入现有 LICENSE/NOTICE；Fresh Rebuild 不是发布门槛。插件两个 manifest 分别引用 `assets/logo.png` 与 `assets/icon.png`；validator 固定尺寸、字节数与 SHA-256，防止构建再替换为相似图案。

## 发布边界

`2.0.0-preview.18` 的 `package.json`、`package-lock.json`、插件 manifest、MCP server version、固定官方 Host、BOM、Runtime Events Schema、图标资产与 Administrative Recovery CLI 应由同一候选提交构建。Preview 支持声明限定为 Windows x64、Node.js `24.16.0` 和已安装的官方 ZCode Desktop `3.18.2.10443`。Preview.18 保持 v14 数据合同（`task_owner_bindings` 为同一 Authority 的加性扩展），并包含独立 Executor、Thin MCP、单页 Task Console、Host 请求触发的崩溃恢复、持久 Owner Binding、安装即生效的 Auto Wake（默认开启，可关闭）、Async Master Handoff 与验收驱动返工。合并到 `preview` 不等同于创建 Tag、GitHub Release 或 Stable 支持声明。

Preview.6 的固定源码树重建、ordered-patch replay、same-source-tree repeatability、BOM/native load、clean install、签名 helper ProcessManager smoke 和带数据的升级回滚为 `PASS`。Preview.7 的 Windows/Ubuntu Release Gate、SQLite 矩阵、生成物 Freshness、CI dispatch 边界与 MCP Events 分页为 `PASS`；真实模型流量不重复执行。跨机器复现仍为 `NOT_VERIFIED`，仅作为 Preview 阶段风险接受；完整 ZCode 产品资源图不进入 Bridge 支持范围。真实 Coding Plan 完整 E2E 和 Start Plan 核心功能路径已通过；历史 Start Plan 完整 E2E 因 Workspace 边界保持 `FAIL`，一般 Desktop Main 独立性、真实 OAuth refresh 与 3.18.0/3.18.1 实机安装组合仍未验证。3.18.0/3.18.1 是 `NOT_VERIFIED`，不是已证明不兼容。
