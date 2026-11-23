// P1 §3.2 Executor Lease Spawn Fence fault injection (2026-11-24).
//
// Contract under test: while Executor lease ownership is unknown, the Manager
// may not start any new Worker Spawn through any path — the dispatch pump, the
// capacity/workspace retry timers, or post-recovery redispatch. Already
// dispatched Workers keep settling under their own lifecycle rules (Result
// delivery, recovery classification, Release notification), queued Attempts
// stay durable, and clearing the fence lets the ordinary queue machinery run.
import assert from "node:assert/strict";
import test from "node:test";
import { SqliteLifecycleMcpAuthority } from "../src/manager/sqlite-lifecycle-mcp-authority.js";
import type { ClaimOnlyRunResult } from "../src/store/lifecycle-gate.js";
import type { TaskPackage } from "../src/interfaces.js";

type Detail = Record<string, unknown>;

function task(taskId: string, executionPath: string): TaskPackage {
  return {
    task_id: taskId,
    workspace: executionPath,
    objective: "verify lease spawn fence",
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
  };
}

function releasedRun(taskId: string): ClaimOnlyRunResult {
  return {
    state: "result_committed",
    operation: { phase: "released" },
    task: {},
    attempt: { attempt: 1 },
    workerExitCode: 0,
    spawnCount: 1,
    cleanupState: "released",
    stopBoundary: "result",
  } as unknown as ClaimOnlyRunResult;
}

function recoverySnapshot(operations: Detail[]): Detail {
  return {
    root_status: "consistent_read_only",
    writes_allowed: false,
    cleanup_performed: false,
    claim_release_performed: false,
    operation_release_performed: false,
    operations,
    capacity: { policy_version: 1, policy_generation: 1, capacity_limit: 8 },
  };
}

function lifecycleSnapshot(taskId: string, executionPath: string, status = "queued", operation: Detail | null = null, result: Detail | null = null): Detail {
  return {
    task: task(taskId, executionPath),
    projection: { task_id: taskId, status, current_attempt: 1, created_at: "2026-11-24T00:00:00.000Z" },
    attempt: { attempt: 1 },
    operation,
    result,
    continuation: null,
  };
}

function releasedOperationSnapshot(): Detail {
  return {
    operation_id: "fenced-operation",
    phase: "released",
    result_digest: "a".repeat(64),
    result_commit_ref: "result-" + "a".repeat(64),
    task_id: "fenced",
    attempt: 1,
    generation: 1,
  };
}

function completedResultSnapshot(): Detail {
  return {
    task_id: "fenced",
    attempt: 1,
    status: "completed",
    summary: "fenced run completed",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: false,
    zcode_output: "",
    exit_code: 0,
    session_id: null,
    started_at: null,
    finished_at: "2026-11-24T00:00:01.000Z",
  };
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_not_reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

interface FenceDriver extends Detail {
  runCalls: string[];
  stages: Array<{ stage: string; detail?: Detail }>;
}

function makeFenceDriver(snapshot: Detail): FenceDriver {
  const stages: Array<{ stage: string; detail?: Detail }> = [];
  const runCalls: string[] = [];
  const driver: FenceDriver = {
    readRecoverySnapshot() {
      return recoverySnapshot(Array.isArray(snapshot.operations) ? snapshot.operations as Detail[] : []);
    },
    readRecoverableQueuedAttempts() {
      return snapshot.queued ?? [];
    },
    async recoverOperation(operationId: string) {
      return { state: "released", operation_id: operationId };
    },
    readTaskLifecycle(taskId: string) {
      return (snapshot.tasks as Detail)[String(taskId)];
    },
    readCommittedResult() {
      return null;
    },
    readTaskEvents() {
      return { events: [], nextCursor: 0, hasMore: false };
    },
    close() {},
    async run(input: { task: TaskPackage }) {
      runCalls.push(input.task.task_id);
      if (snapshot.capacityExhaustedFirst === true && runCalls.length === 1) {
        return { ...releasedRun(input.task.task_id), state: "admission_refused", reason: "capacity_exhausted", spawnCount: 0 };
      }
      return releasedRun(input.task.task_id);
    },
    stages,
    runCalls,
  };
  return driver;
}

type FenceManagerHarness = {
  readonly manager: SqliteLifecycleMcpAuthority;
  readonly driver: FenceDriver;
};

function makeFenceManager(driver: FenceDriver, dispatchFence: () => string | null): FenceManagerHarness {
  const Constructor = SqliteLifecycleMcpAuthority as unknown as new (
    driver: Detail,
    context: Detail,
    probe: Detail,
    before?: undefined,
    onStage?: (stage: string, detail?: Detail) => void,
    shutdownWaitMs?: number,
    startPlanAuthAvailable?: boolean,
    testOnlyFakeAdapter?: boolean,
    routeTaskModel?: undefined,
    startPlanAuthInjected?: boolean,
    startPlanPrivateAuthFactory?: undefined,
    onOperationReleased?: (fact: Detail, recorder: Detail) => Promise<void>,
    dispatchFence?: () => string | null,
  ) => SqliteLifecycleMcpAuthority;
  const manager = new Constructor(driver, { name: "lease-fence-test" }, { platform: "win32" }, undefined,
    (stage, detail) => driver.stages.push({ stage, detail }), 1_000,
    false, false, undefined, false, undefined,
    async (fact) => { driver.stages.push({ stage: "wake_hook", detail: fact }); },
    dispatchFence);
  return { manager, driver };
}

test("queued attempts never spawn while the lease fence reports unknown ownership", async () => {
  const driver = makeFenceDriver({
    operations: [],
    queued: [{ task_id: "fenced", attempt: 1, dispatchable: true }],
    tasks: { fenced: lifecycleSnapshot("fenced", "D:\\fenced") },
  });
  const { manager } = makeFenceManager(driver, () => "lease_ownership_unknown");
  await manager.recoverTasks();
  await drain();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(driver.runCalls, [], "no Worker Spawn may leave the Manager while lease ownership is unknown");
  assert.ok(driver.stages.some((entry) => entry.stage === "schedule_fenced"));
  await manager.shutdown();
});

test("a capacity retry timer cannot bypass the lease fence", async () => {
  const driver = makeFenceDriver({
    operations: [],
    queued: [{ task_id: "retry-fenced", attempt: 1, dispatchable: true }],
    tasks: { "retry-fenced": lifecycleSnapshot("retry-fenced", "D:\\retry-fenced") },
    capacityExhaustedFirst: true,
  });
  let fenced = false;
  const { manager } = makeFenceManager(driver, () => (fenced ? "lease_ownership_unknown" : null));
  await manager.recoverTasks();
  await waitFor(() => driver.runCalls.length === 1);
  fenced = true;
  await waitFor(() => driver.stages.some((entry) => entry.stage === "schedule_fenced" || entry.stage === "dispatch_fenced"));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(driver.runCalls.length, 1,
    "the capacity retry timer must not produce a second Spawn after ownership becomes unknown");
  await manager.shutdown();
});

test("an in-flight Worker result still settles while the fence blocks the next dispatch", async () => {
  let releaseFirstRun: (() => void) | null = null;
  const firstRunGate = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
  const driver = makeFenceDriver({
    operations: [],
    queued: [
      { task_id: "inflight", attempt: 1, dispatchable: true },
      { task_id: "behind-fence", attempt: 1, dispatchable: true },
    ],
    tasks: {
      inflight: lifecycleSnapshot("inflight", "D:\\inflight", "queued", null, null),
      "behind-fence": lifecycleSnapshot("behind-fence", "D:\\behind-fence"),
    },
  });
  const originalRun = (driver.run as unknown as (input: { task: TaskPackage }) => Promise<ClaimOnlyRunResult>).bind(driver);
  (driver as Record<string, unknown>).run = async (input: { task: TaskPackage }) => {
    if (input.task.task_id === "inflight") {
      driver.runCalls.push("inflight");
      await firstRunGate;
      return releasedRun("inflight");
    }
    return originalRun(input);
  };
  const originalRead = (driver.readTaskLifecycle as unknown as (taskId: string) => Detail | null).bind(driver);
  let inflightSettled = false;
  (driver as Record<string, unknown>).readTaskLifecycle = (taskId: string) => {
    if (String(taskId) === "inflight" && inflightSettled) {
      return lifecycleSnapshot("inflight", "D:\\inflight", "completed", releasedOperationSnapshot(), completedResultSnapshot());
    }
    return originalRead(taskId);
  };
  let fenced = false;
  const { manager } = makeFenceManager(driver, () => (fenced ? "lease_ownership_unknown" : null));
  await manager.recoverTasks();
  await waitFor(() => driver.runCalls.includes("inflight"));
  // The in-flight Worker's Result lands while the fence is already active.
  inflightSettled = true;
  fenced = true;
  releaseFirstRun!();
  fenced = true;
  releaseFirstRun!();
  await waitFor(() => driver.stages.some((entry) => entry.stage === "dispatch_fenced"));
  await drain();
  assert.deepEqual(driver.runCalls, ["inflight"], "the queued follow-up task must not spawn while fenced");
  assert.ok(driver.stages.some((entry) => entry.stage === "wake_hook"),
    "the in-flight Result delivery (Release notification) still runs while fenced");
  await manager.shutdown();
});

test("clearing the fence lets the ordinary queue machinery dispatch again", async () => {
  const driver = makeFenceDriver({
    operations: [],
    queued: [{ task_id: "resume", attempt: 1, dispatchable: true }],
    tasks: { resume: lifecycleSnapshot("resume", "D:\\resume") },
  });
  let fenced = true;
  const { manager } = makeFenceManager(driver, () => (fenced ? "lease_ownership_unknown" : null));
  await manager.recoverTasks();
  await drain();
  assert.deepEqual(driver.runCalls, []);
  fenced = false;
  await manager.recoverTasks();
  await waitFor(() => driver.runCalls.length === 1);
  await manager.shutdown();
});
