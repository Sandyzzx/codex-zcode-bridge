// Worker execution body tests: evidence persistence, failure mapping, cancel
// intent handling, and continuation specs — all with a fake adapter.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { runWorkerTask } from "../src/worker/run-task.js";
import { workerEntryPath } from "../src/manager/spawn-worker.js";
import { TaskStore } from "../src/store/task-store.js";
import { BridgeError } from "../src/runtime/errors.js";
import {
  FakeAdapter,
  makeManagerFixture,
  type ManagerFixture,
} from "./manager-helpers.js";
import { SESSION_ID, makeTask } from "./helpers.js";

async function workerFixture() {
  const fixture: ManagerFixture = await makeManagerFixture();
  const store = new TaskStore(fixture.dataRoot);
  store.createTask(fixture.makeTask(), "2026-09-27T00:00:00.000Z");
  return { fixture, store };
}

test("successful run persists running state, attempt evidence, logs, and a completed result", async () => {
  const { fixture, store } = await workerFixture();
  try {
    const adapter = new FakeAdapter();
    const { result } = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1", attempt: store.readStatus("task_1").attempt,
      adapter,
    });
    assert.equal(result.status, "completed");
    const status = store.readStatus("task_1");
    assert.equal(status.status, "completed");
    assert.equal(status.worker_pid, null, "terminal workers release their recorded PID");
    assert.equal(status.zcode_session_id, SESSION_ID);
    assert.equal(status.exit_code, 0);
    const persisted = store.readResult("task_1");
    assert.equal(persisted?.session_id, SESSION_ID);
    assert.deepEqual(persisted?.files_changed, ["bridge-smoke.txt"]);
    assert.equal(persisted?.needs_master_decision, false);
    assert.match(store.readAttemptText("task_1", 1, "prompt.txt")!, /ZCODE_HEADLESS_SMOKE_OK/);
    const outcomeMeta = store.readAttemptMeta<Record<string, unknown>>("task_1", 1, "outcome.json");
    assert.equal((outcomeMeta?.["outcome"] as Record<string, unknown>)["sessionId"], SESSION_ID);
    assert.match(store.readLog("task_1", "stdout"), /sessionId/);
    assert.equal(store.readLog("task_1", "stderr"), "");
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0]!.kind, "start");
  } finally {
    await fixture.cleanup();
  }
});

test("cancel intent recorded during a running attempt reaches the adapter", { timeout: 2_000 }, async () => {
  const { fixture, store } = await workerFixture();
  try {
    let rejectRun: (error: Error) => void;
    const adapter = new FakeAdapter();
    adapter.getResult = async () => {
      store.writeStatus("task_1", { cancel_requested: true });
      return new Promise((_, reject) => { rejectRun = reject; });
    };
    adapter.cancelTask = async () => {
      adapter.cancelCallCount += 1;
      rejectRun(new BridgeError("cancelled", "runtime cancellation verified"));
    };
    const run = await runWorkerTask({ dataRoot: fixture.dataRoot, taskId: "task_1", attempt: 1, adapter });
    assert.equal(adapter.cancelCallCount, 1);
    assert.equal(run.status, "cancelled");
    assert.equal(store.readResult("task_1")?.summary, "runtime cancellation verified");
    assert.equal(store.readStatus("task_1").worker_pid, null);
  } finally { await fixture.cleanup(); }
});

test("needs_master_decision=true maps to waiting_for_master, not completed", async () => {
  const { fixture, store } = await workerFixture();
  try {
    const adapter = new FakeAdapter();
    adapter.behavior = "master";
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1", attempt: store.readStatus("task_1").attempt,
      adapter,
    });
    assert.equal(run.status, "waiting_for_master");
    assert.equal(store.readStatus("task_1").status, "waiting_for_master");
    assert.equal(store.readResult("task_1")?.needs_master_decision, true);
  } finally {
    await fixture.cleanup();
  }
});

test("adapter failure maps to failed with the adapter error code preserved", async () => {
  const { fixture, store } = await workerFixture();
  try {
    const adapter = new FakeAdapter();
    adapter.behavior = "adapterFailed";
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1", attempt: store.readStatus("task_1").attempt,
      adapter,
    });
    assert.equal(run.status, "failed");
    const result = store.readResult("task_1");
    assert.equal(result?.error_code, "zcode_nonzero_exit");
    assert.equal(result?.needs_master_decision, true);
    assert.equal(result?.exit_code, 1);
    assert.match(store.readLog("task_1", "stderr"), /zcode exited/);
    const status = store.readStatus("task_1");
    assert.equal(status.error_code, "zcode_nonzero_exit");
    assert.ok(status.error);
  } finally {
    await fixture.cleanup();
  }
});

test("injected resolver failure surfaces as a distinct config error before any adapter call", async () => {
  const { fixture, store } = await workerFixture();
  try {
    const adapter = new FakeAdapter();
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1", attempt: store.readStatus("task_1").attempt,
      adapter,
      resolver: {
        resolve: async () => {
          throw new BridgeError("provider_config_missing", "no personal provider config exists");
        },
      },
    });
    assert.equal(run.status, "failed");
    assert.equal(store.readResult("task_1")?.error_code, "provider_config_missing");
    assert.equal(adapter.calls.length, 0, "the adapter must not run on config failure");
  } finally {
    await fixture.cleanup();
  }
});

test("a pre-recorded cancel intent finishes cancelled without touching the adapter", async () => {
  const { fixture, store } = await workerFixture();
  try {
    store.writeStatus("task_1", { cancel_requested: true });
    const adapter = new FakeAdapter();
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1", attempt: store.readStatus("task_1").attempt,
      adapter,
    });
    assert.equal(run.status, "cancelled");
    assert.equal(adapter.calls.length, 0);
    assert.equal(store.readResult("task_1")?.status, "cancelled");
    assert.equal(store.readResult("task_1")?.needs_master_decision, false);
    assert.equal(store.readStatus("task_1").status, "cancelled");
  } finally {
    await fixture.cleanup();
  }
});

test("continuation spec drives continueTask with feedback and prior evidence", async () => {
  const { fixture, store } = await workerFixture();
  try {
    // Attempt 1 completes normally.
    await runWorkerTask({ dataRoot: fixture.dataRoot, taskId: "task_1", attempt: store.readStatus("task_1").attempt, adapter: new FakeAdapter() });
    // The manager archives attempt 1's result and records attempt 2's spec.
    store.archiveResultToAttempt("task_1", 1);
    store.writeStatus("task_1", {
      status: "queued",
      attempt: 2,
      started_at: null,
      finished_at: null,
      worker_pid: null,
      zcode_session_id: null,
      exit_code: null,
      error_code: null,
      error: null,
    });
    store.writeAttemptMeta("task_1", 2, "continue.json", {
      feedback: "Fix the failing test",
      additional_requirements: ["Keep the API stable"],
      previous_session_id: SESSION_ID,
      previous_attempt: 1,
    });
    const adapter = new FakeAdapter();
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1", attempt: store.readStatus("task_1").attempt,
      adapter,
    });
    assert.equal(run.status, "completed");
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.calls[0]!.kind, "continue");
    assert.equal(adapter.calls[0]!.attempt, 2);
    assert.equal(adapter.calls[0]!.feedback, "Fix the failing test");
    assert.deepEqual(adapter.calls[0]!.additionalRequirements, ["Keep the API stable"]);
    assert.equal(adapter.calls[0]!.previousSessionId, SESSION_ID);
    assert.equal(
      (adapter.calls[0]!.previousResult as { session_id?: string } | null)?.session_id,
      SESSION_ID,
      "previous result must be loaded from the archived attempt",
    );
    assert.match(store.readAttemptText("task_1", 2, "prompt.txt")!, /Fix the failing test/);
    assert.equal(store.readResult("task_1")?.attempt, 2);
    assert.ok(store.readArchivedResult("task_1", 1), "attempt 1 evidence must survive");
  } finally {
    await fixture.cleanup();
  }
});

test("the compiled worker shell rejects missing arguments without any task access", () => {
  const run = spawnSync(process.execPath, [workerEntryPath()], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node worker-main\.js/);
});
