// ADR-011 Adapter integration tests: the frozen FailureFactsV1 contract exercised
// through the real ZCodeAppServerAdapter against fake app-server runtimes, the
// direct private facts callback and shared Result normalization — never pure
// functions alone. Covers the VALIDATION_PLAN A/S/R/P/F/L/D scenarios; the
// Q/T/D2 classifier matrix lives in test/failure-facts.test.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { buildTaskResult } from "../src/manager/normalize.js";
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import { type FailureFactsV1 } from "../src/diagnostics/failure-facts.js";
import { formatWorkerFailureFactsLine } from "../src/host/stdio.js";
import { BridgeError } from "../src/runtime/errors.js";
import type { TaskPackage, ZCodeRuntimeConfig } from "../src/interfaces.js";
import type { ZCodeRunOutcome } from "../src/adapters/run-outcome.js";
import { SESSION_ID, makeTask, validReport } from "./helpers.js";

const TASK_ID = "facts_integration";

test("M1: a competing turn failure cannot replace the selected session/send RPC rejection", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({
    sendRpcError: { code: -32603, dataCode: "model_not_found" },
    turnAfterRpcRejection: { code: "insufficient_quota" },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({ fixture, resolver: { resolve: async () => runtime.config } });
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts.source, "rpc");
    assert.equal(facts.rpc_data_code, "model_not_found");
    assert.equal(facts.category, "unknown");
  } finally { await runtime.cleanup(); }
});

test("D1b: unknown resultType and invalid protocol frames never expose upstream text", { timeout: 30_000 }, async () => {
  const sentinel = "SENTINEL_UPSTREAM_PAYLOAD_SECRET";
  for (const options of [{ turnResultType: sentinel }, { malformedFrame: `invalid-json-${sentinel}` }]) {
    const runtime = await makeFakeRuntime(options);
    const fixture = makeAdapterFixture(runtime.root);
    try {
      const run = await runAdapter({ fixture, resolver: { resolve: async () => runtime.config } });
      assert.equal(run.result.status, "failed");
      assertNoSentinel(run.result, sentinel);
      assertNoSentinel(fixture.events, sentinel);
      assertNoSentinel(fixture.facts, sentinel);
      assert.equal(run.result.error_code, "turnResultType" in options ? "unknown_turn_terminal" : "zcode_nonzero_exit");
    } finally { await runtime.cleanup(); }
  }
});

// ---- Fake app-server runtime ------------------------------------------------

interface FakeRuntimeOptions {
  accountSyncError?: unknown;
  accountSyncExitCode?: number;
  preSendReject?: { method: "session/create" | "session/resume"; code?: number; dataCode?: string | null; dataMessage?: string };
  sendAck?: boolean;
  sendRpcError?: { code?: number; dataCode?: string | null };
  sideEffectFile?: string;
  exitAfterSendMs?: { delayMs: number; code: number };
  turnFailure?: unknown;
  turnFailureOnSends?: number[];
  turnStartOnSend?: boolean;
  coalesceSendAckWithTurnStart?: boolean;
  turnId?: string;
  turnResultType?: string;
  completeDelayMs?: number;
  interaction?: boolean;
  failAfterDeny?: unknown;
  replayUnsupported?: boolean;
  preSendEvents?: unknown[];
  snapshotEventSeq?: number;
  echoFile?: string;
  reportOverride?: string;
  malformedFrame?: string;
  turnAfterRpcRejection?: unknown;
}

async function makeFakeRuntime(options: FakeRuntimeOptions = {}, overrides: { nodeExecutable?: string } = {}): Promise<{
  root: string;
  config: ZCodeRuntimeConfig;
  requestLog: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-facts-runtime-"));
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const requestLog = path.join(root, "requests.jsonl");
  const script = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const sessionId = ${JSON.stringify(SESSION_ID)};
const requestLog = ${JSON.stringify(requestLog)};
const opts = ${JSON.stringify(options)};
const report = ${JSON.stringify(validReport())};
let turnFinished = false;
let sendNumber = 0;
let nextEventSeq = 89;
let currentTurnId = null;
const sleep = (ms) => { const b = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(b, 0, 0, ms); };
function emit(params) { process.stdout.write(JSON.stringify({ method: "session/event", params }) + "\n"); }
function snapshot() {
  return {
    session: { sessionId },
    settings: { model: { current: { providerId: "provider-default", modelId: "model-default" }, available: [{ ref: { providerId: "provider-default", modelId: "model-default" }, label: "Test Model" }] } },
    runtime: { eventSeq: opts.snapshotEventSeq || 0 },
  };
}
function finishTurn() {
  if (turnFinished) return;
  turnFinished = true;
  const shouldFail = opts.turnFailureOnSends
    ? opts.turnFailureOnSends.includes(sendNumber)
    : opts.turnFailure !== undefined;
  if (shouldFail) {
    emit({ seq: ++nextEventSeq, sessionId, ...(currentTurnId ? { turnId: currentTurnId } : {}), type: "turn.failed", payload: { error: opts.turnFailure } });
    return;
  }
  const resultType = opts.turnResultType || "success";
  emit({ seq: ++nextEventSeq, type: "turn.completed", payload: { response: opts.reportOverride === undefined ? JSON.stringify(report) : opts.reportOverride, usage: { totalTokens: 4 }, resultType } });
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLog, JSON.stringify({ ...message, received_at: Date.now() }) + "\n");
  if (message.method === "session/create" || message.method === "session/resume") {
    if (opts.preSendReject && opts.preSendReject.method === message.method) {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: opts.preSendReject.code === undefined ? -32603 : opts.preSendReject.code, data: { code: opts.preSendReject.dataCode === undefined ? null : opts.preSendReject.dataCode, message: opts.preSendReject.dataMessage === undefined ? "rejected" : opts.preSendReject.dataMessage } } }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\n");
  } else if (message.method === "provider/updateAccountConfig") {
    if (opts.accountSyncExitCode !== undefined) process.exit(opts.accountSyncExitCode);
    else if (opts.accountSyncError) process.stdout.write(JSON.stringify({ id: message.id, error: opts.accountSyncError }) + "\n");
    else process.stdout.write(JSON.stringify({ id: message.id, result: { status: "ok" } }) + "\n");
  } else if (message.method === "session/setModel" || message.method === "session/setMode" || message.method === "session/subscribe") {
    process.stdout.write(JSON.stringify({ id: message.id, result: message.method === "session/setModel" ? snapshot() : {} }) + "\n");
  } else if (message.method === "session/events") {
    if (opts.replayUnsupported) process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported ZCode app-server request: session/events" } }) + "\n");
    else process.stdout.write(JSON.stringify({ id: message.id, result: { events: [] } }) + "\n");
  } else if (message.method === "session/send") {
    sendNumber += 1;
    turnFinished = false;
    currentTurnId = null;
    if (opts.sideEffectFile) { try { fs.writeFileSync(opts.sideEffectFile, "written-by-runtime\n"); } catch (error) {} }
    if (opts.sendAck === false) {
      // no reply: the ACK is dropped
    } else if (opts.sendRpcError) {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: opts.sendRpcError.code === undefined ? -32603 : opts.sendRpcError.code, data: { code: opts.sendRpcError.dataCode === undefined ? null : opts.sendRpcError.dataCode } } }) + "\n");
      if (opts.turnAfterRpcRejection) emit({ seq: 90, type: "turn.failed", payload: { error: opts.turnAfterRpcRejection } });
      return;
    } else if (opts.turnStartOnSend && opts.coalesceSendAckWithTurnStart) {
      // Coalescing mimics hosted CI transports where the ACK and first event
      // are delivered to Node in one stdout chunk before the send microtask.
      currentTurnId = opts.turnId || "turn-fixture-" + sendNumber;
      process.stdout.write([
        JSON.stringify({ id: message.id, result: {} }),
        JSON.stringify({ method: "session/event", params: { seq: ++nextEventSeq, sessionId, type: "turn.started", payload: { turnId: currentTurnId } } }),
      ].join("\n") + "\n");
    } else {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
    }
    if (opts.malformedFrame) { process.stdout.write(opts.malformedFrame + "\n"); return; }
    if (opts.turnStartOnSend && !opts.coalesceSendAckWithTurnStart) {
      currentTurnId = opts.turnId || "turn-fixture-" + sendNumber;
      emit({ seq: ++nextEventSeq, sessionId, type: "turn.started", payload: { turnId: currentTurnId } });
    }
    for (const params of opts.preSendEvents || []) emit(params);
    if (opts.echoFile) {
      let echo = null;
      for (let i = 0; i < 60 && !echo; i += 1) {
        try { echo = fs.readFileSync(opts.echoFile, "utf8").trim() || null; } catch (error) {}
        if (!echo) sleep(50);
      }
      if (echo) emit({ seq: 45, sessionId, type: "turn.started", payload: { turnId: "turn-fixture", correlation: { submit_id: echo } } });
    }
    if (opts.interaction) {
      process.stdout.write(JSON.stringify({ id: "interaction-rpc-1", method: "interaction/requestPermission", params: { requestId: "permission-1", sessionId, toolCallId: "call-1", toolName: "Bash", reason: "run a test command", input: { command: "echo hi" }, options: [{ kind: "allow_once" }, { kind: "deny" }] } }) + "\n");
      return;
    }
    if (opts.exitAfterSendMs) { setTimeout(() => process.exit(opts.exitAfterSendMs.code), opts.exitAfterSendMs.delayMs); return; }
    const delay = opts.completeDelayMs || 0;
    if (delay > 0) setTimeout(finishTurn, delay);
    else finishTurn();
  } else if (message.id === "interaction-rpc-1") {
    if (message.result && message.result.decision === "deny" && opts.failAfterDeny !== undefined) {
      emit({ seq: 90, type: "turn.failed", payload: { error: opts.failAfterDeny } });
      return;
    }
    if (message.result && message.result.decision) finishTurn();
  } else if (message.method === undefined) {
    // a late duplicate reply — ignore
  } else {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
  }
});
`;
  await writeFile(entrypoint, script, "utf8");
  const personal = path.join(root, "personal.json");
  const builtin = path.join(root, "builtin.json");
  await writeFile(builtin, JSON.stringify({ config: {} }), "utf8");
  await writeFile(personal, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: "fake" }] } } }), "utf8");
  return {
    root,
    requestLog,
    config: {
      nodeExecutable: overrides.nodeExecutable ?? process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: builtin,
      providerPersonalConfigFile: personal,
      zcodeDataRoot: path.join(root, "zcode-data"),
      dataRoot: root,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// Same layout the runtime resolver produces for the account-sync path; used by
// the F1/F2 scenarios so provider/updateAccountConfig is actually sent.
async function withAccountSyncLayout(runtime: { root: string; config: ZCodeRuntimeConfig }): Promise<ZCodeRuntimeConfig> {
  const v2 = path.join(runtime.root, ".zcode", "v2");
  await mkdir(v2, { recursive: true });
  const personal = path.join(v2, "provider_config.json");
  await writeFile(personal, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: "fake" }] } } }), "utf8");
  await writeFile(runtime.config.providerBuiltinConfigFile, JSON.stringify({
    revision: 1,
    config: { providerConfigRules: { providerRules: [{ providerId: "account:fixture", config: { access: { type: "zhipu-account" } } }] } },
  }), "utf8");
  return {
    ...runtime.config,
    providerPersonalConfigFile: personal,
    zcodeDataRoot: path.join(runtime.root, ".zcode"),
  };
}

async function withStartPlanAccountSyncLayout(
  runtime: { root: string; config: ZCodeRuntimeConfig },
  modelId: string,
): Promise<ZCodeRuntimeConfig> {
  const v2 = path.join(runtime.root, ".zcode", "v2");
  await mkdir(v2, { recursive: true });
  const personal = path.join(v2, "provider_config.json");
  await writeFile(personal, JSON.stringify({ config: { providerConfigRules: { providerRules: [] } } }), "utf8");
  await writeFile(runtime.config.providerBuiltinConfigFile, JSON.stringify({
    revision: 1,
    config: { providerConfigRules: { providerRules: [{
      providerId: "account:bigmodel-start-plan",
      config: {
        builtinModelIds: [modelId],
        access: { type: "zhipu-account", mode: "start-plan", accountType: "bigmodel" },
      },
    }] } },
  }), "utf8");
  return {
    ...runtime.config,
    providerPersonalConfigFile: personal,
    zcodeDataRoot: path.join(runtime.root, ".zcode"),
  };
}

// ---- Direct Adapter fixture -------------------------------------------------

interface AdapterFixture {
  task: TaskPackage;
  attempt: number;
  facts: FailureFactsV1 | null;
  events: Array<{type: string; summary: string; details?: Record<string, unknown>}>;
}
function makeAdapterFixture(workspace: string): AdapterFixture {
  return {task: makeTask({task_id: TASK_ID, workspace, model: {provider_id:"provider-default",model_id:"model-default"}, timeout_ms:60_000}), attempt:1, facts:null, events:[]};
}
async function runAdapter(options: {
  fixture: AdapterFixture;
  resolver: import("../src/interfaces.js").RuntimeResolver;
  startPlanProviderEntitled?: boolean;
  resolveStartPlanRuntimeAuth?: () => Promise<never>;
}) {
  const fixture=options.fixture;
  const startedAt=new Date().toISOString();
  let outcome: ZCodeRunOutcome | null=null;
  let failure: {code:string;message:string} | null=null;
  const adapter=new ZCodeAppServerAdapter({resolver:options.resolver, timeoutMs:fixture.task.timeout_ms,
    childEnvBase:{PATH:process.env.PATH},homeDir:fixture.task.workspace,
    onEvent:event=>fixture.events.push(event),onFailureFacts:facts=>{fixture.facts=facts;},
    onOutcomeCheckpoint:value=>{outcome=value;},
    startPlanProviderEntitled:options.startPlanProviderEntitled,
    resolveStartPlanRuntimeAuth:options.resolveStartPlanRuntimeAuth});
  try {
    const handle=await adapter.startTask({task:fixture.task,attempt:fixture.attempt,workspace:{requestedPath:fixture.task.workspace,canonicalPath:fixture.task.workspace,mode:"direct"}});
    outcome=await adapter.getResult(handle);
  } catch(error) {
    failure={code:error instanceof BridgeError?error.code:"worker_error",message:error instanceof Error?error.message:String(error)};
  }
  return {result:buildTaskResult({task:fixture.task,attempt:fixture.attempt,startedAt,finishedAt:new Date().toISOString(),outcome,failure})};
}

async function readRequestLog(requestLog: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(requestLog, "utf8");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

function assertNoSentinel(value: unknown, sentinel: string): void {
  const text = JSON.stringify(value) ?? "";
  assert.ok(!text.includes(sentinel), `output must not contain the sentinel ${sentinel}: ${text.slice(0, 500)}`);
}

// ---- Q-scenarios through the real adapter and worker ------------------------

test("Q1+Q4: explicit quota business code with HTTP 429 keeps zcode_usage_exhausted and confirmed private facts", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: {
      code: "insufficient_quota",
      type: "model_error",
      message: "provider reported the end of the quota",
      attribution: { providerErrorCode: "insufficient_quota", statusCode: 429, retryable: false },
    },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "zcode_usage_exhausted");
    assert.match(run.result.summary, /额度已耗尽/);
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.category, "quota_exhausted");
    assert.equal(facts!.confidence, "confirmed");
    assert.equal(facts!.provider_code, "insufficient_quota");
    assert.equal(facts!.http_status, 429);
    assert.equal(facts!.runtime_retryable, false);
    assert.equal(facts!.runtime_retryable_basis, "reported");
    assert.equal(facts!.phase, "turn_terminal");
    assert.equal(facts!.source, "turn_event");
    assert.equal(facts!.accepted_before_error, "yes");
  } finally {
    await runtime.cleanup();
  }
});

test("Q2: rate_limit_error with per-minute quota text is rate_limited publicly and privately (false-positive fix)", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: {
      code: "rate_limit_error",
      type: "model_rate_limited",
      message: "Quota exceeded for this minute; retry later",
    },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    const facts = fixture.facts;
    assert.equal(facts!.category, "rate_limited");
    assert.equal(facts!.confidence, "confirmed");
    assert.equal(facts!.error_code, "rate_limit_error");
    assert.equal(facts!.provider_code, null);
  } finally {
    await runtime.cleanup();
  }
});

test("A1: a pre-send session/create rejection records accepted=no with the RPC candidate, and no sentinel text", { timeout: 30_000 }, async () => {
  const sentinel = "SENTINEL_A1_rpc_message";
  const runtime = await makeFakeRuntime({
    preSendReject: { method: "session/create", code: -32603, dataCode: "provider_not_found", dataMessage: `rejected: ${sentinel}` },
  });
  const fixture = makeAdapterFixture(runtime.root);
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      onFailureFacts: (facts) => {
        fixture.facts = facts;
      },
      timeoutMs: 20_000,
      childEnvBase: { PATH: process.env.PATH },
      homeDir: runtime.root,
    });
    const handle = await adapter.startTask({ task: fixture.task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
    await assert.rejects(adapter.getResult(handle), (error: unknown) => error instanceof BridgeError && error.code === "zcode_nonzero_exit");
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.source, "rpc");
    assert.equal(facts!.phase, "pre_send");
    assert.equal(facts!.accepted_before_error, "no");
    assert.equal(facts!.rpc_method, "session/create");
    assert.equal(facts!.rpc_code, -32603);
    assert.equal(facts!.rpc_data_code, "provider_not_found");
    assert.equal(facts!.category, "unknown");
    assertNoSentinel(facts, sentinel);
    assertNoSentinel(events, sentinel);
    // The public error event keeps a bounded Bridge-built message.
    const errorEvent = events.find((event) => event.type === "error");
    assert.ok(errorEvent);
    assertNoSentinel(errorEvent, sentinel);
  } finally {
    await runtime.cleanup();
  }
});

test("A1b: Start Plan registration RPC rejection preserves structured private facts without upstream text", { timeout: 30_000 }, async () => {
  const sentinel = "SENTINEL_A1B_registration_message";
  const modelId = "GLM-5.3-Flash";
  const runtime = await makeFakeRuntime({
    accountSyncError: {
      code: -32603,
      message: sentinel,
      data: { code: "provider_not_configured", message: sentinel },
    },
  });
  const config = await withStartPlanAccountSyncLayout(runtime, modelId);
  const fixture = makeAdapterFixture(runtime.root);
  fixture.task = {
    ...fixture.task,
    model: { provider_id: "account:bigmodel-start-plan", model_id: modelId },
  };
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => config },
      startPlanProviderEntitled: true,
      resolveStartPlanRuntimeAuth: async () => { throw new Error("registration failure must precede private auth"); },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "provider_config_invalid");
    const facts = fixture.facts;
    assert.ok(facts, JSON.stringify({ result: run.result, events: fixture.events }));
    assert.equal(facts.source, "rpc");
    assert.equal(facts.phase, "pre_send");
    assert.equal(facts.rpc_method, "provider/updateAccountConfig");
    assert.equal(facts.rpc_code, -32603);
    assert.equal(facts.rpc_data_code, "provider_not_configured");
    const syncFailure = fixture.events.find((event) => event.type === "account_provider_sync_failed");
    assert.ok(syncFailure);
    assert.deepEqual(syncFailure.details, {
      failure_stage: "provider_registration",
      failure_kind: "RPC_REJECTED",
      rpc_method: "provider/updateAccountConfig",
      rpc_error_code: -32603,
      rpc_data_code: "provider_not_configured",
    });
    assertNoSentinel(run.result, sentinel);
    assertNoSentinel(fixture.events, sentinel);
    assertNoSentinel(facts, sentinel);
    const methods = (await readRequestLog(runtime.requestLog)).map((item) => item["method"]);
    assert.equal(methods.includes("provider/updateAccountConfig"), true);
    assert.equal(methods.includes("session/create"), false);
    assert.equal(methods.includes("session/send"), false);
  } finally {
    await runtime.cleanup();
  }
});

test("A1c: Start Plan registration app-server exit is distinct from an RPC rejection", { timeout: 30_000 }, async () => {
  const modelId = "GLM-5.3-Flash";
  const runtime = await makeFakeRuntime({ accountSyncExitCode: 0 });
  const config = await withStartPlanAccountSyncLayout(runtime, modelId);
  const fixture = makeAdapterFixture(runtime.root);
  fixture.task = {
    ...fixture.task,
    model: { provider_id: "account:bigmodel-start-plan", model_id: modelId },
  };
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => config },
      startPlanProviderEntitled: true,
      resolveStartPlanRuntimeAuth: async () => { throw new Error("registration failure must precede private auth"); },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.status, "failed");
    const facts = fixture.facts;
    assert.ok(facts, JSON.stringify({ result: run.result, events: fixture.events }));
    assert.equal(facts.source, "process");
    assert.equal(facts.phase, "process_exit");
    assert.equal(facts.rpc_method, null);
    assert.equal(facts.rpc_code, null);
    const syncFailure = fixture.events.find((event) => event.type === "account_provider_sync_failed");
    assert.ok(syncFailure);
    assert.deepEqual(syncFailure.details, {
      failure_stage: "provider_registration",
      failure_kind: "APPSERVER_EXITED",
    });
    const methods = (await readRequestLog(runtime.requestLog)).map((item) => item["method"]);
    assert.equal(methods.includes("provider/updateAccountConfig"), true);
    assert.equal(methods.includes("session/create"), false);
    assert.equal(methods.includes("session/send"), false);
  } finally {
    await runtime.cleanup();
  }
});

test("A2: a dropped ACK with a real runtime side effect stays unknown and never asserts no execution", { timeout: 30_000 }, async () => {
  const sideEffectFile = path.join(tmpdir(), `bridge-facts-sideeffect-${Date.now()}-${process.pid}.txt`);
  const runtime = await makeFakeRuntime({
    sendAck: false,
    sideEffectFile,
    exitAfterSendMs: { delayMs: 120, code: 3 },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    // The runtime demonstrably executed the request before the ACK was dropped.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(existsSync(sideEffectFile), true, "the runtime side effect must exist");
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.accepted_before_error, "unknown", "a dropped ACK after a send write is unknown, never no");
    assert.equal(facts!.source, "process");
    assert.equal(facts!.phase, "process_exit");
    const requests = await readRequestLog(runtime.requestLog);
    assert.equal(requests.filter((request) => request["method"] === "session/send").length, 1,
      "an unknown acceptance outcome must never trigger a duplicate send");
  } finally {
    await runtime.cleanup();
    await rm(sideEffectFile, { force: true });
  }
});

test("A3: the fixture-verified native correlation upgrade reaches yes, and stays unknown without the verified flag", { timeout: 40_000 }, async () => {
  const run = async (nativeVerified: boolean): Promise<FailureFactsV1 | null> => {
    const echoFile = path.join(tmpdir(), `bridge-facts-echo-${Date.now()}-${Math.random()}.txt`);
    const runtime = await makeFakeRuntime({
      sendAck: false,
      echoFile,
      exitAfterSendMs: { delayMs: 400, code: 2 },
      snapshotEventSeq: 40,
    });
    let capturedFacts: FailureFactsV1 | null = null;
    const task = makeTask({ task_id: TASK_ID, workspace: runtime.root, timeout_ms: 30_000 });



    let correlationId: string | null = null;
    try {
      const adapter = new ZCodeAppServerAdapter({
        resolver: { resolve: async () => runtime.config },
        timeoutMs: 20_000,
        childEnvBase: { PATH: process.env.PATH },
        homeDir: runtime.root,
        nativeSendCorrelationVerified: nativeVerified,
        onSendBoundary: (boundary) => {
          correlationId = boundary.submitCorrelationId;
          // Simulate the verified native echo channel: the runtime reads this file.
          void writeFile(echoFile, boundary.submitCorrelationId, "utf8").catch(() => undefined);
        },
        onFailureFacts: (facts) => {
          capturedFacts = facts;
        },
      });
      const handle = await adapter.startTask({ task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
      await adapter.getResult(handle).catch(() => undefined);
      const facts = capturedFacts as FailureFactsV1 | null;
      if (nativeVerified) {
        assert.ok(correlationId, "the send boundary must be observable in fixture mode");
      }
      return facts;
    } finally {
      await rm(runtime.root, { recursive: true, force: true });
      await rm(echoFile, { force: true });
    }
  };
  const verified = await run(true);
  assert.ok(verified);
  assert.equal(verified.accepted_before_error, "yes", "sessionId+seq-baseline+new turnId+verified echo together upgrade to yes");
  const unverified = await run(false);
  assert.ok(unverified);
  assert.equal(unverified.accepted_before_error, "unknown", "without the verified flag the same fixture cannot upgrade");
});

test("A4: an unproven session/send rejection keeps acceptance unknown", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({ sendRpcError: { code: -32603, dataCode: null } });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.source, "rpc");
    assert.equal(facts!.phase, "rpc_rejected");
    assert.equal(facts!.rpc_method, "session/send");
    assert.equal(facts!.rpc_code, -32603);
    assert.equal(facts!.accepted_before_error, "unknown", "only version-proven pre-acceptance rejection may say no");
  } finally {
    await runtime.cleanup();
  }
});

test("A5: an established send ACK stays yes in the failure snapshot", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({
    sendAck: true,
    turnFailure: { code: "1005", message: "request rejected" },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.accepted_before_error, "yes");
    // Q5 at the live-adapter level: a top-level 1005 stays in its own
    // error_code field (provenance is never rewritten) and classifies unknown.
    assert.equal(facts!.error_code, "1005");
    assert.equal(facts!.provider_code, null);
    assert.equal(facts!.category, "unknown");
  } finally {
    await runtime.cleanup();
  }
});

test("A6: late unbound turn events after an unacknowledged send never upgrade acceptance, while compat progress still flows", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    sendAck: false,
    exitAfterSendMs: { delayMs: 250, code: 1 },
    snapshotEventSeq: 40,
    preSendEvents: [
      { seq: 41, type: "turn.started", payload: { turnId: "old-turn-a" } },
      { seq: 42, type: "turn.started", sessionId: SESSION_ID, payload: {} },
      { seq: 43, type: "turn.started", sessionId: SESSION_ID, payload: { turnId: "old-turn-b" } },
    ],
  });
  const fixture = makeAdapterFixture(runtime.root);
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      onFailureFacts: (facts) => {
        fixture.facts = facts;
      },
      timeoutMs: 20_000,
      childEnvBase: { PATH: process.env.PATH },
      homeDir: runtime.root,
    });
    const handle = await adapter.startTask({ task: fixture.task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
    await adapter.getResult(handle).catch(() => undefined);
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.accepted_before_error, "unknown", "missing sessionId, missing/unbound turnId, no baseline echo, and late arrival all stay unknown");
    // The compat progress path is a separate check: the bound turn still published progress.
    assert.ok(events.some((event) => event.type === "turn_started"), "compat progress is independent of the acceptance evidence");
  } finally {
    await runtime.cleanup();
  }
});

// ---- S/R/P-scenarios --------------------------------------------------------

test("S1: an async spawn ENOENT maps to spawn_failed with sanitized text and process-plane facts", { timeout: 30_000 }, async () => {
  const sentinel = "SENTINEL_S1_executable_path";
  const runtime = await makeFakeRuntime({}, { nodeExecutable: path.join(tmpdir(), `missing-node-${sentinel}-does-not-exist`, "node.exe") });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "spawn_failed", "an async ENOENT is spawn evidence even after app_server_started");
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.source, "process");
    assert.equal(facts!.phase, "spawn");
    assert.equal(facts!.process_errno, "ENOENT");
    assert.equal(facts!.category, "unknown");
    assert.equal(facts!.accepted_before_error, "no");
    // D1b: Adapter events and normalized Result must not carry the executable path.
    assertNoSentinel(run.result, sentinel);
    const persistedEvents = fixture.events;
    assertNoSentinel(persistedEvents, sentinel);
  } finally {
    await runtime.cleanup();
  }
});

test("S2: an abnormal process exit after startup keeps process-plane unknown facts and the generic public code", { timeout: 30_000 }, async () => {
  // Keep the root alive long enough for the platform identity capture to
  // settle. Production cleanup must fail closed when a root exits before its
  // identity is observable; this scenario is about the later process-exit
  // facts, not that earlier race.
  const runtime = await makeFakeRuntime({ sendAck: true, exitAfterSendMs: { delayMs: 8_000, code: 7 } });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.source, "process");
    assert.equal(facts!.phase, "process_exit");
    assert.equal(facts!.category, "unknown");
    assert.equal(facts!.accepted_before_error, "yes");
  } finally {
    await runtime.cleanup();
  }
});

test("R1: an execution-terminal resultType preserves the private result_type under the generic public code", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({ turnResultType: "error_max_turns" });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    assert.match(run.result.summary, /error_max_turns/);
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.result_type, "error_max_turns");
    assert.equal(facts!.category, "execution_failed");
    assert.equal(facts!.evidence_basis, "result_type");
    assert.equal(facts!.accepted_before_error, "yes");
  } finally {
    await runtime.cleanup();
  }
});

test("P1: a denied permission does not fabricate failure facts; success continues, a later failure is classified on its own", { timeout: 40_000 }, async () => {
  const denyFlow = async (failAfterDeny: unknown | undefined): Promise<{ exitCode: number | null; facts: FailureFactsV1 | null; events: Array<{ type: string }> }> => {
    const runtime = await makeFakeRuntime({ interaction: true, failAfterDeny });
    let capturedFacts: FailureFactsV1 | null = null;
    const task = makeTask({ task_id: TASK_ID, workspace: runtime.root, timeout_ms: 30_000 });



    const events: Array<{ type: string }> = [];
    try {
      const adapter = new ZCodeAppServerAdapter({
        resolver: { resolve: async () => runtime.config },
        onEvent: (event) => events.push({ type: event.type }),
        resolveInteraction: async () => ({ decision: "deny" }),
        onFailureFacts: (facts) => {
          capturedFacts = facts;
        },
        timeoutMs: 30_000,
        childEnvBase: { PATH: process.env.PATH },
        homeDir: runtime.root,
      });
      const handle = await adapter.startTask({ task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
      const outcome = await adapter.getResult(handle).catch((error: unknown) => {
        return { exitCode: error instanceof BridgeError ? 1 : 1, failed: true } as unknown as ZCodeRunOutcome;
      });
      const facts = capturedFacts as FailureFactsV1 | null;
      return { exitCode: outcome.exitCode, facts, events };
    } finally {
      await rm(runtime.root, { recursive: true, force: true });
    }
  };
  const success = await denyFlow(undefined);
  assert.equal(success.exitCode, 0);
  assert.equal(success.facts, null, "a denied approval is not a failure root cause");
  const laterFailure = await denyFlow({ type: "tool_execution_failed", message: "the follow-up tool failed" });
  assert.ok(laterFailure.facts);
  assert.equal(laterFailure.facts.category, "execution_failed");
  assert.equal(laterFailure.facts.phase, "turn_terminal");
});

// ---- F-scenarios: warnings and internal degradation never take the slot -----

test("F1: an account-sync warning and replay degradation never create failure facts on success", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    accountSyncError: { code: -32031, data: { code: "restore_warning", message: "SENTINEL_F1_sync" } },
    replayUnsupported: true,
    completeDelayMs: 400,
  });
  const syncConfig = await withAccountSyncLayout(runtime);
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => syncConfig },
    });
    assert.equal(run.result.status, "completed");
    assert.equal(fixture.facts, null, "warnings and degradations must not fabricate failure evidence");
    assert.ok(run.result.summary.length > 0);
  } finally {
    await runtime.cleanup();
  }
});

test("F1b: a degraded session/events replay before a successful turn never creates failure facts", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({ replayUnsupported: true, completeDelayMs: 500 });
  let capturedFacts: FailureFactsV1 | null = null;
  const task = makeTask({ task_id: TASK_ID, workspace: runtime.root, timeout_ms: 30_000 });



  const events: Array<{ type: string }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push({ type: event.type }),
      onFailureFacts: (facts) => {
        capturedFacts = facts;
      },
      replayIdleMs: 60,
      timeoutMs: 30_000,
      childEnvBase: { PATH: process.env.PATH },
      homeDir: runtime.root,
    });
    const handle = await adapter.startTask({ task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
    const outcome = await adapter.getResult(handle);
    assert.equal(outcome.exitCode, 0);
    assert.ok(events.some((event) => event.type === "session_event_replay_unavailable"), "the degradation must be visible");
    assert.equal(capturedFacts, null, "a degradable replay failure never occupies the root-cause slot");
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("F2: the same warnings before a real turn failure leave the slot to the adjudicated termination cause", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    accountSyncError: { code: -32031, data: { code: "restore_warning", message: "SENTINEL_F2_sync" } },
    replayUnsupported: true,
    turnFailure: {
      code: "insufficient_quota",
      attribution: { providerErrorCode: "insufficient_quota", statusCode: 429 },
    },
  });
  const syncConfig = await withAccountSyncLayout(runtime);
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => syncConfig },
    });
    assert.equal(run.result.error_code, "zcode_usage_exhausted");
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.phase, "turn_terminal", "the turn failure, not the earlier warning, owns the root-cause slot");
    assert.equal(facts!.rpc_method, null, "the degraded warning never registers as the termination RPC");
    assert.equal(facts!.category, "quota_exhausted");
  } finally {
    await runtime.cleanup();
  }
});

test("F3: private callback failures (sync throw, async reject) never alter the outcome and leak no unhandled rejection", { timeout: 40_000 }, async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  const runOnce = async (sink: (facts: FailureFactsV1) => unknown): Promise<{ code: string | undefined; events: number }> => {
    const runtime = await makeFakeRuntime({ turnFailure: { code: "insufficient_quota" } });
    let capturedFacts: FailureFactsV1 | null = null;
    const task = makeTask({ task_id: TASK_ID, workspace: runtime.root, timeout_ms: 30_000 });



    let events = 0;
    try {
      const adapter = new ZCodeAppServerAdapter({
        resolver: { resolve: async () => runtime.config },
        onEvent: () => { events += 1; },
        onFailureFacts: sink,
        timeoutMs: 20_000,
        childEnvBase: { PATH: process.env.PATH },
        homeDir: runtime.root,
      });
      const handle = await adapter.startTask({ task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
      const outcome = await adapter.getResult(handle).catch((error: unknown) => error);
      const code = outcome instanceof BridgeError ? outcome.code : undefined;
      assert.equal(code, "zcode_usage_exhausted");
      return { code, events };
    } finally {
      await rm(runtime.root, { recursive: true, force: true });
    }
  };
  try {
    const syncThrow = await runOnce(() => { throw new Error("SENTINEL_F3_sync_sink"); });
    assert.ok(syncThrow.events > 0);
    const asyncReject = await runOnce((facts) => Promise.reject(new Error("SENTINEL_F3_async_sink")));
    assert.ok(asyncReject.events > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled.length, 0, "the diagnostic boundary must absorb async rejections");
    assert.ok(!JSON.stringify(unhandled).includes("SENTINEL_F3"));
  } finally {
    process.off("unhandledRejection", listener);
  }
});

// ---- D-scenarios: privacy, isolation, and store ownership -------------------

test("D1a+D1b: sentinel-saturated failures leak nothing into Adapter facts/events or normalized Result", { timeout: 40_000 }, async () => {
  const s = (name: string): string => `SENTINEL_${name}_7f3a`;
  const runtime = await makeFakeRuntime({
    turnFailure: {
      code: "insufficient_quota",
      message: `${s("message")} quota is gone`,
      stack: s("stack"),
      headers: { authorization: `Bearer ${s("header")}` },
      underlyingErrorMessage: s("underlying"),
      turnPhase: s("phase"),
      attribution: {
        providerErrorCode: "insufficient_quota",
        statusCode: 429,
        retryable: false,
        reason: s("reason"),
        exceptionKind: s("exception"),
        source: s("attr_source"),
      },
    },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.error_code, "zcode_usage_exhausted");
    for (const name of ["message", "stack", "header", "underlying", "phase", "reason", "exception", "attr_source"]) {
      assertNoSentinel(run.result, s(name));
    }
    const raw = JSON.stringify(fixture.facts);
    for (const name of ["message", "stack", "header", "underlying", "reason", "exception", "attr_source"]) {
      assert.ok(!raw.includes(s(name)), `facts must not contain the ${name} sentinel`);
    }
    assert.ok(!raw.includes(s("phase")), "an unregistered upstream phase value is never stored verbatim");
    const facts = fixture.facts;
    assert.equal(facts!.phase, "unknown");
    assert.equal(facts!.provider_code, "insufficient_quota");
    assert.equal(facts!.http_status, 429);
    const events = fixture.events;
    for (const name of ["message", "stack", "header", "underlying", "phase", "reason"]) {
      assertNoSentinel(events, s(name));
    }
  } finally {
    await runtime.cleanup();
  }
});

test("L1b: a report-only failure fabricates no provider facts", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({ reportOverride: "this is not a report at all" });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "invalid_agent_report");
    assert.equal(fixture.facts, null, "report-plane failures never receive provider failure facts");
  } finally {
    await runtime.cleanup();
  }
});

test("L3: a retryable flag alone does not prove Provider non-acceptance", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: {
      code: "rate_limit_error",
      type: "model_rate_limited",
      attribution: { retryable: true, statusCode: 429 },
    },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    const facts = fixture.facts;
    assert.equal(facts!.category, "rate_limited");
    assert.equal(facts!.runtime_retryable, true);
    assert.equal(facts!.runtime_retryable_basis, "reported");
    // No respawn slot or repeat send: the runtime's retryable flag does not
    // prove that the Provider did not accept this request.
    const requests = await readRequestLog(runtime.requestLog);
    assert.equal(requests.filter((request) => request["method"] === "session/send").length, 1);
  } finally {
    await runtime.cleanup();
  }
});

test("L3b: HTTP 429 is not retried until Provider non-acceptance can be verified", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: {
      code: "rate_limit_error",
      type: "model_rate_limited",
      attribution: { statusCode: 429, retryable: true, retryAfterMs: 100 },
    },
    turnFailureOnSends: [1],
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(fixture.facts?.category, "rate_limited");
    const requests = await readRequestLog(runtime.requestLog);
    const sends = requests.filter((request) => request["method"] === "session/send");
    assert.equal(sends.length, 1, "a statusCode field alone does not establish trusted Provider rejection provenance");
  } finally {
    await runtime.cleanup();
  }
});

test("L3b2: HTTP 429 beyond the bounded Retry-After wait is not retried early", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: { code: "rate_limit_error", attribution: { statusCode: 429, retryAfterMs: 60_001 } },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    const requests = await readRequestLog(runtime.requestLog);
    assert.equal(requests.filter((request) => request["method"] === "session/send").length, 1,
      "the adapter must not violate a Retry-After longer than its automatic retry budget");
  } finally {
    await runtime.cleanup();
  }
});

test("L3c1: HTTP 5xx does not retry when request acceptance is unknown", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: { code: "provider_unavailable", attribution: { statusCode: 503 } },
    turnFailureOnSends: [1],
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({ fixture, resolver: { resolve: async () => runtime.config } });
    assert.equal(run.result.status, "failed");
    const requests = await readRequestLog(runtime.requestLog);
    assert.equal(requests.filter((request) => request["method"] === "session/send").length, 1);
  } finally { await runtime.cleanup(); }
});

test("L3c2: network failure with unknown acceptance does not resend", { timeout: 20_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: { code: "ECONNRESET", type: "connection_reset" },
    turnFailureOnSends: [1],
  });
  const fixture = makeAdapterFixture(runtime.root);
  const adapter = new ZCodeAppServerAdapter({
    resolver: { resolve: async () => runtime.config },
    timeoutMs: 15_000,
    childEnvBase: { PATH: process.env.PATH },
    homeDir: runtime.root,
  });
  const handle = await adapter.startTask({
    task: fixture.task,
    workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" },
    attempt: fixture.attempt,
  });
  try {
    await assert.rejects(adapter.getResult(handle), /turn failed/u);
    const requests = await readRequestLog(runtime.requestLog);
    assert.equal(requests.filter((request) => request["method"] === "session/send").length, 1);
  } finally {
    await adapter.cancelTask(handle).catch(() => undefined);
    await runtime.cleanup();
  }
});

test("L3e: a bound turn-start prevents retry after a terminal Provider or transport failure", { timeout: 45_000 }, async () => {
  const cases = [
    { name: "HTTP 429", turnFailure: { code: "rate_limit_error", attribution: { statusCode: 429, retryable: true } } },
    { name: "HTTP 503", turnFailure: { code: "provider_unavailable", attribution: { statusCode: 503, retryable: true } } },
    { name: "connection closed", exitAfterSendMs: { delayMs: 100, code: 1 } },
  ] as const;
  for (const scenario of cases) {
    const runtime = await makeFakeRuntime({
      ...scenario,
      turnStartOnSend: true,
      coalesceSendAckWithTurnStart: true,
      turnId: `bound-${scenario.name.replace(/\W/gu, "-")}`,
    });
    const fixture = makeAdapterFixture(runtime.root);
    try {
      const run = await runAdapter({
        fixture,
        resolver: { resolve: async () => runtime.config },
      });
      assert.equal(run.result.status, "failed", `${scenario.name} must remain a failed attempt`);
      const persisted = fixture.events;
      assert.ok(persisted.some((event) => event.type === "turn_started"),
        `${scenario.name}: a session-bound turn.started must reach the Worker`);
      const boundStarts = persisted.filter((event) => event.type === "turn_started"
        && (event.details as Record<string, unknown> | undefined)?.turn_id === `bound-${scenario.name.replace(/\W/gu, "-")}`);
      assert.equal(boundStarts.length, 1, `${scenario.name}: the runtime turn identity must bind exactly once`);
      const requests = await readRequestLog(runtime.requestLog);
      assert.equal(requests.filter((request) => request["method"] === "session/send").length, 1,
        `${scenario.name}: turn-started work must never be sent again`);
    } finally {
        await runtime.cleanup();
    }
  }
});

test("L3d: auth failures do not retry", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: { code: "authentication_failed", type: "auth_failed", attribution: { statusCode: 401 } },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    const run = await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    const requests = await readRequestLog(runtime.requestLog);
    assert.equal(requests.filter((request) => request["method"] === "session/send").length, 1);
  } finally {
    await runtime.cleanup();
  }
});

test("T1: the live adapter reports reported booleans only, and contradictory booleans null out with the conflict flag", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: {
      code: "model_not_found",
      attribution: { providerErrorCode: "model_not_found", retryable: true },
      retryable: false,
    },
  });
  const fixture = makeAdapterFixture(runtime.root);
  try {
    await runAdapter({
      fixture,
      resolver: { resolve: async () => runtime.config },
    });
    const facts = fixture.facts;
    assert.ok(facts);
    assert.equal(facts!.category, "model_unavailable", "the unaffected direct category still stands");
    assert.equal(facts!.runtime_retryable, null);
    assert.equal(facts!.runtime_retryable_basis, null);
    assert.equal(facts!.evidence_conflict, true);
    assert.equal(facts!.evidence_basis, "runtime_type_or_reason");
  } finally {
    await runtime.cleanup();
  }
});

// ---- Host stderr exit validation (ADR-011 private diagnostic boundary) ------

const VALID_FACTS: FailureFactsV1 = {
  schema_version: "1",
  source: "turn_event",
  phase: "turn_terminal",
  rpc_method: null,
  rpc_code: null,
  rpc_data_code: null,
  error_type: "model_error",
  error_code: "model_request_failed",
  provider_code: "3007",
  http_status: 429,
  accepted_before_error: "yes",
  category: "rate_limited",
  confidence: "inferred",
  evidence_basis: "http_status",
  evidence_conflict: false,
  runtime_retryable: false,
  runtime_retryable_basis: "reported",
  result_type: null,
  process_errno: null,
};

test("H1: the Host validator accepts a trusted Worker failure-facts stderr line", () => {
  const line = `[bridge-worker] failure-facts ${JSON.stringify(VALID_FACTS)}`;
  assert.equal(formatWorkerFailureFactsLine(line), JSON.stringify(VALID_FACTS));
});

test("H2: non-marker lines, malformed JSON, and unregistered snapshots are dropped", () => {
  assert.equal(formatWorkerFailureFactsLine("not a facts line"), null);
  assert.equal(formatWorkerFailureFactsLine("[bridge-worker] adapter event=cleanup_unverified"), null);
  assert.equal(formatWorkerFailureFactsLine("[bridge-worker] failure-facts {broken"), null);
  assert.equal(formatWorkerFailureFactsLine("[bridge-worker] failure-facts [1,2,3]"), null);
  // An unknown field means unvalidated content: the whole snapshot is dropped.
  const injected = JSON.stringify({ ...VALID_FACTS, upstream_message: "SENTINEL_H2_secret" });
  assert.equal(formatWorkerFailureFactsLine(`[bridge-worker] failure-facts ${injected}`), null);
  // A missing field is equally untrusted.
  const { provider_code: _omitted, ...incomplete } = VALID_FACTS;
  assert.equal(formatWorkerFailureFactsLine(`[bridge-worker] failure-facts ${JSON.stringify(incomplete)}`), null);
});
