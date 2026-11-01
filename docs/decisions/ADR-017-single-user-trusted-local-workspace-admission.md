# ADR-017: Single-user trusted-local Workspace Admission

> Status: DECISION
> Decision: ACCEPTED v2 — OWNER DIRECTIVE 2026-11-01
> Date: 2026-11-01
> Scope: SQLite candidate Workspace Admission for the local Bridge; no Authority switch
> Supersedes: v1 Owner-maintained `workspace_roots` policy file design

## Revision history

- v1 required a regular `trusted-local-policy.json` file and an Owner-managed
  `workspace_roots` list. This changed ordinary JSON-mode workspace use into a
  manual project-registration workflow.
- v2 removes that project allowlist. The Host-owned capability remains
  mandatory, while workspace path acceptance follows the existing JSON Host
  workflow: an existing absolute local directory may be used, and an optional
  Host-prepared execution worktree may be supplied separately.

## Context

The original WP6D design required native stable file identity, complete ancestor
reparse-point inspection, fixed-volume proof, and resistance to path
replacement between validation and use. Its provenance and license remain
unresolved, and the implementation is deferred.

The production deployment model targeted by this release is narrower: one
trusted local user runs Codex and the Bridge under the same Windows account on
one machine. Other local users, remote clients, and a hostile process running
as the same account are outside this boundary.

The pre-SQLite JSON Authority already accepts an ordinary non-empty absolute
local project directory supplied by the calling Host, canonicalizes it, and
persists it. A separate optional `worktree_path`, when supplied by that Host,
selects the execution directory while the source project remains the ZCode
project identity. SQLite must preserve this user-visible workflow. Requiring a
new policy file or manually maintained project roots would create a SQLite-only
restriction and is not required by the single-user trusted-local boundary.

## Decision

1. Workspace Admission is available only in the local stdio Host composition.
   The Host issues an in-process capability; Task data, prompts, environment
   variables, Worker input, and MCP request fields cannot create or raise it.
2. SQLite Authority refuses to start unless that Host capability is present and
   its Trusted Local policy status is `enabled`.
3. The Host uses a fixed built-in single-user local policy. Normal users do not
   create or maintain `trusted-local-policy.json`, `workspace_roots`, a project
   registry, or a setup wizard.
4. A Workspace must be an absolute drive-letter path naming an existing local
   directory. Relative paths, UNC paths, missing paths, non-directories, and
   canonical-path mismatches fail closed.
5. `workspace` identifies the source project. The optional `worktree_path`, when
   present, is validated separately and becomes the execution path. SQLite
   persists both canonical paths and records the execution path as the
   Admission `workspace_ref`.
6. Both the source workspace and execution worktree are revalidated immediately
   before Worker use. Either path becoming unavailable fails closed before
   Spawn.
7. Task and Worker claims cannot set `unrestricted`, supply roots, change the
   fixed execution profile, or broaden the allowed operation kind. The Host
   capability and fixed policy remain authoritative.
8. A policy revision is applied to later checks. It does not rewrite or release
   existing Operations, Claims, Capacity, Cleanup, or Release state.

## Threat Model

The following are in scope and must be denied:

- relative, malformed, missing, non-directory, UNC, or remote paths;
- a source workspace or execution worktree that disappears before use;
- Task, Prompt, or Worker attempts to assert authority not granted by the Host;
- reuse of stale policy state after the Host capability or policy is disabled.

The following are outside the supported v2 boundary:

- a hostile process running as the same Windows user that replaces filesystem
  paths between checks;
- other local users, remote clients, or multi-user authorization;
- native stable file identity and complete ancestor-chain proof from WP6D;
- claiming that same-account filesystem mutation can be detected after the
  final pre-use check.

This decision preserves the practical trust boundary of a single-user local
Bridge. It does not claim the stronger WP6D properties, and it does not claim
that any existing local directory is safe from a hostile same-account process.

## Consequences

- SQLite uses the same ordinary local-directory and optional-worktree workflow
  as JSON mode; users do not maintain a project allowlist.
- The in-process Host capability remains mandatory, and Task or Worker data
  cannot supply or broaden it.
- SQLite remains opt-in and disabled in the current production configuration.
- The WP6D native files and provenance remain deferred and are not required for
  this boundary.
- Documentation and tests must state the threat-model limit explicitly; they
  must not describe path revalidation as protection against same-account
  adversarial replacement.
- Changing to multi-user, remote, or hostile-same-account operation requires a
  new decision and a stronger identity mechanism.
- This revision does not introduce a configuration wizard, project
  registration system, or multi-user authorization layer.
