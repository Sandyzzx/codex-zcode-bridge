# Async Executor Real Host Acceptance

> Status: RESEARCH
> Date: 2026-11-22 (Asia/Shanghai)
> Baseline: PR #131 RC `a1bc911ec1b03cd22bbf13e717fc2233284e6183`
> Acceptance implementation: `7f54531acba0844937bc134609dae840090294ec`
> Conclusion: `PARTIAL / BLOCKED`
> Paid model requests during this acceptance: `0`

## Verdict

The shipped MCP Host can now be terminated after a Task is accepted without
cancelling the original Attempt. A cross-process synthetic Worker committed one
Result, Cleanup was verified, the Operation was released, the Worker spawned
exactly once, and a new Host read the same Result.

Wake configuration and user discovery also have a supported path:

- `task wake-authorize` binds an Owner-confirmed one-Turn policy to the current
  SQLite Task/Attempt and workspace;
- the CLI still derives Thread model/provider/effort and workspace from the
  explicit policy, but Queue remains blocked unless the live Thread matches all
  fields;
- CLI and Web task lists expose the latest durable `executor_wake` fact without
  adding a database or notification service.

This is not enough to promote Preview. The real Codex Desktop fully-exited
case, strict `notLoaded`, real Queue/Turn/Master behavior, Official Runtime
execution, and live model adherence to Async Master remain unproven.

## Environment

| Item | Value |
|---|---|
| Platform | Windows x64 |
| Node.js | `24.16.0` |
| Codex Desktop | `26.1117.4957.0` |
| Codex CLI | `0.171.0-alpha.13` |
| Installed ZCode | `3.19.0.10774` |
| Supported ZCode baseline | `3.18.2.10443` |
| App Server control socket | absent at `C:\Users\Sandy\.codex\app-server-control\app-server-control.sock`; `codex app-server daemon version` failed with `os error 10050` |
| Current Desktop process | app-server over stdio, PID `20020`; not the Queue/App Server control socket |
| Current exec-server | PID `12760`; not the Queue/App Server control endpoint |

The installed ZCode `3.19.0.10774` is outside the release support matrix and
would additionally require an ADR-042 exact-fingerprint authorization for a
real Runtime experiment. No such paid execution was requested or performed.

## Safe Probes

Only version/help, process discovery, socket existence, and Runtime installation
inspection were run. None starts a model Turn.

```powershell
codex --version
codex queue --help
codex app-server --help
codex app-server proxy --help
codex app-server daemon --help
codex app-server daemon version
Test-Path C:\Users\Sandy\.codex\app-server-control\app-server-control.sock
node tools/compatibility/authorize-official-runtime.mjs inspect
```

Observed facts:

- `codex queue` accepts `--thread`, `--message`, and optional `--resume`.
- Its help says `--resume` only tries to resume after queueing and a failed
  resume still exits successfully with a warning.
- Its `-c` help explicitly says queued messages use the Thread's model. This
  confirms why Queue must not be used until the live Thread model/provider/effort
  exactly matches the Owner policy.
- `codex app-server proxy` is the supported read-only control path and requires
  `--sock`.
- The configured control socket is absent and daemon version probing fails.
- The current owner Desktop is a stdio app-server and cannot be treated as the
  missing control endpoint.

Evidence files are `codex-queue-help-final.txt`,
`codex-app-server-help-final.txt`, `codex-app-server-proxy-help-final.txt`,
`codex-app-server-daemon-help-final.txt`, `app-server-daemon-version-final.txt`,
and `environment-final.json`.

## Implemented Acceptance Surface

Commit `7f54531acba0844937bc134609dae840090294ec` adds:

1. `zcode-bridge task wake-authorize <task_id>` with explicit current Attempt,
   Thread, model, provider, safe reasoning effort, expiry, and
   `--confirm-owner`.
2. Exclusive creation of `<authority-root>/wake-policy.json`; an existing policy
   is never silently overwritten.
3. A read-only `wake` summary on the existing task-list projection. The fact is
   derived from the latest SQLite `executor_wake` event, not a new store.
4. Web Console Wake count, banner, and row badge, plus the same summary in Task
   CLI list output.
5. A shipped-MCP-Host process-exit E2E using a synthetic Worker.

The public MCP tool names and schemas are unchanged. SQLite remains v14-only.

## Acceptance Matrix

| Item | Status | Evidence |
|---|---|---|
| Owner-to-Task/Thread Wake policy path | `PASS` | `task-cli-targeted-final.log`: exact Attempt lookup, `one_turn`, expiry, max 24 h, safe effort, owner confirmation, no overwrite |
| Model/provider/effort fail-closed preflight | `PASS — SYNTHETIC` | `executor-wake-targeted-final.log`: loaded/idle and exact model/provider/effort required; mismatch does not call Queue |
| Web Notify durable discoverability | `PASS` | `web-console-targeted-final.log`; Web API/HTML exposes wake count/banner/badge, Task CLI exposes `wake` |
| App Server unavailable degradation in current Host | `PASS` | `appserver-unavailable-probe.log`: `web_notify / app_server_unavailable`, zero Queue submissions |
| Shipped MCP Host process exit after Task acceptance | `PASS — SYNTHETIC WORKER` | `executor-process-targeted-final.log`: one accepted Attempt survived Host termination |
| Original Attempt Result durability | `PASS — SYNTHETIC WORKER` | one `result_committed`; same Task/Attempt read after Host reconnect |
| Cleanup and Operation Release | `PASS — SYNTHETIC WORKER` | one `cleanup_verified` and one `released` event |
| Duplicate Spawn/Result overwrite | `PASS — NEGATIVE` | Worker spawn log contained exactly one `spawn`; one Result commit |
| Strict Wake C: `notLoaded` | `BLOCKED` | no isolated real control socket/Thread; not inferred from local preflight test |
| Strict Wake D: Desktop fully exited | `BLOCKED` | Owner Desktop was not closed; current app-server is stdio |
| Real realtime Desktop visibility | `BLOCKED` | no UI acknowledgement evidence |
| Queue ACK vs Turn Started vs Master response | `BLOCKED` | no isolated paid Thread authorization; not run |
| Official Runtime execution | `NOT_RUN` | requires separate exact-version and paid-model authorization |
| Async Master real task behavior | `BLOCKED` | static Skill contract tests passed; live model behavior not run |

## Wake State Separation

| Fact | Current result | Evidence boundary |
|---|---|---|
| `LOADED` | `PASS — SYNTHETIC`; real `BLOCKED` | fake App Server preflight requires Thread in loaded list and exact idle/direct-input state; real control socket is absent |
| `QUEUED` | `PASS — SYNTHETIC`; real `NOT_RUN` | fake Queue runner returns exit 0 and one intent/queued fact is recorded; no real `codex queue` was issued |
| `TURN_STARTED` | `PASS — SYNTHETIC`; real `NOT_RUN` | fake App Server exposes a baseline-new `inProgress` Turn; no real Master Turn was created |
| `DESKTOP_VISIBLE` | `UNKNOWN` | no Desktop UI acknowledgement channel exists in the Adapter |
| Web Notify | `PASS` | current missing socket produces `web_notify / app_server_unavailable` with zero Queue calls; CLI/Web expose the durable fact |
| Master response | `BLOCKED` | requires an isolated low-cost/paid model authorization; no such request was made |

Queue exit 0 is therefore only `QUEUED`. It is not `TURN_STARTED`, a Master
response, task acceptance, or `DESKTOP_VISIBLE`.

## Official Runtime Preparation

The zero-model installation inspection succeeds:

```text
status:                 OFFICIAL_RUNTIME_UNVERIFIED
installation_safety:    OFFICIAL_INSTALLATION_SAFE
desktop_version:        3.19.0.10774
node_compatible:        true
fingerprint:            3e25056614f91d3651c237fbc89a076a1f9e834d351257423854844fb5b28290
authorization:          required
discount_capability:    OFFICIAL_DISCOUNT_NOT_VERIFIED
```

The minimal real experiment is prepared but not authorized or run:

1. Obtain a fresh Owner approval for the exact fingerprint and the intended
   Provider scope; do not reuse the inspection as execution authorization.
2. Create a project-local ADR-042 authorization with
   `node tools/compatibility/authorize-official-runtime.mjs grant` only after
   that approval.
3. Start the isolated Executor with
   `ZCODE_BRIDGE_EXPERIMENTAL_RUNTIME_AUTHORIZATION_FILE` pointing to that file.
4. Submit one minimal real Task using the existing public MCP → Executor →
   Adapter → Official Runtime path.
5. Record model/usage availability, original Attempt `result_committed`,
   `cleanup_verified`, `released`, process-tree evidence, and any billing
   uncertainty separately.

No Official Runtime authorization file, Session, Turn, or paid Runtime request
was created for this experiment. The isolated Wake probe's local
`wake-policy.json` is not an ADR-042 Runtime authorization. The inspection
result is not a production-compatibility or discount verdict.

## Host-Exit E2E Boundary

The new test starts the shipped
`plugins/codex-zcode-bridge/dist/bridge.mjs` as a real Node MCP Host process. It
submits through public MCP to an isolated Executor, waits for `launch_intent`,
then terminates the Host before releasing a synthetic Worker gate.

Only test-owned processes and temporary directories are used. The test proves:

- the Host exit was observed;
- the Executor remained `active`;
- the original Task/Attempt still produced exactly one Result;
- Cleanup and Release facts were each persisted once;
- the Worker process was spawned once and was separately observed to exit;
- a new shipped MCP Host reconnected and read the same Result.

This evidence must be described as **real MCP Host process exit + synthetic
Worker**, not as a real Codex Desktop close or real Official Runtime test.

## Verification

| Gate | Result |
|---|---|
| `npm run typecheck` | `PASS` |
| `npm run build:test` | `PASS` |
| `npm run build` | `PASS` |
| `npm run validate:plugin` | `PASS` |
| `npm run check:generated` after implementation commit | `PASS`, 13 files fresh |
| Task CLI targeted | `PASS`, 9/9 |
| Web Console targeted | `PASS`, 3/3 |
| Wake coordinator targeted | `PASS`, 8/8 |
| Thin MCP / shipped Host exit / cross-process fake lifecycle | `PASS`, 3/3 |
| Skill policy targeted | `PASS — CONTRACT`, 10/10 |
| App Server unavailable probe | `PASS`, `web_notify / app_server_unavailable`, zero Queue calls |
| Official Runtime zero-model inspect | `PASS`, exact 3.19 fingerprint / safety verified / authorization required |
| Paid model requests | `0` |
| Complete local matrix | `ABORTED — NOT A PASS`; the docs-only impact command expanded to the full suite because the branch delta includes implementation commits, so it was interrupted per the Owner policy |

Raw local evidence is under
`C:\Users\Sandy\.codex\worktrees\async-executor-pr5-20261122\codex-zcode-bridge\.run\async-executor-real-acceptance-20261122`.
It is intentionally not committed.

Historical exact-head GitHub checks for
`a1bc911ec1b03cd22bbf13e717fc2233284e6183` passed in run `45017172570`
(including Windows/Ubuntu verification and the SQLite resource matrix), but that
result is invalidated for `7f54531a`. A new exact-head CI run is required after
the report/docs head is pushed.

## Preview Recommendation

Do not merge PR #131 into `preview` and do not publish a Preview/Stable release.

The candidate is stronger than the original RC because Host process loss no
longer depends only on graceful stdin disconnect, and Wake authorization/Web
discovery now have tested control surfaces. The independent real Host gates
remain unmet, so the Preview recommendation is:

`PARTIAL / BLOCKED — keep PR #131 open; no Preview promotion.`

## Minimum Follow-Up

1. In an isolated Codex Desktop environment, run strict `notLoaded` C and fully
   exited D with zero-model probes first.
2. With explicit Owner budget authorization, run one low-cost Queue wake and
   record `QUEUED`, `TURN_STARTED`, Master response, and Desktop visibility as
   separate facts.
3. With separate Official Runtime authorization, run one minimal real Task
   through the existing four-layer path and verify the same original
   Result/Cleanup/Release facts.
4. Use one real Async Handoff task to verify that the Master ends its Turn only
   after reliable acceptance and independently validates the Wake later.

