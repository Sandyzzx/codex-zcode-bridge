# Codex ZCode Bridge

**Connect Codex to the official ZCode Agent Runtime, delegate a bounded development task, and review the result before accepting it.**

[简体中文](README.zh-CN.md) · [Repository](https://github.com/Sandyzzx/codex-zcode-bridge) · [Releases](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

> **Release status.** This branch promotes Preview `2.0.0-preview.4` to the Stable `v1.7.0` line. The `preview` channel remains the integration branch for subsequent work.

## What this is

Codex ZCode Bridge is a task-orchestration plugin that connects Codex to the official ZCode Agent Runtime on the same computer. It is not a model API proxy and it is not a wrapper around a shell command.

| Component | Responsibility |
| --- | --- |
| **Codex** | Defines the task, handles host interaction, follows progress, and performs final review and acceptance. |
| **Bridge** | Exposes MCP tools, orchestrates tasks and attempts, persists state in SQLite, and manages Worker lifecycle and recovery. |
| **ZCode AppServer** | Executes the model turn and owns context construction, tools, streaming, and provider transport. |
| **SQLite Authority** | Stores the authoritative task, result, cleanup, and release lifecycle for the current production architecture. |

Codex does not automatically hand every coding request to ZCode. Delegation happens when the user explicitly asks to use ZCode Bridge, or when an existing explicit session/goal authorization covers the task.

## Model plan support

| Plan | Availability | Authentication and runtime path |
| --- | --- | --- |
| **Z.ai Start Plan** | Stable `v1.7.0` and Preview | Discovers the official logged-in account credential, performs the required entitlement check for the selected model, and supplies the official runtime through a per-task private credential lease. |
| **Z.ai Coding Plan** | Stable `v1.7.0` and Preview | Uses the existing official Coding Plan account/API-key path through the ZCode Runtime. |

Start Plan and Coding Plan are different account and authentication paths. Bridge selects the path from the task's provider, model, and plan selection; both paths ultimately execute through the official ZCode AppServer.

### Verified Start Plan path

The `v1.7.0` line includes one real Windows acceptance run with these facts:

- Official ZCode AppServer `0.17.1`.
- Provider `account:bigmodel-start-plan`.
- Model `GLM-5.3-Flash`.
- Three main-turn model iterations, all with HTTP `200`.
- Successful `Write` and `Read` tool calls.
- Valid AgentReport schema.
- Result committed, Worker exited, process tree cleaned up, and private lease released.
- One Billing GET was observed for the task.
- No HTTP `405`, provider code `3012`, or unusual-activity response was observed.

This evidence covers **only `GLM-5.3-Flash` on Windows**. It does not prove every Start Plan model, every ZCode runtime version, or every platform. Other models remain subject to the official provider registry and the live entitlement of the signed-in account.

## Core capabilities

- **Task dispatch:** submit one bounded, independently reviewable development task with `zcode_task`; Codex's Master skill can choose a whole-task or staged delivery strategy.
- **Persistent orchestration:** SQLite records operations, attempts, claims, results, cleanup, release, and restart recovery state.
- **Worker lifecycle:** Bridge starts and observes an isolated Worker, verifies the ZCode process tree, and keeps an explicit Hold when cleanup cannot be verified.
- **Progress and interaction:** use `zcode_status`, `zcode_feedback`, `zcode_events`, `zcode_result`, and `zcode_interaction_reply` to follow a task and answer a surfaced permission or user-input request.
- **Model selection:** read available provider/model combinations, choose a model per task, or configure a Bridge default.
- **Provider integration:** route Start Plan or Coding Plan through the official runtime without turning Bridge into a second request builder.
- **Independent acceptance:** `completed` means execution and report normalization finished; it does not mean Codex accepted the code.

## MCP tool surface

| Area | Tools |
| --- | --- |
| Setup and model discovery | `zcode_doctor`, `zcode_model_catalog`, `zcode_default_model`, `zcode_set_default_model`, `zcode_clear_default_model` |
| Task lifecycle | `zcode_task`, `zcode_status`, `zcode_feedback`, `zcode_events`, `zcode_result`, `zcode_continue`, `zcode_cancel` |
| Interaction | `zcode_interaction_reply` |

`zcode_continue` is for evidence-driven rework, a required decision, controlled recovery, or report repair. It is not a general scheduler for the next implementation step.

## Requirements

- **Windows** is the currently validated local deployment target for the production SQLite path and the real Start Plan acceptance run. Linux and macOS have synthetic/CI coverage only.
- **Stable 1.7.0:** Node.js `>=24.16.0` and `<25`.
- Git, Codex with plugin/marketplace support, and a working local ZCode installation.
- A signed-in official ZCode account with the plan and model entitlement required by the selected task.
- A **single-user, trusted-local** environment. This is not a multi-user isolation boundary or a remote sandbox.

Node.js and ZCode are not installed by the marketplace plugin.

## Installation

Use one release channel per Codex installation. Branch refs move with later commits; tags are fixed snapshots.

### Stable

Stable `v1.7.0` includes SQLite-only orchestration plus Start Plan and Coding Plan integration:

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.7.0
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

### Preview

Preview remains the integration channel for post-1.7 work. Marketplace ID: `codex-zcode-bridge-preview`.

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref preview
codex plugin add codex-zcode-bridge@codex-zcode-bridge-preview
```

Update the moving Preview marketplace with:

```sh
codex plugin marketplace upgrade codex-zcode-bridge-preview
```

To pin the accepted Preview snapshot instead of following the branch:

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-preview-v2.0.0-preview.4
```

To switch an existing marketplace between branch and tag refs, re-run `marketplace add` with the desired `--ref` or remove and add the marketplace. Verify the command with `codex plugin marketplace add --help` if your Codex version differs.

After installation, start a new Codex conversation so the plugin and MCP tools are loaded. Review and trust the plugin's `SessionStart` hook, then run `zcode_doctor` if setup needs diagnosis.

## Use it

1. Open the project in Codex.
2. Explicitly ask Codex to use ZCode Bridge for the task.
3. Provide the goal, relevant files, constraints, allowed scope, and acceptance checks.
4. Let Codex's Master workflow select a whole-task or staged strategy and dispatch the task.
5. Follow progress with `zcode_status`, `zcode_feedback`, and `zcode_events`; answer a surfaced permission request only when the requested action is actually authorized.
6. Inspect the workspace diff, test evidence, and `zcode_result` independently before accepting the work.

Example prompt:

```text
Use ZCode Bridge to run this task with Start Plan GLM-5.3-Flash.
Fix the failing parser test in this repository. Keep the change limited to
the parser and its tests, run the focused test command, and return a valid
AgentReport. Do not commit or push.
```

For planning, inspection, or an independent second opinion, ask Codex not to delegate and keep the work in the current Host.

### Workspace and worktree boundary

The calling host chooses the project workspace and, if needed, creates and prepares a Git worktree. Bridge validates and uses the supplied paths but never creates, selects, or deletes a worktree. A worktree is a filesystem layout choice, not an operating-system security sandbox.

## SQLite startup and upgrades

New installations create and validate:

```text
${LOCALAPPDATA}\CodexZCodeBridge\state\bridge.sqlite
```

The database must pass integrity and lifecycle checks before MCP requests are accepted. Bridge does not fall back to JSON storage.

When startup finds a valid Schema v13 Authority, Bridge performs a guarded copy upgrade to v14 under the existing cross-process bootstrap lock. The original database is retained as a sibling v13 backup, the published v14 Authority is verified before the durable upgrade marker is cleared, and occupied Operations, Holds, and Recovery evidence remain intact:

```powershell
node ./dist/upgrade-sqlite-v14.mjs --help
```

The offline upgrade tool remains available for explicit operator workflows. Corrupt or non-v13 databases stay on the existing fail-closed validation path. Do not edit lifecycle tables or clear a Hold to force an upgrade. See [ZCODE_RUNTIME.md](docs/ZCODE_RUNTIME.md) for the full contract.

## Security boundary

The `v1.7.0` line runs on the current Windows account with the fixed trusted-local `yolo` profile. Ordinary reads, edits, builds, tests, and task-scoped cleanup can run without per-step approval. Push, merge, tag, release, production Authority changes, deletion outside the task scope, credential changes, and production task-data access still require explicit user authorization.

Prompts, Skills, path lists, and worktree selection do not create those permissions. Do not put credentials, JWTs, private keys, or sensitive account data into a task prompt. A task's `allowed_paths` and `forbidden_paths` are instructions, not an OS-enforced sandbox.

## Current limits

- **Start Plan real E2E:** Windows only; one model (`GLM-5.3-Flash`) has published evidence.
- **Other Start Plan models:** dependent on the official registry and live account entitlement; not individually certified here.
- **Linux/macOS:** synthetic/CI coverage only; no real Start Plan certification.
- **CAPTCHA and unusual activity:** Bridge does not solve CAPTCHA or bypass account controls. Entitlement failures fail closed and may require the user to resolve the condition in the official ZCode client.
- **Host Portability and Companion Service:** architecture research only; they are not delivered features in `v1.7.0`.
- **JSON storage and the retired CLI execution chain:** not current production paths. Old JSON task histories are not imported into SQLite.
- **A worker can exit without committing a Result.** Bridge intentionally retains cleanup evidence and a Hold rather than guessing that resources were released.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Interfaces and lifecycle contracts](docs/INTERFACES.md)
- [Runtime and SQLite upgrade details](docs/ZCODE_RUNTIME.md)
- [Plugin safety notes](plugins/codex-zcode-bridge/SECURITY.md)
- [Master skill](plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md)
- [`v1.7.0` release](https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-v1.7.0)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
