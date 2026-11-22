# Async Executor PR 5 Evidence

> Status: IMPLEMENTED — PARTIAL / BLOCKED
> Date: 2026-11-22（Asia/Shanghai）
> Baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1` + stacked PR 4 candidate
> Decision: [ADR-051](../decisions/ADR-051-executor-wake-delivery.md)

## Scope

PR 5 adds an optional, one-shot Wake Adapter inside the existing Executor. It
runs only after the original Attempt has a committed terminal Result and the
Operation has durably reached `released`. It does not own Task scheduling,
Result, Cleanup, Release, Recovery, or a second persistence authority.

```text
Queue first for confirmed loaded/idle exact-config Thread
Web Notify default fallback for every uncertain condition
SQLite v14 observation_recorded for bounded Wake facts
```

## Implementation

- `src/executor/wake.ts` reads strict `<authority-root>/wake-policy.json`,
  validates an Owner one-turn authorization, starts `codex app-server proxy
  --sock`, checks loaded/idle/direct-input/workspace/model/provider/effort,
  records intent, submits exactly one Queue request, observes a new
  `inProgress` Turn, and falls back to Web Notify.
- Queue is called without `--resume`; timeout, signal, non-zero exit or lost
  ACK records `submission_unknown` and is never retried.
- `src/manager/sqlite-lifecycle-mcp-authority.ts` invokes the post-Release hook
  only after durable Release, outside SQLite transactions. Wake failure cannot
  roll back Result/Cleanup/Release.
- `src/sqlite-candidate/wp6b2b1/store.mjs` appends bounded
  `observation_recorded` evidence to the existing released Operation. It adds
  no schema/table and validates exact keys, digest, immutable binding,
  idempotence, state transitions and a five-observation limit.
- `src/executor/production-composition.ts` wires the coordinator into the
  existing production Authority composition.
- `src/manager/sqlite-lifecycle-mcp-authority.ts` exposes a safe summary for
  Wake events in Web/Event projections.

## Result Matrix

| Check | Status | Evidence |
|---|---|---|
| Missing/invalid/disabled policy -> Web Notify without Queue or App Server | `PASS` | `test/executor-wake.test.ts` |
| App Server unavailable or malformed preflight -> Web Notify | `PASS` | 8 coordinator/proxy tests |
| notLoaded / active / systemError / direct-input false | `PASS` | deterministic injected App Server |
| workspace/model/provider/effort mismatch and High rejection | `PASS` | deterministic matrix; exact-config fails closed |
| eligible loaded/idle -> intent before one Queue call | `PASS` | one `submit`, no retry, message bounded to Task/Attempt/digest |
| Queue timeout/non-zero/signal -> `submission_unknown` | `PASS` | exact state transition, no second submission |
| new `inProgress` Turn -> `turn_started` | `PASS` | baseline-new turn observation |
| duplicate intent / prior Wake history blocks dispatch | `PASS` | one-shot/idempotent coordinator |
| SQLite Wake facts survive reopen and do not change Result/Cleanup/Release | `PASS` | `executor-wake.test.mjs`, `lifecycle-port.test.mjs` |
| Release retry/Continue/administrative Release compatibility | `PASS` | 39 lifecycle tests |
| cross-process fake Worker Result -> Cleanup -> Release -> Wake -> Web fallback | `PASS` | `test/executor-process.test.ts` |
| Desktop realtime visibility | `UNKNOWN` | no UI acknowledgement; Web projection only |
| real App Server control socket / real Queue | `NOT_RUN` | control socket absent in current environment; no real command issued |
| strict notLoaded C / Desktop full-exit D | `NOT_RUN / BLOCKED` | requires separate isolated Host acceptance |
| real paid model / cost and quota observation | `NOT_RUN / BLOCKED` | no authorized paid request; unobservable |
| complete Windows/Ubuntu/Stress Release Candidate matrix | `NOT_RUN` | deferred until frozen PR 2-6 candidate |

## Commands and Evidence

Current targeted commands:

```text
npm run typecheck
npm run build:test
node --test dist-test/test/executor-wake.test.js
node --test test/sqlite-candidate/wp6b2b1/lifecycle-port.test.mjs test/sqlite-candidate/wp6c/executor-wake.test.mjs
node --test --test-name-pattern "a real Executor commits a synthetic Worker Result, Cleanup, and Release across processes" dist-test/test/executor-process.test.js
```

Observed results:

- Coordinator/proxy transport: 8/8 PASS.
- SQLite lifecycle + Wake: 39/39 PASS.
- Cross-process fake Worker E2E: PASS.
- Typecheck and test build: PASS for the candidate revision.

These are development-gate evidence, not the full release suite. The candidate
must not be represented as a Preview release or as real Desktop Wake proof.

## Strict Wake Boundaries

- `QUEUED`: Queue process exited 0; this only proves CLI acceptance.
- `TURN_STARTED`: App Server reported a new Turn not present in the baseline.
- `TURN_COMPLETED`: not recorded by this PR; requires later Thread observation.
- `DESKTOP_VISIBLE`: always `UNKNOWN` in this implementation.
- `submission_unknown`: a Queue process may have submitted; never resend.
- `web_notify`: a persisted fallback intent, not a successful wake.

The A/B experiment established that `codex queue` follows the original
Thread's current model and that `-c` does not override it. The coordinator
therefore requires exact current model/provider/effort and safe effort; it
does not use a CLI override.

## Blocking / Next Experiment

Real loaded/idle App Server and Queue acceptance remain dependent on an
available Desktop control socket and isolated thread authorization. Strict
notLoaded C and Desktop full-exit D must be run separately, with an isolated
Host and external evidence capture. No paid model request or Desktop shutdown
was performed by this PR.

PR 5 remains `PARTIAL / BLOCKED`; no Preview merge, release publication, CLI/Web
production expansion, or Wake claim beyond loaded/idle experimentation is
authorized by this evidence.
