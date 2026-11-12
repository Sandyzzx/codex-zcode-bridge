# Start Plan Multi-Turn Runtime Auth Repair

Date: 2026-11-11

## Verdict

`MULTI_TURN_AUTH_REPAIR: PASS`

The repair separates the one-shot private-channel delivery deadline from the
credential's actual usability lifetime, and makes Billing entitlement
preparation the single authoritative check for a task dispatch. No real
Billing, OAuth, Provider, or model request was sent.

## Baseline

| Item | Value |
| --- | --- |
| Worktree | `D:\codex-zcode-bridge\.run\startplan-desktop-compat-20261110` |
| Branch | `codex/startplan-desktop-compat-20261110` |
| HEAD | `357e2e49595ea07c4d2715807bd50a575b263c64` |
| Candidate | `2.0.0-preview.2` |
| Previous real E2E provider | `account:bigmodel-start-plan` |
| Previous real E2E model | `GLM-5.3-Flash` |

## Root Cause

The first real model iteration completed in approximately 43.17 seconds and
issued a tool call. AppServer then started the next model iteration and
requested provider runtime headers again.

Before this repair:

1. `prepare()` performed a Billing entitlement GET.
2. `issue()` performed a second Billing entitlement GET.
3. The resulting `PrivateCredentialLease` used one value for both the bounded
   one-shot delivery deadline and the Worker's cached credential lifetime.
4. `createProductionStartPlanAuth()` capped that shared value at
   `createdAt + 30_000`.
5. The Worker rejected the cached credential when the next runtime-header
   request arrived after that 30-second deadline.

This was a local private-runtime-auth failure. It was not an HTTP Provider
failure, HTTP 405, or Provider code 3012.

## Credential Lifecycle

### Before

`prepare() -> Billing GET -> issue() -> Billing GET -> 30-second shared lease
deadline -> one delivery -> Worker cache expires after 30 seconds`

### After

`prepare() -> one Billing GET -> task-scoped verdict -> issue() validates the
same credential/account/provider/model -> one 30-second delivery window ->
Worker cache uses the JWT's actual exp, or the active task lifetime when exp is
absent`

The private lease now carries two independent values:

- `deliveryDeadline`: one-shot delivery remains bounded and cannot be replayed.
- `credentialExpiresAt`: actual JWT expiration, or `Number.MAX_SAFE_INTEGER`
  for an observed no-`exp` credential.

The no-`exp` path does not create an indefinite process lease. The Worker cache
is still revoked by parent-lifetime EOF, cancellation, account invalidation,
adapter completion, or Worker failure. Long Node timer delays are scheduled in
safe chunks so a large finite deadline cannot overflow into an immediate
expiry.

## Billing Call Graph

### Before

```text
prepare() -> entitlement.check() -> Billing GET #1
issue()   -> entitlement.check() -> Billing GET #2
```

### After

```text
prepare() -> entitlement.check() -> task-scoped verdict -> Billing GET #1
issue()   -> compare current credential/account/provider/model with verdict
          -> no Billing GET
```

The issuer is created per dispatch by `startPlanPrivateAuthFactory`. It accepts
only one lease issuance. A repeated or cross-task request fails closed and does
not receive another entitlement check or lease.

## Runtime Changes

### `src/runtime/start-plan-private-lease.ts`

- Separates one-shot delivery deadline from credential expiration.
- Continues to enforce identity-bound, consume-once delivery.
- Delivers the actual credential expiration to the Worker.

### `src/runtime/start-plan-production-auth.ts`

- Stores one task-scoped entitlement verdict.
- Compares a credential digest, account, provider, model, device identity, and
  expiration before reusing the verdict.
- Reuses the verdict during `issue()` without another Billing GET.
- Allows only one lease issuance from an issuer instance.
- Passes actual JWT expiration independently of the delivery deadline.

### `src/worker/worker-main.ts`

- Single-flights concurrent runtime-header requests.
- Reuses one cached credential across repeated requests.
- Separates cached credential validity from one-shot lease delivery.
- Safely handles long and no-`exp` credential deadlines.
- Preserves revocation on parent EOF, cancellation, account invalidation, and
  adapter completion.
- Emits only bounded stage labels and fixed error classifications for private
  auth diagnostics.

### `src/store/lifecycle-gate.ts`

- Documents that `prepare()` owns the task's authoritative entitlement check
  and `issue()` must reuse it.

No AppServer request body, header construction, provider identity, Desktop
context prompt, system blocks, tools, or model routing contract was changed.

## Security

- JWT material remains memory-only.
- The task-scoped entitlement context stores a SHA-256 credential digest, not
  the JWT, plus non-secret binding facts.
- No JWT, Authorization header, device ID, prompt, model output, or raw
  Provider payload is persisted or exposed by the repair.
- Account, provider, model, task, attempt, operation, generation, claim,
  session, turn, PID, and exact process creation identity remain bound.
- Failed delivery remains terminal and is never retransmitted.
- Lease release remains owned by the existing Cleanup/Release lifecycle.

## Test Evidence

### Focused private-auth contracts

Command:

```text
node --test dist-test/test/start-plan-private-lease.test.js dist-test/test/start-plan-private-channel.test.js dist-test/test/start-plan-production-auth.test.js
```

Result: `33/33 PASS`

Coverage includes:

- JWT valid at the 43.17-second-equivalent point.
- Actual JWT expiration independently enforced.
- No-`exp` task-lifetime sentinel.
- Exactly one Billing GET for `prepare()` plus `issue()`.
- Repeated preparation and lease access without another Billing GET.
- Account switch and unentitled fail-closed behavior.
- Separate task issuers independently perform one Billing check.

### Cross-process Worker private auth

Command:

```text
node --test --test-name-pattern="reuses one delivered credential" dist-test/test/sqlite-candidate/wp6b-wiring/mvp-real-adapter.test.js
```

Result: `2/2 PASS`

Coverage includes:

- Synthetic tool permission followed by a second runtime-header request.
- Two sequential runtime-header requests reusing one credential.
- Two concurrent runtime-header requests sharing one pending acquisition.
- Exactly one private lease issuance.
- No synthetic credential in SQLite, request logs, Worker stderr, args, or
  public Result/status output.

### Existing private-auth and host wiring regression

Command:

```text
node --test --test-name-pattern="private auth|private-auth|host-wired|ADR-031 Gate E1|Start Plan Billing|SQLite cancellation" dist-test/test/sqlite-candidate/wp6b-wiring/mvp-real-adapter.test.js
```

Result: `17/17 PASS`

An additional Host composition test, `startBridge's host issuer wiring reaches
the fake Billing gate and completes a Start Plan task`, passed `1/1`.

These runs cover:

- Prepare rejection before AppServer startup.
- Wrong turn, wrong claim, and account switch rejection.
- Cancellation before, during, and after credential delivery.
- Worker crash and delayed lease revocation.
- Lifetime EOF and ACK loss.
- Host issuer wiring through the real Authority path.
- Canonical credential non-leak scans.
- Coding Plan continuation without Billing.
- SQLite Result, Commit, Cleanup, and Release invariants.

### Affected gate

Command:

```text
npm run test:affected
```

Result:

```text
677 tests
677 PASS
0 FAIL
0 SKIP
STRESS_TEST_REQUIRED_AND_PASS
```

The same gate passed Typecheck, Build, Plugin Validation, and
`git diff --check`. After strengthening the multi-iteration fixture with a
synthetic tool permission, the two focused multi-iteration tests were rebuilt
and rerun successfully.

## Coding Plan

`CODING_PLAN_REGRESSION: PASS`

Coding Plan continues to bypass Start Plan Billing and private credential
delivery. Existing Coding Plan integration tests passed in both focused and
affected runs.

## Remaining Uncertainties

- No real Start Plan E2E was run in this task.
- The official Provider was not contacted, so the repaired multi-iteration
  path is proven synthetically and through the controlled AppServer fixture.
- AppServer behavior for a new turn ID inside one Worker remains intentionally
  fail-closed; the verified continuation case is multiple model requests
  within the same active turn.
- Exact production JWT lifetime and no-`exp` frequency remain external facts;
  both are handled without assuming a fixed local TTL.

## Recommended Real E2E Procedure

1. Obtain a new explicit Owner authorization.
2. Use an isolated SQLite v14 Authority and an empty test workspace.
3. Confirm the official credential/account/device identity is read-only valid.
4. Allow at most one user turn and zero automatic retries or fallbacks.
5. Use a prompt that requires one minimal tool call and then a final JSON
   Worker report, exercising two model iterations.
6. Record only redacted timing, status, frame length, request count, and
   lifecycle evidence.
7. Stop on the first failure. Do not retry, refresh credentials, change device
   identity, or send a second user turn.
8. Verify Result Commit, Worker exit, process-tree cleanup, Lease release, and
   no new Hold before restoring the Authority configuration.

## Final Status

```text
MULTI_TURN_AUTH_REPAIR: PASS
TASK_SCOPED_CREDENTIAL_LIFECYCLE: PASS
JWT_EXPIRATION_ENFORCED: PASS
MULTI_ITERATION_SYNTHETIC_E2E: PASS
BILLING_REQUESTS_PER_TASK: 1
BILLING_CONTEXT_SHARED: PASS
CODING_PLAN_REGRESSION: PASS
LEASE_RELEASE: PASS
CREDENTIAL_LEAK_SCAN: PASS
TYPECHECK: PASS
BUILD: PASS
PLUGIN_VALIDATION: PASS
READY_FOR_INDEPENDENT_REVIEW: YES
READY_FOR_REAL_STARTPLAN_E2E: YES
```

No commit, push, merge, tag, or release was performed. Existing unrelated WIP
was not staged or removed.
