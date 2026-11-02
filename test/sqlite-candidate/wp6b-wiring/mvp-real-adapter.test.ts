import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { BridgeTaskManager } from "../../../src/manager/task-manager.js";
import { SqliteLifecycleMcpAuthority } from "../../../src/manager/sqlite-lifecycle-mcp-authority.js";
import { createBridgeServer } from "../../../src/mcp/server.js";
import { createTrustedLocalCandidateContext } from "../../../src/host/stdio.js";
import { initializeIsolatedCandidateRoot, loadLifecycleCandidateModules } from "../../../src/store/lifecycle-gate.js";

const projectRoot = process.cwd();
const compiledCandidate = path.join(projectRoot, "dist-test", "src", "sqlite-candidate", "wp6b2b1");
const sourceSchema = path.join(projectRoot, "src", "sqlite-candidate", "wp6b2b1", "schema.sql");
const candidateSchema = path.join(compiledCandidate, "schema.sql");
const workerEntryPath = path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js");

// The isolated candidate Store only accepts data roots inside the candidate
// tree, matching the established WP6 composition fixture layout.
const fixtureRoot = path.join(compiledCandidate, ".wp6-mvp-real-adapter");

test.after(() => {
  if (process.env["MVP_KEEP_FIXTURE"] === "1") return;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

interface FakeRuntimeFixture {
  readonly entrypoint: string;
  readonly requestLog: string;
  readonly taskInput: string;
  readonly builtinConfig: string;
  readonly personalConfig: string;
  readonly zcodeHomeV2: string;
}

function writeFakeRuntime(name: string, variant: "success" | "failure"): FakeRuntimeFixture {
  const root = path.join(fixtureRoot, name);
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, ".zcode", "v2"), { recursive: true });
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const requestLog = path.join(root, "requests.jsonl");
  const taskInput = path.join(root, "task-input.json");
  const report = JSON.stringify({
    summary: "synthetic MVP real-adapter report",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: false,
  });
  const finishTurn = variant === "failure"
    ? `process.stdout.write(JSON.stringify({ method: "session/event", params: { seq: 1, type: "turn.failed", payload: { error: { message: "synthetic adapter failure" } } } }) + "\\n");`
    : [
      `const task = JSON.parse(fs.readFileSync(${JSON.stringify(taskInput)}, "utf8"));`,
      `const report = ${JSON.stringify(report)}.replace("TASK_ID", task.task_id);`,
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { seq: 1, type: "turn.completed", payload: { response: report, usage: { totalTokens: 4 }, resultType: "success" } } }) + "\\n");`,
    ].join("\n");
  const script = [
    `const readline = require("node:readline");`,
    `const fs = require("node:fs");`,
    `const sessionId = "mvp-session-1";`,
    `const requestLog = ${JSON.stringify(requestLog)};`,
    `let selected = { providerId: "provider-default", modelId: "model-default" };`,
    `let turnFinished = false;`,
    `let interactionSent = false;`,
    `function snapshot() {`,
    `  return { session: { sessionId }, settings: { model: { current: selected, available: [selected, { providerId: "provider-123", modelId: "model-x" }].map((ref) => ({ ref, label: "Test Model" })) } }, runtime: { eventSeq: 0 } };`,
    `}`,
    `function finishTurn() {`,
    `  if (turnFinished) return;`,
    `  turnFinished = true;`,
    ...variant === "success" ? [`  ${finishTurn}`] : [`  ${finishTurn}`],
    `}`,
    `const input = readline.createInterface({ input: process.stdin });`,
    // Keep the fake app-server alive after stdin ends so the adapter exercises
    // its real identity-bound termination transaction and produces a receipt.
    `setInterval(() => {}, 1 << 30);`,
    `input.on("line", (line) => {`,
    `  const message = JSON.parse(line);`,
    `  fs.appendFileSync(requestLog, JSON.stringify(message) + "\\n");`,
    `  if (message.method === "session/create") {`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\\n");`,
    `  } else if (message.method === "session/setModel") {`,
    `    selected = message.params.model;`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\\n");`,
    `  } else if (message.method === "session/subscribe") {`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");`,
    `  } else if (message.method === "session/send") {`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");`,
    `    if (${variant === "success"} && !interactionSent) {`,
    `      interactionSent = true;`,
    `      for (const rpcId of ["interaction-rpc-1", "interaction-rpc-2"]) {`,
    `        process.stdout.write(JSON.stringify({ id: rpcId, method: "interaction/requestPermission", params: { requestId: "permission-1", sessionId, toolCallId: "call-1", toolName: "Bash", reason: "Run the synthetic build command", input: { command: "npm run build" }, options: [{ kind: "allow_once" }, { kind: "deny" }] } }) + "\\n");`,
    `      }`,
    `      return;`,
    `    }`,
    `    finishTurn();`,
    `  } else if (message.id === "interaction-rpc-1" || message.id === "interaction-rpc-2") {`,
    `    if (message.result && message.result.decision) finishTurn();`,
    `  } else {`,
    `    process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported" } }) + "\\n");`,
    `  }`,
    `});`,
  ].join("\n");
  writeFileSync(entrypoint, script, "utf8");
  writeFileSync(taskInput, JSON.stringify({ task_id: "TASK_ID" }), "utf8");
  writeFileSync(path.join(root, "builtin.json"), JSON.stringify({ config: { providers: [] } }), "utf8");
  const zcodeHomeV2 = path.join(root, ".zcode", "v2");
  writeFileSync(path.join(zcodeHomeV2, "provider_config.json"), JSON.stringify({
    config: { providerConfigRules: { providerRules: { "provider-default": { upstream: { type: "synthetic" } } } } },
  }), "utf8");
  return { entrypoint, requestLog, taskInput, builtinConfig: path.join(root, "builtin.json"), personalConfig: path.join(zcodeHomeV2, "provider_config.json"), zcodeHomeV2 };
}

function contentObject(result: { readonly structuredContent?: unknown; readonly isError?: boolean }, diagnostic = ""): Record<string, unknown> {
  const value = result.structuredContent;
  assert.notEqual(result.isError, true, `MCP tool returned an error: ${JSON.stringify(result)} ${diagnostic}`);
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `MCP tool must return structured content: ${JSON.stringify(result)} ${diagnostic}`);
  return value as Record<string, unknown>;
}

function syntheticTask(workspace: string, taskId: string): Record<string, unknown> {
  return {
    task_id: taskId,
    workspace,
    objective: "Complete the isolated MVP real-adapter lifecycle",
    requirements: ["synthetic only"],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: ["persist one SQLite Result"],
    test_commands: [],
  };
}

async function waitForTerminal(client: Client, taskId: string, expectedAttempt: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  const observed: string[] = [];
  while (Date.now() < deadline) {
    const status = contentObject(await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } }));
    if (observed.at(-1) !== String(status.status)) observed.push(String(status.status));
    if (["completed", "failed", "cancelled", "waiting_for_master"].includes(String(status.status)) && Number(status.attempt) === expectedAttempt) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`task ${taskId} did not reach terminal status (attempt ${expectedAttempt}); observed: ${observed.join(" -> ")}`);
}

async function waitForEvent(client: Client, taskId: string, predicate: (event: Record<string, unknown>) => boolean, description: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const page = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const events = Array.isArray(page.events) ? page.events as Array<Record<string, unknown>> : [];
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${description} was not observed for ${taskId}`);
}

async function waitForLifecycleEvent(client: Client, taskId: string, eventType: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const page = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const events = Array.isArray(page.events) ? page.events as Array<Record<string, unknown>> : [];
    if (events.some((event) => event.type === eventType)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`lifecycle event ${eventType} was not observed for ${taskId}`);
}

async function waitForInteractionRequest(client: Client, taskId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const page = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const events = Array.isArray(page.events) ? page.events as Array<Record<string, unknown>> : [];
    const request = events.find((event) => event.type === "interaction_requested");
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`interaction request was not observed for ${taskId}`);
}

async function withRealAdapterMcp(
  run: (client: Client, manager: BridgeTaskManager, dataRoot: string, workspace: string, runtime: FakeRuntimeFixture) => Promise<void>,
  options: { readonly runtimeVariant?: "success" | "failure"; readonly preserveFixtureOnFailure?: boolean; readonly stderrCollector?: { readonly lines: string[] } } = {},
): Promise<void> {
  const fixture = path.join(fixtureRoot, randomUUID());
  const dataRoot = path.join(fixture, "sqlite-root");
  const workspace = path.join(fixture, "workspace");
  const settingsDirectory = path.join(fixture, "settings");
  let successful = false;
  const runtime = writeFakeRuntime(path.basename(fixture), options.runtimeVariant ?? "success");
  try {
    mkdirSync(compiledCandidate, { recursive: true });
    if (existsSync(candidateSchema)) {
      assert.equal(readFileSync(candidateSchema, "utf8"), readFileSync(sourceSchema, "utf8"), "compiled schema must match the tested source schema");
    } else {
      copyFileSync(schema());
    }
    mkdirSync(fixtureRoot, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(settingsDirectory, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    await initializeIsolatedCandidateRoot(dataRoot);
    const modules = await loadLifecycleCandidateModules();
    const store = modules.Store.open(dataRoot);
    try {
      modules.createPort(store).provisionCapacity({
        operation_id: `capacity-${path.basename(fixture)}`,
        capacity_limit: 2,
        expected_generation: 0,
        maintenance: { dispatch_blocked: true, writers_drained: true },
      });
    } finally {
      store.close();
    }
    const previousZcodeCjs = process.env["ZCODE_BRIDGE_ZCODE_CJS"];
    const previousZcodeNode = process.env["ZCODE_BRIDGE_NODE"];
    const previousZcodeHome = process.env["ZCODE_HOME"];
    process.env["ZCODE_BRIDGE_ZCODE_CJS"] = runtime.entrypoint;
    process.env["ZCODE_BRIDGE_NODE"] = process.execPath;
    // The resolver requires ZCODE_HOME to name the .zcode directory itself.
    process.env["ZCODE_HOME"] = path.dirname(runtime.zcodeHomeV2);
    let authority: SqliteLifecycleMcpAuthority | undefined;
    try {
      authority = await SqliteLifecycleMcpAuthority.create({
        dataRoot,
        workerEntryPath,
        bridgeEntryPath: fileURLToPath(import.meta.url),
        // The Worker resolves ZCode runtime settings through the persisted
        // runtime-config.json of this Host profile. Point it at the fixture
        // settings directory so the real user's runtime config cannot steer
        // the adapter away from the controlled fake app-server.
        hostProfile: { name: "mvp-real-adapter-test", settingsDirectory },
        trustedLocalContext: createTrustedLocalCandidateContext({ name: "mvp-real-adapter-test", settingsDirectory }),
        ...(options.stderrCollector ? {
          onChildSpawn: (child: { readonly stderr?: NodeJS.ReadableStream | null }) => {
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", (chunk: string) => options.stderrCollector?.lines.push(chunk));
          },
        } : {}),
        testOnScheduler: (stage, detail) => {
          if (stage === "driver_run_returned") console.error(`[bridge-manager] ${stage} ${JSON.stringify(detail)}`);
        },
      });
      const manager = new BridgeTaskManager({ lifecycleAuthority: authority });
      const server = createBridgeServer({ taskManager: manager });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "mvp-real-adapter-test", version: "0.0.1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        await run(client, manager, dataRoot, workspace, runtime);
        successful = true;
      } finally {
        await client.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await manager.shutdown().catch(() => undefined);
      }
    } finally {
      await authority?.shutdown().catch(() => undefined);
      if (previousZcodeCjs === undefined) delete process.env["ZCODE_BRIDGE_ZCODE_CJS"]; else process.env["ZCODE_BRIDGE_ZCODE_CJS"] = previousZcodeCjs;
      if (previousZcodeNode === undefined) delete process.env["ZCODE_BRIDGE_NODE"]; else process.env["ZCODE_BRIDGE_NODE"] = previousZcodeNode;
      if (previousZcodeHome === undefined) delete process.env["ZCODE_HOME"]; else process.env["ZCODE_HOME"] = previousZcodeHome;
    }
  } finally {
    if (successful || !options.preserveFixtureOnFailure) {
      try { rmSync(fixture, { recursive: true, force: true }); } catch { /* retain fixture if Windows still holds a handle */ }
    }
  }
}

function schema(): string {
  return sourceSchema;
}

function copyFileSync(source: string): void {
  writeFileSync(candidateSchema, readFileSync(source, "utf8"), "utf8");
}

test("formal MCP lifecycle runs a real ZCodeAppServerAdapter against a controlled fake app-server", { timeout: 120_000 }, async () => {
  const stderrLines: string[] = [];
  try {
    await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
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
    } finally {
      eventsRoot.close();
    }
    }, { stderrCollector: { lines: stderrLines }, preserveFixtureOnFailure: true });
  } catch (error) {
    console.error("worker stderr:\n" + stderrLines.join("\n"));
    throw error;
  }
});

test("test-only fake adapter capability cannot be injected through MCP TaskPackage arguments", { timeout: 60_000 }, async () => {
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace) => {
    const taskId = `mvp-inject-${randomUUID()}`;
    const rejected = await client.callTool({ name: "zcode_task", arguments: { ...syntheticTask(workspace, taskId), testOnlyFakeAdapter: true } });
    assert.equal(rejected.isError, true, "the MCP TaskPackage schema must reject unknown test-adapter fields");
    const status = await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } });
    assert.equal(status.isError, true, "a rejected TaskPackage must not create any Operation; status must report TASK_NOT_FOUND");
  });
});

test("an adapter turn failure commits a failed Result without faking success", { timeout: 120_000 }, async () => {
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace) => {
    const taskId = `mvp-failed-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    assert.equal(created.status, "queued");
    const status = await waitForTerminal(client, taskId, 1);
    assert.equal(status.status, "failed", "a turn.failed payload must produce a failed Result, never a synthetic completed");
    await waitForLifecycleEvent(client, taskId, "result_committed");
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(result.status, "failed");
  }, { runtimeVariant: "failure", preserveFixtureOnFailure: true });
});
