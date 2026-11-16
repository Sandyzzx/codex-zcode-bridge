# Signal-only Waiting Decision

> Status: RESEARCH / DECISION PROPOSAL
> Last updated: 2026-11-17
> Last verified: 2026-11-17，基于 V2 隔离 Authority 的 B1、MCP 对照和 B2 Host 上限证据。

## Decision

**当前不做默认 Whole Task 等待路径切换：`NO-GO`。**

Signal-only wrapper 本身已经能提供单行、低内容的 CLI 信号，并且 B1 的 60 秒真实 E2E 通过；但当前 Codex Desktop Host 对单次 `mcp__node_repl__js` 调用的实际上限约为 300 秒。B2 请求 930 秒，实际在 300.014 秒返回：

```text
timed out awaiting tools/call after 300s
```

因此它无法覆盖 1 小时 Whole Task，也不适合成为无条件默认路径。B2 的 Worker 在 Host 取消工具后仍由隔离 broker 继续运行并最终完成，这只证明 Worker 生命周期独立，不证明 Master 能收到信号。

## 允许的短期用法

可以保留 Signal-only 作为**短任务快速路径**：

- 预期在约 240 秒以内完成；
- 以一次长 Host 工具调用启动 wrapper；
- 超时、Host 取消或 wrapper exit `3` 时，必须回退到现有 MCP Attention；
- 任何成功都必须继续调用 `zcode_result` 并核对 SQLite Authority，不能把进程退出或文件存在当成验收。

这不是 Whole Task 默认策略，也不改变现有 MCP schema 或 Worker 生命周期。

## 方案对比

| 方案 | 当前证据 | 决策 |
|---|---|---|
| A. MCP Attention 长等待 | 已验证 3 次 Attention 调用覆盖约 59.5 秒，最终 terminal 和 Result 一致 | 保留为长任务安全路径 |
| B. Thin Waiter + Codex Queue / Signal-only | 60 秒成功；300 秒 Host 上限阻断 12 分钟及更长的活跃 Turn | **不作为 Whole Task 默认；只允许短任务回退路径** |
| C. Native Subagent + `wake_on_agent_messages` | 本轮没有做 Native Wake E2E；不能由本报告推断 | 继续作为独立研究，不能替代当前结论 |

## Reopen conditions

只有满足至少一项，才应重新评估 Whole Task 默认候选：

1. Host 为单次工具调用提供可配置且经真实 E2E 验证的 1 小时级生命周期。
2. 后台 waiter 能在 Master Turn 结束后持续运行，并通过受支持的 Host 接口触发可观测的新 Turn。
3. 发生 Host 超时/取消时，Bridge 能提供可验证的 handoff，且 Master 不需要反复模型轮询。

在本轮不实现 `--notify-codex`、Native Subagent Adapter、Host Wake Adapter、后台 daemon 或新的任务状态机。

## 最终 GO/NO-GO

**GO**：把 Signal-only 做成有界短任务快速路径，并保留 MCP Attention 回退。
**NO-GO**：把当前 Signal-only Waiting 直接做成 Bridge Whole Task 的默认等待路径。
