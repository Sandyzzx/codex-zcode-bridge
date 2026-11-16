# Host Event Wake Probe Decision

> Status: RESEARCH
> Last updated: 2026-11-16
> Last verified: 2026-11-16, real Windows Host E2E and real ZCode/SQLite Attention
> Verified against: `295727320cab86b071c23ddddd6e29306fa29e7f`

## Decision

`Thin Waiter --notify-codex`: **NO-GO** for implementation in this round.

This is not a rejection of the observed wake capability. It is a rejection of treating the current user-role queue route as a production-safe notification contract.

## Accepted findings

- `QUEUE_WAKES_TUI = YES` for a loaded, idle TUI. A1 produced a new target turn and assistant ACK without manual submission.
- `QUEUE_WAKES_DESKTOP_GOAL = YES` for a loaded completed Goal thread. B produced a visible assistant ACK in the same Desktop Goal thread UUID returned by the Goal tool.
- `MCP_WAIT_RETURNS = YES`. C1 returned on a real terminal Attention state and continued the active Master turn.
- The installed Thin Waiter is a real read-only SQLite Attention v2 observer. C2 returned terminal/exit `0`; C3 returned timeout/exit `3`.
- C2 can be combined with the already-confirmed queue route using a fixed summary. The resulting Desktop turn called `zcode_events` and `zcode_result` and emitted the expected ACK.
- `TOKEN_SAVINGS_MEASURABLE = NO / NOT_ESTABLISHED`. The available Master usage lacks matched, per-wait attribution.

## Blocking conditions

1. **Role boundary:** the confirmed wake mechanism delivers the notification as `role=user`. Worker text or permission instructions must never be inserted through that route.
2. **Unloaded resume:** A2 exited `0` but explicitly warned that it could not resume. Exit status alone cannot drive notification success.
3. **Interrupted state:** A3 queued successfully but produced no new turn during the observation window. No direct dispatch-pause event was available.
4. **No native notification channel:** the Thin Waiter only prints JSON. C2's Host wake required an additional ordinary CLI queue call.
5. **No safety matrix:** duplicate enqueue, cancellation races, late terminal notifications, and permission notifications were not exercised.
6. **No cost proof:** there are no matched active-wait and idle-wake trials with attributable Master token usage.

## Revisit gate

A future design proposal may be reconsidered only if it:

- preserves user authorization and does not convert Worker content into user intent or permission;
- treats enqueue, resume warning, Host turn start, and assistant consumption as separate facts;
- defines fail-closed handling for unloaded, interrupted, duplicate, cancelled, and late-event cases;
- emits only a fixed schema-derived summary: task ID, attempt, Attention reason, and instruction to query authoritative state;
- demonstrates measured, attributable token benefit in matched trials.

This probe does not authorize implementation, production SQLite changes, a daemon, or any Codex/Bridge architecture change.
