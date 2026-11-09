# ADR-028: Pre-Intent Workspace Refusal and Launch Unknown Boundary

> Status: DECISION
> Decision: ACCEPTED for local R4 implementation under the Owner R4 directive, 2026-11-06
> Baseline: `cbf0305b0f548b065fcfab0ffaa7159554f6d69d`
> Scope: SQLite launch ordering and failure classification; no Schema, Result, timeout or release authorization

## Context

ADR-017 requires the source workspace and execution worktree to be revalidated
before Worker use. The previous ordering persisted a Launch Intent before that
final `validateWorkspaceForUse` check. If a path disappeared in that window,
the Manager had deterministically not called Spawn, but SQLite contained a
launch permit. Queued cancellation then correctly refused to treat the Intent
as unused, leaving an occupied execution path with no normal cancellation path.

The durable Intent cannot be erased or downgraded merely because the current
Manager has `spawnCount === 0`. The same distinction is required after a
Manager crash: a missing Receipt or absent in-memory child handle does not
prove that process creation was never requested.

## Decision

1. The final source-workspace and execution-worktree use checks run after the
   consistent Admission snapshot and immediately before `createLaunchIntent`.
   A refusal therefore persists no Launch Intent and never enters the
   "Spawn possible" state.
2. A refusal leaves the existing Task/Attempt queued and the Operation in
   untouched `reserved`. It appends no launch event and retains Capacity and the
   execution path until an explicit queued `zcode_cancel`.
3. Queued cancellation continues to use the existing CAS transition
   `reserved -> cancelled_before_launch`. It releases the reservation without
   creating an Attempt or Worker. Once Launch Intent wins the CAS, queued
   cancellation continues to refuse.
4. Successful Launch Intent persistence is the durable boundary after which
   Worker creation is treated as possible. Spawn callback errors, bootstrap
   failure, missing identity, missing Receipt, delayed Claim, Manager crash, or
   an in-memory `spawnCount` of zero never authorize automatic termination,
   reassignment, Workspace release or a second Spawn.
5. R4 does not add a `launch_failed` transition, reset an Intent to `reserved`,
   or change SQLite Schema v14. Existing persisted `launch_intent` Operations
   with no trustworthy process evidence remain conservative unknowns.
6. The check remains a single-user local final-use guard, not protection
   against same-account path replacement after the check. That threat remains
   outside ADR-017's supported boundary.

## Consequences

- Deterministic path loss before process creation has a normal, explicit
  cancellation and Capacity-release path.
- Recovery may resume one queued Attempt only while the Operation is an
  untouched `reserved` with no launch evidence.
- An Intent still causes conservative Hold when process identity cannot be
  established. This may retain availability cost, but preserves the stronger
  no-duplicate-execution boundary.
- No new persistent state, watchdog, retry loop or public status is introduced.

## Verification

Real SQLite Manager/Worker composition tests must cover source and execution
path removal, zero Spawn, no launch event, queued cancellation,
`cancelled_before_launch`, Capacity/path reuse, and the existing Intent-wins
CAS behavior. Manager crash and delayed Claim tests continue to prove that
Intent/receipt/claim evidence is never replayed merely because a process handle
or Receipt is absent.
