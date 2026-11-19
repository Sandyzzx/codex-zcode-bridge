# Cost Lab Unified Billing Web Integration

> Status: RESEARCH
> Last updated: 2026-11-19
> Last verified: 2026-11-19
> Verified against: cd7e22e9a2042b0e8c6f45f54101bdbc7ba25a16

## Result

Cost Lab now exposes the verified Start Plan Billing Reader through its existing
local Web Server and `Billing & Usage` page. Coding Plan remains a separate
credit workflow. Start Plan remains a separate token-unit balance and is never
converted into Coding Plan credits.

The implementation is read-only. It adds no Start Plan model execution route,
changes no production Bridge authentication or routing, and does not alter the
Preview plugin bundle.

## Baseline And Integration

- Worktree: `D:\codex-zcode-bridge\.run\cost-lab-unified-billing-web-20261119`
- Branch: `codex/cost-lab-unified-billing-web-20261119`
- Integration baseline: `c706a62e9be89210eacd6c36dbdf78ff5bc3b1e4`
- Baseline tree: `84951e5585a517b63d5082feb4267baa95925529`
- Start Plan Reader source: `895ccace72d1d148ae5637d69fca3f159896e566`
- Implementation commit: `cd7e22e9a2042b0e8c6f45f54101bdbc7ba25a16`
- Implementation tree: `1c63cee72f224cccba038c75b44c9776a2b6a8ee`

The initial cherry-pick of the old Reader commit was aborted after conflicts
showed that its CLI-era `tools/cost-lab/lib/io.mjs` dependency no longer exists
in the Web architecture. The official authentication and entitlement logic was
ported into the existing Web baseline instead.

The root worktree's `M AGENTS.md` and `?? $null` were not read into or changed by
this worktree. An existing zero-byte `$null` file in this integration worktree
was left untracked.

## Reader Reuse

`tools/cost-lab/startplan-reader.mjs` calls compiled official Bridge modules:

- `StartPlanBillingEntitlement`
- `loadOfficialHostProductVersion`
- `loadOfficialStartPlanAuthenticationResolverFactory`

It does not implement JWT acquisition, credential decryption, device identity,
official header construction, or entitlement interpretation.

The only official request is:

```text
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.18.2
```

The reader enforces the exact origin, path, method, and sole query key. It has a
20-second operation bound, one request attempt, no retry, and a fail-closed
persistent credential refresh callback.

Credential metadata is inspected before and after the read. Credential content
is not read or hashed by the Web layer. The observed keyring lock must not exist
before the read and must be released after it.

## Persistence And Comparison

Start Plan history uses:

```text
.run/cost-lab-web/startplan-history.json
```

Each successful read stores:

- Unique snapshot ID and capture time
- Official server time
- Sanitized raw response
- Normalized plans and buckets
- Hashed opaque account, bucket, entitlement, and request identifiers
- Token totals and period/expiry values when present
- Integrity, request metadata, and read-only state evidence
- A deduplication digest

Missing values remain `null`/`UNKNOWN`; they are not converted to zero. Multiple
units or ambiguous entitlements do not produce an aggregate balance.

Comparison requires a matching account, bucket, entitlement, unit, and billing
period. A changed period is reported as `ROLLED_OVER`, not negative usage.

## Web API

The existing loopback-only server now exposes:

```text
GET  /api/billing/startplan/latest
GET  /api/billing/startplan/history?from=&to=&limit=
POST /api/billing/startplan/refresh
GET  /api/billing/startplan/history/:id/export
```

Refresh behavior:

- Existing same-origin, CSRF, Host, and same-site checks apply.
- Arbitrary account, path, provider, endpoint, and data-root inputs are rejected.
- Concurrent refresh requests share one in-flight read.
- A local cooldown prevents rapid repeated official reads.
- A failed read does not replace the last successful snapshot.
- 401, 403, 429, malformed success, transport error, and timeout are not retried.

`GET /api/billing/startplan/latest` and history reads only local persisted data.
They report `official_request_performed: false`.

## Frontend

The existing Cost Lab UI now has one `Billing & Usage` page containing:

- The unchanged Coding Plan credit-ledger view
- A separate Start Plan overview
- Total, used, and remaining token values
- Usage progress
- Per-bucket details
- Billing period and expiry
- `FRESH`, `STALE`, `EXPIRED`, `LOADING`, `ERROR`, and `UNKNOWN` states
- Refresh, history, comparison, and export actions
- Historical snapshot rows and explicit no-history/no-bucket states

Direct `#billing` navigation is supported. A page load and reload request only
local Cost Lab APIs; neither calls the official Start Plan endpoint.

## Offline Verification

Executed in the integration worktree:

```text
npm run build:core
npm run cost-lab:test
node --check tools/cost-lab/web/app.js
node --check tools/cost-lab/web/startplan-view.mjs
git diff --check
```

Results:

```yaml
CORE_BUILD: PASS
COST_LAB_TESTS: 81/81 PASS
FRONTEND_SYNTAX: PASS
DIFF_CHECK: PASS
MODEL_REQUESTS: 0
```

The final suite preserves all prior Coding Plan and Web tests. New coverage
includes exact official GET enforcement, timeout, 401/429 mapping, refresh
deduplication, cooldown, failure retention, history persistence, date filters,
redaction, mixed units, expiry, rollover, export, page-load zero-request
behavior, and frontend view states.

The baseline suite initially failed one pre-existing provenance assertion:
`BUILD_PROVENANCE.json` and the patch sidecar recorded an older SHA-256 than the
tracked patch content. Both metadata files were corrected to the actual patch
hash:

```text
7DBB5F62CB9A23D02E5DD4B5D4C8331F0BA4953A8DB1F8CBE7EAF8153502AFEB
```

No vendored billing runtime or billing calculation was changed.

## Real Web Billing Smoke

Start command:

```powershell
npm run cost-lab:web
```

Smoke URL:

```text
http://127.0.0.1:43119/
```

Exactly one explicit Web API refresh was issued. There was no model request.

Observed result:

```yaml
HTTP_STATUS: 200
OFFICIAL_BILLING_GET_ATTEMPTS: 1
DEDUPLICATED: false
CAPTURED_AT: 2026-11-19T01:25:49.360Z
OFFICIAL_SERVER_TIME: 2026-11-19T01:25:50.000Z
FRESHNESS_AT_CAPTURE: FRESH
INTEGRITY: PASS
OFFICIAL_CODE: 0
PLAN_COUNT: 0
BUCKET_COUNT: 0
CREDENTIAL_METADATA_UNCHANGED: true
KEYRING_LOCK_RELEASED: true
MODEL_REQUESTS: 0
```

The official response was structurally valid but returned empty `plans` and
`balances` arrays. Therefore the current page correctly shows no active plan
or bucket values. It does not reuse the earlier 299,897,316 remaining-token
snapshot as current data.

After the refresh, the page was loaded and reloaded. History remained at one
snapshot, the latest API still reported `official_request_performed: false`, and
no second official billing read occurred.

Local smoke evidence:

```text
.run/cost-lab-web/startplan-history.json
SHA-256 51713343A168A7E7DA0FBDF20D9EAA0AE4D6CE332B190CB5612D7276CFB251EC

.run/cost-lab-web/startplan-refresh-response.json
SHA-256 F4E417A88E3084A728D47D0E37E70A6AE6C83256792E60DFAFA8425405F5E6BA
```

The stored response was scanned for bearer tokens, credential paths, device MID
values, and fixture secret markers. None were present. Opaque `logid` and request
IDs are stored as stable hashes.

The Web Server was stopped after the smoke; the process exited and port 43119
was released.

## Limitations

- The real response contained no active plan or balance bucket, so a non-empty
  real multi-bucket display was not available in this run.
- `FRESH` means the capture is recent. It does not make an absent or expired
  entitlement active.
- The Start Plan UI proves read-only billing access and persistence. It does not
  prove Start Plan model execution, CAPTCHA behavior, or any discount.
- History comparison with two real non-empty snapshots remains not exercised;
  comparable, mixed-unit, unknown, expiry, and rollover behavior is covered by
  deterministic tests.

## Acceptance

```yaml
STARTPLAN_READER_REUSE: PASS
WEB_API_INTEGRATION: PASS
WEB_UI_INTEGRATION: PASS
CODING_PLAN_REGRESSION: PASS
SNAPSHOT_HISTORY: PASS
BUCKET_RECONCILIATION: PASS
SECURITY: PASS
REAL_WEB_BILLING_SMOKE: PASS
MODEL_REQUESTS: 0
PRODUCTION_BRIDGE_CHANGED: NO
PLUGIN_BUNDLE_CHANGED: NO
PREVIEW_RELEASED: NO
```

The real smoke is a successful connection, one-read, persistence, and UI-state
verification. It is not evidence that the signed-in account currently has an
active Start Plan bucket.
