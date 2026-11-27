# Host Event Wake Capability Probe

> Status: RESEARCH
> Last updated: 2026-11-16
> Last verified: 2026-11-16, real Windows Codex Desktop/CLI Host, installed Bridge Preview, real ZCode tasks, and the shared SQLite Attention database
> Verified against: `295727320cab86b071c23ddddd6e29306fa29e7f`

## Executive result

本轮确实执行了真实 Windows Host E2E，不是 mock，也没有把 CLI 入队成功当成 Host 已执行。

| Question | Answer | Basis |
|---|---|---|
| `QUEUE_WAKES_TUI` | **YES, loaded idle** | A1 的已载入空闲 TUI 在无人工消息下自动产生新 turn，并由目标 thread 的 assistant 发出唯一 ACK。A2/A3 同时证明不能把任意状态都外推为成功。 |
| `QUEUE_WAKES_DESKTOP_GOAL` | **YES, loaded completed-goal thread** | B 的可丢弃 Desktop `/goal` thread 完成目标并空闲后，外部 `codex queue` 使其可见会话自动产生新的 user message、新 turn 和唯一 assistant ACK；rollout UUID 与 Goal tool 返回的 thread UUID 一致。 |
| `MCP_WAIT_RETURNS` | **YES** | C1 中 `zcode_events(wait_for="attention")` 在活跃 Master turn 内等待并在 terminal 变化时返回，随后同一 turn 继续执行。 |
| `TOKEN_SAVINGS_MEASURABLE` | **NO / NOT ESTABLISHED** | 取得了多个 idle queue wake 的 Master token usage，但 active MCP wait 发生在贯穿整个探针的长 turn 中，无法按调用归因；没有至少两组同任务、同上下文、同口径的 matched trials，因此不计算节省比例。 |

`Thin Waiter --notify-codex` 的产品建议：**NO-GO**。当前证据足以证明“可由 user-role queue 唤醒已载入的 TUI/Desktop Goal”，不足以证明存在安全的 Host-native Worker notification 通道，也没有解决 interruption pause、failed resume、重复/迟到/取消通知和 token 收益归因。

## Scope and isolation

- 探针 worktree：`D:\codex-zcode-bridge\.run\host-event-wake-probe-20261116`
- 分支：`codex/host-event-wake-probe-20261116`
- 基线 commit：`295727320cab86b071c23ddddd6e29306fa29e7f`
- Master worktree 的 `M AGENTS.md` 与未跟踪 `$null` 保持原样，未触碰。
- 未修改 Bridge 生产代码、SQLite Authority、现有 Worker、MCP schema、权限合同或生产会话。
- 未读取或记录明文凭据、OAuth 状态、隐藏 reasoning；未复制 raw rollout。
- 未执行 push、merge、tag、release。

## Environment

| Component | Observed value |
|---|---|
| OS/Host | Windows local desktop, Asia/Shanghai |
| Codex Desktop | `26.1111.2228.0` |
| Codex CLI | `0.169.0-alpha.11.1` |
| Node / npm | `v24.16.0` / `11.13.0` |
| ZCode Desktop | `3.18.2.10443` |
| ZCode AppServer | `0.17.1` |
| Bridge plugin | `codex-zcode-bridge` `2.0.0-preview.8`, installed Preview cache |
| Master model in A/B | `opencode-go/deepseek-v4.1-flash`, reasoning `high` |
| Bridge task model in C | `account:bigmodel-individual-coding-plan/GLM-5.3-Flash`, task-level reasoning `low` for successful probes |
| SQLite state dir | `C:\Users\Sandy\AppData\Local\CodexZCodeBridge\state` |
| SQLite database | `bridge.sqlite` with live `-wal` and `-shm` |

`codex queue --help` confirms local `--resume`, but also documents: `A failed resume produces a warning and the command still succeeds`. This behavior was reproduced by A2.

`codex features list` reports `wake_on_agent_messages: under development, false`. This is context only; the decision below uses observed Host behavior, not the feature flag.

The installed Thin Waiter is the read-only SQLite Attention V2 waiter. Its contract is:

```text
node wait-task.mjs --task <task_id> [--timeout-s S] [--poll-ms MS] [--data-dir ABS_SQLITE_STATE_DIR]
0 = Pending/terminal/Attempt change, 3 = timeout, 2 = argument/configuration/read error
```

It does not notify Codex. `zcode_doctor` was successfully called in this run and reported Node, Git, execution mode, desktop settings, ZCode runtime, provider config, task data, process probe, and recovery-lock checks; `model`, `app_server`, `permission_roundtrip`, and `codex_host_tokens` remained intentionally `unknown`.

## State distinction used

- **MESSAGE_ENQUEUED**: `codex queue` returned a Message ID.
- **HOST_RESUMED**: Host/rollout recorded a new `task_started` for the same target UUID without a user manually submitting the queued text.
- **MASTER_EXECUTED**: the target thread's rollout recorded an assistant response, or the visible Desktop session showed that assistant response.

No case below treats `MESSAGE_ENQUEUED` alone as `WAKE_CONFIRMED`.

## A. Plain TUI queue cases

| Case | Target state | Result | Classification |
|---|---|---|---|
| A1 | Loaded + idle | New automatic turn and exact assistant ACK | `OBSERVED / PASS / WAKE_CONFIRMED` |
| A2 | Client closed/unloaded + `--resume` | Message queued; resume warning; no new turn | `OBSERVED / QUEUED_ONLY` |
| A3 | User-interrupted, then idle | Message queued; no new turn after about 289 s observation | `OBSERVED / QUEUED_ONLY` |

### A1: loaded idle TUI

- Thread UUID: `01a1e44f-8c56-7ad3-80a6-ae6ed91867bc`
- Baseline assistant response: `TUI_BASELINE_HWP-20261116-A1-7F3C9D2A`
- Queue command: `HWP-20261116-A1-7F3C9D2A`
- Enqueue window: `2026-11-16T12:23:59.8626434Z` to `2026-11-16T12:24:01.7846223Z`
- Exit code: `0`
- Message ID: `01a1e450-749d-7f61-af70-43e64b116970`
- New target `task_started`: `2026-11-16T12:24:08.985Z`
- Assistant ACK: `WAKE_ACK_HWP-20261116-A1-7F3C9D2A` at `2026-11-16T12:24:12.533Z`
- `task_complete`: `2026-11-16T12:24:12.576Z`
- No manual message was submitted after the queue command.

The queued text and assistant response were distinguished by rollout role and by the separate turn/ACK values. This is a real Host wake, not a grep hit on the queued user message.

### A2: unloaded thread with `--resume`

- Thread UUID: `01a1e452-bcc6-72e1-ba40-fbc93effece5`
- Baseline assistant response: `TUI_BASELINE_HWP-20261116-A2-4B8E1C7D`
- The TUI was stopped with `Ctrl-C` before enqueue.
- Enqueue window: `2026-11-16T12:27:35.4663384Z` to `2026-11-16T12:27:36.7611120Z`
- Exit code: `0`
- Message ID: `01a1e453-be4c-7761-9f2a-15b275a424a5`
- Exact warning: `message was queued, but could not resume thread ...: start a local daemon or specify a server with --remote`
- No new target `task_started` or assistant ACK was observed.

This is `QUEUED_ONLY`. The successful exit code is not a wake.

### A3: interrupted then idle

- Thread UUID: `01a1e454-b531-77f2-be4e-ce67a4eec365`
- Baseline assistant response: `TUI_BASELINE_HWP-20261116-A3-9C2A6E41`
- A disposable long prompt was started at `2026-11-16T12:29:58Z`, then interrupted with Escape; rollout recorded `turn_aborted` at `2026-11-16T12:30:14Z`.
- Enqueue window: `2026-11-16T12:30:35.5060272Z` to `2026-11-16T12:30:36.7448827Z`
- Exit code: `0`
- Message ID: `01a1e456-7d8a-7bc3-9993-28e004406733`
- No new target `task_started` or assistant ACK was present at final observation, about `289 s` after enqueue.
- The target TUI remained idle until the probe process was closed.

This is `QUEUED_ONLY`. A dispatch pause is plausible, but no direct `queued_but_dispatch_paused` event was available, so this report does not upgrade that explanation from inferred to observed.

## B. Desktop `/goal`

### B1: loaded completed-goal thread

- Disposable Goal objective nonce: `HWP-20261116-B-DESKTOP-GOAL-6D1A4C`
- Thread UUID from Goal tool result: `01a1e45e-12c7-76c1-a441-a280cfcdcd55`
- Goal tool reported `status=complete`, `tokensUsed=11729`, `timeUsedSeconds=7`.
- Baseline assistant response: `GOAL_BASELINE_HWP-20261116-B-DESKTOP-GOAL-6D1A4C`
- Baseline `task_complete`: `2026-11-16T12:39:08Z`
- Enqueue window: `2026-11-16T12:39:40.7977937Z` to `2026-11-16T12:39:42.5841204Z`
- Exit code: `0`
- Message ID: `01a1e45e-d14e-7462-a50d-750ab5a441b9`
- New target `task_started`: `2026-11-16T12:39:41Z`
- Assistant ACK: `WAKE_ACK_HWP-20261116-B-DESKTOP-GOAL-6D1A4C` at `2026-11-16T12:39:47Z`
- `task_complete`: `2026-11-16T12:39:47Z`

The visible Desktop Goal session was refreshed after the turn had materialized. Its accessibility tree then showed both the queued user message and the assistant ACK. The refresh did not submit a message and did not create the turn. Rollout UUID, Goal tool UUID, visible session title, and target queue UUID all match.

Classification: `OBSERVED / PASS / WAKE_CONFIRMED`.

Only `loaded + goal completed (idle)` was tested. Unloaded Goal, interrupted Goal, and an actively running Goal were not tested.

## C. MCP Attention and Thin Waiter

| Case | Observation | Result |
|---|---|---|
| C1 | Real `zcode_events(wait_for="attention")` returned on terminal completion in the active Master turn | `OBSERVED / PASS / MCP_WAIT_CONFIRMED` |
| C2 | Installed read-only waiter returned terminal JSON with exact exit `0`; fixed summary was then queued to the confirmed Desktop route and consumed | `OBSERVED / PASS` |
| C3 | Waiter ran against a live task, received no Attention change for 5 s, and returned exact exit `3` while status remained `running` | `OBSERVED / PASS / TIMEOUT_EXPECTED` |

### C1: direct MCP wait

- Task: `hwp-c1-wait-20261116`
- Attempt: `1`
- Task create call returned queued at `2026-11-16T12:46:47.422Z`.
- Direct MCP wait call started at `2026-11-16T12:47:01Z`.
- Tool wall time: `11.9840 s`.
- Wait returned top-level `status=completed` and `attention={attempt:1,status:completed,pending_requests:[]}`.
- The task's terminal `result_committed` was `2026-11-16T12:47:13.212Z`.
- No new user turn was needed; the same Master turn continued to run C2.

This establishes that the MCP long-wait returns and the active turn continues. It is not an idle-Host wake.

### C2: independent Thin Waiter

- Task: `hwp-c1-wait-20261116`, attempt `1`.
- Waiter start/end: `2026-11-16T12:47:31.0582562Z` to `2026-11-16T12:47:31.3605817Z`.
- Exit code: `0`.
- JSON reason: `terminal`; status: `completed`; waiter elapsed: `60 ms`.
- It read the real SQLite state directory and did not write business database/WAL state.

The waiter result alone is not called a Host wake. A fixed, sanitized summary containing only `task_id`, attempt, attention reason/status, and an instruction to call `zcode_events`/`zcode_result` was queued to the already-confirmed disposable Desktop Thread.

- Fixed notification nonce: `HWP-20261116-C2-NOTIFY-2D8B719E`
- Queue window: `2026-11-16T12:48:38.6670194Z` to `2026-11-16T12:48:40.4663711Z`
- Exit code: `0`
- Message ID: `01a1e467-06e7-7f21-8e74-eb15bba2fd6d`
- New target `task_started`: `2026-11-16T12:48:41Z`
- The assistant called `zcode_events` and `zcode_result`, then emitted `NOTIFY_ACK_HWP-20261116-C2-NOTIFY-2D8B719E` at `2026-11-16T12:48:54Z`.

The end-to-end chain is therefore: SQLite Attention -> independent waiter -> fixed CLI queue notification -> Desktop Host resume -> assistant consumption. The last two stages use the ordinary user-role queue route; there is still no native worker notification channel.

### C3: expected timeout

- Task: `hwp-c3-timeout-20261116`, attempt `1`.
- Task create call returned queued at `2026-11-16T12:47:50.411Z`.
- Waiter start/end: `2026-11-16T12:48:06.1466291Z` to `2026-11-16T12:48:11.3706371Z`.
- Exit code: `3`.
- JSON reason: `timeout`; status: `running`; waiter elapsed: `5003 ms`; no pending requests.
- The task later completed normally; `result_committed` was `2026-11-16T12:48:13.164Z`, and cleanup/release completed at `2026-11-16T12:48:15.819Z`.

No task state was synthesized to force timeout or completion.

### Auxiliary failed task

`hwp-c1-c2-c3-20261116` was a first minimal task attempt. Its real ZCode turn failed with `zcode_nonzero_exit`; Result, cleanup, and release completed normally with `workspace_touched=false`. A separate C2 waiter observation against it returned `terminal`, status `failed`, exit `0`. It is retained as an infrastructure-negative observation, not as a successful Task.

## D. Low-cost Token Cost Lab

Only observable Host token fields are reported. Missing per-wait attribution remains `null`.

| Sample | Master model | Host turns | Input | Cached input | Cache writes | Output | Reasoning | Total | Comparability |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| A1 baseline | DeepSeek V4.1 Flash | 1 | 20692 | 8704 | 0 | 25 | 0 | 20717 | Baseline only |
| A1 idle queue wake | DeepSeek V4.1 Flash | 1 | 20808 | 20608 | 0 | 35 | 12 | 20843 | Idle wake sample |
| B ACK wake | DeepSeek V4.1 Flash | 1 | 20265 | 20096 | 0 | 26 | 0 | 20291 | Idle wake sample |
| B C2 notification wake | DeepSeek V4.1 Flash | 1 | 93383 turn aggregate | 75520 | 0 | 380 | 131 | 93763 | Idle wake plus 3 MCP tool calls; not matched |
| C1 active MCP wait | DeepSeek V4.1 Flash | same long probe turn | null | null | null | null | null | null | No per-call Host usage |
| A2 unloaded enqueue | DeepSeek V4.1 Flash | 0 post-enqueue | 0 | 0 | 0 | 0 | 0 | 0 | Negative control |
| A3 interrupted enqueue | DeepSeek V4.1 Flash | 0 post-enqueue | 0 | 0 | 0 | 0 | 0 | 0 | Negative control |

Observed latency:

- A1: queue command ended at `12:24:01.785Z`; first new target turn started at `12:24:08.985Z`, about `7.20 s`.
- B ACK: task started inside the queue command window; no artificial delay.
- C2 notification: queue call started at `12:48:38.667Z`; target turn started at `12:48:41Z`, about `2.33 s`.
- C1: direct MCP wait returned after `11.984 s`.
- C3: Thin Waiter timed out after `5.003 s`, which is a CLI/SQLite observation, not Host model activity.

Worker usage is separate from Master usage:

- C1 successful Worker usage: `46103` total (`45995` input, `9280` cache read, `108` output).
- C3 successful Worker usage: `46087` total (`45977` input, `192` cache read, `110` output).

These samples are not enough to claim a token-saving percentage. The MCP wait sample shares a long turn with all other probe work, the idle samples use different conversation contexts and task shapes, and no manual/poll control was run. `TOKEN_SAVINGS_MEASURABLE` is therefore `NO / NOT_ESTABLISHED`.

## Probe artifact verification

- `evidence.json` parsed successfully with PowerShell `ConvertFrom-Json`.
- `extract-rollout-evidence.ps1` passed the PowerShell parser and extracted only lifecycle events, exact probe ACK/nonces, and token usage from the A1 rollout.
- The first `npm run test:affected` attempt in the fresh isolated worktree failed at plugin build because the worktree had no `node_modules/playwright-core`; this was an environment setup failure, not a test assertion. The generated files from that failed attempt were restored to the worktree baseline.
- An ignored `node_modules` junction to the existing local dependency tree was then used only for verification, and `npm run test:affected` completed with exit `0`: `NO_TESTS_APPLICABLE`, typecheck PASS, build PASS, plugin validation PASS, `git diff --check` PASS, `STRESS_TESTS_NOT_APPLICABLE`.
- Generated plugin files changed only as build output during verification and were restored; only the probe artifacts are retained for commit.

## Decision implications

### Established

- A loaded idle TUI thread can be resumed by `codex queue` and execute an assistant turn without manual message submission.
- A loaded completed Desktop Goal thread can likewise be resumed and visibly consume the queued message.
- The installed MCP Attention wait returns on a real terminal state while the Master turn remains active.
- The installed Thin Waiter returns real SQLite Attention with the documented exit codes.
- A fixed-summary CLI notification can complete an end-to-end idle wake chain after the waiter returns.

### Not established or blocked

- Unloaded TUI resume without a local daemon: failed to resume, despite exit `0`.
- Interrupted TUI queue dispatch: queued only; the direct pause state was not observable.
- Desktop Goal unloaded/interrupted/active-running variants: `NOT_TESTED`.
- A supported Host-native notification channel that injects a non-user event: not found.
- Safe handling of duplicates, cancellation races, late notifications, and permission-derived notifications: `NOT_TESTED`.
- Matched-trial token savings: `INCONCLUSIVE`.

## Recommendation

**`Thin Waiter --notify-codex`: NO-GO for implementation in this round.**

A later research prototype would need, at minimum:

1. An explicit user-authorized notification policy; ordinary queue delivery remains `role=user` and must not smuggle Worker text into user intent.
2. A recovery contract for `exit 0 + resume warning` and interrupted queue pause.
3. Deduplication, cancellation, and late-event rules for terminal and permission Attention.
4. Matched active-wait versus idle-wake trials with attributable Master token usage.
5. Separate validation for unloaded and interrupted Desktop Goal behavior.

No Bridge or Host architecture change was made during this probe.
