# 当前架构

> Status: AUTHORITATIVE

> 2026-11-16 本地候选修订：[ADR-039](decisions/ADR-039-host-authorized-cancellation.md) 将取消授权与清理事实分离。queued + Launch Intent 无 Claim 时允许原子持久化取消并禁止迟到 Claim，未证明的进程/资源占用保留；Running 的 cleanup-only Hold 可经新鲜取消树证明追加消解记录，再继续原 CAS。此修复不增加 MCP 工具、Schema、重派或第二套恢复引擎。
> Last updated: 2026-11-18（ADR-040 安装版官方 AppServer 的 Coding Plan 候选接线）
> Last verified: 2026-11-18，核对 ADR-040 Resolver/Adapter/Worker 定向测试、构建后 MCP/Worker/SQLite 真实 Coding Plan E2E、Start Plan 离线审计与 Cost Lab；不含完整 CI 或发布验收。
> Verified against: `02cf2fa92c8235370fe7a883d4c5b30d93a8ab33` + candidate integration branch
> ADR-039 Last verified: 2026-11-16，仅取消接线及定向隔离测试；基线 `ec5f3e83d737df469f9ed54361d2aec46b4a15a8` + 本地候选。生产取消未重试。

本文件描述 Preview.7 的生产架构。Windows x64 已默认切换到官方 Host 路径，R7 Runtime Events/Usage 复用同一 SQLite Authority；Preview.7 保留 ZCode 3.18.2 Host、官方 Start Plan 认证投影与官方签名 runtime host，并应用 ADR-038 的最小整改。公开合同继续以 [INTERFACES.md](INTERFACES.md) 为准，宿主和运行配置分别见 [SHARED_CORE.md](SHARED_CORE.md) 与 [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md)。

2026-11-18 的集成候选在 Coding Plan 上应用 [ADR-040](decisions/ADR-040-installed-official-appserver-runtime.md)：通过精确 Manifest 校验后，使用用户已安装的官方 AppServer Bundle、同根 builtin Provider 配置和 runtime host。Start Plan、其他 Provider 与显式兼容 fallback 不继承该选择；未知安装版仍 fail closed，也不获得 `0.67` 声明。

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
                                        OfficialHostAdapter
                                               │
               fixed official-host-runtime.mjs -> ZCodeAgentProcessManager
                                               │
                         Windows runtime-host helper + official AppServer
                                               │
                                TaskResult -> SQLite v14
                                               │
                              independent Cleanup proof -> Release
```

`SqliteLifecycleMcpAuthority` 仍是唯一生产 Lifecycle Manager。`lifecycle-gate.ts` 负责 Bootstrap、进程身份、私有 Claim/Result/Interaction 管道、自动 Schema 升级和清理证明；SQLite Store 负责事务、Task/Attempt/Operation、Result digest、Capacity 和不可覆盖事件。

R7 在同一 Authority 内增加 additive `runtime_task_events`，不新增 Event Broker、第二状态机或 Companion IPC。Worker 通过一次性 fd14 发送规范化 Runtime observation；Manager 只从持久 Task/Attempt/Generation/Claim 派生身份绑定，Worker 不能自报权威身份。Store 以 Worker sequence 幂等、拒绝 stale Attempt，并把 Runtime row 映射到既有单调 public cursor。`zcode_events`、`zcode_feedback` 和 `buildTaskResult()` 从同一持久事实读取 Usage、Model Profile、Timing、Tool Activity 与 Feedback；Lifecycle Event 与 Runtime Event 仍分属不同表。

生产 Worker 的 `zcode_app_server` 模式按 [ADR-035](decisions/ADR-035-worker-platform-adapter-selection.md) 选择 Adapter。只有 `win32/x64` 实例化 `OfficialHostAdapter`；Linux、macOS、Windows 非 x64 与其他组合都在构造 Adapter 前以 `unsupported_worker_platform` fail closed。direct Adapter 类与 `testOnlyLegacyDirectAdapter` 只服务旧行为的合成回归，不是受支持平台的生产备用路径。选择只读取 platform/arch，环境变量、TaskPackage、MCP 参数、持久配置和测试参数都不能改变正式 Worker 的 Adapter 类型。`OfficialHostAdapter` 继承现有 `ZCodeAppServerAdapter`，沿用 `CodingAgentAdapter` 的完成、取消、交互、结果、期限和 Cleanup 合同，没有新增公开 Adapter Mode、持久配置或平行 RuntimeAdapter。

ADR-040 候选只对 `account:bigmodel-individual-coding-plan` 选择其子类 `OfficialAppServerWorkerAdapter`。该子类仍复用 Official Host 认证、ProcessManager 和上述生命周期，只把模型执行资产替换为通过 Desktop 版本、Bundle、builtin provider config、runtime host、Node 与平台校验的安装版 AppServer。该校验不是服务端权益证明；未知版本返回 `OFFICIAL_RUNTIME_UNVERIFIED`。

## 生命周期与身份

TaskPackage 经 SQLite Manager 校验后创建 queued Attempt。Admission 事务绑定执行路径与 Capacity；同路径或重叠路径不会并行入场。派发前最终校验 source workspace 与 execution worktree，再持久化 Launch Intent。确定性 pre-Intent 拒绝可通过 queued Cancel CAS 终结 untouched reservation；Intent 后视为可能已 Spawn，不因缺 Receipt、句柄、timeout 或回调异常重派。

Worker 接收私有 Bootstrap，经精确 OS 进程身份、Launch/Claim 绑定后进入一次执行。永久 Claim 不重放。Spawner 持续消费 stderr，不在内存累积无人订阅的日志。Worker 只有私有 SQLite 握手入口；旧 `dataRoot taskId attempt` JSON 执行入口已删除。

合法 Result 经完整帧和绑定验证后先提交 SQLite，随后才验证 Worker 退出、Adapter proof、进程树和资源。Result、进程退出、Cleanup 与 Release 是独立事实。32 MiB canonical Result 和 v14 保持 [ADR-026](decisions/ADR-026-sqlite-result-contract.md)；COMMIT 不确定继续保留 poison/WRITER_INTENT，禁止猜测替代 Result 或重派。

执行、交付与清理期限保持 [ADR-027](decisions/ADR-027-execution-and-cleanup-deadlines.md)。Manager 一次解析 Task/Host 默认执行预算，Worker/Adapter 使用相同快照；执行结束即停止执行 timer，Adapter 清理使用独立预算。迟到或缺失 Cleanup proof 不自动释放路径。

Recovery 由 SQLite 持久事实和当前 Host 共同协调，并可在 Host 存活期间重复执行。[ADR-036](decisions/ADR-036-host-native-interruption-requeue.md) 定义了没有 Result 的 running Attempt 的原子中断/重派门槛与合成实现：持久 Claim 的精确 Worker 已退出、recorded-tree claimant scan clean、Adapter Cleanup 证明完整、没有 Runtime 执行事件、无未回答交互，并且当前 Host 不触碰另一个 Host 的存活进程。当前生产 Adapter 不提供满足该门槛的独立 Cleanup Proof，因此真实 Result-less Attempt 默认停在 Operation/Workspace Hold，`zcode_status.execution_observation.state` 为 `interrupted_without_result`，恢复审计原因为 `adapter_cleanup_unverified`；只有 `testOnlyFakeAdapter` 合成测试能走到成功重派分支。不得用 OS PID/tree 扫描替代 Adapter resource facts，也不得把该合成分支宣传为已具备生产能力。显式 `zcode_cancel` 继续使用持久 Claim、取消 intent、verification 与 CAS；身份不明或树不干净时保留占用，重复恢复不 Spawn、不重复 Release。已有 Result 的取消或在线 Recovery 只恢复清理，不覆盖 Result。

## 官方 Host、账户与清理

非 Coding Plan 路径及显式兼容 fallback 继续使用候选包内固定制品：`official-host-runtime.mjs`、AppServer、builtin provider 配置和 Windows helper 不能由环境变量或持久设置重定向到用户 Desktop 安装。Coding Plan 候选路径则只接受 ADR-040 已验证的安装版同根资产。两条路径都在启动前验证文件身份并拒绝外来入口。Windows helper 是官方 Desktop `3.18.2.10443` 的 Authenticode 签名产物，来源、PE x64、大小与 SHA-256 固化在 BOM、Build Provenance 和运行时资源校验常量；Bridge 不编译或另建 Windows 原生实现。当前固定制品只在 Windows x64、Node `24.16.0` 上完成构建、加载、clean-install 与 ProcessManager smoke；其他 Node 24 patch level、平台和 Desktop 安装组合保持 `NOT_VERIFIED`，非 Windows x64 在构造官方 Host 路径时 fail closed。

官方 `ZCodeAgentProcessManager` 独占正常 Runtime/AppServer/helper 生命周期。Bridge 单独捕获官方 Runtime root PID 和精确 fingerprint，并在 close 后独立验证原 Worker identity 与 recorded process tree。官方 close status/stage、错误 code/name、manager residual process count、tree-scan status 与 Bridge Cleanup outcome 分开保存；有界 close 诊断进入 execution proof 和 SQLite `cleanup_verified` 事件，任意错误 message 不持久化。`dispose()` 或带错误的 `close()` resolved 不能单独生成 `cleanup_verified`。

正常 Cleanup 遵守 [ADR-034](decisions/ADR-034-normal-cleanup-worker-tree-proof.md)：关闭后复用 exact Worker identity、Worker-root recorded-tree scan、resource facts、Cleanup Digest 与 Release CAS。可接受证明包括“Adapter 未启动”和“原根已退出且 recorded-tree claimant scan clean”；任一证明都绑定 Operation/Attempt/generation/Claim，且最终仍需现有 Release CAS。Windows 异常终止继续遵守 [ADR-009](decisions/ADR-009-windows-identity-bound-tree-termination.md)。

官方 transport 显式使用 16 MiB raw UTF-8 stdout frame 上限。超限立即结束 pending RPC 和 turn，清理缓冲并 fail closed；LF 不计入预算、CR 计入预算、多字节 UTF-8 跨越 chunk 时按 raw bytes 计算。

Start Plan 每任务只执行一次权威 Billing GET，后续 Private Lease 复用同一 account/provider/model/credential 绑定的 verdict；凭据、Provider 或模型变化必须重新授权。Coding Plan 保持官方账户/API Key 路径，不经过 Start Plan Billing；ADR-040 只改变其模型执行 Runtime 来源。ADR-030 的 Private Lease/HANDLE/ACK、fail-closed 和不跨任务缓存继续有效。Start Plan 的官方模型 transport 在已安装 3.18.2 Bundle 中不需要 Coding Plan 的 Client Signing；该离线结论不等于真实 Start Plan E2E 或优惠已验证。

[ADR-037](decisions/ADR-037-official-zcode-authentication-reuse.md) 已接受且 Preview.7 保留该认证所有权：固定 ZCode 3.18.2 Host 统一拥有 credential format、keyring、OAuth refresh、登录主体、BigModel/Z.ai/`zai_cn` 映射和请求认证；Bridge 只消费一次任务所需的 Start Plan 投影，并继续拥有 Billing verdict、Private Lease 和全部任务生命周期。该 Host 的只读路径使用官方 cipher/repo，禁止 v1→v2 migration、credentials 写回、source marker 变更和新 key 创建；过期 JWT 的 refresh 才经过 ADR-033 事务。v1、v2:env、v2:os、损坏容器、未知格式和冷进程字节不变已有合成证据；Windows native keyring 隔离只读、真实 Coding Plan 和真实 Start Plan 核心功能路径已通过。真实 OAuth refresh/账户轮换仍未单独验收；历史 Start Plan 完整 E2E 因 Workspace 边界保持 `FAIL`。

[ADR-033](decisions/ADR-033-official-account-refresh-coordination.md) 的账户 refresh 协调已进入固定上游 patch：independent profile-scoped lock、获取锁后重读、网络请求前 dispatch marker、单次网络刷新、expected-snapshot/CAS 发布、timeout 与 stale-lock 恢复、不重试可能已消费的一次性 token、live runtime-header 更新，以及 A→B→A 和迟到响应隔离。该行为在合成矩阵中通过；真实 Coding Plan/Start Plan 模型请求已经执行，但真实 OAuth refresh/账户轮换与生产凭据 mutation 仍为 `NOT_RUN`。

## 安装、构建与升级

Fresh root 继续通过 stage SQLite、pending marker 和原子 publication 初始化。生产 Lifecycle Gate 在持有同一 bootstrap lock 时，对已有 v13 Authority 自动执行一次 v13→v14 升级：复制到 stage、校验 v14、持久化 pending marker、将原 v13 改为 backup，再发布 v14 并清理 marker。中断的首次 rename 或发布后清理可由下一次启动恢复；occupied running Attempt、Recovery Hold 和既有事件保持不变。随插件提供的 `upgrade-sqlite-v14` 离线副本工具继续保留。

自动升级属于生产 Lifecycle 启动路径。直接调用 Store 打开 v13 时仍返回带离线升级指引的 `schema_upgrade_required`；不能据此声称所有 Store API 都会自动迁移。未知 schema、损坏库、未解释现场和 writer 活跃状态仍 fail closed。

发布包包含 Bridge、Worker、Thin Waiter、离线 v14 升级命令、v13/v14 Schema、Administrative Recovery CLI、浏览器后端，以及固定官方 Host 制品。运行时会校验 `ARTIFACT_BOM.json` 与 shipped files；当前 3.18.2 候选构建还会把三项有序 patch 重放到固定源码 HEAD，并要求生成的树与实际源码树完全相同，随后记录 aggregate diff。`@napi-rs/keyring` 与 `keyring-win32-x64-msvc` 的 6 个 native closure/license/metadata 文件通过精确 `.gitignore` 例外纳入包。官方签名 runtime host 由 Owner 确认再分发权利，纳入现有 LICENSE/NOTICE；Fresh Rebuild 不是发布门槛。

## 发布边界

`2.0.0-preview.8` 的 `package.json`、`package-lock.json`、插件 manifest、MCP server version、固定官方 Host、BOM、Runtime Events Schema 与 Administrative Recovery CLI 应由同一 Tag 和 Release asset 提供。Preview 支持声明限定为 Windows x64、Node.js `24.16.0` 和已安装的官方 ZCode Desktop `3.18.2.10443`。

Preview.6 的固定源码树重建、ordered-patch replay、same-source-tree repeatability、BOM/native load、clean install、签名 helper ProcessManager smoke 和带数据的升级回滚为 `PASS`。Preview.7 的 Windows/Ubuntu Release Gate、SQLite 矩阵、生成物 Freshness、CI dispatch 边界与 MCP Events 分页为 `PASS`；真实模型流量不重复执行。跨机器复现仍为 `NOT_VERIFIED`，仅作为 Preview 阶段风险接受；完整 ZCode 产品资源图不进入 Bridge 支持范围。真实 Coding Plan 完整 E2E 和 Start Plan 核心功能路径已通过；历史 Start Plan 完整 E2E 因 Workspace 边界保持 `FAIL`，一般 Desktop Main 独立性、真实 OAuth refresh 与 3.18.0/3.18.1 实机安装组合仍未验证。3.18.0/3.18.1 是 `NOT_VERIFIED`，不是已证明不兼容。
