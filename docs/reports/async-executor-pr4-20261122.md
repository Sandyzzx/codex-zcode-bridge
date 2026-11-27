# Async Executor PR 4 Evidence

> Status: RESEARCH
> Date: 2026-11-22
> Branch: `codex/async-executor-pr4-20261122` (stacked on PR 3)
> Integration baseline: `origin/preview@1bf039fda2ccfd17a992458a871bddd7b48b38c1`
> Conclusion: `IMPLEMENTED — PARTIAL`

## Scope

PR 4 adds a loopback-only Task Web Console over the same Executor Control
Client. It does not create tasks, call models, open SQLite, own Worker/Runtime
lifecycle, or add a second scheduler.

## Verification

| Check | Status | Evidence |
|---|---|---|
| TypeScript typecheck | `PASS` | `npm run typecheck` |
| Test compilation/assets | `PASS` | `npm run build:test` |
| Web security and read routes | `PASS` | `web-console.test.ts`: loopback session/HTML/list/events/result |
| Mutation authorization | `PASS` | missing CSRF and foreign Origin rejected; valid Cancel/Reply forwarded |
| Input bounds | `PASS` | invalid Host/task ID and >64 KiB body rejected |
| Static architecture boundary | `PASS` | Web source has no Manager/Store/Worker/Adapter/Host imports |
| Plugin build | `PASS` | `npm run build`; `dist/web-console.mjs` generated |
| Plugin validation | `PASS` | `npm run validate:plugin` |
| Bundled HTTP smoke | `PASS` | isolated Executor + `web-console.mjs`; session returned `active`, CSRF present, page 200 |
| Console close independence | `PASS` | after Console close, `task-cli executor status` still returned same active lease |
| Full local regression | `NOT_RUN` | deferred to unified release-candidate gate |
| Desktop-close and paid Runtime | `NOT_RUN` | no Owner Desktop shutdown or paid model request |

The HTTP smoke created no Task, spawned no Worker, and made no model request.
Console shutdown closed only its local HTTP listener and Control Client; the
Executor remained active until the explicit Task CLI stop.

## Boundaries

The Console exposes no task creation, model settings, filesystem, shell, SQLite,
Executor shutdown, or arbitrary proxy endpoint. Full Result output over HTTP is
capped at 2 MiB; larger evidence must use the Task CLI's explicit file output.

This is a stacked candidate and must not merge into Preview or be published
until the complete Executor chain and its independent release gates pass.
