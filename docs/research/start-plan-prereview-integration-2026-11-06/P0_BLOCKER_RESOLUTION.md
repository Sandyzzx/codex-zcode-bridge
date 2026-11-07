# Start Plan P0 Blocker Resolution

> Status: RESEARCH  
> Result: PASS  
> Date: 2026-11-06  
> Branch: `codex/start-plan-prereview-20261106`  
> Worktree: `D:\codex-zcode-bridge\.run\start-plan-prereview-20261106`  
> Baseline: `67dd8c67275c4afeb81dd9795ee03e258083c54d`  
> Verified against: local feature WIP, before the P0 resolution commit

## Result

Both named P0 blockers are resolved without weakening lifecycle assertions.
The follow-up full-suite failures exposed a real LedgerStore Windows atomic
rename defect; it now reuses the repository's existing bounded atomic-rename
policy and cleans its temporary file on failure. The final affected gate and
complete isolated regression pass.

No OAuth, provider token, model request, production SQLite data, Device ID, or
real account was touched. No push, merge, tag, or release was performed before
the P0 gate passed.

## Blocker 1 - Crash Hold

### Determination

The original failure was a stale test contract, not a new Worker entering an
occupied execution path. The observed chain was:

1. Worker crash before cancellation.
2. Operation retained its actual execution path.
3. Recovery classified the path as `recovery_workspace_scoped`.
4. A same-path dispatch remained queued.
5. The scheduler deferred it without spawning a second Worker.
6. An unrelated execution path could still dispatch.

The old test expected a global `recovery_root_read_only` hold. That expectation
conflicted with ADR-024's execution-path-scoped hold. The test now asserts the
actual path hold, `recovery_workspace_scoped`, same-path deferral, and zero
second-Worker spawns. It does not mask overlap defects.

## Blocker 2 - Lifetime EOF Recheck

### Root cause

The fixture wrote its recheck trigger to:

`<fixture>/resources/glm/recheck-trigger`

The controlled fake AppServer checked:

`<fixture>/recheck-trigger`

Consequently, the first stalled event was the initial
`private-auth-recheck` request: the second runtime-auth request was never sent.
The retained request log contained successful initial auth but no
`recheck_auth_applied`.

### Fix

The fake runtime now exposes its actual `runtimeRoot`, and the test writes the
trigger there. This was a fixture-path correction only; EOF still revokes later
runtime-auth eligibility, and EOF alone does not fabricate a failed Result or
Cleanup Verified.

## Cancellation Ordering Fix

After the two named blockers passed, full-file testing exposed a cancellation
race. The previous cancellation path aborted the private-auth pipe immediately.
That premature EOF could let a Worker produce an auth failure before the
durable cancellation proof, cleanup, Result, and Release had settled.

The production ordering is now:

1. Cancellation marks the in-flight private-auth state cancelled.
2. It does not immediately destroy the private-auth pipes.
3. It closes the Worker identity-handle gate and performs identity-bound
   termination.
4. A pending lease is revoked without retransmission.
5. The issuer waits for owner exit before rejecting the pending auth request.
6. Worker close completes.
7. The final Result commits.
8. Cleanup/Recovery and Release follow the normal evidence contract.

The lifecycle path does not add a global Hold, inflate test budgets, swallow
errors, or force a terminal state without evidence.

## Cleanup Diagnostics

`#scanRootExitedCleanup` now returns a bounded `scanError` when the Windows
claimant scan fails. A `cleanup_unverified` event can therefore retain a
bounded scan-error diagnostic alongside PID/member evidence. It still refuses
to claim Cleanup Verified when process-tree state is unknown.

## Test Fixture Corrections

The write-cancel fixture now counts a completed logical credential-frame write
rather than Node's incidental zero-byte `end()` call. Its failure diagnostics
are emitted through `try/finally`, and teardown waits for the relevant process
exit before settling controlled late events.

The composition static test was updated for the Gate 2 Worker call's explicit
`privateAuthMode` argument. No lifecycle assertion was removed.

## Follow-Up Full-Suite Defect

Two complete regressions failed intermittently at unrelated LedgerStore tests
with the same Windows error:

- Run 1: `C1-02` failed with `EPERM` renaming `snapshot.json.<uuid>.tmp`.
- Run 2: `C3-04` failed with the same `EPERM` rename shape.

Both files passed when their test files ran isolated, and the second full run
failed at a different test than the first. The shared defect was therefore not
an assertion defect in either test: LedgerStore used a bare `renameSync`, while
TaskStore already had a bounded Windows atomic-rename retry for transient
`EPERM`, `EBUSY`, and `EACCES`.

LedgerStore now uses that existing helper for its snapshot replacement. A failed
write still throws, and its temporary file is removed best-effort. This is a
minimal production reliability fix, not error swallowing or assertion masking.

## Validation

### P0-focused runs

| Check | Result |
| --- | --- |
| Crash-hold isolated | PASS |
| Lifetime-EOF isolated | PASS |
| Full 25-test MVP file after final changes | PASS 25/25 |
| Composition suite after final changes | PASS 36/36 |
| Start Plan private-channel/frame/lease/redactor suites | PASS 11/11 |

### Follow-up full runs

| Run | Tests | Result | Failure |
| --- | ---: | --- | --- |
| Full before cancellation fix | 876 | FAIL | remaining cancellation tests |
| Complete run 1 before ledger fix | 876 | FAIL 1 | `C1-02`, rename `EPERM` |
| Isolated `ledger-core.test.ts` | 14 | PASS 14/14 | none |
| Complete run 2 before ledger fix | 876 | FAIL 1 | `C3-04`, rename `EPERM` |
| Isolated `ledger-bridge-review.test.js` | 12 | PASS 12/12 | none |
| Final `npm run test:affected` | 876 | PASS | none |

The final gate executed in this order:

1. `npm run typecheck` - PASS.
2. `npm run build` - PASS.
3. `npm run validate:plugin` - PASS.
4. `git diff --check` - PASS.
5. Complete `npm test` - PASS: 876 tests, 874 passed, 0 failed, 2 platform
   skips, 0 cancelled; `FULL_REGRESSION_PASS`.

The two skips are expected platform guards, not omitted Windows coverage: the
POSIX permission test is replaced by Windows ACL semantics, and the injected
`ENOTEMPTY` teardown case is explicitly skipped on Windows.

The final complete run included stress test `B3-05` with its frozen 32 active /
10,000 historical-task parameters. It passed. `STRESS_TESTS_APPLICABLE` applied;
the stress boundary was not skipped.

## Remaining Risks

1. Windows process-tree scans can still remain conservatively occupied when
   identity is uncertain. This is intentional fail-closed behavior, but it may
   require later operator Recovery.
2. Cleanup scan diagnostics are bounded and code-level, but do not identify an
   external process that Windows cannot attribute.
3. The branch still carries the broader uncommitted Gate 2 WIP; independent
   review on the Draft PR is required before merge.
4. CI must independently confirm the local Windows regression; this report does
   not substitute for CI.

## Git State

After the gate passed, the implementation, tests, bundled artifacts, and this
report were committed to `codex/start-plan-prereview-20261106` for the requested
Draft PR against `prereview`. No merge occurred.
