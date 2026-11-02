import test from "node:test";
import assert from "node:assert/strict";
import {
  ThreadTokenUsageManager,
  TokenUsageSource,
  TOKEN_USAGE_NOTIFICATION,
  classifyAccountUsageReadFailure,
} from "../src/observability/thread-token-usage.js";

function notice(threadId: string, turnId: string, total: number, last: number, patch: Record<string, unknown> = {}): {
  threadId: string;
  turnId: string;
  tokenUsage: { total: Record<string, unknown>; last: Record<string, unknown>; modelContextWindow: number | null };
} {
  const item = (tokens: number) => ({
    totalTokens: tokens,
    inputTokens: tokens - 100,
    cachedInputTokens: 100,
    outputTokens: 80,
    reasoningOutputTokens: 20,
    ...patch,
  });
  return { threadId, turnId, tokenUsage: { total: item(total), last: item(last), modelContextWindow: 128_000 } };
}

test("normal notification preserves total and last with protocol provenance", () => {
  const manager = new ThreadTokenUsageManager();
  const source = new TokenUsageSource(manager);
  const result = source.receive(TOKEN_USAGE_NOTIFICATION, notice("main", "t1", 900, 900), "2026-10-30T00:00:00.000Z");
  assert.equal(result.state, "accepted");
  assert.equal(source.status, "supported");
  if (result.state !== "accepted") return;
  assert.equal(result.snapshot.totalTokens, 900);
  assert.equal(result.snapshot.lastTokens, 900);
  assert.equal(result.snapshot.confidence, "protocol_notification");
});

test("successive turns replace latest snapshot and keep total distinct from last", () => {
  const manager = new ThreadTokenUsageManager();
  manager.ingest(notice("main", "t1", 900, 900));
  manager.ingest(notice("main", "t2", 1_700, 800));
  assert.equal(manager.get("main")?.totalTokens, 1_700);
  assert.equal(manager.get("main")?.lastTokens, 800);
});

test("cached input and reasoning output are retained", () => {
  const manager = new ThreadTokenUsageManager();
  manager.ingest(notice("main", "t1", 1_000, 1_000, { cachedInputTokens: 450, reasoningOutputTokens: 77 }));
  assert.equal(manager.get("main")?.cachedInputTokens, 450);
  assert.equal(manager.get("main")?.reasoningOutputTokens, 77);
});

test("missing context window remains unknown", () => {
  const manager = new ThreadTokenUsageManager();
  const payload = notice("main", "t1", 10, 10);
  payload.tokenUsage.modelContextWindow = null;
  manager.ingest(payload);
  assert.equal(manager.get("main")?.modelContextWindow, null);
});

test("omitted numeric counters do not become zero", () => {
  const manager = new ThreadTokenUsageManager();
  const payload = notice("main", "t1", 10, 10);
  delete payload.tokenUsage.total.cachedInputTokens;
  manager.ingest(payload);
  assert.equal(manager.get("main")?.cachedInputTokens, null);
});

test("empty usage is invalid and never synthesizes zero usage", () => {
  const manager = new ThreadTokenUsageManager();
  assert.deepEqual(manager.ingest({ threadId: "main", turnId: "t1", tokenUsage: {} }), {
    state: "invalid", reason: "missing_thread_turn_or_usage",
  });
  assert.equal(manager.get("main"), undefined);
});

test("exact duplicate notification is idempotent", () => {
  const manager = new ThreadTokenUsageManager();
  const payload = notice("main", "t1", 100, 100);
  assert.equal(manager.ingest(payload).state, "accepted");
  assert.equal(manager.ingest(payload).state, "duplicate");
});

test("different threads have independent latest snapshots", () => {
  const manager = new ThreadTokenUsageManager();
  manager.ingest(notice("main", "t1", 100, 100));
  manager.ingest(notice("child", "t1", 50, 50));
  assert.equal(manager.get("main")?.totalTokens, 100);
  assert.equal(manager.get("child")?.totalTokens, 50);
});

test("main and child agent thread ids do not share counters", () => {
  const manager = new ThreadTokenUsageManager();
  manager.ingest(notice("thread-root", "turn-1", 10_000, 2_000));
  manager.ingest(notice("thread-child", "turn-1", 500, 500));
  assert.equal(manager.list().length, 2);
  assert.equal(manager.get("thread-root")?.totalTokens, 10_000);
  assert.equal(manager.get("thread-child")?.totalTokens, 500);
});

test("compaction reset is accepted as a newer absolute snapshot, not added", () => {
  const manager = new ThreadTokenUsageManager();
  manager.ingest(notice("main", "before", 60_000, 60_000));
  manager.ingest(notice("main", "after", 62_000, 3_000));
  assert.equal(manager.get("main")?.totalTokens, 62_000);
  assert.equal(manager.get("main")?.lastTokens, 3_000);
});

test("resume can restore token information from a rollout TokenCount", () => {
  const manager = new ThreadTokenUsageManager();
  const result = manager.restore(notice("main", "restored-turn", 12_000, 2_000), "2026-10-30T00:00:00Z");
  assert.equal(result.state, "accepted");
  assert.equal(manager.get("main")?.source, "rollout/token_count");
  assert.equal(manager.get("main")?.confidence, "rollout_restored");
});

test("app-server restart replay is accepted idempotently and retains the snapshot", () => {
  const manager = new ThreadTokenUsageManager();
  const payload = notice("main", "restored-turn", 12_000, 2_000);
  manager.ingest(payload);
  const restartedManager = new ThreadTokenUsageManager();
  assert.equal(restartedManager.restore(payload, "2026-10-30T00:00:00Z").state, "accepted");
  assert.equal(restartedManager.restore(payload, "2026-10-30T00:00:01Z").state, "duplicate");
  assert.equal(restartedManager.get("main")?.totalTokens, 12_000);
});

test("notification gaps recover from a later absolute total without inventing deltas", () => {
  const manager = new ThreadTokenUsageManager();
  manager.ingest(notice("main", "t1", 2_000, 2_000));
  // t2 is intentionally absent; t3's total is authoritative as supplied.
  manager.ingest(notice("main", "t3", 5_500, 1_500));
  assert.equal(manager.get("main")?.totalTokens, 5_500);
  assert.equal(manager.get("main")?.lastTokens, 1_500);
});

test("unsupported old-version notification leaves status unknown", () => {
  const source = new TokenUsageSource(new ThreadTokenUsageManager());
  assert.deepEqual(source.receive("other/notification", {}), { state: "ignored" });
  assert.equal(source.status, "unknown");
  source.markUnsupported();
  assert.equal(source.status, "unsupported");
});

test("active turn fence drops a delayed update from the preceding turn", () => {
  const manager = new ThreadTokenUsageManager();
  manager.ingest(notice("main", "t1", 100, 100));
  manager.markTurnStarted("main", "t2");
  assert.equal(manager.ingest(notice("main", "t1", 120, 20)).state, "stale_turn");
  assert.equal(manager.get("main")?.totalTokens, 100);
});

test("account usage query failures preserve unsupported, auth, permission and unknown states", () => {
  assert.equal(classifyAccountUsageReadFailure("-32601", "Method not found"), "unsupported");
  assert.equal(classifyAccountUsageReadFailure("unauthorized", ""), "authentication_required");
  assert.equal(classifyAccountUsageReadFailure("permission_denied", ""), "permission_denied");
  assert.equal(classifyAccountUsageReadFailure(undefined, undefined), "unknown");
  assert.equal(classifyAccountUsageReadFailure("transport_error", "Connection closed"), "failed");
});
