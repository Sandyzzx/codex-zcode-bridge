// Worker execution body tests: evidence persistence, failure mapping, cancel
// intent handling, and continuation specs — all with a fake adapter.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { runWorkerTask } from "../src/worker/run-task.js";
import { workerEntryPath } from "../src/manager/spawn-worker.js";
import { BRIDGE_WORKER_LAUNCH_MARKER, fingerprintRuntimeArtifact } from "../src/runtime/build-provenance.js";
import { TaskStore } from "../src/store/task-store.js";
import { BridgeError } from "../src/runtime/errors.js";
import type { ProcessIdentity, ProcessProbe } from "../src/runtime/process-probe.js";
import {
  FakeAdapter,
  fakeOutcome,
  makeManagerFixture,
  type ManagerFixture,
} from "./manager-helpers.js";
import { SESSION_ID, makeTask } from "./helpers.js";

function immediateProbe(): ProcessProbe {
  const identity = (pid: number): ProcessIdentity => ({
    pid,
    fingerprint: `test-fingerprint-${pid}`,
    fingerprint_precision: "exact",
    identity_version: 1,
    platform: process.platform,
    captured_at: "2026-09-27T00:00:00.000Z",
  });
  return {
    platform: process.platform,
    identityOf: async (pid) => identity(pid),
    selfIdentity: async () => identity(process.pid),
    probe: async () => [],
  };
}

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

test("runtime build provenance is stored in attempt-private metadata", async () => {
  const { fixture, store } = await workerFixture();
  try {
    const adapter = new FakeAdapter();
    const bridgePath = path.join(fixture.workspaceDir, "bridge.mjs");
    const workerPath = path.join(fixture.workspaceDir, "worker-main.mjs");
    writeFileSync(bridgePath, "bridge fixture", "utf8");
    writeFileSync(workerPath, "worker fixture", "utf8");
    const expected = { bridge: fingerprintRuntimeArtifact(bridgePath), worker: fingerprintRuntimeArtifact(workerPath) };
    await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1",
      attempt: 1,
      adapter,
      runtimeProvenance: {
        bridgeLaunchMarker: true,
        rawEnvelope: JSON.stringify(expected),
        worker: fingerprintRuntimeArtifact(workerPath),
      },
    });
    assert.deepEqual(store.readAttemptMeta("task_1", 1, "runtime-provenance.json"), {
      expected,
      actual_worker: expected.worker,
      cleanup_code_bundle_sha256: expected.worker.sha256,
      provenance_status: "verified",
      worker_matches_expected: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("Bridge provenance mismatch commits failure before resolver or adapter side effects", async () => {
  const { fixture, store } = await workerFixture();
  try {
    const actualPath = path.join(fixture.workspaceDir, "worker-main.mjs");
    const wrongExpectedPath = path.join(fixture.workspaceDir, "other-worker.mjs");
    const bridgePath = path.join(fixture.workspaceDir, "bridge.mjs");
    writeFileSync(actualPath, "actual worker", "utf8");
    writeFileSync(wrongExpectedPath, "expected but different worker", "utf8");
    writeFileSync(bridgePath, "bridge fixture", "utf8");
    const hash = (filePath: string): string => createHash("sha256").update(readFileSync(filePath)).digest("hex").toUpperCase();
    const expected = {
      bridge: { path: realpathSync(bridgePath), sha256: hash(bridgePath) },
      worker: { path: realpathSync(wrongExpectedPath), sha256: hash(wrongExpectedPath) },
    };
    const adapter = new FakeAdapter();
    let resolverCalls = 0;
    const { result } = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1",
      attempt: 1,
      adapter,
      resolver: { resolve: async () => { resolverCalls += 1; return {} as never; } },
      runtimeProvenance: {
        bridgeLaunchMarker: true,
        rawEnvelope: JSON.stringify(expected),
        worker: { path: realpathSync(actualPath), sha256: hash(actualPath) },
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "provenance_path_mismatch");
    assert.equal(result.session_id, null);
    assert.deepEqual(result.files_changed, []);
    assert.equal(adapter.calls.length, 0);
    assert.equal(resolverCalls, 0);
    assert.equal(store.readStatus("task_1").cleanup_unverified, false);
    assert.equal(store.readStatus("task_1").worker_pid, null);
    assert.equal(store.readAttemptText("task_1", 1, "started.json"), null);
    assert.deepEqual(store.readAttemptMeta("task_1", 1, "runtime-provenance.json"), {
      expected,
      actual_worker: { path: realpathSync(actualPath), sha256: hash(actualPath) },
      cleanup_code_bundle_sha256: hash(actualPath),
      provenance_status: "rejected",
      provenance_error_code: "provenance_path_mismatch",
      worker_matches_expected: false,
    });
    const events = store.readEvents("task_1", 0, 100).events;
    assert.ok(events.some((event) => event.type === "worker_provenance_rejected" && event.details?.["error_code"] === "provenance_path_mismatch"));
    assert.ok(events.some((event) => event.type === "task_finished" && event.details?.["status"] === "failed"));
    assert.ok(!events.some((event) => event.type === "session_ready" || event.type === "app_server_started"));
  } finally { await fixture.cleanup(); }
});

// Budget = probe contract timeout (5s) + identity reap budget (5.5s upper
// bound already inside the probe window) + cancel polling/persistence. The
// original 2s collided with the controlled identity-evidence cost measured
// at 1.2-2.5s+ (see docs/reports/GLOBAL_INTEGRATION_P1_DIAGNOSIS.md).
test("cancel intent recorded during a running attempt reaches the adapter", { timeout: 8_000 }, async () => {
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
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1",
      attempt: 1,
      adapter,
      probe: immediateProbe(),
    });
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

test("cleanup failure persists recorded member PIDs before committing the terminal result", async () => {
  const { fixture, store } = await workerFixture();
  try {
    const adapter = new FakeAdapter();
    adapter.getResult = async () => ({
      ...fakeOutcome(),
      cleanupError: "process_tree_root_exited: process tree cleanup refused",
      cleanupVerified: false,
      cleanupMemberPids: [44_001, 44_002],
    });
    const run = await runWorkerTask({ dataRoot: fixture.dataRoot, taskId: "task_1", attempt: 1, adapter });
    assert.equal(run.status, "failed");
    assert.equal(store.readStatus("task_1").cleanup_unverified, true);
    assert.deepEqual(store.readAttemptMeta("task_1", 1, "cleanup-failure.json"), {
      member_pids: [44_001, 44_002],
      complete: true,
      last_error: "process_tree_root_exited: process tree cleanup refused",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("cleanup_failed exceptions preserve member evidence for recovery", async () => {
  const { fixture, store } = await workerFixture();
  try {
    const adapter = new FakeAdapter();
    adapter.getResult = async () => {
      throw new BridgeError("cleanup_failed", "recorded-tree scan could not verify cleanup", { memberPids: [45_101, 45_102] });
    };
    const run = await runWorkerTask({ dataRoot: fixture.dataRoot, taskId: "task_1", attempt: 1, adapter });
    assert.equal(run.status, "failed");
    assert.equal(store.readResult("task_1")?.error_code, "cleanup_failed");
    assert.equal(store.readStatus("task_1").cleanup_unverified, true);
    assert.deepEqual(store.readAttemptMeta("task_1", 1, "cleanup-failure.json"), {
      member_pids: [45_101, 45_102],
      complete: true,
      last_error: "recorded-tree scan could not verify cleanup",
    });
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

test("the shipped Worker bundle records its actual build identity without starting ZCode", async () => {
  const fixture = await makeManagerFixture();
  const store = new TaskStore(fixture.dataRoot);
  try {
    store.createTask(fixture.makeTask(), "2026-09-27T00:00:00.000Z");
    const workerPath = path.resolve("plugins/codex-zcode-bridge/worker/worker-main.mjs");
    const workerSha = createHash("sha256").update(readFileSync(workerPath)).digest("hex").toUpperCase();
    const expected = {
      bridge: { path: "C:\\isolated\\dist\\bridge.mjs", sha256: "A".repeat(64) },
      worker: { path: workerPath, sha256: workerSha },
    };
    const run = spawnSync(process.execPath, [workerPath, fixture.dataRoot, "task_1", "1", BRIDGE_WORKER_LAUNCH_MARKER], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: fixture.workspaceDir,
        USERPROFILE: fixture.workspaceDir,
        APPDATA: path.join(fixture.workspaceDir, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(fixture.workspaceDir, "AppData", "Local"),
        ZCODE_BRIDGE_DATA_DIR: fixture.dataRoot,
        ZCODE_HOME: path.join(fixture.dataRoot, "missing", ".zcode"),
        ZCODE_BRIDGE_RUNTIME_PROVENANCE: JSON.stringify(expected),
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(store.readResult("task_1")?.error_code, "provider_config_missing", "worker fails before any ZCode runtime is started");
    assert.deepEqual(store.readAttemptMeta("task_1", 1, "runtime-provenance.json"), {
      expected,
      actual_worker: { path: realpathSync(workerPath), sha256: workerSha },
      cleanup_code_bundle_sha256: workerSha,
      provenance_status: "verified",
      worker_matches_expected: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("Bridge launch marker makes a missing provenance environment field fail before ZCode startup", async () => {
  const fixture = await makeManagerFixture();
  const store = new TaskStore(fixture.dataRoot);
  try {
    store.createTask(fixture.makeTask(), "2026-09-27T00:00:00.000Z");
    const workerPath = path.resolve("plugins/codex-zcode-bridge/worker/worker-main.mjs");
    const run = spawnSync(process.execPath, [workerPath, fixture.dataRoot, "task_1", "1", BRIDGE_WORKER_LAUNCH_MARKER], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: fixture.workspaceDir,
        USERPROFILE: fixture.workspaceDir,
        APPDATA: path.join(fixture.workspaceDir, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(fixture.workspaceDir, "AppData", "Local"),
        ZCODE_HOME: path.join(fixture.dataRoot, "missing", ".zcode"),
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const result = store.readResult("task_1");
    assert.equal(result?.status, "failed");
    assert.equal(result?.error_code, "provenance_missing");
    assert.equal(result?.session_id, null);
    assert.equal(store.readStatus("task_1").cleanup_unverified, false);
    assert.deepEqual(store.readAttemptMeta("task_1", 1, "runtime-provenance.json"), {
      expected: null,
      actual_worker: { path: realpathSync(workerPath), sha256: createHash("sha256").update(readFileSync(workerPath)).digest("hex").toUpperCase() },
      cleanup_code_bundle_sha256: createHash("sha256").update(readFileSync(workerPath)).digest("hex").toUpperCase(),
      provenance_status: "rejected",
      provenance_error_code: "provenance_missing",
      worker_matches_expected: false,
    });
    const events = store.readEvents("task_1", 0, 100).events;
    assert.ok(events.some((event) => event.type === "worker_provenance_rejected"));
    assert.ok(!events.some((event) => event.type === "app_server_started" || event.type === "session_ready"));
  } finally { await fixture.cleanup(); }
});

test("legacy direct Worker launch records unverified and remains compatible", async () => {
  const fixture = await makeManagerFixture();
  const store = new TaskStore(fixture.dataRoot);
  try {
    store.createTask(fixture.makeTask(), "2026-09-27T00:00:00.000Z");
    const workerPath = path.resolve("plugins/codex-zcode-bridge/worker/worker-main.mjs");
    const run = spawnSync(process.execPath, [workerPath, fixture.dataRoot, "task_1", "1"], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: fixture.workspaceDir,
        USERPROFILE: fixture.workspaceDir,
        APPDATA: path.join(fixture.workspaceDir, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(fixture.workspaceDir, "AppData", "Local"),
        ZCODE_HOME: path.join(fixture.dataRoot, "missing", ".zcode"),
      },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(store.readResult("task_1")?.status, "failed");
    assert.equal(store.readResult("task_1")?.error_code, "provider_config_missing", "legacy path reached ordinary runtime resolution without a model call");
    assert.deepEqual(store.readAttemptMeta("task_1", 1, "runtime-provenance.json"), {
      expected: null,
      actual_worker: { path: realpathSync(workerPath), sha256: createHash("sha256").update(readFileSync(workerPath)).digest("hex").toUpperCase() },
      cleanup_code_bundle_sha256: createHash("sha256").update(readFileSync(workerPath)).digest("hex").toUpperCase(),
      provenance_status: "unverified",
      provenance_reason: "provenance_unverified_legacy",
      worker_matches_expected: false,
    });
    assert.ok(!store.readEvents("task_1", 0, 100).events.some((event) => event.type === "worker_provenance_rejected"));
  } finally { await fixture.cleanup(); }
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

test("identity evidence survives a 2.5s probe inside the 5.5s reap budget and lands before terminal artifacts", { timeout: 10_000 }, async () => {
  const { fixture, store } = await workerFixture();
  try {
    const identity = {
      pid: process.pid,
      fingerprint: "delayed-probe-fingerprint",
      fingerprint_precision: "exact",
      identity_version: 1,
      platform: process.platform,
      captured_at: new Date().toISOString(),
    };
    const probe = {
      platform: process.platform,
      identityOf: async () => identity,
      selfIdentity: async () => {
        await sleepMs(2_500);
        return identity;
      },
      probe: async () => [{ state: "exited", reason_code: "delayed_probe_test", observed_at: new Date().toISOString() }],
    };
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1", attempt: store.readStatus("task_1").attempt,
      adapter: new FakeAdapter(),
      probe: probe as never,
    });
    assert.equal(run.status, "completed");
    const persisted = store.readExecutorIdentity("task_1", 1);
    assert.ok(persisted?.worker, "a probe that answers within its contract must land executor-identity.json");
    assert.equal((persisted!.worker as unknown as Record<string, unknown>)["fingerprint"], identity.fingerprint);
  } finally { await fixture.cleanup(); }
});

test("identity reap window still closes on a probe that never answers, without unbounded waiting", { timeout: 12_000 }, async () => {
  const { fixture, store } = await workerFixture();
  try {
    const started = Date.now();
    const probe = {
      platform: process.platform,
      identityOf: async () => { throw new Error("never"); },
      selfIdentity: () => new Promise<never>(() => undefined),
      probe: async () => [],
    };
    const run = await runWorkerTask({
      dataRoot: fixture.dataRoot,
      taskId: "task_1", attempt: store.readStatus("task_1").attempt,
      adapter: new FakeAdapter(),
      probe: probe as never,
    });
    assert.equal(run.status, "completed");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 9_000, `identity reap must stay bounded, took ${elapsed}ms`);
    assert.equal(store.readExecutorIdentity("task_1", 1)?.worker ?? null, null, "an unanswered probe must not fabricate identity");
  } finally { await fixture.cleanup(); }
});
