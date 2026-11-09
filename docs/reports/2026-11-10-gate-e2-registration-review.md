# Gate E2 Registration Repair Independent Review

> Status: RESEARCH
> Date: 2026-11-10
> Base commit: `064d23ce2d46aa7cda4519cc495f849e4fb60f22`
> Initial repair commit: `f46a81b48385e2669e8d541a3b89475f42a2c315`
> Official CLI/AppServer observed: `0.17.1`

## Review result

The initial repair is architecturally within scope. It changes only the
task-scoped Account Provider Snapshot and ADR-011 registration diagnostics. It
does not modify Billing, OAuth, credential discovery, Provider retry, private
credential leasing, HANDLE identity, SQLite persistence, Cleanup, or Release.

The original Gate E2 remains `BLOCKED`. Its missing RPC error body remains
`NOT_OBSERVABLE_IN_ORIGINAL_RUN`; the offline `-32603` reproduction does not
replace that historical fact.

## Compatibility boundaries

### No-task Model Catalog Snapshot

Result: `NO_CHANGE_REQUIRED`.

Native isolated tests used a synthetic personal Provider config, synthetic
account-cache state, no JWT, and the installed AppServer `0.17.1`.

- The no-task snapshot retained optional absent `current` for Off-Peak and
  Highspeed providers.
- `provider/updateAccountConfig` accepted the snapshot.
- `session/create` returned the synthetic Individual Coding Plan catalog.
- With synthetic available Off-Peak and Highspeed cache entries, the runtime
  accepted the snapshot and advertised both optional providers.
- No task-selected route or entitlement contract was changed.

Therefore the optional `current` fields on the no-task catalog path do not
require the task-scoped all-boolean correction.

### Built-in Revision Source

Result: `NO_CHANGE_REQUIRED`.

Bridge passes the resolved official `zcode-builtin.json` through
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`. For a child process with both built-in and
personal config variables set, AppServer `0.17.1` uses that built-in path as its
active source. Its revision key is based on the resolved source path, which
matches `zcodeBuiltinRevision()` in Bridge.

Native isolated checks:

```yaml
installed_builtin_revision: 43
correct_revision_registration: PASS
start_plan_model_catalog: 3
start_plan_model_selection: PASS
same_content_different_path: PASS
incorrect_revision_rpc: ACCEPTED
incorrect_revision_catalog: EMPTY
missing_current_rpc: RPC_REJECTED (-32603)
session_send: NOT_CALLED
```

The wrong revision registration RPC returning success is not treated as proof
of application. The subsequent empty model catalog confirms the registry did
not apply the Start Plan account snapshot.

## Additional diagnostic defect repaired

Independent review found that request timeout and pre-request closed states also
used the internal `kind: "rpc"` candidate. The first repair classified every
such candidate as `RPC_REJECTED`, even when no RPC error frame had been observed.

The minimal repair adds an internal `rejected` boolean to the existing
`FactsCandidate`. It does not alter the frozen `FailureFactsV1` shape:

- an observed JSON-RPC error frame is `RPC_REJECTED`;
- timeout or closed-before-request cannot be labeled as an RPC rejection;
- RPC method, numeric code, and registered data code are retained only as
  observable structured evidence.

Added regression:

- An unstructured RPC error frame remains `RPC_REJECTED` without inventing a
  numeric or business error code.

## Validation

```yaml
targeted_tests: 94 PASS
typecheck: PASS
build: PASS
plugin_validation: PASS
diff_check: PASS
windows_ci: NOT_RUN
ubuntu_ci: NOT_RUN
sqlite_stress: NOT_APPLICABLE
```

The targeted serial run covered Account Provider snapshots, Start Plan
production auth, registration diagnostics, Coding Plan behavior, Result
handling, Windows cleanup behavior, and adapter lifecycle tests.

## Preview 2 release preparation

Target version: `2.0.0-preview.2`

Suggested annotated Tag:
`codex-zcode-bridge-preview-v2.0.0-preview.2`

Proposed release-note delta:

### Fixed

- Account Provider registration now publishes an explicit boolean `current`
  state for every Provider in a task-scoped snapshot.
- Start Plan Provider registration failures preserve sanitized RPC diagnostics
  through ADR-011 without publishing upstream error text.
- Timeout or closed-before-request registration failures are no longer
  mislabeled as RPC rejection.

### Validation

- Native AppServer `0.17.1` accepted task-scoped Start Plan and Coding Plan
  snapshots, returned three Start Plan models, and accepted the
  `GLM-5.3-Flash` selection.
- A same-content built-in file at a different path produced a matching revision.
- An intentional revision mismatch did not apply the Start Plan account
  snapshot.

### Not verified

- No real Billing, OAuth, Claim, Captcha, or model request was sent.
- The original HTTP 405 / possible 3012 disposition remains unconfirmed.
- Real Start Plan Gate E2 remains `NOT_RUN`.

## Client verification after a future release

After an independently authorized Preview release:

1. Upgrade `codex-zcode-bridge-preview`.
2. Start a new Codex session.
3. Confirm the active MCP path belongs to the released Preview version.
4. Confirm the MCP Server Version matches the package and manifests.
5. Run read-only `zcode_doctor`.
6. Reconfirm the resolved official ZCode root and Bridge SQLite root are
   separate.
7. Obtain separate Owner authorization before any real Start Plan retry.

## Remaining risks

- The original Gate E2 RPC error body was not retained.
- No real Start Plan turn has passed; HTTP 405 and 3012 remain unconfirmed.
- Windows cleanup has an observed intermittent race in prior parallel runs;
  this review did not change or weaken lifecycle assertions.
- Remote Windows/Ubuntu CI has not yet run for the final review commit.
