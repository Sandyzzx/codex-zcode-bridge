# Async Execution Architecture Review

> Status: INDEPENDENT REVIEW（PR 1 待正常评审合入）
> Date: 2026-11-21
> Review baseline: `1f9ff9ef37528205e76156e13fe06ed2b1fd3711`

## Verdict

`OWNER APPROVED`：Owner 已批准总体架构和 ADR-045。本轮最终修订补齐 Lease/Store 释放顺序、可恢复的 Idle-only Shutdown 拒绝路径，以及新旧 Host 混用验收负例。架构仍未实施，不能发布；PR 2 必须先通过真实 Host 关闭 E2E 和原 Attempt Result Durability 验证。

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

## Required Corrections Before Implementation

1. PR 2 必须按架构文档实现 lifetime lease 仲裁；不得以 Bootstrap lock、Admission CAS 或命名管道存在性替代。
2. Executor IPC 错误表必须包含 `REQUEST_CANCELLED`、`TASK_CANCEL_REQUESTED`、`SUBMISSION_UNKNOWN`、`EXECUTOR_UNAVAILABLE`。
3. Executor 正常退出必须实现 Idle-only Shutdown；活动/排队/清理未知状态返回 `EXECUTOR_SHUTDOWN_NOT_IDLE`，不得调用现有 Host shutdown 取消任务。
4. `EXECUTOR_SHUTDOWN_NOT_IDLE` 后必须恢复 Admission 和任务控制；PR 2 需验证可继续 Create/Continue/Cancel/Reply。
5. Lease 释放必须晚于 Store 关闭；PR 2 需验证 Store 关闭失败或 lease 写失败时不出现第二 Authority。
6. PR 2 验收必须包含新旧 Host 混用和手动 Lease Clear 活动 Owner 负例。
7. PR 3/4 需要定义列表/事件查询分页上限，并确认只读投影不写业务 SQLite。
8. PR 5 必须先裁决 SQLite v14 `observation_recorded` 能否安全承载 Wake Intent/Delivery；不能则只保留 Web Notify，不创建第二持久化权威。
9. PR 5 必须复用 A 实验作为模型失控负例；未确认 Thread 当前 model/effort/budget 时只允许 Web Notify。
10. 所有“Desktop 关闭后继续执行”结论必须来自真实 Host E2E，不能来自受控 EOF 或 detached spawn。

## Non-Blocking Follow-up

- 为 Executor 增加 `doctor` 只读诊断，报告 owner、pipe、build provenance、SQLite schema 和 active capacity。
- 在 Web Console MVP 中优先轮询；SSE 只在实测有明显收益后引入。
- 把 Token Efficiency 观测与 Async E2E 的模型调用分开记账。
