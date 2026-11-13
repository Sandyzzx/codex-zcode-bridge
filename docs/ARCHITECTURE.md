# 当前架构

> Status: AUTHORITATIVE
> Last updated: 2026-11-13
> Last verified: 2026-11-13，核对 Stable 1.7.1 SQLite-only 入口、Host 内重复 Recovery、Adapter Cleanup 证据边界与 R1–R5 调用链。
> Verified against: 295727320cab86b071c23ddddd6e29306fa29e7f + ADR-037 hotfix candidate

本文件描述当前实现。公开合同见 [INTERFACES.md](INTERFACES.md)，宿主构建见 [SHARED_CORE.md](SHARED_CORE.md)，配置和升级见 [ZCODE_RUNTIME.md](ZCODE_RUNTIME.md)。决策按主题从 [ADR 索引](decisions/README.md) 加载。

## 单一生产链

```text
Host startBridge → Fresh SQLite Bootstrap → SqliteLifecycleMcpAuthority
MCP tools                                  │ 排队 / 取消 / 只读恢复
                                           ▼
                               lifecycle-gate + SQLite Lifecycle Port
                                           │ Admission / Intent / CAS / 永久 Claim
                                           ▼
                           spawnClaimOnlyWorker → worker-main 私有管道
                                           │
                                 ZCodeAppServerAdapter
                                           │
                               ZCode app-server --stdio --surface desktop
                                           │
                                 TaskResult → SQLite v14
                                           │
                                Cleanup proof → Release
```

`SqliteLifecycleMcpAuthority` 是唯一生产 Lifecycle Manager。它调度已有 SQLite driver；Host/MCP 直接持有该对象，没有外层 JSON Manager 转发。`lifecycle-gate.ts` 负责 Bootstrap、进程身份、私有 Claim/Result/Interaction 管道与清理证明；SQLite Store 负责事务、Schema、Task/Attempt/Operation、Result digest、Capacity 和不可覆盖事件。

旧 JSON TaskStore、JSON Manager/Worker、调度/恢复 roster、JSON 迁移/归档执行器、CLI Adapter/envelope/loader、GitWorktreeProvider 已退役。canonical JSON、JSON-RPC、AgentReport、SQLite 的 `json_artifacts` 与历史 receipt 验证继续存在。模型设置、可选 Ledger 和日志的 JSON 文件各有独立职责，不是 Task Authority。

## 生命周期与身份

TaskPackage 经 SQLite Manager 校验后创建 queued Attempt。Admission 事务绑定执行路径与 Capacity；同路径/重叠路径不会并行入场。派发前最终校验 source workspace 和 execution worktree，再持久化 Launch Intent。确定性 pre-Intent 拒绝仍可通过 queued Cancel CAS 终结 untouched reservation；Intent 后视为可能已 Spawn，不因缺 Receipt、句柄、timeout 或回调异常重派。

Worker 接收私有 Bootstrap，经精确进程身份、Launch/Claim 绑定后进入一次执行。永久 Claim 不重放。Spawner 持续消费 stderr，不在内存累积无人订阅的日志。Worker 只有私有 SQLite 握手入口；旧 `dataRoot taskId attempt` JSON 执行入口已删除。

合法 Result 经完整帧和绑定验证后先提交 SQLite；随后才验证 Worker 退出、Adapter proof、进程树和资源。Result、进程退出、Cleanup 和 Release 是独立事实。普通 Cleanup 不能仅凭 root PID 退出或进程树 clean 合成 `cleanup_verified`；缺少可信 Adapter Cleanup Proof 时保留显式 Hold。32 MiB canonical Result 和 v14 保持 [ADR-026](decisions/ADR-026-sqlite-result-contract.md)；COMMIT 不确定继续保留 poison/WRITER_INTENT，禁止猜测替代 Result 或重派。

执行、交付与清理期限保持 [ADR-027](decisions/ADR-027-execution-and-cleanup-deadlines.md)。Manager 一次解析 Task/Host 默认执行预算，Worker/Adapter 使用相同快照；执行结束即停止执行 timer，Adapter 清理使用独立预算。迟到或缺失 Cleanup proof 不自动释放路径。

`recoverTasks()` 在 Host 生命周期内可重复调用；同一 Manager 的并发恢复共享一个进行中的操作，active run 延后处理，完成后下一次调用重新读取 SQLite。Recovery 本身只读核对事实，继续复用现有 Scheduler 与 Workspace Occupancy；一个 Operation 的 Hold 不阻塞无关执行路径。无 Result 的 running Operation 无论 alive/exited/unknown 都保留 Claim/路径/Capacity，Stable 生产路径不因缺少 R7 Runtime Events 自动重派。

Result 已提交时，Host 内 Recovery 只恢复 Cleanup/Release，不改写 Result 或创建 Attempt。生产路径只有在 Cleanup evidence 已验证或完整 Adapter Cleanup Proof 可验证时才 Release；OS 退出/claimant scan 只用于 Worker 树验证，不能替代 Adapter 资源事实。显式 `zcode_cancel` 可对终态 Result 的 `result_committed`、`cleanup_pending`、`cleanup_verified` 或 `cleanup_unverified` 发起 cleanup-only Recovery，经 SQLite CAS 后处理，证据不足时保持 Hold。Result-less 的取消仍按精确 Claim、身份终止、无未解决交互和 CAS 路径执行；重复调用不 Spawn、不重复 Release。

隔离 fake-Adapter 测试可通过原子 `interruptAndRequeue()` 验证一次自动续 Attempt：旧 Attempt、Result 中断事实、Cleanup/Release 与新 queued Attempt 同事务提交，且必须显式启用测试专用能力。该路径不由公共 MCP、TaskPackage 或 Host 配置暴露，也不构成生产副作用安全证明；无法证明可安全重试的生产任务标为 `MASTER_DECISION_REQUIRED`。

Windows 终止继续使用 [ADR-009](decisions/ADR-009-windows-identity-bound-tree-termination.md)：同一原生句柄内验证世代并终止；已退出根仍需 recorded-tree claimant scan。PID 单独不能授权信号或 Release。未知 Hold 不自动清除；行政兜底保持 [ADR-018](decisions/ADR-018-administrative-abandonment-of-cleanup-incomplete-hold.md)。

## Adapter、观察与宿主

生产执行唯一使用 app-server Adapter；模型目录查询保留独立的短 RPC 生命周期。共享报告解析、输入 prompt、provider 配置、进程身份及浏览器后端，不将目录 RPC 与执行 RPC 强行合并。

任务 Adapter 与模型目录探测共用 `buildZCodeAppServerLaunch()`：启动参数固定为 `app-server --stdio --surface desktop`，并从安装的 Desktop `app.asar` 只读解析 `ZCODE_APP_VERSION` 与 `ZCODE_BUILD_COMMIT_ID`。合法元数据注入子进程环境；元数据缺失仅省略身份变量，损坏、格式非法或版本冲突按 `provider_config_invalid` fail-closed。Bridge 不伪造 Desktop 身份，也不复制官方 HTTP 请求构造。

模型选择在 Task 创建时解析一次并持久化完整 provider/model。显式 `<ModelId>-StartPlan` 或 Start Plan Provider 强制走 Start Plan；普通模型按 `ZCODE_BRIDGE_PREFER_STARTPLAN` 与非权威 Billing verdict 选择 Start Plan 或 Coding Plan，不跨模型替换。Start Plan 每任务只执行一次权威 Billing GET，后续 Private Lease 复用同一 account/provider/model/credential 绑定的 verdict；凭据、Provider 或模型变化必须重新授权。Coding Plan 保持官方账户/API Key 路径，不经过 Start Plan Billing。

可选 browser host 默认关闭，显式启用后使用独立 managed CDP profile；浏览器与 app-server 的清理共同决定 Cleanup proof。生产 bundle 随附 playwright 后端与资源，不依赖开发 checkout。身份/隐私与能力边界见 [ADR-007](decisions/ADR-007-browser-host-rpc.md)、[ADR-009](decisions/ADR-009-windows-identity-bound-tree-termination.md)。

Attention 与 Thin Waiter 共用 SQLite snapshot 和只读等待谓词。Attention 等待已并入唯一 Manager；普通事件不提前唤醒。Doctor 只使用绑定 SQLite Authority 诊断，不再扫描 JSON `.tasks`/恢复锁。默认 Events/Feedback 的既有生产投影保持，完整 Adapter event/usage 持久化改造属于延后的 R7，不能用旧 JSON 用例宣称当前 SQLite 已具备它。

`process-lock.ts` 与 `atomic-rename.ts` 仍用于模型设置和可选 Ledger；它们已不承担 Task 调度锁。公开的纯 observation/feedback/usage 函数及小型 DirectWorkspaceProvider 保留作为 Core 工具；它们不构成第二个执行运行时。

## 安装与构建

新装和旧 JSON 安装均从 Fresh SQLite Bootstrap 开始；旧 JSON 用户数据保持原样，运行时不读取或迁移它。现有 SQLite receipt、历史 `json_artifacts` 校验、schema-v13.sql 与显式离线升级工具不退役。启动时发现有效 v13 Authority 后，Bridge 在既有 bootstrap 锁内执行同一副本升级，保留 v13 备份、验证已发布 v14 后清除升级 marker；不启动 Worker、不释放 Hold，损坏或非 v13 数据库继续 fail-closed。

构建产物包含 Bridge、Worker、Thin Waiter、v14 升级命令、v13/v14 Schema 与浏览器后端。Core API 破坏按 Owner 已批准的 [ADR-029](decisions/ADR-029-legacy-runtime-retirement.md) 随当前稳定版本线交付；当前 Stable 基线为 1.7.1，Host Recovery hotfix 仍需独立合并/发布授权。该退役不更改 Marketplace MCP 工具/schema。
