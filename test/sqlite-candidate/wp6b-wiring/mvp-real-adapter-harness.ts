import assert from "node:assert/strict";

import { test } from "node:test";

import { randomUUID, createHash } from "node:crypto";

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

import type {
  OfficialStartPlanAuthenticationResolver,
  ProductionAuthIssuer,
  StartPlanLiveEntitlement,
} from "../../../src/runtime/start-plan-production-auth.js";

import { initializeIsolatedCandidateRoot, loadLifecycleCandidateModules } from "../../../src/store/lifecycle-gate.js";

import { PrivateCredentialLease } from "../../../src/runtime/start-plan-private-lease.js";

import { createPlatformProbe } from "../../../src/runtime/process-probe.js";

import {
  createTaskModelRouter,
  readStartPlanRoutingRegistry,
  StartPlanEntitlementJournal,
} from "../../../src/runtime/model-routing.js";

import { createBoundedRuntimeEventPublisher } from "../../../src/worker/worker-main.js";

const projectRoot = process.cwd();

const compiledCandidate = path.join(projectRoot, "dist-test", "src", "sqlite-candidate", "wp6b2b1");

const sourceSchema = path.join(projectRoot, "src", "sqlite-candidate", "wp6b2b1", "schema.sql");

const candidateSchema = path.join(compiledCandidate, "schema.sql");

const workerEntryPath = path.join(
  projectRoot,
  "dist-test",
  "test",
  "sqlite-candidate",
  "wp6b-wiring",
  "legacy-direct-worker.js",
);

const officialHostWorkerEntryPath = path.join(
  projectRoot,
  "dist-test",
  "test",
  "sqlite-candidate",
  "wp6b-wiring",
  "official-host-loopback-worker.js",
);

const officialHostCloseFailureWorkerEntryPath = path.join(
  projectRoot,
  "dist-test",
  "test",
  "sqlite-candidate",
  "wp6b-wiring",
  "official-host-close-failure-worker.js",
);

const officialHostStartPlanNoDiscountWorkerEntryPath = path.join(
  projectRoot,
  "dist-test",
  "test",
  "sqlite-candidate",
  "wp6b-wiring",
  "official-host-start-plan-no-discount-worker.js",
);

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
  readonly backpressureLog: string;
  readonly taskInput: string;
  readonly builtinConfig: string;
  readonly personalConfig: string;
  readonly zcodeHomeV2: string;
}

interface LifecycleTimingCollector {
  readonly records: Array<{
    readonly source: "manager" | "lifecycle";
    readonly stage: string;
    readonly at_ms: number;
    readonly detail?: Readonly<Record<string, unknown>>;
  }>;
}

type RuntimeVariant = "success" | "failure" | "stderr-flood" | "stream-flood-stress" | "large-result" | "deadline-success" | "deadline-hang"
  | "facts-turn-failure"
  | "private-auth" | "private-auth-echo" | "private-auth-split-echo"
  | "private-auth-wrong-turn" | "private-auth-wrong-claim"
  | "private-auth-account-switch" | "private-auth-hold" | "private-auth-eof-recheck" | "private-auth-interaction"
  | "private-auth-multi-iteration" | "private-auth-concurrent"
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
  const backpressureLog = path.join(root, "backpressure.json");
  const taskInput = path.join(root, "task-input.json");
  const builtinConfig = path.join(root, "resources", "config", "provider", "zcode-builtin.json");
  const report = JSON.stringify({
    summary: variant === "large-result" ? "中文😀\n\u0000\"".repeat(100_000) : "synthetic MVP real-adapter report",
    files_changed: variant === "large-result" ? Array.from({length:257}, (_,i)=>`文件${i}\n第二行`) : [],
    tests: variant === "large-result" ? [{command:"测试\n命令",status:"passed",details:"\u0000😀"}] : [],
    issues: variant === "large-result" ? ["多行\n"+"x".repeat(5000)] : [],
    needs_master_decision: false,
  });
  const floodSpec = variant === "stderr-flood"
    ? { events: 8, delta: "x".repeat(32 * 1024) }
    : variant === "stream-flood-stress"
      ? { events: 32_000, delta: "x" }
      : null;
  const finishTurn = variant === "failure"
    ? `process.stdout.write(JSON.stringify({ method: "session/event", params: { seq: 1, type: "turn.failed", payload: { error: { message: "synthetic adapter failure" } } } }) + "\\n");`
    : variant === "facts-turn-failure"
    ? `process.stdout.write(JSON.stringify({ method: "session/event", params: { seq: 1, type: "turn.failed", payload: { error: { code: "model_request_failed", type: "model_error", message: "SENTINEL_FF_MESSAGE provider rejected the turn", attribution: { providerErrorCode: "3007", statusCode: 429, retryable: false } } } } }) + "\\n");`
    : variant === "private-auth-split-echo"
    ? [
      `const splitAt = Math.max(1, Math.floor(receivedCredential.length / 2));`,
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 2, turnId: "native-fixture-turn", type: "model.streaming", payload: { kind: "text_start" } } }) + "\\n");`,
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 3, turnId: "native-fixture-turn", type: "model.streaming", payload: { kind: "text_delta", delta: "before " + receivedCredential.slice(0, splitAt) } } }) + "\\n");`,
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 4, turnId: "native-fixture-turn", type: "model.streaming", payload: { kind: "tool_call", toolName: "Bash", toolCallId: "call-split" } } }) + "\\n");`,
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 5, turnId: "native-fixture-turn", type: "tool.updated", payload: { kind: "completed", toolName: "Bash", toolCallId: "call-split" } } }) + "\\n");`,
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 6, turnId: "native-fixture-turn", type: "model.streaming", payload: { kind: "text_delta", delta: receivedCredential.slice(splitAt) + " after" } } }) + "\\n");`,
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 7, turnId: "native-fixture-turn", type: "turn.completed", payload: { response: ${JSON.stringify(report)}, usage: { totalTokens: 4 }, resultType: "success" } } }) + "\\n");`,
    ].join("\n")
    : [
      `const task = JSON.parse(fs.readFileSync(${JSON.stringify(taskInput)}, "utf8"));`,
      `const report = ${JSON.stringify(report)}.replace("TASK_ID", task.task_id)${variant === "private-auth-echo" ? '.replace("synthetic MVP real-adapter report", "echo " + receivedCredential)' : ''};`,
      ...(floodSpec ? [
        // The ordinary gate emits eight large writes (more than the OS pipe
        // capacity) to prove backpressure without paying the per-event cost of
        // thousands of tiny lines. The stress entry retains the former
        // 32,000-event shape.
        `const floodStartedAt = performance.now();`,
        `let writeFalseCount = 0;`,
        `let maxWritableLength = 0;`,
        `let bytesWritten = 0;`,
        `for (let seq = 5; seq <= ${4 + floodSpec.events}; seq++) {`,
        `  const line = JSON.stringify({ method: "session/event", params: { seq, type: "model.streaming", payload: { kind: "text_delta", delta: ${JSON.stringify(floodSpec.delta)} } } }) + "\\n";`,
        `  bytesWritten += Buffer.byteLength(line, "utf8");`,
        `  if (!process.stdout.write(line)) writeFalseCount += 1;`,
        `  maxWritableLength = Math.max(maxWritableLength, process.stdout.writableLength);`,
        `}`,
        `fs.writeFileSync(${JSON.stringify(backpressureLog)}, JSON.stringify({ events_written: ${floodSpec.events}, delta_bytes: Buffer.byteLength(${JSON.stringify(floodSpec.delta)}, "utf8"), bytes_written: bytesWritten, flood_elapsed_ms: performance.now() - floodStartedAt, high_water_mark: process.stdout.writableHighWaterMark, max_writable_length: maxWritableLength, write_false_count: writeFalseCount }));`,
      ] : []),
      `process.stdout.write(JSON.stringify({ method: "session/event", params: { seq: ${variant.startsWith("private-auth") ? 2 : floodSpec ? 5 + floodSpec.events : 5}, ${variant.startsWith("private-auth") ? 'sessionId, turnId: "native-fixture-turn",' : ''} type: "turn.completed", payload: { response: report, usage: { totalTokens: 4 }, resultType: "success" } } }) + "\\n");`,
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
    `let firstAuthCredential = null;`,
    `let authResponses = 0;`,
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
    `  if (!/^private-auth-(rpc|recheck)/.test(String(message.id))) fs.appendFileSync(requestLog, JSON.stringify(message) + "\\n");`,
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
      `    for (const rpcId of ${JSON.stringify(variant === "private-auth-concurrent" ? ["private-auth-rpc", "private-auth-rpc-2"] : ["private-auth-rpc"])}) process.stdout.write(JSON.stringify({ id: rpcId, method: "interaction/requestProviderRuntimeHeaders", params: { sessionId, turnId: ${JSON.stringify(variant === "private-auth-wrong-turn" ? "other-turn" : "native-fixture-turn")}, modelSelection: selected } }) + "\\n");`,
      `    return;`,
    ] : []),
    `    if (${variant === "deadline-hang"}) return;`,
    `    if (${variant !== "failure" && variant !== "facts-turn-failure" && !variant.startsWith("deadline-")} && !interactionSent) {`,
    `      interactionSent = true;`,
    `      process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 1, turnId: "native-fixture-turn", type: "model.streaming", payload: { kind: "text_start" } } }) + "\\n");`,
    `      process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 2, turnId: "native-fixture-turn", type: "model.streaming", payload: { kind: "text_delta", delta: "a" + "🙂".repeat(1001) + " Synthetic visible output before tool use." } } }) + "\\n");`,
    `      process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 3, turnId: "native-fixture-turn", type: "model.streaming", payload: { kind: "tool_call", toolName: "Bash", toolCallId: "call-1" } } }) + "\\n");`,
    `      process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 4, turnId: "native-fixture-turn", type: "tool.updated", payload: { kind: "completed", toolName: "Bash", toolCallId: "call-1" } } }) + "\\n");`,
    `      for (const rpcId of ["interaction-rpc-1", "interaction-rpc-2"]) {`,
    `        process.stdout.write(JSON.stringify({ id: rpcId, method: "interaction/requestPermission", params: { requestId: "permission-1", sessionId, toolCallId: "call-1", toolName: "Bash", reason: "Run the synthetic build command", input: { command: "npm run build" }, options: [{ kind: "allow_once" }, { kind: "deny" }] } }) + "\\n");`,
    `      }`,
    `      return;`,
    `    }`,
    `    finishTurn();`,
    `  } else if (message.id === "private-auth-rpc" || message.id === "private-auth-rpc-2") {`,
    `    receivedCredential = message.result?.requestAuth?.apiKey;`,
    `    const applied = message.result?.headersApplied === true && typeof receivedCredential === "string" && receivedCredential.length > 0;`,
    `    const sameCredential = firstAuthCredential === null || firstAuthCredential === receivedCredential;`,
    `    if (firstAuthCredential === null) firstAuthCredential = receivedCredential;`,
    `    authResponses += 1;`,
    `    fs.appendFileSync(requestLog, JSON.stringify({ auth_applied: applied, same_credential: sameCredential }) + "\\n");`,
    `    if (applied) {`,
    `      ${variant === "private-auth-multi-iteration"
      ? 'if (message.id === "private-auth-rpc") { process.stdout.write(JSON.stringify({ id: "interaction-rpc-1", method: "interaction/requestPermission", params: { requestId: "permission-1", sessionId, toolCallId: "call-1", toolName: "Write", reason: "Synthetic continuation after a tool call", input: { path: "STARTPLAN_E2E.txt" }, options: [{ kind: "allow_once" }, { kind: "deny" }] } }) + "\\n"); return; } finishTurn();'
      : variant === "private-auth-concurrent"
        ? "if (authResponses === 2) finishTurn();"
        : variant === "private-auth-hold" || variant === "private-auth-eof-recheck"
          ? ""
          : variant === "private-auth-interaction"
            ? 'process.stdout.write(JSON.stringify({ id: "interaction-rpc-1", method: "interaction/requestPermission", params: { requestId: "permission-1", sessionId, toolCallId: "call-1", toolName: "Bash", reason: "echo " + receivedCredential, input: { command: "echo " + receivedCredential }, options: [{ kind: "allow_once" }, { kind: "deny" }] } }) + "\\n");'
            : "finishTurn();"}`,
    `    }`,
    ...(variant === "private-auth-eof-recheck" ? [`    if (message.result?.headersApplied === true) { const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(path.join(root, "recheck-trigger"))})) return; clearInterval(timer); process.stdout.write(JSON.stringify({ id: "private-auth-recheck", method: "interaction/requestProviderRuntimeHeaders", params: { sessionId, turnId: "native-fixture-turn", modelSelection: selected } }) + "\\n"); }, 20); }`] : []),
    `    else process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 2, turnId: "native-fixture-turn", type: "turn.failed", payload: { error: { message: "synthetic private auth rejected" } } } }) + "\\n");`,
    `  } else if (message.id === "private-auth-recheck") {`,
    `    fs.appendFileSync(requestLog, JSON.stringify({ recheck_auth_applied: message.result?.headersApplied === true }) + "\\n");`,
    `    process.stdout.write(JSON.stringify({ method: "session/event", params: { sessionId, seq: 2, turnId: "native-fixture-turn", type: "turn.failed", payload: { error: { message: "synthetic recheck complete" } } } }) + "\\n");`,
    `  } else if (message.id === "interaction-rpc-1" || message.id === "interaction-rpc-2") {`,
    `    if (message.result && message.result.decision) ${variant === "private-auth-multi-iteration"
      ? 'process.stdout.write(JSON.stringify({ id: "private-auth-rpc-2", method: "interaction/requestProviderRuntimeHeaders", params: { sessionId, turnId: "native-fixture-turn", modelSelection: selected } }) + "\\n");'
      : "finishTurn();"}`,
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
        config: { builtinModelIds: ["GLM-5.3-Flash", "GLM-5-Air"], access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" } },
      }, {
        // The installed 3.18.2 registry exposes Coding Plan through its
        // account-backed Provider ID. Keep it first so routing exercises the
        // current official identity rather than a legacy compatibility alias.
        providerId: "account:bigmodel-individual-coding-plan",
        config: { builtinModelIds: ["GLM-5.3-Flash"], access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "bigmodel" } },
        // Legacy compatibility alias retained for explicit-provider tests.
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
  return { entrypoint, runtimeRoot: root, requestLog, exitLog, backpressureLog, taskInput, builtinConfig, personalConfig: path.join(zcodeHomeV2, "provider_config.json"), zcodeHomeV2 };
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

async function waitForTerminal(
  client: Client,
  taskId: string,
  expectedAttempt: number,
  timeoutMs = 45_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
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
  // Release follows the production bounded close/probe/tree-scan sequence
  // (15s + 5s + 30s) plus persistence. A 45s test wait was shorter than the
  // contract it was observing and could fail even when cleanup was progressing.
  const deadline = Date.now() + 75_000;
  let observed: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    const page = contentObject(await client.callTool({ name: "zcode_events", arguments: { task_id: taskId, after_seq: 0, limit: 200 } }));
    const events = Array.isArray(page.events) ? page.events as Array<Record<string, unknown>> : [];
    observed = events;
    if (events.some((event) => event.type === eventType)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let status = "unavailable";
  try {
    const current = contentObject(await client.callTool({ name: "zcode_status", arguments: { task_id: taskId } }));
    status = JSON.stringify({
      status: current.status,
      attempt: current.attempt,
      phase: current.phase,
      issues: current.issues,
    });
  } catch { /* preserve the primary timeout failure */ }
  const eventTrail = observed.map((event) => `${String(event.type)}@${String(event.seq)}`).join(" -> ");
  throw new Error(`lifecycle event ${eventType} was not observed for ${taskId}; status=${status}; events=${eventTrail}`);
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
    readonly lifecycleTimings?: LifecycleTimingCollector;
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
      const lifecycleStartedAt = performance.now();
      const recordLifecycleTiming = (
        source: "manager" | "lifecycle",
        stage: string,
        detail?: Readonly<Record<string, unknown>>,
      ): void => {
        options.lifecycleTimings?.records.push({
          source,
          stage,
          at_ms: performance.now() - lifecycleStartedAt,
          ...(detail ? { detail } : {}),
        });
      };
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
          recordLifecycleTiming("manager", stage, detail);
        },
        onStage: (stage, detail) => {
          options.lifecycleCollector?.lines.push(`[bridge-lifecycle] ${stage} ${JSON.stringify(detail ?? {})}`);
          recordLifecycleTiming("lifecycle", stage, detail);
        },
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
    if (process.env["MVP_REAL_ADAPTER_TIMINGS"] === "1" && options.lifecycleTimings?.records.length) {
      console.error("MVP_REAL_ADAPTER_LIFECYCLE_TIMINGS " + JSON.stringify(options.lifecycleTimings.records));
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

// Only test fixtures change data generation/timing; production Spawner, Adapter,
// Manager, CAS, SQLite, process identity and cleanup implementation remain real.
async function deadlineWorker(name: string, mode: 'budget'|'execution-timeout'|'late-cleanup'|'late-close'|'no-result'|'blocked-envelope'):Promise<string>{
  mkdirSync(fixtureRoot,{recursive:true});const outfile=path.join(fixtureRoot,`r3-${name}.mjs`);
  await build({entryPoints:[path.join(projectRoot,'src/worker/worker-main.ts')],outfile,bundle:true,platform:'node',format:'esm',target:'node24',packages:'external',logLevel:'silent',plugins:[{name:'r3-controlled-lifecycle',setup(b){
    b.onLoad({filter:/worker-main\.ts$/},async args=>{
      let source=readFileSync(args.path,'utf8').replaceAll('\r\n','\n');
      source=source.replace(
        'if (invokedWorkerPath === modulePath) await runWorkerMain();',
        'if (invokedWorkerPath === modulePath) await runWorkerMain({ testOnlyLegacyDirectAdapter: true });',
      );
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

// Host composition layer: these tests build the Start Plan issuer exactly
// the way the production stdio host does (createHostStartPlanIssuer) and
// prove the wiring reaches the SQLite gate with a controlled fake Billing
// gate. A test-only Host resolver supplies synthetic authentication; no
// network, keyring access, credential-file parsing or real account is used.
const HOST_ACCOUNT = "synthetic-account";

const HOST_DEVICE_MID = "synthetic-host-device-mid";

const HOST_CREDENTIAL_EXPIRES_AT = (Math.floor(Date.now() / 1000) + 3_600) * 1_000;

function syntheticHostJwt(account: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: "synthetic" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ account, exp: HOST_CREDENTIAL_EXPIRES_AT / 1_000 }), "utf8").toString("base64url"),
    "synthetic-signature",
  ].join(".");
}

const HOST_JWT = syntheticHostJwt(HOST_ACCOUNT);

function hostAuthenticationResolver(
  readAccount: () => string | null,
): OfficialStartPlanAuthenticationResolver {
  return {
    resolveStartPlanAuthentication: async () => {
      const account = readAccount();
      if (!account) return null;
      return {
        accountIdentity: account,
        sessionRevision: `synthetic-session-${account}`,
        requestCredential: syntheticHostJwt(account),
        credentialExpiresAt: HOST_CREDENTIAL_EXPIRES_AT,
        deviceMid: HOST_DEVICE_MID,
      };
    },
  };
}

function fakeHostBillingGate(outcome: "entitled" | "billing_parameter_error") {
  const checks: Array<{ account: string; provider: string; model: string; deviceMid: string }> = [];
  const entitlement: StartPlanLiveEntitlement = {
    check: async (input) => {
      checks.push({ account: input.account, provider: input.provider, model: input.model, deviceMid: input.deviceMid });
      return outcome === "entitled"
        ? { status: "entitled", observedAt: checks.length, requestId: `synthetic-${checks.length}` }
        : {
            status: "billing_parameter_error",
            reason: "synthetic billing parameter rejection",
            providerCode: "3001",
            observedAt: checks.length,
            failureFacts: {
              request_attempted: true,
              http_status: 200,
              provider_code: "3001",
              failure_class: "billing_parameter_error",
              entitlement_verdict: "unavailable",
            },
          };
    },
  };
  return { checks, entitlement };
}

function hostIssuerFactory(entitlement: StartPlanLiveEntitlement, options: { writeCredentials?: boolean } = {}) {
  return async (runtime: FakeRuntimeFixture, host: BridgeHostProfile): Promise<ProductionAuthIssuer | null> => {
    return createHostStartPlanIssuer({
      env: { ...process.env, HOME: runtime.runtimeRoot, USERPROFILE: runtime.runtimeRoot },
      homeDir: runtime.runtimeRoot,
      host,
      signal: new AbortController().signal,
      entitlement,
      authentication: hostAuthenticationResolver(() => options.writeCredentials === false ? null : HOST_ACCOUNT),
    });
  };
}

// ---- ADR-031 Model Routing v1 — Gate E1 synthetic acceptance ----
// The production wiring under test: per-dispatch issuer discovery through
// startPlanPrivateAuthFactory plus the task-creation routing hook. Synthetic
// credentials only; every Billing call is the controlled fake gate.

function routingEnvIssuerFactory(gate: { entitlement: StartPlanLiveEntitlement }, journal: StartPlanEntitlementJournal,
  loginState: { account: string | null }) {
  return async (runtime: FakeRuntimeFixture, host: BridgeHostProfile): Promise<ProductionAuthIssuer | null> => {
    return createHostStartPlanIssuer({
      env: { ...process.env, HOME: runtime.runtimeRoot, USERPROFILE: runtime.runtimeRoot },
      homeDir: runtime.runtimeRoot,
      host,
      signal: new AbortController().signal,
      entitlement: gate.entitlement,
      journal,
      authentication: hostAuthenticationResolver(() => loginState.account),
    });
  };
}

export {
  FakeRuntimeFixture, RuntimeVariant, LifecycleTimingCollector, projectRoot, compiledCandidate, sourceSchema, candidateSchema, workerEntryPath, officialHostWorkerEntryPath, officialHostCloseFailureWorkerEntryPath, officialHostStartPlanNoDiscountWorkerEntryPath, fixtureRoot, writeFakeRuntime, contentObject, syntheticTask, waitForTerminal, waitForEvent, waitForLifecycleEvent, waitForInteractionRequest, withRealAdapterMcp, schema, copyFileSync, deadlineWorker, operationFor, HOST_ACCOUNT, HOST_DEVICE_MID, HOST_CREDENTIAL_EXPIRES_AT, syntheticHostJwt, HOST_JWT, hostAuthenticationResolver, fakeHostBillingGate, hostIssuerFactory, routingEnvIssuerFactory,
};
