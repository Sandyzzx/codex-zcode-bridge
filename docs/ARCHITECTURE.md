# 当前架构

> Status: AUTHORITATIVE
> Last updated: 2026-11-13
> Last verified: 2026-11-13，核对了 ADR-036 的 Host 内中断重派发、v13→v14 升级后重派发、在线 Worker 退出恢复及 Cleanup/Interaction Hold 定向回归；真实账户、真实模型、生产数据库迁移与发布未运行。
> Verified against: `77990f3a840e7b1f3a75afc151c58ca2cef5f28a` + ADR-036 candidate changes；固定上游版本记录沿用本文件后续说明。

本文件描述当前源码候选。候选实现已默认切换到官方 Host 路径，但尚未发布；已发布渠道仍是 `2.0.0-preview.3`，候选版本号为 `2.0.0-preview.4`。公开合同继续以 [INTERFACES.md](INTERFACES.md) 为准，宿主和运行配置分别见 [SHARED_CORE.md](SHARED_CORE.md) 与 [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md)。

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

生产 Worker 的 `zcode_app_server` 模式按 [ADR-035](decisions/ADR-035-worker-platform-adapter-selection.md) 选择 Adapter。`win32/x64` 实例化 `OfficialHostAdapter`；Linux/macOS x64、arm64 的 direct Adapter 只保留 CI/合成覆盖；Windows 非 x64 与其他组合在构造 Adapter 前 fail closed。选择只读取 platform/arch，环境变量、TaskPackage、MCP 参数、持久配置和测试参数都不能改变正式 Worker 的 Adapter 类型。该 Adapter 继承现有 `ZCodeAppServerAdapter`，沿用 `CodingAgentAdapter` 的完成、取消、交互、结果、期限和 Cleanup 合同，没有新增公开 Adapter Mode、持久配置或平行 RuntimeAdapter。

## 生命周期与身份

TaskPackage 经 SQLite Manager 校验后创建 queued Attempt。Admission 事务绑定执行路径与 Capacity；同路径或重叠路径不会并行入场。派发前最终校验 source workspace 与 execution worktree，再持久化 Launch Intent。确定性 pre-Intent 拒绝可通过 queued Cancel CAS 终结 untouched reservation；Intent 后视为可能已 Spawn，不因缺 Receipt、句柄、timeout 或回调异常重派。

Worker 接收私有 Bootstrap，经精确 OS 进程身份、Launch/Claim 绑定后进入一次执行。永久 Claim 不重放。Spawner 持续消费 stderr，不在内存累积无人订阅的日志。Worker 只有私有 SQLite 握手入口；旧 `dataRoot taskId attempt` JSON 执行入口已删除。

合法 Result 经完整帧和绑定验证后先提交 SQLite，随后才验证 Worker 退出、Adapter proof、进程树和资源。Result、进程退出、Cleanup 与 Release 是独立事实。32 MiB canonical Result 和 v14 保持 [ADR-026](decisions/ADR-026-sqlite-result-contract.md)；COMMIT 不确定继续保留 poison/WRITER_INTENT，禁止猜测替代 Result 或重派。

执行、交付与清理期限保持 [ADR-027](decisions/ADR-027-execution-and-cleanup-deadlines.md)。Manager 一次解析 Task/Host 默认执行预算，Worker/Adapter 使用相同快照；执行结束即停止执行 timer，Adapter 清理使用独立预算。迟到或缺失 Cleanup proof 不自动释放路径。

Recovery 由 SQLite 持久事实和当前 Host 共同协调，并可在 Host 存活期间重复执行。[ADR-036](decisions/ADR-036-host-native-interruption-requeue.md) 允许对没有 Result 的 running Attempt 做一次自动中断重派发：只有持久 Claim 的精确 Worker 已退出、recorded-tree claimant scan clean、无未回答交互且当前 Host 不需要触碰另一个 Host 的存活进程时，Store 才在同一事务中保留旧 Attempt 历史、写入中断审计/Result/Cleanup/Release，并创建一个同 Task ID 的新 queued Attempt。自动链最多一次；alive、unknown、脏树、缺少 Adapter resource facts 或存在未解决交互都保留 Operation/Workspace Hold。显式 `zcode_cancel` 继续使用持久 Claim、取消 intent、verification 与 CAS；身份不明或树不干净时保留占用，重复恢复不 Spawn、不重复 Release。已有 Result 的取消或在线 Recovery 只恢复清理，不覆盖 Result。

## 官方 Host、账户与清理

固定制品入口、`official-host-runtime.mjs`、AppServer、builtin provider 配置和 Windows helper 均来自候选包内目录，不能由环境变量或持久设置重定向到用户 Desktop 安装。Adapter 在启动前验证文件身份并拒绝外来 AppServer 入口。当前固定制品只支持 Windows x64、Node `24.16.x`；其他平台在构造官方 Host 路径时 fail closed。

官方 `ZCodeAgentProcessManager` 独占正常 Runtime/AppServer/helper 生命周期。Bridge 单独捕获官方 Runtime root PID 和精确 fingerprint，并在 close 后独立验证原 Worker identity 与 recorded process tree。官方 close status/stage、错误 code/name、manager residual process count、tree-scan status 与 Bridge Cleanup outcome 分开保存；有界 close 诊断进入 execution proof 和 SQLite `cleanup_verified` 事件，任意错误 message 不持久化。`dispose()` 或带错误的 `close()` resolved 不能单独生成 `cleanup_verified`。

正常 Cleanup 遵守 [ADR-034](decisions/ADR-034-normal-cleanup-worker-tree-proof.md)：关闭后复用 exact Worker identity、Worker-root recorded-tree scan、resource facts、Cleanup Digest 与 Release CAS。可接受证明包括“Adapter 未启动”和“原根已退出且 recorded-tree claimant scan clean”；任一证明都绑定 Operation/Attempt/generation/Claim，且最终仍需现有 Release CAS。Windows 异常终止继续遵守 [ADR-009](decisions/ADR-009-windows-identity-bound-tree-termination.md)。

官方 transport 显式使用 16 MiB raw UTF-8 stdout frame 上限。超限立即结束 pending RPC 和 turn，清理缓冲并 fail closed；LF 不计入预算、CR 计入预算、多字节 UTF-8 跨越 chunk 时按 raw bytes 计算。

Start Plan 每任务只执行一次权威 Billing GET，后续 Private Lease 复用同一 account/provider/model/credential 绑定的 verdict；凭据、Provider 或模型变化必须重新授权。Coding Plan 保持官方账户/API Key 路径，不经过 Start Plan Billing。ADR-030 的 Private Lease/HANDLE/ACK、fail-closed 和不跨任务缓存继续有效。

[ADR-033](decisions/ADR-033-official-account-refresh-coordination.md) 的账户 refresh 协调已进入固定上游 patch：independent profile-scoped lock、获取锁后重读、网络请求前 dispatch marker、单次网络刷新、expected-snapshot/CAS 发布、timeout 与 stale-lock 恢复、不重试可能已消费的一次性 token、live runtime-header 更新，以及 A→B→A 和迟到响应隔离。该行为在合成矩阵中通过；真实 OAuth/account/model/Start Plan/Billing 仍为 `NOT_RUN`。

## 安装、构建与升级

Fresh root 继续通过 stage SQLite、pending marker 和原子 publication 初始化。生产 Lifecycle Gate 在持有同一 bootstrap lock 时，对已有 v13 Authority 自动执行一次 v13→v14 升级：复制到 stage、校验 v14、持久化 pending marker、将原 v13 改为 backup，再发布 v14 并清理 marker。中断的首次 rename 或发布后清理可由下一次启动恢复；occupied running Attempt、Recovery Hold 和既有事件保持不变。随插件提供的 `upgrade-sqlite-v14` 离线副本工具继续保留。

自动升级属于生产 Lifecycle 启动路径。直接调用 Store 打开 v13 时仍返回带离线升级指引的 `schema_upgrade_required`；不能据此声称所有 Store API 都会自动迁移。未知 schema、损坏库、未解释现场和 writer 活跃状态仍 fail closed。

候选包包含 Bridge、Worker、Thin Waiter、离线 v14 升级命令、v13/v14 Schema、浏览器后端，以及固定官方 Host 制品。运行时会校验 `ARTIFACT_BOM.json` 与 shipped files；构建来源、patch 顺序和哈希见研究目录的 [制品 BOM](research/zcode-official-host-integration-v1/SOURCE_ARTIFACT_BOM.md)。`@napi-rs/keyring` 与 `keyring-win32-x64-msvc` 的 6 个 native closure/license/metadata 文件已通过精确 `.gitignore` 例外纳入候选；detached clean checkout 已验证存在性、Host exports、native 加载和 BOM hash。

## 发布边界

`2.0.0-preview.4` 当前是源码候选：`package.json`、`package-lock.json`、插件 manifest 和 MCP server version 已统一为 preview.4，但没有发布 Tag。实现和定向测试通过不等于完整回归或生产发布通过。

固定制品在 Windows x64、Node `24.16.0` 的固定源码树重建、same-source-tree repeatability 和提交后 clean checkout 为 `PASS`；跨机器/空缓存复现、完整动态资源闭包、再分发许可审查和官方 Host 制品升级/回滚演练仍为 `PARTIAL` 或 `NOT_RUN`。真实账户、真实模型、Start Plan、Billing 和一般 Desktop Main 独立性未建立；当前候选独立 Astra 审查为 `APPROVED`，不改变这些 `NOT_RUN` 边界。
