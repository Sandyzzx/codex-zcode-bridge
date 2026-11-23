# Async Executor PR 2-6 Unified Release Candidate

> Status: RESEARCH
> Date: 2026-11-22 (Asia/Shanghai)
> Branch: `codex/async-executor-rc-20261122`
> Integration baseline: `origin/preview@ac1e8396f25a1a1d3ff373def84726d28c1f4193`
> Candidate code: `c75c34330287266702cab5949662bf897b74ed5a`
> Conclusion: `PARTIAL / BLOCKED`

## Verdict

The unified PR 2-6 candidate is locally buildable and passes the complete
Windows functional regression, the registered stress matrix, generated-artifact
checks, plugin validation, and the deterministic Executor lifecycle suites.

It is not a release candidate for merge. The independent real Host gates remain
unmet:

- real Codex Desktop close followed by original Attempt execution, Result,
  Cleanup, and Release: `BLOCKED`;
- real Official ZCode Runtime/provider execution: `NOT_RUN`;
- strict Wake C (`notLoaded`) and D (Desktop fully exited): `NOT_RUN`;
- real model adherence to the Async Master Handoff Skill: `NOT_RUN`.

No Preview merge, release tag, paid model request, or Owner Desktop shutdown was
performed while producing this evidence.

## Environment and Scope

| Item | Value |
|---|---|
| Platform | Windows x64 |
| Node.js | `24.16.0` |
| Package | `codex-zcode-bridge@2.0.0-preview.12` |
| SQLite Authority | `v14 ONLY` |
| Base | Preview.12 `ac1e8396f25a1a1d3ff373def84726d28c1f4193` |
| Candidate | `c75c34330287266702cab5949662bf897b74ed5a` |

The candidate contains PR 2 through PR 6:

- independent Executor Lifetime Lease and exact process ownership;
- Idle-only Shutdown and Store-before-Lease release ordering;
- bounded Named Pipe Control IPC;
- Thin MCP, Control-only Task CLI, and loopback Task Web Console;
- fail-closed one-shot Queue Wake with Web Notify fallback;
- Async Master Handoff Skill contract.

There is no Supervisor, second task database, second task state machine,
second recovery engine, or second Worker execution path.

## Local Release Gates

| Gate | Status | Evidence |
|---|---|---|
| Test compilation and complete isolated regression | `PASS` | `.run/rc-test-full-r6.log`: 1060 tests, 1058 pass, 0 fail, 2 skip, 1,389,331 ms |
| Plugin validation inside full regression | `PASS` | `Plugin package is structurally valid (codex-zcode-bridge@2.0.0-preview.12)` |
| Registered SQLite/Worker stress matrix | `PASS` | `.run/rc-stress-r1.log`: 4 tests, 4 pass, 0 fail |
| Cost Lab suite | `PASS` | `.run/rc-cost-lab-r1.log`: 86 tests, 86 pass, 0 fail; GitHub CI remains a separate gate |
| Generated artifacts | `PASS` | `npm run check:generated`: 13 tracked files fresh after commit |
| Patch whitespace | `PASS` | `git diff --check` |
| GitHub Release Gate | `NOT_RUN` | Must pass on the pushed candidate before merge |

The two skips are existing registered manual/platform skips. They are not
converted to PASS.

## Core Lifecycle Matrix

| Acceptance item | Status | Evidence boundary |
|---|---|---|
| Lifetime Lease, exact PID/start fingerprint, heartbeat | `PASS` | Deterministic lease and process suites |
| Double start and old-Host mutual exclusion | `PASS` | Second owner fails before writable Store ownership |
| Manual lease clear cannot remove a live owner | `PASS` | Explicit negative coverage |
| Idle-only Shutdown rejection restores service | `PASS` | `EXECUTOR_SHUTDOWN_NOT_IDLE`; later control requests succeed |
| Store closes before lease release | `PASS` | Release ordering and release-failure tests |
| IPC cancellation versus Task cancel | `PASS` | `REQUEST_CANCELLED`, `TASK_CANCEL_REQUESTED`, `SUBMISSION_UNKNOWN`, `EXECUTOR_UNAVAILABLE` are distinct |
| Thin MCP has no local SQLite Authority | `PASS` | Startup creates no SQLite/Authority state; unavailable Executor fails closed |
| Thin MCP reconnect reads the same durable Task | `PASS` | Disconnect does not cancel the accepted Task |
| Original Attempt Result/Cleanup/Release across processes | `PASS` | Fake Worker E2E commits one original Result, verifies Cleanup, and releases the Operation |
| 32 MiB Result over IPC/MCP boundaries | `PASS` | Exact 32 MiB Result and envelope behavior |
| SQLite v14 compatibility | `PASS` | No schema bump or second persistence authority |
| Queue Wake policy and SQLite evidence | `PASS — SYNTHETIC` | Loaded/idle exact-config only; uncertain conditions use Web Notify |
| Async Master Handoff contract | `PASS — CONTRACT` | Static Skill policy only; live model adherence is not proven |

## Root-Exit Shutdown Race

The earlier complete regression failed one stdio-shutdown test after Windows
reported `process_tree_root_exited` between exact identity probing and the fresh
tree transaction. The failure left Result submission rejected and retained
occupancy, which was fail-closed but prevented the intended Cleanup/Release E2E.

Commit `c75c34330287266702cab5949662bf897b74ed5a` narrows recovery of that
specific error:

1. only `process_tree_root_exited` enters the reconciliation path;
2. a fresh exact process probe must prove the recorded root exited;
3. the existing durable recorded-tree scan must still prove every descendant
   clean before Result/Cleanup/Release continues;
4. every other termination error remains fail-closed;
5. no Result is synthesized and no Workspace is released without tree proof.

Evidence:

- focused shutdown race: `.run/shutdown-race-repro-r1.log`, 20/20 PASS;
- same test under CPU load: `.run/shutdown-race-under-load-r1.log`, 12/12 PASS;
- affected composition suite: `.run/wp6b-composition-r1.log`, 67/67 PASS;
- final complete local regression: `.run/rc-test-full-r6.log`, PASS.

The original full-suite timing was not reproduced exactly under artificial load.
The fix is therefore supported by deterministic fault injection and the final
complete regression, not by a claim of exact historical reproduction.

## Independent Gates

| Gate | Status | Reason |
|---|---|---|
| Real Codex Desktop close E2E | `BLOCKED_BY_OWNER_ENVIRONMENT` | Closing the Owner's active Desktop was not authorized or safe |
| Real Official Runtime/provider E2E | `NOT_RUN` | No new paid model authorization |
| Strict Wake C: unloaded Thread | `NOT_RUN` | Requires isolated real Host acceptance |
| Strict Wake D: Desktop fully exited | `NOT_RUN` | Requires isolated real Host acceptance |
| Desktop realtime visibility | `NOT_RUN` | No UI acknowledgement evidence |
| Real Async Master model adherence | `NOT_RUN` | Static Skill contract cannot prove runtime model behavior |
| Multi-user Named Pipe isolation | `NOT_RUN` | Current deployment contract remains trusted single-user local |

## Release Decision

`PARTIAL / BLOCKED`.

The implementation and complete local regression are sufficient to submit the
unified PR for review and CI. They are not sufficient to:

- merge the candidate into `preview`;
- publish or tag a release;
- claim that Desktop-close execution durability is proven;
- claim that Queue Wake supports unloaded Threads or a fully exited Desktop;
- claim that real Official Runtime or real model Skill adherence passed.

Preview promotion requires the pushed GitHub Release Gate to pass and separate
Owner-led acceptance of the independent real Host gates above.
