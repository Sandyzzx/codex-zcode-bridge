import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash, createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ClaimOnlyWorkerProcess } from "../../../src/manager/spawn-worker.js";
import { build } from "esbuild";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SqliteLifecycleMcpAuthority } from "../../../src/manager/sqlite-lifecycle-mcp-authority.js";
import { createBridgeServer } from "../../../src/mcp/server.js";
import { createTrustedLocalCandidateContext, createHostStartPlanIssuer } from "../../../src/host/stdio.js";
import type { BridgeHostProfile } from "../../../src/host/profile.js";
import type { ProductionAuthIssuer, StartPlanLiveEntitlement } from "../../../src/runtime/start-plan-production-auth.js";
import { initializeIsolatedCandidateRoot, loadLifecycleCandidateModules } from "../../../src/store/lifecycle-gate.js";
import { PrivateCredentialLease } from "../../../src/runtime/start-plan-private-lease.js";
import { createPlatformProbe } from "../../../src/runtime/process-probe.js";
import {
  createTaskModelRouter,
  readStartPlanRoutingRegistry,
  StartPlanEntitlementJournal,
} from "../../../src/runtime/model-routing.js";

const projectRoot = process.cwd();
const compiledCandidate = path.join(projectRoot, "dist-test", "src", "sqlite-candidate", "wp6b2b1");
const sourceSchema = path.join(projectRoot, "src", "sqlite-candidate", "wp6b2b1", "schema.sql");
const candidateSchema = path.join(compiledCandidate, "schema.sql");
const workerEntryPath = path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js");

// The isolated candidate Store only accepts data roots inside the candidate
// tree, matching the established WP6 composition fixture layout.
// Each test process owns only its own tree; parallel invocations and retained
// failed fixtures must never be removed by another invocation's after hook.
const fixtureRoot = path.join(compiledCandidate, `.wp6-mvp-real-adapter-${process.pid}-${randomUUID()}`);
let preserveFailedFixture = false;

test.after(() => {
  if (process.env["MVP_KEEP_FIXTURE"] === "1" || preserveFailedFixture) return;
  // A leaked fixture process (for example a fake app-server kept alive by a
  // failed cleanup verification) may still hold a handle at this point.
  // Retain the tree for OS-level cleanup instead of failing the whole suite
  // with EPERM, matching the per-fixture removal policy in the harness.
  try { rmSync(fixtureRoot, { recursive: true, force: true }); } catch { /* fixture retained */ }
});

interface FakeRuntimeFixture {
  readonly entrypoint: string;
  readonly runtimeRoot: string;
  readonly requestLog: string;
  readonly exitLog: string;
  readonly taskInput: string;
  readonly builtinConfig: string;
  readonly personalConfig: string;
  readonly zcodeHomeV2: string;
}

type RuntimeVariant = "success" | "failure" | "stderr-flood" | "large-result" | "deadline-success" | "deadline-hang"
  | "facts-turn-failure"
  | "private-auth" | "private-auth-echo" | "private-auth-wrong-turn" | "private-auth-wrong-claim"
  | "private-auth-account-switch" | "private-auth-hold" | "private-auth-eof-recheck" | "private-auth-interaction"
  | "private-auth-preflight-reject";
function writeFakeRuntime(name: string, variant: RuntimeVariant): FakeRuntimeFixture {
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
    : variant === "facts-turn-failure"
    ? `process.stdout.write(JSON.stringify({ method: "session/event", params: { seq: 1, type: "turn.failed", payload: { error: { code: "model_request_failed", type: "model_error", message: "SENTINEL_FF_MESSAGE provider rejected the turn", attribution: { providerErrorCode: "3007", statusCode: 429, retryable: false } } } } }) + "\\n");`
    : [
      `const task = JSON.parse(fs.readFileSync(${JSON.stringify(taskInput)}, "utf8"));`,
      `const report = ${JSON.stringify(report)}.replace("TASK_ID", task.task_id)${variant === "private-auth-echo" ? '.replace("synthetic MVP real-adapter report", "echo " + receivedCredential)' : ''};`,
      ...(variant === "stderr-flood" ? [
        `for (let seq = 1; seq <= 32000; seq++) process.stdout.write(JSON.stringify({ method: "session/event", params: { seq, type: "model.streaming", payload: { kind: "text_delta", delta: "x" } } }) + "\\n");`,
      ] : []),
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { seq: ${variant.startsWith("private-auth") ? 2 : variant === "stderr-flood" ? 32001 : 1}, ${variant.startsWith("private-auth") ? 'sessionId, turnId: "native-fixture-turn",' : ''} type: "turn.completed", payload: { response: report, usage: { totalTokens: 4 }, resultType: "success" } } }) + "\\n");`,
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
    `let receivedCredential = null;`,
    `function snapshot() {`,
    `  return { session: { sessionId }, settings: { model: { current: selected, available: [selected, { providerId: "provider-123", modelId: "model-x" }].map((ref) => ({ ref, label: "Test Model" })) } }, runtime: { eventSeq: 0 } };`,
    `}`,
    `function finishTurn() {`,
    `  if (turnFinished) return;`,
    `  turnFinished = true;`,
    `  ${finishTurn}`,
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
    `  if (message.id !== "private-auth-rpc" && message.id !== "private-auth-recheck") fs.appendFileSync(requestLog, JSON.stringify(message) + "\\n");`,
    `  if (message.method === "provider/updateAccountConfig") {`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");`,
    `  } else if (message.method === "session/create" || message.method === "session/resume") {`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\\n");`,
    `  } else if (message.method === "session/setModel") {`,
    `    selected = message.params.model;`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\\n");`,
    `  } else if (message.method === "session/setMode") {`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\\n");`,
    `  } else if (message.method === "session/subscribe") {`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");`,
    `  } else if (message.method === "session/send") {`,
    `    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");`,
    ...(variant.startsWith("private-auth") ? [
      `    process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 1, turnId: "native-fixture-turn", type: "turn.started", payload: { turnId: "native-fixture-turn" } } }) + "\\n");`,
      `    process.stdout.write(JSON.stringify({ id: "private-auth-rpc", method: "interaction/requestProviderRuntimeHeaders", params: { sessionId, turnId: ${JSON.stringify(variant === "private-auth-wrong-turn" ? "other-turn" : "native-fixture-turn")}, modelSelection: selected } }) + "\\n");`,
      `    return;`,
    ] : []),
    `    if (${variant === "deadline-hang"}) return;`,
    `    if (${variant !== "failure" && variant !== "facts-turn-failure" && !variant.startsWith("deadline-")} && !interactionSent) {`,
    `      interactionSent = true;`,
    `      for (const rpcId of ["interaction-rpc-1", "interaction-rpc-2"]) {`,
    `        process.stdout.write(JSON.stringify({ id: rpcId, method: "interaction/requestPermission", params: { requestId: "permission-1", sessionId, toolCallId: "call-1", toolName: "Bash", reason: "Run the synthetic build command", input: { command: "npm run build" }, options: [{ kind: "allow_once" }, { kind: "deny" }] } }) + "\\n");`,
    `      }`,
    `      return;`,
    `    }`,
    `    finishTurn();`,
    `  } else if (message.id === "private-auth-rpc") {`,
    `    receivedCredential = message.result?.requestAuth?.apiKey;`,
    `    fs.appendFileSync(requestLog, JSON.stringify({ auth_applied: message.result?.headersApplied === true && typeof receivedCredential === "string" && receivedCredential.length > 0 }) + "\\n");`,
    `    if (message.result?.headersApplied === true && typeof receivedCredential === "string" && receivedCredential.length > 0) ${variant === "private-auth-hold" || variant === "private-auth-eof-recheck" ? '{}' : variant === "private-auth-interaction" ? '{ process.stdout.write(JSON.stringify({ id: "interaction-rpc-1", method: "interaction/requestPermission", params: { requestId: "permission-1", sessionId, toolCallId: "call-1", toolName: "Bash", reason: "echo " + receivedCredential, input: { command: "echo " + receivedCredential }, options: [{ kind: "allow_once" }, { kind: "deny" }] } }) + "\\n"); }' : 'finishTurn();'}`,
    ...(variant === "private-auth-eof-recheck" ? [`    if (message.result?.headersApplied === true) { const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(path.join(root, "recheck-trigger"))})) return; clearInterval(timer); process.stdout.write(JSON.stringify({ id: "private-auth-recheck", method: "interaction/requestProviderRuntimeHeaders", params: { sessionId, turnId: "native-fixture-turn", modelSelection: selected } }) + "\\n"); }, 20); }`] : []),
    `    else process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 2, turnId: "native-fixture-turn", type: "turn.failed", payload: { error: { message: "synthetic private auth rejected" } } } }) + "\\n");`,
    `  } else if (message.id === "private-auth-recheck") {`,
    `    fs.appendFileSync(requestLog, JSON.stringify({ recheck_auth_applied: message.result?.headersApplied === true }) + "\\n");`,
    `    process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 2, turnId: "native-fixture-turn", type: "turn.failed", payload: { error: { message: "synthetic recheck complete" } } } }) + "\\n");`,
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
  writeFileSync(builtinConfig, JSON.stringify({
    config: {
      providers: [],
      providerConfigRules: { providerRules: [{
        providerId: "account:bigmodel-start-plan",
        config: { builtinModelIds: ["GLM-5.3-Flash"], access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" } },
        // ADR-031 fallback target: a coding plan provider advertising the
        // same official model id in the fixture registry.
      }, {
        providerId: "builtin:bigmodel-coding-plan",
        config: { builtinModelIds: ["GLM-5.3-Flash"], access: { type: "api-key", mode: "individual-coding-plan" } },
      }] },
    },
  }), "utf8");
  const zcodeHomeV2 = path.join(root, ".zcode", "v2");
  writeFileSync(path.join(zcodeHomeV2, "provider_config.json"), JSON.stringify({
    config: { providerConfigRules: { providerRules: { "provider-default": { upstream: { type: "synthetic" } } } } },
  }), "utf8");
  return { entrypoint, runtimeRoot: root, requestLog, exitLog, taskInput, builtinConfig, personalConfig: path.join(zcodeHomeV2, "provider_config.json"), zcodeHomeV2 };
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
  run: (client: Client, manager: SqliteLifecycleMcpAuthority, dataRoot: string, workspace: string, runtime: FakeRuntimeFixture) => Promise<void>,
  options: { readonly runtimeVariant?: RuntimeVariant; readonly preserveFixtureOnFailure?: boolean;
    readonly stderrCollector?: { readonly lines: string[] }; readonly lifecycleCollector?: { readonly lines: string[] };
    readonly onWorkerSpawn?: (child: ChildProcess) => void; readonly issueCount?: { count: number };
    readonly issueOverride?: (binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding) => PrivateCredentialLease | Promise<PrivateCredentialLease>;
    readonly workerOverride?: string; readonly testOnlyFakeAdapter?: true;
  /** Builds the Start Plan issuer exactly like the production stdio host
   * does (createHostStartPlanIssuer); when absent the legacy synthetic
   * issuer object is used. */
  readonly issuerFactory?: (runtime: FakeRuntimeFixture, host: BridgeHostProfile) => Promise<ProductionAuthIssuer | null>;
  /** ADR-031 per-dispatch issuer discovery: consulted by the gate on every
   * Start Plan launch so login/logout/account switches are observed without
   * recreating the Authority. */
  readonly startPlanIssuerPerDispatch?: (runtime: FakeRuntimeFixture, host: BridgeHostProfile) => Promise<ProductionAuthIssuer | null>;
  /** ADR-031 task-creation routing hooks: builds the production router over
   * the fixture's official provider registry. */
  readonly routingHooks?: { readonly journal: StartPlanEntitlementJournal; readonly preferStartPlan?: boolean; readonly defaultProviderId?: string };
  /** Captures the Worker stderr lines forwarded by the production
   * onWorkerDiagnosticLine wiring (ADR-011 failure-facts marker only). */
  readonly workerDiagnosticCollector?: { readonly lines: string[] };
    readonly resultWaitMs?: number; readonly workerCloseWaitMs?: number;
    readonly resultFault?: "commit_ack_lost" | "after_projection";
    readonly onDriverRunReturned?: (detail: Record<string, unknown>) => void } = {},
): Promise<void> {
  const fixture = path.join(fixtureRoot, randomUUID());
  const dataRoot = path.join(fixture, "sqlite-root");
  const workspace = path.join(fixture, "workspace");
  const settingsDirectory = path.join(fixture, "settings");
  let successful = false;
  let authorityShutdownError: unknown;
  let runOrCloseFailure: unknown;
  const runtime = writeFakeRuntime(path.basename(fixture), options.runtimeVariant ?? "success");
  const hostProfile: BridgeHostProfile = { name: "mvp-real-adapter-test", settingsDirectory };
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
    const previousBuiltinConfig = process.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"];
    const previousPersonalConfig = process.env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"];
    process.env["ZCODE_BRIDGE_ZCODE_CJS"] = runtime.entrypoint;
    process.env["ZCODE_BRIDGE_NODE"] = process.execPath;
    process.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = runtime.builtinConfig;
    process.env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"] = runtime.personalConfig;
    // The resolver requires ZCODE_HOME to name the .zcode directory itself.
    process.env["ZCODE_HOME"] = path.dirname(runtime.zcodeHomeV2);
    const hostIssuer = options.issuerFactory ? (await options.issuerFactory(runtime, hostProfile)) ?? undefined : undefined;
    if (options.issuerFactory && options.runtimeVariant?.startsWith("private-auth")) {
      assert.ok(hostIssuer, "the host issuer factory must produce an issuer for Start Plan variants");
    }
    let authority: SqliteLifecycleMcpAuthority | undefined;
    try {
      const accountController = new AbortController();
      authority = await SqliteLifecycleMcpAuthority.create({
        dataRoot,
        workerEntryPath: options.workerOverride ?? workerEntryPath,
        ...(options.resultWaitMs ? {testResultWaitMs:options.resultWaitMs} : {}),
        ...(options.workerCloseWaitMs ? {testWorkerCloseWaitMs:options.workerCloseWaitMs} : {}),
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
        hostProfile,
        trustedLocalContext: createTrustedLocalCandidateContext(hostProfile),
        ...(options.workerDiagnosticCollector ? {
          onWorkerDiagnosticLine: (line: string) => { options.workerDiagnosticCollector!.lines.push(line); },
        } : {}),
        ...(options.routingHooks ? { routeTaskModel: createTaskModelRouter({
          settings: () => ({ preferStartPlan: options.routingHooks!.preferStartPlan ?? true, defaultProviderId: options.routingHooks!.defaultProviderId ?? "" }),
          journal: options.routingHooks.journal,
          registry: async () => readStartPlanRoutingRegistry({ providerBuiltinConfigFile: runtime.builtinConfig, providerPersonalConfigFile: runtime.personalConfig }),
        }) } : {}),
        ...(options.runtimeVariant?.startsWith("private-auth") ? (options.startPlanIssuerPerDispatch
          ? { startPlanPrivateAuthFactory: async () => await options.startPlanIssuerPerDispatch!(runtime, hostProfile) ?? null }
          : { startPlanPrivateAuth: options.issuerFactory ? hostIssuer! : {
          account: "synthetic-account",
          signal: accountController.signal,
          prepare: async () => options.runtimeVariant !== "private-auth-preflight-reject",
          issue: async (binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding, signal: AbortSignal) => {
            if (signal.aborted) throw new Error("cancelled");
            if (options.issueCount) options.issueCount.count++;
            // Synthetic live entitlement outcome; no network or real account.
            if (options.runtimeVariant === "private-auth-account-switch") accountController.abort();
            const actualBinding = options.runtimeVariant === "private-auth-wrong-claim" ? { ...binding, claim: "other-claim" } : binding;
            return options.issueOverride?.(actualBinding) ?? new PrivateCredentialLease(actualBinding, "SYNTHETIC_GATE2_SECRET_93d9422b", Date.now() + 30_000);
          },
        } } ) : {}),
        ...(options.stderrCollector || options.onWorkerSpawn ? {
          onChildSpawn: (child: ChildProcess) => {
            options.onWorkerSpawn?.(child);
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", (chunk: string) => options.stderrCollector?.lines.push(chunk));
          },
        } : {}),
        // Controlled fake kernel-handle transaction: the gate's identity
        // contract (hold → exact ticks → alive from the same handle) runs for
        // real, while Ubuntu CI has no Win32 handles to hold.
        ...(options.runtimeVariant?.startsWith("private-auth") ? { startPlanPrivateAuthHandleTransaction: async (pid: number, expectedTicks: string) => ({
          enumerate: async () => [] as never[],
          hold: async ([held]: readonly number[]) => held === pid
            ? [{ pid: held, status: "ok" as const, creationFileTime: `${expectedTicks}0`, creationTicks: expectedTicks }]
            : [{ pid: held!, status: "absent" as const, error: 87 }],
          kill: async () => ({ status: "error" as const, exitFileTime: null, detail: "fake gate never kills" }),
          alive: async (held: number) => held === pid
            ? { status: "alive" as const, creationFileTime: `${expectedTicks}0`, exitFileTime: null }
            : { status: "not_held" as const, creationFileTime: null, exitFileTime: null, error: 0 },
          close: async () => undefined,
        }) } : {}),
        testOnScheduler: (stage, detail) => {
          if (stage === "driver_run_returned") { console.error(`[bridge-manager] ${stage} ${JSON.stringify(detail)}`); options.onDriverRunReturned?.(detail as Record<string, unknown>); }
          options.lifecycleCollector?.lines.push(`[bridge-manager] ${stage} ${JSON.stringify(detail)}`);
        },
        onStage: (stage, detail) => options.lifecycleCollector?.lines.push(`[bridge-lifecycle] ${stage} ${JSON.stringify(detail ?? {})}`),
      });
      const manager = authority;
      const server = createBridgeServer({ taskManager: manager });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "mvp-real-adapter-test", version: "0.0.1" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const shutdownFailures: unknown[] = [];
      try {
        await run(client, manager, dataRoot, workspace, runtime);
      } catch (runError) {
        shutdownFailures.push(runError);
      }
      await client.close().catch((error: unknown) => shutdownFailures.push(error));
      await server.close().catch((error: unknown) => shutdownFailures.push(error));
      await manager.shutdown().catch((error: unknown) => shutdownFailures.push(error));
      if (shutdownFailures.length > 0) runOrCloseFailure = shutdownFailures[0];
    } finally {
      await authority?.shutdown().catch((error: unknown) => { authorityShutdownError = error; });
      if (previousZcodeCjs === undefined) delete process.env["ZCODE_BRIDGE_ZCODE_CJS"]; else process.env["ZCODE_BRIDGE_ZCODE_CJS"] = previousZcodeCjs;
      if (previousZcodeNode === undefined) delete process.env["ZCODE_BRIDGE_NODE"]; else process.env["ZCODE_BRIDGE_NODE"] = previousZcodeNode;
      if (previousZcodeHome === undefined) delete process.env["ZCODE_HOME"]; else process.env["ZCODE_HOME"] = previousZcodeHome;
      if (previousBuiltinConfig === undefined) delete process.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]; else process.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"] = previousBuiltinConfig;
      if (previousPersonalConfig === undefined) delete process.env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]; else process.env["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"] = previousPersonalConfig;
    }
    if (authorityShutdownError !== undefined) throw authorityShutdownError;
    if (runOrCloseFailure !== undefined) throw runOrCloseFailure;
    // Mark success only after every resource (client, server, manager, and
    // the Authority) closed without error, so a failed close can never lead
    // to fixture deletion while handles may still be open.
    successful = true;
  } finally {
    if (!successful && options.lifecycleCollector?.lines.length) {
      console.error("SQLite lifecycle stages:\n" + options.lifecycleCollector.lines.join("\n"));
    }
    if (!successful && options.preserveFixtureOnFailure) preserveFailedFixture = true;
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

test("Start Plan without official auth is rejected before task persistence or Provider requests", { timeout: 120_000 }, async () => {
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `private-auth-missing-${randomUUID()}`;
    const rejected = await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId),
      model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } });
    assert.equal(rejected.isError, true);
    const error = rejected.structuredContent as { error?: { code?: string; message?: string } } | undefined;
    assert.equal(error?.error?.code, "TASK_INVALID");
    assert.match(error?.error?.message ?? "", /Start Plan credentials are unavailable/u);
    const status = await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } });
    assert.equal(status.isError, true);
    assert.equal(existsSync(runtime.requestLog), false, "no app-server Provider or model request may start");
  }, { preserveFixtureOnFailure: true });
});

for (const variant of ["private-auth", "private-auth-echo"] as const) test(`SQLite Worker private auth ${variant} keeps synthetic credential out of persisted output`, { timeout: 120_000 }, async () => {
  const stderr = { lines: [] as string[] };
  let workerArgs: readonly string[] | undefined;
  await withRealAdapterMcp(async (client, manager, dataRoot, workspace, runtime) => {
    const taskId = `private-auth-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId),
      model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal(created.status, "queued");
    const status = await waitForTerminal(client, taskId, 1);
    assert.equal(status.status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(result.status, "completed");
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.filter((item) => item.auth_applied === true).length, 1);
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    const scan = (directory: string): void => {
      for (const name of readdirSync(directory)) {
        const item = path.join(directory, name); const stat = lstatSync(item);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) scan(item);
        else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`);
      }
    };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
    assert.equal(Buffer.from(stderr.lines.join("")).includes(marker), false);
    assert.ok(workerArgs);
    assert.equal(Buffer.from(JSON.stringify(workerArgs)).includes(marker), false);
    assert.equal(JSON.stringify({ status, result }).includes(marker.toString()), false);
  }, { runtimeVariant: variant, stderrCollector: stderr, onWorkerSpawn: (child) => { workerArgs = [...child.spawnargs]; }, preserveFixtureOnFailure: true });
});

for (const variant of ["private-auth-wrong-turn", "private-auth-wrong-claim", "private-auth-account-switch"] as const) {
  test(`SQLite Worker rejects ${variant} without provider fallback`, { timeout: 120_000 }, async () => {
    const issueCount = { count: 0 };
    const lifecycleCollector = { lines: [] as string[] };
    const stderrCollector = { lines: [] as string[] };
    let fixtureRuntime: FakeRuntimeFixture | undefined;
    try { await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
      fixtureRuntime = runtime;
      const taskId = `private-reject-${randomUUID()}`;
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: {
        ...syntheticTask(workspace, taskId),
        model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
      } }));
      assert.equal(created.status, "queued");
      const status = await waitForTerminal(client, taskId, 1);
      assert.equal(status.status, "failed");
      await waitForLifecycleEvent(client, taskId, "released");
      const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(requests.filter((item) => item.auth_applied === true).length, 0);
      assert.equal(issueCount.count, variant === "private-auth-wrong-turn" ? 0 : 1);
      const selection = requests.filter((item) => item.method === "session/setModel");
      assert.equal(selection.length, 1);
      const model = (selection[0]?.params as { model?: { providerId?: string } } | undefined)?.model;
      assert.equal(model?.providerId, "account:bigmodel-start-plan");
    const providerSync = requests.find((item) => item.method === "provider/updateAccountConfig");
    assert.ok(providerSync, "live entitlement must be followed by native Provider registration");
    const syncParams = providerSync.params as { states?: Record<string, { entitled?: boolean; current?: boolean }> };
    assert.equal(syncParams.states?.["account:bigmodel-start-plan"]?.entitled, true);
    assert.equal(syncParams.states?.["account:bigmodel-start-plan"]?.current, true);
    assert.equal(JSON.stringify(providerSync).includes("SYNTHETIC_GATE2_SECRET_93d9422b"), false);
      const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
      const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
      scan(dataRoot);
    }, { runtimeVariant: variant, issueCount, lifecycleCollector, stderrCollector, preserveFixtureOnFailure: true });
    } catch (error) {
      console.error("worker stderr:\n" + stderrCollector.lines.join("\n"));
      if (fixtureRuntime && existsSync(fixtureRuntime.exitLog)) {
        console.error("fake app-server lifecycle:\n" + readFileSync(fixtureRuntime.exitLog, "utf8"));
      }
      throw error;
    }
  });
}

test("Start Plan Billing preflight rejection prevents AppServer startup and private lease delivery", { timeout: 120_000 }, async () => {
  const issueCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `private-preflight-reject-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId),
      model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(issueCount.count, 0, "no private credential lease may be issued after preflight rejection");
    assert.equal(existsSync(runtime.requestLog), false, "a rejected preflight must not start AppServer or send provider/session requests");
  }, { runtimeVariant: "private-auth-preflight-reject", issueCount, preserveFixtureOnFailure: true });
});

test("SQLite interaction persistence redacts a synthetic credential echoed by AppServer", { timeout: 120_000 }, async () => {
  const stderr = { lines: [] as string[] };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-interaction-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const interaction = await waitForInteractionRequest(client, taskId);
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    assert.equal(Buffer.from(JSON.stringify(interaction)).includes(marker), false);
    const details = interaction.details as Record<string, unknown>;
    const requestId = String(details.request_id ?? (details.payload as Record<string, unknown> | undefined)?.request_id ?? "permission-1");
    contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: { task_id: taskId, request_id: requestId, decision: "allow" } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    const events = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(Buffer.from(JSON.stringify({ events, result })).includes(marker), false);
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
    assert.equal(Buffer.from(stderr.lines.join("")).includes(marker), false);
  }, { runtimeVariant: "private-auth-interaction", stderrCollector: stderr, preserveFixtureOnFailure: true });
});

test("SQLite Worker environment block excludes the delivered synthetic credential", { timeout: 120_000 }, async () => {
  let binding!: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding;
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `private-env-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (!existsSync(runtime.requestLog) || !readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'))) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'));
    assert.ok(binding && binding.pid > 0 && binding.creation);
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "worker-env-probe.ps1");
    const probe = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-TargetPid", String(binding.pid), "-ExpectedTicks", binding.creation],
      { encoding: "utf8", timeout: 30_000, windowsHide: true });
    assert.equal(probe.status, 0, "identity-bound environment probe must succeed without exposing its contents");
    const observed = JSON.parse(probe.stdout.trim()) as { identity_verified?: boolean; marker_found?: boolean; bounded?: boolean };
    assert.deepEqual(observed, { identity_verified: true, marker_found: false, control_found: false, system_root_found: true, bounded: true });
    // Positive control: this independent fixture contains only a non-JWT
    // sentinel in its environment, proving the scanner can find a value.
    const control = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP,
        GATE2_ENV_CONTROL: "GATE2_ENV_CONTROL_PLAINTEXT_SENTINEL" }, stdio: "ignore", windowsHide: true,
    });
    const controlClosed = new Promise<void>((resolve) => control.once("close", () => resolve()));
    try {
      assert.ok(control.pid);
      const identity = await createPlatformProbe().identityOf(control.pid);
      assert.equal(identity.fingerprint_precision, "exact");
      assert.ok(identity.fingerprint);
      const positive = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-TargetPid", String(control.pid), "-ExpectedTicks", identity.fingerprint],
        { encoding: "utf8", timeout: 30_000, windowsHide: true });
      assert.equal(positive.status, 0, "identity-bound positive-control probe must succeed");
      assert.deepEqual(JSON.parse(positive.stdout.trim()), { identity_verified: true, marker_found: false, control_found: true, system_root_found: true, bounded: true });
    } finally { if (control.exitCode === null && control.signalCode === null) control.kill(); await controlClosed; }
    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    await waitForLifecycleEvent(client, taskId, "released");
  }, { runtimeVariant: "private-auth-hold", preserveFixtureOnFailure: true, issueOverride: (scope) => {
    binding = scope;
    return new PrivateCredentialLease(scope, "SYNTHETIC_GATE2_SECRET_93d9422b", Date.now() + 30_000);
  } });
});

test("SQLite cancellation after private credential delivery verifies Worker cleanup and Release", { timeout: 120_000 }, async () => {
  const stderr = { lines: [] as string[] };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-cancel-${randomUUID()}`;
    const created = contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal(created.status, "queued");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (!existsSync(runtime.requestLog) || !readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'), "synthetic credential must be delivered before cancellation");
    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
    assert.equal(result.status, "cancelled");
    await waitForLifecycleEvent(client, taskId, "released");
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(stderr.lines.join("")).includes(marker), false);
    assert.equal(JSON.stringify({ cancelled, result }).includes(marker.toString()), false);
  }, { runtimeVariant: "private-auth-hold", stderrCollector: stderr, preserveFixtureOnFailure: true });
});

test("SQLite cancellation before a delayed issuer returns revokes its late lease", { timeout: 120_000 }, async () => {
  let release!: (lease: PrivateCredentialLease) => void;
  let markIssued!: (lease: PrivateCredentialLease) => void;
  let child: ChildProcess | undefined;
  let issuedBinding!: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding;
  const issued = new Promise<PrivateCredentialLease>((resolve) => { markIssued = resolve; });
  const pending = new Promise<PrivateCredentialLease>((resolve) => { release = resolve; });
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-before-issue-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const lease = await issued;
    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    // Settle the late issuer only after the cancelled Worker generation has
    // exited; otherwise the EOF race can commit a Worker failure after the
    // Manager has already verified cancellation.
    await new Promise<void>((resolve, reject) => {
      const owned = child;
      if (!owned?.pid) return reject(new Error("cancelled Worker handle was unavailable"));
      if (owned.exitCode !== null || owned.signalCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error("cancelled Worker did not exit")), 15_000);
      owned.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    release(lease);
    await new Promise((resolve) => setImmediate(resolve));
    await waitForLifecycleEvent(client, taskId, "released");
    const requests = readFileSync(runtime.requestLog, "utf8");
    assert.equal(requests.includes('"auth_applied":true'), false);
    await assert.rejects(lease.redeem(issuedBinding, async () => true, async () => assert.fail(), new AbortController().signal));
    const marker = Buffer.from("SYNTHETIC_LATE_ISSUER");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(requests).includes(marker), false);
  }, { runtimeVariant: "private-auth-hold", preserveFixtureOnFailure: true, onWorkerSpawn: (value) => { child = value; }, issueOverride: (binding) => {
    const lease = new PrivateCredentialLease(binding, "SYNTHETIC_LATE_ISSUER", Date.now() + 30_000);
    issuedBinding = binding;
    markIssued(lease);
    return pending;
  } });
});

test("SQLite Worker exit while issuer is pending revokes a late lease", { timeout: 120_000 }, async () => {
  let child: ChildProcess | undefined;
  let release!: (lease: PrivateCredentialLease) => void;
  let issued!: (value: { lease: PrivateCredentialLease; binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding }) => void;
  const ready = new Promise<{ lease: PrivateCredentialLease; binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding }>((resolve) => { issued = resolve; });
  const pending = new Promise<PrivateCredentialLease>((resolve) => { release = resolve; });
  await withRealAdapterMcp(async (client, manager, dataRoot, workspace, runtime) => {
    const taskId = `private-worker-exit-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const { lease, binding } = await ready;
    assert.ok(child && child.pid === binding.pid && child.exitCode === null && child.signalCode === null);
    const owned = child;
    const exited = new Promise<void>((resolve) => owned.once("exit", () => resolve()));
    assert.equal(owned.kill(), true);
    await exited;
    release(lease);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(lease.redeem(binding, async () => true, async () => assert.fail(), new AbortController().signal));
    const requests = readFileSync(runtime.requestLog, "utf8");
    assert.equal(requests.includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_EXIT_ISSUER");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(requests).includes(marker), false);
    const cancelResponse = await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } });
    const cancelled = contentObject(cancelResponse);
    assert.equal(cancelled.status, "cancelled");
    await waitForLifecycleEvent(client, taskId, "released");
    await manager.shutdown();
    const settingsDirectory = path.join(path.dirname(dataRoot), "settings");
    const recoveryStages: Array<{ stage: string; detail: Record<string, unknown> }> = [];
    const restarted = await SqliteLifecycleMcpAuthority.create({
      dataRoot, workerEntryPath, bridgeEntryPath: fileURLToPath(import.meta.url),
      hostProfile: { name: "mvp-real-adapter-test", settingsDirectory },
      trustedLocalContext: createTrustedLocalCandidateContext({ name: "mvp-real-adapter-test", settingsDirectory }),
      testOnScheduler: (stage, detail) => { recoveryStages.push({ stage, detail }); },
    });
    try {
      assert.ok(recoveryStages.some((entry) => entry.stage === "operation_recovery_classified" && entry.detail.state === "complete"), "restart must classify the verified-cancelled crashed Attempt as complete");
      assert.ok(!recoveryStages.some((entry) => entry.stage === "recovery_root_read_only"), "a released Attempt must not fence new dispatch");
      const receipt = await restarted.createTask(syntheticTask(workspace, `recovery-probe-${randomUUID()}`) as unknown as import("../../../src/interfaces.js").TaskPackage);
      assert.ok(receipt.task_id, "a released Attempt must allow new dispatch");
      const probeDeadline = Date.now() + 60_000;
      let probeStatus = "";
      while (Date.now() < probeDeadline) {
        probeStatus = (await restarted.getStatus(receipt.task_id)).status;
        if (["completed", "failed", "cancelled"].includes(probeStatus)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(["completed", "failed", "cancelled"].includes(probeStatus), `recovery-probe task must reach a terminal state before restart shutdown (last status: ${probeStatus || "unknown"})`);
      console.error("[gate2] cancelled crashed Attempt released; restart observes no hold and dispatch is available");
    } finally { await restarted.shutdown(); }
  }, { runtimeVariant: "private-auth-hold", preserveFixtureOnFailure: true, onWorkerSpawn: (value) => { child = value; }, issueOverride: (binding) => {
    const lease = new PrivateCredentialLease(binding, "SYNTHETIC_EXIT_ISSUER", Date.now() + 30_000);
    issued({ lease, binding });
    return pending;
  } });
});

test("SQLite Worker crash without cancellation holds recovery and fences dispatch", { timeout: 120_000 }, async () => {
  let child: ChildProcess | undefined;
  let release!: (lease: PrivateCredentialLease) => void;
  let issued!: (value: { lease: PrivateCredentialLease; binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding }) => void;
  const ready = new Promise<{ lease: PrivateCredentialLease; binding: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding }>((resolve) => { issued = resolve; });
  const pending = new Promise<PrivateCredentialLease>((resolve) => { release = resolve; });
  let driverReturned: ((detail: Record<string, unknown>) => void) | undefined;
  const driverDone = new Promise<Record<string, unknown>>((resolve) => { driverReturned = resolve; });
  await withRealAdapterMcp(async (client, manager, dataRoot, workspace, _runtime) => {
    const taskId = `private-crash-hold-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const { binding } = await ready;
    assert.ok(child && child.pid === binding.pid);
    const owned = child;
    const exited = new Promise<void>((resolve) => owned.once("exit", () => resolve()));
    assert.equal(owned.kill(), true);
    await exited;
    const outcome = await driverDone;
    assert.equal(outcome.task_id, taskId);
    // The crashed Attempt stays `running` in the Store with no committed
    // result; no cancellation is requested in this scenario.
    await manager.shutdown();
    const settingsDirectory = path.join(path.dirname(dataRoot), "settings");
    const recoveryStages: Array<{ stage: string; detail: Record<string, unknown> }> = [];
    const admissionStages: Array<{ stage: string; detail: Record<string, unknown> }> = [];
    const restarted = await SqliteLifecycleMcpAuthority.create({
      dataRoot, workerEntryPath, bridgeEntryPath: fileURLToPath(import.meta.url),
      hostProfile: { name: "mvp-real-adapter-test", settingsDirectory },
      trustedLocalContext: createTrustedLocalCandidateContext({ name: "mvp-real-adapter-test", settingsDirectory }),
      testOnScheduler: (stage, detail) => {
        recoveryStages.push({ stage, detail });
        if (stage === "dispatch_deferred_workspace_occupied") admissionStages.push({ stage, detail });
      },
    });
    try {
      assert.ok(recoveryStages.some((entry) => entry.stage === "operation_recovery_classified" && entry.detail.state === "held"), "restart must hold the unverified crashed Attempt");
      // ADR-024 keeps a crashed Attempt scoped to its execution path instead
      // of installing a workspace-global Recovery Hold.
      assert.ok(recoveryStages.some((entry) => entry.stage === "recovery_workspace_scoped"), "held recovery must scope its fence to the occupied execution path");
      // Admission keeps a same-path Task queued; it must not create or spawn
      // a second Worker on the path occupied by the crashed Attempt.
      const probeTaskId = `recovery-probe-${randomUUID()}`;
      const probeReceipt = await restarted.createTask(syntheticTask(workspace, probeTaskId) as unknown as import("../../../src/interfaces.js").TaskPackage);
      assert.equal(probeReceipt.status, "queued");
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 10_000;
        const check = () => admissionStages.length > 0 ? resolve() : Date.now() < deadline ? setTimeout(check, 50) : reject(new Error("same-path admission was not deferred"));
        check();
      });
      assert.equal(admissionStages[0]?.detail.task_id, probeTaskId);
      assert.equal(admissionStages[0]?.detail.occupied_path, workspace);
      assert.equal(admissionStages[0]?.detail.execution_path, workspace);
      assert.equal((await restarted.getStatus(probeTaskId)).status, "queued");
      console.error("[gate2] crashed Attempt without cancellation stays held; restart fences new dispatch");
    } finally { await restarted.shutdown(); }
  }, { runtimeVariant: "private-auth-hold", preserveFixtureOnFailure: true, onWorkerSpawn: (value) => { child = value; }, onDriverRunReturned: (detail) => driverReturned?.(detail), issueOverride: (binding) => {
    const lease = new PrivateCredentialLease(binding, "SYNTHETIC_CRASH_HOLD", Date.now() + 30_000);
    issued({ lease, binding });
    return pending;
  } });
});

test("SQLite cancellation during a partially written credential frame aborts delivery once and releases", { timeout: 120_000 }, async () => {
  let writeStarted!: () => void;
  let writeHandoffFailed!: (error: Error) => void;
  let releaseWrite!: () => void;
  const writeBegun = new Promise<void>((resolve, reject) => { writeStarted = resolve; writeHandoffFailed = reject; });
  const writeReleased = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let writeEndCalls = 0;
  let frameWriteCalls = 0;
  const stderr = { lines: [] as string[] };
  const lifecycle = { lines: [] as string[] };
  try {
    await withRealAdapterMcp(async (client, manager, dataRoot, workspace, runtime) => {
    const taskId = `private-write-cancel-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    // The harness splits the Manager-side credential frame: the 4-byte
    // prefix plus the first body slice are handed to the OS socket, and the
    // remainder is withheld until this test releases it, so the cancel below
    // lands after a partial frame has genuinely been written.
    await writeBegun;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cancelResponse = await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } });
    releaseWrite();
    const cancelled = contentObject(cancelResponse);
    assert.ok(["cancelled", "failed"].includes(String(cancelled.status)), `cancellation must win or lose to a failed result, got ${String(cancelled.status)}`);
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(frameWriteCalls, 1, "the credential frame must be written at most once (never retransmitted)");
    const requests = readFileSync(runtime.requestLog, "utf8");
    assert.equal(requests.includes('"auth_applied":true'), false);
    if (cancelled.status === "failed") {
      const failedResult = await manager.getResult(taskId);
      assert.ok(String(failedResult.summary).includes("private_auth_receive_failed"), `a committed Worker failure must identify the mid-frame receive failure: ${String(failedResult.summary)}`);
    }
    const marker = Buffer.from("SYNTHETIC_WRITE_CANCEL");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(requests).includes(marker), false);
    console.error("[gate2] cancellation during outstanding credential write completed; release verified, no retransmission");
    }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, stderrCollector: stderr, lifecycleCollector: lifecycle, onWorkerSpawn: (value) => {
    const responseChannel = (value as unknown as { privateAuthResponseChannel?: { readonly destroyed?: boolean; readonly writableEnded?: boolean; write: (chunk: Buffer, callback?: (error?: Error | null) => void) => boolean; end: (chunk?: Buffer) => unknown } }).privateAuthResponseChannel;
    if (responseChannel) {
      const originalWrite = responseChannel.write.bind(responseChannel);
      const originalEnd = responseChannel.end.bind(responseChannel);
      responseChannel.end = (chunk?: Buffer) => {
        writeEndCalls += 1;
        if (chunk) frameWriteCalls += 1;
        if (!chunk) {
          writeStarted();
          void writeReleased.then(() => { if (!responseChannel.destroyed && !responseChannel.writableEnded) originalEnd(); });
          return responseChannel;
        }
        // Prefix plus the first body slice: a genuine partial frame reaches
        // the OS socket; `writeStarted` fires from the write callback, which
        // proves the bytes were handed off before the test cancels.
        const split = Math.min(chunk.length, 4 + 64);
        originalWrite(chunk.subarray(0, split), (handoffError?: Error | null) => {
          // The write callback proves the partial bytes were handed to the
          // OS socket; a handoff error must fail the test, not be ignored.
          if (handoffError) writeHandoffFailed(new Error(`partial frame handoff failed: ${String(handoffError)}`));
          else writeStarted();
        });
        void writeReleased.then(() => {
          if (!responseChannel.destroyed && !responseChannel.writableEnded) {
            originalWrite(chunk.subarray(split));
            originalEnd();
          }
        });
        return responseChannel;
      };
    }
    }, issueOverride: (binding) => new PrivateCredentialLease(binding, "SYNTHETIC_WRITE_CANCEL", Date.now() + 30_000) });
  } finally {
    if (process.env["MVP_KEEP_FIXTURE"] === "1") {
      console.error("write-cancel stderr:\n" + stderr.lines.join(""));
      console.error("write-cancel lifecycle:\n" + lifecycle.lines.join("\n"));
    }
  }
});

test("SQLite Worker rejects subsequent runtime auth after lifetime pipe EOF", { timeout: 120_000 }, async () => {
  let child: ClaimOnlyWorkerProcess | undefined;
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-eof-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (!existsSync(runtime.requestLog) || !readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'))) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'));
    assert.ok(child?.privateAuthLifetimeChannel);
    child.privateAuthLifetimeChannel.destroy();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(child.exitCode, null, "the same Worker must still be alive for the EOF recheck");
    assert.equal(child.signalCode, null);
    writeFileSync(path.join(runtime.runtimeRoot, "recheck-trigger"), "recheck", "utf8");
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    const entries = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(entries.filter((item) => item.auth_applied === true).length, 1);
    assert.deepEqual(entries.filter((item) => "recheck_auth_applied" in item).map((item) => item.recheck_auth_applied), [false]);
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth-eof-recheck", preserveFixtureOnFailure: true, onWorkerSpawn: (value) => { child = value as ClaimOnlyWorkerProcess; } });
});

test("SQLite Worker ACK channel loss never retransmits a private credential", { timeout: 120_000 }, async () => {
  let lease: PrivateCredentialLease | undefined;
  let issuedBinding!: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding;
  const issuedCount = { count: 0 };
  let responseFinished = 0;
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-ack-loss-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const status = await waitForTerminal(client, taskId, 1);
    assert.equal(status.status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(issuedCount.count, 1);
    assert.equal(responseFinished, 1, "exactly one credential frame must finish writing before ACK failure");
    assert.ok(lease);
    await assert.rejects(lease.redeem(issuedBinding, async () => true, async () => assert.fail(), new AbortController().signal));
    const marker = Buffer.from("SYNTHETIC_ACK_LOSS");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => { const worker = child as ClaimOnlyWorkerProcess; const channel = worker.privateAuthAcknowledgementChannel; assert.ok(channel); assert.ok(worker.privateAuthResponseChannel); worker.privateAuthResponseChannel.once("finish", () => { responseFinished++; }); channel.destroy(); },
    issueOverride: (binding) => { issuedBinding = binding; lease = new PrivateCredentialLease(binding, "SYNTHETIC_ACK_LOSS", Date.now() + 30_000); return lease; },
  });
});

for (const invalid of [Buffer.from([2, 2]), Buffer.from([0])] as const) test(`SQLite Worker rejects malformed confirmation ${invalid.toString("hex")}`, { timeout: 120_000 }, async () => {
  let injected = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-confirm-invalid-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(injected, 1);
    assert.equal(issuedCount.count, 1);
    assert.equal(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_CONFIRM_INVALID");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const lifetime = (child as ClaimOnlyWorkerProcess).privateAuthLifetimeChannel;
      assert.ok(lifetime);
      const originalWrite = lifetime.write.bind(lifetime);
      lifetime.write = ((chunk: unknown, ...args: unknown[]) => {
        if (Buffer.isBuffer(chunk) && chunk.length === 1 && chunk[0] === 2) { injected++; return (originalWrite as (...values: unknown[]) => boolean)(invalid, ...args); }
        return (originalWrite as (...values: unknown[]) => boolean)(chunk, ...args);
      }) as typeof lifetime.write;
    },
    issueOverride: (scope) => new PrivateCredentialLease(scope, "SYNTHETIC_CONFIRM_INVALID", Date.now() + 30_000),
  });
});

test("SQLite Worker refuses credentials when lifetime EOF precedes Manager confirmation", { timeout: 120_000 }, async () => {
  let interrupted = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-confirm-eof-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(interrupted, 1);
    assert.equal(issuedCount.count, 1);
    assert.equal(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_CONFIRM_EOF");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const lifetime = (child as ClaimOnlyWorkerProcess).privateAuthLifetimeChannel;
      assert.ok(lifetime);
      const originalWrite = lifetime.write.bind(lifetime);
      lifetime.write = ((chunk: unknown, ...args: unknown[]) => {
        if (Buffer.isBuffer(chunk) && chunk.length === 1 && chunk[0] === 2) { interrupted++; lifetime.destroy(); return false; }
        return (originalWrite as (...values: unknown[]) => boolean)(chunk, ...args);
      }) as typeof lifetime.write;
    },
    issueOverride: (scope) => new PrivateCredentialLease(scope, "SYNTHETIC_CONFIRM_EOF", Date.now() + 30_000),
  });
});

test("SQLite cancellation while Worker awaits Manager confirmation revokes delivery", { timeout: 120_000 }, async () => {
  let dropped = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-confirm-cancel-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && dropped === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(dropped, 1, "cancel only after Manager accepted ACK and confirmation was dropped");
    const cancelled = contentObject(await client.callTool({ name: "zcode_cancel", arguments: { task_id: taskId } }));
    assert.equal(cancelled.status, "cancelled");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(issuedCount.count, 1);
    assert.equal(readFileSync(runtime.requestLog, "utf8").includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_CONFIRM_CANCEL");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const lifetime = (child as ClaimOnlyWorkerProcess).privateAuthLifetimeChannel;
      assert.ok(lifetime);
      const originalWrite = lifetime.write.bind(lifetime);
      lifetime.write = ((chunk: unknown, ...args: unknown[]) => {
        if (Buffer.isBuffer(chunk) && chunk.length === 1 && chunk[0] === 2) {
          dropped++;
          const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
          if (callback) queueMicrotask(callback);
          return true;
        }
        return (originalWrite as (...values: unknown[]) => boolean)(chunk, ...args);
      }) as typeof lifetime.write;
    },
    issueOverride: (scope) => new PrivateCredentialLease(scope, "SYNTHETIC_CONFIRM_CANCEL", Date.now() + 30_000),
  });
});

test("SQLite Worker refuses credentials when Manager confirmation is lost", { timeout: 120_000 }, async () => {
  let dropped = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-confirm-lost-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(dropped, 1);
    assert.equal(issuedCount.count, 1);
    const requests = readFileSync(runtime.requestLog, "utf8");
    assert.equal(requests.includes('"auth_applied":true'), false);
    const marker = Buffer.from("SYNTHETIC_CONFIRM_LOST");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(Buffer.from(requests).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const lifetime = (child as ClaimOnlyWorkerProcess).privateAuthLifetimeChannel;
      assert.ok(lifetime);
      const originalWrite = lifetime.write.bind(lifetime);
      lifetime.write = ((chunk: unknown, ...args: unknown[]) => {
        if (Buffer.isBuffer(chunk) && chunk.length === 1 && chunk[0] === 2) {
          dropped++;
          const callback = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
          if (callback) queueMicrotask(callback);
          return true;
        }
        return (originalWrite as (...values: unknown[]) => boolean)(chunk, ...args);
      }) as typeof lifetime.write;
    },
    issueOverride: (scope) => new PrivateCredentialLease(scope, "SYNTHETIC_CONFIRM_LOST", Date.now() + 6_000),
  });
});

test("SQLite Worker ACK received then discarded never causes credential retransmission", { timeout: 120_000 }, async () => {
  let lease: PrivateCredentialLease | undefined;
  let binding!: import("../../../src/runtime/start-plan-private-lease.js").PrivateLeaseBinding;
  let discarded = 0;
  let responseFinished = 0;
  const issuedCount = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-ack-discard-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    const status = await waitForTerminal(client, taskId, 1);
    assert.equal(status.status, "failed", "Worker must not use credentials before Manager accepts ACK");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(discarded, 1, "the Manager must observe and discard the Worker's ACK bytes");
    assert.equal(responseFinished, 1);
    assert.equal(issuedCount.count, 1);
    assert.ok(lease);
    await assert.rejects(lease.redeem(binding, async () => true, async () => assert.fail(), new AbortController().signal));
    const marker = Buffer.from("SYNTHETIC_ACK_DISCARDED");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
    const entries = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(entries.filter((item) => item.auth_applied === true).length, 0);
    console.error(`[gate2] discarded ACK bytes; task_status=${String(status.status)} frame_finishes=${responseFinished} issues=${issuedCount.count} discarded=${discarded}`);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueCount: issuedCount,
    onWorkerSpawn: (child) => {
      const worker = child as ClaimOnlyWorkerProcess;
      const ack = worker.privateAuthAcknowledgementChannel;
      assert.ok(ack); assert.ok(worker.privateAuthResponseChannel);
      worker.privateAuthResponseChannel.once("finish", () => { responseFinished++; });
      const originalRead = ack.read.bind(ack);
      ack.read = (size?: number) => { const chunk: unknown = originalRead(size); if (chunk !== null) { discarded++; ack.destroy(); return null; } return null; };
    },
    issueOverride: (scope) => { binding = scope; lease = new PrivateCredentialLease(scope, "SYNTHETIC_ACK_DISCARDED", Date.now() + 30_000); return lease; },
  });
});

test("SQLite continuation cannot redeem a prior Attempt's private lease", { timeout: 120_000 }, async () => {
  let priorLease: PrivateCredentialLease | undefined;
  const attempts: number[] = [];
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const taskId = `private-old-attempt-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    contentObject(await client.callTool({ name: "zcode_continue", arguments: { task_id: taskId, feedback: "Run the isolated continuation", operation_id: `continue-${randomUUID()}` } }));
    assert.equal((await waitForTerminal(client, taskId, 2)).status, "failed");
    const operationId = `sqlite-${createHash("sha256").update(`${taskId}\0${2}`, "utf8").digest("hex").slice(0, 32)}`;
    const modules = await loadLifecycleCandidateModules();
    const store = modules.Store.openForRecovery(dataRoot);
    assert.ok(store);
    try {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !modules.createPort(store).readLifecycleEvents(operationId).some((event) => event.event_type === "released")) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(modules.createPort(store).readLifecycleEvents(operationId).some((event) => event.event_type === "released"), "second Attempt must Release");
    } finally { store.close(); }
    assert.deepEqual(attempts, [1, 2]);
    const entries = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(entries.filter((entry) => entry.auth_applied === true).length, 1);
    const markers = [Buffer.from("SYNTHETIC_OLD_ATTEMPT"), Buffer.from("SYNTHETIC_FIRST_ATTEMPT")];
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) for (const marker of markers) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
    for (const marker of markers) assert.equal(readFileSync(runtime.requestLog).includes(marker), false);
  }, { runtimeVariant: "private-auth", preserveFixtureOnFailure: true, issueOverride: (binding) => {
    attempts.push(binding.attempt);
    if (!priorLease) {
      priorLease = new PrivateCredentialLease(binding, "SYNTHETIC_OLD_ATTEMPT", Date.now() + 60_000);
      return new PrivateCredentialLease(binding, "SYNTHETIC_FIRST_ATTEMPT", Date.now() + 60_000);
    }
    return priorLease;
  } });
});

test("two SQLite Workers cannot consume the same private credential lease", { timeout: 120_000 }, async () => {
  let shared: PrivateCredentialLease | undefined;
  const claims = new Set<string>();
  const count = { count: 0 };
  await withRealAdapterMcp(async (client, _manager, dataRoot, workspace, runtime) => {
    const firstWorkspace = path.join(workspace, "first"), secondWorkspace = path.join(workspace, "second");
    mkdirSync(firstWorkspace); mkdirSync(secondWorkspace);
    const first = `private-first-${randomUUID()}`, second = `private-second-${randomUUID()}`;
    for (const [taskId, directory] of [[first, firstWorkspace], [second, secondWorkspace]]) {
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: {
        ...syntheticTask(directory!, taskId!), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
      } }));
      assert.equal(created.status, "queued");
    }
    const statuses = await Promise.all([waitForTerminal(client, first, 1), waitForTerminal(client, second, 1)]);
    assert.deepEqual(statuses.map((status) => status.status).sort(), ["completed", "failed"]);
    await Promise.all([waitForLifecycleEvent(client, first, "released"), waitForLifecycleEvent(client, second, "released")]);
    assert.equal(count.count, 2);
    assert.equal(claims.size, 2);
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.filter((item) => item.auth_applied === true).length, 1);
    assert.equal(JSON.stringify(statuses).includes("SYNTHETIC_GATE2_SECRET_93d9422b"), false);
    const marker = Buffer.from("SYNTHETIC_GATE2_SECRET_93d9422b");
    const scan = (directory: string): void => { for (const name of readdirSync(directory)) { const item = path.join(directory, name); const stat = lstatSync(item); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) scan(item); else if (stat.isFile()) assert.equal(readFileSync(item).includes(marker), false, `secret marker in ${item}`); } };
    scan(dataRoot);
  }, { runtimeVariant: "private-auth", issueCount: count, preserveFixtureOnFailure: true,
    issueOverride: (binding) => { claims.add(binding.claim); shared ??= new PrivateCredentialLease(binding, "SYNTHETIC_GATE2_SECRET_93d9422b", Date.now() + 30_000); return shared; } });
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

test("ADR-011 failure facts cross the Worker stderr diagnostic exit and the Host validator without failure payloads", { timeout: 120_000 }, async () => {
  const stderr = { lines: [] as string[] };
  const diagnostics = { lines: [] as string[] };
  const marker = "[bridge-worker] failure-facts ";
  const sentinel = "SENTINEL_FF_MESSAGE";
  try {
    await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
      const taskId = `mvp-facts-${randomUUID()}`;
      const created = contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
      assert.equal(created.status, "queued");
      const status = await waitForTerminal(client, taskId, 1);
      assert.equal(status.status, "failed");
      await waitForLifecycleEvent(client, taskId, "result_committed");
      await waitForLifecycleEvent(client, taskId, "released");
      const result = contentObject(await client.callTool({ name: "zcode_result", arguments: { task_id: taskId } }));
      assert.equal(result.status, "failed");
      // Exactly one validated snapshot leaves the Worker through stderr.
      const factDeadline = Date.now() + 10_000;
      const factLines = (): string[] => stderr.lines.join("").split("\n").filter((line) => line.startsWith(marker));
      while (Date.now() < factDeadline && factLines().length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(factLines().length, 1, `exactly one failure-facts line expected: ${JSON.stringify(stderr.lines)}`);
      const facts = JSON.parse(factLines()[0]!.slice(marker.length)) as Record<string, unknown>;
      assert.equal(facts.schema_version, "1");
      assert.equal(facts.source, "turn_event");
      assert.equal(facts.phase, "turn_terminal");
      assert.equal(facts.provider_code, "3007");
      assert.equal(facts.http_status, 429);
      assert.equal(facts.error_code, "model_request_failed");
      assert.equal(facts.category, "rate_limited");
      assert.equal(facts.confidence, "inferred");
      assert.equal(facts.evidence_basis, "http_status");
      assert.equal(facts.runtime_retryable, false);
      assert.equal(facts.accepted_before_error, "yes");
      // The production Manager wiring forwards the same line once.
      const forwardDeadline = Date.now() + 10_000;
      while (Date.now() < forwardDeadline && diagnostics.lines.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(diagnostics.lines.length, 1);
      assert.equal(JSON.parse(diagnostics.lines[0]!.slice(marker.length)).provider_code, "3007");
      // Raw failure payloads stay out of every diagnostic or result surface.
      for (const surface of [stderr.lines.join(""), diagnostics.lines.join(""), JSON.stringify(result), JSON.stringify(status)]) {
        assert.equal(surface.includes(sentinel), false, "upstream failure text must never reach diagnostics or results");
      }
      // Classification never creates a retry: exactly one model send.
      const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.equal(requests.filter((message) => message.method === "session/send").length, 1);
    }, { runtimeVariant: "facts-turn-failure", stderrCollector: stderr, workerDiagnosticCollector: diagnostics, preserveFixtureOnFailure: true });
  } catch (error) {
    console.error("worker stderr:\n" + stderr.lines.join("\n") + "\nforwarded diagnostics:\n" + diagnostics.lines.join("\n"));
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

// Only test fixtures change data generation/timing; production Spawner, Adapter,
// Manager, CAS, SQLite, process identity and cleanup implementation remain real.
async function deadlineWorker(name: string, mode: 'budget'|'execution-timeout'|'late-cleanup'|'late-close'|'no-result'|'blocked-envelope'):Promise<string>{
  mkdirSync(fixtureRoot,{recursive:true});const outfile=path.join(fixtureRoot,`r3-${name}.mjs`);
  await build({entryPoints:[path.join(projectRoot,'src/worker/worker-main.ts')],outfile,bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',logLevel:'silent',plugins:[{name:'r3-controlled-lifecycle',setup(b){
    b.onLoad({filter:/worker-main\.ts$/},async args=>{
      let source=readFileSync(args.path,'utf8').replaceAll('\r\n','\n');
      if(mode==='budget')source=source.replace('return executeFakeResultAdapter(bootstrap as Parameters<typeof executeFakeResultAdapter>[0]);',`const frame=executeFakeResultAdapter(bootstrap as Parameters<typeof executeFakeResultAdapter>[0]);frame.result.summary='effective_timeout_ms='+String(execution.task.timeout_ms);return frame;`);
      if(mode==='execution-timeout')source=source.replace('timeoutMs: execution.task.timeout_ms,','timeoutMs: 5000,');
      if(mode==='late-cleanup'){
        source=`import {terminateProcessTree as actualTerminate} from ${JSON.stringify(path.join(projectRoot,'src/adapters/process-spawn.ts'))};\n`+source;
        source=source.replace('timeoutMs: execution.task.timeout_ms,',`timeoutMs: execution.task.timeout_ms,testCleanupTimeoutMs:100,terminateProcessTreeImpl:async(pid,options)=>{await new Promise(r=>setTimeout(r,1500));return actualTerminate(pid,options);},`);
      }
      if(mode==='late-close')source=source.replace('options.onStage?.("adapter result frame written");','options.onStage?.("adapter result frame written"); await new Promise(r=>setTimeout(r,10000));');
      if(mode==='no-result')source=source.replace('options.onStage?.("adapter result frame prepared");','options.onStage?.("adapter result frame prepared"); await new Promise(r=>setTimeout(r,1000000));');
      if(mode==='blocked-envelope')source=source.replace('  const decision = readPrivateFrame(5, 1_100_000);','  await new Promise(r=>setTimeout(r,1000000));\n  const decision = readPrivateFrame(5, 1_100_000);');
      return {contents:source,loader:'ts',resolveDir:path.dirname(args.path)};
    });
  }}]});return outfile;
}

async function operationFor(dataRoot:string,taskId:string):Promise<Record<string,unknown>>{
  const modules=await loadLifecycleCandidateModules();const store=modules.Store.open(dataRoot)!;
  try{return store.readTaskLifecycle(taskId)!.operation as Record<string,unknown>;}finally{store.close();}
}

test('ADR-027 Manager and actual Worker share the environment default and four-hour Task override', {timeout:60000},async()=>{
  const worker=await deadlineWorker('budget','budget'),before=process.env['ZCODE_BRIDGE_TIMEOUT_MS'];
  process.env['ZCODE_BRIDGE_TIMEOUT_MS']='90000';
  try{for(const override of [undefined,4*60*60_000]){
    const lifecycle={lines:[] as string[]};
    await withRealAdapterMcp(async(client,_manager,_dataRoot,workspace)=>{
      const taskId=`r3-budget-${randomUUID()}`;
      contentObject(await client.callTool({name:'zcode_task',arguments:{...syntheticTask(workspace,taskId),...(override?{timeout_ms:override}:{})}}));
      await waitForTerminal(client,taskId,1);await waitForLifecycleEvent(client,taskId,'released');
      const expected=override??90000;
      assert.equal(contentObject(await client.callTool({name:'zcode_result',arguments:{task_id:taskId}})).summary,`effective_timeout_ms=${expected}`);
      const sent=lifecycle.lines.find(line=>line.startsWith('[bridge-lifecycle] claim_continue_sent '));assert.ok(sent);
      const detail=JSON.parse(sent.slice(sent.indexOf('{')));assert.equal(detail.execution_timeout_ms,expected);assert.equal(detail.result_wait_ms,expected+330000);
    },{workerOverride:worker,testOnlyFakeAdapter:true,lifecycleCollector:lifecycle});
  }}finally{if(before===undefined)delete process.env['ZCODE_BRIDGE_TIMEOUT_MS'];else process.env['ZCODE_BRIDGE_TIMEOUT_MS']=before;}
});

test('ADR-027 actual Worker execution timeout commits a timeout Result and releases only with real Windows cleanup proof', {timeout:90000},async()=>{
  const worker=await deadlineWorker('timeout','execution-timeout');
  const workerStderr:string[]=[];const lifecycleLines:string[]=[];
  try{
    await withRealAdapterMcp(async(client,_manager,dataRoot,workspace,runtime)=>{
      const taskId=`r3-timeout-${randomUUID()}`;
      contentObject(await client.callTool({name:'zcode_task',arguments:syntheticTask(workspace,taskId)}));
      assert.equal((await waitForTerminal(client,taskId,1)).status,'failed');
      await waitForLifecycleEvent(client,taskId,'released');
      const result=contentObject(await client.callTool({name:'zcode_result',arguments:{task_id:taskId}}));
      assert.equal(result.error_code,'timeout');assert.equal((await operationFor(dataRoot,taskId)).phase,'released');
      const requests=readFileSync(runtime.requestLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));
      assert.equal(requests.filter(r=>r.method==='session/send').length,1);
    },{workerOverride:worker,runtimeVariant:'deadline-hang',stderrCollector:{lines:workerStderr},lifecycleCollector:{lines:lifecycleLines}});
  }catch(error){
    console.error('worker stderr:\n'+workerStderr.join('\n'));
    throw error;
  }
});

test('ADR-027 cleanup expiry persists a failed Result and late cleanup cannot silently release its Workspace', {timeout:90000},async()=>{
  const worker=await deadlineWorker('cleanup','late-cleanup');
  await withRealAdapterMcp(async(client,_manager,dataRoot,workspace)=>{
    const taskId=`r3-cleanup-${randomUUID()}`;
    contentObject(await client.callTool({name:'zcode_task',arguments:syntheticTask(workspace,taskId)}));
    assert.equal((await waitForTerminal(client,taskId,1)).status,'failed');
    await waitForLifecycleEvent(client,taskId,'cleanup_unverified');
    const result=contentObject(await client.callTool({name:'zcode_result',arguments:{task_id:taskId}}));
    assert.equal(result.error_code,'cleanup_failed');
    const operation=await operationFor(dataRoot,taskId);assert.equal(operation.phase,'cleanup_unverified');
    // Explicit evidence-only recovery can stop the exact live generation or
    // prove that the delayed cleanup already finished; neither path re-executes.
    contentObject(await client.callTool({name:'zcode_cancel',arguments:{task_id:taskId}}));
    await waitForLifecycleEvent(client,taskId,'released');
    assert.deepEqual(contentObject(await client.callTool({name:'zcode_result',arguments:{task_id:taskId}})),result);
  },{workerOverride:worker,runtimeVariant:'deadline-success',workerCloseWaitMs:100});
});

test('ADR-027 Result survives a late Worker close and Manager restart; completed Result allows cleanup-only cancel', {timeout:90000},async()=>{
  const worker=await deadlineWorker('close','late-close');
  await withRealAdapterMcp(async(client,manager,dataRoot,workspace)=>{
    const taskId=`r3-close-${randomUUID()}`;
    contentObject(await client.callTool({name:'zcode_task',arguments:syntheticTask(workspace,taskId)}));
    await waitForTerminal(client,taskId,1);await waitForLifecycleEvent(client,taskId,'cleanup_unverified');
    const result=contentObject(await client.callTool({name:'zcode_result',arguments:{task_id:taskId}}));assert.equal(result.status,'completed');
    assert.equal((await operationFor(dataRoot,taskId)).phase,'cleanup_unverified');
    await manager.shutdown();
    const host={name:'mvp-real-adapter-test',settingsDirectory:path.join(path.dirname(dataRoot),'settings')};
    const authority=await SqliteLifecycleMcpAuthority.create({dataRoot,workerEntryPath:worker,bridgeEntryPath:fileURLToPath(import.meta.url),hostProfile:host,trustedLocalContext:createTrustedLocalCandidateContext(host),testOnlyFakeAdapter:true});
    const restarted=authority;
    try{
      assert.deepEqual(await restarted.getResult(taskId),result);
      const recovered=await restarted.cancelTask(taskId);assert.equal(recovered.status,'completed');
      assert.equal((await operationFor(dataRoot,taskId)).phase,'released');
      assert.equal((await restarted.cancelTask(taskId)).status,'completed');
      assert.deepEqual(await restarted.getResult(taskId),result);
    }finally{await restarted.shutdown();}
  },{workerOverride:worker,testOnlyFakeAdapter:true,workerCloseWaitMs:100});
});

test('ADR-027 Manager result deadline keeps the real claimed Worker cancellable instead of dropping its handle', {timeout:90000},async()=>{
  const worker=await deadlineWorker('missing','no-result');
  await withRealAdapterMcp(async(client,_manager,dataRoot,workspace)=>{
    const taskId=`r3-no-result-${randomUUID()}`;
    contentObject(await client.callTool({name:'zcode_task',arguments:syntheticTask(workspace,taskId)}));
    const until=Date.now()+30000;let status:Record<string,unknown>={};
    while(Date.now()<until){status=contentObject(await client.callTool({name:'zcode_status',arguments:{task_id:taskId}}));if(status.error_code==='private_report_timeout')break;await new Promise(r=>setTimeout(r,30));}
    assert.equal(status.error_code,'private_report_timeout');assert.equal(status.status,'running');
    assert.equal((await operationFor(dataRoot,taskId)).phase,'running');
    contentObject(await client.callTool({name:'zcode_cancel',arguments:{task_id:taskId}}));
    assert.equal((await waitForTerminal(client,taskId,1)).status,'cancelled');
    await waitForLifecycleEvent(client,taskId,'released');
  },{workerOverride:worker,testOnlyFakeAdapter:true,resultWaitMs:500});
});

test('ADR-027 blocked execution-envelope pipe expires visibly and retains the exact Worker for cancellation', {timeout:90000},async()=>{
  const worker=await deadlineWorker('delivery','blocked-envelope');
  const lifecycle={lines:[] as string[]};
  await withRealAdapterMcp(async(client,_manager,dataRoot,workspace)=>{
    const taskId=`r3-delivery-${randomUUID()}`;
    // A valid Task below the existing 1.1 MB envelope cap exceeds the real
    // Windows pipe buffer. The actual Worker reports identity but never reads fd5.
    contentObject(await client.callTool({name:'zcode_task',arguments:{...syntheticTask(workspace,taskId),context:'x'.repeat(1_000_000)}}));
    const until=Date.now()+45000;let status:Record<string,unknown>={};
    while(Date.now()<until){status=contentObject(await client.callTool({name:'zcode_status',arguments:{task_id:taskId}}));if(status.error_code==='private_execution_delivery_timeout')break;await new Promise(r=>setTimeout(r,30));}
    assert.equal(status.error_code,'private_execution_delivery_timeout');assert.equal(status.status,'running');
    assert.equal((await operationFor(dataRoot,taskId)).phase,'running');
    assert.equal(lifecycle.lines.filter(line=>line.startsWith('[bridge-lifecycle] claim_committed ')).length,1);
    assert.equal(lifecycle.lines.filter(line=>line.startsWith('[bridge-lifecycle] claim_continue_sent ')).length,0);
    contentObject(await client.callTool({name:'zcode_cancel',arguments:{task_id:taskId}}));
    assert.equal((await waitForTerminal(client,taskId,1)).status,'cancelled');
    await waitForLifecycleEvent(client,taskId,'released');
  },{workerOverride:worker,testOnlyFakeAdapter:true,workerCloseWaitMs:100,lifecycleCollector:lifecycle});
});

// Host composition layer: these tests build the Start Plan issuer exactly
// the way the production stdio host does (createHostStartPlanIssuer) and
// prove the wiring reaches the SQLite gate with a controlled fake Billing
// gate. Synthetic credentials only; no network and no real account.
const HOST_CREDENTIAL_SECRET = "synthetic-host-credential-secret";
const HOST_ACCOUNT = "synthetic-account";
const HOST_DEVICE_MID = "synthetic-host-device-mid";
const HOST_JWT = [
  Buffer.from(JSON.stringify({ alg: "synthetic" }), "utf8").toString("base64url"),
  Buffer.from(JSON.stringify({ account: HOST_ACCOUNT, exp: Math.floor(Date.now() / 1000) + 3_600 }), "utf8").toString("base64url"),
  "synthetic-signature",
].join(".");

function encryptHostCredential(value: string, secret: string): string {
  const iv = randomBytes(12);
  const key = createHash("sha256").update(secret).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function writeHostCredentials(runtime: FakeRuntimeFixture, account: string = HOST_ACCOUNT): void {
  const jwt = [
    Buffer.from(JSON.stringify({ alg: "synthetic" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ account, exp: Math.floor(Date.now() / 1000) + 3_600 }), "utf8").toString("base64url"),
    "synthetic-signature",
  ].join(".");
  writeFileSync(path.join(runtime.zcodeHomeV2, "credentials.json"), JSON.stringify({
    zcodejwttoken: encryptHostCredential(jwt, HOST_CREDENTIAL_SECRET),
    "oauth:bigmodel:user_info": encryptHostCredential(JSON.stringify({
      id: account,
      username: "synthetic-host-user",
      displayName: "Synthetic Host User",
      rawProfile: {
        user_id: account,
        name: "Synthetic Host User",
        email: "synthetic-host@example.invalid",
        avatar: "",
        zcodeProfileSchemaVersion: 1,
      },
    }), HOST_CREDENTIAL_SECRET),
  }));
  writeFileSync(path.join(runtime.zcodeHomeV2, "telemetry-state.json"), JSON.stringify({ deviceMid: HOST_DEVICE_MID }));
}

function fakeHostBillingGate(outcome: "entitled" | "billing_parameter_error") {
  const checks: Array<{ account: string; provider: string; model: string; deviceMid: string }> = [];
  const entitlement: StartPlanLiveEntitlement = {
    check: async (input) => {
      checks.push({ account: input.account, provider: input.provider, model: input.model, deviceMid: input.deviceMid });
      return outcome === "entitled"
        ? { status: "entitled", observedAt: checks.length, requestId: `synthetic-${checks.length}` }
        : { status: "billing_parameter_error", reason: "synthetic billing parameter rejection", providerCode: "3001", observedAt: checks.length };
    },
  };
  return { checks, entitlement };
}

function hostIssuerFactory(entitlement: StartPlanLiveEntitlement, options: { writeCredentials?: boolean } = {}) {
  return async (runtime: FakeRuntimeFixture, host: BridgeHostProfile): Promise<ProductionAuthIssuer | null> => {
    if (options.writeCredentials !== false) writeHostCredentials(runtime);
    return createHostStartPlanIssuer({
      // Redirect the Windows user home so official credential discovery can
      // only ever see this fixture's .zcode tree, never the real account.
      env: { ...process.env, HOME: runtime.runtimeRoot, USERPROFILE: runtime.runtimeRoot, ZCODE_CREDENTIAL_SECRET: HOST_CREDENTIAL_SECRET },
      homeDir: runtime.runtimeRoot,
      host,
      signal: new AbortController().signal,
      entitlement,
    });
  };
}

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
      { account: HOST_ACCOUNT, provider: "account:bigmodel-start-plan", model: "GLM-5.3-Flash", deviceMid: HOST_DEVICE_MID },
    ]);
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(requests.some((message) => message.method === "session/create"), "Billing success must reach Provider registration and session creation");
    assert.ok(requests.some((message) => message.method === "session/send"), "Billing success must reach the Worker turn");
    assert.ok(requests.some((message) => (message as { auth_applied?: boolean }).auth_applied === true), "the private lease must be delivered after Billing success");
    assert.equal(JSON.stringify(requests).includes(HOST_JWT), false, "the delivered credential must never appear in the app-server request log");
  }, { runtimeVariant: "private-auth", issuerFactory: hostIssuerFactory(gate.entitlement), preserveFixtureOnFailure: true });
});

test("host-wired issuer surfaces a sanitized Billing rejection and never starts the AppServer", { timeout: 120_000 }, async () => {
  const gate = fakeHostBillingGate("billing_parameter_error");
  const lifecycle = { lines: [] as string[] };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `host-wired-reject-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { provider_id: "account:bigmodel-start-plan", model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(gate.checks.length, 1, "a Billing rejection must stop before lease delivery");
    assert.equal(existsSync(runtime.requestLog), false, "a Billing rejection must not start the AppServer or send session requests");
    const rejection = lifecycle.lines.find((line) => line.includes("start_plan_entitlement_preflight_rejected"));
    assert.ok(rejection, "the gate must stage a sanitized entitlement rejection classification");
    const detail = JSON.parse(rejection.slice(rejection.indexOf("{"))) as Record<string, unknown>;
    assert.equal(detail.classification, "billing_parameter_error");
    assert.equal(detail.provider_code, "3001");
    assert.equal(JSON.stringify(detail).includes("3001:") || JSON.stringify(detail).toLowerCase().includes("synthetic"), false,
      "the staged diagnostic must stay within the sanitized classification shape");
  }, { runtimeVariant: "private-auth-preflight-reject", issuerFactory: hostIssuerFactory(gate.entitlement), lifecycleCollector: lifecycle, preserveFixtureOnFailure: true });
});

test("missing Start Plan credentials keep the host issuer unavailable without affecting Coding Plan", { timeout: 120_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  let issuerObserved: ProductionAuthIssuer | null | undefined;
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    assert.equal(issuerObserved, null, "missing official credentials must keep the host issuer unavailable");
    const taskId = `host-wired-coding-plan-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: syntheticTask(workspace, taskId) }));
    const interaction = await waitForInteractionRequest(client, taskId);
    const request = interaction.details as Record<string, unknown>;
    const requestId = String(request.request_id ?? (request.payload as Record<string, unknown> | undefined)?.request_id ?? "permission-1");
    contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: { task_id: taskId, request_id: requestId, decision: "allow" } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(gate.checks.length, 0, "Coding Plan must never touch the Start Plan Billing gate");
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(requests.some((message) => message.method === "session/send"), "the Coding Plan path must run the full Worker turn");
  }, { runtimeVariant: "success", issuerFactory: async (runtime, host) => {
    issuerObserved = await createHostStartPlanIssuer({
      env: { ...process.env, HOME: runtime.runtimeRoot, USERPROFILE: runtime.runtimeRoot },
      homeDir: runtime.runtimeRoot, host, signal: new AbortController().signal, entitlement: gate.entitlement,
    });
    return issuerObserved;
  }, preserveFixtureOnFailure: true });
});

// ---- ADR-031 Model Routing v1 — Gate E1 synthetic acceptance ----
// The production wiring under test: per-dispatch issuer discovery through
// startPlanPrivateAuthFactory plus the task-creation routing hook. Synthetic
// credentials only; every Billing call is the controlled fake gate.

function routingEnvIssuerFactory(gate: { entitlement: StartPlanLiveEntitlement }, journal: StartPlanEntitlementJournal,
  loginState: { account: string | null }) {
  return async (runtime: FakeRuntimeFixture, host: BridgeHostProfile): Promise<ProductionAuthIssuer | null> => {
    if (loginState.account) writeHostCredentials(runtime, loginState.account);
    return createHostStartPlanIssuer({
      env: { ...process.env, HOME: runtime.runtimeRoot, USERPROFILE: runtime.runtimeRoot, ZCODE_CREDENTIAL_SECRET: HOST_CREDENTIAL_SECRET },
      homeDir: runtime.runtimeRoot,
      host,
      signal: new AbortController().signal,
      entitlement: gate.entitlement,
      journal,
    });
  };
}

test("ADR-031 Gate E1: a post-startup login is observed by the next dispatch and account switches never cross identities", { timeout: 240_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: null as string | null };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    // Logged out at startup: the plain model routes to Start Plan and the
    // task is refused at creation (pre-intent, ADR-028 semantics), never
    // silently re-routed to Coding Plan.
    const loggedOut = `routing-logged-out-${randomUUID()}`;
    const refusal = await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, loggedOut), model: { model_id: "GLM-5.3-Flash" },
    } });
    assert.equal(refusal.isError, true, "a logged-out Start Plan task must be refused at creation");
    assert.match(JSON.stringify(refusal), /official Start Plan credentials are unavailable/u);
    assert.equal(gate.checks.length, 0, "a missing credential must fail before any Billing request");

    // User logs in inside ZCode: the next task reads the fresh credential.
    loginState.account = HOST_ACCOUNT;
    const loggedIn = `routing-logged-in-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, loggedIn), model: { model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, loggedIn, 1)).status, "completed");
    await waitForLifecycleEvent(client, loggedIn, "released");

    // Account switch: the new task binds to the new account; running tasks
    // keep their bound identity (covered by the private-auth-account-switch
    // lifecycle variant).
    loginState.account = "synthetic-account-b";
    const switched = `routing-account-b-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, switched), model: { model_id: "GLM-5.3-Flash" },
    } }));
    assert.equal((await waitForTerminal(client, switched, 1)).status, "completed");
    await waitForLifecycleEvent(client, switched, "released");

    assert.deepEqual(gate.checks.map(({ account, provider, model, deviceMid }) => ({ account, provider, model, deviceMid })), [
      { account: HOST_ACCOUNT, provider: "account:bigmodel-start-plan", model: "GLM-5.3-Flash", deviceMid: HOST_DEVICE_MID },
      { account: HOST_ACCOUNT, provider: "account:bigmodel-start-plan", model: "GLM-5.3-Flash", deviceMid: HOST_DEVICE_MID },
      { account: "synthetic-account-b", provider: "account:bigmodel-start-plan", model: "GLM-5.3-Flash", deviceMid: HOST_DEVICE_MID },
      { account: "synthetic-account-b", provider: "account:bigmodel-start-plan", model: "GLM-5.3-Flash", deviceMid: HOST_DEVICE_MID },
    ]);
    assert.equal(journal.latest("GLM-5.3-Flash"), "entitled", "live Billing verdicts must feed the routing journal");
    const log = readFileSync(runtime.requestLog, "utf8");
    assert.ok(log.includes("GLM-5.3-Flash"), "the AppServer must receive the raw official model id");
    assert.equal(log.includes("-StartPlan"), false, "the user-visible alias must never reach the AppServer");
    assert.equal(log.includes("synthetic-signature"), false, "the official credential must never appear in app-server traffic");
  }, { runtimeVariant: "private-auth", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031 Gate E1: an explicit -StartPlan alias executes the raw model id over Start Plan", { timeout: 180_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: HOST_ACCOUNT };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `routing-alias-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { model_id: "GLM-5.3-Flash-StartPlan" },
    } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.deepEqual(gate.checks.map(({ account, model }) => ({ account, model })), [
      { account: HOST_ACCOUNT, model: "GLM-5.3-Flash" },
      { account: HOST_ACCOUNT, model: "GLM-5.3-Flash" },
    ]);
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const setModel = requests.find((message) => message.method === "session/setModel") as { params?: { model?: { providerId?: string; modelId?: string } } } | undefined;
    assert.equal(setModel?.params?.model?.modelId, "GLM-5.3-Flash");
    assert.equal(setModel?.params?.model?.providerId, "account:bigmodel-start-plan");
    assert.equal(JSON.stringify(requests).includes("-StartPlan"), false);
  }, { runtimeVariant: "private-auth", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031 Gate E1: a confirmed unavailable verdict falls back to the coding plan provider without Billing", { timeout: 180_000 }, async () => {
  const gate = fakeHostBillingGate("entitled");
  const journal = new StartPlanEntitlementJournal();
  journal.record("GLM-5.3-Flash", "no_entitlement", Date.now());
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace, runtime) => {
    const taskId = `routing-fallback-${randomUUID()}`;
    contentObject(await client.callTool({ name: "zcode_task", arguments: {
      ...syntheticTask(workspace, taskId), model: { model_id: "GLM-5.3-Flash" },
    } }));
    const interaction = await waitForInteractionRequest(client, taskId);
    const request = interaction.details as Record<string, unknown>;
    const requestId = String(request.request_id ?? (request.payload as Record<string, unknown> | undefined)?.request_id ?? "permission-1");
    contentObject(await client.callTool({ name: "zcode_interaction_reply", arguments: { task_id: taskId, request_id: requestId, decision: "allow" } }));
    assert.equal((await waitForTerminal(client, taskId, 1)).status, "completed");
    await waitForLifecycleEvent(client, taskId, "released");
    assert.equal(gate.checks.length, 0, "the execution-time fallback must not consume a Billing request");
    const requests = readFileSync(runtime.requestLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const setModel = requests.find((message) => message.method === "session/setModel") as { params?: { model?: { providerId?: string; modelId?: string } } } | undefined;
    assert.equal(setModel?.params?.model?.providerId, "builtin:bigmodel-coding-plan");
    assert.equal(setModel?.params?.model?.modelId, "GLM-5.3-Flash", "the fallback must keep the same official model id");
  }, { runtimeVariant: "success", routingHooks: { journal }, preserveFixtureOnFailure: true });
});

test("ADR-031 Gate E1: billing rejections never trigger a silent fallback", { timeout: 180_000 }, async () => {
  const gate = fakeHostBillingGate("billing_parameter_error");
  const journal = new StartPlanEntitlementJournal();
  const loginState = { account: HOST_ACCOUNT };
  await withRealAdapterMcp(async (client, _manager, _dataRoot, workspace) => {
    for (const round of [1, 2]) {
      const taskId = `routing-no-fallback-${round}-${randomUUID()}`;
      contentObject(await client.callTool({ name: "zcode_task", arguments: {
        ...syntheticTask(workspace, taskId), model: { model_id: "GLM-5.3-Flash" },
      } }));
      assert.equal((await waitForTerminal(client, taskId, 1)).status, "failed", `round ${round}: an unresolved Billing verdict must not fall back to Coding Plan`);
      await waitForLifecycleEvent(client, taskId, "released");
    }
    assert.equal(gate.checks.length, 2, "each task performs exactly one rejected preflight and no lease delivery");
    assert.equal(journal.latest("GLM-5.3-Flash"), "billing_parameter_error");
  }, { runtimeVariant: "private-auth-preflight-reject", startPlanIssuerPerDispatch: routingEnvIssuerFactory(gate, journal, loginState),
    routingHooks: { journal }, preserveFixtureOnFailure: true });
});
