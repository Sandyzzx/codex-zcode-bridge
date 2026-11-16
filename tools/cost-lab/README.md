# Official Assembly Probe

This directory contains the isolated, offline-only evidence tool for
`CODING_PLAN_OFFICIAL_ASSEMBLY_AB_PROBE`.

Run from the repository root:

```powershell
node tools/cost-lab/official-assembly-probe.mjs
```

The command verifies the pinned official ZCode 3.18.2 source checkout, records the
native/Bridge assembly boundaries that reach the official request-auth service, and writes
sanitized evidence under:

```text
.run/coding-plan-assembly-ab-20261116/offline-evidence.json
```

The synthetic comparison reports `final_request_auth_surface_delta` and `transport_delta`
separately. A transport difference therefore does not turn an otherwise identical fixture
auth surface into a request-auth delta; the fixture result still never establishes live
Project identity parity.

It performs no model request and no network request. The CLI has no live mode because the
current baseline cannot prove read-only Settings initialization, non-mutating Project Token
location persistence, fresh official billing snapshot access, or an exclusive billing window.
Those gates must be resolved before a real B request is authorized.
