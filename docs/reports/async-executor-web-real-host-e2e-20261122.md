# Async Executor Web Deep Link and Real Host E2E

> Status: RESEARCH
> Date: 2026-11-22 (Asia/Shanghai)
> Latest integrated Preview: `origin/preview@c941f578ec00834ab0e93f235134d24bf14a827a`
> C1 evidence candidate: `02a9e81198cffc5b90077eaba00b5abbfd40f640`
> Pull request: [#131](https://github.com/Sandyzzx/codex-zcode-bridge/pull/131), open
> Conclusion: `PARTIAL / BLOCKED`
> Paid model requests during this acceptance: `0`

## Verdict

Phase A is implemented and the merged candidate passes the affected local
targeted set. The Web Console now has an Authority-Root discovery record, an
actual dynamic loopback URL, Task Deep Links, and independent Status / Events /
Result / Attention reads. The shipped `task console-url` command either returns
a URL verified against the live Executor lease and Console session or fails
closed.

C1 also passes with a stronger boundary than the earlier unit-only evidence:

- the shipped MCP Host, Executor, Web Console, synthetic Worker, and browser
  each ran as a real OS process;
- Chromium opened the real Deep Link while the task was queued/running and
  later observed the completed Result;
- terminating the MCP Host did not terminate the Executor or Web Console;
- the original Attempt committed one Result, passed Cleanup once, and the
  Operation released once;
- a new MCP Host read the same Task / Attempt / Result;
- the synthetic Worker was spawned exactly once.

This is `PASS — REAL PROCESS / SYNTHETIC WORKER`. It is not a real-model,
Official Runtime, Queue Wake, or real Codex Desktop fully-exited result.

The overall result remains `PARTIAL / BLOCKED` because strict Wake C/D, a real
Queue ACK / Turn / Master response, the real Official Runtime model path, and
the real Async Master behavior were not authorized in this run.

## Environment

| Item | Observed value |
|---|---|
| Platform | Windows x64 |
| Codex Desktop | `26.1117.4957.0` |
| Codex CLI | `0.171.0-alpha.13` |
| Node.js | `24.16.0` |
| Installed ZCode | `3.19.0.10774` |
| ZCode release baseline | `3.18.2.10443` |
| App Server control socket | absent; configured socket probe failed with OS error `10050` |
| Owner Desktop processes | app-server PID `20020`, exec-server PID `12760`; both left running |
| Executor development policy | local affected verification; full Release Gate deferred |

Current `codex queue --help` exposes `--thread`, `--message`, and optional
`--resume`. The help still says a failed `--resume` produces a warning while
the command succeeds, and queued messages use the Thread's current model.
Therefore Queue acceptance cannot be treated as Turn start, Master response,
or a model/budget guarantee.

## Phase A Implementation

The code candidate adds:

1. `task-console.json` under the Authority Root as lifecycle discovery
   metadata only. It records Console PID/start fingerprint, Authority digest,
   exact loopback URL/port, Console ID, and a record digest.
2. Exclusive `wx` creation, live-owner reuse, and `console_id + record_digest`
   CAS deletion. Unknown, stale, mismatched, or unverifiable records fail
   closed rather than starting a second Console authority.
3. `/api/session` plus a second-process reuse path that validates the same
   Executor lease before returning the existing URL.
4. `task console-url <task_id>`, which validates the Task and Executor lease,
   verifies `/api/session`, and returns the real URL. It never guesses a port.
5. `?task_id=<task-id>` selection, URL synchronization on manual selection,
   refresh/back/forward persistence, and `/summary` lookup across bounded Task
   pages.
6. Independent Status, Events, Result, and Attention reads. An unfinished
   Result is shown as pending and does not hide valid Status or Events.
7. Async Handoff instructions that report the Task ID and verified URL after
   reliable acceptance, end the Master Turn, and wait for Wake before
   independent acceptance.

No public MCP tool name/schema, SQLite v14 fact, Worker path, Result contract,
Cleanup proof, Release CAS, or Token Efficiency candidate was changed.

## C1 Real Process E2E

The isolated test used a disposable Authority Root, workspace, HOME, settings
directory, and worker entry under `.run`. It did not use the Owner Desktop
Authority or credentials and made no model request.

| Fact | Result |
|---|---|
| Executor process | PASS, PID `7512`, lease `d54ee862-5417-4ac3-b195-d5a867caa5b3` |
| Web Console process | PASS, PID `17600`, dynamic port `56904` |
| Shipped MCP Host | PASS, real process PID `20256` |
| Synthetic Worker | PASS, real process PID `22864` |
| Task | `web-e2e-1795359276802` |
| Initial Task state | `QUEUED`; Attempt `1` |
| Verified Deep Link | `http://127.0.0.1:56904/?task_id=web-e2e-1795359276802` |
| Browser | headless Chromium; real HTTP page and DOM assertions |
| Running page | Status/Events visible; Result displayed pending |
| Completed page | `COMPLETED`; Wake `web_notify`; Hold `not observed`; Result visible |
| MCP Host exit | observed `SIGTERM` |
| Executor after Host exit | `ACTIVE`, same lease |
| Web Console after Host exit | same process alive and browser still `ACTIVE` |
| Final Task state | `completed`, Attempt `1` |
| Original Result digest | `0d42aa7523692fdd59bec1bc8bcebddf53d5a15c0a5a5c5a17852a8ba2cc5a00` |
| `result_committed` | exactly `1` |
| `cleanup_verified` | exactly `1` |
| `released` | exactly `1` |
| Worker spawn log | exactly one `spawn` |
| Operation after reconnect | `released`, Capacity released |
| New MCP Host | read the same Task / Attempt `1` / completed Result |

The URL above was live during the test and was verified by
`task console-url`, `/api/session`, the browser navigation, and the rendered
page. The test-owned Console and Executor were then shut down. A post-test
check found none of the four test PIDs and no listener on port `56904`.
Screenshots preserve the running and completed views:

- `.run/async-executor-web-e2e-20261122/web-running.png`
- `.run/async-executor-web-e2e-20261122/web-completed.png`
- `.run/async-executor-web-e2e-20261122/evidence.json`
- `.run/async-executor-web-e2e-20261122/targeted-current-02a9e811.log`
- `.run/async-executor-web-e2e-20261122/c1-merged-c941-final.log`

The pre-merge evidence remains preserved separately as
`evidence-premerge-8f83bd34.json` and the `*-premerge-8f83bd34.png` files. The
first merged rerun was also preserved as `evidence-merged-c941-initial.json`
because its screenshot raced one Console polling cycle before Wake became
visible; the final rerun waits for the rendered `completed + web_notify +
released` state and is the C1 evidence above.

The Wake fact produced after Release was `web_notify` with reason
`policy_missing`, `thread_id=null`. It is durable SQLite v14 evidence and the
Web list/banner/badge made it discoverable. This run did not submit Queue.

## Lifecycle State Separation

| State | This run | Boundary |
|---|---|---|
| `QUEUED` | `PASS — SYNTHETIC WORKER` | Executor Task initially reported queued; this is not a Codex Queue acknowledgement |
| `LOADED` | `NOT_RUN` | no isolated real Codex Thread/control socket was selected |
| `TURN_STARTED` | `NOT_RUN` | no real `codex queue` call was made |
| `DESKTOP_VISIBLE` | `UNKNOWN` | no Desktop UI acknowledgement mechanism exists here |
| Web Console visible | `PASS — REAL BROWSER / SYNTHETIC WORKER` | real HTTP page showed queued/running and completed states |
| `UNKNOWN` submission | `NOT_RUN` | Queue was not attempted, so no acknowledgement uncertainty was manufactured |

Queue exit `0`, a Queue ACK, and a visible Web page are therefore separate
facts. None alone is a Master Turn completion.

## Official Runtime Preflight

The zero-model installation inspection passed against the installed
`3.19.0.10774`:

```text
status:                  OFFICIAL_RUNTIME_UNVERIFIED
installation_safety:     OFFICIAL_INSTALLATION_SAFE
installation_fingerprint:3e25056614f91d3651c237fbc89a076a1f9e834d351257423854844fb5b28290
desktop_version:         3.19.0.10774
node_compatible:         true
authorization:           required
discount_capability:     OFFICIAL_DISCOUNT_NOT_VERIFIED
```

This proves only installation identity and safety inspection. Because 3.19 is
outside the release support matrix and no new exact-fingerprint experimental
authorization was granted in this task, a new protocol smoke, Session, Turn,
Provider request, billing reconciliation, and real Result path are
`BLOCKED_BY_AUTHORIZATION`. The historical 3.19 zero-model and paid probes are
not rewritten as evidence for this candidate.

A read-only `runBridgeDoctor()` pass also reported:

- Node `24.16.0`, Git, user-home consistency, Worker environment consistency,
  configured Runtime readability, provider-config validation, and process
  identity probe `ok`;
- the personal provider config exists as a regular file and was hashed without
  reading its contents into evidence;
- default model and live App Server status are `unknown`; Doctor intentionally
  does not create a Session or start a model request;
- execution mode is `yolo`, which remains an existing local-deployment warning,
  not an acceptance PASS.

Evidence:

- `.run/async-executor-web-e2e-20261122/official-runtime-inspect-web-e2e-final.json`
- `.run/async-executor-web-e2e-20261122/official-runtime-doctor-web-e2e-final.json`
- `.run/async-executor-web-e2e-20261122/provider-config-presence-web-e2e-final.json`

## Strict Wake C/D and Master

The Owner Desktop was not closed. No isolated Codex host, Thread, model budget,
or paid-model authorization was supplied. Consequently:

| Item | Status | Reason |
|---|---|---|
| Real loaded/idle Queue submission | `BLOCKED_BY_AUTHORIZATION` | no isolated Thread plus model/provider/effort/budget approval |
| `QUEUED` vs `TURN_STARTED` observation | `NOT_RUN` | no Queue submission |
| Master responds and reads original Result | `BLOCKED_BY_AUTHORIZATION` | would create a paid model Turn |
| C: Thread `notLoaded` | `BLOCKED_BY_OWNER_ENVIRONMENT` | no isolated Codex instance/control endpoint |
| D: Desktop fully exited | `BLOCKED_BY_OWNER_ENVIRONMENT` | closing the Owner's working Desktop was prohibited |
| Desktop visible | `UNKNOWN` | no acknowledgement channel |
| Web Notify fallback | `PASS — SYNTHETIC / REAL PROCESS` | durable, discoverable, no Queue or model request |
| Safe C/D degradation | `PARTIAL` | Result/Web discovery proven; actual notLoaded/full-exit delivery not run |

The valid release statement remains: Queue works only for an explicitly
authorized loaded/idle Thread whose current model, provider, effort, workspace,
and budget all match the Owner policy. Otherwise the safe fallback is Web
Notify.

## Preview Integration

The branch was first merged with Preview `3daffe476` through merge commit
`8f83bd340f1d6f31ddac12360583257969bb5863`, then integrated with the latest
Preview `c941f578` (terminal Result administrative release unification). The
resulting candidate is `02a9e81198cffc5b90077eaba00b5abbfd40f640`.

The integrated Preview deltas were:

- the AgentReport 400,000-character scan ceiling remains removed;
- ADR-039 administrative release now supports `completed`, `failed`,
  `waiting_for_master`, and `cancelled` terminal Results with Result/Claim/
  Worker identity/Recovery evidence binding;
- the Worker and plugin bundles are rebuilt from the merged source;
- the current Executor, IPC, Thin MCP, Web, Skill, Result Recovery, and
  architecture tests were rerun or bounded as described below.

No upstream Token Efficiency or terminal-Result release implementation was
overwritten.

## Verification

| Gate | Result |
|---|---|
| `npm run typecheck` on merged candidate | `PASS` |
| `npm run build:test` final rerun | `PASS` |
| `npm run build` on merged candidate | `PASS` |
| `npm run check:generated` | `PASS`, 13 files fresh |
| `npm run validate:plugin` | `PASS` |
| `git diff --check` | `PASS` |
| Current `02a9e811` primary targeted set | `92/92 PASS`, 0 fail |
| Merged Result/Cleanup/Recovery composition set | `269/269 non-Skill PASS`; the only failure in the 279-test run was the now-corrected Skill wording contract |
| Skill contract rerun after wording correction | `10/10 PASS` |
| C1 real process + real browser + synthetic Worker | `PASS — REAL PROCESS / SYNTHETIC WORKER` |
| Paid model requests | `0` |
| Full local Release Gate | `NOT_RUN` at this report revision |
| GitHub exact-head Release Gate | `NOT_RUN` at this report revision |

The 92-test targeted set covers AgentReport parsing, architecture boundaries,
Executor IPC/lease/process, Wake fail-closed behavior, Thin MCP, Task CLI, Web
Console discovery / Deep Link / pending Result, and Skill policy. The broader
merged composition run also covered the four terminal Result release states,
Recovery Hold binding, Cleanup/Release durability, SQLite v14 compatibility,
and real-adapter Result lifecycle. The Skill wording change did not alter any
non-Skill test input, so those 269 non-Skill tests were not repeated solely to
manufacture a second identical long run.

## Preview Recommendation

Keep PR #131 open for final review. Do not merge Preview and do not create a
Preview or Stable release from this report.

The four-layer architecture is unchanged:

```text
MCP -> Executor -> Adapter -> ZCode
```

Required follow-up:

1. After the documentation-only index update, run the exact-candidate GitHub
   Release Gate; record any failed job without widening the architecture.
2. With separate authorization, run one isolated loaded/idle Queue Turn and
   record ACK, Turn start, Master response, and Desktop visibility separately.
3. With separate Official Runtime authorization, run one minimal real Task and
   verify the same original Attempt Result / Cleanup / Release path.
4. Use an isolated Desktop environment for strict C/D. If unsupported, retain
   Web Notify and mark automatic Wake `BLOCKED`, never `PASS`.
