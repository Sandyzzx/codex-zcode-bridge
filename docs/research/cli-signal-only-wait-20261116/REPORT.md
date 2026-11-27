# CLI Signal-only Wait E2E

> Status: RESEARCH
> Last updated: 2026-11-17
> Last verified: 2026-11-17，真实 Windows Host 上验证 60 秒成功信号、60 秒 MCP 对照和 720 秒 Host 上限；核对 SQLite Result 与精确文件字节。
> Verified against: 295727320cab86b071c23ddddd6e29306fa29e7f + 本 worktree 测试脚本

## 结论摘要

| 判定 | 结果 | 证据边界 |
|---|---|---|
| `CLI_SIGNAL_ONLY` | **PASS** | B1：一次 CLI waiter 阻塞 60.744 秒，返回唯一一行 completed terminal 信号；Result 和信号文件一致 |
| `HOST_LONG_TOOL_WAIT` | **NO，当前上限约 300 秒** | B2：请求 `timeout_ms=930000`，Host 在 300.014 秒后以 `timed out awaiting tools/call after 300s` 取消 |
| `SAME_TURN_CONTINUATION` | **PASS（机械行为）** | B1 和 MCP 对照都在原活跃 Turn 返回后继续调用 Result；B2 超时后也在原 Turn 做诊断，但没有成功的 wrapper 返回 |
| `MODEL_CALLS_DURING_WAIT` | **0 个新 Master 模型请求** | B1、MCP 和 B2 的等待窗口内均无新的 `token_usage_record`；B2 有一个属于发起工具调用的记录落在工具启动后 29 ms |
| `TOKEN_REDUCTION` | **COST_INCONCLUSIVE** | 可见 Token 有约 1% 差异，但上下文、工具数量、诊断轮和缓存不同，不能归因于等待机制 |
| `WHOLE_TASK_1H_FEASIBILITY` | **当前活跃 Turn 路径不可行** | 300 秒 Host 硬边界在 1 小时测试前就会触发；不做无意义的 1 小时压力测试 |

**最终建议：`NO-GO`，不应把当前 Signal-only Waiting 直接设为 Whole Task 的默认等待路径。**
它可以作为约 240 秒以内的短任务快速路径，并必须在 Host 提前返回或超时时回退到现有 MCP Attention；长等待仍需要独立的后台 waiter 加受支持的 Host 唤醒机制。

本实验验证的是**活跃 Turn 内的阻塞工具调用**。没有任何结果证明 Parent 输出 Final 后还能被原生唤醒。

## 实验边界

- 使用真实 Windows Codex Desktop 专用实验 Thread：`01a1e505-b5f6-7712-9d40-45c65bcf33df`。
- 使用项目内隔离 worktree：`D:\codex-zcode-bridge\.run\cli-signal-wait-20261116`。
- 使用测试专用 V2 broker、隔离 profile 和隔离 SQLite Authority；没有写入生产 SQLite，没有取消或修改已有 Worker。
- 真实 ZCode 任务使用 `GLM-5.3-Flash`、`reasoning_level=low`，每次只做一次真实 PowerShell sleep 和固定信号文件写入。
- 没有修改生产 Bridge、SQLite Schema、MCP Schema、Waiter 或 Worker。
- B1/B2 都是 Master 活跃 Turn 内的一次长工具调用；不是 Parent Final 后的 Agent Message 唤醒，也不是 `/goal` 唤醒。

## 环境

| 项目 | 实测值 |
|---|---|
| OS | Microsoft Windows 11 家庭版，10.0.26100，x64 |
| Codex Desktop | `26.1111.2228.0` |
| Codex CLI | `0.169.0-alpha.11.1` |
| Node | `v24.16.0` |
| Bridge | `2.0.0-preview.8` |
| Waiter | `%USERPROFILE%\.codex\plugins\cache\codex-zcode-bridge-preview\codex-zcode-bridge\2.0.0-preview.8\dist\wait-task.mjs` |
| Waiter SHA-256 | `EB7209D299396F864DDA53625B9895F828AEBC3605842808A85441DB281D03BF` |

## Waiter 基线

源码和实际 CLI 行为一致：

- `0`：Attention，包含 `interaction`、`terminal` 或 `attempt_changed`
- `3`：Timeout
- `2`：Usage/Error

`node wait-task.mjs --help` 实测退出码为 `2`，因为帮助通过 `UsageError` 路径终结。Signal-only wrapper 只在 child exit `3` 且 payload reason 为 `timeout` 时输出 `WAIT_TIMEOUT` 并保留 `3`；Timeout 不会被解释成完成。

`signal-only-wait.mjs` 只向 stdout 输出一行 Attention 信号，不显示 pending 请求正文、Worker 文本、历史 Events、Result 或凭据。错误路径不转发 child stderr；实测不存在 task 时仅输出：

```text
WAIT_ERROR code=invalid_waiter_output exit=2 code=wrapper_error diagnostic=Unexpected end of JSON input
```

退出码保留为非零 `2`。

## B1：60 秒成功信号

| 事实 | 实测 |
|---|---|
| Task | `csow-iso-b1-20261117-b1` |
| Codex Turn | `01a1e520-0663-7912-91b1-4f4ae0e25454` |
| Host 工具 | `mcp__node_repl__js`，`call_00_ilxd505p41mf2hpjf1irf0mn` |
| 派发 | `16:11:14.802Z` 至 `16:11:15.047Z`，receipt queued |
| Attempt | `16:11:17.310Z` 至 `16:12:53.773Z`，attempt `1` |
| Readiness | 一次 `zcode_events(wait_ms=0)` 得到 `running` |
| Wrapper | `16:11:53.294Z` 至 `16:12:54.038Z`，`60744 ms`，未被杀 |
| Host 工具结束 | `16:12:54.055Z`，状态 completed，`60774 ms` |
| Wrapper stdout | `ATTENTION task=csow-iso-b1-20261117-b1 attempt=1 status=completed reason=terminal` |
| Wrapper 退出码 | `0` |
| Result | `completed`，`exit_code=0`，`usage=null` |
| 信号 | 26 bytes，`CSOW_B1_RESULT_20261117_B1`，SHA-256 `63168845C0745F8DEE024933CE5D06EF896D174B40A6EB2B8E71D005EC367BBB` |
| 生命周期 | Result committed、cleanup verified、released 全部完成 |

结果顺序是：**消息入队** → **同一活跃 Turn 内的阻塞 Waiter** → **Master 在返回后继续执行 Result 查询**。这里没有发生 Host 自动恢复或 Parent Final 后的唤醒。

等待开始于 `16:11:53.294Z`，wrapper 返回于 `16:12:54.038Z`。期间没有新的 Master 模型请求；下一个 `token_usage_record` 出现在 wrapper 返回后的 `16:13:04.188Z`。

Host 呈现给模型的工具结果只有 284 bytes，包含 wall time、单行信号和 wrapper 生命周期：

```json
{
  "stdout": "ATTENTION task=csow-iso-b1-20261117-b1 attempt=1 status=completed reason=terminal\n",
  "stderr": "",
  "exit_code": 0,
  "killed": false,
  "elapsed_ms": 60744
}
```

## MCP Attention 对照

| 事实 | 实测 |
|---|---|
| Task | `csow-iso-mcp-20261117-b1` |
| Codex Turn | `01a1e523-8630-7782-90cc-0c6bc6250f2a` |
| Host 工具 | `mcp__node_repl__js`，`call_00_t1oz6z925acdq3n4u803pq6x` |
| 派发 | `16:14:57.115Z` 至 `16:14:57.422Z` |
| Attempt | `16:14:59.941Z` 至 `16:16:27.623Z` |
| Readiness | 一次 `zcode_events(wait_ms=0)` 得到 `running` |
| Attention 等待 | `16:15:28.230Z` 至 `16:16:27.718Z`，`59488 ms` |
| 等待调用 | 3 次 `zcode_events(wait_for="attention", wait_ms=25000)` |
| 未到终态的窗口 | 前两次各约 25.16 秒，返回 `running`；均明确不作为完成 |
| 成功 terminal | 第 3 次在 `9.152 s` 后返回 `status=completed` |
| Result | `completed`，`exit_code=0`，`usage=null` |
| 信号 | 27 bytes，`CSOW_MCP_RESULT_20261117_B1`，SHA-256 `6373854E1BBF062220F0F87BAC131407B15A5E874B02CF6EF90B6C18844AF788` |
| 生命周期 | Result committed、cleanup verified、released 全部完成 |

等待拓扑：

```text
WAIT_LOOP
  attention#1 25.176s -> running
  attention#2 25.159s -> running
  attention#3 9.152s  -> completed
```

这 3 次是真实的 `zcode_events` Attention 调用，但由同一个 `mcp__node_repl__js` 调用内部串行执行，因此 Master 模型在等待期间仍为 0 个新请求。它是有效的 signal/timing 对照，**不是**普通 Master 直接连续调用 3 次 MCP 工具时的 billing A/B。

## B2：720 秒等待与 Host 上限

| 事实 | 实测 |
|---|---|
| Task | `csow-iso-b2-20261117-b1` |
| Codex Turn | `01a1e526-6e7e-7c50-a7bb-6dbdd2a37845` |
| Host 工具 | `mcp__node_repl__js`，`call_00_p4nwwmb6kqheqf41q7mpenwi` |
| 派发 | `16:18:04.899Z` 至 `16:18:05.165Z` |
| Readiness | `16:18:21.050Z` 得到 `running` |
| 请求 Host 上限 | `930000 ms` |
| Host 实际结果 | `16:18:37.794Z` 开始，`16:23:37.884Z` failed，`300014 ms` |
| Host 错误 | `timed out awaiting tools/call after 300s` |
| wrapper 自然输出 | 未取得；Host 在 child close 前取消 |
| wrapper/waiter 残留 | 取消后扫描未发现 |
| Host 取消后的 Worker | **继续运行并最终完成** |
| Worker 完成 | `16:30:53.867Z`，`status=completed`，`exit_code=0` |
| 信号 | 26 bytes，`CSOW_B2_RESULT_20261117_B1`，SHA-256 `467264C851BD65BC58F8D1A36F768FAD17AF7DEFA06F4865E52C2E92E986E67D` |
| 生命周期 | result committed、cleanup verified、released；`16:30:54.451Z` |

B2 的关键区分：

- **消息入队**：已发生。
- **Host 自动恢复**：未发生；这是同一活跃 Turn 的工具调用，不是自动恢复。
- **Master 实际执行**：wrapper 没有被允许执行到自然完成；Host 在 300 秒取消了工具，Master 随后只能处理超时错误。
- **Worker 执行**：隔离 broker 持有的真实 Worker 独立继续，最终写出信号并提交 Result。不能把这说成 Signal-only 成功。

因此 B2 是 `HOST_WAIT_LIMIT / NOT_PASS`，不是 completed terminal，也不是 wrapper 已确认失败。

## Token 与调用量

以下数字来自实验 Thread 的 Codex rollout `token_usage_record`，仅表示可见的请求/上下文计数，**不是计费 Token**。每个 Turn 还包含准备、派发、Result 和诊断调用，不能把整个 Turn 差值当作等待收益。

| Turn | Model requests in turn | Input | Cached | Output | Reasoning | Total |
|---|---:|---:|---:|---:|---:|---:|
| B1 | 10 | 1,046,173 | 1,032,320 | 9,468 | 2,322 | 1,055,641 |
| MCP 对照 | 9 | 1,057,761 | 1,044,864 | 8,034 | 2,295 | 1,065,795 |
| B2 | 8 | 1,038,289 | 1,024,896 | 8,570 | 2,531 | 1,046,859 |

等待发起响应和返回后下一响应的可见增量如下：

| 实验 | 发起等待响应 | 下一次响应 | 等待窗口内新请求 |
|---|---|---|---:|
| B1 | `resp_35d4...` total 106,573 | `resp_1736...` total 107,433，于返回后 | 0 |
| MCP | `resp_3f06...` total 117,457 | `resp_76fb...` total 118,764，于返回后 | 0 |
| B2 | `resp_7daf...` total 129,776 | `resp_f7e8...` total 131,515，于超时后 | 0 |

工具结果大小：

| 实验 | 呈现给模型的工具结果 |
|---|---:|
| B1 wrapper | 284 bytes |
| MCP 等待循环 | 1,394 bytes |
| B2 超时错误 | 145 bytes |

虽然 B1 与 MCP 的 Turn 总量相差约 `10,154`（约 0.95%），但 B1 有一次预 spawn Node REPL 编译失败、较多的准备/诊断调用，MCP 对照又把 3 次 Attention 调用封装在一个 Node REPL 内；缓存和上下文也不同。因此结论是 `COST_INCONCLUSIVE`，不计算虚假的节省百分比。

## 验收判定

| 判定 | 结果 |
|---|---|
| `CLI_SIGNAL_ONLY` | **PASS**：B1 真实成功 terminal 信号、精确文件、Result 和 lifecycle 一致 |
| `HOST_LONG_TOOL_WAIT` | **FAIL/LIMITED**：60 秒通过；Host 在约 300.014 秒取消，930 秒请求未生效 |
| `SAME_TURN_CONTINUATION` | **PASS（机械行为）**：B1/MCP 返回后原 Turn 继续；B2 超时后也继续诊断 |
| `MODEL_CALLS_DURING_WAIT` | **0 个新 Master 请求**（三个采样窗口） |
| `TOKEN_REDUCTION` | **COST_INCONCLUSIVE**，只有方向性信号，不能归因 |
| `WHOLE_TASK_1H_FEASIBILITY` | **不可行（当前活跃 Turn 路径）**；不进入 1 小时测试 |

## 限制与后续门槛

- 没有验证 Parent Final 后的原生 Agent Mail 唤醒；本报告不提供 `QUEUE_WAKES_TUI`、`QUEUE_WAKES_DESKTOP_GOAL` 或 `MCP_WAIT_RETURNS` 的跨 Phase 结论。
- 没有运行 1 小时压力测试；300 秒上限已经是先行阻断条件。
- MCP 对照不是直接由 Master 调用 3 次原生 MCP 工具，而是同一 Host 调用内的 3 次 broker MCP 调用；不能据此宣称 billing 节省。
- 若未来要让 Signal-only 成为长任务默认路径，必须先提供并真实验证：后台 waiter 生命周期、Host 超时后的可恢复交接、以及 Parent 结束后的可观测唤醒；本轮未实现任何这类改造。

## 验证命令

- `node --check signal-only-wait.mjs`：通过。
- `node signal-only-wait.mjs --help`：退出码 `0`，输出单行 usage。
- 不存在 task 的 wrapper 错误路径：退出码 `2`，不转发 child stderr 正文。
- `npm run test:affected`：退出码 `0`；类型检查、构建、plugin validation 和 `git diff --check` 实际运行。变更被分类为 `NO_TESTS_APPLICABLE`，这不是测试 PASS；`STRESS_TESTS_NOT_APPLICABLE`。
