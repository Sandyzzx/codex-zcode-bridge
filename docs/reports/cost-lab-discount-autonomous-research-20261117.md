# Cost Lab Official Execution Path and Discount Research

> Status: RESEARCH
> Last updated: 2026-11-18
> Baseline: `06ef9e0cb3371cffd9181fb6b4a993a71d1c5eb0`
> Scope: Coding Plan `GLM-5.3-Flash`, account
> `account:bigmodel-individual-coding-plan`, V5 official execution-path reuse.

## Result

The installed official ZCode AppServer bundle restores the current `0.67`
Coding Plan multiplier when Bridge's experimental AppServer harness uses that
bundle and the existing official auth service. The result was reproduced and
then minimized by removing the previously tested Project Location Cache and
official Device MID reuse.

The minimal successful `0.67` configuration is:

- installed official bundle:
  `C:\Users\Sandy\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs`
- file identity: size `15,675,386`, SHA-256
  `08726b5ef69e1e9072828baa4656713cb3aac93bb096938681278c5600312b2c`
- installed ZCode `3.18.2.10443`
- system Node `v24.16.0`
- official AppServer command:
  `node zcode.cjs app-server --stdio --surface desktop`
- official runtime-host, installed provider config, and the existing official
  auth service
- isolated data root, in-memory Project Location handling, and a generated
  fixture Device MID

No Project Location Cache or official Device MID reuse is required.

## Native Control

Run: `.run/native-v5/native-v5-20261117-02`

The Native Desktop task completed with response `COSTLAB_NATIVE_V5_OK`.
It emitted three model HTTP attempts:

- main turn
- `session_title`
- `project_memory_extract`

The `project_memory_extract` request usage was not exposed. The official
`23:00` Asia/Shanghai bucket remained the authoritative attribution source.

| Field | Value |
|---|---:|
| Official token delta | 59,485 |
| Cached input | 320 |
| Uncached input | 59,115 |
| Output | 50 |
| Actual credits | 4.5743 |
| Expected normal at off-peak `0.5` | 6.827185 |
| Effective extra ratio | 0.6700126040 |
| Discount | PASS |

This confirms that the current account and model still receive the campaign
multiplier in Native ZCode.

## Official Execution Paths

### Installed executable as Node

The installed `ZCode.exe` was tried with `ELECTRON_RUN_AS_NODE=1`. Provider
configuration succeeded, but `session/create` timed out and no model request
was made. This path is not required and was not retried.

Evidence:
`.run/v5-installed-appserver-smoke-20261117/live-probe/smoke-evidence.json`

### Installed AppServer bundle under Node

The unchanged installed `resources/glm/zcode.cjs` successfully completed the
zero-model protocol smoke:

- `provider/updateAccountConfig`
- `session/create`
- Provider `account:bigmodel-individual-coding-plan`
- Model `GLM-5.3-Flash`
- reasoning `low`
- AppServer start, exit, cleanup, shared-state, and Host Wake gates all passed

Evidence:
`.run/v5-installed-bundle-node-billing-20261118/live-probe/smoke-evidence.json`

### Full official AppServer assembly

The successful path did not substitute only a model adapter. The unchanged
installed bundle executed its full AppServer protocol stack:

- `runZCodeProtocolAgent`
- process-level `startProcessProviderRegistryRuntime`
- `createZCodeApp`
- isolated session store and plugin preparation
- runtime preferences and Provider Registry account configuration
- the installed model request-security edition

The billing evidence records the complete RPC sequence:

- `provider/updateAccountConfig`: PASS
- `session/create`: PASS
- `session/requestRuntimePreferences`: PASS
- `session/subscribe`: PASS
- `session/send`: PASS
- `interaction/requestProviderRuntimeHeaders`: two PASS calls
- `interaction/requestOfficialMcpAuthHeaders`: non-secret unavailability response

The harness still supplied the account request headers through the existing
official auth service. In the minimal run, the official credential store was
read-only, Project Location state was in-memory, and the Device MID was
fixture-generated. The shared keyring lock was observed and released normally.

This verifies a full official AppServer assembly, not merely an Account Resolver
or model-client substitution.

The separate Desktop Shell `createLocalServices` graph was not started. It is
not present as a direct entry point in the installed AppServer bundle, and the
installed `ZCode.exe` run-as-Node attempt failed before a model request. The
successful supported boundary used by this research is therefore the installed
AppServer process, not the Desktop Shell host graph.

## Real Billing Experiments

All experiments used `GLM-5.3-Flash`, personal Coding Plan, reasoning `low`,
an exact response marker, and off-peak billing at `0.5`.

| Run | Project context | Device context | Official tokens | Actual credits | Expected normal | Effective extra ratio |
|---|---|---|---:|---:|---:|---:|
| `v5-installed-bundle-node-billing-20261118` | official read-only | official reused | 22,650 | 1.7574 | 2.622990 | 0.6699987419 |
| `v5-installed-bundle-node-repro-20261118` | official read-only | official reused | 22,657 | 1.7469 | 2.607376 | 0.6699839225 |
| `v5-installed-bundle-node-isolated-context-20261118` | in-memory | fixture generated | 22,658 | 1.7397 | 2.596508 | 0.6700152667 |

Every differential window:

- had no other model activity in the same hour
- bracketed the experiment with fresh before/after snapshots
- matched official cached, uncached, output, and total token categories
- retained local API-key, organization, and project identity parity
- passed cleanup, shared persistent-state, and Host Wake checks

The third run is the minimal successful variant and removes both identity
components that had failed independently in V4.

## Signing Evidence

The installed bundle's captured request sequence was:

1. `GET https://zcode.z.ai/api/v1/agent/configs`
2. `POST https://open.bigmodel.cn/api/paas/c1f3a7e2/v2/client`
3. `POST https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages`

The second request is the official client-signing handshake registered by the
installed bundle as `get_sign_key`. It returned HTTP `200`. Its body structure
contained only the signing fields `accessToken`, `nonce`, `sig`, and `ts`; no
secret value is retained in this report.

Installed bundle:

- `createModelRequestSecurityState` creates `OfficialRequestSecurity`
- Coding Plan providers are classified as requiring client request signing
- the transport is replaced with the official signing fetch

Vendored bundle:

- `createModelRequestSecurityState` returns
  `protectTransport: ({ transport }) => transport`
- no signing handshake exists
- prior controls using this bundle billed at approximately `1.0`

The exact causal necessity of signing was not proven with a negative control
that disables only signing inside the installed bundle. That would require
altering or bypassing the installed request-security implementation and was
not attempted. Root cause confidence is therefore `SUPPORTED`, not absolute.

## Minimal Integration Candidate

The smallest viable production integration candidate is to reuse the installed
official AppServer bundle as the model-execution entry:

1. Resolve the installed ZCode AppServer and verify its pinned version/hash.
2. Launch the unchanged official `zcode.cjs` with the official runtime-host and
   installed provider configuration.
3. Keep Bridge's existing official auth service and provider runtime-header
   callback.
4. Preserve the isolated project/device-context behavior used by the successful
   minimal variant.
5. Do not copy, reimplement, or synthesize client-signing logic.
6. Fall back explicitly when a compatible installed bundle is unavailable; do
   not claim discount parity for the vendored open bundle.

Production integration was intentionally not implemented in this research
branch.

## Real Request Totals

| Item | Total |
|---|---:|
| Real tasks | 4 |
| Model HTTP attempts | 9 |
| Main-turn requests | 4 |
| Auxiliary requests | 5 |
| Official tokens | 127,450 |
| Official credits | 9.8183 |

The totals include the Native control and all three Bridge billing experiments.
Unavailable auxiliary usage remains classified as missing; official bucket
deltas, not synthetic zero usage, are used for billing totals.

## Excluded or Deferred Work

- No Start Plan request was made.
- No DSH work was performed.
- No production Bridge authentication, routing, Worker, Manager, SQLite
  Authority, Magpie, Host Wake, or Start Plan code was changed.
- No official installation file was modified.
- No credential was copied, exported, replayed, or persisted by this work.
- No MITM or certificate substitution was used.
- Full CI, full regression, stress tests, and release gates are deferred.

## Remaining Uncertainty

- The installed bundle differs from the vendored bundle in more than one module.
  The direct signing handshake is strong associated evidence, but signing alone
  is not isolated as the only necessary difference.
- The failed `session_title` auxiliary request does not expose usage in the
  probe. Its charge is included in the official bucket delta and remains
  request-resolution `UNKNOWN`.
- Long-term validity depends on the installed ZCode version, campaign rules,
  and protocol compatibility.

## Next Action

Review the minimal integration candidate and separately authorize a production
Bridge runtime-resolver change. That change should prefer a verified installed
official AppServer bundle while preserving an explicit no-discount fallback.
