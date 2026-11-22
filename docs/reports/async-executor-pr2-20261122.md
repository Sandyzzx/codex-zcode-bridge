# Async Executor PR 2 Evidence

> Status: RESEARCH
> Date: 2026-11-22
> Branch: `codex/async-executor-pr2`
> Integration baseline: `origin/preview@1bf039fda2ccfd17a992458a871bddd7b48b38c1`
> Code evidence commit: `0c039406f`
> Conclusion: `PARTIAL / BLOCKED`

## 1. Scope and Conclusion

This report covers the PR 2 candidate only: independent Executor ownership,
deterministic IPC, Thin MCP control transport, and the original Attempt
Result/Cleanup/Release durability path. It does not implement or validate the
PR 3-6 CLI, Web, Wake, or production Desktop integration.

The deterministic and synthetic gates are PASS. The real Codex Desktop close
E2E and a real Official ZCode Runtime/provider request are not run. The Desktop
shutdown test would require closing the Owner's active Desktop, and no new paid
model authorization was requested. Therefore PR 2 may be submitted for review,
but must not be merged into Preview or published.

No real model request, Desktop termination, SQLite production-root mutation, or
agent bridge task was performed while producing this evidence.

## 2. Architecture Delta

The accepted ADR-045 ownership model is implemented without a second task
manager, database, recovery engine, or Worker execution path:

| Concern | PR 2 candidate |
|---|---|
| Ownership | One Lifetime Lease per normalized Authority Root; exact PID plus start fingerprint; heartbeat; fail closed on unknown identity |
| Executor | Standalone `src/executor/main.ts` owns the existing `SqliteLifecycleMcpAuthority` |
| IPC | Windows Named Pipe control client/server; bounded frames; 33 MiB frame budget for the existing 32 MiB Result contract |
| MCP | `ZCODE_BRIDGE_MCP_TRANSPORT=control` selects a Thin MCP adapter; legacy in-process transport remains the default |
| Submission semantics | `REQUEST_CANCELLED`, `TASK_CANCEL_REQUESTED`, `SUBMISSION_UNKNOWN`, and `EXECUTOR_UNAVAILABLE` remain distinct |
| Shutdown | Idle-only Executor close; Store closes before Lease release; refused close restores control service |
| Wake | Not implemented in PR 2. The planned Queue Adapter remains a later PR 5 decision; Web Notify is the future safe fallback when Queue/model/budget confirmation is unavailable |

The public MCP tool names and schemas, SQLite v14 schema, Worker private IPC,
Official Runtime, Task/Result/Cleanup/Recovery contracts, and public Core API
are unchanged.

## 3. Minimal Implementation

Implemented files:

- `src/executor/main.ts`: standalone internal Executor entry point.
- `src/executor/service.ts`: Lifetime Lease coordination, heartbeat, and
  Idle-only shutdown ordering.
- `src/executor/lease.ts`: exact owner lease, transition guard, heartbeat,
  release, and explicit stale-owner clearance primitive.
- `src/executor/control-client.ts`, `control-server.ts`, `frame.ts`, and
  `protocol.ts`: bounded Named Pipe Control transport.
- `src/executor/remote-task-manager.ts` and
  `lease-guarded-task-manager.ts`: Thin MCP delegation and legacy lease fencing.
- `src/host/stdio.ts`: opt-in control transport composition; the accepted Task
  is not cancelled when the MCP request/transport disappears.
- `plugins/codex-zcode-bridge/dist/bridge.mjs`: rebuilt generated artifact.

No Supervisor, second task database, second state machine, management CLI, Web
server, or Wake Adapter was added.

## 4. Verification Matrix

The following statuses use the existing project vocabulary:
`PASS`, `FAIL`, `BLOCKED`, and `NOT_RUN`.

| Area | Status | Evidence |
|---|---|---|
| Lifetime Lease create and exact owner | `PASS` | `test/executor-lease.test.ts` |
| Double start and competing legacy MCP Host | `PASS` | exact live owner refuses the second Executor; tests cover both owner kinds |
| PID reuse, malformed lease, unknown probe | `PASS` | fail closed with stale/unknown classification |
| Heartbeat loss | `PASS` | mutation fence remains; reads remain available; release is not attempted |
| Store-before-Lease release order | `PASS` | test records Store close before released lease; release failure remains fail closed |
| Idle-only Shutdown refusal | `PASS` | active work returns `EXECUTOR_SHUTDOWN_NOT_IDLE`; service remains active |
| Refusal recovery | `PASS` | subsequent Create and health checks succeed |
| Manual stale-owner clear | `PASS` | exact live owner is refused; only a proven exited owner is cleared |
| Historical Lease transition | `PASS` | missing history requires explicit acknowledgement; released history does not; acknowledgement still cannot bypass a known live owner |
| IPC request correlation | `PASS` | framed receipt/response identity |
| Request wait abort | `PASS` | returns `REQUEST_CANCELLED`; accepted Task continues |
| Client close with in-flight submission | `PASS` | returns `SUBMISSION_UNKNOWN` rather than implying a Task cancel |
| Lost response and unavailable Executor | `PASS` | method-specific unknown/cancel versus unavailable classification |
| Oversized/malformed frames | `PASS` | bounded decoder rejects before manager dispatch |
| 32 MiB Result over IPC | `PASS` | complete Result read through the 33 MiB frame budget |
| Thin MCP transport flag | `PASS` | `ZCODE_BRIDGE_MCP_TRANSPORT=control` builds no local SQLite Manager |
| Thin MCP disconnect/reconnect | `PASS` | MCP closes, Executor finishes one synthetic Worker spawn, reconnect reads completed Result attempt 1 |
| Cross-process fake Worker durability | `PASS` | one `result_committed`, non-null digest, `cleanup_pending`, `cleanup_verified`, `released` |
| Repeated Spawn/result overwrite | `PASS` | synthetic E2E observes exactly one Worker spawn and one original Attempt commit |
| Complete local regression | `NOT_RUN` | PR 2 is one part of the Executor chain; the Owner deferred complete CI until the whole chain reaches its Release Candidate |
| Real Codex Desktop close | `BLOCKED` | `BLOCKED_BY_OWNER_ENVIRONMENT`; Owner's active Desktop was not closed |
| Real Official ZCode Runtime/provider | `NOT_RUN` | no paid model authorization and no real provider request |
| Strict Wake C/D | `NOT_RUN` | Wake Adapter is outside PR 2 |

## 5. Current Test Evidence

The initial full affected gate selected `FULL_SUITE` because the test impact map
changed. It reported `1005 PASS / 3 FAIL / 2 SKIP`. The three failures were
test-infrastructure/mapping issues, not a semantic Executor failure:

1. Thin MCP used a nested fixture path that was too long for the local SQLite
   open in this worktree; the fixture now uses a short-lived isolated app-data
   path.
2. `test/executor-process.test.ts` was missing the `sqlite-persistence` impact
   domain.
3. The Windows shard plan did not enumerate the three new Executor tests.

After those corrections, the focused Executor/IPC/Thin MCP suite passes. The
current evidence includes:

- `test/executor-lease.test.ts`: PASS.
- `test/executor-ipc.test.ts`: 8/8 PASS, including in-flight client close.
- `test/executor-process.test.ts`: 5/5 PASS, including synthetic original
  Attempt Result/Cleanup/Release.
- `test/mcp-stdio-entry.test.ts`: PASS for control transport and no local
  SQLite Manager construction.
- The combined Executor Lease/IPC/process/Thin MCP run is 32/32 PASS.
- `test/test-impact-selector.test.ts` and `test/test-shard-plan.test.ts`:
  24/24 PASS.
- `npm run test:affected -- --force-full --development`: T0 PASS and ended
  with `FULL_SUITE_DEFERRED_TO_RELEASE_GATE`; this is not a full-suite PASS.
- The first pushed workflow exposed an unquoted YAML `run` scalar containing
  a colon. The two deferral messages are now quoted, and `actionlint` passes.

The Owner clarified that PR 2 is only one part of the Executor chain. The
complete local regression and complete Windows/Ubuntu/stress CI are therefore
`NOT_RUN` for this PR and remain deferred until the whole chain forms a common
Release Candidate. This report does not claim a post-fix full-suite PASS. An
accidentally started early full local run was stopped on Owner direction before
the test matrix completed and is not counted as evidence.

## 6. Real Host Boundary

The required real E2E steps are:

1. Start the isolated Executor and submit a synthetic or explicitly authorized
   original Attempt.
2. Close only the Codex Desktop host; do not terminate the Owner's live
   workspace or unrelated conversations.
3. Compare the Executor process identity and Worker evidence after Host exit.
4. Require the original Result commit, independent Cleanup proof, and exact
   Operation Release; a live Worker alone is not PASS.
5. Reopen the Desktop/Executor client and read the original Attempt without
   duplicate Spawn or overwrite.

These steps are `BLOCKED_BY_OWNER_ENVIRONMENT` in the current run. They must be
performed in an owner-approved isolated Windows environment or a dedicated
test host. The result was not inferred from controlled stdin EOF, fake Worker
completion, or `detached:true`.

## 7. Release Gates

Executor development follows the approved lightweight development gate:
typecheck, affected tests, targeted lifecycle E2E, then a single complete
release gate at the Release Candidate boundary. Ordinary PR updates do not
repeat the complete matrix. `FULL_SUITE` is explicitly deferred by the
development gate instead of being reported as a pass.

The complete gate runs on `preview`/`master` push, a non-draft PR labeled
`release-candidate`, or manual dispatch with `release_gate=true`. Required
check jobs remain present in development mode and announce the deferral.

PR 2 may proceed to review only if:

- generated artifacts are current and `git diff --check` is clean;
- typecheck, build, plugin validation, impacted tests, and the required
  lifecycle E2E pass;
- the development-gate CI passes on the final branch;
- the review explicitly records `PARTIAL / BLOCKED` and preserves the real
  Desktop E2E requirement.

PR 2 must not:

- merge into Preview while the real Desktop close E2E is `BLOCKED`;
- publish a Preview or Stable release;
- implement CLI/Web/Wake production integration before the ownership and
  durability gate is satisfied;
- create a second task manager/persistence authority to make synthetic tests
  look complete.

The first safe follow-up is a dedicated isolated real-Host experiment. Queue
Wake remains a later adapter decision: use Queue only for an authorized,
loaded/idle Thread with model/budget preflight; otherwise use Web Notify.
Strict not-loaded and Desktop-exit C/D scenarios remain independent release
gates.

## 8. Remaining Risks

- A historical installed MCP Host that predates Lease has no readable Lease
  history. It must be stopped and verified manually before a transition
  acknowledgement; hot coexistence with such a Host is not proven safe.
- A Lease heartbeat loss intentionally keeps the Store writable but fences
  lifecycle mutations. This preserves in-flight Result durability but requires
  explicit recovery before a new owner can start.
- The real Desktop process tree and close behavior remain unverified.
- Official ZCode Runtime authentication, provider execution, billing, and
  cleanup remain unverified for this branch.
- Token Efficiency candidates remain frozen and are not mixed with this PR 2
  evidence.

## 9. Recommendation

Keep ADR-045 `ACCEPTED`; record PR 2 as `IMPLEMENTED — PARTIAL / BLOCKED`.
Submit the implementation and this evidence for review, do not merge Preview,
and schedule the isolated real-Desktop close experiment as the next gate.
