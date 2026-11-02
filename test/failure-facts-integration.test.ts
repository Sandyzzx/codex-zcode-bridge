// ADR-011 P0 integration tests: the frozen FailureFactsV1 contract exercised
// through the real ZCodeAppServerAdapter against fake app-server runtimes, the
// real TaskStore dedicated write entry, and runWorkerTask — never pure
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
import { ZCodeAppServerAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import { buildFailureFacts, type FailureFactsV1 } from "../src/diagnostics/failure-facts.js";
import { runWorkerTask } from "../src/worker/run-task.js";
import { TaskStore } from "../src/store/task-store.js";
import { BridgeError } from "../src/runtime/errors.js";
import type { TaskPackage, ZCodeRuntimeConfig } from "../src/interfaces.js";
import type { ZCodeRunOutcome } from "../src/adapters/zcode-adapter.js";
import type { WorkerAdapter } from "../src/worker/run-task.js";
import { SESSION_ID, makeTask, validReport } from "./helpers.js";

const TASK_ID = "facts_integration";

test("M1: a competing turn failure cannot replace the selected session/send RPC rejection", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({
    sendRpcError: { code: -32603, dataCode: "model_not_found" },
    turnAfterRpcRejection: { code: "insufficient_quota" },
  });
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({ dataRoot: fixture.dataRoot, taskId: TASK_ID, attempt: fixture.attempt, resolver: { resolve: async () => runtime.config } });
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    const facts = fixture.store.readFailureFacts(TASK_ID, fixture.attempt).facts;
    assert.ok(facts);
    assert.equal(facts.source, "rpc");
    assert.equal(facts.rpc_data_code, "model_not_found");
    assert.equal(facts.category, "unknown");
  } finally { await fixture.cleanup(); await runtime.cleanup(); }
});

test("D1b: unknown resultType and invalid protocol frames never expose upstream text", { timeout: 30_000 }, async () => {
  const sentinel = "SENTINEL_UPSTREAM_PAYLOAD_SECRET";
  for (const options of [{ turnResultType: sentinel }, { malformedFrame: `invalid-json-${sentinel}` }]) {
    const runtime = await makeFakeRuntime(options);
    const fixture = await makeWorkerFixture(runtime.root);
    try {
      const run = await runWorkerTask({ dataRoot: fixture.dataRoot, taskId: TASK_ID, attempt: fixture.attempt, resolver: { resolve: async () => runtime.config } });
      assert.equal(run.result.status, "failed");
      assertNoSentinel(run.result, sentinel);
      assertNoSentinel(fixture.store.readEvents(TASK_ID, 0, 200).events, sentinel);
      assertNoSentinel(fixture.store.readFailureFacts(TASK_ID, fixture.attempt), sentinel);
      assert.equal(run.result.error_code, "turnResultType" in options ? "unknown_turn_terminal" : "zcode_nonzero_exit");
    } finally { await fixture.cleanup(); await runtime.cleanup(); }
  }
});

// ---- Fake app-server runtime ------------------------------------------------

interface FakeRuntimeOptions {
  accountSyncError?: unknown;
  preSendReject?: { method: "session/create" | "session/resume"; code?: number; dataCode?: string | null; dataMessage?: string };
  sendAck?: boolean;
  sendRpcError?: { code?: number; dataCode?: string | null };
  sideEffectFile?: string;
  exitAfterSendMs?: { delayMs: number; code: number };
  turnFailure?: unknown;
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
  if (opts.turnFailure !== undefined) { emit({ seq: 90, type: "turn.failed", payload: { error: opts.turnFailure } }); return; }
  const resultType = opts.turnResultType || "success";
  emit({ seq: 90, type: "turn.completed", payload: { response: opts.reportOverride === undefined ? JSON.stringify(report) : opts.reportOverride, usage: { totalTokens: 4 }, resultType } });
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLog, JSON.stringify(message) + "\n");
  if (message.method === "session/create" || message.method === "session/resume") {
    if (opts.preSendReject && opts.preSendReject.method === message.method) {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: opts.preSendReject.code === undefined ? -32603 : opts.preSendReject.code, data: { code: opts.preSendReject.dataCode === undefined ? null : opts.preSendReject.dataCode, message: opts.preSendReject.dataMessage === undefined ? "rejected" : opts.preSendReject.dataMessage } } }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\n");
  } else if (message.method === "provider/updateAccountConfig") {
    if (opts.accountSyncError) process.stdout.write(JSON.stringify({ id: message.id, error: opts.accountSyncError }) + "\n");
    else process.stdout.write(JSON.stringify({ id: message.id, result: { status: "ok" } }) + "\n");
  } else if (message.method === "session/setModel" || message.method === "session/setMode" || message.method === "session/subscribe") {
    process.stdout.write(JSON.stringify({ id: message.id, result: message.method === "session/setModel" ? snapshot() : {} }) + "\n");
  } else if (message.method === "session/events") {
    if (opts.replayUnsupported) process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported ZCode app-server request: session/events" } }) + "\n");
    else process.stdout.write(JSON.stringify({ id: message.id, result: { events: [] } }) + "\n");
  } else if (message.method === "session/send") {
    if (opts.sideEffectFile) { try { fs.writeFileSync(opts.sideEffectFile, "written-by-runtime\n"); } catch (error) {} }
    if (opts.sendAck === false) {
      // no reply: the ACK is dropped
    } else if (opts.sendRpcError) {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: opts.sendRpcError.code === undefined ? -32603 : opts.sendRpcError.code, data: { code: opts.sendRpcError.dataCode === undefined ? null : opts.sendRpcError.dataCode } } }) + "\n");
      if (opts.turnAfterRpcRejection) emit({ seq: 90, type: "turn.failed", payload: { error: opts.turnAfterRpcRejection } });
      return;
    } else {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
    }
    if (opts.malformedFrame) { process.stdout.write(opts.malformedFrame + "\n"); return; }
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
  return { ...runtime.config, providerPersonalConfigFile: personal };
}

// ---- Worker-level fixture ---------------------------------------------------

interface FactsWorkerFixture {
  dataRoot: string;
  store: TaskStore;
  task: TaskPackage;
  attempt: number;
  cleanup: () => Promise<void>;
}

async function makeWorkerFixture(workspace: string): Promise<FactsWorkerFixture> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "bridge-facts-store-"));
  const store = new TaskStore(dataRoot);
  const task = makeTask({
    task_id: TASK_ID,
    workspace,
    objective: "Return the requested report",
    timeout_ms: 60_000,
  });
  store.createTask(task, "2026-10-18T00:00:00.000Z");
  store.writeWorkspaceRef(task.task_id, { requestedPath: workspace, canonicalPath: workspace, mode: "direct" });
  return {
    dataRoot,
    store,
    task,
    attempt: store.readStatus(task.task_id).attempt,
    cleanup: () => rm(dataRoot, { recursive: true, force: true }),
  };
}

async function readRequestLog(requestLog: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(requestLog, "utf8");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

/** Puts a fixture into the same running+claimed state a real worker creates,
 * so the dedicated store entry accepts evidence from this process. */
function admitWorker(fixture: FactsWorkerFixture): void {
  fixture.store.writeStatus(TASK_ID, { status: "running", worker_pid: process.pid }, fixture.attempt);
  fixture.store.claimWorkerExecution(TASK_ID, fixture.attempt);
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
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "zcode_usage_exhausted");
    assert.match(run.result.summary, /额度已耗尽/);
    const { facts, corrupt } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.equal(corrupt, false);
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
    await fixture.cleanup();
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
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.equal(facts!.category, "rate_limited");
    assert.equal(facts!.confidence, "confirmed");
    assert.equal(facts!.error_code, "rate_limit_error");
    assert.equal(facts!.provider_code, null);
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("A1: a pre-send session/create rejection records accepted=no with the RPC candidate, and no sentinel text", { timeout: 30_000 }, async () => {
  const sentinel = "SENTINEL_A1_rpc_message";
  const runtime = await makeFakeRuntime({
    preSendReject: { method: "session/create", code: -32603, dataCode: "provider_not_found", dataMessage: `rejected: ${sentinel}` },
  });
  const fixture = await makeWorkerFixture(runtime.root);
  admitWorker(fixture);
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      onFailureFacts: (facts) => {
        try { fixture.store.writeFailureFacts(TASK_ID, 1, process.pid, facts); } catch { /* diagnostic boundary */ }
      },
      timeoutMs: 20_000,
      childEnvBase: { PATH: process.env.PATH },
      homeDir: runtime.root,
    });
    const handle = await adapter.startTask({ task: fixture.task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
    await assert.rejects(adapter.getResult(handle), (error: unknown) => error instanceof BridgeError && error.code === "zcode_nonzero_exit");
    const { facts } = fixture.store.readFailureFacts(TASK_ID, 1);
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
    await fixture.cleanup();
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
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    // The runtime demonstrably executed the request before the ACK was dropped.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(existsSync(sideEffectFile), true, "the runtime side effect must exist");
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.ok(facts);
    assert.equal(facts!.accepted_before_error, "unknown", "a dropped ACK after a send write is unknown, never no");
    assert.equal(facts!.source, "process");
    assert.equal(facts!.phase, "process_exit");
  } finally {
    await fixture.cleanup();
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
    const store = new TaskStore(runtime.root);
    const task = makeTask({ task_id: TASK_ID, workspace: runtime.root, timeout_ms: 30_000 });
    store.createTask(task, "2026-10-18T00:00:00.000Z");
    store.writeStatus(TASK_ID, { status: "running", worker_pid: process.pid }, 1);
    store.claimWorkerExecution(TASK_ID, 1);
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
          try { store.writeFailureFacts(TASK_ID, 1, process.pid, facts); } catch { /* boundary */ }
        },
      });
      const handle = await adapter.startTask({ task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
      await adapter.getResult(handle).catch(() => undefined);
      const { facts } = store.readFailureFacts(TASK_ID, 1);
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
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.ok(facts);
    assert.equal(facts!.source, "rpc");
    assert.equal(facts!.phase, "rpc_rejected");
    assert.equal(facts!.rpc_method, "session/send");
    assert.equal(facts!.rpc_code, -32603);
    assert.equal(facts!.accepted_before_error, "unknown", "only version-proven pre-acceptance rejection may say no");
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("A5: an established send ACK stays yes in the failure snapshot", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({
    sendAck: true,
    turnFailure: { code: "1005", message: "request rejected" },
  });
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.ok(facts);
    assert.equal(facts!.accepted_before_error, "yes");
    // Q5 at the live-adapter level: a top-level 1005 stays in its own
    // error_code field (provenance is never rewritten) and classifies unknown.
    assert.equal(facts!.error_code, "1005");
    assert.equal(facts!.provider_code, null);
    assert.equal(facts!.category, "unknown");
  } finally {
    await fixture.cleanup();
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
  const fixture = await makeWorkerFixture(runtime.root);
  admitWorker(fixture);
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push(event),
      onFailureFacts: (facts) => {
        try { fixture.store.writeFailureFacts(TASK_ID, 1, process.pid, facts); } catch { /* boundary */ }
      },
      timeoutMs: 20_000,
      childEnvBase: { PATH: process.env.PATH },
      homeDir: runtime.root,
    });
    const handle = await adapter.startTask({ task: fixture.task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
    await adapter.getResult(handle).catch(() => undefined);
    const { facts } = fixture.store.readFailureFacts(TASK_ID, 1);
    assert.ok(facts);
    assert.equal(facts!.accepted_before_error, "unknown", "missing sessionId, missing/unbound turnId, no baseline echo, and late arrival all stay unknown");
    // The compat progress path is a separate check: the bound turn still published progress.
    assert.ok(events.some((event) => event.type === "turn_started"), "compat progress is independent of the acceptance evidence");
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

// ---- S/R/P-scenarios --------------------------------------------------------

test("S1: an async spawn ENOENT maps to spawn_failed with sanitized text and process-plane facts", { timeout: 30_000 }, async () => {
  const sentinel = "SENTINEL_S1_executable_path";
  const runtime = await makeFakeRuntime({}, { nodeExecutable: path.join(tmpdir(), `missing-node-${sentinel}-does-not-exist`, "node.exe") });
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "spawn_failed", "an async ENOENT is spawn evidence even after app_server_started");
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.ok(facts);
    assert.equal(facts!.source, "process");
    assert.equal(facts!.phase, "spawn");
    assert.equal(facts!.process_errno, "ENOENT");
    assert.equal(facts!.category, "unknown");
    assert.equal(facts!.accepted_before_error, "no");
    // D1b: neither the persisted events, the result, nor the logs carry the
    // executable path sentinel.
    assertNoSentinel(run.result, sentinel);
    const persistedEvents = fixture.store.readEvents(TASK_ID, 0, 200).events;
    assertNoSentinel(persistedEvents, sentinel);
    const stderrLog = fixture.store.readLog(TASK_ID, "stderr");
    assert.ok(!stderrLog.includes(sentinel), "stderr evidence must be sanitized too");
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("S2: an abnormal process exit after startup keeps process-plane unknown facts and the generic public code", { timeout: 30_000 }, async () => {
  // Keep the root alive long enough for the platform identity capture to
  // settle. Production cleanup must fail closed when a root exits before its
  // identity is observable; this scenario is about the later process-exit
  // facts, not that earlier race.
  const runtime = await makeFakeRuntime({ sendAck: true, exitAfterSendMs: { delayMs: 8_000, code: 7 } });
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.ok(facts);
    assert.equal(facts!.source, "process");
    assert.equal(facts!.phase, "process_exit");
    assert.equal(facts!.category, "unknown");
    assert.equal(facts!.accepted_before_error, "yes");
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("R1: an execution-terminal resultType preserves the private result_type under the generic public code", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({ turnResultType: "error_max_turns" });
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "zcode_nonzero_exit");
    assert.match(run.result.summary, /error_max_turns/);
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.ok(facts);
    assert.equal(facts!.result_type, "error_max_turns");
    assert.equal(facts!.category, "execution_failed");
    assert.equal(facts!.evidence_basis, "result_type");
    assert.equal(facts!.accepted_before_error, "yes");
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("P1: a denied permission does not fabricate failure facts; success continues, a later failure is classified on its own", { timeout: 40_000 }, async () => {
  const denyFlow = async (failAfterDeny: unknown | undefined): Promise<{ exitCode: number | null; facts: FailureFactsV1 | null; events: Array<{ type: string }> }> => {
    const runtime = await makeFakeRuntime({ interaction: true, failAfterDeny });
    const store = new TaskStore(runtime.root);
    const task = makeTask({ task_id: TASK_ID, workspace: runtime.root, timeout_ms: 30_000 });
    store.createTask(task, "2026-10-18T00:00:00.000Z");
    store.writeStatus(TASK_ID, { status: "running", worker_pid: process.pid }, 1);
    store.claimWorkerExecution(TASK_ID, 1);
    const events: Array<{ type: string }> = [];
    try {
      const adapter = new ZCodeAppServerAdapter({
        resolver: { resolve: async () => runtime.config },
        onEvent: (event) => events.push({ type: event.type }),
        resolveInteraction: async () => ({ decision: "deny" }),
        onFailureFacts: (facts) => {
          try { store.writeFailureFacts(TASK_ID, 1, process.pid, facts); } catch { /* boundary */ }
        },
        timeoutMs: 30_000,
        childEnvBase: { PATH: process.env.PATH },
        homeDir: runtime.root,
      });
      const handle = await adapter.startTask({ task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
      const outcome = await adapter.getResult(handle).catch((error: unknown) => {
        return { exitCode: error instanceof BridgeError ? 1 : 1, failed: true } as unknown as ZCodeRunOutcome;
      });
      const { facts } = store.readFailureFacts(TASK_ID, 1);
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
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => syncConfig },
    });
    assert.equal(run.result.status, "completed");
    assert.equal(fixture.store.readFailureFacts(TASK_ID, fixture.attempt).facts, null, "warnings and degradations must not fabricate failure evidence");
    assert.ok(run.result.summary.length > 0);
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("F1b: a degraded session/events replay before a successful turn never creates failure facts", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({ replayUnsupported: true, completeDelayMs: 500 });
  const store = new TaskStore(runtime.root);
  const task = makeTask({ task_id: TASK_ID, workspace: runtime.root, timeout_ms: 30_000 });
  store.createTask(task, "2026-10-18T00:00:00.000Z");
  store.writeStatus(TASK_ID, { status: "running", worker_pid: process.pid }, 1);
  store.claimWorkerExecution(TASK_ID, 1);
  const events: Array<{ type: string }> = [];
  try {
    const adapter = new ZCodeAppServerAdapter({
      resolver: { resolve: async () => runtime.config },
      onEvent: (event) => events.push({ type: event.type }),
      onFailureFacts: (facts) => {
        try { store.writeFailureFacts(TASK_ID, 1, process.pid, facts); } catch { /* boundary */ }
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
    assert.equal(store.readFailureFacts(TASK_ID, 1).facts, null, "a degradable replay failure never occupies the root-cause slot");
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
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => syncConfig },
    });
    assert.equal(run.result.error_code, "zcode_usage_exhausted");
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.ok(facts);
    assert.equal(facts!.phase, "turn_terminal", "the turn failure, not the earlier warning, owns the root-cause slot");
    assert.equal(facts!.rpc_method, null, "the degraded warning never registers as the termination RPC");
    assert.equal(facts!.category, "quota_exhausted");
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("F3: private callback failures (sync throw, async reject) never alter the outcome and leak no unhandled rejection", { timeout: 40_000 }, async () => {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  const runOnce = async (sink: (facts: FailureFactsV1) => unknown): Promise<{ code: string | undefined; events: number }> => {
    const runtime = await makeFakeRuntime({ turnFailure: { code: "insufficient_quota" } });
    const store = new TaskStore(runtime.root);
    const task = makeTask({ task_id: TASK_ID, workspace: runtime.root, timeout_ms: 30_000 });
    store.createTask(task, "2026-10-18T00:00:00.000Z");
    store.writeStatus(TASK_ID, { status: "running", worker_pid: process.pid }, 1);
    store.claimWorkerExecution(TASK_ID, 1);
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

test("D1a+D1b: sentinel-saturated turn failures leak nothing into facts, events, results, or logs", { timeout: 40_000 }, async () => {
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
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.error_code, "zcode_usage_exhausted");
    for (const name of ["message", "stack", "header", "underlying", "phase", "reason", "exception", "attr_source"]) {
      assertNoSentinel(run.result, s(name));
    }
    const factsFile = path.join(fixture.dataRoot, ".tasks", TASK_ID, "attempts", String(fixture.attempt), "failure-facts.json");
    const raw = await readFile(factsFile, "utf8");
    for (const name of ["message", "stack", "header", "underlying", "reason", "exception", "attr_source"]) {
      assert.ok(!raw.includes(s(name)), `facts must not contain the ${name} sentinel`);
    }
    assert.ok(!raw.includes(s("phase")), "an unregistered upstream phase value is never stored verbatim");
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.equal(facts!.phase, "unknown");
    assert.equal(facts!.provider_code, "insufficient_quota");
    assert.equal(facts!.http_status, 429);
    const events = fixture.store.readEvents(TASK_ID, 0, 200);
    for (const name of ["message", "stack", "header", "underlying", "phase", "reason"]) {
      assertNoSentinel(events.events, s(name));
    }
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("D3: a failing facts write and failing events never change the original result, and no IO text escapes", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({ turnFailure: { code: "insufficient_quota" } });
  const fixture = await makeWorkerFixture(runtime.root);
  // Block the persistence path with a directory where the snapshot file would go.
  const blockDir = path.join(fixture.dataRoot, ".tasks", TASK_ID, "attempts", String(fixture.attempt), "failure-facts.json");
  await mkdir(path.dirname(blockDir), { recursive: true });
  await mkdir(blockDir);
  const events: Array<{ type: string; summary: string }> = [];
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "zcode_usage_exhausted", "the blocked evidence write never changes the main result");
    events.push(...fixture.store.readEvents(TASK_ID, 0, 200).events.map((event) => ({ type: event.type, summary: event.summary })));
    const publicText = JSON.stringify({ events, result: run.result });
    assert.ok(!/failure-facts|EISDIR|EPERM|ENOTEMPTY/i.test(publicText), "no diagnostics IO text may reach the public channel");
    assert.equal(run.result.issues.some((issue) => /failure-facts/i.test(issue)), false);
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("D5: every ownership mismatch is rejected inside the dedicated entry, and the same state.lock serializes writers", { timeout: 40_000 }, async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "bridge-facts-ownership-"));
  try {
    const store = new TaskStore(dataRoot);
    store.createTask(makeTask({ task_id: TASK_ID }), "2026-10-18T00:00:00.000Z");
    const facts = buildFailureFacts({ source: "turn_event", phase: "turn_terminal", providerCode: "insufficient_quota", accepted: "yes" });
    const factsFile = path.join(dataRoot, ".tasks", TASK_ID, "attempts", "1", "failure-facts.json");

    // Mismatched attempt: attempt 2 does not exist while status sits on attempt 1.
    store.writeStatus(TASK_ID, { status: "running", worker_pid: process.pid }, 1);
    assert.throws(() => store.writeFailureFacts(TASK_ID, 2, process.pid, facts), /stale attempt/);
    assert.equal(existsSync(factsFile), false);

    // Missing claim: worker_pid recorded but no execution.claim yet.
    assert.throws(() => store.writeFailureFacts(TASK_ID, 1, process.pid, facts), /execution claim/);
    assert.equal(existsSync(factsFile), false);

    // Claim mismatch: another process owns the claim.
    store.claimWorkerExecution(TASK_ID, 1);
    const attemptDir = path.join(dataRoot, ".tasks", TASK_ID, "attempts", "1");
    const claimFile = path.join(attemptDir, "execution.claim");
    const originalClaim = await readFile(claimFile, "utf8");
    await writeFile(claimFile, JSON.stringify({ pid: process.pid + 4321 }));
    assert.throws(() => store.writeFailureFacts(TASK_ID, 1, process.pid, facts), /execution claim/);
    assert.equal(existsSync(factsFile), false);
    await writeFile(claimFile, originalClaim);

    // Mismatched worker_pid in status.
    store.writeStatus(TASK_ID, { worker_pid: process.pid + 1234 }, 1);
    assert.throws(() => store.writeFailureFacts(TASK_ID, 1, process.pid, facts), /worker pid/);
    assert.equal(existsSync(factsFile), false);
    store.writeStatus(TASK_ID, { worker_pid: process.pid }, 1);

    // The matching current running worker may write the first snapshot.
    assert.equal(store.writeFailureFacts(TASK_ID, 1, process.pid, facts), "written");
    assert.equal(existsSync(factsFile), true);

    // An identical redelivery is an idempotent no-op while the attempt runs.
    assert.equal(store.writeFailureFacts(TASK_ID, 1, process.pid, facts), "duplicate");

    // A divergent replacement candidate is rejected while the attempt runs.
    const divergent = buildFailureFacts({ source: "turn_event", phase: "turn_terminal", errorCode: "model_not_found", accepted: "yes" });
    assert.throws(() => store.writeFailureFacts(TASK_ID, 1, process.pid, divergent), /divergent/);
    assert.ok(JSON.parse(await readFile(factsFile, "utf8")));

    // A plain writeAttemptMeta cannot act as the validated entry: garbage seeded
    // through it stays on disk, and the dedicated entry refuses to treat the
    // corrupt snapshot as an empty slot.
    store.writeAttemptMeta(TASK_ID, 1, "failure-facts.json", { garbage: true } as unknown as Record<string, unknown>);
    assert.throws(() => store.writeFailureFacts(TASK_ID, 1, process.pid, facts), /unknown field/);
    assert.equal((JSON.parse(await readFile(factsFile, "utf8")) as Record<string, unknown>)["garbage"], true, "the corrupt file is preserved for diagnosis, never overwritten");

    // Non-running (terminal) attempts are never backfilled.
    const result = {
      task_id: TASK_ID, status: "failed" as const, summary: "x", files_changed: [], tests: [],
      issues: [], needs_master_decision: true, zcode_output: "", exit_code: 1,
      session_id: null, attempt: 1, started_at: null, finished_at: "2026-10-18T00:01:00.000Z",
      error_code: "zcode_nonzero_exit",
    };
    store.commitWorkerResult(TASK_ID, 1, result, { status: "failed", finished_at: result.finished_at!, worker_pid: null });
    assert.throws(() => store.writeFailureFacts(TASK_ID, 1, process.pid, facts), /non-running/);

    // Same-lock competition: a foreign process holding state.lock delays the
    // dedicated entry's critical section; the write lands only after release.
    const second = await mkdtemp(path.join(tmpdir(), "bridge-facts-lockrun-"));
    try {
      const lockStore = new TaskStore(second);
      lockStore.createTask(makeTask({ task_id: TASK_ID }), "2026-10-18T00:00:00.000Z");
      lockStore.writeStatus(TASK_ID, { status: "running", worker_pid: process.pid }, 1);
      lockStore.claimWorkerExecution(TASK_ID, 1);
      const lockDir = path.join(second, ".tasks", TASK_ID, "state.lock");
      const helper = path.join(second, "lock-holder.mjs");
      const readyFile = path.join(second, "lock-holder.ready");
      const lockModule = fileURLToPath(new URL("../src/store/process-lock.js", import.meta.url));
      await writeFile(helper, [
        `import { writeFileSync } from "node:fs";`,
        `import { tryAcquireProcessLock } from ${JSON.stringify(pathToFileURL(lockModule).href)};`,
        `const release = tryAcquireProcessLock(process.argv[2]);`,
        `if (!release) { process.exit(2); }`,
        `writeFileSync(process.argv[3], "ready");`,
        `setTimeout(() => { release(); process.exit(0); }, 1500);`,
      ].join("\n"), "utf8");
      const holder = spawn(process.execPath, [helper, lockDir, readyFile], { stdio: "ignore" });
      // Deterministic start: wait until the holder actually owns the lock.
      const deadline = Date.now() + 10_000;
      while (!existsSync(readyFile)) {
        if (Date.now() >= deadline) throw new Error("the lock holder never acquired state.lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      const started = Date.now();
      assert.equal(lockStore.writeFailureFacts(TASK_ID, 1, process.pid, facts), "written");
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 300, `the dedicated entry must wait for the state.lock holder (waited ${elapsed}ms)`);
      await new Promise((resolve) => holder.on("close", resolve));
      assert.equal(holder.exitCode, 0);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("D4+D6: stale workers, attempt switches, duplicates, divergent candidates, and corrupt files never replace a root cause", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: { code: "insufficient_quota", attribution: { providerErrorCode: "insufficient_quota" } },
  });
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.error_code, "zcode_usage_exhausted");
    const attempt = fixture.attempt;
    const original = await readFile(path.join(fixture.dataRoot, ".tasks", TASK_ID, "attempts", String(attempt), "failure-facts.json"), "utf8");
    const facts = fixture.store.readFailureFacts(TASK_ID, attempt).facts!;

    // The worker's own terminal state rejects every later delivery, even the
    // identical snapshot: a terminal attempt is never backfilled.
    assert.throws(() => fixture.store.writeFailureFacts(TASK_ID, attempt, process.pid, facts), /non-running/);
    assert.equal(await readFile(path.join(fixture.dataRoot, ".tasks", TASK_ID, "attempts", String(attempt), "failure-facts.json"), "utf8"), original);

    // Attempt switch: the manager queued attempt 2; the old worker (same pid,
    // stale attempt) cannot write the archived attempt, a fake new-attempt
    // snapshot, or anything at all.
    fixture.store.writeStatus(TASK_ID, { status: "queued", attempt: attempt + 1, worker_pid: null, finished_at: null, cancel_requested: null, cleanup_unverified: null });
    assert.throws(() => fixture.store.writeFailureFacts(TASK_ID, attempt, process.pid, facts), /stale attempt/);
    assert.equal(await readFile(path.join(fixture.dataRoot, ".tasks", TASK_ID, "attempts", String(attempt), "failure-facts.json"), "utf8"), original);
    assert.throws(() => fixture.store.writeFailureFacts(TASK_ID, attempt + 1, process.pid, facts), /non-running|execution claim/, "a queued new attempt without a fresh claim accepts no evidence");
    assert.equal(fixture.store.readFailureFacts(TASK_ID, attempt + 1).facts, null);

    // Old worker (foreign pid) with the correct old attempt id: rejected.
    fixture.store.writeStatus(TASK_ID, { status: "running", attempt, worker_pid: process.pid + 99 });
    assert.throws(() => fixture.store.writeFailureFacts(TASK_ID, attempt, process.pid + 99, facts), /execution claim/, "a foreign writer matching only status.worker_pid still lacks the claim");
    assert.equal(await readFile(path.join(fixture.dataRoot, ".tasks", TASK_ID, "attempts", String(attempt), "failure-facts.json"), "utf8"), original);

    // Atomic publication: no temporary files remain, so readers never observe a partial snapshot.
    const attemptDir = path.join(fixture.dataRoot, ".tasks", TASK_ID, "attempts", String(attempt));
    const leftovers = (await readdir(attemptDir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

// ---- L-scenarios: lifecycle isolation ---------------------------------------

test("L1: cleanup_failed keeps its lifecycle priority while the established quota root cause is preserved", { timeout: 30_000 }, async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "bridge-facts-l1-"));
  try {
    const store = new TaskStore(dataRoot);
    store.createTask(makeTask({ task_id: TASK_ID }), "2026-10-18T00:00:00.000Z");
    const quotaFacts = buildFailureFacts({
      source: "turn_event", phase: "turn_terminal",
      providerCode: "insufficient_quota", httpStatus: 429, accepted: "yes",
    });
    const adapter: WorkerAdapter = {
      startTask: async () => ({ taskId: TASK_ID, attempt: 1, workerPid: process.pid, zcodePid: null, startedAt: "2026-10-18T00:00:00.000Z" }),
      continueTask: async () => { throw new Error("not used"); },
      getStatus: async () => ({ state: "exited", workerPid: process.pid, zcodePid: null, exitCode: 1, signal: null }),
      cancelTask: async () => undefined,
      getResult: async () => {
        // The real wiring path: the adapter submits through the dedicated entry
        // before the outcome reports an unverified cleanup.
        store.writeFailureFacts(TASK_ID, 1, process.pid, quotaFacts);
        const outcome: ZCodeRunOutcome = {
          attempts: 1, cancelled: false, stdout: "", stderr: "", exitCode: 1, signal: null,
          sessionId: SESSION_ID, response: "", usage: null, timedOut: false,
          stdoutTruncated: false, stderrTruncated: false, agentReport: null,
          reportCandidate: null, reportError: "ZCode turn failed", errorCode: "zcode_nonzero_exit",
          cleanupError: "process termination could not be verified", cleanupVerified: false,
        };
        return outcome;
      },
    };
    const run = await runWorkerTask({ dataRoot, taskId: TASK_ID, attempt: 1, adapter });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "cleanup_failed", "the cleanup lifecycle conclusion keeps priority");
    const { facts } = store.readFailureFacts(TASK_ID, 1);
    assert.ok(facts);
    assert.equal(facts!.category, "quota_exhausted", "the execution root cause is retained, not rewritten to a cleanup reason");
    assert.equal(store.readStatus(TASK_ID).cleanup_unverified, true);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("L1b: a report-only failure fabricates no provider facts", { timeout: 30_000 }, async () => {
  const runtime = await makeFakeRuntime({ reportOverride: "this is not a report at all" });
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "invalid_agent_report");
    assert.equal(fixture.store.readFailureFacts(TASK_ID, fixture.attempt).facts, null, "report-plane failures never receive provider failure facts");
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});

test("L2: deleted, corrupt, and forged facts never influence status, results, or any manager/ledger consumption", { timeout: 30_000 }, async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "bridge-facts-l2-"));
  try {
    const store = new TaskStore(dataRoot);
    store.createTask(makeTask({ task_id: TASK_ID }), "2026-10-18T00:00:00.000Z");
    store.writeStatus(TASK_ID, { status: "running", worker_pid: process.pid }, 1);
    store.claimWorkerExecution(TASK_ID, 1);
    const facts = buildFailureFacts({ source: "turn_event", phase: "turn_terminal", providerCode: "insufficient_quota", accepted: "yes" });
    store.writeFailureFacts(TASK_ID, 1, process.pid, facts);
    const factsFile = path.join(dataRoot, ".tasks", TASK_ID, "attempts", "1", "failure-facts.json");

    // Corrupt the file, then forge a snapshot carrying disabled-contract
    // values; validation rejects it on read while lifecycle reads stay normal.
    await writeFile(factsFile, "{not json at all", "utf8");
    assert.deepEqual(store.readFailureFacts(TASK_ID, 1), { facts: null, corrupt: true });
    assert.equal(store.readStatus(TASK_ID).status, "running");
    assert.equal(store.readResult(TASK_ID), null);
    assert.ok(store.readObservationEvidence(TASK_ID, 1));
    await writeFile(factsFile, JSON.stringify({ ...facts, runtime_retryable: true, runtime_retryable_basis: "versioned_mapping" }), "utf8");
    assert.equal(store.readFailureFacts(TASK_ID, 1).corrupt, true, "forged disabled-contract values fail validation on read");
    assert.equal(store.readStatus(TASK_ID).status, "running");
    await rm(factsFile);
    assert.equal(store.readFailureFacts(TASK_ID, 1).facts, null);

    // Structural guard: no manager, ledger, or MCP module consumes the facts —
    // they are never a state, recovery, occupancy, or READY input.
    const forbiddenRoots = ["manager", "ledger", "mcp"];
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!entry.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        if (text.includes("failure-facts") || text.includes("failure_facts") || text.includes("FailureFacts")) {
          offenders.push(path.relative(srcRoot, full));
        }
      }
    };
    for (const root of forbiddenRoots) walk(path.join(srcRoot, root));
    assert.deepEqual(offenders, [], "manager/ledger/mcp must not consume failure facts");
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("L3: any classification or runtime_retryable=true never spawns a worker, continues, or replays the prompt", { timeout: 40_000 }, async () => {
  const runtime = await makeFakeRuntime({
    turnFailure: {
      code: "rate_limit_error",
      type: "model_rate_limited",
      attribution: { retryable: true, statusCode: 429 },
    },
  });
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    assert.equal(run.result.status, "failed");
    assert.equal(run.result.error_code, "zcode_nonzero_exit", "a retryable rate limit is still a plain public failure");
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.equal(facts!.category, "rate_limited");
    assert.equal(facts!.runtime_retryable, true);
    assert.equal(facts!.runtime_retryable_basis, "reported");
    // No respawn slot, no second attempt, no prompt replay: one send total.
    assert.equal(existsSync(path.join(fixture.dataRoot, ".tasks", TASK_ID, "attempts", String(fixture.attempt), "respawn.claim")), false);
    assert.equal(fixture.store.readStatus(TASK_ID).attempt, fixture.attempt);
    assert.equal(fixture.store.readStatus(TASK_ID).status, "failed");
    const requests = await readRequestLog(runtime.requestLog);
    assert.equal(requests.filter((request) => request["method"] === "session/send").length, 1);
  } finally {
    await fixture.cleanup();
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
  const fixture = await makeWorkerFixture(runtime.root);
  try {
    await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: TASK_ID,
      attempt: fixture.attempt,
      resolver: { resolve: async () => runtime.config },
    });
    const { facts } = fixture.store.readFailureFacts(TASK_ID, fixture.attempt);
    assert.ok(facts);
    assert.equal(facts!.category, "model_unavailable", "the unaffected direct category still stands");
    assert.equal(facts!.runtime_retryable, null);
    assert.equal(facts!.runtime_retryable_basis, null);
    assert.equal(facts!.evidence_conflict, true);
    assert.equal(facts!.evidence_basis, "runtime_type_or_reason");
  } finally {
    await fixture.cleanup();
    await runtime.cleanup();
  }
});
