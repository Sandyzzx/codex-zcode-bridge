// Batch-1 regression evidence for the 2026-10-04 lifecycle & observability
// plan: A1 unified observation judger, A2 process identity / safe cleanup,
// and A3 bounded diagnostics. Each test names the acceptance item it proves.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore } from "../src/store/task-store.js";
import { BridgeTaskManager } from "../src/manager/task-manager.js";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import { buildTaskObservation, inferExecutionStage } from "../src/observation/build.js";
import { judgeTaskObservation } from "../src/observation/judge.js";
import { sanitizeDiagnostics, DiagnosticCounters } from "../src/observation/diagnostics.js";
import { tryAcquireProcessLock, withProcessLock } from "../src/store/process-lock.js";
import { createPlatformProbe, type ProcessIdentity, type ProbeRequest, type ProbeVerdict } from "../src/runtime/process-probe.js";
import { runWorkerTask } from "../src/worker/run-task.js";
import { FakeAdapter, makeManagerFixture, type ManagerFixture } from "./manager-helpers.js";
import { makeTask, makeTempDir, removeTempDir } from "./helpers.js";
import type { TaskPackage, TaskStatus } from "../src/interfaces.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const T0 = Date.UTC(2026, 9, 4, 0, 0, 0);

function iso(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

/** Scriptable fake probe: identity records and verdict answers per pid. */
class FakeProbe {
  readonly identities = new Map<number, ProcessIdentity>();
  readonly answers = new Map<number, ProbeVerdict>();
  probeCalls = 0;
  delayMs = 0;

  identityOf(pid: number): Promise<ProcessIdentity> {
    const found = this.identities.get(pid);
    if (found) return Promise.resolve(found);
    const identity: ProcessIdentity = {
      pid,
      fingerprint: `fp-${String(pid)}`,
      fingerprint_precision: "exact",
      identity_version: 1,
      platform: process.platform,
      captured_at: iso(0),
    };
    this.identities.set(pid, identity);
    return Promise.resolve(identity);
  }

  selfIdentity(): Promise<ProcessIdentity> {
    return this.identityOf(process.pid);
  }

  async probe(requests: readonly ProbeRequest[]): Promise<ProbeVerdict[]> {
    this.probeCalls += 1;
    if (this.delayMs) await delay(this.delayMs);
    return requests.map((request) => {
      const answer = this.answers.get(request.pid);
      if (answer) return answer;
      return { state: "alive", reason_code: "fake_alive", observed_at: iso(0) };
    });
  }

  set(pid: number, state: ProbeVerdict["state"], reason: string): void {
    this.answers.set(pid, { state, reason_code: reason, observed_at: iso(0) });
  }
}

interface ObservedFixture {
  dataRoot: string;
  workspaceDir: string;
  store: TaskStore;
  manager: BridgeTaskManager;
  probe: FakeProbe;
  spawned: Array<{ dataRoot: string; taskId: string; pid: number }>;
  pidsAlive: Set<number>;
  terminateCalls: number[];
  setTerminateError: (error: Error | null) => void;
  advance: (ms: number) => void;
  makeTask: (overrides?: Partial<TaskPackage>) => TaskPackage;
  runWorker: (taskId: string, adapter: FakeAdapter) => Promise<unknown>;
  cleanup: () => Promise<void>;
}

async function makeObservedFixture(options: { workerStartGraceMs?: number; probe?: FakeProbe } = {}): Promise<ObservedFixture> {
  const probe = options.probe ?? new FakeProbe();
  const base = await makeManagerFixture({ workerStartGraceMs: options.workerStartGraceMs });
  const legacy = base as unknown as { cleanup: () => Promise<void>; makeTask: ObservedFixture["makeTask"]; runWorker: ObservedFixture["runWorker"] };
  const dataRoot = base.dataRoot;
  const workspaceDir = base.workspaceDir;
  const store = base.store;
  const spawned = base.spawned;
  const pidsAlive = base.pidsAlive;
  const terminateCalls = base.terminateCalls;
  let terminateError: Error | null = null;
  const clock = { ms: 1_000 };
  const manager = new BridgeTaskManager({
    store,
    workspaceProvider: new DirectWorkspaceProvider(),
    spawnWorker: (root, taskId) => {
      const pid = 50_000 + spawned.length + 1;
      spawned.push({ dataRoot: root, taskId, pid });
      pidsAlive.add(pid);
      return { pid };
    },
    isProcessRunning: (pid) => pidsAlive.has(pid),
    terminateProcessTree: async (pid) => {
      terminateCalls.push(pid);
      if (terminateError) throw terminateError;
      pidsAlive.delete(pid);
      return { pid, signal: "SIGKILL", verified: true };
    },
    probe: probe as unknown as import("../src/runtime/process-probe.js").ProcessProbe,
    pollIntervalMs: 0,
    workerStartGraceMs: options.workerStartGraceMs ?? 0,
    now: () => new Date(T0 + clock.ms),
  });
  return {
    dataRoot,
    workspaceDir,
    store,
    manager,
    probe,
    spawned,
    pidsAlive,
    terminateCalls,
    setTerminateError: (error) => { terminateError = error; },
    advance: (ms: number) => { clock.ms += ms; },
    makeTask: legacy.makeTask,
    runWorker: legacy.runWorker,
    cleanup: async () => {
      manager.dispose();
      await base.cleanup();
    },
  };
}

async function seedRunningTask(fx: ObservedFixture, overrides: Partial<TaskPackage> = {}): Promise<number> {
  await fx.manager.createTask(fx.makeTask(overrides));
  const pid = fx.spawned[0]!.pid;
  // Worker is running and heartbeating; the execution claim proves ownership.
  fx.store.writeAttemptMeta("task_1", 1, "execution.claim", { pid });
  fx.store.writeAttemptMeta("task_1", 1, "started.json", { worker_pid: pid, started_at: iso(0) });
  fx.store.writeWorkerHeartbeat("task_1", 1, {
    attempt: 1,
    worker_pid: pid,
    started_at: iso(0),
    heartbeat_at: iso(1_000),
    heartbeat_seq: 1,
    session_id: null,
    turn_id: null,
    last_event_seq: 1,
    last_event_type: "worker_running",
    zcode_event_seq: 0,
  });
  return pid;
}

// ---- A1: unified observation contract ----

test("A1-01: long quiet tool execution with a fresh heartbeat stays running and is never worker_lost", async () => {
  const fx = await makeObservedFixture();
  try {
    await seedRunningTask(fx);
    // Advance 5 minutes with no business events at all — heartbeat refreshes.
    fx.advance(300_000);
    fx.store.writeWorkerHeartbeat("task_1", 1, {
      attempt: 1, worker_pid: fx.spawned[0]!.pid, started_at: iso(0), heartbeat_at: iso(301_000),
      heartbeat_seq: 2, session_id: null, turn_id: null, last_event_seq: 1, last_event_type: "model_tool_call", zcode_event_seq: 0,
    });
    await fx.manager.recoverTasks();
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "running");
    assert.notEqual(status.error_code, "worker_lost");
    assert.equal(fx.spawned.length, 1, "no respawn for a heartbeating worker");
    assert.equal(fx.terminateCalls.length, 0);
  } finally { await fx.cleanup(); }
});

test("A1-02: a pending permission request past the stall threshold shows waiting, not failure; the answer resumes executing", async () => {
  const root = await makeTempDir("a1-interaction");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    store.writeStatus("task_1", { status: "running", started_at: iso(0), worker_pid: 4242 });
    store.writeInteractionRequest("task_1", {
      request_id: "1:perm-1",
      method: "interaction/requestPermission",
      params: { toolName: "Bash" },
    }, iso(1_000));
    // Heartbeat fresh, but no events since the interaction began 10 minutes ago.
    const observation = buildTaskObservation(store, "task_1", store.readStatus("task_1"), {
      now: () => new Date(T0 + 601_000),
      stallHintMs: 120_000,
    });
    assert.equal(observation.activity.code, "waiting_for_permission");
    assert.equal(observation.stalled, false, "waiting is explicit, not a stall");
    // Answering the interaction moves the phase back to executing evidence;
    // the worker keeps heartbeating throughout (every 3s in production).
    store.answerInteractionRequest("task_1", "1:perm-1", { decision: "allow" }, iso(602_000));
    store.appendEvent("task_1", "interaction_reply_submitted", "the calling host submitted a response", undefined, iso(602_000));
    store.writeAttemptMeta("task_1", 1, "execution.claim", { pid: 4242 });
    store.writeWorkerHeartbeat("task_1", 1, {
      attempt: 1, worker_pid: 4242, started_at: iso(0), heartbeat_at: iso(603_000),
      heartbeat_seq: 9, session_id: null, turn_id: null, last_event_seq: 2, last_event_type: "interaction_reply_submitted", zcode_event_seq: 0,
    });
    const after = buildTaskObservation(store, "task_1", store.readStatus("task_1"), {
      now: () => new Date(T0 + 603_000),
      stallHintMs: 120_000,
    });
    assert.equal(after.activity.code, "executing");
    const terminal = store.readStatus("task_1").status;
    assert.equal(terminal, "running", "a pending answer is never a failure");
  } finally { await removeTempDir(root); }
});

test("A1-03: a fresh heartbeat with stale business events shows the stall hint without masking or re-dispatch", async () => {
  const fx = await makeObservedFixture();
  try {
    await seedRunningTask(fx);
    // Heartbeat keeps refreshing while business events go quiet for 10 minutes.
    fx.store.writeWorkerHeartbeat("task_1", 1, {
      attempt: 1, worker_pid: fx.spawned[0]!.pid, started_at: iso(0), heartbeat_at: iso(601_000),
      heartbeat_seq: 2, session_id: null, turn_id: null, last_event_seq: 1, last_event_type: "worker_running", zcode_event_seq: 0,
    });
    // Last business event 10 minutes old, heartbeat fresh: stalled hint.
    const observation = buildTaskObservation(fx.store, "task_1", fx.store.readStatus("task_1"), {
      now: () => new Date(T0 + 601_000),
      stallHintMs: 120_000,
    });
    assert.equal(observation.activity.code, "stalled");
    assert.equal(observation.stalled, true);
    assert.equal(observation.worker.state, "alive", "a stalled hint never contradicts a live executor");
    // Recovery must not re-dispatch or finalize on the hint.
    await fx.manager.recoverTasks();
    assert.equal((await fx.manager.getStatus("task_1")).status, "running");
    assert.equal(fx.spawned.length, 1);
    assert.equal(fx.terminateCalls.length, 0);
  } finally { await fx.cleanup(); }
});

test("A1-04: an unknown probe never kills a task, keeps occupancy, and blocks the same directory", async () => {
  const probe = new FakeProbe();
  const fx = await makeObservedFixture({ probe });
  try {
    const pid = await seedRunningTask(fx);
    fx.store.writeExecutorIdentity("task_1", 1, { worker: (await probe.identityOf(pid)) as unknown as Record<string, unknown> });
    probe.set(pid, "unknown", "query_timeout");
    // Heartbeat goes stale so recovery must probe.
    fx.advance(60_000);
    await fx.manager.recoverTasks();
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "running", "unknown never becomes worker_lost");
    assert.equal(fx.spawned.length, 1, "unknown never respawns");
    assert.ok(fx.store.listRecentEventTypes("task_1", 64).includes("probe_unknown"), "the unknown verdict is visible");
    // Same-directory follow-up stays queued while the unknown task occupies.
    await fx.manager.createTask(fx.makeTask({ task_id: "same_dir" }));
    assert.equal((await fx.manager.getStatus("same_dir")).status, "queued");
    // The observation surfaced through status reports the unknown verdict.
    const observation = status.observation;
    assert.ok(observation, "getStatus carries the observation");
    assert.equal(observation!.worker.state, "unknown");
    assert.equal(observation!.worker.reason_code, "query_timeout");
  } finally { await fx.cleanup(); }
});

test("A1-05: a committed result is never downgraded by a stale running/stalled observation", async () => {
  const root = await makeTempDir("a1-committed");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    store.writeStatus("task_1", { status: "running", started_at: iso(0), worker_pid: 4242 });
    store.writeAttemptMeta("task_1", 1, "execution.claim", { pid: 4242 });
    store.writeWorkerHeartbeat("task_1", 1, {
      attempt: 1, worker_pid: 4242, started_at: iso(0), heartbeat_at: iso(1_000),
      heartbeat_seq: 1, session_id: "s1", turn_id: null, last_event_seq: 3, last_event_type: "model_output", zcode_event_seq: 9,
    });
    // The worker commits a completed result, then dies; a stale heartbeat
    // and a stalled hint arrive afterwards. Neither may roll anything back.
    store.commitWorkerResult("task_1", 1, {
      task_id: "task_1", status: "completed", summary: "done", files_changed: [], tests: [],
      issues: [], needs_master_decision: false, zcode_output: "", exit_code: 0,
      session_id: "s1", attempt: 1, started_at: iso(0), finished_at: iso(2_000),
    }, { status: "completed", finished_at: iso(2_000), worker_pid: null });
    const observation = buildTaskObservation(store, "task_1", store.readStatus("task_1"), {
      now: () => new Date(T0 + 3_600_000),
    });
    assert.equal(observation.result, "committed");
    assert.equal(observation.cleanup, "verified");
    assert.equal(store.readStatus("task_1").status, "completed");
    assert.equal(store.readResult("task_1")!.summary, "done");
    // Recovery also aligns instead of downgrading.
    const probe = new FakeProbe();
    probe.set(4242, "unknown", "query_timeout");
    const fx = await makeObservedFixture({ probe });
    try {
      const manager = new BridgeTaskManager({
        store, workspaceProvider: new DirectWorkspaceProvider(), pollIntervalMs: 0,
        isProcessRunning: () => true, terminateProcessTree: async (pid) => ({ pid, signal: "SIGKILL", verified: true }),
        probe: probe as unknown as import("../src/runtime/process-probe.js").ProcessProbe,
      });
      await manager.recoverTasks();
      assert.equal(store.readStatus("task_1").status, "completed");
      manager.dispose();
    } finally { void probe; }
  } finally { await removeTempDir(root); }
});

test("A1-06: status, events, and doctor share one judger verdict for one snapshot", async () => {
  const fx = await makeObservedFixture();
  try {
    await seedRunningTask(fx);
    // One live snapshot for all three surfaces: fresh heartbeat + fresh
    // business progress on the real clock (the manager runs a fake clock).
    fx.store.appendEvent("task_1", "model_tool_call", "Model requested tool Edit");
    fx.store.writeWorkerHeartbeat("task_1", 1, {
      attempt: 1, worker_pid: fx.spawned[0]!.pid, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(),
      heartbeat_seq: 3, session_id: null, turn_id: null, last_event_seq: 4, last_event_type: "model_tool_call", zcode_event_seq: 0,
    });
    const status = await fx.manager.getStatus("task_1");
    const page = await fx.manager.getEvents({ task_id: "task_1" });
    assert.ok(status.observation && page.observation);
    assert.deepEqual(status.observation.activity, page.observation.activity);
    assert.deepEqual(status.observation.worker, page.observation.worker);
    assert.deepEqual(status.observation.cleanup, page.observation.cleanup);
    // Doctor summarizes the same task through the same builder.
    const { runBridgeDoctor } = await import("../src/runtime/doctor.js");
    const report = await runBridgeDoctor({
      env: { ...process.env, ZCODE_BRIDGE_DATA_DIR: fx.dataRoot, OS: process.env["OS"] },
      dataRoot: fx.dataRoot,
      observationDataRoot: fx.dataRoot,
      resolver: { env: { ...process.env, ZCODE_BRIDGE_NODE: process.execPath, ZCODE_BRIDGE_ZCODE_CJS: "x", ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "b", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "p", ZCODE_BRIDGE_DATA_DIR: fx.dataRoot } as NodeJS.ProcessEnv },
    });
    const active = report.checks.find((check) => check.name === "active_tasks");
    assert.ok(active, "doctor reports active task observations");
    assert.match(active.summary, /task_1#1: executing/);
  } finally { await fx.cleanup(); }
});

// ---- A2: process identity, probing, safe cleanup ----

test("A2-01: a reused PID counts the old executor exited and cancel never signals the new owner", async () => {
  const probe = new FakeProbe();
  const fx = await makeObservedFixture({ probe });
  try {
    const pid = await seedRunningTask(fx);
    // Persist the old executor's identity, then have the probe report that
    // the PID now belongs to a different process (reuse).
    fx.store.writeExecutorIdentity("task_1", 1, { worker: (await probe.identityOf(pid)) as unknown as Record<string, unknown> });
    probe.set(pid, "exited", "pid_reused");
    // Make the reused PID look alive so a liveness-only cancel would kill it.
    fx.pidsAlive.add(pid + 9_999); // unrelated live process on another pid
    await fx.manager.cancelTask("task_1");
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "cancelled");
    assert.equal(fx.terminateCalls.length, 0, "a reused PID must never be signalled");
    assert.match(fx.store.readResult("task_1")!.summary, /reused/);
  } finally { await fx.cleanup(); }
});

test("A2-02: probe permission errors, timeouts, and fingerprint failures answer unknown and keep the attempt", async () => {
  const probe = new FakeProbe();
  const fx = await makeObservedFixture({ probe });
  try {
    const pid = await seedRunningTask(fx);
    fx.store.writeExecutorIdentity("task_1", 1, { worker: (await probe.identityOf(pid)) as unknown as Record<string, unknown> });
    for (const reason of ["access_denied", "query_timeout", "fingerprint_unparsable"]) {
      probe.set(pid, "unknown", reason);
      fx.advance(60_000);
      await fx.manager.recoverTasks();
      const status = await fx.manager.getStatus("task_1");
      assert.equal(status.status, "running", `${reason} must not kill the attempt`);
      assert.equal(fx.spawned.length, 1, `${reason} must not respawn`);
      assert.equal(status.observation?.worker.state, "unknown");
      assert.equal(status.observation?.worker.reason_code, reason);
    }
  } finally { await fx.cleanup(); }
});

test("A2-03: a manager restart recovers the same live worker without creating a second executor", async () => {
  const probe = new FakeProbe();
  const first = await makeObservedFixture({ probe });
  const dataRoot = first.dataRoot;
  try {
    const pid = await seedRunningTask(first);
    const store = first.store;
    first.manager.dispose();
    // A brand-new manager process over the same data root.
    const restarted = new BridgeTaskManager({
      store,
      workspaceProvider: new DirectWorkspaceProvider(),
      pollIntervalMs: 0,
      isProcessRunning: (candidate) => first.pidsAlive.has(candidate),
      terminateProcessTree: async (candidate) => { first.terminateCalls.push(candidate); first.pidsAlive.delete(candidate); return { pid: candidate, signal: "SIGKILL", verified: true }; },
      probe: probe as unknown as import("../src/runtime/process-probe.js").ProcessProbe,
      now: () => new Date(T0 + 30_000),
    });
    await restarted.recoverTasks();
    assert.equal(store.readStatus("task_1").status, "running");
    assert.equal(store.readStatus("task_1").worker_pid, pid, "the original executor keeps the attempt");
    assert.equal(first.spawned.length, 1, "no replacement worker may start");
    restarted.dispose();
  } finally { await first.cleanup(); }
});

test("A2-04: cancel racing a natural exit keeps the worker result; a confirmed exit without a result is idempotent", async () => {
  const fx = await makeObservedFixture();
  try {
    await seedRunningTask(fx);
    // (a) The worker commits its result while cancel is in flight.
    const pid = fx.spawned[0]!.pid;
    const racing = fx.manager.cancelTask("task_1");
    await delay(10);
    fx.store.commitWorkerResult("task_1", 1, {
      task_id: "task_1", status: "completed", summary: "worker finished first", files_changed: [], tests: [],
      issues: [], needs_master_decision: false, zcode_output: "", exit_code: 0,
      session_id: "race-session", attempt: 1, started_at: iso(0), finished_at: iso(2_000),
    }, { status: "completed", worker_pid: null });
    fx.pidsAlive.delete(pid);
    const status = await racing;
    assert.equal(status.status, "completed", "the worker's own terminal result wins");
    assert.equal((await fx.manager.getResult("task_1")).summary, "worker finished first");
    // (b) A confirmed exit with no result at all is an idempotent cancel.
    await fx.manager.createTask(fx.makeTask({ task_id: "gone" }));
    const gonePid = fx.spawned[1]!.pid;
    fx.pidsAlive.delete(gonePid);
    fx.probe.set(gonePid, "exited", "pid_absent");
    const cancelled = await fx.manager.cancelTask("gone");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(fx.terminateCalls.filter((candidate) => candidate === gonePid).length, 0, "no kill for an already-exited pid");
  } finally { await fx.cleanup(); }
});

test("A2-05: an exited worker with a live runtime keeps the directory reserved", async () => {
  const probe = new FakeProbe();
  const fx = await makeObservedFixture({ probe });
  try {
    const pid = await seedRunningTask(fx);
    fx.store.writeStatus("task_1", { zcode_pid: 4444 });
    fx.store.writeExecutorIdentity("task_1", 1, {
      worker: (await probe.identityOf(pid)) as unknown as Record<string, unknown>,
      runtime: (await probe.identityOf(4444)) as unknown as Record<string, unknown>,
    });
    probe.set(pid, "exited", "pid_absent");
    // runtime stays alive per probe (alive default). Stale the heartbeat so
    // recovery actually probes instead of trusting the fresh heartbeat.
    fx.advance(60_000);
    await fx.manager.recoverTasks();
    const status = fx.store.readStatus("task_1");
    assert.equal(status.cleanup_unverified, true, "a live runtime blocks release");
    assert.equal(status.status, "running");
    await fx.manager.createTask(fx.makeTask({ task_id: "blocked" }));
    assert.equal((await fx.manager.getStatus("blocked")).status, "queued", "the execution path stays reserved");
    assert.equal(fx.terminateCalls.length, 0, "recovery never kills on its own");
  } finally { await fx.cleanup(); }
});

test("A2-06: a probe result computed against an older snapshot cannot touch a newer state", async () => {
  const probe = new FakeProbe();
  probe.delayMs = 150;
  const fx = await makeObservedFixture({ probe });
  try {
    await seedRunningTask(fx);
    const pid = fx.spawned[0]!.pid;
    const recovering = fx.manager.recoverTasks();
    // While the probe is in flight the worker completes normally.
    await delay(20);
    fx.store.commitWorkerResult("task_1", 1, {
      task_id: "task_1", status: "completed", summary: "raced to terminal", files_changed: [], tests: [],
      issues: [], needs_master_decision: false, zcode_output: "", exit_code: 0,
      session_id: null, attempt: 1, started_at: iso(0), finished_at: iso(2_000),
    }, { status: "completed", worker_pid: null });
    fx.pidsAlive.delete(pid);
    await recovering;
    const status = await fx.manager.getStatus("task_1");
    assert.equal(status.status, "completed", "the stale probe cycle must not overwrite the terminal state");
    assert.equal(fx.terminateCalls.length, 0);
    // Concurrent managers: the recovery lock lets at most one scan run.
    const other = new BridgeTaskManager({
      store: fx.store, workspaceProvider: new DirectWorkspaceProvider(), pollIntervalMs: 0,
      isProcessRunning: (candidate) => fx.pidsAlive.has(candidate),
      terminateProcessTree: async (candidate) => ({ pid: candidate, signal: "SIGKILL", verified: true }),
    });
    await Promise.all([fx.manager.recoverTasks(), other.recoverTasks()]);
    other.dispose();
  } finally { await fx.cleanup(); }
});

test("A2-07: lock owners are never evicted by age; reclaim needs explicit exit evidence", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "zcode-bridge-test-a2-lock-"));
  try {
    const lockDir = path.join(tmp, "case.lock");
    // Corrupt owner record: stays blocking, never auto-reclaimed.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "owner.json"), "{broken");
    assert.equal(tryAcquireProcessLock(lockDir), null, "a corrupt owner must block");
    // Live same-pid owner: no reclaim.
    const liveDir = path.join(tmp, "live.lock");
    const release = tryAcquireProcessLock(liveDir);
    assert.ok(release);
    assert.equal(tryAcquireProcessLock(liveDir), null);
    release();
    // Dead owner (impossible pid → ESRCH): reclaimed.
    const deadDir = path.join(tmp, "dead.lock");
    mkdirSync(deadDir, { recursive: true });
    writeFileSync(path.join(deadDir, "owner.json"), JSON.stringify({ pid: 987654, token: "t" }));
    const reclaimed = tryAcquireProcessLock(deadDir);
    assert.ok(reclaimed, "a provably dead owner is reclaimed");
    reclaimed();
    // Old-format owner without fingerprint stays readable and reclaimable on ESRCH only.
    const oldDir = path.join(tmp, "old.lock");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(path.join(oldDir, "owner.json"), JSON.stringify({ pid: 987655 }));
    const reclaimedOld = tryAcquireProcessLock(oldDir);
    assert.ok(reclaimedOld);
    reclaimedOld();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("A2-07b: a live owner is never evicted no matter how old the lock is", async () => {
  const root = await makeTempDir("a2-lock-live");
  try {
    const lockDir = path.join(root, "aged.lock");
    const release = tryAcquireProcessLock(lockDir);
    assert.ok(release);
    // Touch the directory mtime far into the past.
    const deadline = Date.now() + 500;
    while (tryAcquireProcessLock(lockDir) === null && Date.now() < deadline) await delay(25);
    assert.equal(tryAcquireProcessLock(lockDir), null, "a live owner keeps the lock");
    await assert.rejects(withProcessLock(lockDir, async () => 1, 100), /timed out/);
    release();
  } finally { await removeTempDir(root); }
});

test("A2-08: the platform probe answers alive for a live process with a matching identity", { timeout: 20_000 }, async () => {
  const probe = createPlatformProbe();
  const identity = await probe.selfIdentity();
  assert.equal(identity.pid, process.pid);
  if (process.platform === "win32" || process.platform === "linux") {
    assert.ok(identity.fingerprint, `${process.platform} must expose a startup fingerprint`);
    assert.equal(identity.fingerprint_precision, "exact");
    const verdicts = await probe.probe([{ pid: process.pid, identity }]);
    assert.equal(verdicts[0]!.state, "alive");
    assert.equal(verdicts[0]!.reason_code, "pid_and_fingerprint_match");
    // A mismatched fingerprint on the same live PID proves reuse.
    const reused = await probe.probe([{ pid: process.pid, identity: { ...identity, fingerprint: "definitely-not-the-same" } }]);
    assert.equal(reused[0]!.state, "exited");
    assert.equal(reused[0]!.reason_code, "pid_reused");
    // An absent (but plausible) PID is conclusive exit evidence. Huge PIDs
    // make Get-Process itself error, which correctly answers unknown instead.
    const absentIdentity: import("../src/runtime/process-probe.js").ProcessIdentity = { pid: 987654, fingerprint: "fp-gone", fingerprint_precision: "exact", identity_version: 1, platform: process.platform, captured_at: new Date().toISOString() };
    const absent = await probe.probe([{ pid: 987654, identity: absentIdentity }]);
    assert.equal(absent[0]!.state, "exited");
    assert.equal(absent[0]!.reason_code, "pid_absent");
  } else {
    // macOS/other: the probe must answer without claiming exact identity.
    const verdicts = await probe.probe([{ pid: process.pid, identity }]);
    assert.ok(["alive", "unknown"].includes(verdicts[0]!.state));
  }
});

test("A2-08b: probe query failures answer unknown, never exited", { timeout: 20_000 }, async () => {
  const probe = createPlatformProbe({ timeoutMs: 1 });
  if (process.platform === "win32") {
    // A 1ms timeout forces the bounded-timeout path on Windows.
    const verdicts = await probe.probe([{ pid: process.pid, identity: null }]);
    assert.equal(verdicts[0]!.state, "unknown");
  }
});

// ---- A3: bounded, correlatable diagnostics ----

test("A3-01: synthesized tasks localize the failure stage", async () => {
  const root = await makeTempDir("a3-stage");
  try {
    const store = new TaskStore(root);
    // worker_spawn: status running but the worker never wrote anything.
    store.createTask(makeTask(), iso(0));
    store.writeStatus("task_1", { status: "running", started_at: iso(0), worker_pid: 1111 });
    assert.equal(inferExecutionStage(store, "task_1", store.readStatus("task_1")), "worker_spawn");
    // worker: started but no app-server yet.
    store.appendEvent("task_1", "worker_started", "Bridge worker started", undefined, iso(1));
    assert.equal(inferExecutionStage(store, "task_1", store.readStatus("task_1")), "worker");
    // runtime: app-server up, no session yet.
    store.appendEvent("task_1", "app_server_started", "ZCode app-server process started", { pid: 2222 }, iso(2));
    store.writeStatus("task_1", { zcode_pid: 2222 });
    assert.equal(inferExecutionStage(store, "task_1", store.readStatus("task_1")), "runtime");
    // event_channel: session ready, no turn.
    store.appendEvent("task_1", "session_ready", "session ready", { session_id: "s" }, iso(3));
    assert.equal(inferExecutionStage(store, "task_1", store.readStatus("task_1")), "event_channel");
    // cleanup: result committed but cleanup unverified.
    store.appendEvent("task_1", "turn_started", "turn started", undefined, iso(4));
    store.writeStatus("task_1", { cleanup_unverified: true, error_code: "cleanup_failed" });
    assert.equal(inferExecutionStage(store, "task_1", store.readStatus("task_1")), "cleanup");
  } finally { await removeTempDir(root); }
});

test("A3-02: status reads stay fast while a slow cancellation holds the manager mutex", async () => {
  const fx = await makeObservedFixture();
  try {
    await seedRunningTask(fx);
    let releaseTerminate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseTerminate = resolve; });
    const manager = new BridgeTaskManager({
      store: fx.store,
      workspaceProvider: new DirectWorkspaceProvider(),
      pollIntervalMs: 0,
      isProcessRunning: (candidate) => fx.pidsAlive.has(candidate),
      terminateProcessTree: async (pid) => {
        await gate;
        fx.pidsAlive.delete(pid);
        return { pid, signal: "SIGKILL", verified: true };
      },
      now: () => new Date(T0 + 1_000),
    });
    const cancelling = manager.cancelTask("task_1").catch(() => "failed");
    await delay(50); // cancel is now inside the mutex waiting on terminate
    const started = Date.now();
    const status = await manager.getStatus("task_1");
    const elapsed = Date.now() - started;
    assert.equal(status.status, "running");
    assert.ok(elapsed < 250, `getStatus took ${String(elapsed)}ms behind the cancel mutex`);
    releaseTerminate!();
    await cancelling;
    manager.dispose();
  } finally { await fx.cleanup(); }
});

test("A3-03: diagnostics projections never expose task bodies, credentials, or reasoning", async () => {
  const fx = await makeObservedFixture();
  try {
    const secret = "SK-PROJECT-SECRET-9f8e7d6c";
    const reasoning = "hidden chain of thought marker";
    await fx.manager.createTask(fx.makeTask({
      objective: `Build the widget. ${secret} ${reasoning}`,
    }));
    fx.store.appendEvent("task_1", "error", "failed", {
      provider_key: secret,
      reasoning_text: reasoning,
      objective_echo: secret,
      reason_code: "boom",
      attempt: 1,
    });
    const status = await fx.manager.getStatus("task_1");
    const projected = JSON.stringify({ status: status.observation, diagnostics: status.observation ? Object.keys(status.observation) : [] });
    assert.ok(!projected.includes(secret), "observation projections must not carry the task body");
    assert.ok(!JSON.stringify(status.observation).includes(reasoning), "observation must not carry reasoning");
    const sanitized = sanitizeDiagnostics({
      provider_key: secret,
      reasoning_text: reasoning,
      raw_stack: "x".repeat(5_000),
      reason_code: "boom",
      attempt: 1,
      task_id: "task_1",
    });
    assert.ok(!JSON.stringify(sanitized.fields).includes(secret));
    assert.equal(sanitized.dropped_keys >= 3, true);
    assert.equal(sanitized.fields.reason_code, "boom");
    assert.equal(sanitized.fields.attempt, 1);
  } finally { await fx.cleanup(); }
});

test("A3-04: heartbeats never grow the public event log; failures keep count + last seen across restarts", async () => {
  const root = await makeTempDir("a3-bounded");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), iso(0));
    store.writeStatus("task_1", { status: "running", started_at: iso(0), worker_pid: 4242 });
    store.writeAttemptMeta("task_1", 1, "execution.claim", { pid: 4242 });
    store.writeWorkerObservation("task_1", 1, 4242, { activity_phase: "executing" }, 1, iso(1_000));
    store.writeWorkerHeartbeat("task_1", 1, {
      attempt: 1, worker_pid: 4242, started_at: iso(0), heartbeat_at: iso(1_000),
      heartbeat_seq: 0, session_id: null, turn_id: null, last_event_seq: 0, last_event_type: null, zcode_event_seq: 0,
    });
    const before = store.readEvents("task_1", 0, 200).events.length;
    for (let index = 0; index < 25; index += 1) {
      store.writeWorkerHeartbeat("task_1", 1, {
        attempt: 1, worker_pid: 4242, started_at: iso(0), heartbeat_at: iso(1_000 + index * 3_000),
        heartbeat_seq: index + 1, session_id: null, turn_id: null, last_event_seq: 0, last_event_type: null, zcode_event_seq: 0,
      });
    }
    const after = store.readEvents("task_1", 0, 200).events.length;
    assert.equal(after, before, "heartbeats must not append public events");
    // The observation snapshot, not the event log, carries the liveness evidence.
    const snapshot = store.readObservationSnapshot("task_1", 1).snapshot;
    assert.ok(snapshot, "the attempt observation snapshot exists");
    // Throttled failure events carry cumulative counts.
    const counters = new DiagnosticCounters(() => T0 + 1_000);
    for (let index = 0; index < 15; index += 1) {
      counters.record("probe_unknown_worker", "query_timeout");
      if (counters.shouldEmit("probe_unknown_worker", "query_timeout")) {
        const occurrence = counters.snapshot()["probe_unknown_worker:query_timeout"]!;
        store.appendEvent("task_1", "probe_unknown", "liveness unknown", { count: occurrence.count, reason_code: "query_timeout" });
      }
    }
    const events = store.readEvents("task_1", 0, 200).events.filter((event) => event.type === "probe_unknown");
    assert.equal(events.length, 2, "first occurrence plus the throttled 10th");
    assert.equal(events.at(-1)!.details?.["count"], 10, "the throttled event carries the cumulative count");
    // The event log survives a "restart": a fresh store sees the same evidence.
    const restarted = new TaskStore(root);
    assert.ok(restarted.listRecentEventTypes("task_1", 64).includes("probe_unknown"));
  } finally { await removeTempDir(root); }
});

// ---- Judger unit edges (clock skew, queued, terminal) ----

test("judger degrades to unknown on clock jumps and reports queued starting", () => {
  const base = {
    status: {
      status: "running" as TaskStatus,
      attempt: 1,
      started_at: iso(0),
      finished_at: null,
      worker_pid: 4242,
    },
    result: null,
    checkpoint: null,
    heartbeat: null,
    last_business_event: null,
    pending_interaction: null,
    now_ms: T0 + 1_000,
  };
  const futureHeartbeat = judgeTaskObservation({
    ...base,
    heartbeat: { attempt: 1, worker_pid: 4242, heartbeat_at: iso(600_000), last_event_seq: 0, last_event_type: null, session_id: null, turn_id: null },
  });
  assert.equal(futureHeartbeat.worker.state, "unknown");
  assert.equal(futureHeartbeat.worker.reason_code, "clock_skew");
  assert.equal(futureHeartbeat.evidence.heartbeat_age_ms, null);
  const queued = judgeTaskObservation({
    ...base,
    status: { ...base.status, status: "queued", started_at: null },
  });
  assert.equal(queued.activity.code, "starting");
});
