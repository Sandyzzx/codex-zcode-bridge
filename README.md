# Codex → ZCode Bridge

**Delegate coding to ZCode from Codex; keep planning, review, and acceptance in Codex.**

> **Preview release.** This build introduces SQLite-backed task state and recovery. It has been exercised on a Windows local installation, but other users' installations and operating systems have not been fully validated. Please read the upgrade notes before installing over a JSON-based version.

[简体中文](README.zh-CN.md) · [Repository](https://github.com/Sandyzzx/codex-zcode-bridge) · [Releases](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

## What it does

Codex delegates bounded development work through an MCP bridge to the local ZCode Agent. Codex can follow progress and interactions, inspect the output, and decide whether to accept, cancel, or continue an attempt. ZCode does **not** automatically inherit the whole Codex conversation; include the necessary requirements and acceptance criteria when delegating.

The bridge supports direct project directories and an optional Git execution worktree. Codex remains responsible for reviewing actual code changes and running independent acceptance checks. A task reported as `completed` is **not** automatically accepted.

## Highlights

- **Task delegation:** submit, track, cancel, and continue ZCode tasks; the accompanying Master skill supports bounded single-step and whole-task delegation guidance.
- **Live feedback:** inspect `zcode_status`, `zcode_events`, `zcode_feedback`, and `zcode_result`; reply to pending permissions or questions through the MCP interaction tools.
- **Model selection:** discover available ZCode provider/model combinations, choose per task, or configure a default.
- **Master token reporting:** the Master Skill can read an explicit `CODEX_THREAD_ID` from the local Codex rollout and report a bounded task-window delta when a baseline was saved before delegation. It never reads provider credentials or substitutes account quotas, session totals, or text estimates.
- **Local concurrency:** run work from different execution directories concurrently while coordinating access to overlapping execution paths.
- **Persistent SQLite state:** durable operations, attempts, claims, event history, cleanup decisions, and crash/restart recovery for **new** tasks.
- **Explicit recovery:** uncertain cleanup blocks unsafe reuse; an exceptional administrative-abandon path exists for verified terminal holds and must not be treated as ordinary cancellation.
- **Optional worktree:** preserve the source project identity while executing in a separate Git worktree. Neither a worktree nor task path hints is a security sandbox.

## Requirements

- **Windows:** the validated local deployment target. macOS and Linux are not yet verified for this release.
- **Node.js >= 24.16.0 and < 25** for SQLite mode. The prior JSON runtime's Node >= 22.18 requirement does not cover SQLite.
- Git, a working local ZCode installation with an authenticated provider, and Codex with plugin/marketplace support.
- A **single-user, trusted-local** environment. Remote/multi-user and hostile same-account process scenarios are outside this preview's Workspace Admission boundary.

ZCode and Node.js are not installed automatically by the marketplace.

## Install the preview

Use the **published Preview tag** rather than `master`. The commands below pin the exact tag shown on the [GitHub prerelease](https://github.com/Sandyzzx/codex-zcode-bridge/releases):

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.3.0-rc.1
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

Alternatively, register the tagged repository marketplace, then install **Zcode Bridge** in Codex's Plugins Directory. Start a new conversation and review the plugin's `SessionStart` hook. First-run discovery locates the local ZCode runtime and provider settings; it does not copy credentials. Use `zcode_doctor` for installation diagnostics.

**First activation on a new installation:** after installing the Preview, explicitly select the SQLite Authority before starting the Bridge:

```powershell
$settings = Join-Path $HOME '.codex\codex-zcode-bridge'
New-Item -ItemType Directory -Path $settings -Force | Out-Null
@'
{
  "schema_version": 1,
  "authority": "sqlite"
}
'@ | Set-Content -LiteralPath (Join-Path $settings 'authority.json') -Encoding ascii
```

The first SQLite startup creates `${LOCALAPPDATA}\CodexZCodeBridge\state\bridge.sqlite` with a fresh-install receipt. Ordinary local project directories and optional Git worktrees do **not** require a `trusted-local-policy.json` or a manually maintained `workspace_roots` list. Use this activation step only when no legacy Bridge `.tasks` data exists; installations with existing JSON tasks must use the stop-the-world migration path below.

## Important: upgrading from JSON storage

**Complete or save important tasks before upgrading.** This release deliberately does **not** migrate old JSON task lifecycles into SQLite:

- **`queued`** tasks are not automatically dispatched after switching.
- **`running`** tasks must be allowed to finish or safely cancelled before shutdown.
- **`waiting_for_master`** tasks must be reviewed or their handoff instructions saved.
- Old tasks cannot automatically **Resume** or **Continue** in the new SQLite database. Re-submit any unfinished work as a new task when appropriate.

The supported design is a **stop-the-world switch**: stop the old JSON writer and workers, verify shutdown, preserve the entire legacy JSON task tree as an immutable/read-only archive, then publish an **empty** SQLite Authority for future tasks. It is **not** a history conversion or an automatic in-place upgrade. Do not delete the archive. Never run a second cutover against an already-published SQLite Authority; after SQLite accepts new writes, restoring a pre-switch JSON snapshot is not a safe rollback.

**For an existing installation, do not merely switch an `authority.json` value by hand.** Follow the matching release's validated migration procedure and confirm the target data roots, archive, published receipt and absence of active workers. If a packaged upgrade procedure for your environment is not available, defer upgrading and keep the prior JSON installation until the procedure is verified.

## Everyday use

1. Open the relevant local project in Codex.
2. Ask Codex to delegate a bounded task to ZCode, including the required context and acceptance criteria.
3. Monitor events and interactions; review the resulting code, logs, tests, and reported usage.
4. Accept the result or continue with a focused follow-up task. A successful Worker result is not a substitute for review.

If an MCP request times out, query the existing Task ID before submitting again; use stable operation identifiers for retries when supported. The Bridge's persisted state is designed to prevent unintended duplicate attempts.

## Configuration

On Windows, first-run runtime configuration is stored under `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json`. Common overrides include the ZCode runtime path, provider configuration paths, default provider/model, execution mode, worker concurrency and timeouts. Use the discovered locations rather than copying paths from somebody else's machine.

SQLite's production database and archive must be **separate** from the JSON source task directory; their actual locations depend on the installation/upgrade configuration. Do not edit SQLite tables, authority receipts, or migration markers manually. The default ZCode execution mode may allow broad local tool permissions: use an approval-based mode when appropriate and do not place secrets in prompts.

## Limits and troubleshooting

- Only a Windows single-user local deployment has received real ZCode Provider and production SQLite cutover validation in this development cycle. A Preview is not a cross-platform or general-availability certification.
- ZCode Start Plan is not established as a supported Bridge path in this release; provider capabilities depend on the user's local ZCode installation.
- A worker can exit without committing a Result. In that case the bridge intentionally retains a cleanup hold rather than guessing that resource cleanup succeeded. Do not clear holds by editing the database or killing unidentified processes. Preserve diagnostic evidence and use documented, verified recovery procedures.
- ZCode Desktop may refresh its workspace/session index after the Bridge task is created.
- A Git worktree is not a sandbox. Permissions and access are governed by the local operating-system account and the selected execution mode.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/INTERFACES.md`](docs/INTERFACES.md), and the accepted ADR-016 / ADR-017 decisions for implementation contracts. Source builds require the repository's development dependencies; standard plugin installation does not require cloning or `npm install`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party attributions.
