# 决策路由 / Decisions

> Status: AUTHORITATIVE（仅指本索引）
> Last updated: 2026-11-11
> Last verified: 2026-11-11，既有适用范围沿用 52015d12 核对；本轮新增 ADR-032 Accepted 目标及两项 Proposed 草案路由，不变更生产合同。
> Verified against: 372e90622772b070357a278f1da3dea58fa42dee

先读当前 [架构](../ARCHITECTURE.md)/[接口](../INTERFACES.md)，只在需要解释取舍时加载对应决策。文件保持原路径和历史正文；Partially superseded 的标注优先于历史段落，不得拿旧 JSON 实现恢复当前合同。

## 当前有效 / Active

| 主题 | 决策 | 范围 |
|---|---|---|
| 执行链 | [001](ADR-001-appserver-as-production-execution-path.md)、[003](ADR-003-execution-directory-prepared-by-host.md) | app-server 唯一路径（Desktop surface/身份由当前架构文档补充）；Host 准备执行目录 |
| Authority/观察 | [004](ADR-004-separate-control-state-and-observation.md)、[016 v3](ADR-016-stop-the-world-json-to-sqlite-cutover.md) | SQLite-only Fresh Bootstrap；补充观察不是状态 Authority |
| Provider/报告 | [006](ADR-006-provider-quota-failure-diagnostics.md) | 明确额度耗尽分类；不自动重试 |
| Browser | [007](ADR-007-browser-host-rpc.md) | 可选独立 managed CDP；默认关闭 |
| Windows 身份 | [009](ADR-009-windows-identity-bound-tree-termination.md)、[023](ADR-023-completion-window-cleanup-prewarm.md) | 原生句柄/claimant proof；空 helper 预热 |
| Master 委派 | [010](ADR-010-whole-task-delegation.md)、[015](ADR-015-master-skill-authorization-and-progressive-loading.md) | whole_task 默认、授权和按需加载 |
| Workspace | [017](ADR-017-single-user-trusted-local-workspace-admission.md) | 单用户本机 Admission；无需项目白名单 |
| Recovery | [018](ADR-018-administrative-abandonment-of-cleanup-incomplete-hold.md)、[024](ADR-024-scoped-sqlite-hold-and-local-cleanup-recovery.md) | 行政兜底与 Operation scoped Hold/清理恢复；R5 补足显式取消 |
| 配置/诊断 | [021](ADR-021-zcode-path-discovery.md)、[022](ADR-022-authority-bound-doctor.md) | ZCode 路径发现；诊断绑定 SQLite |
| Attention | [025](ADR-025-sqlite-attention-unified-waiting.md) | SQLite snapshot、被动等待与 Thin Waiter |
| Result | [026](ADR-026-sqlite-result-contract.md) | 32 MiB、256 KiB envelope、v14 与显式离线升级 |
| 期限 | [027](ADR-027-execution-and-cleanup-deadlines.md) | Owner 已接受 R3；执行/交付/清理分工 |
| Launch | [028](ADR-028-pre-intent-workspace-refusal.md) | Owner 已接受 R4；Intent 前拒绝与 Intent 后 unknown |
| 退役/Core | [029](ADR-029-legacy-runtime-retirement.md) | Owner 已批准内部及公共 Core 退役；未来主版本发布 |
| Start Plan Provider | [030](ADR-030-start-plan-provider-preflight.md) | 每任务一次权威 Billing verdict、Provider 注册门及失败清理边界；不得从旧缓存推断权益 |
| Model Routing | [031](ADR-031-model-routing-v1.md) | Start Plan 别名、`prefer_startplan` 自动选路与动态凭据发现；路由不替代实时授权 |
| 下一阶段目标（未实施） | [032](ADR-032-existing-worker-official-host-integration.md) | Accepted：现有 Worker 内官方 Host、内部 Binding、官方 ProcessManager；无独立 Companion/新 IPC/业务库；保留现行并发及生命周期合同 |

## 未决草案 / Proposed only

[官方 Runtime Cleanup Proof 与账户所有权草案](../research/zcode-companion-owner-architecture-convergence-2026-11-11/ADR_PROPOSALS.md) 保持研究目录中的两个 Proposed 草案，不分配正式 Accepted 编号。ADR-032 不批准 Job 证据替代、账户/权益来源切换或删除 ADR-030；正式生产合同继续生效。

[POC-1 进入条件](../research/zcode-official-host-architecture-freeze-2026-11-11/POC_1_ENTRY.md) 是后续计划，需要单独授权。

后续隔离 POC 已执行到组件门禁，但生产接线未完成；same-profile 双 Worker refresh、raw frame guard 和 Cleanup Proof 仍是阻断项。当前能力状态见 [Official Host Integration v1](../research/zcode-official-host-integration-v1/IMPLEMENTATION_SUMMARY.md)，不能把组件 PASS 当作 ADR-032 实施完成。

## 部分被替代 / Partially superseded

| 决策 | 仍生效 | 已退役/替代 |
|---|---|---|
| [002](ADR-002-manager-owns-task-lifecycle.md) | Manager 管生命周期、Claim 防重放 | JSON Manager/Store/Worker 具体实现被 016/024/029 替代 |
| [005](ADR-005-long-session-reliability.md) | 严格报告、显式报告修复、模型身份解析 | 旧 JSON pump/heartbeat/checkpoint、Task 调度锁退休；Windows 清理以 009、期限以 027 为准 |
| [008](ADR-008-session-frames-and-large-interactions.md) | app-server 帧边界、输入资源有界原则 | JSON full_request 文件/64KB 事件预览协议退役；SQLite request/reply/ACK 以当前接口为准 |
| ADR-011（历史编号；原文未纳入当前仓库） | Adapter 受理事实/根因/隐私边界 | JSON failure-facts 文件与 state.lock 所有权不再是生产机制；未扩展到 R7 |
| [019](ADR-019-local-trust-and-recovery-fence.md) | 单用户本机信任及 yolo profile | Recovery 围栏由 024/R5 替代；JSON 双链描述由 029 替代 |

016 的 v1/v2 归档/导入方案已被同文件 v3 取代；保留旧 receipt/schema 读取不等于保留迁移执行器。

## 历史追溯 / Historical only

[2026-09-27 路线图](roadmap-decisions-2026-09-27.md) 与 [2026-10-03 修复计划](reliability-repair-plan-v2-2026-10-03.md) 仅供追溯，当前事实已分流到架构/接口和专题 ADR。不再作为 Master 默认阅读前置。

ADR-009/026/027/028 原有关键合同保留。未因数量多而合并决策；完整/部分/历史分类降低默认加载范围。新决策只记录真实合同取舍，不重复源码和测试日志。

核验发现：旧索引链接的 ADR-011 文件在集成基线 Git tree 中并不存在，本轮不伪造已批准原文。Adapter 诊断当前事实由源码/接口与保留的分类回归证明；需要历史原文时由 Owner 提供外部归档。
