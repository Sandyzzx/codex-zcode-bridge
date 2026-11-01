import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readCodexRolloutTokenSnapshot } from "../src/observability/codex-rollout-token-source.js";

let sandbox: string;
let codexHome: string;

test.beforeEach(() => {
  mkdirSync(path.join(process.cwd(), ".evidence"), { recursive: true });
  sandbox = mkdtempSync(path.join(process.cwd(), ".evidence", "rollout-reader-test-"));
  codexHome = path.join(sandbox, "codex-home");
  mkdirSync(path.join(codexHome, "sessions", "2026", "10", "30"), { recursive: true });
});

test.afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function rollout(threadId: string, records: unknown[], newline = true): string {
  const file = path.join(codexHome, "sessions", "2026", "10", "30", `rollout-${threadId}.jsonl`);
  const content = records.map(record => JSON.stringify(record)).join("\n") + (newline ? "\n" : "");
  writeFileSync(file, content, "utf8");
  return file;
}

function metadata(id: string, parentThreadId: string | null = null): unknown {
  return { timestamp: "2026-10-30T00:00:00.000Z", type: "session_meta", payload: {
    id, session_id: id, parent_thread_id: parentThreadId, thread_source: "user", originator: "Codex Desktop",
  } };
}

function tokenCount(total: Record<string, unknown> | null, last: Record<string, unknown> | null, context = 258_400): unknown {
  return { timestamp: "2026-10-30T00:01:00.000Z", type: "event_msg", payload: {
    type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: context },
  } };
}

test("reads the latest absolute TokenCount for an explicitly identified main Thread", async () => {
  const id = "thread-a";
  const file = rollout(id, [
    metadata(id),
    tokenCount({ total_tokens: 100, input_tokens: 90, output_tokens: 10 }, { total_tokens: 100, input_tokens: 90, output_tokens: 10 }),
    { timestamp: "2026-10-30T00:02:00.000Z", type: "compacted", payload: {} },
    tokenCount({ total_tokens: 100, input_tokens: 90, output_tokens: 10 }, { total_tokens: 25, input_tokens: 20, output_tokens: 5 }, null as unknown as number),
  ]);
  const result = await readCodexRolloutTokenSnapshot({ codexHome, rolloutFile: file, expectedThreadId: id });
  assert.equal(result.state, "ok");
  assert.equal(result.tokenCountEventCount, 2);
  assert.equal(result.compactionMarkerCount, 1);
  assert.equal(result.latest?.absoluteSnapshot, true);
  assert.equal(result.latest?.total?.totalTokens, 100);
  assert.equal(result.latest?.last?.totalTokens, 25);
  assert.equal(result.latest?.last?.cachedInputTokens, null);
  assert.equal(result.latest?.modelContextWindow, null);
});

test("ignores a truncated final JSONL line and reports unknown fields as null", async () => {
  const id = "thread-b";
  const valid = tokenCount({ total_tokens: 8, output_tokens: 1 }, { total_tokens: 8, input_tokens: 7 }, null as unknown as number);
  const file = rollout(id, [metadata(id), { broken: true }, valid], false);
  const append = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":";
  writeFileSync(file, `${JSON.stringify(metadata(id))}\n{broken json}\n${JSON.stringify(valid)}\n${append}`, "utf8");
  const result = await readCodexRolloutTokenSnapshot({ codexHome, rolloutFile: file, expectedThreadId: id });
  assert.equal(result.state, "ok");
  assert.equal(result.invalidJsonLineCount, 1);
  assert.equal(result.trailingPartialLineIgnored, true);
  assert.equal(result.latest?.total?.totalTokens, 8);
  assert.equal(result.latest?.total?.cachedInputTokens, null);
  assert.equal(result.latest?.last?.outputTokens, null);
  assert.equal(result.latest?.modelContextWindow, null);
});

test("reports no_token_usage without fabricating a zero snapshot", async () => {
  const id = "thread-empty";
  const file = rollout(id, [
    metadata(id),
    { timestamp: "2026-10-30T00:01:00.000Z", type: "event_msg", payload: { type: "token_count", info: null } },
  ]);
  const result = await readCodexRolloutTokenSnapshot({ codexHome, rolloutFile: file, expectedThreadId: id });
  assert.equal(result.state, "no_token_usage");
  assert.equal(result.tokenCountEventCount, 1);
  assert.equal(result.emptyUsageEventCount, 1);
  assert.equal(result.latest, null);
});

test("fails closed when rollout metadata identifies another Thread or a child Agent", async () => {
  const expected = "thread-c";
  const otherId = "thread-other";
  const file = rollout(expected, [metadata(otherId), tokenCount({ total_tokens: 1 }, { total_tokens: 1 })]);
  const result = await readCodexRolloutTokenSnapshot({ codexHome, rolloutFile: file, expectedThreadId: expected });
  assert.equal(result.state, "thread_identity_unverified");
  assert.equal(result.latest, null);

  const childId = "thread-child";
  const childFile = rollout(childId, [metadata(childId, "thread-parent"), tokenCount({ total_tokens: 3 }, { total_tokens: 3 })]);
  const child = await readCodexRolloutTokenSnapshot({ codexHome, rolloutFile: childFile, expectedThreadId: childId });
  assert.equal(child.state, "thread_identity_unverified");
  assert.equal(child.latest, null);
});

test("rejects a Rollout path outside the explicitly selected Codex Home session roots", async () => {
  const file = path.join(sandbox, "outside.jsonl");
  writeFileSync(file, `${JSON.stringify(metadata("thread-d"))}\n`, "utf8");
  await assert.rejects(
    readCodexRolloutTokenSnapshot({ codexHome, rolloutFile: file, expectedThreadId: "thread-d" }),
    /rollout_file_outside_codex_home_sessions/,
  );
});
