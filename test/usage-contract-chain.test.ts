import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createCandidateWorkerRuntimeEventChannel } from "../src/sqlite-candidate/wp6b2b1/runtime-event-channel.mjs";
import { canonicalTaskResult } from "../src/result-contract.mjs";
import { normalizeUsage } from "../src/usage/normalize.js";
import { taskResultSchema } from "../src/mcp/schemas.js";
import { IsolatedAdmissionStore } from "../src/sqlite-candidate/wp6b2b1/store.mjs";
import { fixture, result, running } from "./sqlite-v14-fixture.mjs";

test("official cache Usage survives Runtime Event, normalization, SQLite Result and MCP schema", async () => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const channel = await createCandidateWorkerRuntimeEventChannel({ writeStream: stream });
  const officialUsage = {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    source: "official_runtime",
    scope: "session:sess-cache",
    observed_at: "2026-11-15T10:00:00.000Z",
    finality: "reported",
    conflicts: ["safe_conflict"],
  };
  channel.send({ type: "turn_completed", summary: "Turn complete", details: { usage: officialUsage } });
  await channel.close();

  const frame = JSON.parse(Buffer.concat(chunks).toString("utf8").trim()) as {
    details: { usage: Record<string, unknown> };
  };
  assert.deepEqual(frame.details.usage, officialUsage);

  const usage = normalizeUsage(frame.details.usage);
  assert.ok(usage);
  assert.equal(usage.cached_input_tokens, 40);
  assert.equal(usage.cached_write_input_tokens, 0);
  assert.equal(usage.total_tokens, 120);
  assert.equal(usage.source, "official_runtime");
  assert.equal(usage.scope, "session:sess-cache");
  assert.equal(usage.observed_at, "2026-11-15T10:00:00.000Z");
  assert.equal(usage.finality, "partial", "a reported conflict downgrades finality without discarding its original marker");
  assert.deepEqual(usage.conflicts, ["safe_conflict"]);

  const value = { ...result("cache-usage-v14"), usage };
  const canonical = canonicalTaskResult(value, {
    task_id: value.task_id,
    attempt: value.attempt,
    result_status: value.status,
  });
  assert.equal(JSON.parse(canonical).usage.cached_write_input_tokens, 0);
  assert.doesNotThrow(() => taskResultSchema.parse(value));
  assert.throws(
    () => canonicalTaskResult(
      { ...value, usage: { ...usage, unexpected_cache_counter: 1 } },
      { task_id: value.task_id, attempt: value.attempt, result_status: value.status },
    ),
    (error: unknown) => (error as { code?: string }).code === "invalid_result_payload",
  );

  const root = fixture("cache-usage-v14");
  const { store, fence } = running(root, value.task_id);
  try {
    store.commitResult({ ...fence, result_status: "completed", result: value });
  } finally {
    store.close();
  }
  const reopened = IsolatedAdmissionStore.openForRecovery(root, { managedDataDirectory: true });
  assert.ok(reopened);
  try {
    const persisted = reopened.readTaskLifecycle(value.task_id).result;
    assert.deepEqual(persisted.usage, usage);
  } finally {
    reopened.close();
  }
});
