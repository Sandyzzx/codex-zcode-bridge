# ADR-041: Thin Official Host end state

> Status: DECISION
> Date: 2026-11-19
> Decision: Accepted by the `Thin Adapter End-State - Complete Architecture Convergence` Owner goal.
> Applicability: ACTIVE CANDIDATE on `codex/unified-official-appserver-startplan-20261119`.
> Verified against: `5501c60ecf3f1812a3d3170a670ab0031ea784d8`

## Context

The Bridge already keeps its SQLite Task Authority, Worker lifecycle, process
identity, Result, Cleanup Proof, and Release CAS. The remaining runtime
divergence is narrower:

1. `zcode_model_catalog` starts its own AppServer and implements its own
   framing, request, timeout, authentication reply, and process cleanup.
2. Coding Plan and Start Plan use the installed Official AppServer, while other
   Providers still use the packaged AppServer.
3. `ZCodeAppServerAdapter` retains a direct AppServer implementation that is
   also reachable from the public Core export.
4. The Official Host build retains three locally maintained patches.

These are runtime-composition issues, not reasons to rewrite SQLite or the
Worker state machine.

## Decision

### 1. One Official Host session factory

Model catalog reads and task execution must use one shared Official Host
session factory for:

- installed Runtime resolution and compatibility verification;
- Official Host module loading and asset verification;
- `ZCodeAgentProcessManager` and `ZCodeProtocolClient` construction;
- reverse-RPC transport;
- timeout, process identity, and close ownership;
- official Provider Runtime Auth and Start Plan authentication boundaries.

The model catalog may own an independent short-lived session, but it must not
spawn an AppServer itself or implement JSON-RPC framing, pending requests,
timeouts, authentication replies, or process-tree cleanup.

### 2. Installed AppServer is the only production AppServer

After provider compatibility is verified, every supported Provider uses the
installed, compatibility-manifest-verified ZCode AppServer. Provider-specific
authentication and entitlement rules remain separate:

- Coding Plan uses the official OAuth Provider Runtime Auth service;
- Start Plan continues to use Live Entitlement, Private Credential Lease,
  Worker-parent binding, HANDLE/ACK, expiry, cancellation, and redaction;
- other account/API-key/custom Providers use their existing official
  configuration or an explicit, documented compatibility failure.

No production path silently falls back to a packaged AppServer. A provider
that cannot use the installed runtime fails closed with a bounded diagnostic
unless a separately verified compatibility adapter is explicitly selected.

### 3. Direct stdio AppServer is test-only

Production Worker execution has one boundary:

```text
Worker -> Official Host session -> installed Official ZCode AppServer
```

The direct stdio implementation may remain only as an isolated test harness
for protocol, framing, timeout, failure-fact, and process-cleanup tests. It may
not be the default behavior of the public `ZCodeAppServerAdapter`, and it may
not be reachable through Core as a production execution bypass.

The `CodingAgentAdapter` contract, Session/Turn mapping, Interaction handling,
Usage/Events projection, Result, and Cleanup semantics remain unchanged.

### 4. Official Host patches are reduced independently

The three fixed-source patches are assessed independently:

- `0001-stdio-max-frame-bytes.patch`
- `0002-oauth-refresh-coordination.patch`
- `0003-read-only-official-start-plan-auth.patch`

A patch is removed only when the fixed upstream source provides an equivalent
behavior and the replacement has regression evidence. Otherwise it remains and
is marked `UPSTREAM_PENDING`. No patch is removed merely to claim a zero-patch
build.

## Preserved invariants

- SQLite is the single Task Authority.
- Task, Attempt, Claim, Admission, Launch Intent, Recovery, Result, Cleanup
  Proof, and Release CAS are not replaced.
- Start Plan and Coding Plan authentication are never merged.
- Credentials, OAuth material, keyring contents, account identity, signing, and
  device identity are not copied or reimplemented by Bridge.
- Public MCP schemas remain unchanged.
- Process identity and recorded-tree cleanup evidence remain mandatory.
- Unsupported or unverified runtimes fail closed.

## Consequences

The expected steady-state topology is:

```text
Codex Host
  -> Bridge MCP / Host Adapter
  -> SQLite Task Authority
  -> Worker
  -> Official Host session factory
  -> installed Official ZCode AppServer
  -> Result / Cleanup Proof
  -> SQLite Release CAS
```

The packaged AppServer and its builtin Provider config become removable only
after production imports, tests, build scripts, plugin validation, BOM, and
distribution checks prove there is no remaining dependency.

## Required verification

- Model catalog uses the installed Runtime resolver and shared session factory,
  preserves cache/catalog/alias behavior, and sends no static Coding Plan API
  key reply.
- Every existing Provider has an evidence-backed compatibility disposition.
- Production Worker has no direct or packaged AppServer fallback.
- Direct stdio survives only through an explicit test-only harness.
- Build, plugin validation, generated artifacts, focused tests, affected tests,
  and full tests are reported truthfully.
- Patch status is independently recorded as upstream-equivalent or
  `UPSTREAM_PENDING`.
