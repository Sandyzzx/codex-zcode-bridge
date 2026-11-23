// P1 §3.3 Release → Wake recovery fault injection (2026-11-24).
//
// Contract under test: when an Executor exits after the durable Release
// commit but before the Wake intent exists, the next Recovery pass re-runs the
// notification exactly once for released operations that carry a committed
// Result and no executor_wake observation at all. Operations with any
// recorded wake fact keep their dedup contract (no duplicate Queue
// submission), cancelled Results are skipped, and repeated Recovery passes do
// not duplicate notifications once the observation lands.
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
    objective: "verify release wake recovery",
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
  };
}

function releasedRun(): ClaimOnlyRunResult {
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

interface WakeHarness {
  readonly driver: Detail;
  readonly stages: Array<{ stage: string; detail?: Detail }>;
  readonly wakeFacts: Detail[];
  readonly observations: Detail[];
  manager(): Promise<SqliteLifecycleMcpAuthority>;
}

function makeRecoveryHarness(input: {
  readonly operations: Detail[];
  readonly events: Detail[];
  readonly taskProjections: Detail[];
  readonly tasks: Detail;
  readonly queued?: Detail[];
  readonly resultStatus?: string;
}): WakeHarness {
  const stages: Array<{ stage: string; detail?: Detail }> = [];
  const wakeFacts: Detail[] = [];
  const observations: Detail[] = [];
  const driver: Detail = {
    readRecoverySnapshot() {
      return {
        root_status: "consistent_read_only",
        writes_allowed: false,
        cleanup_performed: false,
        claim_release_performed: false,
        operation_release_performed: false,
        operations: input.operations,
        events: input.events,
        task_projections: input.taskProjections,
        capacity: { policy_version: 1, policy_generation: 1, capacity_limit: 8 },
      };
    },
    readRecoverableQueuedAttempts() {
      return input.queued ?? [];
    },
    async recoverOperation(operationId: string) {
      return { state: "released", operation_id: operationId };
    },
    readTaskLifecycle(taskId: string) {
      return (input.tasks as Detail)[String(taskId)] ?? null;
    },
    readCommittedResult() {
      return null;
    },
    readTaskEvents() {
      return { events: [], nextCursor: 0, hasMore: false };
    },
    recordExecutorWakeObservation(observation: Detail) {
      observations.push(observation);
      return {
        duplicate: false,
        operation_id: observation.operation_id,
        state: observation.state,
      };
    },
    close() {},
    async run() {
      return releasedRun();
    },
    stages,
    wakeFacts,
    observations,
  };
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
    onOperationReleased?: (fact: Detail, recorder: { recordExecutorWakeObservation(input: Detail): Detail }) => Promise<void>,
  ) => SqliteLifecycleMcpAuthority;
  const manager = new Constructor(driver, { name: "release-wake-recovery-test" }, { platform: "win32" }, undefined,
    (stage, detail) => stages.push({ stage, detail }), 1_000,
    false, false, undefined, false, undefined,
    async (fact, recorder) => {
      wakeFacts.push(fact);
      recorder.recordExecutorWakeObservation({
        operation_id: fact.operation_id,
        task_id: fact.task_id,
        attempt: fact.attempt,
        generation: fact.generation,
        state: "intent",
        thread_id: "thread-recovered",
        delivery_id: `delivery-${String(fact.operation_id)}`,
        policy_digest: "0".repeat(64),
        authorization_digest: "1".repeat(64),
        reason_code: "recovered_release_without_intent",
      });
    });
  return {
    driver,
    stages,
    wakeFacts,
    observations,
    manager: async () => manager,
  };
}

function releasedOperation(operationId: string, taskId: string, resultStatus = "completed"): Detail {
  return {
    operation_id: operationId,
    task_id: taskId,
    attempt: 1,
    generation: 1,
    phase: "released",
    result_digest: "a".repeat(64),
    result_commit_ref: "result-" + "a".repeat(64),
    result_status: resultStatus,
    operation_kind: "attempt_lifecycle",
    capacity_occupied: false,
  };
}

function taskProjection(taskId: string, status: string): Detail {
  return { task_id: taskId, status, workspace: `D:\\${taskId}`, execution_workspace: `D:\\${taskId}` };
}

function lifecycleSnapshotFor(taskId: string): Detail {
  return {
    task: task(taskId, `D:\\${taskId}`),
    projection: { task_id: taskId, status: "completed", current_attempt: 1, created_at: "2026-11-24T00:00:00.000Z" },
    attempt: { attempt: 1 },
    operation: null,
    result: null,
    continuation: null,
  };
}

test("a Release that never produced a Wake intent is re-notified exactly once by Recovery", async () => {
  const harness = makeRecoveryHarness({
    operations: [releasedOperation("op-gap", "gap")],
    events: [],
    taskProjections: [taskProjection("gap", "completed")],
    tasks: { gap: lifecycleSnapshotFor("gap") },
  });
  const manager = await harness.manager();
  await manager.recoverTasks();
  assert.equal(harness.wakeFacts.length, 1, "the interrupted notification must be re-run");
  assert.equal(harness.wakeFacts[0]?.operation_id, "op-gap");
  assert.equal(harness.observations.length, 1, "the re-run notification records its observation");
  assert.ok(harness.stages.some((entry) => entry.stage === "release_wake_recovery_selected"));
  await manager.shutdown();
});

test("an existing executor_wake observation keeps its dedup contract and is never re-notified", async () => {
  const priorEvidence = {
    reason: "executor_wake",
    state: "intent",
    task_id: "notified",
    attempt: 1,
    operation_id: "op-notified",
    generation: 1,
    result_digest: "a".repeat(64),
    result_commit_ref: "result-" + "a".repeat(64),
    thread_id: "thread-original",
    delivery_id: "delivery-original",
    policy_digest: "0".repeat(64),
    authorization_digest: "1".repeat(64),
    reason_code: "owner_authorized_trusted_local",
    evidence_digest: "2".repeat(64),
  };
  const harness = makeRecoveryHarness({
    operations: [releasedOperation("op-notified", "notified")],
    events: [{
      operation_id: "op-notified",
      event_type: "observation_recorded",
      evidence_json: JSON.stringify(priorEvidence),
    }],
    taskProjections: [taskProjection("notified", "completed")],
    tasks: { notified: lifecycleSnapshotFor("notified") },
  });
  const manager = await harness.manager();
  await manager.recoverTasks();
  assert.equal(harness.wakeFacts.length, 0,
    "a queue submission with unknown acknowledgement outcome must not be duplicated");
  await manager.shutdown();
});

test("repeated Recovery passes do not duplicate the recovered notification", async () => {
  const harness = makeRecoveryHarness({
    operations: [releasedOperation("op-repeat", "repeat")],
    events: [],
    taskProjections: [taskProjection("repeat", "completed")],
    tasks: { repeat: lifecycleSnapshotFor("repeat") },
  });
  const manager = await harness.manager();
  await manager.recoverTasks();
  // The observation recorded by the first pass now exists in the wake set.
  harness.driver.readRecoverySnapshot = () => ({
    root_status: "consistent_read_only",
    writes_allowed: false,
    cleanup_performed: false,
    claim_release_performed: false,
    operation_release_performed: false,
    operations: [releasedOperation("op-repeat", "repeat")],
    events: [{
      operation_id: "op-repeat",
      event_type: "observation_recorded",
      evidence_json: JSON.stringify({
        reason: "executor_wake",
        state: "intent",
        operation_id: "op-repeat",
        task_id: "repeat",
      }),
    }],
    task_projections: [taskProjection("repeat", "completed")],
    capacity: { policy_version: 1, policy_generation: 1, capacity_limit: 8 },
  });
  await manager.recoverTasks();
  assert.equal(harness.wakeFacts.length, 1, "the second pass sees the recorded intent and deduplicates");
  await manager.shutdown();
});

test("two parallel Releases are both recovered independently", async () => {
  const harness = makeRecoveryHarness({
    operations: [releasedOperation("op-a", "task-a"), releasedOperation("op-b", "task-b")],
    events: [],
    taskProjections: [taskProjection("task-a", "completed"), taskProjection("task-b", "failed")],
    tasks: { "task-a": lifecycleSnapshotFor("task-a"), "task-b": lifecycleSnapshotFor("task-b") },
  });
  const manager = await harness.manager();
  await manager.recoverTasks();
  assert.deepEqual(harness.wakeFacts.map((fact) => fact.operation_id).sort(), ["op-a", "op-b"]);
  await manager.shutdown();
});

test("a cancelled Result is never selected for wake recovery", async () => {
  const harness = makeRecoveryHarness({
    operations: [releasedOperation("op-cancelled", "cancelled", "cancelled")],
    events: [],
    taskProjections: [taskProjection("cancelled", "cancelled")],
    tasks: { cancelled: lifecycleSnapshotFor("cancelled") },
  });
  const manager = await harness.manager();
  await manager.recoverTasks();
  assert.equal(harness.wakeFacts.length, 0);
  await manager.shutdown();
});

test("an unreleased or Result-less operation is not selected", async () => {
  const harness = makeRecoveryHarness({
    operations: [
      { ...releasedOperation("op-running", "running-task"), phase: "running", result_digest: null, result_commit_ref: null },
      { ...releasedOperation("op-released-no-result", "no-result-task"), result_digest: null, result_commit_ref: null, result_status: null },
    ],
    events: [],
    taskProjections: [taskProjection("running-task", "running"), taskProjection("no-result-task", "queued")],
    tasks: { "running-task": lifecycleSnapshotFor("running-task"), "no-result-task": lifecycleSnapshotFor("no-result-task") },
  });
  const manager = await harness.manager();
  await manager.recoverTasks();
  assert.equal(harness.wakeFacts.length, 0);
  await manager.shutdown();
});
