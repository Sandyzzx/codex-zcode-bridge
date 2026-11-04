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
    objective: "verify scoped scheduling",
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
  };
}

function recoveryOperation(operationId: string, phase: string, workspace: string, occupied = true): Detail {
  return {
    operation_id: operationId,
    phase,
    workspace_ref: workspace,
    capacity_occupied: occupied,
  };
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

function lifecycleSnapshot(taskId: string, executionPath: string, status = "queued", phase: string | null = null): Detail {
  return {
    task: task(taskId, executionPath),
    projection: { task_id: taskId, status, current_attempt: 1, created_at: "2026-11-04T00:00:00.000Z" },
    attempt: { attempt: 1 },
    operation: phase === null ? null : { operation_id: `${taskId}-operation`, phase },
    result: null,
    continuation: null,
  };
}

async function drain(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeDriver(snapshot: Detail): Detail {
  const activeWorkspaces: string[] = [];
  const stages: Array<{ stage: string; detail?: Detail }> = [];
  const runCalls: string[] = [];
  const recoverCalls: string[] = [];
  const recoverOptions: Detail[] = [];
  const driver = {
    readRecoverySnapshot() {
      const operations = (snapshot.operations as Detail[]).map((operation) => (
        activeWorkspaces.includes(String(operation.workspace_ref))
          ? { ...operation, capacity_occupied: true }
          : operation
      ));
      return recoverySnapshot(operations);
    },
    readRecoverableQueuedAttempts() {
      return snapshot.queued;
    },
    async recoverOperation(operationId: string, options?: Detail) {
      recoverCalls.push(String(operationId));
      recoverOptions.push(options ?? {});
      return operationId === "held-a"
        ? { state: "held", operation_id: operationId, reason: "cleanup_incomplete" }
        : { state: "released", operation_id: operationId };
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
      activeWorkspaces.push(input.task.worktree_path ?? input.task.workspace);
      return releasedRun(input.task.task_id);
    },
    stages,
    runCalls,
    recoverCalls,
    recoverOptions,
  };
  return driver;
}

function makeManager(driver: Detail): SqliteLifecycleMcpAuthority {
  const Constructor = SqliteLifecycleMcpAuthority as unknown as new (
    driver: Detail,
    context: Detail,
    probe: Detail,
    before?: undefined,
    onStage?: (stage: string, detail?: Detail) => void,
    shutdownWaitMs?: number,
  ) => SqliteLifecycleMcpAuthority;
  return new Constructor(driver, { name: "scoped-hold-test" }, { platform: "win32" }, undefined,
    (stage, detail) => (driver.stages as Array<{ stage: string; detail?: Detail }>).push({ stage, detail }), 1_000);
}

test("startup Recovery scopes a Hold to one execution path and dispatches another", async () => {
  const held = recoveryOperation("held-a", "cleanup_unverified", "D:\\one");
  const driver = makeDriver({
    operations: [held],
    queued: [{ task_id: "other", attempt: 1, dispatchable: true }],
    tasks: { other: lifecycleSnapshot("other", "D:\\two") },
  });
  const manager = makeManager(driver);
  await manager.recoverTasks();
  await drain();
  assert.deepEqual(driver.runCalls, ["other"]);
  assert.ok((driver.stages as Array<{ stage: string }>).some((entry) => entry.stage === "recovery_workspace_scoped"));
  assert.ok(!(driver.stages as Array<{ stage: string }>).some((entry) => entry.stage === "recovery_root_read_only"));
  await manager.shutdown();
});

test("different execution paths can run concurrently up to the Manager dispatch loop", async () => {
  const driver = makeDriver({
    operations: [],
    queued: [
      { task_id: "one", attempt: 1, dispatchable: true },
      { task_id: "two", attempt: 1, dispatchable: true },
    ],
    tasks: {
      one: lifecycleSnapshot("one", "D:\\one"),
      two: lifecycleSnapshot("two", "D:\\two"),
    },
  });
  const manager = makeManager(driver);
  await manager.recoverTasks();
  await drain();
  assert.deepEqual([...(driver.runCalls as string[])].sort(), ["one", "two"]);
  await manager.shutdown();
});

test("an occupied execution path is deferred and never spawns a second Worker", async () => {
  const driver = makeDriver({
    operations: [recoveryOperation("held-a", "cleanup_unverified", "D:\\one")],
    queued: [{ task_id: "conflict", attempt: 1, dispatchable: true }],
    tasks: { conflict: lifecycleSnapshot("conflict", "D:\\one") },
  });
  const manager = makeManager(driver);
  await manager.recoverTasks();
  await drain();
  assert.deepEqual(driver.runCalls, []);
  assert.ok((driver.stages as Array<{ stage: string }>).some((entry) => entry.stage === "dispatch_deferred_workspace_occupied"));
  await manager.shutdown();
});

test("cancel completes evidence-only recovery for a failed cleanup Hold", async () => {
  const driver = makeDriver({
    operations: [],
    queued: [],
    tasks: { held: lifecycleSnapshot("held", "D:\\one", "failed", "cleanup_unverified") },
  });
  const manager = makeManager(driver);
  const status = await manager.cancelTask("held");
  assert.equal(status.status, "failed");
  assert.deepEqual(driver.recoverCalls, ["held-operation"]);
  assert.deepEqual(driver.recoverOptions, [{ stopAliveWorker: true }], "explicit cancel authorizes identity-bound stop of the original Worker if still alive");
  await manager.shutdown();
});

test("repeated cancel after durable Release is a read-only idempotent success", async () => {
  const driver = makeDriver({
    operations: [],
    queued: [],
    tasks: { held: lifecycleSnapshot("held", "D:\\one", "failed", "released") },
  });
  const manager = makeManager(driver);
  const first = await manager.cancelTask("held");
  const repeated = await manager.cancelTask("held");
  assert.equal(first.status, "failed");
  assert.equal(repeated.status, "failed");
  assert.deepEqual(driver.recoverCalls, [], "a released Operation must not run Recovery or append another Release");
  await manager.shutdown();
});
