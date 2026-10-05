// B3-05 performance acceptance: status latency under slow probes/cleanup,
// bounded scans near the log capacity cap, and scale trends across active and
// historical task counts. Synthetic tasks and isolated directories only; no
// model calls. The 250ms status budget is the plan's recommended baseline —
// actual figures are logged for the delivery report.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore } from "../src/store/task-store.js";
import { BridgeTaskManager } from "../src/manager/task-manager.js";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import { makeTask } from "./helpers.js";

const T0 = Date.UTC(2026, 9, 4, 0, 0, 0);
const iso = (ms: number): string => new Date(T0 + ms).toISOString();

interface BenchProbe {
  probeCalls: number;
  handle: import("../src/runtime/process-probe.js").ProcessProbe;
}

function benchProbeRef(fx: Fixture): number {
  return (fx.probe.handle as unknown as { probeCalls: number }).probeCalls;
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
}

/** Upper bound on the bytes one getStatus pulls from disk for a task: the
 * persisted files on the status read path (the events tail counts only its
 * bounded 8 KiB window). Absent files contribute nothing. */
function statusReadBytesUpperBound(store: TaskStore, taskId: string): number {
  let total = 0;
  const add = (file: string, cap?: number): void => {
    try { total += Math.min(statSync(file).size, cap ?? Number.MAX_SAFE_INTEGER); } catch { /* absent */ }
  };
  const dir = store.taskDir(taskId);
  add(path.join(dir, "status.json"));
  add(path.join(dir, "result.json"));
  add(path.join(dir, "events.jsonl"), 8_192);
  try {
    for (const attempt of readdirSync(path.join(dir, "attempts"))) {
      const attemptDir = path.join(dir, "attempts", attempt);
      add(path.join(attemptDir, "observation.json"));
      add(path.join(attemptDir, "outcome-checkpoint.json"));
      add(path.join(attemptDir, "heartbeat.json"));
    }
  } catch { /* no attempts dir */ }
  return total;
}

interface Fixture {
  root: string;
  store: TaskStore;
  manager: BridgeTaskManager;
  probe: BenchProbe;
  activeIds: string[];
  cleanup: () => void;
}

async function makeBenchFixture(activeCount: number, historicalCount: number, options: { probeDelayMs?: number; workspaces?: string } = {}): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), `zcode-bridge-bench-${activeCount}x${historicalCount}-`));
  const store = new TaskStore(root);
  const handle = {
    platform: process.platform,
    probeCalls: 0,
    selfIdentity: async () => ({ pid: process.pid, fingerprint: "bench", fingerprint_precision: "exact" as const, identity_version: 1 as const, platform: process.platform, captured_at: iso(0) }),
    identityOf: async (pid: number) => ({ pid, fingerprint: `bench-${String(pid)}`, fingerprint_precision: "exact" as const, identity_version: 1 as const, platform: process.platform, captured_at: iso(0) }),
    probe: async (requests: readonly { pid: number; identity: unknown }[]) => {
      handle.probeCalls += requests.length;
      if (options.probeDelayMs) await new Promise((resolve) => setTimeout(resolve, options.probeDelayMs));
      return requests.map(() => ({ state: "alive" as const, reason_code: "bench_alive", observed_at: iso(0) }));
    },
  };
  const probe: BenchProbe = { probeCalls: 0, handle: handle as unknown as import("../src/runtime/process-probe.js").ProcessProbe };
  const workspaceDir = options.workspaces ?? mkdtempSync(path.join(tmpdir(), "zcode-bridge-bench-ws-"));
  const clock = { ms: 1_000 };
  const manager = new BridgeTaskManager({
    store,
    workspaceProvider: new DirectWorkspaceProvider(),
    spawnWorker: () => ({ pid: 70_000 + Math.floor(Math.random() * 10_000) }),
    isProcessRunning: () => true,
    terminateProcessTree: async (pid) => ({ pid, signal: "SIGKILL", verified: true }),
    probe: probe.handle as unknown as import("../src/runtime/process-probe.js").ProcessProbe,
    pollIntervalMs: 0,
    now: () => new Date(T0 + clock.ms),
  });
  const activeIds: string[] = [];
  for (let index = 0; index < historicalCount; index += 1) {
    const taskId = `hist_${String(index).padStart(4, "0")}`;
    store.createTask(makeTask({ task_id: taskId, workspace: workspaceDir }), iso(index * 10));
    store.writeStatus(taskId, { status: "completed", started_at: iso(index * 10), finished_at: iso(index * 10 + 5_000), worker_pid: null });
  }
  for (let index = 0; index < activeCount; index += 1) {
    // Distinct execution directories: same-directory tasks are serialized by
    // design, so a scale bench gives every active task its own path.
    const taskWorkspace = path.join(workspaceDir, `task-${String(index)}`);
    mkdirSync(taskWorkspace, { recursive: true });
    const taskId = `act_${String(index).padStart(2, "0")}`;
    await manager.createTask(makeTask({ task_id: taskId, workspace: taskWorkspace }));
    activeIds.push(taskId);
  }
  return {
    root,
    store,
    manager,
    probe,
    activeIds,
    cleanup: () => {
      manager.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("B3-05: status returns within budget while probes are slow; bounded scans respect the byte budget; scale trend recorded", { timeout: 900_000 }, async () => {
  const summary: Array<Record<string, number | string>> = [];
  const scenarios: Array<{ active: number; historical: number }> = [
    { active: 1, historical: 0 },
    { active: 8, historical: 1_000 },
    { active: 32, historical: 10_000 },
  ];
  const workspaces = mkdtempSync(path.join(tmpdir(), "zcode-bridge-bench-shared-ws-"));
  try {
    for (const scenario of scenarios) {
      const setupStarted = performance.now();
      const fx = await makeBenchFixture(scenario.active, scenario.historical, { probeDelayMs: 50, workspaces });
      const setupMs = performance.now() - setupStarted;
      try {
        // A fresh heartbeat keeps the recovery fast path warm — but only for
        // tasks that actually hold a worker: the Bridge caps concurrent
        // workers (maxConcurrentWorkers ≤ 8 by design), so in the 32-active
        // tier the remainder are legitimately queued and have no executor.
        let runningActive = 0;
        const heartbeatStarted = performance.now();
        for (const taskId of fx.activeIds) {
          const status = fx.store.readStatus(taskId);
          if (status.status !== "running" || status.worker_pid === null) continue;
          runningActive += 1;
          const pid = status.worker_pid;
          fx.store.writeAttemptMeta(taskId, 1, "execution.claim", { pid });
          fx.store.writeExecutorIdentity(taskId, 1, {
            worker: { pid, fingerprint: `bench-${String(pid)}`, fingerprint_precision: "exact", identity_version: 1, platform: process.platform, captured_at: iso(0) },
          });
          fx.store.writeWorkerHeartbeat(taskId, 1, {
            attempt: 1, worker_pid: pid, started_at: iso(0), heartbeat_at: iso(2_000), heartbeat_seq: 1,
            session_id: null, turn_id: null, last_event_seq: 1, last_event_type: "model_output", zcode_event_seq: 0,
          });
        }
        const heartbeatMs = performance.now() - heartbeatStarted;
        //getStatus: 60 samples. It must never await an OS probe.
        const before = benchProbeRef(fx);
        const samplingStarted = performance.now();
        const samples: number[] = [];
        for (let index = 0; index < 60; index += 1) {
          const started = performance.now();
          await fx.manager.getStatus(fx.activeIds[index % fx.activeIds.length]!);
          samples.push(performance.now() - started);
        }
        const samplingMs = performance.now() - samplingStarted;
        const p50 = percentile(samples, 50);
        const p95 = percentile(samples, 95);
        const p99 = percentile(samples, 99);
        const probesDuringStatus = benchProbeRef(fx) - before;
        assert.ok(p95 < 250, `status p95 ${p95.toFixed(1)}ms exceeded the 250ms budget (p50=${p50.toFixed(1)}, p99=${p99.toFixed(1)})`);
        assert.equal(probesDuringStatus, 0, "getStatus must not trigger OS probes");
        assert.ok(runningActive >= 1, "at least one active task must hold a worker");
        assert.ok(runningActive <= 8, `running workers (${String(runningActive)}) exceed the platform concurrency cap of 8`);
        const diagnostics = fx.manager.diagnostics();
        const heapAfter = process.memoryUsage();
        summary.push({
          scenario: `${scenario.active} active / ${scenario.historical} historical`,
          status_p50_ms: Number(p50.toFixed(2)), status_p95_ms: Number(p95.toFixed(2)), status_p99_ms: Number(p99.toFixed(2)),
          status_sample_count: samples.length,
          probes_during_status: probesDuringStatus,
          active_total: fx.activeIds.length,
          running_active: runningActive,
          queued_active: fx.activeIds.length - runningActive,
          lock_wait_samples: diagnostics.lock_wait.samples,
          lock_wait_p50_ms: diagnostics.lock_wait.p50_ms ?? -1,
          lock_wait_p95_ms: diagnostics.lock_wait.p95_ms ?? -1,
          lock_wait_max_ms: diagnostics.lock_wait.max_ms ?? -1,
          status_read_bytes_upper_bound: statusReadBytesUpperBound(fx.store, fx.activeIds[0]!),
          setup_ms: Number(setupMs.toFixed(0)),
          heartbeat_setup_ms: Number(heartbeatMs.toFixed(0)),
          status_sampling_ms: Number(samplingMs.toFixed(0)),
          heap_used_mb: Number((heapAfter.heapUsed / 1_048_576).toFixed(1)),
          rss_mb: Number((heapAfter.rss / 1_048_576).toFixed(1)),
        });
        // Recovery with deliberately slow probes stays bounded and completes.
        const recoveryStarted = performance.now();
        await fx.manager.recoverTasks();
        const recoveryMs = performance.now() - recoveryStarted;
        assert.ok(benchProbeRef(fx) > 0, "recovery probed the executors");
        summary.push({ scenario: `${scenario.active} active recovery`, recovery_ms: Number(recoveryMs.toFixed(1)), probe_calls: benchProbeRef(fx) });
        console.error(`B3-05 tier ${String(scenario.active)}x${String(scenario.historical)} done`);
      } finally {
        const cleanupStarted = performance.now();
        fx.cleanup();
        summary.push({ scenario: `${scenario.active} active cleanup`, cleanup_ms: Number((performance.now() - cleanupStarted).toFixed(0)) });
      }
    }

    // Near-capacity event log: bounded scan bytes ≤ budget + one block.
    const fx = await makeBenchFixture(1, 0, { workspaces });
    try {
      const taskId = fx.activeIds[0]!;
      const bigStore = new TaskStore(fx.root, { maxEventBytes: 4 * 1024 * 1024 });
      void bigStore;
      // Generate a dense valid log near the default cap (fast, direct write).
      const dir = path.join(fx.store.taskDir(taskId));
      const line = `${JSON.stringify({ seq: 1, at: iso(1), type: "model_output", summary: "x".repeat(200) })}\n`;
      const seqBase = fx.store.readEvents(taskId, 0, 1).events.at(-1)?.seq ?? 0;
      const lines: string[] = [];
      for (let index = 1; index <= 20_000; index += 1) {
        lines.push(JSON.stringify({ seq: seqBase + index, at: iso(index), type: "model_output", summary: "x".repeat(200) }));
      }
      writeFileSync(path.join(dir, "events.jsonl"), lines.map((entry) => `${entry}\n`).join(""));
      const logBytes = Number(lines.reduce((total, entry) => total + Buffer.byteLength(entry) + 1, 0));
      const budget = 512 * 1024;
      // A full-page read (limit covers the whole log) exhausts the byte
      // budget and must report the incompleteness instead of pretending.
      const scan = fx.store.readEventsBounded(taskId, { afterSeq: 0, limit: 30_000, maxBytes: budget });
      assert.ok(scan.metrics.bytes_read <= budget + 64 * 1024 + 4_096, `bounded scan read ${String(scan.metrics.bytes_read)} bytes`);
      assert.equal(scan.scan_incomplete, true, "a near-capacity log cannot be read within a small budget");
      assert.ok(scan.scan_cursor, "continuation cursor available");
      const legacyWhole = performance.now();
      fx.store.readEvents(taskId, 0, 200);
      const legacyMs = performance.now() - legacyWhole;
      const boundedStart = performance.now();
      const firstPage = fx.store.readEventsBounded(taskId, { afterSeq: 0, limit: 200, maxBytes: budget });
      const boundedMs = performance.now() - boundedStart;
      assert.equal(firstPage.events.length, 200);
      assert.equal(firstPage.hasMore, true);
      summary.push({ scenario: "near-capacity scan", log_bytes: logBytes, bounded_bytes_read: scan.metrics.bytes_read, legacy_first_page_ms: Number(legacyMs.toFixed(2)), bounded_first_page_ms: Number(boundedMs.toFixed(2)) });
    } finally { fx.cleanup(); }

    const heap = process.memoryUsage();
    summary.push({ scenario: "memory", heap_used_mb: Number((heap.heapUsed / 1_048_576).toFixed(1)), rss_mb: Number((heap.rss / 1_048_576).toFixed(1)) });
    console.log("B3-05 performance summary:", JSON.stringify(summary, null, 1));
  } finally {
    rmSync(workspaces, { recursive: true, force: true });
  }
  void mkdirSync;
});
