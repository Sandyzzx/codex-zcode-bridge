import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEventByteBudget,
  mergeAdjacentModelOutputRows,
} from "../src/manager/sqlite-lifecycle-mcp-authority.js";

function row(
  cursor: number,
  eventType: string,
  summary: string,
  attempt: number,
  evidence: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cursor,
    sequence: cursor + 100,
    at: `2026-11-15T00:00:${String(cursor).padStart(2, "0")}.000Z`,
    event_type: eventType,
    summary,
    operation_id: `operation-${attempt}`,
    operation_attempt: attempt,
    evidence_json: JSON.stringify(evidence),
  };
}

function eventFor(value: Record<string, unknown>) {
  const details = JSON.parse(String(value.evidence_json)) as Record<string, unknown>;
  return {
    seq: Number(value.cursor),
    at: String(value.at),
    type: String(value.event_type),
    summary: String(value.summary),
    details,
  };
}

test("summary merges only adjacent safe model output from the same Attempt", () => {
  const result = mergeAdjacentModelOutputRows([
    row(1, "model_output", "one ", 1),
    row(2, "model_output", "two", 1),
    row(3, "model_output", " three", 1),
  ]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.summary, "one two three");
  assert.equal(result.rows[0]?.cursor, 3, "the merged row retains the final scanned cursor");
  assert.equal(result.rows[0]?.sequence, 103, "the merged row retains the final store sequence");
  assert.equal(result.omittedEvents, 2);
});

test("summary does not merge across Interaction or Permission boundaries", () => {
  const result = mergeAdjacentModelOutputRows([
    row(1, "model_output", "a", 1),
    row(2, "interaction_requested", "interaction", 1),
    row(3, "model_output", "b", 1),
    row(4, "permission_requested", "permission", 1),
    row(5, "model_output", "c", 1),
  ]);
  assert.deepEqual(
    result.rows.map((item) => item.summary),
    ["a", "interaction", "b", "permission", "c"],
  );
  assert.equal(result.omittedEvents, 0);
});

test("summary preserves every non-text boundary and Attempt/evidence boundary", () => {
  const input = [
    row(1, "model_output", "a", 1),
    row(2, "model_output", "b", 1),
    row(3, "model_tool_call", "tool", 1),
    row(4, "model_output", "c", 1),
    row(5, "model_output", "attempt-two", 2),
    row(6, "model_output", "d", 2),
    row(7, "model_output", "unsafe", 2, { hidden: "detail" }),
    row(8, "model_output", "e", 2),
  ];
  const result = mergeAdjacentModelOutputRows(input);
  assert.equal(result.rows.length, 6);
  assert.deepEqual(
    result.rows.map((item) => item.summary),
    ["ab", "tool", "c", "attempt-twod", "unsafe", "e"],
  );
  assert.equal(result.omittedEvents, 2);
});

test("raw-shaped rows are copied rather than mutated across invocations", () => {
  const first = row(1, "model_output", "first", 1);
  const second = row(2, "model_output", "second", 1);
  const original = structuredClone([first, second]);
  const result = mergeAdjacentModelOutputRows([first, second]);
  assert.deepEqual([first, second], original);
  assert.notEqual(result.rows[0], first);
});

test("summary admits only merge groups that fit the byte budget", () => {
  const rows = [
    row(1, "model_output", "a".repeat(700), 1),
    row(2, "model_output", "b".repeat(700), 1),
    row(3, "model_output", "c".repeat(700), 1),
  ];
  const merged = mergeAdjacentModelOutputRows(rows, 1_024);
  assert.ok(merged.rows.length > 1, "the complete merge must not exceed max_bytes");
  assert.ok(merged.rows.every((value) => Buffer.byteLength(JSON.stringify(eventFor(value)), "utf8") <= 1_024));

  const bounded = applyEventByteBudget(merged.rows.map(eventFor), 4, 1_024, 0);
  assert.equal(bounded.events.length, 1);
  assert.equal(bounded.nextCursor, 1);
  assert.equal(bounded.scanIncomplete, true);
});

test("a merge group that exactly reaches max_bytes is returned", () => {
  const rows = [
    row(1, "model_output", "a".repeat(300), 1),
    row(2, "model_output", "b".repeat(300), 1),
  ];
  const unbounded = mergeAdjacentModelOutputRows(rows).rows[0]!;
  const exactBudget = Buffer.byteLength(JSON.stringify(eventFor(unbounded)), "utf8");
  const merged = mergeAdjacentModelOutputRows([
    ...rows,
    row(3, "model_output", "c".repeat(100), 1),
  ], exactBudget);
  assert.equal(merged.rows.length, 2);

  const bounded = applyEventByteBudget(merged.rows.map(eventFor), 4, exactBudget, 0);
  assert.equal(bounded.events.length, 1);
  assert.equal(bounded.nextCursor, 2);
  assert.equal(bounded.scanIncomplete, true);
});

test("omitted_events can be limited to the merged rows actually returned", () => {
  const merged = mergeAdjacentModelOutputRows([
    row(1, "model_output", "a", 1),
    row(2, "model_output", "b", 1),
    row(3, "model_output", "c", 1),
    row(4, "model_output", "x".repeat(2_000), 1),
  ], 1_024);
  assert.deepEqual(merged.omittedEventsByRow, [2, 0]);
  const bounded = applyEventByteBudget(merged.rows.map(eventFor), 5, 1_024, 0);
  assert.equal(bounded.events.length, 1);
  const omittedForReturned = merged.omittedEventsByRow
    .slice(0, bounded.events.length)
    .reduce((total, count) => total + count, 0);
  assert.equal(omittedForReturned, 2);
});

test("a single raw event over budget retains the explicit incomplete scan", () => {
  const events = [
    {
      seq: 9,
      at: "2026-11-15T00:00:09.000Z",
      type: "model_output",
      summary: "x".repeat(2_000),
    },
  ];
  assert.deepEqual(applyEventByteBudget(events, 10, 1_024, 8), {
    events: [],
    nextCursor: 8,
    scanIncomplete: true,
  });
});

test("the byte budget retains the merged cursor and reports an incomplete scan", () => {
  const events = [
    { seq: 12, at: "2026-11-15T00:00:12.000Z", type: "model_output", summary: "small" },
    { seq: 13, at: "2026-11-15T00:00:13.000Z", type: "model_output", summary: "x".repeat(5_000) },
  ];
  const bounded = applyEventByteBudget(events, 14, 1_024, 11);
  assert.deepEqual(bounded.events, [events[0]]);
  assert.equal(bounded.nextCursor, 12, "the next scan cursor points at the last returned event");
  assert.equal(bounded.scanIncomplete, true);
  assert.deepEqual(applyEventByteBudget(events, 14, undefined, 11), {
    events,
    nextCursor: 14,
    scanIncomplete: false,
  });
});
