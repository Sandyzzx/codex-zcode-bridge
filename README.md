# Codex ZCode Bridge

[简体中文](README.zh-CN.md) · [Releases](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

Codex ZCode Bridge connects Codex with the official ZCode Agent Runtime on your PC. Delegate a development task to ZCode, follow its progress across interruptions, and have Codex review the result before accepting it.

## Why use Bridge?

- **Persistent task delegation.** Send a whole task with its scope and acceptance checks. Bridge saves progress and results so Codex can follow up or recover interrupted work.
- **Official ZCode Runtime.** ZCode uses its own AppServer to run the model and tools. Codex defines the task and reviews the result.
- **Coding Plan and Start Plan.** Use your Z.ai Coding Plan account or select Start Plan, which uses its own official authentication, model entitlement checks, and task-scoped credentials.
- **Task Workspace with explicit diagnostics.** Use a scannable Task inbox to see status, failure reasons, and safe recovery actions, then inspect Attempt, Result, Cleanup, Release, and token usage in the same page. Provider actual cost stays visibly not observed when Bridge has no settlement. Runtime and cost-evidence checks live in Diagnostics.

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

Use one marketplace channel per Codex installation. Preview `2.0.0-preview.17` (prerelease) contains the installed Runtime integration, SQLite v14-only runtime, bounded Event monitoring, opt-in Result summaries, the independent Executor with Thin MCP, automatic Executor crash recovery, the single-page Task Workspace, Async Master handoff with acceptance-driven rework, persisted Owner Binding, and Auto Wake that is enabled by installing the plugin. Stable remains at `v1.7.2`.

Auto Wake needs no per-task authorization file: installing and enabling the plugin is the local trusted Auto Wake contract. The trusted Codex Thread ID comes from the MCP Host request context, is persisted before the Worker starts, and is used for one official Codex Queue delivery after Release. That delivery resumes the original Codex session with its current model, so it can consume additional Codex usage. You can turn Auto Wake off in Task Workspace Diagnostics; Bridge then keeps the Web observation only and submits no Queue message. Queue acknowledgement is not proof that the original Turn started, and `web_notify` is only a fallback observation. A real Codex Host completion-wake E2E with a non-empty engineering delivery passed on 2026-11-24; Desktop fully exited recovery, the notLoaded case and Official Runtime provenance remain unverified.

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

The Task inbox uses scannable rows with Workspace, status, Attempt, model, Plan, usage, updated time, and an inline Attention reason, plus name/workspace search and one shared bucket filter. Needs-attention Tasks sort first; completed Tasks show Review ready / Awaiting review / Review blocked. The header uses the exact published Z icon bytes rather than a text placeholder. The same-page Task workspace puts Overview, Available actions, and Acceptance/Attention before the Attempt timeline, Result, Worker/Master usage, folded Wake/Cleanup/Release evidence, and folded Events. Plan, Discount, Model, and Effort stay separate. When Bridge has no provider settlement, Provider actual cost is explicitly `not_observed` with `bridge_authority_has_no_provider_settlement`; it is never inferred as zero or an estimate.

The former standalone Runtime and Cost Lab main-navigation pages are retired. Runtime inspection, the authorized zero-model protocol probe, candidate report export, and cost-evidence environment/history/verification remain available under **Diagnostics**. Opening the Task Workspace or Diagnostics performs no model, Runtime-probe, or Billing request; each external read or check requires an explicit click. A real Coding Plan verification still requires its explicit confirmation flow.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Historical Coding Plan credit measurement (not a guarantee)](docs/evidence/coding-plan-official-discount-verification-20261118.md)
- [Start Plan compatibility](docs/research/start-plan-official-appserver-compatibility-20261118.md)
- [Troubleshooting, runtime, and upgrades](docs/ZCODE_RUNTIME.md)
- [Plugin safety](plugins/codex-zcode-bridge/SECURITY.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
