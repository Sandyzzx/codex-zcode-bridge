# Cost Lab Discount Causal Probe V4 Hypothesis Ledger

> Status: RESEARCH
> Last updated: 2026-11-17
> Scope: Evidence available through `c13c4ac941a661d04b92d4acf23818a578f2dbac` plus the V4 isolated harness changes.

This ledger orders source-supported explanations for why Native Coding Plan requests received the observed additional `0.67` credit factor while the unchanged Bridge B baseline received `1.0`. The official credits, not request shape or header similarity, decide each experiment.

## Fixed Baseline

| Fact | Native historical control | Bridge clean-window baseline |
|---|---:|---:|
| Provider | `account:bigmodel-individual-coding-plan` | `account:bigmodel-individual-coding-plan` |
| Model | `GLM-5.3-Flash` | `GLM-5.3-Flash` |
| Account scope | personal | personal |
| Billing scene | `CODING_PLAN` | `CODING_PLAN` |
| Actual / expected-normal credits | `0.6699917497` | `1.0000277588` |
| Evidence strength | aggregate hourly billing | clean-window request plus hourly billing |

Official source baseline:

- ZCode `3.18.2`
- Commit `fec975905a2abd4c07e35c40d51fa097a2258ec9`
- Tree `5e90fec80706b8381f94e4eef48cf821b9868916`

Anonymous client-config evidence captured at
`2026-11-17T22:33:43+08:00` returned HTTP `200` and still advertises the
`codingPlanBillingDiscount` campaign. The text says that model use through
Coding Plan in ZCode converts quota consumption by `0.67` throughout the
campaign, equivalent to about `150%` quota.

This copy proves the campaign is still advertised on the capture date. It does
not contain a model list, account allowlist, effective timestamp, enforcement
field, or transaction-level entitlement, so it cannot by itself prove that a
particular request received the discount.

## Priority Hypotheses

### H1: Persistent Official Project-Key Location Cache

| Field | Evidence |
|---|---|
| Description | Native Load Services restores the persistent `project-key-location:v1:*` record before obtaining a Coding Plan Project Token. The existing isolated Bridge harness replaced every location read/write with an in-memory `Map`, forcing the location to be rediscovered in the harness process. |
| Source file | `packages/services/src/model-provider/accountProjectTokenClient.ts` |
| Source location | `19-65` |
| Native behavior | `locationStore: credentialService`; the official read path uses `load(storageKey)` and the create path persists with `save(storageKey, ...)`. |
| Bridge baseline | The harness intercepted all `project-key-location:v1:*` operations and supplied an empty in-memory location. |
| Expected wire delta | Same account, Project Token endpoint, model endpoint, and auth flow; only the previously cached project location is restored instead of discovered again. No manually constructed auth or entitlement field. |
| Expected billing effect | If the project location identity is part of the server-side entitlement context, restoring it may recover Native `0.67`. If billing does not depend on this cache, the result remains `1.0`. |
| Test method | `v4-project-location-cache`: read the existing official encrypted location through the official read-only Credential Service; block every location write. Require nonzero `load_calls` and a `cache_hits` increment in the real B run. |
| Risk | Medium. Shared credential access is already governed by the approved read-only Credential Service and transient Keyring Lock. The variant must not write or delete the shared location. |
| Confidence | Medium. This is a concrete Native/Bridge source difference and the persistent cache exists and is valid, but no source code proves the server uses this cache state for discounts. |

Additional source locations:

- `packages/shared/src/project-access-token-client.ts:91-96`: persistent location-store interface.
- `packages/shared/src/project-access-token-client.ts:148-196`: stable key construction, `load`, validation, and `save`.
- `packages/shared/src/project-access-token-client.ts:267-269`: deletion only on an explicit `404`.

Current status: `FAIL`.

Real H1 evidence:

- Run: `.run/v4-h1-protocol-smoke-20261117T2210`
- Request: `msg_20261117220730729d503e66c34be1`
- Location cache: `load_calls=1`, `cache_hits=1`, `cache_misses=0`, `write_attempts=0`
- Official 22:00 bucket: cached `0`, uncached `13,733`, output `30`, credits `1.5913`
- Expected normal at `0.5`: `1.591295`
- Effective extra ratio: `1.0000031421`

The intended variable was exercised and produced `1.0`, not `0.67`. A persistent
project-key location cache is therefore not the discount switch.

### H2: Full Official Account-Auth Composition

| Field | Evidence |
|---|---|
| Description | The full official Local Services graph composes a settings-aware account-access resolver, official request-auth wrapper, Host API transport, Project Token client, API Key resolver, and credential service. The minimal Bridge runtime already shares the core Project Token and request-material path but resolves account access differently. |
| Source file | `packages/services/src/node.ts` |
| Source location | `1419-1624`, especially `1452-1520` and `1616-1624` |
| Native behavior | Account requests pass through `createAccountRequestAuthService(createAccountProviderRequestAuthService(...))`; the resolver reads current provider-family settings and account identity at request time. |
| Bridge behavior | Minimal runtime directly creates the official OAuth runtime auth service and supplies the target account/request context. |
| Expected wire delta | Potentially different account scope, Project Token selection, or runtime-auth invocation order. It should not introduce a new endpoint by itself. |
| Expected billing effect | A stricter current-account/scope check could affect which server-side entitlement context signs the request. Direct billing effect is unproven. |
| Test method | Do not spend a real request on the current minimal helper alone: `createOAuthProviderRuntimeAuthService` already constructs the same official `createAccountProviderRequestAuthService`, so replacing only the resolver callback is not a distinct full-auth assembly. A future test must initialize a materially different full service graph and declare every coupled variable. |
| Risk | Medium-high. Full `createLocalServices` has unrelated Host side effects and cannot be initialized wholesale merely for this probe. |
| Confidence | Low. The apparent wrapper difference is largely already closed by the official runtime helper. |

Current status: `DEFERRED_NOT_A_SINGLE_VARIABLE_TEST`.

Additional source locations:

- `packages/services/src/model-provider/accountRequestAuthService.ts:13-32`: official request-auth wrapper.
- `packages/services/src/model-provider/accountProviderRequestAuthService.ts:75-133`: current-access resolution, scope hash, Project Token material, and post-IO identity assertion.

### H3: Isolated Harness Device MID Divergence

| Field | Evidence |
|---|---|
| Description | Official `3.18.2` reads `deviceMid` from `${ZCODE_DATA_BASE_DIR}/.zcode/v2/telemetry-state.json` for source headers and Anthropic `metadata.user_id`. The isolated harness rewrites `ZCODE_DATA_BASE_DIR` to a fresh fixture home, so it generates a different Device MID unless the official runtime state is reused. |
| Source file | `apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts`; `apps/zcode-cli/packages/adapters/src/model/anthropic-request-metadata.ts`; bootstrap endpoint-routing source headers |
| Source location | `cli-device-mid.ts:34-51`; `anthropic-request-metadata.ts:8-31`; installed `zcode.cjs` source-header builder |
| Native behavior | Reads the persistent official telemetry state. The request audit records production Bridge as reusing the same Device MID when it uses the real data root. |
| Bridge harness baseline | Uses a task-local home/data root and a newly generated UUID. This is a confirmed isolation artifact, not evidence that production Bridge rotates identity. |
| Expected wire delta | Authentic `x-device-mid` source header when present and an authentic Device MID inside the redacted `metadata.user_id`. No manually supplied identity fields. |
| Expected billing effect | If campaign eligibility is bound to the ZCode Device MID, reuse may restore `0.67`. Otherwise the result remains `1.0`. |
| Test method | `v4-official-device-mid`: read only the official telemetry state, place only its existing `deviceMid` into the isolated official schema, keep every shared file unchanged, and let the official AppServer construct headers and metadata. Persist only a SHA-256 fingerprint in evidence. |
| Risk | Medium. The value is authentic official identity, not synthesized or rotated, but it is copied into an ignored task fixture so the isolated AppServer can perform its normal read path. No credential or token is copied. |
| Confidence | Medium-high. This is a concrete difference between the isolated test and the documented production reuse path, and the campaign copy explicitly describes calls made in ZCode. |

Current status: `FAIL`.

Real H3 evidence:

- Run: `.run/v4-h2-device-billing-20261117T2300`
- Device mode: `OFFICIAL_DEVICE_MID_REUSED`
- Device fingerprint: matched the unchanged official telemetry state
- Main request: `msg_2026111723011188684834b2524bc0`
- Main runtime usage: input `13,441`, output `37`, total `13,478`
- Clean official `23:00` bucket: cached `0`, uncached `13,743`, output `55`,
  total `13,798`, credits `1.6024`
- Expected normal at `0.5`: `1.602445`
- Effective extra ratio: `0.9999719179`

The only additional model request emitted by the task was the automatic
`session_title` request. It was cancelled during AppServer shutdown and its
request-level usage is `USAGE_MISSING`. Its timeline and the official residual
of `302` input plus `18` output tokens are compatible with that request, but
the official hour bucket remains an aggregate. Even if both emitted requests
are treated as one task-level bill, the official credits are exactly the
non-discounted `0.5` calculation. Reusing the authentic official Device MID
therefore does not restore `0.67`.

### H4: Gateway and Endpoint Context

| Field | Evidence |
|---|---|
| Description | Native Model I/O exposes the logical `open.bigmodel.cn/api/anthropic` configuration, while official source maps exact BigModel Anthropic `/v1/messages` traffic to the Ultra Gateway. This is an expected official routing step, not a Bridge-specific deviation. |
| Source file | Installed AppServer `GATEWAY_PATH_BY_ENDPOINT` map and official source research. |
| Source location | Installed `app-server/zcode.cjs`, gateway map. |
| Native behavior | Official runtime may show the literal provider endpoint before gateway resolution. |
| Bridge behavior | Observed final Anthropic message path is the official Ultra Gateway path. |
| Expected wire delta | None attributable to Bridge when the official mapping is active. |
| Expected billing effect | Unknown. Endpoint identity may affect routing and could indirectly affect entitlement, but no direct evidence yet. |
| Test method | Use an official gateway resolver or official provider configuration path only. Do not rewrite headers or fabricate an endpoint-supporting identity. |
| Risk | Low after source mapping was located. |
| Confidence | Low. This hypothesis is downgraded; Ultra Gateway routing is expected official behavior. |

### H5: Messages and Tools Request Structure

| Field | Evidence |
|---|---|
| Description | Native main-turn evidence had 3 system blocks, 58 tools, and `max_tokens=128000`; Bridge clean B main-turn evidence had 3 system blocks, 21 tools, and `max_tokens=128000`. |
| Source file | Request construction occurs across client/runtime configuration rather than one isolated discount rule. |
| Source location | `UNVERIFIED` |
| Native behavior | Larger available tool catalog. |
| Bridge behavior | Smaller tool catalog. |
| Expected wire delta | Different `tools` array and serialized request size. |
| Expected billing effect | Token quantity can change, but there is no evidence this changes the per-credit multiplier. |
| Test method | Only after H1-H4 are exhausted. Add official tools without changing the marker task, and record all resulting shape deltas as a multi-variable experiment if more than one field changes. |
| Risk | High. It is confounded with context size, token counts, and prompt assembly, and cannot independently prove a discount rule. |
| Confidence | Low. |

## Experiment Rules

1. Sixteen minutes are required after using a billing hour to avoid overlapping the next V4 variant.
2. A fresh before snapshot must be less than ten minutes old and the target hour bucket must have no other `GLM-5.3-Flash` activity.
3. Each variant gets at most one real task. Any automatic retry is part of that task budget.
4. H1 is considered exercised only if its persisted location metrics record a load and cache hit.
5. About `0.67` is `PASS`; about `1.0` is `FAIL`; a mixed or contaminated hour is `INCONCLUSIVE`.
6. A first successful variant must be reproduced once in a new clean hour before `DISCOUNT_TRIGGER_REPRODUCED: PASS`.
7. No production Bridge authentication, routing, Worker, Manager, SQLite Authority, Magpie, Host Wake, Start Plan, Desktop installation, login state, or credential contents are changed.
