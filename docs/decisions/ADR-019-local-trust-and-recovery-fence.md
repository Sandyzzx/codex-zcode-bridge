# ADR-019: Local trust mode and recovery ownership fences

> Status: DECISION
> Decision: ACCEPTED — OWNER DIRECTIVE 2026-11-02
> Date: 2026-11-02
> Scope: single-user local stdio Bridge, SQLite Worker admission and startup Recovery
> Related: ADR-002, ADR-017, ADR-018

> Supersession note (2026-11-04): ADR-024 replaces Decisions 5–8 only for
> Operation-scoped startup Recovery, dispatch, and explicit cleanup recovery.
> Decisions 1–4 on trusted-local execution and authorization boundaries remain
> in force. The previous per-Manager read-only fence no longer blocks unrelated
> workspaces; SQLite Admission now serializes overlapping workspace ownership.

## Context

The supported deployment is one trusted user running Codex and the Bridge under
the same Windows account on one local machine. The JSON production path uses
ZCode `yolo` mode by default for ordinary local tool operations. The SQLite
integration must preserve that workflow rather than silently forcing every
ordinary write, edit or command through `build`-mode approval.

Operational evidence also showed a separate recovery-ownership defect. One
Manager can start while another Manager still owns a running Operation. If the
second Manager's process probe is temporarily unknown, treating that uncertainty
as a durable `cleanup_incomplete` Hold prevents the owning Worker from recording
its next interaction request or cancellation intent. A local probe timeout is
not proof that the owning execution failed.

## Decision

1. The fixed trusted-local SQLite execution profile uses ZCode `yolo` mode for
   ordinary local operations, matching the JSON Host workflow. The persisted
   profile ID `local-build-v1` is retained for compatibility; policy revision
   `single-user-local-v3` records the mode change.
2. Workspace admission still requires the in-process trusted-local Host
   capability. A workspace must be an existing absolute local directory, and
   the optional execution worktree is revalidated before use. No
   `workspace_roots`, project registry or policy file is introduced.
3. `yolo` uses the current Windows account's permissions. A workspace,
   worktree, task prompt, `allowed_paths` or `forbidden_paths` is not an OS
   sandbox. The Bridge does not elevate privileges.
4. Publishing, merging, tagging, release, production Authority changes,
   destructive cleanup outside the approved task scope, credential changes and
   access to production task data remain explicit user decisions. Task and
   Skill instructions cannot manufacture those authorizations.
5. During startup Recovery, a `running` Operation whose exact Worker identity is
   `alive`, or whose probe is transiently `unknown`, returns a per-Manager
   read-only fence. This Manager must not create tasks, dispatch work or mutate
   the Operation. It must not append a durable global Recovery Hold.
6. The owning Manager remains able to persist interaction replies and
   cancellation intent while a second Manager is fenced. This decision does not
   transfer ownership, terminate the Worker or release its Claim or Capacity.
7. Once a `running` Worker is conclusively `exited` without a committed Result,
   or when Result, Cleanup or Release evidence is incomplete, existing
   fail-closed and administrative-recovery rules continue to apply.
8. An existing durable Hold is not removed by this policy change. Resolution
   must use the existing evidence-bound Recovery or `admin_abandoned` path; no
   command may delete Hold events directly.

## Consequences

- SQLite and JSON use the same ordinary local workspace and `yolo` workflow for
  normal coding tasks.
- Probe timeouts from a secondary Manager no longer deadlock the owning Worker.
- Exact exit, unresolved interaction, cleanup failure and Authority ambiguity
  remain blocking conditions.
- The change depends on the single-user trusted-local boundary. Multi-user,
  remote or hostile-same-account operation requires a stronger OS-level policy.
