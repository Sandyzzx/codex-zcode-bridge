# ADR-042: Unknown Runtime Safety and Fingerprint-Bound Experimental Probes

> Status: DECISION
> Date: 2026-11-20
> Decision: Accepted by the `ZCODE_3_19_0_ADAPTATION_WITH_3_18_COMPATIBILITY` Owner goal and its UNKNOWN-version compatibility policy.
> Applicability: ACTIVE CANDIDATE on `codex/zcode-3190-compat-20261120`.
> Verified against: implementation `15abe6becb13f383fee676a4ae20510d51f817fc`
> (tree `654cda65168ece915251305522db6ce603e23ad7`), baseline
> `aedeb2c2a1ea6f41ea3ac2d045f7ed0d75281552`

## Context

ADR-040 uses an exact compatibility manifest as both an installation-safety
check and a Provider-capability verdict. This fails closed safely, but an
official ZCode Desktop update cannot be inspected or exercised until Bridge
ships another manifest entry.

The Owner requires the opposite sequence for unknown but apparently official
installations:

1. verify the complete installation identity and basic safety;
2. require an explicit local authorization bound to that exact fingerprint;
3. permit bounded experimental OAuth, Provider and model probes;
4. keep every Provider capability unverified until its own evidence exists;
5. never let an experimental result promote itself into the verified manifest.

Clearly unsafe installations must remain hard-blocked.

## Decision

### 1. Installation safety is separate from manifest compatibility

The installed-runtime resolver reports three independent facts:

- whether the installation passed basic safety checks;
- the exact installation fingerprint;
- the runtime verification stage (`VERIFIED`, `EXPERIMENTAL`, or `UNVERIFIED`).

Basic safety includes, at minimum:

- Windows x64 and the supported Node range;
- an absolute, canonical installation root;
- same-root regular files with no symlink escape;
- valid Desktop and runtime-host Authenticode signatures from the official
  Zhipu publisher identity;
- x64 PE architecture for both executables;
- consistent Desktop executable, ASAR package/build metadata and AppServer
  identities;
- exact hashes for the AppServer bundle, builtin Provider config, runtime-host,
  Desktop executable and ASAR archive.

An unsafe installation remains `OFFICIAL_RUNTIME_UNVERIFIED` even when an
authorization file mentions its path or version.

### 2. Unknown versions require fingerprint-bound authorization

A safe installation outside the verified manifest is not runnable by default.
The resolver returns `OFFICIAL_RUNTIME_UNVERIFIED` with
`EXPERIMENTAL_AUTHORIZATION_REQUIRED` and still exposes the computed
fingerprint for review.

The Owner can grant a local authorization for that exact fingerprint. The
authorization is persisted in a dedicated JSON file selected by trusted runtime
configuration or an explicit test/Cost Lab option. Matching requires all
fingerprinted bytes and identity metadata to remain unchanged. Changing any
AppServer, builtin Provider config, runtime-host, Desktop executable, ASAR,
signer thumbprint or Node version invalidates the authorization.

With a matching authorization, the resolver returns
`OFFICIAL_RUNTIME_EXPERIMENTAL`. This status means only "safe identity accepted
for an explicit probe"; it never means discount-verified or Provider-compatible.

### 3. Provider capabilities remain independent

Experimental authorization scopes are:

- `coding_plan_probe`
- `start_plan_probe`
- `other_provider_probe`

An authorized experimental runtime may pass the corresponding execution gate
to obtain evidence. The descriptor still reports:

- `OFFICIAL_DISCOUNT_NOT_VERIFIED` for Coding Plan;
- `OFFLINE_RESEARCH_PENDING` for Start Plan;
- no verified production-compatibility claim for other Providers.

Successful protocol, OAuth or model execution does not change those values.
Only fresh Provider-specific evidence and a reviewed manifest update can
promote a capability.

### 4. No automatic promotion

Experimental authorizations are read-only inputs to runtime selection. Running
an experiment must not rewrite the verified manifest, modify the installed
Desktop, or elevate the fingerprint to `VERIFIED`.

The verification manifest may contain a known 3.19 identity as an experimental
candidate, but its Provider fields remain unverified until the corresponding
real evidence is reconciled.

The existing verified 3.18.2 entry predates full Desktop executable/archive
pinning. It remains a `LEGACY_SAFETY_ONLY` asset-pinning case: the AppServer,
builtin config, runtime-host, Node range and signatures are exact, while the
Desktop executable and ASAR are still required to pass signed x64 official
installation checks. New manifest candidates must use `FULL` pinning.

### 5. Existing lifecycle and security boundaries remain unchanged

This decision does not change SQLite Task Authority, Worker lifecycle, Claim,
Recovery, Result, Cleanup, Release, Credential Lease, OAuth ownership, device
binding, request signing or public MCP schemas.

An experimental installation still has to pass the same process-identity,
Provider-authentication, secret-redaction, timeout and recorded-tree cleanup
gates as a verified installation.

## Consequences

- New official Desktop releases can be investigated without shipping a new
  Bridge release first.
- A normal unconfigured installation still fails closed on an unknown version.
- Authorization cannot silently carry over to changed assets.
- Provider claims remain evidence-scoped instead of inheriting from a version
  number or a successful model response.

## Required verification

- exact verified 3.18.2 behavior remains unchanged;
- safe known 3.19 identity can enter experimental mode only after
  fingerprint authorization;
- unknown safe identity, missing authorization, malformed authorization,
  fingerprint drift, unsafe signer, wrong PE architecture, mixed roots and
  unsupported Node all fail closed;
- each Provider capability remains independently gated;
- no experimental result rewrites the manifest;
- protocol smoke and real Coding Plan / Start Plan evidence are recorded
  separately from production verification status.
