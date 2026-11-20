# Legacy Retirement and Repository Simplification

> Status: RESEARCH
> Date: 2026-11-21
> Baseline: `c1245a02f8f9d4b6e1102eabac230b657d85de9b`
> Baseline tree: `b687bca64ce766b945178cf8af44442cf57f90b3`
> Code candidate: `3e2c637ce0f31963d27aef8c56da3e360013462c`
> Code candidate tree: `52b9a53a1138a7d0e614c657467584fb1be9d7cd`
> Scope: exact legacy retirement; no architecture expansion

## A. Retirement Inventory

The GLM-5.3 audit was present outside the current branch at
`D:\codex-zcode-bridge\.run\zcode-3190-compat-20261120\docs\reports\bridge-independent-architecture-audit-glm53-20261120.md`.
Its audited tree is the same tree as this Goal's baseline. This report uses its
Removal/Simplification Matrix and F-09 finding without copying the report or any
source from that worktree.

| Candidate | Original purpose | Production references | Test references | Decision |
|---|---|---|---|---|
| `src/runtime/sqlite-install-config.ts` `authority:"json"` branch | Treat the retired JSON authority setting as an implicit SQLite hint | Configuration loader used by Host and Thin Waiter | `sqlite-install-config.test.ts`, `wait-task.test.ts` | REMOVE |
| `upstream/zcode-3.18.0/patches/` | Historical 3.18.0 Official Host patch replay | None in `scripts/`, `src/`, `tools/`, `test/`, plugin code, `.github`, or `package.json`; current Patch Root is `upstream/zcode-3.18.2/patches/` | None | REMOVE |
| `docs/research/start-plan-gate2-2026-11-03/` | Gate 2 research, evidence, and manual gate prototypes | Research reference only | `frame.test.mjs` and `lease.test.mjs` are manual historical tests, not production-suite entries | KEEP / RESEARCH_REFERENCE |
| `testOnlyLegacyDirectAdapter` | Select `ZCodeAppServerTestAdapter` for direct-protocol tests | None | `legacy-direct-worker.ts`, `mvp-real-adapter.test.ts`, `worker-main.ts` test injection | KEEP |
| `ZCodeAppServerTestAdapter` | Synthetic direct stdio protocol, framing, timeout, and cleanup boundary tests | None | Browser, failure-facts, session, Start Plan, timeout, and adapter suites | KEEP |
| `interruptAndRequeue()` | Atomic Result-less interruption/requeue contract | Store/port and lifecycle gate surface | `interrupt-requeue.test.mjs` and Manager/Recovery suites | KEEP |
| `testOnlyFakeAdapter` | Exercise otherwise unreachable synthetic cleanup/requeue branches | Explicit test-only claim-only driver option | Manager, MCP, SQLite lifecycle suites and `probe-result-resources.mjs` | KEEP |
| `testOnlyAutomaticRecoveryRequeue` | Candidate named by earlier audit terminology | Not found in the current tree | Not found | NOT_APPLICABLE |

## B. Actual Changes

### R-01: JSON Authority Hint

`loadInstallAuthoritySelection()` now rejects exactly
`{"schema_version":1,"authority":"json"}` with the stable code
`authority_config_json_unsupported`.

- No configuration rewrite.
- No database creation.
- No legacy `.tasks` read.
- Existing v14 database bytes remain untouched.
- Missing configuration still selects the default SQLite root.
- Valid SQLite configuration behavior is unchanged.
- Arbitrary unsupported authority values continue to fail with
  `authority_config_invalid_contract`.

ADR-016 received a v4 applicability note. The historical decision text remains
available; it is not treated as current behavior where it described the former
JSON upgrade hint.

The checked-in Bridge and Thin Waiter bundles were regenerated from source.

### R-02: ZCode 3.18.0 Patch Assets

The following six tracked files were removed after repository-wide reference
checks found no current build, test, plugin, artifact-BOM, validator, or release
packaging dependency:

| File | Bytes |
|---|---:|
| `0001-stdio-max-frame-bytes.patch` | 16,290 |
| `0001-stdio-max-frame-bytes.patch.sha256` | 99 |
| `0002-oauth-refresh-coordination.patch` | 49,456 |
| `0002-oauth-refresh-coordination.patch.sha256` | 105 |
| `0003-account-runtime-header-coordination.patch` | 21,461 |
| `0003-account-runtime-header-coordination.patch.sha256` | 113 |
| **Total** | **87,524** |

`upstream/zcode-3.18.2/patches/` remains unchanged:

- `0001-stdio-max-frame-bytes.patch`
- `0002-oauth-refresh-coordination.patch`
- `0003-read-only-official-start-plan-auth.patch`

Historical BOM/report references remain as history; the deleted files remain
available in Git history. The 3.18.2 Manifest, 3.19.0 authorization, Official
Host binary, and Runtime build were not changed.

### R-03: Gate 2 Research Assets

All 14 files under `docs/research/start-plan-gate2-2026-11-03/` are retained as
`RESEARCH_REFERENCE`. Exact Git blob comparison found no duplicate file in the
tracked tree. None is selected by the production test runner.

The two historical test-shaped files now carry an explicit
`RESEARCH_REFERENCE` header stating that they are not discovered by the
production test runner:

- `frame.test.mjs`
- `lease.test.mjs`

The manual scripts and evidence markdown remain unchanged except for that
classification header. No new archive tree or second copy was created.

### R-04: Test-Only Features

All investigated test-only features are retained by default:

- They have no production caller.
- They provide unique protocol, cleanup, requeue, identity, or credential-boundary
  regression coverage.
- Removing them would require changing production interfaces or losing an
  unreachable synthetic contract.
- The name `testOnlyAutomaticRecoveryRequeue` does not exist in this tree; no
  matching implementation was deleted.

### R-05: Additional Dead Assets

A limited reference audit covered `src/`, `scripts/`, `tools/`, `upstream/`, and
`plugins/codex-zcode-bridge/`. No additional retirement candidate met the
evidence threshold.

`src/cli/upgrade-sqlite-v14.ts` and the rest of v13 support are not changed by
this branch because they are owned by the SQLite v13 retirement Goal.

## C. Overlap With SQLite v13 Retirement

The v13 candidate is based on the same Preview baseline and remains unmerged.
This Goal did not copy its source or modify its worktree.

`OWNED_BY_V13_GOAL`:

- v13 schema, auto-upgrade, offline-upgrade CLI, markers, upgrade tests, and
  their documentation.
- `plugins/codex-zcode-bridge/dist/bridge.mjs` and
  `plugins/codex-zcode-bridge/dist/wait-task.mjs` are also changed by the v13
  candidate.

The two generated bundles in this branch are independently produced from the
current source and are required for the JSON-hint change to be real in the
installed plugin. They are not copied from the v13 branch. Mechanical Git merge
is not appropriate: integration must use one baseline and regenerate generated
artifacts after resolving the source changes.

No v14 Schema, `authority_switch`, `migration_runs`, `json_artifacts`, migrated
history tables, or production data were changed.

## D. Retained Contracts

- SQLite v14 Schema: unchanged.
- Existing v14 database and historical facts: unchanged.
- Official Host Session Factory and installed AppServer path: unchanged.
- Coding Plan Runtime Auth: unchanged.
- Start Plan Lease, entitlement, HANDLE/ACK, and secret redaction: unchanged.
- 3.18.2 patches and compatibility manifest: unchanged.
- 3.19.0 experimental authorization: unchanged.
- Worker/Claim/Recovery/Hold/Cleanup/Release semantics: unchanged.
- Public MCP tool names, inputs, and outputs: unchanged.
- Browser, Cost Lab, Master Skill, Windows process identity/tree cleanup: unchanged.

## E. Verification and Measured Benefit

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm run validate:plugin` | PASS |
| `npm run check:generated` | PASS, 12 tracked generated artifacts fresh |
| `git diff --check` | PASS |
| Targeted affected suite | PASS, 520/520 |
| Required SQLite stress boundary | PASS |
| Test Impact Selector mode | `TARGETED` with `STRESS_TEST_REQUIRED` |
| Full regression | NOT_RUN; selector did not require `FULL_SUITE` |
| Real model / OAuth / Billing requests | 0 |
| Files removed | 6 |
| Deleted patch/BOM lines | 2,254 |
| Artifact bytes removed | 87,524 |
| Tests removed | 0 |
| Tests added | 1 |
| Production source files removed | 0 |
| Production source lines removed | 2 modified lines, net 0 |
| CI runs in this branch before push | 0 |
| Wall-clock test duration | 1,277,519.84 ms |

The targeted run exercised the existing SQLite lifecycle, recovery, Windows
cleanup, Worker, MCP, Startup, Start Plan, and Runtime regression boundaries
selected by the Impact Selector. The stress run retained the configured
256-history-task, four-process CAS, and eight-admission boundaries.

No performance improvement is claimed for the 87,524-byte deletion or the
generated bundle change. CI cost and runtime were not used as success criteria.

## F. Final Status

```text
GOAL: LEGACY_RETIREMENT_AND_REPOSITORY_SIMPLIFICATION

BASELINE: c1245a02f8f9d4b6e1102eabac230b657d85de9b
FINAL_CODE_HEAD: 3e2c637ce0f31963d27aef8c56da3e360013462c
FINAL_CODE_TREE: 52b9a53a1138a7d0e614c657467584fb1be9d7cd

V13_RETIREMENT_OVERLAP: PRESENT; OPEN V13 CANDIDATE; REGENERATE GENERATED ARTIFACTS AT INTEGRATION
JSON_AUTHORITY_COMPATIBILITY: REMOVED
ZCODE_3180_PATCHES: REMOVED
HISTORICAL_RESEARCH_ASSETS: KEPT_AND_MARKED
TEST_ONLY_FEATURES: KEPT
ADDITIONAL_DEAD_CODE: NO_ADDITIONAL_RETIREMENT_RECOMMENDED

V14_SCHEMA_CHANGED: NO
PRODUCTION_LIFECYCLE_CHANGED: NO
OFFICIAL_HOST_CHANGED: NO
MCP_PUBLIC_SCHEMA_CHANGED: NO

FILES_REMOVED: 6
SOURCE_LINES_REMOVED: 2 MODIFIED, NET 0
ARTIFACT_BYTES_REMOVED: 87524
TESTS_REMOVED: 0

TYPECHECK: PASS
BUILD: PASS
PLUGIN_VALIDATOR: PASS
GENERATED_ARTIFACTS: PASS
FOCUSED_TESTS: PASS 520/520
FULL_REGRESSION: NOT_RUN (NOT REQUIRED BY IMPACT SELECTOR)
CI_RUNS: PENDING PUSH

PUSHED: NO AT REPORT WRITE
PR_CREATED: NO AT REPORT WRITE
PREVIEW_MERGED: NO
RELEASED: NO

FINAL_VERDICT: PASS
```
