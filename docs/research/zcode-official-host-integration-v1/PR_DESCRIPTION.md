# docs: validate official ZCode host integration and record blockers

> Status: RESEARCH
> Date: 2026-11-11
> Astra-approved evidence candidate: `5da873d1f2632ac67343be692fab121f682f4cef`

## Problem

ADR-032 accepts a target topology that runs the official ZCode Host inside the existing Bridge Worker while retaining the current Task/Attempt, SQLite, lifecycle and Cleanup/Release contracts. Before implementation, the project needed reproducible source artifacts, a real official ProcessManager/AppServer Mock path, account-concurrency evidence, lifecycle mapping, and an independent decision on whether the candidate was ready.

## Result

This branch adds the formal architecture freeze and the complete Official Host Integration v1 research package. It records:

- a successful fixed-source build for ZCode `3.18.0` / AppServer `0.17.1`;
- a hash-addressed self-contained Host module and Windows runtime-host helper;
- three isolated ProcessManager runs (`r7`, `r8`, `r9`), each with 12/12 assertions covering the official AgentRuntime, two main-turn Mock requests, official `Read`, resume, cancel, usage and target PID cleanup;
- existing Bridge auth/lifecycle targeted regression evidence;
- a failing two-process same-profile credential test;
- contract gaps for the 16 MiB raw stdout frame guard and Bridge Cleanup/Release proof mapping.

The branch does not add an independent Companion service, IPC, business database, parallel RuntimeAdapter, Shared AppServer Pool or second task/recovery state machine.

## Blocking findings

1. Two real Node Workers using one synthetic profile both refreshed the same one-time token. The first rotated it; the second received `409 rotation_reuse_rejected`. Per-Worker `OAuthService` assembly therefore cannot be treated as cross-process single-flight.
2. Official `ZCodeStdioTransport` does not provide the Bridge's equivalent 16 MiB raw UTF-8 stdout-frame boundary. Checking sizes after JSON parsing is not contract parity.
3. Official normal close and observed target PID exit do not expose a persistent Job identity/kernel-empty/helper-exit receipt accepted by the Bridge Cleanup verifier. A new proof contract must be accepted before Release integration.

## Not implemented

- `OfficialHostAdapter`
- Worker production wiring
- event/terminal/error parity
- persistent Cleanup Proof mapping
- same-profile refresh coordination
- full native/resource BOM and redistribution approval
- performance comparison and upgrade/rollback rehearsal
- full regression and real account/model/Start Plan/Billing E2E

## Validation

```text
npm run test:affected
  typecheck: PASS
  build: PASS
  validate:plugin: PASS
  git diff --check: PASS
  selection: NO_TESTS_APPLICABLE
  stress: STRESS_TESTS_NOT_APPLICABLE

Start Plan/private auth targeted regression: 33/33 PASS_HISTORICAL
Lifecycle/cleanup targeted regression: 139/139 PASS_HISTORICAL
ProcessManager isolated Mock: r7/r8/r9 each 12/12 PASS
Same-profile synthetic multi-worker: FAIL
```

## Delivery status

```text
PR_READY: NO
PRODUCTION_CODE_CHANGED: NO
PRODUCTION_DATA_MODIFIED: NO
REAL_MODEL_REQUESTS: 0
REAL_ACCOUNT_REQUESTS: 0
STARTPLAN_REQUESTS: 0
BILLING_REQUESTS: 0
PUSHED: NO
MERGED: NO
RELEASED: NO
```

This description is a review artifact. It does not authorize merging the research branch as a production implementation.
