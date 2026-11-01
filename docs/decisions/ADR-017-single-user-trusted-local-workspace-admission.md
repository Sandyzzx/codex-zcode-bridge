# ADR-017: Single-user trusted-local Workspace Admission

> Status: DECISION
> Decision: ACCEPTED — OWNER DIRECTIVE 2026-11-01
> Date: 2026-11-01
> Scope: SQLite candidate Workspace Admission for the local Bridge; no Authority switch

## Context

The original WP6D design required native stable file identity, complete ancestor
reparse-point inspection, fixed-volume proof, and resistance to path
replacement between validation and use. Its provenance and license remain
unresolved, and the implementation is deferred.

The production deployment model targeted by this release is narrower: one
trusted local user runs Codex and the Bridge under the same Windows account on
one machine. Other local users, remote clients, and a hostile process running
as the same account are outside this boundary. The Admission contract must
still reject paths supplied by Tasks or prompts that escape the roots selected
by the Owner.

## Decision

1. Workspace Admission is available only in the local stdio Host composition.
   The Host issues an in-process capability; Task data, prompts, environment
   variables, Worker input, and MCP request fields cannot create or raise it.
2. SQLite Authority refuses to start unless that Host capability is present and
   its Trusted Local policy status is `enabled`.
3. The policy is loaded only from
   `%USERPROFILE%\\.codex\\codex-zcode-bridge\\trusted-local-policy.json`.
   The file must be a regular, non-symlink file of bounded size with the exact
   supported schema and a known local execution profile.
4. A Workspace must be an absolute local drive path naming an existing
   directory. UNC paths, missing directories, malformed paths, and paths
   outside the configured Owner roots are denied.
5. The policy and roots are re-read for Candidate admission and immediately
   before Worker use. A changed or unavailable policy, a changed configured
   root, or a canonical path outside the Owner scope fails closed.
6. Task and Worker claims cannot set `unrestricted`, add roots, change the
   execution profile, or broaden the allowed operation kind.
7. A policy revision is applied to later checks. It does not rewrite or release
   existing Operations, Claims, Capacity, Cleanup, or Release state.

## Threat Model

The following are in scope and must be denied:

- accidental or request-supplied paths outside the configured local roots;
- UNC or remote paths;
- malformed, symlinked, oversized, or unknown policy files;
- policy or root changes that cannot be revalidated;
- Task, Prompt, or Worker attempts to assert authority not granted by the Host;
- reuse of stale policy state after the Host capability or policy is disabled.

The following are outside the supported v1 boundary:

- a hostile process running as the same Windows user that replaces filesystem
  paths between checks;
- other local users, remote clients, or multi-user authorization;
- native stable file identity and complete ancestor-chain proof from WP6D;
- claiming that same-account filesystem mutation can be detected after the
  final pre-use check.

This decision preserves the practical trust boundary of a single-user local
Bridge. It does not claim the stronger WP6D properties.

## Consequences

- The Workspace Admission blocker is closed for the single-user trusted-local
  deployment boundary.
- SQLite remains opt-in and disabled in the current production configuration.
- The WP6D native files and provenance remain deferred and are not required for
  this boundary.
- Documentation and tests must state the threat-model limit explicitly; they
  must not describe path revalidation as protection against same-account
  adversarial replacement.
- Changing to multi-user, remote, or hostile-same-account operation requires a
  new decision and a stronger identity mechanism.
