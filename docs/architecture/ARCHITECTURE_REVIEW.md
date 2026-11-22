# Async Execution Architecture Review

> Status: IMPLEMENTED — PR 2 PARTIAL（architecture accepted；release blocked）
> Date: 2026-11-22
> Review baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1`；PR 2 branch `codex/async-executor-pr2`

## Verdict

`OWNER APPROVED`：Owner 已批准总体架构和 ADR-045。PR 2 candidate 已实现
Lifetime Lease、精确 owner 仲裁、Idle-only Shutdown、IPC、Thin MCP control
transport，以及跨进程 fake Worker 的 Result/Cleanup/Release 验证。当前结论为
`PARTIAL / BLOCKED`：真实 Codex Desktop 关闭后的 Host E2E 和真实 Official
Runtime 路径仍未运行；PR 2 可以提交评审，但不得合入 Preview 或发布。

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

## PR 2 Evidence Update

| 验收项 | 状态 | 当前证据 |
|---|---|---|
| Lifetime Lease 与精确 PID/start fingerprint | `PASS` | 单进程/双启动/legacy Host 互斥、heartbeat、release ordering、malformed lease、manual clear 活动 Owner 负例 |
| Idle-only Shutdown 与拒绝后恢复 | `PASS` | 活动任务拒绝、`EXECUTOR_SHUTDOWN_NOT_IDLE` 后继续接受 Create/健康检查；metadata 默认启动/过期/PID reuse 路径覆盖 |
| IPC 错误与断连语义 | `PASS` | `REQUEST_CANCELLED`、`TASK_CANCEL_REQUESTED`、`SUBMISSION_UNKNOWN`、`EXECUTOR_UNAVAILABLE`；in-flight close 与 lost response 覆盖 |
| 32 MiB Result IPC | `PASS` | 完整 32 MiB Result 通过 33 MiB frame 回读 |
| Thin MCP transport | `PASS` | control transport 不构造本地 SQLite Manager；MCP stdio 关闭不取消已受理 Task；reconnect 读到原 Result |
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
7. `NOT_RUN`：PR 3/4 仍需定义列表/事件查询分页上限，并确认只读投影不写业务 SQLite。
8. `NOT_RUN`：PR 5 必须裁决 SQLite v14 `observation_recorded` 能否安全承载 Wake Intent/Delivery；不能则只保留 Web Notify。
9. `NOT_RUN`：PR 5 必须复用 A 实验作为模型失控负例；未确认 Thread 当前 model/effort/budget 时只允许 Web Notify。
10. `BLOCKED`：真实 Desktop 关闭后的进程存活和 Result durability 仍需真实 Host E2E；受控 EOF、detached spawn 和 fake Worker 不能替代。

## Non-Blocking Follow-up

- 为 Executor 增加 `doctor` 只读诊断，报告 owner、pipe、build provenance、SQLite schema 和 active capacity。
- 在 Web Console MVP 中优先轮询；SSE 只在实测有明显收益后引入。
- 把 Token Efficiency 观测与 Async E2E 的模型调用分开记账。
