# 当前架构

> Status: AUTHORITATIVE
> Last updated: 2026-11-07
> Last verified: 2026-11-07，核对 SQLite-only 入口、Core 退役范围及 R1–R5 调用链；运行验证见本轮报告。
> Verified against: a46137fe46b567271a7756be819361132625278c + ADR-029 本地候选（未发布）

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
                               ZCode app-server --stdio
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

合法 Result 经完整帧和绑定验证后先提交 SQLite；随后才验证 Worker 退出、Adapter proof、进程树和资源。Result、进程退出、Cleanup 和 Release 是独立事实。32 MiB canonical Result 和 v14 保持 [ADR-026](decisions/ADR-026-sqlite-result-contract.md)；COMMIT 不确定继续保留 poison/WRITER_INTENT，禁止猜测替代 Result 或重派。

执行、交付与清理期限保持 [ADR-027](decisions/ADR-027-execution-and-cleanup-deadlines.md)。Manager 一次解析 Task/Host 默认执行预算，Worker/Adapter 使用相同快照；执行结束即停止执行 timer，Adapter 清理使用独立预算。迟到或缺失 Cleanup proof 不自动释放路径。

启动 Recovery 只读核对事实。无 Result 的 running Operation 无论 alive/exited/unknown 都保留 Claim/路径/Capacity，不因启动观察写持久 Recovery Hold。显式 `zcode_cancel` 可读取持久 Claim 恢复取消：原身份已退出且 claimant scan clean、无未解决交互时，使用现有取消 intent、verification 与 CAS 提交 cancelled Result，再 Cleanup/Release。身份不明或树不干净时保留占用；重复恢复不 Spawn、不重复 Release。已有 Result 的取消仅恢复清理，不覆盖 Result。

Windows 终止继续使用 [ADR-009](decisions/ADR-009-windows-identity-bound-tree-termination.md)：同一原生句柄内验证世代并终止；已退出根仍需 recorded-tree claimant scan。PID 单独不能授权信号或 Release。未知 Hold 不自动清除；行政兜底保持 [ADR-018](decisions/ADR-018-administrative-abandonment-of-cleanup-incomplete-hold.md)。

## Adapter、观察与宿主

生产执行唯一使用 app-server Adapter；模型目录查询保留独立的短 RPC 生命周期。共享报告解析、输入 prompt、provider 配置、进程身份及浏览器后端，不将目录 RPC 与执行 RPC 强行合并。

可选 browser host 默认关闭，显式启用后使用独立 managed CDP profile；浏览器与 app-server 的清理共同决定 Cleanup proof。生产 bundle 随附 playwright 后端与资源，不依赖开发 checkout。身份/隐私与能力边界见 [ADR-007](decisions/ADR-007-browser-host-rpc.md)、[ADR-009](decisions/ADR-009-windows-identity-bound-tree-termination.md)。

Attention 与 Thin Waiter 共用 SQLite snapshot 和只读等待谓词。Attention 等待已并入唯一 Manager；普通事件不提前唤醒。Doctor 只使用绑定 SQLite Authority 诊断，不再扫描 JSON `.tasks`/恢复锁。默认 Events/Feedback 的既有生产投影保持，完整 Adapter event/usage 持久化改造属于延后的 R7，不能用旧 JSON 用例宣称当前 SQLite 已具备它。

`process-lock.ts` 与 `atomic-rename.ts` 仍用于模型设置和可选 Ledger；它们已不承担 Task 调度锁。公开的纯 observation/feedback/usage 函数及小型 DirectWorkspaceProvider 保留作为 Core 工具；它们不构成第二个执行运行时。

## 安装与构建

新装和旧 JSON 安装均从 Fresh SQLite Bootstrap 开始；旧 JSON 用户数据保持原样，运行时不读取或迁移它。现有 SQLite receipt、历史 `json_artifacts` 校验及 schema-v13.sql 不退役。v13→v14 只允许显式离线复制升级，工具随插件交付。

构建产物包含 Bridge、Worker、Thin Waiter、v14 升级命令、v13/v14 Schema 与浏览器后端。Core API 破坏按 Owner 已批准的 [ADR-029](decisions/ADR-029-legacy-runtime-retirement.md) 处理：未来主版本发布，当前仅本地候选，不更改 Marketplace MCP 工具/schema。
