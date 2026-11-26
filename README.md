# Codex ZCode Bridge

[简体中文](README.zh-CN.md) · [Releases](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

Codex ZCode Bridge connects Codex with the official ZCode Agent Runtime on your PC. Delegate a development task to ZCode, follow its progress across interruptions, and have Codex review the result before accepting it.

## Why use Bridge?

- **Persistent task delegation.** Send a whole task with its scope and acceptance checks. Bridge saves progress and results so Codex can follow up or recover interrupted work.
- **Official ZCode Runtime.** ZCode uses its own AppServer to run the model and tools. Codex defines the task and reviews the result.
- **Coding Plan and Start Plan.** Use your Z.ai Coding Plan account or select Start Plan, which uses its own official authentication, model entitlement checks, and task-scoped credentials.
- **Task Workspace with explicit diagnostics.** Use one scannable task list to see status, failure reasons, and safe recovery actions, then inspect Attempt, Result, technical evidence, and token usage in the same page. Provider actual cost stays visibly not observed when Bridge has no settlement. Runtime and cost-evidence checks live in Diagnostics.

## Plans in Preview

Bridge reuses the locally installed ZCode Runtime; the models actually available, plan allowances, billing multipliers, and usage permissions are decided by ZCode and the respective model provider — not by Bridge.

| Plan | Statement |
| --- | --- |
| **Z.ai Coding Plan** | Normal authorized model calls are supported. Historical real Windows end-to-end execution exists with the installed official AppServer. Bridge makes no promise about credit multipliers or other promotional benefits; current plan policy is whatever Z.ai reports. |
| **Z.ai Start Plan** | The technical adaptation is retained. Current official policy limits Start Plan to the official ZCode client, so Bridge makes no availability promise and does not bypass official access restrictions. |

Verified ZCode Desktop installs: `3.18.2.10443` (full historical verification), `3.19.0.10774` (protocol smoke + one real Coding Plan execution), and `4.0.0.10870` (protocol smoke + a full real-task E2E through the shipped plugin artifacts on 2026-11-24). Other safe installs run without a version gate; their compatibility stays unverified until listed here. README lists the verified versions, but no static version whitelist or discount-verification result is used as a task-execution gate (ADR-054).

Plan policies may change at any time — campaigns, allowances, billing rules, and usage scope follow the latest official policy. Bridge's core goal is reliable async agent dispatch, durable task persistence, lifecycle management, and token-consumption optimization, not obtaining plan discounts.

## Install

For Preview, use **Windows x64** and **Node.js `24.16.0`**. Any safe official ZCode Desktop installation runs (ADR-054); versions with completed real verification are listed below. Sign in to ZCode with access to your chosen plan and model. You also need Git and Codex with plugin support. Install Node.js and ZCode separately.

Use one marketplace channel per Codex installation. Preview `2.0.0-preview.18` (prerelease) contains the installed Runtime integration, SQLite v14-only runtime, bounded Event monitoring, opt-in Result summaries, the independent Executor with Thin MCP, automatic Executor crash recovery, operation-scoped Worker uncertainty, authorized cleanup for abnormal tasks, the single-page Task Workspace, Async Master handoff with acceptance-driven rework, persisted Owner Binding, and Auto Wake that is enabled by installing the plugin. The plugin manifest declares the Owner-approved Z artwork at the top-level Codex `interface`, so plugin pages use it instead of the generic fallback. Stable remains at `v1.7.2`.

Auto Wake needs no per-task authorization file: installing and enabling the plugin is the local trusted Auto Wake contract. The trusted Codex Thread ID comes from the MCP Host request context, is persisted before the Worker starts, and is used for one official Codex Queue delivery after Release. That delivery resumes the original Codex session with its current model, so it can consume additional Codex usage. You can turn Auto Wake off in Task Workspace Diagnostics; Bridge then keeps the Web observation only and submits no Queue message. Queue acknowledgement is not proof that the original Turn started, and `web_notify` is only a fallback observation. A real Codex Host completion-wake E2E with a non-empty engineering delivery passed on 2026-11-24. On 2026-11-25 a second real Host run passed the acceptance-driven loop: Worker completion and Result readback, a failed independent acceptance, automatic `zcode_continue` without user approval, a second Attempt, one Queue delivery per Attempt, a new Turn on the original Thread, and final `GOAL ACCEPTED` only after the same acceptance command passed. Desktop fully exited recovery, the notLoaded case, Windows reboot recovery, strict Wake C/D and Official Runtime provenance remain unverified.

### Preview

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref preview
codex plugin add codex-zcode-bridge@codex-zcode-bridge-preview
```

To update the Preview marketplace:

```sh
codex plugin marketplace upgrade codex-zcode-bridge-preview
```

### Stable

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.7.2
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

Start a new Codex conversation after installation and review the plugin's `SessionStart` hook. If setup fails, ask Codex to run `zcode_doctor`.

## Delegate your first task

1. Open the project in Codex and explicitly ask to use ZCode Bridge. Specify your plan and model if you have a preference.
2. Give Codex the goal, the files it may change, and the tests or checks you expect.
3. Ask for progress when needed. Codex can use `zcode_status`, `zcode_feedback`, or `zcode_events` to follow the task.
4. Ask Codex to review the workspace diff, test evidence, and `zcode_result` before accepting the work.

> Use ZCode Bridge with Coding Plan GLM-5.3-Flash. Fix the failing parser test, limit edits to the parser and its tests, run the focused test, and have Codex review the result. Do not commit or push.

Run Bridge in a trusted single-user environment. A Git worktree helps organize edits. Filesystem permissions still belong to your OS account.

## Inspect tasks and diagnostics

Task receipts link to the local Task Workspace. From a Preview source checkout:

```powershell
npm ci
npm run build
npm run bridge:cli -- executor start
npm run bridge:cli -- task console-url <task_id>
```

The task list uses at most three lines per item: task name plus one primary status; only the Workspace, model, Plan, Attempt, and updated metadata that is actually observed; and an inline failure or Attention reason only when needed. Internal task/workflow identifiers, full workspace paths, duplicate usage, and missing fields stay out of the normal view. Running / Needs attention / Execution completed is one compact clickable summary line, and the list has name/workspace search plus a shared bucket filter. Needs-attention Tasks sort first; execution-completed Tasks show Awaiting review or Review blocked. The header uses the exact published Z icon bytes rather than a text placeholder. The same-page detail keeps only Attempt, Workspace, and Updated in its header, with the full workspace path expandable. It then shows Problem and actions, Work history, Execution, and folded Technical details. Work history keeps the Attempt timeline and places the selected Result summary immediately below it without a duplicate Result heading, Attempt number, or status badge. Execution starts as one `Model · Plan · Discount · Total tokens` line and expands to observed token, cache, Effort, provider-cost, Worker, and Master details. Missing fields are hidden and summarized once as not observed rather than rendered as repeated `Not observed` or zero. Wake, Cleanup, Release, and Events stay folded. When Bridge has no provider settlement, Provider actual cost is never inferred as zero or an estimate.

Execution completed is not Master acceptance. The current Authority does not expose a Master acceptance decision, so the page reports that acceptance is not recorded and never fabricates an accepted state.

The former standalone Runtime and Cost Lab main-navigation pages are retired. Runtime inspection, the authorized zero-model protocol probe, candidate report export, and cost-evidence environment/history/verification remain available under **Diagnostics**. Opening the Task Workspace or Diagnostics performs no model, Runtime-probe, or Billing request; each external read or check requires an explicit click. A real Coding Plan verification still requires its explicit confirmation flow.

## Executor lifecycle

- **Start:** Host/CLI/Web requests first probe for a healthy Executor. If one is running, they connect to it; otherwise the recovery coordinator archives a proven-exited Lease and starts one Executor per Authority Root. A live or unknown historical Worker is retained with its Operation while unrelated tasks continue.
- **Close:** An Executor closes only when it is idle and still owns its Lease. Unverified Cleanup, pending work, an unknown Lease, or an unsafe Authority Root remains open and reports the blocker.
- **Host restart:** Host reconnects to the existing Executor through the same control channel. If the channel is unavailable, it performs one recovery attempt; it does not blindly spawn a second Executor or second Worker.
- **WebUI:** The local Task Workspace talks to that Executor's SQLite Authority for reads and actions. It has no separate task state or database.
- **Authorize cleanup:** For a selected abnormal task, choose **Authorize cleanup**. Confirmation explicitly accepts that a possibly live Worker may keep writing the Workspace. SQLite keeps all evidence, marks the administrative release as cleanup-unverified, releases only that Bridge occupancy, and never respawns the abandoned Attempt.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Historical Coding Plan credit measurement (not a guarantee)](docs/evidence/coding-plan-official-discount-verification-20261118.md)
- [Start Plan compatibility](docs/research/start-plan-official-appserver-compatibility-20261118.md)
- [Troubleshooting, runtime, and upgrades](docs/ZCODE_RUNTIME.md)
- [Plugin safety](plugins/codex-zcode-bridge/SECURITY.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
