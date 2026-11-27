# feat: integrate official ZCode host into the existing worker

> Status: RESEARCH — PR-READY CANDIDATE / INDEPENDENT REVIEW APPROVED
> Last updated: 2026-11-12
> Verified against: `ba25f83722094ef3428a04202749377cc9b6e643`；后续仅有文档证据刷新

## Problem

The prior candidate kept the official Host behind an isolated POC and left several production contracts disconnected. Preview.4 needs one Worker execution path that reuses the fixed official Host while preserving Bridge's SQLite task authority, lifecycle recovery and cleanup semantics.

## Result

- The Windows x64 Worker defaults to `OfficialHostAdapter`; the official ProcessManager owns the AppServer and helper lifecycle.
- The existing Worker, Manager, SQLite Authority and `CodingAgentAdapter` contracts remain in place.
- Fixed upstream patches add the 16 MiB raw frame limit and profile-scoped OAuth refresh coordination.
- Normal close is independently verified through exact Worker identity, recorded process tree, resource facts, cleanup digest and Release CAS.
- Preview.4 lifecycle startup upgrades SQLite v13 to v14 with pending-marker recovery and preserved occupied Attempts/Holds.
- The fixed official bundle verifies its manifest and ships the exact Windows x64 helper, provider, licenses and six-file Node-API keyring closure.
- No Companion process, Companion IPC, second task database, parallel RuntimeAdapter or shared AppServer pool is introduced.

## Validation

```text
Final test:affected FULL_SUITE:      936 tests / 935 pass / 0 fail / 1 skip
Reviewer focused adapter/platform:    18/18 PASS
Official-host/plugin/platform:        32/32 PASS
Focused routing/SQLite/selection:     64/64 PASS
SQLite real-adapter:                  47/47 PASS
Upstream frame matrix:                 7/7 PASS
Upstream account matrix:              12/12 PASS
SQLite stress:                         3/3 PASS
Direct rollback smoke:                 1/1 PASS
Same-source-tree artifact rebuild:      BYTE-IDENTICAL
Detached clean checkout:                 PASS
Current-candidate Astra review:          APPROVED
```

`npm run test:affected -- --base origin/preview` selected `FULL_SUITE` and ended with `FULL_REGRESSION_PASS`. A detached clean checkout passed `npm ci`, typecheck, build, plugin validation, Host export import and keyring native load. Astra reviewed the production diff, BOM, original Git bytes and tests and found no P0/P1/P2 attributable to this candidate.

## Scope and limits

- The fixed Official Host artifact supports Windows x64 with Node `24.16.0`; unsupported Windows architectures fail closed.
- Real OAuth, account rotation, model, Start Plan and Billing requests are `NOT_RUN`; all Provider behavior in tests is loopback or synthetic.
- SQLite v13→v14 is verified in the isolated test scope. Production data migration is `NOT_RUN`.
- A next upstream version is not bundled. Its upgrade/canary is deferred until a second approved artifact exists.
- Redistribution analysis remains `PARTIAL`; the BOM and notices are complete engineering inputs, not a substitute for legal approval.
- `npm audit --omit=dev` reports existing `high` advisories for `@modelcontextprotocol/server@2.1.0` and `zod@4.6.5`. Their versions and dependency tree match `origin/preview`; this PR does not introduce or fix them. A separate security update and audit remain required.

## PR status

```text
VERDICT: APPROVED
PR_READY: YES
```

Merge, release, real account/model E2E, production data migration and redistribution approval require separate authorization.
