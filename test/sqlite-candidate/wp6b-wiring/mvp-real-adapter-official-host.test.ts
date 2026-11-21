import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { loadLifecycleCandidateModules } from "../../../src/store/lifecycle-gate.js";

import { officialHostWorkerEntryPath, officialHostCloseFailureWorkerEntryPath, officialHostStartPlanNoDiscountWorkerEntryPath, contentObject, syntheticTask, waitForTerminal, waitForEvent, waitForLifecycleEvent, waitForInteractionRequest, withRealAdapterMcp, HOST_ACCOUNT, HOST_DEVICE_MID, HOST_JWT, fakeHostBillingGate, hostIssuerFactory } from "./mvp-real-adapter-harness.js";
import type { FakeRuntimeFixture, LifecycleTimingCollector } from "./mvp-real-adapter-harness.js";

test("Worker routes an explicit Coding Plan through the installed AppServer adapter, SQLite Result, Cleanup, and Release", {
  timeout: 120_000,
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async () => {
  const diagnostics = { lines: [] as string[] };
  const workerStderr = { lines: [] as string[] };
  await withRealAdapterMcp(async (client, manager, _dataRoot, workspace) => {
    const taskId = `official-host-worker-${randomUUID()}`;
    const created = contentObject(await client.callTool({
      name: "zcode_task",
      arguments: {
        ...syntheticTask(workspace, taskId),
        model: { provider_id: "account:bigmodel-individual-coding-plan", model_id: "GLM-5.3-Flash" },
      },
    }));
    assert.equal(created.status, "queued");
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const result = contentObject(await client.callTool({
      name: "zcode_result",
      arguments: { task_id: taskId },
    }));
    assert.equal(result.status, "completed");
    assert.equal(result.summary, "Official Host loopback completed the Worker task");
    assert.match(String(result.session_id), /^sess_worker_loopback_/u);

    const cleanup = await waitForEvent(
      client,
      taskId,
      (event) => event.type === "cleanup_verified",
      "verified Cleanup",
    );
    const details = cleanup.details as Record<string, unknown>;
    const adapterCleanup = details.adapter_cleanup as Record<string, unknown>;
    assert.equal(adapterCleanup.contract, "adapter-cleanup-v1");
    assert.deepEqual(adapterCleanup.close, {
      status: "resolved",
      stage: "official_manager_dispose",
      managerProcessCountAfter: 0,
      treeScanStatus: "verified",
    });
    assert.equal(adapterCleanup.treeScanStatus, "verified");
    assert.ok(
      workerStderr.lines.join("").includes("[bridge-worker] adapter event=official_runtime_verified"),
      "Coding Plan must enter OfficialAppServerWorkerAdapter",
    );
    assert.ok(
      diagnostics.lines.some((line) => line.includes("[bridge-worker] installed-runtime")
        && line.includes("a".repeat(64))),
      "Coding Plan must report the installed AppServer runtime identity",
    );
    await manager.shutdown();
  }, {
    workerOverride: officialHostWorkerEntryPath,
    workerDiagnosticCollector: diagnostics,
    stderrCollector: workerStderr,
  });
});

test("Worker Cleanup keeps a rejected official close visible when its independent scan is clean", {
  timeout: 120_000,
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async () => {
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace) => {
    const taskId = `official-host-close-failure-${randomUUID()}`;
    contentObject(await client.callTool({
      name: "zcode_task",
      arguments: syntheticTask(workspace, taskId),
    }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const cleanup = await waitForEvent(
      client,
      taskId,
      (event) => event.type === "cleanup_verified",
      "Cleanup despite close rejection",
    );
    const adapterCleanup = (cleanup.details as Record<string, unknown>).adapter_cleanup as Record<string, unknown>;
    assert.deepEqual(adapterCleanup.close, {
      status: "rejected",
      stage: "official_manager_workspace_dispose",
      errorName: "Error",
      errorCode: "E_SYNTHETIC_CLOSE",
      managerProcessCountAfter: 0,
      treeScanStatus: "verified",
    });
    assert.equal(adapterCleanup.treeScanStatus, "verified");
    assert.equal(JSON.stringify(cleanup).includes("synthetic official manager close failure"), false,
      "arbitrary close error text must not be persisted");
  }, { workerOverride: officialHostCloseFailureWorkerEntryPath });
});

test("SQLite production Worker survives bounded large-chunk stderr backpressure without a diagnostic recorder", { timeout: 120_000 }, async () => {
  const lifecycleTimings: LifecycleTimingCollector = { records: [] };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `mvp-stderr-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    const interaction = await waitForInteractionRequest(client, taskId);
    const request = interaction.details as Record<string, unknown>;
    contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: {
      task_id: taskId, request_id: String(request.request_id), decision: "allow",
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.match(String(result.summary), /synthetic MVP real-adapter report/u);
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.filter((message) => message.method === "session/send").length, 1);
    const page = contentObject(await client.callTool({ name: "zcode_events", arguments: {
      task_id: taskId, after_seq: 0, limit: 200,
    } }));
    const output = (page.events as Array<Record<string, unknown>>)
      .filter((event) => event.type === "model_output")
      .map((event) => String(event.summary));
    const visible = output.join("");
    assert.ok(visible.endsWith("x".repeat(8 * 32 * 1024)), "all streamed characters must remain ordered and durable");
    assert.ok(visible.includes("a" + "🙂".repeat(1001)), "UTF-8 event chunking must not split or replace non-BMP text");
    assert.ok(visible.includes("Synthetic visible output before tool use."));
    assert.ok(output.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 8_000));
    const backpressure = JSON.parse(readFileSync(runtime.backpressureLog, "utf8")) as Record<string, number>;
    if (process.env["MVP_REAL_ADAPTER_TIMINGS"] === "1") {
      console.error("MVP_REAL_ADAPTER_BACKPRESSURE " + JSON.stringify(backpressure));
    }
    assert.equal(backpressure.events_written, 8);
    assert.equal(backpressure.delta_bytes, 32 * 1024);
    assert.ok(backpressure.bytes_written! > 256 * 1024
      && backpressure.bytes_written! > backpressure.high_water_mark! * 8,
    "the bounded stream must substantially exceed the Windows pipe high-water mark");
    assert.ok(backpressure.flood_elapsed_ms! >= 0);
    assert.equal(backpressure.max_writable_length, 0,
      "the Windows synchronous pipe must not accumulate an unbounded JavaScript write queue");
    assert.ok(Number.isSafeInteger(backpressure.write_false_count));
  }, { runtimeVariant: "stderr-flood", lifecycleTimings });
});

test("formal MCP lifecycle runs a real ZCodeAppServerAdapter against a controlled fake app-server", { timeout: 120_000 }, async () => {
  const stderrLines: string[] = [];
  const lifecycleLines: string[] = [];
  let fixtureRuntime: FakeRuntimeFixture | undefined;
  try {
    await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
      fixtureRuntime = runtime;
      const taskId = `mvp-real-${randomUUID()}`;
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
      assert.equal(created.task_id, taskId);
      assert.equal(created.status, "queued");

    const interaction = await waitForInteractionRequest(client, taskId);
    assert.ok(interaction, "the real Adapter must surface the app-server permission request through MCP events");
    const request = interaction.details as Record<string, unknown>;
    const requestId = String(request.request_id ?? (request.payload as Record<string, unknown> | undefined)?.request_id ?? "permission-1");
    await client.callTool({ name: "zcode_interaction_reply", arguments: { task_id: taskId, request_id: requestId, decision: "allow" } });

    const status = await waitForTerminal(client, taskId, 1);
    assert.equal(status.status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(result.status, "completed");
    assert.ok(String(result.summary).includes("synthetic MVP real-adapter report"), `Result must come from the real Adapter response: ${JSON.stringify(result)}`);
    assert.equal((result.usage as Record<string, unknown>).total_tokens, 4);
    assert.equal((result.model as Record<string, unknown>).provider_id, "provider-default");
    assert.equal((result.model as Record<string, unknown>).model_id, "model-default");
    assert.ok(Number.isSafeInteger((result.timing as Record<string, unknown>).wall_ms));

    const runtimeEvents = contentObject(await client.callTool({
      name: "zcode_events",
      arguments: { task_id: taskId, after_seq: 0, limit: 200 },
    })).events as Array<Record<string, unknown>>;
    const runtimeTypes = runtimeEvents
      .filter((event) => [
        "session_ready", "model_selected", "turn_started", "model_tool_call",
        "tool_status", "model_output", "turn_completed", "report_ready",
      ].includes(String(event.type)))
      .map((event) => String(event.type));
    for (const type of ["session_ready", "model_selected", "turn_started",
      "model_output", "model_tool_call", "tool_status", "turn_completed", "report_ready"]) {
      assert.ok(runtimeTypes.includes(type), `missing persisted runtime event ${type}`);
    }
    assert.ok(runtimeEvents.some((event) => event.type === "model_output"
      && String(event.summary).includes("Synthetic visible output before tool use.")));

    const feedback = contentObject(await client.callTool({
      name: "zcode_feedback",
      arguments: { task_id: taskId },
    }));
    assert.deepEqual(feedback.model, {
      provider_id: "provider-default",
      model_id: "model-default",
      reasoning_level: null,
      source: "runtime",
    });
    assert.equal((feedback.activity as Record<string, unknown>).kind, "tool_update");
    assert.ok(String((feedback.activity as Record<string, unknown>).summary).includes("Bash"));
    assert.equal((feedback.result as Record<string, unknown>).source, "agent_report");

    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(requests.some((message) => message.method === "session/create"), "the real Adapter must start an app-server session");
    assert.ok(requests.some((message) => message.method === "session/send"), "the real Adapter must send the task turn");
    assert.ok(requests.some((message) => message.id === "interaction-rpc-1" && (message.result as Record<string, unknown> | undefined)?.decision === "allow"),
      "the MCP interaction reply must reach the app-server through the real Adapter");

    const modules = await loadLifecycleCandidateModules();
    const eventsRoot = modules.Store.openForRecovery(_dataRoot);
    assert.ok(eventsRoot);
    try {
      const operationId = `sqlite-${createHash("sha256").update(`${taskId}\0${1}`, "utf8").digest("hex").slice(0, 32)}`;
      const lifecycle = modules.createPort(eventsRoot).readLifecycleEvents(operationId);
      assert.equal(lifecycle.filter((event) => event.event_type === "result_committed").length, 1);
      assert.equal(lifecycle.filter((event) => event.event_type === "claim_committed").length, 1);
      assert.equal(lifecycle.filter((event) => event.event_type === "launch_intent").length, 1, "the real Adapter path must Spawn exactly once");
      const persistedRuntime = eventsRoot.readTaskEvents(taskId, { afterCursor: 0, limit: 200 }).events;
      assert.ok(persistedRuntime.some((event) => event.event_type === "report_ready"),
        "report_ready must be drained before Result commit and remain readable after Worker exit");
    } finally {
      eventsRoot.close();
    }
    }, { stderrCollector: { lines: stderrLines }, lifecycleCollector: { lines: lifecycleLines }, preserveFixtureOnFailure: true });
  } catch (error) {
    console.error("worker stderr:\n" + stderrLines.join("\n"));
    if (fixtureRuntime && existsSync(fixtureRuntime.exitLog)) {
      console.error("fake app-server lifecycle:\n" + readFileSync(fixtureRuntime.exitLog, "utf8"));
    }
    throw error;
  }
});

test("startBridge's host issuer wiring reaches the fake Billing gate and completes a Start Plan task", { timeout: 120_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `host-wired-success-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    // The private-auth fixture path never surfaces a permission interaction;
    // the app-server's runtime-headers RPC is the credential delivery point.
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.deepEqual(gate.checks.map(({ account, provider, model, deviceMid }) => ({ account, provider, model, deviceMid })), [
      { account: HOST_ACCOUNT, provider: "account:bigmodel-start-plan", model: "GLM-5.3-Flash", deviceMid: HOST_DEVICE_MID },
    ]);
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(requests.some((message) => message.method === "session/create"), "Billing success must reach Provider registration and session creation");
    assert.ok(requests.some((message) => message.method === "session/send"), "Billing success must reach the Worker turn");
    assert.ok(requests.some((message) => (message as { auth_applied?: boolean }).auth_applied === true), "the private lease must be delivered after Billing success");
    assert.equal(JSON.stringify(requests).includes(HOST_JWT), false, "the delivered credential must never appear in the app-server request log");
  }, { runtimeVariant: "private-auth", issuerFactory: hostIssuerFactory(gate.entitlement), preserveFixtureOnFailure: true });
});

test("Start Plan Worker routing enters the installed AppServer adapter", { timeout: 120_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const diagnostics = { lines: [] as string[] };
  const workerStderr = { lines: [] as string[] };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace) => {
    const taskId = `start-plan-installed-route-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId),
      model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline
      && !diagnostics.lines.some((line) => line.includes("[bridge-worker] installed-runtime"))) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      workerStderr.lines.join("").includes("[bridge-worker] adapter event=official_runtime_verified"),
      "Start Plan must enter OfficialAppServerWorkerAdapter, not the packaged Specialized Host adapter",
    );
    assert.ok(
      diagnostics.lines.some((line) => line.includes("[bridge-worker] installed-runtime")
        && line.includes("a".repeat(64))),
      "Start Plan must report the installed AppServer runtime identity without a Coding Plan discount verdict",
    );
  }, {
    runtimeVariant: "private-auth",
    issuerFactory: hostIssuerFactory(gate.entitlement),
    workerOverride: officialHostStartPlanNoDiscountWorkerEntryPath,
    workerDiagnosticCollector: diagnostics,
    stderrCollector: workerStderr,
    preserveFixtureOnFailure: true,
  });
});
