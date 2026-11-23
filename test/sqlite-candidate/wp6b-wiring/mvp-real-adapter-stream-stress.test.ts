import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  contentObject,
  readAllPublicEvents,
  syntheticTask,
  waitForInteractionRequest,
  waitForLifecycleEvent,
  waitForTerminal,
  withRealAdapterMcp,
} from "./mvp-real-adapter-harness.js";

test("SQLite production Worker retains sustained 32,000-event AppServer streaming stderr output", {
  timeout: 180_000,
}, async () => {
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `mvp-stream-stress-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    const interaction = await waitForInteractionRequest(client, taskId);
    const request = interaction.details as Record<string, unknown>;
    contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: {
      task_id: taskId,
      request_id: String(request.request_id),
      decision: "allow",
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1, 120_000)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");

    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.match(String(result.summary), /synthetic MVP real-adapter report/u);
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.filter((message) => message.method === "session/send").length, 1);

    const { events } = await readAllPublicEvents(client, taskId);
    const output = events
      .filter((event) => event.type === "model_output")
      .map((event) => String(event.summary));
    const visible = output.join("");
    assert.ok(visible.endsWith("x".repeat(32_000)), "all 32,000 stress-streamed characters must remain ordered and durable");
    assert.ok(visible.includes("a" + "🙂".repeat(1001)), "UTF-8 event chunking must not split or replace non-BMP text");
    assert.ok(output.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 8_000));

    const evidence = JSON.parse(readFileSync(runtime.backpressureLog, "utf8")) as Record<string, number>;
    console.log("MVP_REAL_ADAPTER_STREAM_STRESS " + JSON.stringify(evidence));
    assert.equal(evidence.events_written, 32_000);
    assert.equal(evidence.delta_bytes, 1);
    assert.ok(evidence.bytes_written! > 3 * 1024 * 1024, "stress traffic must substantially exceed the ordinary pipe boundary");
    assert.equal(evidence.max_writable_length, 0,
      "the Windows synchronous pipe must remain bounded under sustained output");
    assert.ok(evidence.flood_elapsed_ms! >= 0);
  }, { runtimeVariant: "stream-flood-stress" });
});
