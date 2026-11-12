# 决策路由 / Decisions

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-11-12
> Last verified: 2026-11-12，核对 ADR-032–035 的候选实现状态、ADR-030 保持不变，以及同步最新 `origin/preview` 后的完整回归。
> Verified against: `8e8966d5ec7539a2d8575fc748871a9641fe0a2d`（tree `4e9b0a005e4802cb4247582dbf1b7369498cb966`）+ documentation changes

先读当前 [架构](../ARCHITECTURE.md)/[接口](../INTERFACES.md)，只在需要解释取舍时加载对应决策。文件保持原路径和历史正文；Partially superseded 的标注优先于历史段落。

## 当前有效 / Active

| 主题 | 决策 | 范围 |
|---|---|---|
| 执行链 | [001](ADR-001-appserver-as-production-execution-path.md)、[003](ADR-003-execution-directory-prepared-by-host.md) | AppServer 唯一执行路径；Host 准备执行目录 |
| Authority/观察 | [004](ADR-004-separate-control-state-and-observation.md)、[016 v3](ADR-016-stop-the-world-json-to-sqlite-cutover.md) | SQLite-only Fresh Bootstrap；观察不是状态 Authority |
| Provider/报告 | [006](ADR-006-provider-quota-failure-diagnostics.md) | 明确额度耗尽分类；不自动重试 |
| Browser | [007](ADR-007-browser-host-rpc.md) | 可选独立 managed CDP；默认关闭 |
| Windows 身份 | [009](ADR-009-windows-identity-bound-tree-termination.md)、[023](ADR-023-completion-window-cleanup-prewarm.md) | 原生句柄与 claimant proof；空 helper 预热 |
| Master 委派 | [010](ADR-010-whole-task-delegation.md)、[015](ADR-015-master-skill-authorization-and-progressive-loading.md) | whole_task 默认、授权和按需加载 |
| Workspace | [017](ADR-017-single-user-trusted-local-workspace-admission.md) | 单用户本机 Admission；无需项目白名单 |
| Recovery | [018](ADR-018-administrative-abandonment-of-cleanup-incomplete-hold.md)、[024](ADR-024-scoped-sqlite-hold-and-local-cleanup-recovery.md) | 行政兜底与 Operation-scoped Hold/清理恢复 |
| 配置/诊断 | [021](ADR-021-zcode-path-discovery.md)、[022](ADR-022-authority-bound-doctor.md) | ZCode 路径发现；诊断绑定 SQLite |
| Attention | [025](ADR-025-sqlite-attention-unified-waiting.md) | SQLite snapshot、被动等待与 Thin Waiter |
| Result | [026](ADR-026-sqlite-result-contract.md) | 32 MiB Result、256 KiB envelope、v14；正文早于 Preview.4 自动升级实现并保持原文 |
| 期限 | [027](ADR-027-execution-and-cleanup-deadlines.md) | 执行、交付、清理分工 |
| Launch | [028](ADR-028-pre-intent-workspace-refusal.md) | Intent 前拒绝与 Intent 后 unknown |
| 退役/Core | [029](ADR-029-legacy-runtime-retirement.md) | 内部及公共 Core 退役；未来主版本发布 |
| Start Plan Provider | [030](ADR-030-start-plan-provider-preflight.md) | 每任务一次权威 Billing verdict、Provider 注册门及失败清理边界；正文保持不变 |
| Model Routing | [031](ADR-031-model-routing-v1.md) | Start Plan 别名、`prefer_startplan` 自动选路与动态凭据发现 |
| 官方 Host | [032](ADR-032-existing-worker-official-host-integration.md) | Accepted 目标；已接线到 Preview.4 源码候选，尚未发布或完成完整验收 |
| 账户 Refresh | [033](ADR-033-official-account-refresh-coordination.md) | Accepted；profile-scoped lock、lock-time reread、一次远端 refresh、CAS；无 Broker |
| 正常 Cleanup | [034](ADR-034-normal-cleanup-worker-tree-proof.md) | Accepted；官方 close 后复用 exact Worker identity、recorded-tree、resource facts、Digest 与 Release CAS |
| 平台启用 | [035](ADR-035-worker-platform-adapter-selection.md) | Accepted；Windows x64 启用 Official Host，Linux/macOS direct 仅 CI/合成覆盖，其余 fail closed |

ADR-032、ADR-033、ADR-034 和 ADR-035 的正文记录决定作出时的状态，其中 ADR-032 的“生产实现未完成”等表述没有在本次回写。当前实现状态以 [ARCHITECTURE](../ARCHITECTURE.md) 和 [Implementation Summary](../research/zcode-official-host-integration-v1/IMPLEMENTATION_SUMMARY.md) 为准：候选 Windows x64 Worker 默认使用 `OfficialHostAdapter`；Linux/macOS direct 仅保留 CI/合成覆盖；同步最新 Preview 后完整回归通过。缺少真实账户、官方制品升级/回滚和当前候选独立审查时，不能升级为已发布或真实服务事实。

Preview.4 生产 Lifecycle Gate 会在持有 bootstrap lock 时自动升级已有 SQLite v13→v14。ADR-026 正文中的“生产 Migration 不自动授权”仍是其历史决策背景；候选已实现受限的启动升级，直接 Store API 仍对不同 Schema 或未知现场 fail closed。

## 历史研究草案 / Superseded direction

[官方 Runtime Cleanup Proof 与账户所有权草案](../research/zcode-companion-owner-architecture-convergence-2026-11-11/ADR_PROPOSALS.md) 保留为历史正文。账户 refresh 与正常 Cleanup 已分别由 ADR-033、ADR-034 替代；旧草案中的 Credential Broker、持久 Job receipt、verifier service 与 schema 方向不进入当前实现。ADR-030 继续是 Start Plan 权益权威。

[POC-1 进入条件](../research/zcode-official-host-architecture-freeze-2026-11-11/POC_1_ENTRY.md) 是已执行的历史研究计划。后续实现证据见 [Official Host Integration v1](../research/zcode-official-host-integration-v1/IMPLEMENTATION_SUMMARY.md)。

## 部分被替代 / Partially superseded

| 决策 | 仍生效 | 已退役或替代 |
|---|---|---|
| [002](ADR-002-manager-owns-task-lifecycle.md) | Manager 管生命周期、Claim 防重放 | JSON Manager/Store/Worker 具体实现由 016/024/029 替代 |
| [005](ADR-005-long-session-reliability.md) | 严格报告、显式报告修复、模型身份解析 | 旧 JSON pump/heartbeat/checkpoint、Task 调度锁退役；Windows 清理以 009、期限以 027 为准 |
| [008](ADR-008-session-frames-and-large-interactions.md) | AppServer 帧边界、输入资源有界原则 | JSON full_request/64 KiB 事件预览协议退役；SQLite request/reply/ACK 以当前接口为准 |
| ADR-011（历史编号；原文未纳入本仓库） | Adapter 受理事实、根因和隐私边界 | JSON failure-facts 与 state.lock 所有权不再是生产机制 |
| [019](ADR-019-local-trust-and-recovery-fence.md) | 单用户本机信任与 yolo profile | Recovery 围栏由 024 替代；JSON 双链描述由 029 替代 |

016 的 v1/v2 归档/导入方案已被同文件 v3 取代；保留旧 receipt/schema 读取不等于恢复迁移执行器。

## 历史追溯 / Historical only

[2026-09-27 路线图](roadmap-decisions-2026-09-27.md) 与 [2026-10-03 修复计划](reliability-repair-plan-v2-2026-10-03.md) 仅供追溯，当前事实已分流到架构、接口和专题 ADR。

ADR-011 原文在集成基线中不存在，本索引不伪造其已批准文本。需要历史原文时由 Owner 提供外部归档。
