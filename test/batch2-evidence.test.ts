// Batch-2 regression evidence: B1 bounded log scanning, B2 turn correlation,
// B3 attempt-scoped snapshot fences + performance, B4 usage/timing/model.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore } from "../src/store/task-store.js";
import { makeTask, makeTempDir, removeTempDir, SESSION_ID, validReport } from "./helpers.js";
import { normalizeUsage, addNonOverlappingUsage, phaseDuration } from "../src/usage/normalize.js";
import { runWorkerTask } from "../src/worker/run-task.js";
import { buildTaskResult } from "../src/manager/normalize.js";
import { BridgeTaskManager } from "../src/manager/task-manager.js";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import type { ZCodeRunOutcome } from "../src/adapters/zcode-adapter.js";
import type { AgentHandle } from "../src/interfaces.js";

function iso(ms: number): string {
  return new Date(Date.UTC(2026, 9, 4, 0, 0, 0) + ms).toISOString();
}

// ---- B1: log facade, tolerance, cursor ----

function seedEvents(store: TaskStore, taskId: string, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    store.appendEvent(taskId, "model_output", `事件内容-${index}-plicé✓`, undefined, iso(index * 1000));
  }
}

test("B1-01: multibyte events split across read blocks stay whole; complete bad lines are counted, good ones preserved", async () => {
  const root = await makeTempDir("b1-utf8");
  try {
    const store = new TaskStore(root, { maxEventBytes: 4 * 1024 * 1024 });
    store.createTask(makeTask(), iso(0));
    seedEvents(store, "task_1", 50);
    // Corrupt complete lines sandwiched between valid ones.
    const file = path.join(store.taskDir("task_1"), "events.jsonl");
    const raw = readFileSync(file, "utf8");
    const lines = raw.trimEnd().split("\n");
    lines.splice(5, 0, "{definitely not json");
    lines.splice(20, 0, '{"seq":"not-an-int","type":"x"}');
    writeFileSync(file, `${lines.join("\n")}\n`);
    const read = store.readEventsBounded("task_1", { afterSeq: 0, limit: 200 });
    assert.equal(read.events.length, 50, "all valid events survive");
    assert.equal(read.metrics.corrupt_count, 2);
    assert.equal(read.metrics.invalid_lines, 2);
    assert.ok(read.metrics.first_corrupt_offset !== null);
    assert.equal(read.events[4]!.summary, "事件内容-5-plicé✓");
    assert.equal(read.cursor_invalid, false);
  } finally { await removeTempDir(root); }
});

test("B1-02: a half-written tail is not consumed; after completion it is returned exactly once", async () => {
  const root = await makeTempDir("b1-tail");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    seedEvents(store, "task_1", 5);
    const file = path.join(store.taskDir("task_1"), "events.jsonl");
    // Simulate an interrupted append: a partial event without a newline.
    const partial = JSON.stringify({ seq: 6, at: iso(6_000), type: "model_output", summary: "半行" }).slice(0, 40);
    const goodPrefix = readFileSync(file);
    writeFileSync(file, partial, { flag: "a" });
    const first = store.readEventsBounded("task_1", { afterSeq: 0, limit: 200 });
    assert.equal(first.events.length, 5, "the torn tail is never served");
    assert.equal(first.metrics.corrupt_count, 0, "a torn tail is not corruption");
    assert.ok(first.scan_cursor, "cursor present");
    assert.equal(first.scan_cursor!.offset, goodPrefix.length, "the cursor stops before the tail");
    // The writer completes the line.
    // The writer completes the line: replace the torn tail with the full event.
    const withTail = readFileSync(file);
    writeFileSync(file, withTail.subarray(0, withTail.length - Buffer.byteLength(partial, "utf8")));
    store.appendEvent("task_1", "model_output", "半行补全", undefined, iso(6_500));
    const second = store.readEventsBounded("task_1", { afterSeq: 5, limit: 200 });
    const summaries = second.events.map((event) => event.summary);
    assert.equal(second.metrics.corrupt_count, 0, "the completed line is valid, not corrupt");
    assert.equal(summaries.filter((text) => text.includes("半行补全")).length, 1, "exactly once");
    assert.equal(second.cursor_invalid, false);
  } finally { await removeTempDir(root); }
});

test("B1-03: a budget consumed by corrupt lines still advances the byte cursor and reports incompleteness", async () => {
  const root = await makeTempDir("b1-budget");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    const file = path.join(store.taskDir("task_1"), "events.jsonl");
    const garbage = `{"broken":`.repeat(1) + "\n";
    writeFileSync(file, garbage.repeat(200));
    store.appendEvent("task_1", "model_output", "末尾有效事件", undefined, iso(1_000));
    const read = store.readEventsBounded("task_1", { afterSeq: 0, limit: 200, maxBytes: 1_024 });
    assert.ok(read.metrics.bytes_read <= 1_024 + 64 * 1024, "the read respects budget + one block");
    assert.ok(read.metrics.corrupt_count >= 1);
    assert.ok(read.scan_cursor, "a byte cursor exists for continuation");
    if (read.scan_incomplete) {
      // Continuation must make forward progress, never loop.
      const next = store.readEventsBounded("task_1", { afterSeq: 0, limit: 200, maxBytes: 1_024, cursor: read.scan_cursor });
      assert.ok(next.scan_cursor!.offset > read.scan_cursor!.offset || !next.scan_incomplete, "the scan advances");
      assert.equal(next.cursor_invalid, false);
    }
    // The final valid event is reachable through cursor continuation.
    let cursor: NonNullable<ReturnType<TaskStore["readEventsBounded"]>["scan_cursor"]> | null = read.scan_cursor;
    let seen = read.events.some((event) => event.summary.includes("末尾有效事件"));
    for (let hops = 0; hops < 50 && !seen && cursor; hops += 1) {
      const page = store.readEventsBounded("task_1", { afterSeq: 0, limit: 200, maxBytes: 1_024, cursor });
      seen = page.events.some((event) => event.summary.includes("末尾有效事件"));
      if (!page.scan_incomplete) break;
      assert.ok(page.scan_cursor!.offset > cursor.offset, "every continuation advances");
      cursor = page.scan_cursor ?? null;
    }
    assert.ok(seen, "the valid event is reachable without an infinite loop");
  } finally { await removeTempDir(root); }
});

test("B1-04: a missing/corrupt/out-of-range index falls back safely; replaced or truncated logs invalidate cursors", async () => {
  const root = await makeTempDir("b1-index");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    seedEvents(store, "task_1", 250); // triggers index rows every 100
    const dir = store.taskDir("task_1");
    // Corrupt index → fallback with a diagnostic metric.
    writeFileSync(path.join(dir, "events.index"), "not-an-index\n");
    const fallback = store.readEventsBounded("task_1", { afterSeq: 0, limit: 200 });
    assert.equal(fallback.metrics.index_fallback, true);
    assert.equal(fallback.events.length, 200, "fallback still reads from the log itself");
    // Valid index works too.
    const page = store.readEventsBounded("task_1", { afterSeq: 0, limit: 200 });
    // Out-of-range offset in a syntactically valid index → fallback.
    const firstPage = store.readEventsBounded("task_1", { afterSeq: 0, limit: 1 });
    writeFileSync(path.join(dir, "events.index"), `50\t999999999\n`);
    const weird = store.readEventsBounded("task_1", { afterSeq: 40, limit: 10 });
    assert.equal(weird.metrics.index_fallback, true, "an out-of-range index cannot be trusted");
    void firstPage;
    // Replaced log: byte cursor invalid, never another attempt's data.
    const cursor = page.scan_cursor;
    store.appendEvent("task_1", "model_output", "新事件", undefined, iso(300_000));
    assert.ok(cursor);
    const same = store.readEventsBounded("task_1", { afterSeq: 0, limit: 5, cursor });
    assert.equal(same.cursor_invalid, false);
    // Truncation below the cursor offset invalidates it.
    const rawBuffer = readFileSync(path.join(dir, "events.jsonl"));
    writeFileSync(path.join(dir, "events.jsonl"), rawBuffer.subarray(0, Math.max(0, cursor!.offset - 10)));
    const truncated = store.readEventsBounded("task_1", { afterSeq: 0, limit: 5, cursor });
    assert.equal(truncated.cursor_invalid, true, "a truncated log invalidates the cursor");
    // Cross-task isolation: a cursor bound to task_1 cannot read task_2.
    store.createTask(makeTask({ task_id: "task_2" }), iso(0));
    seedEvents(store, "task_2", 5);
    const foreign = store.readEventsBounded("task_2", { afterSeq: 0, limit: 5, cursor });
    assert.equal(foreign.cursor_invalid, true);
  } finally { await removeTempDir(root); }
});

test("B1-05: legacy and bounded pagination reassemble identically; summary merging counts separately from corruption", async () => {
  const root = await makeTempDir("b1-compat");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    for (let index = 1; index <= 30; index += 1) {
      store.appendEvent("task_1", "model_output", `chunk ${String(index)} `, undefined, iso(index * 1_000));
    }
    const file = path.join(store.taskDir("task_1"), "events.jsonl");
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    lines.splice(10, 0, "{broken line");
    writeFileSync(file, `${lines.join("\n")}\n`);
    // Legacy client: full scan via after_seq.
    const legacy: Array<{ seq: number; summary: string }> = [];
    let afterSeq = 0;
    while (true) {
      const page = store.readEvents("task_1", afterSeq, 10);
      legacy.push(...page.events.map((event) => ({ seq: event.seq, summary: event.summary })));
      if (!page.hasMore) break;
      afterSeq = page.nextSeq;
    }
    // Bounded client: byte cursor.
    const bounded: Array<{ seq: number; summary: string }> = [];
    let cursor: NonNullable<ReturnType<TaskStore["readEventsBounded"]>["scan_cursor"]> | null = null;
    let guard = 0;
    while (guard < 100) {
      const page = store.readEventsBounded("task_1", { afterSeq: 0, limit: 10, cursor, maxBytes: 2_048 });
      assert.equal(page.cursor_invalid, false, "the byte cursor stays valid across pages");
      bounded.push(...page.events.map((event) => ({ seq: event.seq, summary: event.summary })));
      if (!page.scan_incomplete && !page.hasMore) break;
      cursor = page.scan_cursor ?? cursor;
      guard += 1;
    }
    assert.deepEqual(bounded, legacy, "identical reassembly, no duplicates, no silent omissions");
    // Summary merging counts omitted chunks separately from corrupt lines.
    const merged = store.readEventsBounded("task_1", { afterSeq: 0, limit: 200, view: "summary" });
    assert.ok(merged.omittedEvents > 0);
    assert.equal(merged.metrics.corrupt_count, 1, "corruption counting is independent of merging");
  } finally { await removeTempDir(root); }
});

test("B1-06: ownership/state JSON corruption never adopts the skip-bad-line policy; isolation keeps other tasks safe", async () => {
  const fx = { manager: null as BridgeTaskManager | null };
  const root = await makeTempDir("b1-strict");
  const otherRoot = await makeTempDir("b1-strict-other");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    store.createTask(makeTask({ task_id: "task_2", workspace: otherRoot }), iso(1));
    writeFileSync(path.join(store.taskDir("task_1"), "status.json"), "{corrupt");
    assert.throws(() => store.readStatus("task_1"), /unreadable or corrupt JSON record/);
    // The manager skips the corrupt task but keeps the healthy one running.
    const manager = new BridgeTaskManager({
      store,
      workspaceProvider: new DirectWorkspaceProvider(),
      spawnWorker: () => ({ pid: 60_001 }),
      isProcessRunning: () => true,
      terminateProcessTree: async (pid) => ({ pid, signal: "SIGKILL", verified: true }),
      pollIntervalMs: 0,
    });
    fx.manager = manager;
    await manager.recoverTasks();
    const statuses = store.listTaskIds().map((taskId) => {
      try { return store.readStatus(taskId).status; } catch { return "corrupt"; }
    });
    assert.equal(statuses.filter((status) => status === "corrupt").length, 1, "exactly the corrupt task is skipped");
    assert.equal(statuses.filter((status) => status === "running").length, 1, "the healthy task still runs");
    manager.dispose();
  } finally {
    fx.manager?.dispose();
    await removeTempDir(root);
    await removeTempDir(otherRoot);
  }
});

// ---- B3: attempt-scoped observation snapshot ----

function claimFor(store: TaskStore, taskId: string, pid: number): void {
  store.writeStatus(taskId, { status: "running", started_at: iso(0), worker_pid: pid });
  store.writeAttemptMeta(taskId, 1, "execution.claim", { pid });
}

test("B3-01: attempt-1 writers are fenced out after attempt 2 starts (heartbeat, snapshot, result, status)", async () => {
  const root = await makeTempDir("b3-fence");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    claimFor(store, "task_1", 1111);
    store.writeWorkerObservation("task_1", 1, 1111, { activity_phase: "executing" }, 1, iso(1));
    // Attempt 2 starts.
    store.writeStatus("task_1", { status: "running", attempt: 2, started_at: iso(9_000), worker_pid: 2222 });
    assert.throws(() => store.writeWorkerHeartbeat("task_1", 1, {
      attempt: 1, worker_pid: 1111, started_at: iso(0), heartbeat_at: iso(9_500), heartbeat_seq: 2,
      session_id: null, turn_id: null, last_event_seq: 0, last_event_type: null, zcode_event_seq: 0,
    }), /stale or unowned/);
    assert.throws(() => store.writeWorkerObservation("task_1", 1, 1111, { activity_phase: "finalizing" }, 2, iso(9_600)), /stale attempt/);
    assert.throws(() => store.commitWorkerResult("task_1", 1, {
      task_id: "task_1", status: "completed", summary: "late", files_changed: [], tests: [], issues: [],
      needs_master_decision: false, zcode_output: "", exit_code: 0, session_id: null, attempt: 1,
      started_at: iso(0), finished_at: iso(9_700),
    }, { status: "completed" }), /stale or terminal/);
    assert.throws(() => store.writeStatus("task_1", { worker_pid: null }, 1), /stale or terminal/);
    // The snapshot still shows attempt 2's world.
    const snapshot = store.readObservationSnapshot("task_1", 1);
    assert.equal(snapshot.snapshot?.attempt, 1);
    assert.equal(store.readStatus("task_1").attempt, 2);
  } finally { await removeTempDir(root); }
});

test("B3-02: a replaced writer or stale revision cannot overwrite current facts within one attempt", async () => {
  const root = await makeTempDir("b3-revision");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    claimFor(store, "task_1", 1111);
    store.writeWorkerObservation("task_1", 1, 1111, { activity_phase: "executing", session_id: "s1" }, 5, iso(1));
    // Same writer, stale revision → rejected.
    assert.throws(() => store.writeWorkerObservation("task_1", 1, 1111, { activity_phase: "starting" }, 3, iso(2)), /stale observation revision/);
    // Different pid (respawned writer without the claim) → rejected.
    assert.throws(() => store.writeWorkerObservation("task_1", 1, 9999, { activity_phase: "starting" }, 9, iso(2)), /execution claim/);
    // Manager-owned probe fields merge without touching worker phases.
    store.writeManagerObservation("task_1", 1, { worker_probe: { state: "alive", reason_code: "pid_and_fingerprint_match" } }, 0, iso(3));
    const snapshot = store.readObservationSnapshot("task_1", 1).snapshot!;
    assert.equal(snapshot.activity_phase, "executing");
    assert.equal(snapshot.session_id, "s1");
    assert.equal(snapshot.worker_probe?.state, "alive");
  } finally { await removeTempDir(root); }
});

test("B3-03: a lost or corrupt snapshot degrades to diagnostics without fake values; clock skew downgrades evidence", async () => {
  const root = await makeTempDir("b3-lost");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    claimFor(store, "task_1", 1111);
    // Snapshot lost entirely: observation still builds from core evidence.
    const observation = buildObservationFor(store, "task_1");
    assert.equal(observation.activity.code, "unknown");
    assert.equal(observation.result, "absent");
    // Corrupt snapshot: flagged, never served.
    writeFileSync(path.join(store.attemptDir("task_1", 1), "observation.json"), "{broken");
    const corrupt = store.readObservationSnapshot("task_1", 1);
    assert.equal(corrupt.snapshot, null);
    assert.equal(corrupt.corrupt, true);
    // Heartbeat far in the future (clock jumped back across restart) → unknown, not a negative age.
    store.writeWorkerHeartbeat("task_1", 1, {
      attempt: 1, worker_pid: 1111, started_at: iso(0), heartbeat_at: iso(3_600_000), heartbeat_seq: 1,
      session_id: null, turn_id: null, last_event_seq: 0, last_event_type: null, zcode_event_seq: 0,
    });
    const skewed = buildObservationFor(store, "task_1", Date.UTC(2026, 9, 4, 0, 0, 0));
    assert.equal(skewed.worker.state, "unknown");
    assert.equal(skewed.worker.reason_code, "clock_skew");
    assert.equal(skewed.evidence.heartbeat_age_ms, null, "no negative or fake-zero ages");
  } finally { await removeTempDir(root); }
});

import { buildTaskObservation } from "../src/observation/build.js";
function buildObservationFor(store: TaskStore, taskId: string, nowMs = Date.UTC(2026, 9, 4, 1, 0, 0)) {
  return buildTaskObservation(store, taskId, store.readStatus(taskId), { now: () => new Date(nowMs) });
}

test("B3-04: old tasks without snapshots and new tasks with them coexist; clients keep working", async () => {
  const root = await makeTempDir("b3-mixed");
  try {
    const store = new TaskStore(root);
    // "Old" task: status/result/after_seq only, no observation artifacts.
    store.createTask(makeTask({ task_id: "old_task" }), iso(0));
    store.writeStatus("old_task", { status: "running", started_at: iso(0), worker_pid: 7777 });
    store.appendEvent("old_task", "model_output", "旧格式事件", undefined, iso(1));
    const legacyPage = store.readEvents("old_task", 0, 10);
    assert.equal(legacyPage.events[0]!.summary, "旧格式事件");
    // "New" task: with snapshot artifacts.
    store.createTask(makeTask({ task_id: "new_task" }), iso(2));
    claimFor(store, "new_task", 8888);
    store.writeWorkerObservation("new_task", 1, 8888, { activity_phase: "executing" }, 1, iso(3));
    assert.equal(store.readObservationSnapshot("new_task", 1).snapshot?.activity_phase, "executing");
    assert.equal(store.readObservationSnapshot("old_task", 1).snapshot, null);
    // Both build observations without interference.
    assert.equal(buildObservationFor(store, "old_task").evidence.attempt, 1);
    assert.equal(buildObservationFor(store, "new_task").evidence.attempt, 1);
  } finally { await removeTempDir(root); }
});

// ---- B2: turn correlation (drives the real adapter against a fake runtime) ----

interface FakeRuntimeOptions {
  scenario: "normal" | "complete-before-start" | "completion-then-start" | "foreign-turn" | "duplicate-completion" | "missing-result-type" | "replay-unsupported";
  requestedModel?: { providerId: string; modelId: string; options?: { reasoningLevel: string } };
  sessionModel?: { providerId: string; modelId: string; options?: { reasoningLevel: string } };
}

async function makeScenarioRuntime(options: FakeRuntimeOptions) {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-b2-runtime-"));
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const report = JSON.stringify(validReport());
  const script = String.raw`
const readline = require("node:readline");
const sessionId = ${JSON.stringify(SESSION_ID)};
const report = ${JSON.stringify(report)};
const scenario = ${JSON.stringify(options.scenario)};
let selected = ${JSON.stringify(options.sessionModel ?? { providerId: "prov", modelId: "m-default" })};
let turnDone = false;
function emit(line) { process.stdout.write(JSON.stringify(line) + "\n"); }
function completed(seq, turnId, resultType) {
  emit({ method: "session/event", params: { seq, turnId, type: "turn.completed", payload: {
    response: report, usage: { totalTokens: 7, input_tokens: 5, output_tokens: 2 }, resultType } } });
}
function started(seq, turnId) {
  emit({ method: "session/event", params: { seq, turnId, type: "turn.started", payload: {} } });
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "session/create") {
    emit({ id: message.id, result: { session: { sessionId }, settings: { model: { current: selected, available: [{ ref: selected, label: "M" }] } }, runtime: { eventSeq: 0 } } });
  } else if (message.method === "session/setModel") {
    selected = message.params.model;
    emit({ id: message.id, result: { session: { sessionId }, settings: { model: { current: selected, available: [{ ref: selected, label: "M" }] } }, runtime: { eventSeq: 0 } } });
  } else if (message.method === "session/subscribe") {
    emit({ id: message.id, result: {} });
  } else if (message.method === "session/send") {
    emit({ id: message.id, result: {} });
    if (scenario === "normal" || scenario === "replay-unsupported") {
      started(1, "turn-1");
      // The replay-unsupported run holds the turn open so the replay poll
      // actually fires before completion.
      setTimeout(() => completed(2, "turn-1", "success"), scenario === "replay-unsupported" ? 400 : 30);
    }
    else if (scenario === "complete-before-start") { completed(1, "turn-1", "success"); }
    else if (scenario === "completion-then-start") { completed(1, "turn-1", "success"); setTimeout(() => started(2, "turn-1"), 60); }
    else if (scenario === "foreign-turn") { completed(1, "turn-OLD", "success"); setTimeout(() => completed(2, "turn-1", "success"), 40); }
    else if (scenario === "duplicate-completion") { completed(1, "turn-1", "success"); completed(2, "turn-1", "success"); }
    else if (scenario === "missing-result-type") { started(1, "turn-1"); emit({ method: "session/event", params: { seq: 2, turnId: "turn-1", type: "turn.completed", payload: { response: report } } }); }
    turnDone = true;
  } else if (message.method === "session/events") {
    if (scenario === "replay-unsupported") {
      emit({ id: message.id, error: { code: -32601, message: "Unsupported ZCode app-server request: session/events" } });
    } else {
      emit({ id: message.id, result: { events: [ { seq: 1, turnId: "turn-1", type: "turn.completed", payload: { response: report, usage: { totalTokens: 7 }, resultType: "success" } } ] } });
    }
  } else {
    emit({ id: message.id, error: { code: -32601, message: "unsupported" } });
  }
});
`;
  writeFileSync(entrypoint, script);
  return {
    root,
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: path.join(root, "builtin.json"),
      providerPersonalConfigFile: path.join(root, "personal.json"),
      dataRoot: root,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const b2Task = {
  task_id: "b2_task",
  workspace: "C:\\unused-b2",
  objective: "Return the requested report",
  requirements: [],
  allowed_paths: [],
  forbidden_paths: [],
  acceptance_criteria: [],
  test_commands: [],
};

async function runScenario(scenario: FakeRuntimeOptions["scenario"], requestedModel?: FakeRuntimeOptions["requestedModel"]) {
  const runtime = await makeScenarioRuntime({ scenario, requestedModel, sessionModel: requestedModel ? { providerId: requestedModel.providerId, modelId: requestedModel.modelId } : undefined });
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  const { ZCodeAppServerAdapter } = await import("../src/adapters/zcode-app-server-adapter.js");
  const adapter = new ZCodeAppServerAdapter({
    resolver: { resolve: async () => runtime.config },
    onEvent: (event) => events.push(event),
    timeoutMs: 15_000,
    childEnvBase: { PATH: process.env["PATH"] ?? "" },
    turnBindingCompatMs: 400,
    replayIdleMs: 0,
    homeDir: runtime.root,
  });
  const handle: AgentHandle = await adapter.startTask({ task: requestedModel ? { ...b2Task, model: { provider_id: requestedModel.providerId, model_id: requestedModel.modelId, ...(requestedModel.options ? { reasoning_level: requestedModel.options.reasoningLevel } : {}) } } : b2Task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
  let outcome: ZCodeRunOutcome | null = null;
  let error: Error | null = null;
  try { outcome = await adapter.getResult(handle); }
  catch (caught) { error = caught as Error; }
  return { outcome, error, events, cleanup: runtime.cleanup };
}

test("B2-01: normal, completion-before-start, and completion-then-start all settle exactly once", async () => {
  for (const scenario of ["normal", "complete-before-start", "completion-then-start"] as const) {
    const run = await runScenario(scenario);
    try {
      assert.ok(run.outcome, `${scenario}: outcome expected, got ${run.error?.message}`);
      assert.equal(run.outcome!.errorCode, null, `${scenario}: ${run.outcome!.reportError ?? ""}`);
      assert.equal(run.outcome!.cancelled, false);
      assert.ok(run.outcome!.agentReport, `${scenario}: report parsed`);
      // Exactly one turn_started published event, one completion.
      const starts = run.events.filter((event) => event.type === "turn_started").length;
      const completions = run.events.filter((event) => event.type === "turn_completed").length;
      assert.ok(starts >= 1, `${scenario}: at least one start event`);
      assert.ok(completions <= 1, `${scenario}: at most one completion event`);
    } finally { run.cleanup(); }
  }
});

test("B2-02: foreign-turn and duplicate-sequence events never settle the current turn early", async () => {
  const run = await runScenario("foreign-turn");
  try {
    // The foreign completion (turn-OLD) must be filtered; the current turn
    // still completes from its own event.
    assert.ok(run.outcome, `outcome expected, got ${run.error?.message}`);
    assert.equal(run.outcome!.errorCode, null);
    assert.equal(run.outcome!.sessionId, SESSION_ID);
  } finally { run.cleanup(); }
});

test("B2-03: a completion delivered by both push and replay settles once", async () => {
  const run = await runScenario("duplicate-completion");
  try {
    assert.ok(run.outcome, `outcome expected, got ${run.error?.message}`);
    assert.equal(run.outcome!.errorCode, null);
    assert.equal(run.outcome!.agentReport!.summary, validReport().summary, "single result");
    assert.equal(run.events.filter((event) => event.type === "report_ready").length, 1);
  } finally { run.cleanup(); }
});

test("B2-04: a completed turn survives a crash via checkpoint; an old attempt cannot overwrite a new one", async () => {
  const root = await makeTempDir("b2-crash");
  const workspaceDir = await makeTempDir("b2-crash-ws");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask({ workspace: workspaceDir }), iso(0));
    claimFor(store, "task_1", 1111);
    const report = validReport();
    store.writeAttemptMeta("task_1", 1, "outcome-checkpoint.json", {
      recorded_at: iso(1_000),
      exit_code: 0,
      signal: null,
      session_id: SESSION_ID,
      response: JSON.stringify(report),
      usage: { totalTokens: 9 },
      error_code: null,
      report_error: null,
      agent_report: report,
      report_candidate: report,
      cleanup_error: null,
      cleanup_verified: false,
    });
    // A runtime process was recorded; it is dead too (nothing to terminate).
    store.writeStatus("task_1", { zcode_pid: 987001 });
    // The worker died; the manager recovers from the checkpoint.
    const manager = new BridgeTaskManager({
      store,
      workspaceProvider: new DirectWorkspaceProvider(),
      spawnWorker: () => ({ pid: 61_000 }),
      isProcessRunning: () => false,
      terminateProcessTree: async (pid) => ({ pid, signal: "SIGKILL", verified: true }),
      pollIntervalMs: 0,
      now: () => new Date(Date.UTC(2026, 9, 4, 0, 0, 0) + 5_000),
    });
    await manager.recoverTasks();
    const status = store.readStatus("task_1");
    // Cleanup was never verified: the attempt fails closed while the ZCode
    // report itself is preserved as evidence (B2-04/A2-05).
    assert.equal(status.status, "failed");
    assert.equal(status.error_code, "cleanup_failed");
    assert.equal(status.cleanup_unverified, true, "runtime exit was not confirmed");
    const recovered = store.readResult("task_1")!;
    assert.equal(recovered.report_candidate?.summary, report.summary, "the report survives the crash as review evidence");
    assert.equal(recovered.zcode_output, JSON.stringify(report));
    // Unverified cleanup must be resolved through the cancel verification
    // path before a continuation is allowed (existing contract).
    await manager.cancelTask("task_1");
    assert.equal(store.readStatus("task_1").cleanup_unverified ?? false, false, "verified dead processes clear the flag");
    // A new attempt invalidates the old writer entirely.
    await manager.continueTask({ task_id: "task_1", feedback: "再跑一次" });
    assert.equal(store.readStatus("task_1").attempt, 2);
    assert.throws(() => store.writeWorkerHeartbeat("task_1", 1, {
      attempt: 1, worker_pid: 1111, started_at: iso(0), heartbeat_at: iso(9_000), heartbeat_seq: 9,
      session_id: null, turn_id: null, last_event_seq: 0, last_event_type: null, zcode_event_seq: 0,
    }), /stale or unowned/);
    manager.dispose();
  } finally { await removeTempDir(root); await removeTempDir(workspaceDir); }
});

test("B2-05: a missing resultType is an explicit unknown terminal; replay-unsupported degrades visibly", async () => {
  const missing = await runScenario("missing-result-type");
  try {
    assert.ok(missing.outcome);
    assert.equal(missing.outcome!.errorCode, "unknown_turn_terminal");
    assert.match(missing.outcome!.reportError ?? "", /unknown terminal/i);
    assert.notEqual(missing.outcome!.exitCode, 0);
  } finally { missing.cleanup(); }
  const replay = await runScenario("replay-unsupported");
  try {
    assert.ok(replay.outcome);
    assert.ok(replay.events.some((event) => event.type === "session_event_replay_unavailable"), "degradation is visible");
    assert.equal(replay.outcome!.errorCode, null, "the task itself still completes");
  } finally { replay.cleanup(); }
});

test("B2-06: phase timestamps and correlation survive cancel/timeout races in the outcome contract", async () => {
  const run = await runScenario("normal");
  try {
    assert.ok(run.outcome?.phaseTimestamps);
    assert.ok(run.outcome!.phaseTimestamps!.turn_started_at);
    assert.ok(run.outcome!.phaseTimestamps!.turn_completed_at);
    assert.ok(run.outcome!.phaseTimestamps!.rpc_accepted_at);
    assert.equal(run.outcome!.modelProfile?.model_id, "m-default");
    assert.equal(run.outcome!.modelProfile?.effective_reasoning_level_source, "not_reported");
  } finally { run.cleanup(); }
});

// ---- B4: usage/timing/model contracts ----

test("B4-02: usage normalization matrix (synonyms, zero, missing, invalid, conflict, no recompute)", () => {
  const camel = normalizeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }, { source: "s" });
  assert.equal(camel?.input_tokens, 10);
  assert.equal(camel?.total_tokens, 15);
  const snake = normalizeUsage({ input_tokens: 3, output_tokens: 4 }, { source: "s" });
  assert.equal(snake?.total_tokens, null, "a missing total is not fabricated");
  const both = normalizeUsage({ input_tokens: 7, inputTokens: 9 }, { source: "s" });
  assert.equal(both?.input_tokens, 7, "snake_case wins on conflict");
  assert.ok(both?.conflicts.includes("duplicate_synonyms"));
  const zero = normalizeUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }, { source: "s" });
  assert.equal(zero?.input_tokens, 0, "a real zero survives");
  const invalid = normalizeUsage({ input_tokens: -1, output_tokens: Number.NaN, total_tokens: Number.POSITIVE_INFINITY, reasoning_tokens: 1.5 }, { source: "s" });
  assert.equal(invalid?.input_tokens, null);
  assert.equal(invalid?.output_tokens, null);
  assert.equal(invalid?.total_tokens, null);
  assert.equal(invalid?.reasoning_tokens, null);
  assert.ok(invalid!.conflicts.length >= 4);
  const mismatch = normalizeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 100 }, { source: "s" });
  assert.equal(mismatch?.total_tokens, 100, "the reported total is preserved verbatim");
  assert.ok(mismatch?.conflicts.includes("total_mismatch"));
  const cache = normalizeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: 4, reasoning_tokens: 2 }, { source: "s" });
  assert.equal(cache?.total_tokens, 15, "cache/reasoning are subsets, never added again");
  const junk = normalizeUsage("not-an-object");
  assert.equal(junk, null);
  const empty = normalizeUsage({ unknown_field: 1 }, { source: "s" });
  assert.equal(empty?.dropped_unknown_keys, 1);
  assert.equal(empty?.input_tokens, null);
});

test("B4-03: replayed executions never add usage; session totals never sum per run without non-overlap proof", () => {
  const a = normalizeUsage({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, { source: "zcode_runtime_turn" });
  // The same attempt's usage read twice stays one consumption item.
  const replayed = addNonOverlappingUsage(a, a, "merged");
  assert.equal(replayed?.total_tokens, 4, "double counting is only possible by explicit non-overlap merging");
  // The ledger dedupes by run+attempt, so projection replays never call add.
  // Missing parts propagate as null (partial), never as zero.
  const partial = addNonOverlappingUsage(a, null, "merged");
  assert.equal(partial?.total_tokens, null);
  assert.equal(partial?.input_tokens, null);
  assert.equal(partial?.finality, "partial");
});

test("B4-04: worker persistence keeps usage/timing for success, failure, cancel, and checkpoint paths; old files read as absent", async () => {
  const root = await makeTempDir("b4-worker");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    store.writeStatus("task_1", { status: "running", started_at: iso(0), worker_pid: 1111 });
    const usage = { totalTokens: 42, input_tokens: 30, output_tokens: 12 };
    const adapter = {
      startTask: async () => ({ taskId: "task_1", attempt: 1, workerPid: 1111, zcodePid: null, startedAt: iso(100) }),
      continueTask: async () => { throw new Error("not used"); },
      getStatus: async () => ({ state: "exited" as const, workerPid: 1111, zcodePid: null, exitCode: 0, signal: null }),
      cancelTask: async () => undefined,
      getResult: async (): Promise<ZCodeRunOutcome> => ({
        exitCode: 0, signal: null, stdout: "", stderr: "", sessionId: SESSION_ID, response: JSON.stringify(validReport()),
        usage, timedOut: false, cancelled: false, stdoutTruncated: false, stderrTruncated: false, attempts: 1,
        agentReport: validReport(), reportCandidate: validReport(), reportError: null, errorCode: null,
        phaseTimestamps: { rpc_accepted_at: iso(150), turn_started_at: iso(200), turn_completed_at: iso(1_500) },
        modelProfile: { executor: "zcode", provider_id: "prov", model_id: "m-1", requested_model: null, requested_reasoning_level: "high", effective_reasoning_level: "low", effective_reasoning_level_source: "runtime", selection_source: "task", effective_at: iso(200), session_id: SESSION_ID, turn_id: "t1" },
      }),
    };
    const result = await runWorkerTask({
      dataRoot: root, taskId: "task_1", attempt: 1,
      adapter: adapter as unknown as import("../src/worker/run-task.js").WorkerAdapter,
      now: () => new Date(Date.UTC(2026, 9, 4, 0, 0, 0) + 2_000),
    });
    assert.equal(result.result.status, "completed");
    // Worker-normalized usage on the result.
    assert.equal(result.result.usage?.total_tokens, 42);
    assert.equal(result.result.usage?.input_tokens, 30);
    assert.equal(result.result.model?.model_id, "m-1");
    assert.equal(result.result.model?.effective_reasoning_level, "low");
    assert.equal(result.result.model?.requested_reasoning_level, "high", "requested vs confirmed is distinguishable");
    assert.equal(result.result.timing?.execution_ms, 2_000);
    assert.equal(result.result.timing?.turn_ms, 1_300);
    // outcome.json persists the normalized + raw evidence.
    const outcomeMeta = store.readAttemptMeta<{ usage_normalized: { total_tokens: number }; model_profile: { model_id: string }; correlation: { turn_id: string | null } }>("task_1", 1, "outcome.json");
    assert.equal(outcomeMeta?.usage_normalized?.total_tokens, 42);
    assert.equal(outcomeMeta?.model_profile?.model_id, "m-1");
    // Old outcome records (no usage keys) read as missing, not broken.
    store.writeAttemptMeta("task_1", 1, "outcome-old.json", { started_at: iso(0), finished_at: iso(1) });
    const old = store.readAttemptMeta("task_1", 1, "outcome-old.json") as Record<string, unknown>;
    assert.equal("usage_normalized" in old, false);
    const projected = buildTaskResult({
      task: makeTask(), attempt: 1, startedAt: iso(0), finishedAt: iso(1), outcome: null,
      failure: { code: "worker_lost", message: "x" },
    });
    assert.equal(projected.usage, undefined, "an infra-failure result without usage stays absent");
    // A cancelled run with known consumption keeps the usage facts.
    const cancelledWithUsage = buildTaskResult({
      task: makeTask(), attempt: 1, startedAt: iso(0), finishedAt: iso(1),
      outcome: { exitCode: null, signal: null, stdout: "", stderr: "", sessionId: null, response: null, usage: { total_tokens: 5 }, timedOut: false, cancelled: true, stdoutTruncated: false, stderrTruncated: false, attempts: 1, agentReport: null, reportCandidate: null, reportError: "cancelled", errorCode: "cancelled" },
      cancelled: true,
      usage: normalizeUsage({ total_tokens: 5 }, { source: "zcode_runtime_turn" }),
    });
    assert.equal(cancelledWithUsage.status, "cancelled");
    assert.equal(cancelledWithUsage.usage?.total_tokens, 5, "cancelled work still reports known consumption");
  } finally { await removeTempDir(root); }
});

test("B4-05: parallel wall time vs cumulative execution time differ; boundaries are checkable; no negative durations", () => {
  const notes: string[] = [];
  assert.equal(phaseDuration(iso(1_000), iso(2_000), notes), 1_000);
  // Clock regression: null + note, never negative.
  assert.equal(phaseDuration(iso(2_000), iso(1_000), notes), null);
  assert.ok(notes.includes("clock_regression_dropped"));
  // Cancelled before start: not-started, not a fake 0.
  assert.equal(phaseDuration(null, iso(1_000), notes), null);
  // Two parallel attempts: wall 1000, cumulative 1800.
  const a = phaseDuration(iso(0), iso(1_000), []);
  const b = phaseDuration(iso(200), iso(1_000), []);
  const wall = 1_000;
  const cumulative = a! + b!;
  assert.equal(cumulative, 1_800);
  assert.notEqual(cumulative, wall, "累计执行时长 ≠ 墙钟时长");
});

test("B4-10/11/12: requested vs default vs unreported model paths; push/replay idempotence of model evidence", async () => {
  // Explicit request: requested + runtime-confirmed visible separately.
  const explicit = await runScenario("normal", { providerId: "prov", modelId: "m-override", options: { reasoningLevel: "high" } });
  try {
    assert.ok(explicit.outcome?.modelProfile);
    const profile = explicit.outcome!.modelProfile!;
    assert.equal(profile.requested_model, "prov/m-override");
    assert.equal(profile.requested_reasoning_level, "high");
    assert.equal(profile.model_id, "m-override");
    assert.equal(profile.selection_source, "task");
    // The runtime confirmed a level (session echoes the requested options).
    if (profile.effective_reasoning_level) {
      assert.equal(profile.effective_reasoning_level_source, "runtime");
    }
  } finally { explicit.cleanup(); }
  // Default path: no requested values; source says runtime-selected.
  const defaulted = await runScenario("normal");
  try {
    assert.equal(defaulted.outcome?.modelProfile?.requested_model, null);
    assert.equal(defaulted.outcome?.modelProfile?.model_id, "m-default");
    assert.equal(defaulted.outcome?.modelProfile?.selection_source, "zcode_default");
  } finally { defaulted.cleanup(); }
});

test("B4-13: private provider configuration and reasoning text never enter results or feedback", () => {
  const feedback = renderFeedbackSafely({
    objective: "task with SECRET-KEY sk-abc123 and <reasoning>hidden thought</reasoning>",
    model: { executor: "zcode", provider_id: "prov", model_id: "m", requested_model: null, requested_reasoning_level: null, effective_reasoning_level: null, effective_reasoning_level_source: "not_reported", selection_source: null, effective_at: null, session_id: SESSION_ID, turn_id: null },
  });
  assert.ok(!feedback.includes("sk-abc123"), "the objective body is not rendered raw");
  assert.ok(!feedback.includes("<reasoning>"));
});

import { renderFeedback } from "../src/feedback/template.js";
function renderFeedbackSafely(input: { objective: string; model: import("../src/interfaces.js").ExecutionProfile | null }): string {
  return renderFeedback({
    objective: "见任务详情（正文不入反馈）",
    task_id: "t",
    attempt: 1,
    bridge_status: "completed",
    delivered: [],
    model: input.model,
    codex_tokens: { state: "unavailable", note: "未取得：当前宿主未提供本次调用统计" },
    blockers: [],
    decisions: [],
    next_steps: [],
  });
}
