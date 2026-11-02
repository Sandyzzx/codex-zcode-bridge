# ADR-018: Administrative abandonment of an unrecoverable Cleanup Hold

> Status: DECISION
> Decision: ACCEPTED — OWNER DIRECTIVE 2026-11-01
> Date: 2026-11-01
> Scope: One operation-scoped SQLite recovery path for a confirmed terminal Worker generation

## Context

A SQLite Operation can remain in `cleanup_incomplete` after its Worker root has
exited and its Claimant Scan is clean. The normal lifecycle cannot close such an
Operation because no committed Result exists and the original live Worker handle
is no longer available to prove Cleanup.

Without a bounded recovery path, one abandoned test Operation can retain
Capacity and prevent the Manager from accepting every later Task. Treating PID
absence, a Result, Cleanup Verified, or a normal Release as proven would make
the lifecycle report a fact that was never established.

## Decision

1. A narrow operator command may administer one exact
   `cleanup_incomplete` Hold. The binding includes Operation ID, Task ID,
   Attempt, Generation, Operation revision, Claim ID, and Worker identity
   digest.
2. Before mutation, the command must verify a Windows restart after the Hold,
   absence of Codex Host and Bridge/Worker writers, exact recorded Worker exit,
   a clean real Claimant Scan, unchanged Claim/revision, absent Result, and the
   expected running projections. Any uncertainty fails closed.
3. The administration records effective terminal outcome
   `admin_abandoned` in an immutable sidecar. The underlying Operation uses the
   existing `released` carrier so one Capacity slot is freed without creating a
   normal `released` lifecycle Event.
4. Task and Attempt become `failed`. The audit records
   `result_absent=true`, `cleanup_verified=false`, the administrative reason,
   time facts, and digests of the sanitized process-inventory, platform-probe,
   and Claimant-Scan evidence.
5. The operation is one-shot and CAS-fenced. Replay succeeds only when the
   recomputed administrative request and audit digest exactly match the
   retained record. Different evidence, revision, Claim, or Worker identity is
   rejected without changing state.
6. An administered Task cannot Spawn, Resume, Continue, or recover into
   execution. Existing Events, Hold evidence, and error reasons remain intact.
7. This path does not generalize into an administrative MCP tool, remote API,
   background service, general Result bypass, or reusable Cleanup exemption.

## Rationale

The normal Cleanup contract proves that no live Worker resources remain. Here,
the stronger post-restart and Claimant-Scan checks establish that the Worker
generation has ended, but do not claim that historical descendant or resource
closure was observed. Naming the effective terminal state separately preserves
that distinction and avoids misreporting the operation as a verified Cleanup.

## Consequences

- Capacity can be recovered after a bounded post-restart operator procedure.
- Abandoned work remains failed and unavailable for execution.
- Audit history remains append-only and explicitly distinguishes administrative
  recovery from Result, Cleanup Verified, and normal Release.
- The operator command, generated schemas, plugin assets, and documentation
  form one shipping closure.
- Production execution of the command requires separate Owner authorization.
