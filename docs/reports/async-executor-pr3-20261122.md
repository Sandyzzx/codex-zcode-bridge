# Async Executor PR 3 Evidence

> Status: RESEARCH
> Date: 2026-11-22
> Branch: `codex/async-executor-pr3-20261122` (stacked on PR 2.5)
> Integration baseline: `origin/preview@1bf039fda2ccfd17a992458a871bddd7b48b38c1`
> Conclusion: `IMPLEMENTED — PARTIAL`

## Scope

PR 3 adds the Task CLI and the shared Executor Control-facing task management
surface. It does not add a local SQLite writer, scheduler, recovery engine,
Worker path, Web server, or Wake path.

The CLI is shipped as both:

- `dist/src/cli/main.js` for source/npm builds;
- `plugins/codex-zcode-bridge/dist/task-cli.mjs` for the self-contained plugin.

The standalone Executor is shipped as
`plugins/codex-zcode-bridge/dist/executor.mjs`; the CLI resolves it beside the
bundled CLI and otherwise falls back to the source `dist/src/executor/main.js`.

## Evidence

| Check | Status | Evidence |
|---|---|---|
| TypeScript typecheck | `PASS` | `npm run typecheck` |
| Test compilation/assets | `PASS` | `npm run build:test` |
| Task CLI focused tests | `PASS` | `task-cli`, `executor-process`, and architecture boundary suites: 22/22 |
| Executor/Core lifecycle regressions | `PASS` | 22 tests including existing single-owner, shutdown, fake Worker and Thin MCP paths |
| Bundled plugin build | `PASS` | `npm run build`; generated `task-cli.mjs` and `executor.mjs` |
| Plugin structural/security validation | `PASS` | `npm run validate:plugin` |
| Bundled executor control smoke | `PASS` | isolated `.run` root: start, status, second start (`already_running`), stop |
| Bounded Task enumeration | `PASS` | existing lifecycle-port test through `readTaskProjections` |
| Full local regression | `NOT_RUN` | intentionally deferred under the unified development/release policy |
| Real Desktop close / Official Runtime | `NOT_RUN` | no Owner Desktop shutdown and no paid model authorization |

The bundled executor smoke performed no Task creation, Worker spawn, model
request, SQLite production-root mutation, or Desktop operation.

## Behavioral Notes

- `executor start` probes the existing Control Pipe and does not spawn a second
  process when an active Executor is already present. Lease arbitration remains
  the cross-process authority.
- `--accept-unleased-transition` is passed only to the one spawned process and
  cannot bypass a live lease owner.
- `executor stop` waits for the pipe to disappear; an accepted-but-not-confirmed
  shutdown returns a non-zero exit and `UNKNOWN`, not success.
- Task reads and writes use `ExecutorControlClient`; Task list pagination is
  bounded and cursor-based.
- Result output defaults to the shared ADR-047 summary and requires an absolute
  `--output` path when full output would exceed the 1 MiB stdout budget.

## Release Boundary

This is a stacked candidate, not a Preview fact and not a release approval.
PR 3 must remain unmerged until the whole Executor chain reaches the unified
Release Candidate gate and the real Desktop-close E2E is separately resolved.
