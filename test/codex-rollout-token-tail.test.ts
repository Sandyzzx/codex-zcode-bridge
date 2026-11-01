import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  CodexRolloutTailReader,
  discoverCodexRolloutByThreadId,
} from "../src/observability/codex-rollout-token-source.js";

let sandbox: string;
let codexHome: string;

test.beforeEach(() => {
  mkdirSync(path.join(process.cwd(), ".evidence"), { recursive: true });
  sandbox = mkdtempSync(path.join(process.cwd(), ".evidence", "rollout-tail-test-"));
  codexHome = path.join(sandbox, "codex-home");
  mkdirSync(path.join(codexHome, "sessions", "2026", "10", "31"), { recursive: true });
  mkdirSync(path.join(codexHome, "archived_sessions"), { recursive: true });
});

test.afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function metadata(id: string, parentThreadId: string | null = null): Record<string, unknown> {
  return {
    timestamp: "2026-10-31T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      session_id: id,
      parent_thread_id: parentThreadId,
      thread_source: "user",
      originator: "Codex Desktop",
      model_provider: "magpie",
      cli_version: "0.166.0-alpha.5.1",
    },
  };
}

function tokenCount(total: number, last: number, context: number | null = 258_400, note = ""): Record<string, unknown> {
  return {
    timestamp: "2026-10-31T00:01:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      note,
      info: {
        total_token_usage: { total_tokens: total, input_tokens: total - 10, output_tokens: 10 },
        last_token_usage: { total_tokens: last, input_tokens: last - 2, output_tokens: 2 },
        model_context_window: context,
      },
    },
  };
}

function rolloutPath(id: string, root = "sessions", nameSuffix = ""): string {
  const directory = root === "sessions"
    ? path.join(codexHome, root, "2026", "10", "31")
    : path.join(codexHome, root);
  mkdirSync(directory, { recursive: true });
  return path.join(directory, `rollout-2026-10-31T00-00-00-${id}${nameSuffix}.jsonl`);
}

function writeRollout(file: string, records: unknown[]): void {
  writeFileSync(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

test("discovers only an identity-validated main Thread inside official session roots", async () => {
  const id = "thread-discovery";
  const valid = rolloutPath(id);
  writeRollout(valid, [metadata(id), tokenCount(100, 50)]);

  const wrongIdentity = rolloutPath(id, "sessions", "-decoy");
  writeRollout(wrongIdentity, [metadata("different-thread"), tokenCount(999, 999)]);
  utimesSync(wrongIdentity, new Date("2026-10-31T01:00:00.000Z"), new Date("2026-10-31T01:00:00.000Z"));

  const outside = path.join(sandbox, `rollout-2026-10-31T00-00-00-${id}-outside.jsonl`);
  writeRollout(outside, [metadata(id), tokenCount(1_000, 1_000)]);

  const result = await discoverCodexRolloutByThreadId({ codexHome, expectedThreadId: id });
  assert.equal(result.state, "found");
  assert.equal(result.validatedFileCount, 1);
  assert.equal(result.sourceFile, valid);
  assert.equal(result.threadSource, "user");
  assert.equal(result.parentThreadId, null);
});

test("does not use mtime to choose between multiple identity-validated files", async () => {
  const id = "thread-ambiguous";
  const first = rolloutPath(id);
  const second = rolloutPath(id, "archived_sessions");
  writeRollout(first, [metadata(id), tokenCount(100, 25)]);
  writeRollout(second, [metadata(id), tokenCount(200, 50)]);
  utimesSync(first, new Date("2026-10-31T02:00:00.000Z"), new Date("2026-10-31T02:00:00.000Z"));

  const result = await discoverCodexRolloutByThreadId({ codexHome, expectedThreadId: id });
  assert.equal(result.state, "ambiguous");
  assert.equal(result.validatedFileCount, 2);
  assert.equal(result.sourceFile, null);
});

test("rejects child Agent and wrong metadata candidates", async () => {
  const id = "thread-child";
  const child = rolloutPath(id);
  writeRollout(child, [metadata(id, "parent-thread"), tokenCount(100, 25)]);

  const result = await discoverCodexRolloutByThreadId({ codexHome, expectedThreadId: id });
  assert.equal(result.state, "identity_unverified");
  assert.equal(result.filenameCandidateCount, 1);
  assert.equal(result.validatedFileCount, 0);
  assert.equal(result.sourceFile, null);
});

test("tails appends, deduplicates absolute snapshots, and replaces last after Compaction", async () => {
  const id = "thread-tail";
  const file = rolloutPath(id);
  writeRollout(file, [metadata(id), tokenCount(100, 90)]);
  const reader = await CodexRolloutTailReader.open({ codexHome, rolloutFile: file, expectedThreadId: id });

  const initial = await reader.poll();
  assert.equal(initial.status, "updated");
  assert.equal(initial.snapshot?.total?.totalTokens, 100);
  assert.equal(initial.snapshot?.last?.totalTokens, 90);
  assert.equal(initial.state.pendingBytes, 0);

  appendFileSync(file, [
    JSON.stringify({ timestamp: "2026-10-31T00:02:00.000Z", type: "compacted", payload: {} }),
    JSON.stringify(tokenCount(100, 20)),
    JSON.stringify(tokenCount(100, 20)),
  ].join("\n") + "\n", "utf8");

  const afterCompaction = await reader.poll();
  assert.equal(afterCompaction.status, "updated");
  assert.equal(afterCompaction.snapshot?.total?.totalTokens, 100);
  assert.equal(afterCompaction.snapshot?.last?.totalTokens, 20);
  assert.equal(afterCompaction.observedAfterCompaction, true);
  assert.equal(afterCompaction.duplicateSnapshotCount, 1);
  assert.equal(afterCompaction.state.lastValidSnapshot?.last?.totalTokens, 20);
});

test("handles UTF-8 split across chunks and a partial JSONL line across polls", async () => {
  const id = "thread-utf8";
  const file = rolloutPath(id);
  writeRollout(file, [metadata(id), tokenCount(100, 90)]);
  const reader = await CodexRolloutTailReader.open({
    codexHome,
    rolloutFile: file,
    expectedThreadId: id,
    chunkSize: 1,
  });
  await reader.poll();

  const line = Buffer.from(`${JSON.stringify(tokenCount(160, 40, 200_000, "中文增量"))}\n`, "utf8");
  const chineseStart = line.indexOf(Buffer.from("中", "utf8"));
  appendFileSync(file, line.subarray(0, chineseStart + 1));
  const partial = await reader.poll();
  assert.equal(partial.status, "partial_line");
  assert.ok(partial.state.pendingBytes > 0);

  appendFileSync(file, line.subarray(chineseStart + 1));
  const completed = await reader.poll();
  assert.equal(completed.status, "updated");
  assert.equal(completed.snapshot?.total?.totalTokens, 160);
  assert.equal(completed.snapshot?.last?.totalTokens, 40);
  assert.equal(completed.snapshot?.modelContextWindow, 200_000);
  assert.equal(completed.state.pendingBytes, 0);
});

test("recovers from truncation and replacement, and reopening starts from the latest snapshot", async () => {
  const id = "thread-recovery";
  const file = rolloutPath(id);
  writeRollout(file, [metadata(id), tokenCount(1_000, 500)]);
  const reader = await CodexRolloutTailReader.open({ codexHome, rolloutFile: file, expectedThreadId: id });
  await reader.poll();

  writeRollout(file, [metadata(id), tokenCount(120, 30)]);
  const truncated = await reader.poll();
  assert.equal(truncated.resetReason, "truncated");
  assert.equal(truncated.snapshot?.total?.totalTokens, 120);
  assert.equal(truncated.snapshot?.last?.totalTokens, 30);

  rmSync(file);
  const missing = await reader.poll();
  assert.equal(missing.status, "file_changed");
  assert.equal(missing.snapshot, null);

  writeRollout(file, [metadata(id), tokenCount(77, 17)]);
  const replaced = await reader.poll();
  assert.equal(replaced.resetReason, "replaced");
  assert.equal(replaced.snapshot?.total?.totalTokens, 77);
  assert.equal(replaced.snapshot?.last?.totalTokens, 17);

  const reopened = await CodexRolloutTailReader.open({ codexHome, rolloutFile: file, expectedThreadId: id });
  const reopenedResult = await reopened.poll();
  assert.equal(reopenedResult.resetReason, "initial");
  assert.equal(reopenedResult.snapshot?.total?.totalTokens, 77);
  assert.equal(reopenedResult.snapshot?.last?.totalTokens, 17);
});

test("detects an in-place truncate and regrow beyond the previous offset", async () => {
  const id = "thread-regrow";
  const file = rolloutPath(id);
  writeRollout(file, [metadata(id), tokenCount(100, 20)]);
  const reader = await CodexRolloutTailReader.open({ codexHome, rolloutFile: file, expectedThreadId: id });
  await reader.poll();

  writeRollout(file, [
    metadata(id),
    { timestamp: "2026-10-31T00:02:00.000Z", type: "noop", payload: { padding: "x".repeat(8_192) } },
    tokenCount(240, 30),
  ]);
  const regrown = await reader.poll();
  assert.equal(regrown.resetReason, "truncated");
  assert.equal(regrown.snapshot?.total?.totalTokens, 240);
  assert.equal(regrown.snapshot?.last?.totalTokens, 30);
});

test("fails closed if a tracked file is truncated into a different or child Thread identity", async () => {
  const id = "thread-stable-id";
  const file = rolloutPath(id);
  writeRollout(file, [metadata(id), tokenCount(100, 40)]);
  const reader = await CodexRolloutTailReader.open({ codexHome, rolloutFile: file, expectedThreadId: id });
  await reader.poll();

  writeRollout(file, [metadata("different-thread"), tokenCount(1, 1)]);
  const result = await reader.poll();
  assert.equal(result.status, "identity_unverified");
  assert.equal(result.snapshot, null);
  assert.equal(result.state.lastValidSnapshot, null);
});
