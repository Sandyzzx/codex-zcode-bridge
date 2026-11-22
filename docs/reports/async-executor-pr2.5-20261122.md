# Async Executor PR 2.5 Evidence

> Status: RESEARCH
> Date: 2026-11-22
> Branch: `codex/async-executor-pr2.5` (stacked on `codex/async-executor-pr2`)
> Base: `f330b511270934fa40014006333aa7747dad684c`
> Integration baseline: `origin/preview@1bf039fda2ccfd17a992458a871bddd7b48b38c1`
> Conclusion: `PARTIAL / BLOCKED`

## Scope

This slice converges the shipped MCP entry onto the accepted four-layer
direction:

```text
Thin MCP -> Executor Control IPC -> existing Worker -> Official ZCode Adapter/Runtime
```

It does not add a Supervisor, a second task database, a second state machine, a
management CLI, a Web server, or a Wake Adapter. The public MCP tool names and
schemas, SQLite v14, Worker private IPC, Task/Result/Cleanup/Release/Recovery
contracts, and the Official Runtime path remain intact.

## Architecture Delta

| Concern | PR 2.5 result |
|---|---|
| Shipped MCP | `src/host/stdio.ts` is Thin MCP only: MCP registration plus Executor control calls |
| Authority composition | `src/executor/production-composition.ts` is the only production composition |
| MCP transport | `ZCODE_BRIDGE_MCP_TRANSPORT` accepts only `control`; `in_process` is rejected |
| IPC | typed per-method request schemas, bounded frames, Existing 33 MiB envelope for 32 MiB Results |
| Model/Doctor | list/get/set/clear and complete Doctor are Executor-owned and proxied over IPC |
| Dependency boundary | static tests prohibit MCP from importing Manager, Store, Worker, Adapter, or Executor internals |
| Compatibility | `src/host/profile.ts` remains a re-export of the shared runtime host profile |
| Test-only legacy Host | `test/fixtures/stdio-lifecycle-host.ts`; never shipped |

## Verification Matrix

| Check | Status | Evidence |
|---|---|---|
| TypeScript declaration/typecheck | `PASS` | `npm run typecheck` |
| Test compilation/assets | `PASS` | `npm run build:test` |
| Executor process lifecycle, double start, shutdown, reconnect, fake durability, four-layer fake Official Adapter | `PASS` | `node --test dist-test/test/executor-process.test.js`: 10/10 |
| Lease, heartbeat, transition guard, legacy Host overlap, release failure | `PASS` | `node --test dist-test/test/executor-lease.test.js`: 14/14 |
| IPC framing, cancellation/unknown/unavailable, model/Doctor, 32 MiB Result | `PASS` | `node --test dist-test/test/executor-ipc.test.js`: 10/10 |
| Static dependency boundaries | `PASS` | `test/architecture-boundaries.test.ts`: 4/4 |
| Frozen MCP schemas and tool behavior | `PASS` | `node --test dist-test/test/mcp-server.test.js`: 27/27 |
| Shipped Thin MCP entry and no local SQLite Manager | `PASS` | `node --test dist-test/test/mcp-stdio-entry.test.js`: 5/5 |
| Validator fixture and path-leak regression | `PASS` | `node --test dist-test/test/validate-plugin-root-pattern.test.js`: 15/15 |
| Plugin structural validation | `PASS` | `npm run validate:plugin` |
| Full regression / Windows/Ubuntu/Stress | `NOT_RUN` | Owner deferred the complete suite until the whole Executor chain is a Release Candidate |
| Real Codex Desktop close / original Attempt durability | `BLOCKED_BY_OWNER_ENVIRONMENT` | Owner's active Desktop was not closed |
| Real Official ZCode Runtime/provider request | `NOT_RUN` | No new paid model authorization; fake Official Host cannot establish production billing/auth |
| Strict Wake C/D | `NOT_RUN` | PR 5 scope; Web Notify remains the safe fallback |

The four-layer test uses the test-only Official Host loopback module and a
controlled app-server. It is evidence of composition and IPC behavior, not of
real Desktop process survival, real provider authentication, or billing.

## Commands and Safety

The verification commands used isolated roots under the test fixtures and did
not mutate production SQLite, the Owner Desktop, account credentials, or
Workspace resources. No command was automatically retried. No real model
request was made.

For the branch gate, generated artifacts must be rebuilt and committed together
with source. `npm run check:generated` is expected to pass only from a clean
tree; it is not a substitute for the full regression gate.

## Release Decision

PR 2.5 may be submitted as a stacked review candidate after its final focused
tests and CI pass. It must not be merged into Preview, published, or used to
claim Desktop-close durability while the PR 2 Validation Gate remains blocked.
The next required evidence is an isolated real Host close experiment using a
dedicated test environment, followed by real Official Runtime verification only
if separately authorized.
