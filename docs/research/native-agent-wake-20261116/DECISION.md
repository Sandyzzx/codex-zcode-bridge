# Native Agent Wake Decision

> Status: RESEARCH
> Last updated: 2026-11-16
> Last verified: 2026-11-16, real Windows Codex CLI Native Agent Wake and default Desktop negative controls
> Verified against: `295727320cab86b071c23ddddd6e29306fa29e7f`

## Decision

`Thin Waiter --notify-codex`: **NO-GO**。

本轮不建议把现有 Thin Waiter 直接改造成 Host Wake Adapter，也不建议把普通 `codex queue` 伪装成 Native Agent Message。CLI 原生唤醒只在 Native Agent Message 路径上得到确认；外部 Bridge/ZCode Worker 没有公开的 Native Mailbox ingress。

长期候选方案：**C. Native Subagent + `wake_on_agent_messages`**。该候选仍有明确前置条件，不能在本轮直接实现或宣称生产可用。

## Accepted Findings

### Available

- `wake_on_agent_messages` 在本机 CLI 中被识别，默认 `false`，可通过进程级 `--enable` 启用。
- `spawn_agent` 在 `multi_agent=true` 时可用，`multi_agent_v2` 不是本机实测前置条件。
- Feature OFF 对照没有 Parent Wake。
- Feature ON 后，Parent 先 Final，Child 约 30 秒后完成并发出原生 `FINAL_ANSWER`，Parent 自动启动新 Turn 并正确输出 ACK。
- Child 在 Parent Final 后继续运行约 30 秒和约 120 秒；约 123 秒后 Parent 自动恢复。

### Not Available or Not Confirmed

- 默认 Desktop 普通 Thread 没有出现 Native Wake。
- 默认 Desktop `/goal` Thread 已完成并空闲后没有出现 Native Wake。
- Desktop 启用态未测试：需要改全局配置，按隔离约束记为 `DESKTOP_CONFIG_BLOCKED`。
- 公开 AppServer 方法没有 Agent Mailbox 注入入口；`thread/inject_items` 不启动 Turn。
- 未找到外部 Bridge Worker 直接进入 Native Agent Mailbox 的公开路径。
- 1 小时/4 小时长等待、Interrupt/Plan Mode 的真实 Native Wake 变体、Desktop 启用态和重复/取消/迟到消息矩阵未测试。

## Verdicts

| Field | Decision |
|---|---|
| `FEATURE_AVAILABLE` | `TRUE`（CLI 可临时启用） |
| `NATIVE_WAKE_CLI` | `TRUE` |
| `NATIVE_WAKE_DESKTOP` | `FALSE` for tested default Desktop; enabled variant `BLOCKED` |
| `NATIVE_WAKE_GOAL` | `FALSE` for tested default Goal; enabled variant `BLOCKED` |
| `CHILD_SURVIVES_PARENT_FINAL` | `TRUE` |
| `LONG_IDLE_WAKE` | `TRUE` at ~123 seconds |
| `EXTERNAL_BRIDGE_COMPATIBLE` | `FALSE` / no public Native Mailbox ingress |

## Recommended Architecture Direction

### Do not implement now

1. Do not add `--notify-codex` to the current Thin Waiter.
2. Do not inject Worker output through `codex queue` as if it were a user request.
3. Do not modify Codex internals to expose a private Agent Mailbox or terminal pipe.
4. Do not build a Bridge-side fake Agent Message or claim Native Wake from a Child completion event alone.

### If a later round explicitly authorizes a prototype

Prototype C as a **Native Subagent Wrapper** only:

1. Parent uses `spawn_agent` for a dedicated Native Child.
2. The Native Child invokes an isolated ZCode Worker or MCP task and returns a fixed, schema-limited completion message.
3. The Child sends a Native Agent Message to its Parent.
4. Parent wake is tested only when Feature is enabled and the Parent is idle, non-interrupted, non-Plan, and has no outstanding active turn.

The wrapper must preserve:

- fixed message envelope: task ID, attempt, terminal/attention reason, and a request to query authoritative Bridge state;
- no Worker free text as user intent;
- no permission decision or secret material in the notification;
- explicit deduplication, cancellation, late-event, and retry rules;
- measured Native Child token and concurrency cost.

## Comparison

| Option | Recommendation |
|---|---|
| A. MCP Attention active wait | Keep as a bounded active-turn mechanism; it is not an idle Host wake. |
| B. Thin Waiter + user-role queue | Keep as `NO-GO` for production notification; only suitable for explicitly authorized, human-like queue experiments. |
| C. Native Subagent + Feature wake | Best semantic fit for Parent-idle Whole Task completion, but requires a separate native-subagent wrapper design and authorization. |

## Revisit Gate

A future GO decision requires all of the following:

1. A safe, non-global Desktop enablement or a separately authorized Desktop config test.
2. A supported external-to-Native bridge realized through a Native Subagent wrapper, not a private Host interface.
3. Runtime coverage for Interrupt and Plan Mode suppression.
4. Duplicate, cancellation, late-message, and Parent re-finalization safety.
5. A cost model that includes Native Child model turns and Agent-slot occupancy.
6. Explicit user authorization for any production architecture change.

This decision does not authorize Bridge production changes, SQLite Authority writes, daemon creation, or Codex source/install modification.
