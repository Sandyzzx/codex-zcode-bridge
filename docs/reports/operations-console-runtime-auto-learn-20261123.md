# Operations Console, Cost Lab, and Runtime Auto-Learn

> Status: RESEARCH
> Date: 2026-11-23 (Asia/Shanghai)
> Branch: `codex/async-executor-rc-20261122`
> Worktree: `C:\Users\Sandy\.codex\worktrees\async-executor-pr5-20261122\codex-zcode-bridge`
> Candidate: `f8e6aa7f` (`origin/preview@8ee7ec93a82c` already contained)
> Conclusion: `PARTIAL / BLOCKED`

## Scope

This change extends the existing Task Web Console into one loopback Bridge
Operations Console, mounts the existing Cost Lab implementation on the same
origin, and adds an exact-fingerprint Runtime compatibility evidence view. It
does not add a second Task Authority, Manager, Worker path, persistence store,
Supervisor, recovery engine, or long-running Web service.

No production SQLite database, credential, compatibility manifest, Owner
Desktop, or paid model request was modified. The Cost Lab and Web checks use
isolated roots and synthetic providers/workers unless a row explicitly says
otherwise.

## Delivered Changes

### ADR-027 cleanup recovery stability

Commit `1eaf2d876` changes the Windows process probe so a process that exits
between `GetProcessById` and `StartTime` is treated as absent for that snapshot,
not as a query failure. The existing identity, recorded-tree, Result, Cleanup,
and Release guards remain in force. The affected real-adapter lifecycle test
also waits for the exact Worker identity to be observed as exited before the
user-authorized recovery path runs.

### Operations Console

The single-origin Console now provides Dashboard, Tasks, Cost Lab, Runtime, and
Settings. It supports `zh-CN`/`en`, Light/Dark/System preferences, Task Deep
Links, status/events/result loading independently, and Result pending display.
Task facts still flow only through `ExecutorControlClient` and
`RemoteTaskManager`; Task ID, Provider ID, Model ID, error codes, raw Events,
and JSON evidence remain untranslated.

### Cost Lab integration and Runner

Cost Lab APIs are mounted under the Console origin and reuse the existing
billing, Start Plan, history, redaction, and verification services. The
production verification Runner now uses an isolated Authority Root, writes the
SQLite authority marker, starts the independent Executor, and drives the
shipped MCP/Executor path instead of restoring an in-process Manager.

### Runtime Auto-Learn

The Runtime view stores compatibility observations under
`<Authority Root>/.run/bridge-console/runtime-compatibility.json`, keyed by
exact installation fingerprint. It separates static inspection, authorized
zero-model protocol probing, and explicitly authorized real Provider/Billing
evidence. Candidate reports are review material only; they do not modify the
production manifest or promote an experimental Runtime to `VERIFIED`.

## Evidence

| Check | Result | Evidence |
|---|---|---|
| Typecheck | `PASS` | `npm run typecheck` |
| Test compilation | `PASS` | `npm run build:test` |
| Runtime Auto-Learn tests | `PASS — 7/7` | `.run/async-executor-web-e2e-20261122/web-runtime-current-17.log` |
| Web Console tests | `PASS — 10/10` | same log; includes real Chromium |
| Combined Runtime + Web | `PASS — 17/17` | `.run/async-executor-web-e2e-20261122/web-runtime-current-17.log` |
| Cost Lab suite | `PASS — 88/88` | `.run/async-executor-web-e2e-20261122/cost-lab-current-f8e6aa7f.log` |
| Runner cross-process synthetic Worker | `PASS — 1/1` | `.run/async-executor-web-e2e-20261122/cost-lab-runner-process-current.log` |
| ADR-027 affected lifecycle | `PASS — 12/12` | `.run/async-executor-web-e2e-20261122/adr027-result-lifecycle-current.log` |
| ADR-027 process probe related | `PASS — 13/13` | `.run/async-executor-web-e2e-20261122/adr027-probe-related.log` |
| Impact selector + shard validation | `PASS — 25/25` | `node --test dist-test/test/test-impact-selector.test.js dist-test/test/test-shard-plan.test.js` |
| Inventory generation | `PASS` | `npm run test:inventory`: 1015 declarations from 111 mapped files |
| Plugin build | `PASS` | `npm run build:plugin`; `plugins/codex-zcode-bridge/dist/web-console.mjs` rebuilt |
| Plugin structure | `PASS` | `npm run validate:plugin` |
| Generated freshness | `PASS` | `npm run check:generated`: 14 tracked files fresh on Bridge candidate `1a7fcd89f` |
| Local Windows Bridge Release Gate | `PASS — 1086/1088, 2 existing skips` | `1a7fcd89f`; `npm run test:full`, exit 0; `.run/async-executor-web-e2e-20261122/release-gate-repaired.log` |
| GitHub Windows/Ubuntu Release Gate | `NOT_RUN` | New run pending after Cost Lab CI repair `f8e6aa7f`; earlier `ed40ab9b` failed only Cost Lab |
| Real Official Runtime Provider/Billing | `BLOCKED_BY_AUTHORIZATION` | No new paid model or Billing request authorized |
| Real Queue Wake / Master Turn | `NOT_RUN / BLOCKED` | Requires isolated real Codex Thread/Host acceptance |
| Real Desktop fully-exited and strict C/D | `NOT_RUN / BLOCKED` | Owner’s active Desktop was not closed |

### Release Gate repair

The first full gate at `b654d20d9` failed three of 1088 checks. Commit
`1a7fcd89f` fixes only those failures:

- `src/web/cost-lab-integration.ts` no longer imports the frozen Adapter layer
  directly; the official dependency binding moved to
  `src/runtime/cost-lab-official-dependencies.ts`.
- The real plugin-validator fixture now creates
  `dist/vendor/official-billing-runtime.mjs`.
- The Chromium E2E now uses an owned, short-lived persistent profile and
  restores the real OS home only for the browser child. The isolated runner’s
  relocated `HOME`/`USERPROFILE` was the actual startup failure; a long profile
  path was not.

The repaired full gate reported `1088` tests, `1086` pass, `0` fail, and the
same `2` explicit skips. Plugin validation returned
`Plugin package is structurally valid`; generated-artifact freshness returned
`14 files`.

The first pushed CI at `ed40ab9b` then exposed one Windows-only Cost Lab
failure: the runner supplied an 8.3 temporary parent (`RUNNER~1`) to the
Executor, while SQLite correctly compared `realpath(native)` and rejected it as
`sqlite_data_root_redirected`. Commit `f8e6aa7f` canonicalizes the existing
state-root parent before constructing the isolated Authority root. The complete
Cost Lab suite then passed `88/88`, including the real cross-process
Executor/MCP/synthetic-Worker case. No production Bridge source changed after
the 1086-pass local Bridge gate.

### Cost Lab transient observation

One earlier parallel invocation of the Cost Lab suite produced 17/18 PASS with
`ETIMEDOUT 127.0.0.1:2323` in
`startplan-web.test.mjs::simultaneous refreshes share one official read and one
history entry`. Running the affected tests alone produced 4/4 PASS, and the
full isolated Cost Lab suite then produced 88/88 PASS. This is recorded as a
transient network/startup observation, not silently converted into proof. The
final repair changes no `tools/cost-lab/**` file; its 88/88 evidence remains
attached to `3baf91c65`, while the exact final candidate carries the complete
Bridge release gate.

## Real-Process Boundary

The existing C1 evidence remains `REAL OS PROCESS + SYNTHETIC WORKER; NOT REAL
MODEL RUNTIME`:

- Executor URL/process: `http://127.0.0.1:20768/`
- Task: `web-e2e-1795360265130`, Attempt 1
- Deep link: `http://127.0.0.1:20768/?task_id=web-e2e-1795360265130`
- Task completed with exactly one Result commit, one Cleanup Verified event,
  one Release event, and one Spawn
- The first MCP Host exited; Executor and Console remained active
- A new MCP Host read the same original Result
- Browser screenshots: `operations-console-runtime.png`
- Evidence: `.run/async-executor-web-e2e-20261122/evidence.json`

This proves process and Web/Executor ownership behavior with a synthetic
Worker. It does not prove real Codex Desktop shutdown, real Queue Wake, real
Official Runtime execution, real model response, or real Billing attribution.

## Release Decision

`PARTIAL / BLOCKED`.

Implementation candidate `f8e6aa7f` includes the latest verified
`origin/preview`. Its Bridge source passes the complete local Windows Release
Gate at `1a7fcd89f`; its Cost Lab runner passes `88/88` after the 8.3-path CI
fix. The candidate still requires the applicable GitHub Windows/Ubuntu checks
after push. The real Host, Queue/Master, Official Runtime, and Billing gates
remain separate Owner-authorized experiments. No Preview merge or Release is
recommended until the CI result and those separately authorized boundaries are
recorded.
