# Async Execution Architecture Review

> Status: IMPLEMENTED — PR 2–6 CANDIDATE（architecture accepted；release blocked）
> Date: 2026-11-22
> Review baseline: `origin/preview` `ac1e8396f25a1a1d3ff373def84726d28c1f4193` + PR 2–6 candidate `c75c34330287266702cab5949662bf897b74ed5a`

## Verdict

`OWNER APPROVED`：Owner 已批准总体架构和 ADR-045。PR 2 candidate 已实现
Lifetime Lease、精确 owner 仲裁、Idle-only Shutdown、IPC、Thin MCP control
transport，以及跨进程 fake Worker 的 Result/Cleanup/Release 验证。PR 2.5
candidate 进一步把 shipped MCP 入口收敛为单一 Thin MCP，并把生产 Authority
composition 固定在 Executor；确定性四层 E2E 与类型/边界检查通过。PR 3–6
candidate 已加入 Control-only CLI、loopback Web、fail-closed Wake 与 Async
Master Handoff，并通过 1060 项本地完整回归（1058 pass / 0 fail / 2 skip）
与 4/4 注册压力矩阵。当前结论仍为 `PARTIAL / BLOCKED`：真实 Codex Desktop
关闭、严格 Wake C/D、真实 Official Runtime 和真实模型 Skill 遵循率仍未运行；
可以提交统一 RC PR 评审，但不得合入 Preview 或发布。

## Findings

| # | 严重度 | 结论 |
|---|---|---|
| 1 | High | 已修正：Executor 存活期由 Authority Root lifetime lease + 精确 PID/start fingerprint + heartbeat 仲裁；Bootstrap lock、Admission CAS 和 pipe 存在性均不是所有权证据。 |
| 2 | High | 独立 Executor 只解决“Manager 随 Codex 消失”的第一层。若 Host/OS 同时终止 Manager 和 Worker，仍需独立持久化交接设计；PR 2 不得宣称已解决 `RESULT_DURABILITY=FAIL`。 |
| 3 | High | MCP 请求取消与 Task Cancel 必须在 IPC 错误码中显式区分；否则 Stop/断线会被误映射为取消。 |
| 4 | High | 最终修订已明确资源释放顺序：Lease 覆盖整个可写 Store 生命周期，先关 Store 再写 released Lease；关闭或释放失败保持 `EXECUTOR_LEASE_RELEASE_UNKNOWN`，不得创建第二 Authority。 |
| 5 | High | `EXECUTOR_SHUTDOWN_NOT_IDLE` 是可恢复状态，必须撤销 Shutdown fence 并恢复 Admission/任务控制，不是永久停机。 |
| 6 | High | PR 2 必须加入新旧 Host 混用测试：旧 MCP Manager 精确存活时新 Executor fail closed；手动 Lease Clear 不得删除活动 Owner。 |
| 7 | Medium | CLI/Web 需要只读列表投影；必须定义分页、脱敏和事件上限，避免为了 UI 引入全库扫描或第二 Event Broker。 |
| 8 | Medium | Web 可复用 Cost Lab 的 loopback/CSRF 经验，但不得复用其业务耦合；也不应新增任意 Shell/文件/SQLite 接口。 |
| 9 | Medium | Wake 合同正确区分 `QUEUED / TURN_STARTED / TURN_COMPLETED / DESKTOP_VISIBLE`；正式版必须保留严格 C/D 独立验收。 |
| 10 | Medium | `--resume` 的 warning 与 exit 0 不能证明恢复能力；默认 Queue 不应携带 `--resume`。 |
| 11 | Low | ADR-045 与现有 ADR-002/025/026/027/036/039/043 兼容；未改变公共 MCP 工具面。 |
| 12 | High | PR 2.5 已修正：生产 Authority、Start Plan auth、动态 model routing、Worker diagnostics 和 Doctor 只在 Executor production composition 组装；Thin MCP 不保留并行 Authority 路径。 |
| 13 | High | 已修正：Thin MCP 的四个模型工具和完整 Doctor 经 Executor IPC 代理；控制模式只允许返回 `EXECUTOR_UNAVAILABLE`，不得伪造 `MODEL_SETTINGS_UNAVAILABLE`。 |
| 14 | High | 已修正：生产 Executor CLI 不接受 `--test-only-fake-adapter` 或任意 `--worker-entry`；测试入口只存在于显式 test harness。 |
| 15 | Medium | 已修正：开发期延期 `FULL_SUITE` 仍执行直接/域安全测试；CI Integration 使用 `--safe-tests-only`，延期不得显示为完整 PASS。 |
| 16 | Medium | PR 6 已把 Task Scope 与 Handoff Mechanism 分离；可靠受理后允许结束 Turn/停止轮询，但 Wake 只触发身份核对与独立验收，Pending Interaction 不新增自动审批路径。 |

## PR 2 / PR 2.5 Evidence Update

| 验收项 | 状态 | 当前证据 |
|---|---|---|
| Lifetime Lease 与精确 PID/start fingerprint | `PASS` | 单进程/双启动/legacy Host 互斥、heartbeat、release ordering、malformed lease、manual clear 活动 Owner 负例 |
| Idle-only Shutdown 与拒绝后恢复 | `PASS` | 活动任务拒绝、`EXECUTOR_SHUTDOWN_NOT_IDLE` 后继续接受 Create/健康检查；metadata 默认启动/过期/PID reuse 路径覆盖 |
| IPC 错误与断连语义 | `PASS` | `REQUEST_CANCELLED`、`TASK_CANCEL_REQUESTED`、`SUBMISSION_UNKNOWN`、`EXECUTOR_UNAVAILABLE`；in-flight close 与 lost response 覆盖 |
| 32 MiB Result IPC | `PASS` | 完整 32 MiB Result 通过 33 MiB frame 回读 |
| Thin MCP transport | `PASS` | shipped MCP 只构造 `ExecutorControlClient`/Remote adapters；`in_process` 已删除；MCP stdio 关闭不取消已受理 Task；reconnect 读到原 Result |
| Four-layer convergence | `PASS` | Thin MCP → Executor → Worker → Official Adapter fake-host E2E；静态边界禁止 MCP 导入 Manager/Store/Worker/Adapter/Executor 内部 |
| MCP schema parity | `PASS` | 13 个公共工具名和冻结 schema snapshot 未变 |
| 跨进程 fake Worker durability | `PASS` | 原 Attempt `result_committed` 一次、Cleanup pending/verified、Operation `released`、Result digest 非空 |
| 真实 Codex Desktop 关闭 E2E | `BLOCKED` | 未关闭 Owner 当前 Desktop，未声称进程存活或 Result durability 通过 |
| 真实 Official Runtime E2E | `NOT_RUN` | 无新的付费模型授权；合成 fake adapter 不能替代 |

## Implementation Corrections and Current Status

1. `PASS`：PR 2 candidate 已按架构文档实现 lifetime lease 仲裁；Bootstrap lock、Admission CAS 或命名管道存在性没有被当作替代所有权证据。
2. `PASS`：Executor IPC 错误表包含 `REQUEST_CANCELLED`、`TASK_CANCEL_REQUESTED`、`SUBMISSION_UNKNOWN`、`EXECUTOR_UNAVAILABLE`，并覆盖 in-flight close。
3. `PASS`：Executor 正常退出使用 Idle-only Shutdown；活动/排队/清理未知状态返回 `EXECUTOR_SHUTDOWN_NOT_IDLE`，不调用旧 Host 主动取消语义。
4. `PASS`：`EXECUTOR_SHUTDOWN_NOT_IDLE` 后恢复 Admission 和任务控制；确定性测试验证后续 Create/健康检查。
5. `PASS`：Lease 释放晚于 Store 关闭；Store/lease 释放失败保持 fail closed。
6. `PASS`：新旧 Host 混用、手动 Lease Clear 活动 Owner 负例已加入测试。历史 pre-Lease Host 没有可读 Lease，必须人工停机；显式 transition acknowledgement 不是热混用安全证明。
7. `PASS`：PR 2.5 的 shipped `bridge.mjs` 已收窄为 Thin MCP；测试 harness 的 legacy lifecycle Host 不进入生产包。
8. `PASS — CANDIDATE`：Task CLI 使用 bounded list/Result 预算；Web/CLI 只通过同一 Executor Control 读取/控制，不打开可写 SQLite。
9. `PASS — CANDIDATE`：Wake Intent/Delivery 使用现有 SQLite v14 released Operation 的 bounded `observation_recorded` evidence，不新增 schema 或第二持久化权威。
10. `PASS — SYNTHETIC`：A 实验模型失控负例已进入 Wake policy；未确认 Thread 当前 model/provider/effort/budget 时只允许 Web Notify。
11. `BLOCKED`：真实 Desktop 关闭后的进程存活和 Result durability 仍需真实 Host E2E；受控 EOF、detached spawn、fake Worker 与完整本地回归不能替代。

## PR #120 / PR 2.5 Remediation Record

| 项目 | 状态 | 当前证据 |
|---|---|---|
| Production composition parity | `PASS` | `src/executor/production-composition.ts` 是唯一生产 Authority composition；静态合同测试覆盖 Start Plan factory、动态 persisted routing、Worker diagnostics、Doctor 和 model settings |
| Executor-owned model/Doctor IPC | `PASS` | 模型 list/get/set/clear 与完整 Doctor 经 control server/client；Thin MCP reconnect 后仍读取同一持久默认模型 |
| Production CLI test-seam rejection | `PASS` | Fake Adapter 与任意 Worker entry 在 Lease 获取前拒绝 |
| Startup failure rollback | `PASS` | pipe 启动失败仅在 Store idle close 与 exact Lease 证明后释放；Authority 启动失败保留 Lease 并阻止第二 Owner |
| Development gate | `PASS` | 延期 FULL 运行直接/域安全测试；Integration 安全集合 fail closed，完整 Release Gate 仍延期 |
| Complete local release matrix | `PASS — LOCAL` | `c75c3433`：1060 tests、1058 pass、0 fail、2 skip；注册压力 4/4；生成物与插件校验通过。GitHub Release Gate 另列 |
| GitHub complete release matrix | `NOT_RUN` | Pushed RC 必须通过 Ubuntu/Windows/Stress Required Checks 后才能合并 |

## PR 3–6 Candidate Update

| 项目 | 状态 | 当前证据 |
|---|---|---|
| Task CLI control-only boundary | `PASS — CANDIDATE` | `task-cli.test.ts`；共享 Executor Control Client、bounded list/Result、已运行检测；不打开 SQLite |
| Web Console local boundary | `PASS — CANDIDATE` | loopback/Origin/CSRF、只读 Task/Event/Result、显式 Cancel/Reply；console close 不改 Executor |
| Executor Wake | `PASS — SYNTHETIC / REAL NOT_RUN` | post-Release once-only Queue + Web Notify、SQLite v14 evidence、exact-config fail closed；真实 socket/Queue/C/D 未运行 |
| Async Master Handoff | `PASS — CONTRACT / MODEL NOT_RUN` | deterministic Skill decision contract；真实 Host 模型遵循率、真实 Wake 恢复与 Desktop visible 未验证 |
| Unified local release gate | `PASS — LOCAL` | Windows 1060 项完整回归、4/4 压力矩阵、生成物与插件校验通过 |
| Unified GitHub release gate | `NOT_RUN` | 推送后运行 Ubuntu/Windows/Stress；任何失败不得以重跑替代根因处理 |
| Root-exited shutdown race | `PASS — DETERMINISTIC + FULL REGRESSION` | 仅精确 `process_tree_root_exited` 可由 fresh exact probe 加原 recorded-tree clean proof 收敛；定向 20/20、负载 12/12、composition 67/67 |

## Follow-up

- Executor Doctor IPC 已完成；真实 Host 下 owner/pipe/build provenance 的展示仍随 Desktop 关闭 E2E 验证。
- 在 Web Console MVP 中优先轮询；SSE 只在实测有明显收益后引入。
- 把 Token Efficiency 观测与 Async E2E 的模型调用分开记账。
- Async Handoff 的真实模型遵循率和 Pending Interaction 行为需在隔离 Host 中
  单独验证；静态 Skill 合同不能证明运行时遵循。
