# Codex → ZCode Bridge

**Delegate coding to ZCode from Codex; keep planning, review, and acceptance in Codex.**

> **Release channels.** Stable is `v1.6.0` (tag `codex-zcode-bridge-v1.6.0`) for general users, without the unverified experimental Start Plan integration. Preview is `2.0.0-preview.2` on the `preview` branch (Marketplace `codex-zcode-bridge-preview`) for developers and testers; it contains the experimental Start Plan P0 integration whose real-account end-to-end flow is **not** accepted. Windows single-user local installations remain the validated deployment target; other platforms have not been fully validated.

[简体中文](README.zh-CN.md) · [Repository](https://github.com/Sandyzzx/codex-zcode-bridge) · [Releases](https://github.com/Sandyzzx/codex-zcode-bridge/releases)

## What it does

Codex delegates bounded development work through an MCP bridge to the local ZCode Agent. Codex can follow progress and interactions, inspect the output, and decide whether to accept, cancel, or continue an attempt. ZCode does **not** automatically inherit the whole Codex conversation; include the necessary requirements and acceptance criteria when delegating.

The bridge supports direct project directories and an optional Git execution worktree. Codex remains responsible for reviewing actual code changes and running independent acceptance checks. A task reported as `completed` is **not** automatically accepted.

## Highlights

- **Task delegation:** submit, track, cancel, and continue ZCode tasks; the accompanying Master skill supports bounded single-step and whole-task delegation guidance.
- **Live feedback:** inspect `zcode_status`, `zcode_events`, `zcode_feedback`, and `zcode_result`; reply to pending permissions or questions through the MCP interaction tools. Use the optional `zcode_events(wait_for="attention")` mode, or the bundled read-only `dist/wait-task.mjs` for a background host waiter.
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

## Install

Two channels are published. **Use one channel per Codex installation.** Branch refs keep updating; tags are fixed snapshots and do not track later commits.

### Stable (general users)

Use the **published stable tag** rather than `master`:

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-v1.6.0
codex plugin add codex-zcode-bridge@codex-zcode-bridge
```

### Preview (developers and testers)

The preview channel tracks the `preview` branch and contains the experimental Start Plan P0 integration. Marketplace ID: `codex-zcode-bridge-preview`.

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref preview
codex plugin add codex-zcode-bridge@codex-zcode-bridge-preview
```

Update the moving preview marketplace with:

```sh
codex plugin marketplace upgrade codex-zcode-bridge-preview
```

To pin the tested release snapshot instead of following the branch, add the marketplace with the preview tag:

```sh
codex plugin marketplace add https://github.com/Sandyzzx/codex-zcode-bridge.git --ref codex-zcode-bridge-preview-v2.0.0-preview.2
```

Branch refs keep updating with later preview commits; a tag is a fixed snapshot and does not track them. To switch an existing marketplace between a branch and a tag, re-run `marketplace add` with the desired `--ref` (or `codex plugin marketplace remove` first and add again); if the actual behavior differs, verify with `codex plugin marketplace add --help` instead of guessing.

Alternatively, register the tagged repository marketplace, then install **Zcode Bridge** in Codex's Plugins Directory. Start a new conversation and review the plugin's `SessionStart` hook. First-run discovery locates the local ZCode runtime and provider settings; it does not copy credentials. Use `zcode_doctor` for installation diagnostics.

**Automatic SQLite startup:** the first plugin start creates and validates `${LOCALAPPDATA}\CodexZCodeBridge\state\bridge.sqlite` and provisions its default capacity before accepting MCP requests. Marketplace installs and upgrades from the old JSON version use the same bootstrap. No `authority.json`, SQLite activation command, JSON migration command, `trusted-local-policy.json`, or manually maintained `workspace_roots` list is required.

An existing valid SQLite database is reopened without reset. A damaged database, incomplete SQLite state, unsupported schema, or failed integrity check stops startup; the Bridge never falls back to JSON or replaces the database.

## Important: upgrading from JSON storage

**Complete or save important tasks before upgrading.** The new SQLite database starts empty and does **not** migrate old JSON task lifecycles:

- **`queued`** tasks are not automatically dispatched after upgrading.
- **`running`** tasks should be allowed to finish or safely cancelled before shutdown.
- **`waiting_for_master`** tasks should be reviewed or their handoff instructions saved.
- Old tasks cannot automatically **Resume** or **Continue**. Re-submit unfinished work as new tasks when appropriate.

Old JSON files remain untouched and are not read, imported, archived, or deleted by the Bridge. Decide yourself whether to retain them after considering your backup needs. Old task history will not appear in SQLite.

## Everyday use

1. Open the relevant local project in Codex.
2. Ask Codex to delegate a bounded task to ZCode, including the required context and acceptance criteria.
3. Monitor events and interactions; review the resulting code, logs, tests, and reported usage.
4. Accept the result or continue with a focused follow-up task. A successful Worker result is not a substitute for review.

If an MCP request times out, query the existing Task ID before submitting again; use stable operation identifiers for retries when supported. The Bridge's persisted state is designed to prevent unintended duplicate attempts.

## Configuration

On Windows, first-run runtime configuration is stored under `%USERPROFILE%\.codex\codex-zcode-bridge\runtime-config.json`. Common overrides include the ZCode runtime path, provider configuration paths, default provider/model, execution mode, worker concurrency and timeouts. Use the discovered locations rather than copying paths from somebody else's machine.

The SQLite database uses the default per-user data root unless an existing valid SQLite install configuration selects another local root. Do not edit SQLite tables, authority receipts, or bootstrap markers manually.

For the supported Windows single-user local deployment, SQLite uses a fixed trusted-local `yolo` execution profile, It runs with the current Windows account's permissions and is not a sandbox or an elevation mechanism. Ordinary workspace reads, edits, builds, tests, and cleanup inside the task scope can run automatically. Push, merge, tag, release, production Authority changes, deletion outside task scope, credential changes, and access to real production task data still require explicit user authorization. Task prompts, Skills, worktrees, and path lists cannot grant those permissions. Do not place secrets in prompts.

## Limits and troubleshooting

SQLite v14 uses the [ADR-026 Result contract](docs/decisions/ADR-026-sqlite-result-contract.md): a complete canonical TaskResult may contain at most 32 MiB of UTF-8 JSON, with another 256 KiB reserved for the private Worker envelope. Report strings and arrays share the Adapter's text semantics. A rejected report produces an explicit infrastructure failure; uncertain commits retain their recovery fences and are never automatically executed again.

Existing v13 databases require an explicit **offline copy upgrade**; startup never migrates them. Stop every Bridge host/Manager, keep the original data root and configuration, and create an empty destination `state` directory. From the installed plugin root, run:

```powershell
node ./dist/upgrade-sqlite-v14.mjs --source "D:/BridgeOld/state" --destination "D:/BridgeV14/state" --database bridge.sqlite --offline
```

The tool verifies schema, receipts, lifecycle quiescence, rows, events, digests and foreign keys before publishing a receipt. It refuses unresolved operations or unknown writer/poison markers. Use the same Node/SQLite/platform runtime recorded by a v13 cutover receipt. After successful verification, explicitly change the host's `authority.json` `data_root` to `D:/BridgeV14` (the parent of `state`) and start the new version. Production upgrades require separate Owner authorization. Before new writes, rollback means restoring the old configuration and old binary; after new writes, preserve both roots and obtain a forward-fix or reconciled rollback plan. See [the operational details](docs/ZCODE_RUNTIME.md#sqlite-v13--v14-显式升级adr-026).

- Only a Windows single-user local deployment has received real ZCode Provider and production SQLite cutover validation in this development cycle. This release is not a cross-platform or general-availability certification.
- The stable channel does not include Start Plan support. The preview channel contains the experimental Start Plan P0 integration, but real Start Plan account/model end-to-end acceptance has not been performed; provider capabilities still depend on the user's local ZCode installation.
- A worker can exit without committing a Result. In that case the bridge intentionally retains a cleanup hold rather than guessing that resource cleanup succeeded. Do not clear holds by editing the database or killing unidentified processes. Preserve diagnostic evidence and use documented, verified recovery procedures.
- ZCode Desktop may refresh its workspace/session index after the Bridge task is created.
- A Git worktree is not a sandbox. Permissions and access are governed by the local operating-system account and the selected execution mode.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/INTERFACES.md`](docs/INTERFACES.md), and the accepted ADR-016 / ADR-017 decisions for implementation contracts. Source builds require the repository's development dependencies; standard plugin installation does not require cloning or `npm install`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party attributions.
