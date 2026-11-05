import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
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
  // A leaked fixture process (for example a fake app-server kept alive by a
  // failed cleanup verification) may still hold a handle at this point.
  // Retain the tree for OS-level cleanup instead of failing the whole suite
  // with EPERM, matching the per-fixture removal policy in the harness.
  try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* fixture retained */ }
});

interface FakeRuntimeFixture {
  readonly entrypoint: string;
  readonly requestLog: string;
  readonly exitLog: string;
  readonly taskInput: string;
  readonly builtinConfig: string;
  readonly personalConfig: string;
  readonly zcodeHomeV2: string;
}

function writeFakeRuntime(name: string, variant: "success" | "failure" | "stderr-flood" | "large-result"): FakeRuntimeFixture {
  const root = path.join(fixtureRoot, name);
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, ".zcode", "v2"), { recursive: true });
  // Resolver derives the builtin pair from <runtime>/../../config/provider;
  // make the fixture mimic the production resources/glm runtime layout.
  const entrypoint = path.join(root, "resources", "glm", "fake-app-server.cjs");
  const requestLog = path.join(root, "requests.jsonl");
  const exitLog = path.join(root, "exit.log");
  const taskInput = path.join(root, "task-input.json");
  const builtinConfig = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
  const report = JSON.stringify({
    summary: variant === "large-result" ? "中文😀\n\u0000\"".repeat(100_000) : "synthetic MVP real-adapter report",
    files_changed: variant === "large-result" ? Array.from({length:257}, (_,i)=>`文件${i}\n第二行`) : [],
    tests: variant === "large-result" ? [{command:"测试\n命令",status:"passed",details:"\u0000😀"}] : [],
    issues: variant === "large-result" ? ["多行\n"+"x".repeat(5000)] : [],
    needs_master_decision: false,
  });
  const finishTurn = variant === "failure"
    ? `process.stdout.write(JSON.stringify({ method: "session/event", params: { seq: 1, type: "turn.failed", payload: { error: { message: "synthetic adapter failure" } } } }) + "\\n");`
    : [
      `const task = JSON.parse(fs.readFileSync(${JSON.stringify(taskInput)}, "utf8"));`,
      `const report = ${JSON.stringify(report)}.replace("TASK_ID", task.task_id);`,
      ...(variant === "stderr-flood" ? [
        `for (let seq = 1; seq <= 32000; seq++) process.stdout.write(JSON.stringify({ method: "session/event", params: { seq, type: "model.streaming", payload: { kind: "text_delta", delta: "x" } } }) + "\\n");`,
      ] : []),
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { seq: ${variant === "stderr-flood" ? 32001 : 1}, type: "turn.completed", payload: { response: report, usage: { totalTokens: 4 }, resultType: "success" } } }) + "\\n");`,
    ].join("\n");
  const script = [
    `const readline = require("node:readline");`,
    `const fs = require("node:fs");`,
    `const sessionId = "mvp-session-1";`,
    `const requestLog = ${JSON.stringify(requestLog)};`,
    `const exitLog = ${JSON.stringify(exitLog)};`,
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
    // The callback and shorter interval avoid relying on an effectively empty
    // long-duration timer as the sole live-handle evidence in hosted Windows CI.
    `const keepAlive = setInterval(() => { void Date.now(); }, 1_000);`,
    `process.on("exit", (code) => { try { fs.appendFileSync(exitLog, "exit=" + String(code) + "\\n"); } catch {} });`,
    `input.on("close", () => { try { fs.appendFileSync(exitLog, "stdin_close\\n"); } catch {} });`,
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
    `    if (${variant !== "failure"} && !interactionSent) {`,
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
  mkdirSync(path.dirname(entrypoint), { recursive: true });
  writeFileSync(entrypoint, script, "utf8");
  writeFileSync(taskInput, JSON.stringify({ task_id: "TASK_ID" }), "utf8");
  mkdirSync(path.dirname(builtinConfig), { recursive: true });
  writeFileSync(builtinConfig, JSON.stringify({ config: { providers: [] } }), "utf8");
  const zcodeHomeV2 = path.join(root, ".zcode", "v2");
  writeFileSync(path.join(zcodeHomeV2, "provider_config.json"), JSON.stringify({
    config: { providerConfigRules: { providerRules: { "provider-default": { upstream: { type: "synthetic" } } } } },
  }), "utf8");
  return { entrypoint, requestLog, exitLog, taskInput, builtinConfig, personalConfig: path.join(zcodeHomeV2, "provider_config.json"), zcodeHomeV2 };
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
  options: { readonly runtimeVariant?: "success" | "failure" | "stderr-flood" | "large-result"; readonly preserveFixtureOnFailure?: boolean;
    readonly workerOverride?: string; readonly testOnlyFakeAdapter?: true;
    readonly resultFault?: "commit_ack_lost" | "after_projection";
    readonly stderrCollector?: { readonly lines: string[] }; readonly lifecycleCollector?: { readonly lines: string[] } } = {},
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
      writeFileSync(candidateSchema, readFileSync(sourceSchema, "utf8"));
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
        workerEntryPath: options.workerOverride ?? workerEntryPath,
        ...(options.testOnlyFakeAdapter ? { testOnlyFakeAdapter: true as const } : {}),
        ...(options.resultFault ? {loadModules:async()=>{
          const original=await loadLifecycleCandidateModules();
          return {...original,createPort:(raw:object,portOptions?:Readonly<Record<string,unknown>>)=>{
            const port=original.createPort(raw,portOptions);
            return {...port,commitResult:(...args:Parameters<typeof port.commitResult>)=>{
              // Inject at the real Store transaction, after Claim/Adapter.
              const faultStore=original.Store.open(dataRoot,{fault:options.resultFault});
              try{return original.createPort(faultStore).commitResult(...args);}finally{faultStore.close();}
            }};
          }};
        }} : {}),
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
        testOnScheduler: (stage, detail) => options.lifecycleCollector?.lines.push(`[bridge-manager] ${stage} ${JSON.stringify(detail)}`),
        onStage: (stage, detail) => options.lifecycleCollector?.lines.push(`[bridge-lifecycle] ${stage} ${JSON.stringify(detail ?? {})}`),
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
    if (!successful && options.lifecycleCollector?.lines.length) {
      console.error("SQLite lifecycle stages:\n" + options.lifecycleCollector.lines.join("\n"));
    }
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

test("SQLite production Worker survives streaming stderr backpressure without a diagnostic recorder", { timeout: 120_000 }, async () => {
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
  }, { runtimeVariant: "stderr-flood" });
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
    }, { stderrCollector: { lines: stderrLines }, lifecycleCollector: { lines: lifecycleLines }, preserveFixtureOnFailure: true });
  } catch (error) {
    console.error("worker stderr:\n" + stderrLines.join("\n"));
    if (fixtureRuntime && existsSync(fixtureRuntime.exitLog)) {
      console.error("fake app-server lifecycle:\n" + readFileSync(fixtureRuntime.exitLog, "utf8"));
    }
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
  const lifecycleLines: string[] = [];
  const stderrLines: string[] = [];
  let fixtureRuntime: FakeRuntimeFixture | undefined;
  try {
    await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
      fixtureRuntime = runtime;
      const taskId = `mvp-failed-${randomUUID()}`;
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
      assert.equal(created.status, "queued");
      const status = await waitForTerminal(client, taskId, 1);
      assert.equal(status.status, "failed", "a turn.failed payload must produce a failed Result, never a synthetic completed");
      await waitForLifecycleEvent(client, taskId, "result_committed");
      const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
      assert.equal(result.status, "failed");
    }, { runtimeVariant: "failure", stderrCollector: { lines: stderrLines }, lifecycleCollector: { lines: lifecycleLines }, preserveFixtureOnFailure: true });
  } catch (error) {
    console.error("worker stderr:\n" + stderrLines.join("\n"));
    if (fixtureRuntime && existsSync(fixtureRuntime.exitLog)) {
      console.error("fake app-server lifecycle:\n" + readFileSync(fixtureRuntime.exitLog, "utf8"));
    }
    throw error;
  }
});

test("ADR-026 real Adapter→Worker→Manager→SQLite preserves large Unicode reports without the old JSON text restrictions", {timeout:120_000}, async()=>{
  await withRealAdapterMcp(async(client,_manager,dataRoot,workspace,runtime)=>{
    const taskId=`r2-large-${randomUUID()}`;
    contentObject(await client.callTool({name:"zcode_task",arguments:syntheticTask(workspace,taskId)}));
    const interaction=await waitForInteractionRequest(client,taskId);
    contentObject(await client.callTool({name:"zcode_interaction_reply",arguments:{task_id:taskId,request_id:String((interaction.details as Record<string,unknown>).request_id),decision:"allow"}}));
    assert.equal((await waitForTerminal(client,taskId,1)).status,"completed");
    await waitForLifecycleEvent(client,taskId,"released");
    const result=contentObject(await client.callTool({name:"zcode_result",arguments:{task_id:taskId}}));
    assert.equal(result.summary,"中文😀\n\u0000\"".repeat(100_000));
    assert.equal((result.files_changed as unknown[]).length,257);
    assert.deepEqual(result.tests,[{command:"测试\n命令",status:"passed",details:"\u0000😀"}]);
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(path.join(dataRoot,'operations.sqlite3'),{readOnly:true});
    try{
      const row=db.prepare('SELECT result_json,length(CAST(result_json AS BLOB)) AS bytes FROM manager_operations WHERE task_id=?').get(taskId)!;
      assert.ok(Number(row.bytes)>65_536);
      assert.deepEqual(JSON.parse(String(row.result_json)),result);
    }finally{db.close();}
    const requests=readFileSync(runtime.requestLog,'utf8').trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);
    assert.equal(requests.filter(x=>x.method==='session/send').length,1);
  },{runtimeVariant:'large-result'});
});

test("ADR-026 production Worker Result encoder and Windows pipes deliver exact 32 MiB and converge +1/schema failure", {timeout:120_000}, async()=>{
  mkdirSync(fixtureRoot,{recursive:true});
  const controlledWorker=path.join(fixtureRoot,'r2-controlled-worker.mjs');
  // Only the explicitly enabled synthetic Adapter is substituted. Worker
  // bootstrap, Claim, encoding, fd6, Manager and Store are production code.
  await build({entryPoints:[path.join(projectRoot,'src/worker/worker-main.ts')],outfile:controlledWorker,
    bundle:true,platform:'node',format:'esm',target:'node22.18',packages:'external',logLevel:'silent',
    plugins:[{name:'r2-controlled-result',setup(build){build.onLoad({filter:/fake-result-adapter\.ts$/},async args=>{
      let source=readFileSync(args.path,'utf8').replace(/\r\n?/gu,'\n');
      source=`import {canonical,MAX_TASK_RESULT_BYTES} from ${JSON.stringify(path.join(projectRoot,'src/result-contract.mjs'))};\n`+source;
      source=source.replace('  return {\n    protocol:',`  if(snapshot.task_id.includes('invalid'))(result as any).tests=[{command:'x',status:'invalid'}];\n  else (result as any).zcode_output='x'.repeat(MAX_TASK_RESULT_BYTES-Buffer.byteLength(canonical({...result,zcode_output:''}))+(snapshot.task_id.includes('oversized')?1:0));\n  return {\n    protocol:`);
      return {contents:source,loader:'ts',resolveDir:path.dirname(args.path)};
    });}}]});
  for(const mode of ['exact','oversized','invalid']){
    await withRealAdapterMcp(async(client,_manager,dataRoot,workspace)=>{
      const taskId=`r2-${mode}-${randomUUID()}`;
      contentObject(await client.callTool({name:'zcode_task',arguments:syntheticTask(workspace,taskId)}));
      const terminal=await waitForTerminal(client,taskId,1);
      assert.equal(terminal.status,mode==='exact'?'completed':'failed');
      await waitForLifecycleEvent(client,taskId,'released');
      const value=contentObject(await client.callTool({name:'zcode_result',arguments:{task_id:taskId}}));
      if(mode==='exact'){
        const {canonical,MAX_TASK_RESULT_BYTES}=await import('../../../src/result-contract.mjs');
        assert.equal(Buffer.byteLength(canonical(value)),MAX_TASK_RESULT_BYTES);
        assert.match(String(value.zcode_output),/^x+$/u);
        const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(dataRoot,'operations.sqlite3'),{readOnly:true});
        try{assert.equal(db.prepare('SELECT length(CAST(result_json AS BLOB)) AS n FROM manager_operations WHERE task_id=?').get(taskId)?.n,MAX_TASK_RESULT_BYTES);}finally{db.close();}
      }else{
        assert.equal(value.error_code,mode==='oversized'?'result_too_large':'invalid_result_payload');
        assert.match(String(value.summary),/original report not committed/u);
      }
      const modules=await loadLifecycleCandidateModules();const store=modules.Store.open(dataRoot)!;
      try{
        const events=store.readTaskEvents(taskId,{afterCursor:0,limit:200});
        assert.equal(events.events.filter(e=>e.event_type==='claim_committed').length,1);
        assert.equal(events.events.filter(e=>e.event_type==='result_committed').length,1);
        assert.equal(events.events.filter(e=>e.event_type==='released').length,1);
      }finally{store.close();}
    },{workerOverride:controlledWorker,testOnlyFakeAdapter:true});
  }
});

test("ADR-026 Manager distinguishes known rollback from lost COMMIT ACK without replacing or repeating execution", {timeout:120_000},async()=>{
  for(const fault of ['after_projection','commit_ack_lost'] as const){
    const lifecycle={lines:[] as string[]};
    await withRealAdapterMcp(async(client,_manager,dataRoot,workspace)=>{
      const taskId=`r2-write-${fault}-${randomUUID()}`;
      contentObject(await client.callTool({name:'zcode_task',arguments:syntheticTask(workspace,taskId)}));
      const deadline=Date.now()+30000;
      while(!lifecycle.lines.some(line=>line.includes('run_complete'))){
        if(Date.now()>deadline)throw new Error('Result fault did not settle: '+lifecycle.lines.join('\n'));
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      const modules=await loadLifecycleCandidateModules();const store=modules.Store.openForRecovery(dataRoot)!;
      try{
        const snapshot=store.readTaskLifecycle(taskId)!;
        const op=snapshot.operation as Record<string,unknown>;
        const events=store.readTaskEvents(taskId,{afterCursor:0,limit:200}).events;
        assert.equal(events.filter(e=>e.event_type==='claim_committed').length,1);
        assert.equal(events.filter(e=>e.event_type==='released').length,0);
        const status=contentObject(await client.callTool({name:'zcode_status',arguments:{task_id:taskId}}));
        const result=await client.callTool({name:'zcode_result',arguments:{task_id:taskId}});
        if(fault==='commit_ack_lost'){
          assert.equal(op.phase,'result_committed');assert.equal(events.filter(e=>e.event_type==='result_committed').length,1);
          assert.equal(status.status,'completed');assert.equal(contentObject(result).summary,'Synthetic WP6C FakeAdapter result');
          assert.ok(existsSync(path.join(dataRoot,'WRITER_INTENT.json')));assert.ok(existsSync(path.join(dataRoot,'ROOT_POISONED.json')));
          assert.ok(lifecycle.lines.some(line=>line.includes('result_outcome_reconciled_read_only')));
        }else{
          assert.equal(op.phase,'running');assert.equal(snapshot.result,null);assert.equal(status.error_code,'injected_failure');
          assert.equal(result.isError,true);assert.ok(!existsSync(path.join(dataRoot,'ROOT_POISONED.json')));
          assert.equal(events.filter(e=>e.event_type==='result_committed').length,0);
        }
        assert.equal(lifecycle.lines.filter(line=>line.includes('spawn_bootstrap_start')).length,1);
      }finally{store.close();}
    },{testOnlyFakeAdapter:true,resultFault:fault,lifecycleCollector:lifecycle});
  }
});
