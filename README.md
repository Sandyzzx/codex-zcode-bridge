# Codex ZCode Bridge

**Connect Codex to the official ZCode Agent Runtime, delegate a bounded development task, and review the result before accepting it.**

[简体中文](README.zh-CN.md) · [Repository](https://github.com/Sandyzzx/codex-zcode-bridge) · [Releases](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

> **Release status.** Stable is `v1.7.1`. Preview `2.0.0-preview.8` adds host-authorized cancellation for queued Launch Intent and supported cleanup Holds, with fresh process-tree proof bound to durable recovery evidence. It retains the Preview.7 authentication, runtime and SQLite contracts. It is a prerelease for Windows x64 with ZCode Desktop `3.18.2.10443`; it does not promote a new Stable version.

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
| **Z.ai Start Plan** | Stable `v1.7.1` and Preview | Discovers the official logged-in account credential, performs the required entitlement check for the selected model, and supplies the official runtime through a per-task private credential lease. |
| **Z.ai Coding Plan** | Stable `v1.7.1` and Preview | Uses the existing official Coding Plan account/API-key path through the ZCode Runtime. |

Start Plan and Coding Plan are different account and authentication paths. Bridge selects the path from the task's provider, model, and plan selection; both paths ultimately execute through the official ZCode AppServer.

## Official ZCode Billing & Plan Support

This integration branch makes the installed official ZCode AppServer the verified
Coding Plan execution runtime on Windows x64. It does not vendor a second signing
implementation: Bridge validates the installed bundle, provider configuration and
runtime host against an exact version/size/SHA-256 manifest, then reuses the
existing Official Host authentication and process lifecycle.

```yaml
VERIFIED_MODEL: GLM-5.3-Flash
VERIFIED_PLAN: PERSONAL_CODING_PLAN
VERIFIED_ZCODE: 3.18.2.10443
VERIFIED_RUNTIME: INSTALLED_OFFICIAL_APPSERVER
VERIFIED_BUNDLE_SHA256: 08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c
VERIFIED_EFFECTIVE_EXTRA_RATIO: approximately 0.67
```

The published V5 evidence contains a native control and three Bridge runs. The
official ledger consistently showed an extra `0.67` credit multiplier, equivalent
to roughly `1.5x` model usage for the tested profile. This is a **credit
multiplier**, not proof of a universal package-quota `1.5x` grant.

The production integration branch independently reproduced the result through
the built Bridge MCP, Manager, SQLite Worker and installed Official AppServer:
`22,735` Tokens settled at `1.7666` credits versus `2.636755` normal, an effective
extra ratio of `0.6699901963`. The official hourly ledger settled after the first
few reads, so the reconciliation used a later same-hour snapshot without a second
model request.

The time-of-day multiplier is separate from the campaign multiplier. For example,
off-peak `0.5` multiplied by the extra `0.67` is an effective `0.335` of the base
credit formula; a successful task and matching Tokens alone do not prove the extra
discount. The final authority is the official before/after ledger delta.

Compatibility is fail-closed. If the installed Desktop version, bundle,
same-root builtin provider configuration, runtime host, Node range, or platform
does not match the manifest, Coding Plan reports `OFFICIAL_RUNTIME_UNVERIFIED`
and does not claim `0.67`.

### Cost Lab

Cost Lab is the local runtime, Token and official-credit verification UI:

```powershell
npm run build
npm run cost-lab:web
```

The server binds only to `127.0.0.1`. Page load makes no model request. Environment
checks inspect installation identity, hashes, Node compatibility, credential-file
metadata, billing-reader availability and a zero-model AppServer protocol smoke.
A real Coding Plan verification requires an explicit browser confirmation, makes
one fixed `GLM-5.3-Flash` / reasoning-low task through the built production MCP
and Worker path, and reconciles fresh official before/after ledger snapshots.
History and exports are redacted.

See [Cost Lab usage](tools/cost-lab/README.md) and the
[formal V5 evidence](docs/evidence/coding-plan-official-discount-verification-20261118.md).

### Verified Start Plan path

Preview.3 established the Start Plan path with one real Windows acceptance run. Preview.6 separately completed a real Coding Plan E2E and a real Start Plan core functional E2E through the Official Host path, including Runtime Events, Usage, tools, Result, Cleanup, and Release. Preview.7 preserves that runtime and auth path without repeating real model traffic. The historical full Start Plan Workspace acceptance remains `FAIL` because of a PowerShell cache written outside the declared task files; that failure is retained and not rewritten as a pass.

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

The current integration branch also completed an offline Start Plan audit against
the same installed AppServer bundle. Start Plan remains an independent unsigned
provider path with different credentials, Runtime Auth, Runtime Headers and
`zcode-plan/anthropic` gateway. Live Start Plan E2E, CAPTCHA behavior and any Start
Plan discount are `NOT_VERIFIED`; the Coding Plan `0.67` result must not be
promoted to Start Plan. See the
[offline compatibility report](docs/research/start-plan-official-appserver-compatibility-20261118.md).

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

- The fixed Official Host production bundle is supported on **Windows x64**. Production Worker adapter selection fails closed with `unsupported_worker_platform` on Linux, macOS, and Windows non-x64; CI exercises that rejection without claiming a production execution path.
- **Preview 2.0.0-preview.8:** Windows x64, Node.js `24.16.0`, and an installed official ZCode Desktop `3.18.2.10443`.
- Git, Codex with plugin/marketplace support, and a working local ZCode installation.
- A signed-in official ZCode account with the plan and model entitlement required by the selected task.
- A **single-user, trusted-local** environment. This is not a multi-user isolation boundary or a remote sandbox.

Node.js and ZCode are not installed by the marketplace plugin.

Desktop ZCode `3.18.0` and `3.18.1` remain `NOT_VERIFIED` for Preview.7; they are not declared incompatible. Real OAuth refresh/account rotation and cross-machine artifact reproduction also remain `NOT_VERIFIED`. These are accepted Preview-only risks and are not extended to Stable.

## Installation

Use one release channel per Codex installation. Branch refs move with later commits; tags are fixed snapshots.

### Stable

Stable `v1.7.1` is the last Stable release. Preview.7 is the current fixed preview snapshot; Preview.6 added Official Host, official authentication reuse, and R7 Runtime Events/Usage:

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.7.1
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

### Preview

Preview is the channel for SQLite-only orchestration, Start Plan, and Coding Plan integration. Marketplace ID: `codex-zcode-bridge-preview`.

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
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-preview-v2.0.0-preview.6
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

New Preview installations create and validate:

```text
${LOCALAPPDATA}\CodexZCodeBridge\state\bridge.sqlite
```

The database must pass integrity and lifecycle checks before MCP requests are accepted. Bridge does not fall back to JSON storage.

The production Lifecycle Gate upgrades an existing Schema v13 Authority to v14 while holding the bootstrap lock. A conservative offline copy upgrade remains available for recovery and controlled deployment when every Bridge Host, Manager, and Worker is stopped:

```powershell
node ./dist/upgrade-sqlite-v14.mjs `
  --source "D:/BridgeOld/state" `
  --destination "D:/BridgeV14/state" `
  --database bridge.sqlite `
  --offline
```

The source database is retained in the offline workflow. After the copy is verified, change the host's `authority.json` `data_root` to `D:/BridgeV14`. Unknown schemas, corrupt databases, active writers, and unexplained lifecycle state still fail closed. Do not edit lifecycle tables or clear a Hold to force an upgrade. See [ZCODE_RUNTIME.md](docs/ZCODE_RUNTIME.md) for the full contract.

## Security boundary

Preview runs on the current Windows account with the fixed trusted-local `yolo` profile. Ordinary reads, edits, builds, tests, and task-scoped cleanup can run without per-step approval. Push, merge, tag, release, production Authority changes, deletion outside the task scope, credential changes, and production task-data access still require explicit user authorization.

Prompts, Skills, path lists, and worktree selection do not create those permissions. Do not put credentials, JWTs, private keys, or sensitive account data into a task prompt. A task's `allowed_paths` and `forbidden_paths` are instructions, not an OS-enforced sandbox.

## Current limits

- **Start Plan real E2E:** Windows only; one model (`GLM-5.3-Flash`) has published evidence.
- **Other Start Plan models:** dependent on the official registry and live account entitlement; not individually certified here.
- **Linux/macOS:** unsupported for production execution and rejected before Adapter construction; no real Start Plan or model traffic.
- **CAPTCHA and unusual activity:** Bridge does not solve CAPTCHA or bypass account controls. Entitlement failures fail closed and may require the user to resolve the condition in the official ZCode client.
- **Host Portability and Companion Service:** architecture research only; they are not delivered features in Preview.7.
- **JSON storage and the retired CLI execution chain:** not current production paths. Old JSON task histories are not imported into SQLite.
- **A worker can exit without committing a Result.** Bridge intentionally retains cleanup evidence and a Hold rather than guessing that resources were released.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Interfaces and lifecycle contracts](docs/INTERFACES.md)
- [Runtime and SQLite upgrade details](docs/ZCODE_RUNTIME.md)
- [Plugin safety notes](plugins/codex-zcode-bridge/SECURITY.md)
- [Master skill](plugins/codex-zcode-bridge/skills/zcode-bridge/SKILL.md)
- [Preview.8 release](https://github.com/Sandyzzx/codex-zcode-bridge/releases/tag/codex-zcode-bridge-preview-v2.0.0-preview.8)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
