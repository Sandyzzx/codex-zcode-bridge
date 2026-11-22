# Async Executor PR 6 Evidence

> Status: IMPLEMENTED — PARTIAL / BLOCKED
> Date: 2026-11-22（Asia/Shanghai）
> Baseline: stacked PR 5 candidate `5cb9073d55d888cf9a80b1d150b446ece658d645`
> Decision: [ADR-052](../decisions/ADR-052-async-master-handoff.md)

## Scope

PR 6 updates the Master Skill and architecture decisions for Async Handoff. It
does not add a runtime service, public MCP field/tool, Task state, database,
Supervisor, Recovery Engine, or second Worker path.

```text
authorization
  -> task scope: whole_task / staged / read-only auto
  -> reliable Task acceptance
  -> handoff mechanism: async_wake / foreground
  -> Turn end without cancellation
  -> Wake with identity check
  -> Result / Cleanup / Release evidence
  -> independent Master acceptance
```

## Implementation

- Root Skill keeps authorization, explicit cancellation, approval, quota stop,
  cleanup Hold and independent acceptance as P0 rules.
- `references/async-handoff.md` defines reliable acceptance, concise receipt,
  Turn end, no polling, unknown-receipt reconciliation, Wake identity checks,
  Pending Interaction and prohibited Queue/policy shortcuts.
- Existing delegation, dispatch, monitoring, reporting, review and runtime
  references now distinguish task scope from handoff mechanism and no longer
  imply long in-turn waiting after a safe async handoff.
- ADR-052 records the decision without changing SQLite v14, Manager, Worker,
  Result, Cleanup, Recovery, Release or public MCP contracts.

## Result Matrix

| Check | Status | Evidence |
|---|---|---|
| Scoped authorization is still the first gate | `PASS` | `test/skill-policy.test.ts` authorization assertions |
| Task scope and Handoff Mechanism are separate | `PASS` | deterministic workflow contract |
| accepted Task records identity and ends Turn without polling | `PASS` | deterministic workflow contract |
| unknown receipt reconciles the same `task_id` | `PASS` | deterministic workflow contract and Skill text |
| Turn end/disconnect/MCP stop does not cancel Task | `PASS` | deterministic workflow contract and Skill text |
| explicit cancellation remains separately authorized | `PASS` | deterministic workflow contract |
| Wake identity mismatch fails closed | `PASS` | deterministic workflow contract |
| Wake is not Result/Cleanup/Release/acceptance | `PASS` | deterministic workflow contract and Skill text |
| Pending Interaction remains a blocker and is never auto-approved | `PASS` | deterministic workflow contract and Skill text |
| all Skill links/reference routing remain valid | `PASS` | `skill-policy.test.ts` |
| real model follows the Skill after a live Host Turn | `NOT_RUN` | requires separately authorized Host/model test |
| real Queue Wake resumes the original Thread | `NOT_RUN / BLOCKED` | inherited from PR 5 environment boundary |
| strict Wake C / Desktop full-exit D | `NOT_RUN / BLOCKED` | independent Host acceptance remains required |
| complete Windows/Ubuntu/Stress Release Candidate matrix | `NOT_RUN` | deferred to frozen PR 2-6 candidate |

## Commands and Evidence

Targeted development evidence for this candidate:

```text
npm run build:test
node --test dist-test/test/skill-policy.test.js
npm run validate:plugin
npm run check:generated
npm run test:affected -- --development --base 5cb9073d55d888cf9a80b1d150b446ece658d645
```

Observed results:

- TypeScript typecheck: PASS.
- Skill policy contracts: 10/10 PASS.
- Plugin validation: PASS.
- Generated artifact freshness: PASS (13 tracked artifacts).
- Affected development gate: `TARGETED_TESTS_PASS`; only
  `test/skill-policy.test.ts` selected; typecheck/build/plugin/generated checks
  all passed.

The deterministic workflow model proves only the written decision contract; it
does not claim model adherence, Queue delivery, Desktop visibility or paid
Runtime success.

## Boundaries

- No real `codex queue`, App Server control socket, paid model request or
  Desktop shutdown was performed.
- No Preview merge or release is authorized by this evidence.
- Async Handoff remains experimental until the frozen PR 2-6 candidate passes
  the unified release gate and the independent real Host checks.
