# Async Executor PR 5 Evidence

> Status: IMPLEMENTED — TARGETED / REAL WAKE BLOCKED
> Date: 2026-11-23（Asia/Shanghai）
> Baseline: `origin/preview` `1bf039fda2ccfd17a992458a871bddd7b48b38c1` + stacked PR 4 candidate
> Decision: [ADR-051](../decisions/ADR-051-executor-wake-delivery.md)

## Scope

PR 5 adds an optional, one-shot Wake Adapter inside the existing Executor. It
runs only after the original Attempt has a committed terminal Result and the
Operation has durably reached `released`. It does not own Task scheduling,
Result, Cleanup, Release, Recovery, or a second persistence authority.

```text
strict: confirmed loaded/idle exact-config Thread -> one Queue
trusted-local: explicit local Owner risk acceptance -> one Queue
Web Notify default fallback for every uncertain condition
SQLite v14 observation_recorded for bounded Wake facts
```

## Implementation

- `src/executor/wake.ts` reads `<authority-root>/wake-policy.json`. Missing
  `delivery_mode` defaults to strict, which requires `codex app-server proxy
  --sock` plus loaded/idle/direct-input/workspace/model/provider/effort and a
  new `inProgress` Turn observation.
- Explicit `delivery_mode=trusted_local` is limited to the single-user local
  trusted Host. It skips the unavailable Desktop private control plane but
  still validates exact Task/Attempt/Workspace, unexpired Owner authorization,
  Result/Cleanup/Release, writes one intent, and submits one Queue. Queue ACK
  followed by `trusted_local_turn_start_unverified` preserves Web visibility
  without claiming TURN_STARTED.
- Queue is called without `--resume`; timeout, signal, non-zero exit or lost
  ACK records `submission_unknown` and is never retried.
- The official Queue message ID is parsed from the CLI acknowledgement and
  appended to the `queued` evidence as optional `queue_message_id`; SQLite
  schema version remains v14 and old evidence without the field stays readable.
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
| App Server unavailable or malformed strict preflight -> Web Notify | `PASS` | strict coordinator/proxy tests |
| notLoaded / active / systemError / direct-input false | `PASS` | deterministic injected App Server |
| workspace/model/provider/effort mismatch and High rejection | `PASS` | deterministic matrix; exact-config fails closed |
| eligible loaded/idle -> intent before one Queue call | `PASS` | one `submit`, no retry, message bounded to Task/Attempt/digest |
| explicit trusted-local -> one Queue without private control socket | `PASS — SYNTHETIC` | no App Server connect; one Queue; message ID persisted |
| trusted-local expired authorization or Task/Attempt/Workspace mismatch -> zero Queue | `PASS` | policy/binding negative tests |
| trusted-local Queue accepted but Turn unverified -> durable Web fallback | `PASS` | `queued` then `trusted_local_turn_start_unverified`; no resubmit |
| Queue timeout/non-zero/signal -> `submission_unknown` | `PASS` | exact state transition, no second submission |
| new `inProgress` Turn -> `turn_started` | `PASS` | baseline-new turn observation |
| duplicate intent / prior Wake history blocks dispatch | `PASS` | one-shot/idempotent coordinator |
| SQLite Wake facts survive reopen and do not change Result/Cleanup/Release | `PASS` | `executor-wake.test.mjs`, `lifecycle-port.test.mjs` |
| Release retry/Continue/administrative Release compatibility | `PASS` | 39 lifecycle tests |
| cross-process fake Worker Result -> Cleanup -> Release -> Wake -> Web fallback | `PASS — CURRENT CANDIDATE` | `test/executor-process.test.ts`, 1/1 current-code E2E |
| Desktop realtime visibility | `UNKNOWN` | no UI acknowledgement; Web projection only |
| strict real App Server control socket | `BLOCKED` | control socket absent in current environment; zero Queue |
| trusted-local real automatic Queue/Turn | `BLOCKED_BY_AUTHORIZATION` | implementation/tests ready; no new Codex model budget authorization this round |
| strict notLoaded C / Desktop full-exit D | `NOT_RUN / BLOCKED` | requires separate isolated Host acceptance |
| real paid model / cost and quota observation | `NOT_RUN / BLOCKED` | no authorized paid request; unobservable |
| complete Windows/Ubuntu/Stress Release Candidate matrix | `NOT_RUN` | deferred until frozen PR 2-6 candidate |

## Commands and Evidence

Current targeted commands:

```text
npm run typecheck
npm run build:test
node scripts/test-isolated.mjs dist-test/test/executor-wake.test.js dist-test/test/task-cli.test.js dist-test/test/skill-policy.test.js test/sqlite-candidate/wp6b2b1/lifecycle-port.test.mjs test/sqlite-candidate/wp6c/executor-wake.test.mjs
node scripts/test-isolated.mjs --test-name-pattern="a real Executor commits a synthetic Worker Result, Cleanup, and Release across processes" dist-test/test/executor-process.test.js
```

Observed results:

- Current focused set: 72/72 PASS, including Coordinator/proxy transport,
  trusted-local policy/Queue, Task CLI policy writing, SQLite lifecycle + Wake,
  and message-ID persistence.
- Current-code cross-process E2E: 1/1 PASS. A real Executor process with a
  synthetic Worker persisted the original Attempt Result, Cleanup Verified and
  Release, then recorded one policy-missing Web fallback. This is not a real
  automatic Queue/Turn or Desktop visibility proof.
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
Thread's current model and that `-c` does not override it. Strict mode therefore
requires exact current model/provider/effort and safe effort. Trusted-local
mode does not claim a match: Owner explicitly accepts the delivery-time Thread
model risk, and the policy's model/provider/effort values remain an
authorization snapshot for audit only.

## Blocking / Next Experiment

Strict loaded/idle App Server acceptance remains dependent on an available
Desktop control socket. Trusted-local code can now submit one official Queue,
but a real automatic Turn and Master Result/Cleanup/Release readback require a
separate low-cost Codex model budget authorization. Strict notLoaded C and
Desktop full-exit D remain separate, isolated-Host gates. No paid model request
or Desktop shutdown was performed by this PR.

PR 5 remains targeted-complete but real-Wake `BLOCKED_BY_AUTHORIZATION`; no
Preview merge, release publication, or claim that automatic Master acceptance
has passed is authorized by this evidence.
