# Async Execution Architecture Review

> Status: IMPLEMENTED — PR 2.5 CANDIDATE（architecture accepted；release blocked）
> Date: 2026-11-22
> Review baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1`；PR 2.5 stacked branch `codex/async-executor-pr2.5`

## Verdict

`OWNER APPROVED`：Owner 已批准总体架构和 ADR-045。PR 2 candidate 已实现
Lifetime Lease、精确 owner 仲裁、Idle-only Shutdown、IPC、Thin MCP control
transport，以及跨进程 fake Worker 的 Result/Cleanup/Release 验证。PR 2.5
candidate 进一步把 shipped MCP 入口收敛为单一 Thin MCP，并把生产 Authority
composition 固定在 Executor；确定性四层 E2E 与类型/边界检查通过。当前结论
仍为 `PARTIAL / BLOCKED`：真实 Codex Desktop 关闭后的 Host E2E 和真实
Official Runtime 路径仍未运行；可以提交 stacked PR 评审，但不得合入
Preview 或发布。

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
8. `NOT_RUN`：PR 3/4 仍需定义列表/事件查询分页上限，并确认只读投影不写业务 SQLite。
9. `NOT_RUN`：PR 5 必须裁决 SQLite v14 `observation_recorded` 能否安全承载 Wake Intent/Delivery；不能则只保留 Web Notify。
10. `NOT_RUN`：PR 5 必须复用 A 实验作为模型失控负例；未确认 Thread 当前 model/effort/budget 时只允许 Web Notify。
11. `BLOCKED`：真实 Desktop 关闭后的进程存活和 Result durability 仍需真实 Host E2E；受控 EOF、detached spawn 和 fake Worker 不能替代。

## PR #120 / PR 2.5 Remediation Record

| 项目 | 状态 | 当前证据 |
|---|---|---|
| Production composition parity | `PASS` | `src/executor/production-composition.ts` 是唯一生产 Authority composition；静态合同测试覆盖 Start Plan factory、动态 persisted routing、Worker diagnostics、Doctor 和 model settings |
| Executor-owned model/Doctor IPC | `PASS` | 模型 list/get/set/clear 与完整 Doctor 经 control server/client；Thin MCP reconnect 后仍读取同一持久默认模型 |
| Production CLI test-seam rejection | `PASS` | Fake Adapter 与任意 Worker entry 在 Lease 获取前拒绝 |
| Startup failure rollback | `PASS` | pipe 启动失败仅在 Store idle close 与 exact Lease 证明后释放；Authority 启动失败保留 Lease 并阻止第二 Owner |
| Development gate | `PASS` | 延期 FULL 运行直接/域安全测试；Integration 安全集合 fail closed，完整 Release Gate 仍延期 |
| Complete release matrix | `NOT_RUN` | 统一在 Executor PR 2-6 的 Release Candidate 边界执行；历史全量结果不适用于当前工作树 |

## Follow-up

- Executor Doctor IPC 已完成；真实 Host 下 owner/pipe/build provenance 的展示仍随 Desktop 关闭 E2E 验证。
- 在 Web Console MVP 中优先轮询；SSE 只在实测有明显收益后引入。
- 把 Token Efficiency 观测与 Async E2E 的模型调用分开记账。
