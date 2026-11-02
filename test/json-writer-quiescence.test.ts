import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import test from "node:test";
import { BridgeTaskManager } from "../src/manager/task-manager.js";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import { createPlatformProbe } from "../src/runtime/process-probe.js";
import type { ProcessProbe } from "../src/runtime/process-probe.js";
import {
  defaultDurableFileOperations,
  type DurableFileOperations,
} from "../src/runtime/durable-file-system.js";
import { TaskStore } from "../src/store/task-store.js";
import { tryAcquireProcessLock } from "../src/store/process-lock.js";
import { buildFailureFacts } from "../src/diagnostics/failure-facts.js";
import {
  beginJsonWriterDrain,
  bindPendingWorkerJsonWriter,
  jsonWriterFenceState,
  registerManagerJsonWriter,
  registerPendingWorkerJsonWriter,
  releaseManagerJsonWriter,
  releaseWorkerJsonWriter,
  sealJsonWriterRoot,
} from "../src/store/json-writer-quiescence.js";
import { makeTask, makeTempDir, removeTempDir } from "./helpers.js";

function processProbe() {
  return createPlatformProbe({ timeoutMs: 5_000 });
}

interface OwnedProbeProcess {
  readonly child: ReturnType<typeof spawn>;
  readonly pid: number;
  readonly identity: Awaited<ReturnType<ProcessProbe["identityOf"]>>;
}

const OWNED_PROCESS_SOURCE = [
  "process.on('message', (message) => {",
  "  if (message === 'stop') process.exit(0);",
  "});",
  "if (!process.send) process.exit(2);",
  "process.send('ready');",
  "setInterval(() => {}, 1000);",
].join("\n");

async function startOwnedProbeProcess(probe: ProcessProbe): Promise<OwnedProbeProcess> {
  const child = spawn(process.execPath, ["-e", OWNED_PROCESS_SOURCE], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const pid = child.pid;
  assert.ok(pid, "owned probe process must expose its PID");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned probe process readiness timed out")), 10_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      if (message === "ready") resolve();
      else reject(new Error("owned probe process returned an unexpected readiness message"));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`owned probe process exited before readiness: ${String(code)}`));
    });
  });
  return { child, pid, identity: await probe.identityOf(pid) };
}

async function stopOwnedProbeProcess(processHandle: OwnedProbeProcess): Promise<void> {
  if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned probe process did not acknowledge cooperative stop")), 10_000);
    processHandle.child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    processHandle.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    processHandle.child.send("stop", (error) => {
      if (!error) return;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function writeRealHistoricalCleanupAttempt(
  root: string,
  taskId: string,
  worker: OwnedProbeProcess,
  runtime: OwnedProbeProcess,
  memberPid: number,
): Promise<void> {
  const store = new TaskStore(root);
  store.createTask(makeTask({ task_id: taskId }), "2026-10-31T00:00:00.000Z");
  store.writeStatus(taskId, {
    status: "running",
    started_at: "2026-10-31T00:00:01.000Z",
    worker_pid: worker.pid,
    zcode_pid: runtime.pid,
  }, 1);
  store.writeAttemptMeta(taskId, 1, "started.json", { worker_pid: worker.pid });
  store.writeAttemptMeta(taskId, 1, "execution.claim", { pid: worker.pid });
  store.writeExecutorIdentity(taskId, 1, {
    worker: worker.identity as unknown as Record<string, unknown>,
    runtime: runtime.identity as unknown as Record<string, unknown>,
  });
  store.writeAttemptMeta(taskId, 1, "cleanup-failure.json", {
    member_pids: [memberPid],
    complete: true,
    last_error: "the controlled member still required a real platform probe",
  });
  store.writeStatus(taskId, {
    status: "completed",
    finished_at: "2026-10-31T00:01:00.000Z",
    worker_pid: null,
    zcode_pid: null,
  });
  store.writeStatus(taskId, {
    status: "queued",
    attempt: 2,
    started_at: null,
    finished_at: null,
    worker_pid: null,
    zcode_pid: null,
    exit_code: null,
  });
}

async function startDrainedHistoricalTask(
  root: string,
  probe: ProcessProbe,
  managerLeaseRef: { value?: string },
): Promise<TaskStore> {
  managerLeaseRef.value = await registerManagerJsonWriter(root, await probe.selfIdentity());
  const store = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLeaseRef.value });
  await beginJsonWriterDrain(root);
  await releaseManagerJsonWriter(root, managerLeaseRef.value);
  managerLeaseRef.value = undefined;
  return store;
}

test("the final JSON fence is published only after a durable atomic replacement", async () => {
  const root = await makeTempDir("json-writer-durable-seal");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask({ task_id: "durable_seal" }), "2026-10-31T00:00:00.000Z");
    const probe = processProbe();
    const managerLease = await registerManagerJsonWriter(root, await probe.selfIdentity());
    await releaseManagerJsonWriter(root, managerLease);
    assert.equal(await beginJsonWriterDrain(root), "draining");
    let replacements = 0;
    const durability: DurableFileOperations = {
      ...defaultDurableFileOperations,
      replaceFileSync(source, destination) {
        replacements += 1;
        defaultDurableFileOperations.replaceFileSync(source, destination);
      },
    };
    const sealed = await sealJsonWriterRoot(root, store, probe, durability);
    assert.equal(sealed.sealed, true, JSON.stringify(sealed.blockers));
    assert.equal(replacements, 1);
    assert.equal(jsonWriterFenceState(root), "sealed");
  } finally {
    await removeTempDir(root);
  }
});

test("a failed durable fence replacement never reports a successful seal", async () => {
  const root = await makeTempDir("json-writer-durable-seal-failure");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask({ task_id: "durable_seal_failure" }), "2026-10-31T00:00:00.000Z");
    const probe = processProbe();
    const managerLease = await registerManagerJsonWriter(root, await probe.selfIdentity());
    await releaseManagerJsonWriter(root, managerLease);
    assert.equal(await beginJsonWriterDrain(root), "draining");
    const durability: DurableFileOperations = {
      ...defaultDurableFileOperations,
      replaceFileSync() {
        throw Object.assign(new Error("injected durable replacement failure"), { code: "EPERM" });
      },
    };
    await assert.rejects(
      sealJsonWriterRoot(root, store, probe, durability),
      /injected durable replacement failure/u,
    );
    assert.equal(jsonWriterFenceState(root), "draining");
    assert.throws(
      () => new TaskStore(root, { writerQuiescence: true }).createTask(
        makeTask({ task_id: "admission_after_failed_seal" }),
        "2026-10-31T00:00:01.000Z",
      ),
      /fence is draining; unregistered write rejected/u,
    );
  } finally {
    await removeTempDir(root);
  }
});

async function queuedContinuationWithStartedHistory(
  root: string,
  taskId: string,
  includeExactIdentity: boolean,
  startedAt?: string,
): Promise<{ workerPid: number; runtimePid: number }> {
  const probe = processProbe();
  const workerIdentity = await probe.selfIdentity();
  assert.ok(workerIdentity);
  const runtimeIdentity = { ...workerIdentity, pid: workerIdentity.pid + 1 };
  const store = new TaskStore(root);
  store.createTask(makeTask({ task_id: taskId }), "2026-10-31T00:00:00.000Z");
  store.writeStatus(taskId, {
    status: "running",
    started_at: "2026-10-31T00:00:01.000Z",
    worker_pid: workerIdentity.pid,
    zcode_pid: runtimeIdentity.pid,
  }, 1);
  store.writeAttemptMeta(taskId, 1, "started.json", {
    worker_pid: workerIdentity.pid,
    ...(startedAt ? { started_at: startedAt } : {}),
  });
  store.writeAttemptMeta(taskId, 1, "execution.claim", { pid: workerIdentity.pid });
  if (includeExactIdentity) {
    store.writeExecutorIdentity(taskId, 1, {
      worker: workerIdentity as unknown as Record<string, unknown>,
      runtime: runtimeIdentity as unknown as Record<string, unknown>,
    });
  }
  store.writeStatus(taskId, {
    status: "completed",
    finished_at: "2026-10-31T00:01:00.000Z",
    worker_pid: null,
    zcode_pid: null,
  });
  store.writeStatus(taskId, {
    status: "queued",
    attempt: 2,
    started_at: null,
    finished_at: null,
    worker_pid: null,
    zcode_pid: null,
    exit_code: null,
  });
  return { workerPid: workerIdentity.pid, runtimePid: runtimeIdentity.pid };
}

test("BridgeTaskManager closes admission and queue dispatch while preserving queued JSON history", async () => {
  const root = await makeTempDir("json-writer-manager-fence");
  const legacyStore = new TaskStore(root);
  const queued = makeTask({ task_id: "queued_before_drain" });
  legacyStore.createTask(queued, new Date().toISOString());
  const probe = processProbe();
  const managerIdentity = await probe.selfIdentity();
  const leaseToken = await registerManagerJsonWriter(root, managerIdentity);
  const store = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: leaseToken });
  let spawnCount = 0;
  const manager = new BridgeTaskManager({
    store,
    workspaceProvider: new DirectWorkspaceProvider(),
    pollIntervalMs: 0,
    probe,
    spawnWorker: () => { spawnCount += 1; return { pid: process.pid }; },
  });
  try {
    assert.equal(await manager.beginWriterQuiescence(), "draining");
    await assert.rejects(manager.createTask(makeTask({ task_id: "must_be_rejected" })), /writer fence is draining/);
    assert.throws(() => store.createTask(makeTask({ task_id: "direct_store_admission" }), new Date().toISOString()), /new task admission is closed/);
    await manager.recoverTasks();
    assert.equal(spawnCount, 0, "recovery cannot pump queued work after the fence closes");
    assert.equal(store.readStatus(queued.task_id).status, "queued", "queued history remains persisted and unresolved");
    assert.equal(store.hasTask("must_be_rejected"), false, "rejected admission has no JSON record");
    assert.equal(store.hasTask("direct_store_admission"), false, "direct TaskStore admission is checked under the write permit");
  } finally {
    await manager.shutdown();
    await removeTempDir(root);
  }
});

test("sealed root rejects a late fenced TaskStore write before creating task paths", async () => {
  const root = await makeTempDir("json-writer-seal");
  try {
    const probe = processProbe();
    const lease = await registerManagerJsonWriter(root, await probe.selfIdentity());
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: lease });
    await beginJsonWriterDrain(root);
    const unregisteredWriter = new TaskStore(root, { writerQuiescence: true });
    assert.throws(() => unregisteredWriter.createTask(makeTask({ task_id: "unregistered_during_drain" }), new Date().toISOString()), /unregistered write rejected/);
    assert.equal(existsSync(path.join(root, ".tasks", "unregistered_during_drain")), false);
    await releaseManagerJsonWriter(root, lease);
    const sealingStore = new TaskStore(root);
    const sealed = await sealJsonWriterRoot(root, sealingStore, probe);
    assert.deepEqual(sealed, { sealed: true, state: "sealed", blockers: [], reaped_leases: 0 });

    const lateWriter = new TaskStore(root, { writerQuiescence: true });
    assert.throws(() => lateWriter.createTask(makeTask({ task_id: "late_writer" }), new Date().toISOString()), /fence is sealed/);
    assert.equal(existsSync(path.join(root, ".tasks", "late_writer")), false);
    const facts = buildFailureFacts({ source: "turn_event", phase: "turn_terminal", providerCode: "insufficient_quota", accepted: "yes" });
    assert.throws(() => lateWriter.writeFailureFacts("late_writer", 1, process.pid, facts), /fence is sealed/);
    assert.equal(existsSync(path.join(root, ".tasks", "late_writer")), false);
    await assert.rejects(
      registerManagerJsonWriter(root, await probe.selfIdentity()),
      /new writer registration is closed/u,
      "a supported Bridge startup must not reacquire the sealed legacy JSON Root",
    );
  } finally {
    await removeTempDir(root);
  }
});

test("an unconfigured TaskStore cannot bypass an active writer registry or fence", async () => {
  const root = await makeTempDir("json-writer-unconfigured-bypass");
  let unconfiguredChild: ReturnType<typeof spawn> | undefined;
  let childTimer: NodeJS.Timeout | undefined;
  try {
    const legacyStore = new TaskStore(root);
    const beforeFence = makeTask({ task_id: "legacy_before_registry" });
    legacyStore.createTask(beforeFence, new Date().toISOString());
    assert.equal(legacyStore.hasTask(beforeFence.task_id), true, "JSON behavior remains unchanged before the root opts into quiescence");

    const probe = processProbe();
    const lease = await registerManagerJsonWriter(root, await probe.selfIdentity());
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: lease });
    await beginJsonWriterDrain(root);

    const lateLegacyStore = new TaskStore(root);
    const lateTask = makeTask({ task_id: "legacy_after_registry" });
    assert.throws(() => lateLegacyStore.createTask(lateTask, new Date().toISOString()), /unregistered write rejected/);
    assert.equal(lateLegacyStore.hasTask(lateTask.task_id), false, "a constructor missing fence options cannot write after participant registration");

    const probeUrl = new URL("../src/runtime/process-probe.js", import.meta.url).href;
    const storeUrl = new URL("../src/store/task-store.js", import.meta.url).href;
    const childSource = [
      `import { TaskStore } from ${JSON.stringify(storeUrl)};`,
      "const [dataRoot, taskId] = process.argv.slice(1);",
      "try { new TaskStore(dataRoot).writeStatus(taskId, { error: 'child_bypass' }); console.log('unexpected_write'); process.exitCode = 2; }",
      "catch (error) { console.log(error instanceof Error ? error.message : String(error)); }",
    ].join("\n");
    unconfiguredChild = spawn(process.execPath, ["--input-type=module", "-e", childSource, root, beforeFence.task_id], {
      cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const childStdout: Buffer[] = [];
    const childStderr: Buffer[] = [];
    unconfiguredChild.stdout!.on("data", (chunk: Buffer) => childStdout.push(chunk));
    unconfiguredChild.stderr!.on("data", (chunk: Buffer) => childStderr.push(chunk));
    const [childCode] = await Promise.race([
      once(unconfiguredChild, "close") as Promise<[number | null, NodeJS.Signals | null]>,
      new Promise<never>((_resolve, reject) => { childTimer = setTimeout(() => reject(new Error("unconfigured Writer child did not settle")), 10_000); }),
    ]);
    if (childTimer) clearTimeout(childTimer);
    assert.equal(childCode, 0, Buffer.concat(childStderr).toString("utf8"));
    assert.match(Buffer.concat(childStdout).toString("utf8"), /unregistered write rejected/);
    assert.equal(legacyStore.readStatus(beforeFence.task_id).error, undefined, "a separate current-code process cannot write through the active fence");

    await releaseManagerJsonWriter(root, lease);
    const sealed = await sealJsonWriterRoot(root, managerStore, probe);
    assert.equal(sealed.sealed, true, JSON.stringify(sealed.blockers));
    const afterSeal = makeTask({ task_id: "legacy_after_seal" });
    assert.throws(() => new TaskStore(root).createTask(afterSeal, new Date().toISOString()), /fence is sealed/);
    assert.equal(existsSync(path.join(root, ".tasks", afterSeal.task_id)), false, "an unconfigured late writer cannot create paths after seal");
  } finally {
    if (childTimer) clearTimeout(childTimer);
    if (unconfiguredChild && unconfiguredChild.exitCode === null && unconfiguredChild.signalCode === null) {
      unconfiguredChild.kill();
      await once(unconfiguredChild, "close").catch(() => undefined);
    }
    await removeTempDir(root);
  }
});

test("corrupt quiescence state fails closed for an otherwise registered writer", async () => {
  const root = await makeTempDir("json-writer-corrupt-fence");
  let managerLease: string | undefined;
  try {
    const probe = processProbe();
    managerLease = await registerManagerJsonWriter(root, await probe.selfIdentity());
    const store = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    const task = makeTask({ task_id: "corrupt_fence_write" });
    store.createTask(task, new Date().toISOString());
    writeFileSync(path.join(root, ".tasks", ".writer-quiescence.json"), "{not-json", "utf8");
    assert.throws(() => store.writeStatus(task.task_id, { error: "must_not_write" }), /unreadable|malformed/);
    assert.equal(store.readStatus(task.task_id).error, undefined, "the failed write leaves the projection unchanged");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("a Manager roster lease with unknown identity prevents sealing and remains recorded", async () => {
  const root = await makeTempDir("json-writer-unknown-manager-roster");
  let managerLease: string | undefined;
  try {
    managerLease = await registerManagerJsonWriter(root, null);
    const store = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    await beginJsonWriterDrain(root);
    const baseProbe = processProbe();
    let probeCalls = 0;
    const unknownProbe: ProcessProbe = {
      ...baseProbe,
      probe: async (requests) => {
        probeCalls += 1;
        return requests.map(() => ({
          state: "exited",
          reason_code: "pid_absent_but_identity_unavailable",
          observed_at: new Date().toISOString(),
        }));
      },
    };

    const outcome = await sealJsonWriterRoot(root, store, unknownProbe);
    assert.equal(outcome.sealed, false);
    assert.equal(outcome.state, "draining");
    assert.equal(outcome.reaped_leases, 0);
    assert.ok(outcome.blockers.includes(`writer_identity_unknown:${managerLease}`));
    assert.equal(probeCalls, 0, "a PID-only exited verdict cannot substitute for the missing registered identity");
    assert.equal(existsSync(path.join(root, ".tasks", ".writer-roster", `${managerLease}.json`)), true,
      "an unknown identity must not reap or erase its roster evidence");
    assert.equal(jsonWriterFenceState(root), "draining", "unknown roster identity must keep the cutover fence open");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("a started terminal Task without exact Worker identity prevents sealing", async () => {
  const scenarios = [
    { name: "started marker without Worker PID", workerPid: false, runtimePid: false, identity: null, startedAt: true, blocker: "task_worker_identity_unknown" },
    { name: "worker identity missing", workerPid: true, runtimePid: false, identity: null, blocker: "task_worker_identity_unknown" },
    { name: "worker identity PID mismatch", workerPid: true, runtimePid: false, identity: "worker_mismatch", blocker: "task_worker_identity_unknown" },
    { name: "runtime identity missing", workerPid: false, runtimePid: true, identity: "runtime_missing", blocker: "task_runtime_identity_unknown" },
    { name: "runtime identity PID mismatch", workerPid: false, runtimePid: true, identity: "runtime_mismatch", blocker: "task_attempt_identity_conflict" },
  ] as const;

  for (const scenario of scenarios) {
    const root = await makeTempDir("json-writer-task-identity-seal");
    let managerLease: string | undefined;
    try {
      const baseProbe = processProbe();
      const self = await baseProbe.selfIdentity();
      assert.ok(self);
      const taskId = `seal_${scenario.identity === null ? "missing" : scenario.identity}`;
      const taskStore = new TaskStore(root);
      taskStore.createTask(makeTask({ task_id: taskId }), new Date().toISOString());
      taskStore.writeStatus(taskId, {
        status: "completed",
        finished_at: new Date().toISOString(),
        worker_pid: scenario.workerPid ? process.pid : null,
        zcode_pid: scenario.runtimePid ? process.pid : null,
        ...( "startedAt" in scenario && scenario.startedAt ? { started_at: new Date().toISOString() } : {}),
      }, 1);

      if (scenario.identity !== null) {
        const workerIdentity = scenario.identity === "worker_mismatch"
          ? { ...self, pid: process.pid + 1 } as unknown as Record<string, unknown>
          : scenario.workerPid ? self as unknown as Record<string, unknown> : undefined;
        const runtimeIdentity = scenario.identity === "runtime_mismatch"
          ? { ...self, pid: process.pid + 1 } as unknown as Record<string, unknown>
          : scenario.identity === "runtime_missing" ? null : scenario.runtimePid ? self as unknown as Record<string, unknown> : undefined;
        taskStore.writeExecutorIdentity(taskId, 1, {
          ...(workerIdentity ? { worker: workerIdentity } : {}),
          ...(runtimeIdentity !== undefined ? { runtime: runtimeIdentity } : {}),
        });
      }

      managerLease = await registerManagerJsonWriter(root, self);
      const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
      await beginJsonWriterDrain(root);
      await releaseManagerJsonWriter(root, managerLease);
      managerLease = undefined;

      let probeCalls = 0;
      const countingProbe: ProcessProbe = {
        ...baseProbe,
        probe: async () => { probeCalls += 1; return []; },
      };
      const outcome = await sealJsonWriterRoot(root, managerStore, countingProbe);
      assert.equal(outcome.sealed, false, scenario.name);
      assert.ok(outcome.blockers.some((blocker) => blocker.startsWith(`${scenario.blocker}:${taskId}`)), scenario.name);
      assert.equal(probeCalls, 0, `${scenario.name}: seal must reject before a PID-only or mismatched-identity probe`);
      assert.equal(jsonWriterFenceState(root), "draining", `${scenario.name}: identity uncertainty must preserve the drain fence`);
    } finally {
      if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
      await removeTempDir(root);
    }
  }
});

test("a queued continuation still probes every exact identity from its started historical Attempt", async () => {
  const root = await makeTempDir("json-writer-historical-attempt-exited");
  let managerLease: string | undefined;
  try {
    const baseProbe = processProbe();
    const taskId = "queued_after_started_attempt";
    const identities = await queuedContinuationWithStartedHistory(root, taskId, true);
    managerLease = await registerManagerJsonWriter(root, await baseProbe.selfIdentity());
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    await beginJsonWriterDrain(root);
    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;

    const requestsSeen: Array<readonly { pid: number }[]> = [];
    const exitedProbe: ProcessProbe = {
      ...baseProbe,
      probe: async (requests) => {
        requestsSeen.push(requests);
        return requests.map(() => ({
          state: "exited",
          reason_code: "pid_absent_after_complete_query",
          observed_at: new Date().toISOString(),
        }));
      },
    };
    const outcome = await sealJsonWriterRoot(root, managerStore, exitedProbe);
    assert.equal(outcome.sealed, true, JSON.stringify(outcome.blockers));
    assert.deepEqual(
      requestsSeen.map((requests) => requests.map((request) => request.pid)),
      [[identities.workerPid, identities.runtimePid]],
      "the current queued Attempt must not hide the prior started Attempt",
    );
    assert.equal(jsonWriterFenceState(root), "sealed");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("a queued current Attempt with retained executor PIDs is still probed before sealing", async () => {
  const root = await makeTempDir("json-writer-queued-current-identity");
  let managerLease: string | undefined;
  try {
    const baseProbe = processProbe();
    const self = await baseProbe.selfIdentity();
    assert.ok(self);
    const taskId = "queued_current_retained_identity";
    const taskStore = new TaskStore(root);
    taskStore.createTask(makeTask({ task_id: taskId }), "2026-10-31T00:00:00.000Z");
    taskStore.writeStatus(taskId, {
      status: "queued",
      attempt: 1,
      started_at: null,
      finished_at: null,
      worker_pid: process.pid,
      zcode_pid: null,
    }, 1);
    taskStore.writeExecutorIdentity(taskId, 1, {
      worker: self as unknown as Record<string, unknown>,
      runtime: null,
    });

    managerLease = await registerManagerJsonWriter(root, null);
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    await beginJsonWriterDrain(root);
    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;

    let probeCalls = 0;
    const outcome = await sealJsonWriterRoot(root, managerStore, {
      ...baseProbe,
      probe: async (requests) => {
        probeCalls += 1;
        return requests.map(() => ({
          state: "alive",
          reason_code: "identity_match",
          observed_at: new Date().toISOString(),
        }));
      },
    });
    assert.equal(outcome.sealed, false);
    assert.ok(outcome.blockers.some((blocker) => blocker.startsWith(`executor_not_confirmed_exited:${taskId}`)));
    assert.equal(probeCalls, 1, "a queued label must not hide a retained executor PID");
    assert.equal(jsonWriterFenceState(root), "draining");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("historical Attempt live or identity-free evidence keeps the JSON fence draining", async () => {
  const scenarios = [
    { name: "live exact identity", includeIdentity: true, blocker: "executor_not_confirmed_exited" },
    { name: "missing exact identity", includeIdentity: false, blocker: "task_worker_identity_unknown" },
  ] as const;

  for (const scenario of scenarios) {
    const root = await makeTempDir("json-writer-historical-attempt-blocked");
    let managerLease: string | undefined;
    try {
      const baseProbe = processProbe();
      const taskId = scenario.includeIdentity ? "historical_live_attempt" : "historical_identity_missing";
      await queuedContinuationWithStartedHistory(root, taskId, scenario.includeIdentity);
      managerLease = await registerManagerJsonWriter(root, await baseProbe.selfIdentity());
      const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
      await beginJsonWriterDrain(root);
      await releaseManagerJsonWriter(root, managerLease);
      managerLease = undefined;

      let probeCalls = 0;
      const outcome = await sealJsonWriterRoot(root, managerStore, {
        ...baseProbe,
        probe: async (requests) => {
          probeCalls += 1;
          return requests.map((request, index) => ({
            state: index === 0 ? "alive" : "exited",
            reason_code: index === 0 ? "identity_match" : "pid_absent_after_complete_query",
            observed_at: new Date().toISOString(),
          }));
        },
      });
      assert.equal(outcome.sealed, false, scenario.name);
      assert.ok(outcome.blockers.some((blocker) => blocker.startsWith(`${scenario.blocker}:${taskId}`)), scenario.name);
      assert.equal(probeCalls, scenario.includeIdentity ? 1 : 0, scenario.name);
      assert.equal(jsonWriterFenceState(root), "draining", scenario.name);
    } finally {
      if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
      await removeTempDir(root);
    }
  }
});

test("pre-boot terminal Attempts without exact identity are safely distinguishable from live uncertainty", async () => {
  const bootTimeMs = Date.parse("2026-10-31T04:13:12.500Z");
  const scenarios = [
    {
      name: "historical terminal attempt before boot",
      taskId: "historical_pre_boot_identity_missing",
      startedAt: "2026-10-27T15:40:01.478Z",
      terminalAttempt: 2,
      expectSealed: true,
    },
    {
      name: "historical terminal attempt after boot",
      taskId: "historical_post_boot_identity_missing",
      startedAt: "2026-10-31T05:00:00.000Z",
      terminalAttempt: 2,
      expectSealed: false,
    },
    {
      name: "current terminal attempt before boot",
      taskId: "current_pre_boot_identity_missing",
      startedAt: "2026-10-27T15:40:01.478Z",
      terminalAttempt: 1,
      expectSealed: true,
    },
    {
      name: "current terminal attempt without execution evidence",
      taskId: "current_terminal_without_execution",
      startedAt: null,
      terminalAttempt: 1,
      expectSealed: true,
    },
  ] as const;

  for (const scenario of scenarios) {
    const root = await makeTempDir("json-writer-pre-boot-history");
    let managerLease: string | undefined;
    try {
      const probe = processProbe();
      const store = new TaskStore(root);
      store.createTask(makeTask({ task_id: scenario.taskId }), "2026-10-27T15:40:00.000Z");
      if (scenario.terminalAttempt === 2) {
        store.writeStatus(scenario.taskId, {
          status: "running",
          attempt: 1,
          started_at: scenario.startedAt,
          worker_pid: 42_001,
          zcode_pid: null,
        }, 1);
        store.writeAttemptMeta(scenario.taskId, 1, "started.json", {
          worker_pid: 42_001,
          ...(scenario.startedAt ? { started_at: scenario.startedAt } : {}),
        });
        store.writeStatus(scenario.taskId, {
          status: "completed",
          attempt: 1,
          finished_at: "2026-10-27T15:41:00.000Z",
          worker_pid: null,
          zcode_pid: null,
        });
      }
      store.writeStatus(scenario.taskId, {
        status: "cancelled",
        attempt: scenario.terminalAttempt,
        ...(scenario.terminalAttempt === 1 && scenario.startedAt
          ? { started_at: scenario.startedAt }
          : {}),
        finished_at: "2026-10-27T15:42:00.000Z",
        worker_pid: null,
        zcode_pid: null,
      });
      const managerLeaseRef: { value?: string } = {};
      const managerStore = await startDrainedHistoricalTask(root, probe, managerLeaseRef);
      managerLease = managerLeaseRef.value;
      let probeCalls = 0;
      const outcome = await sealJsonWriterRoot(root, managerStore, {
        ...probe,
        probe: async () => {
          probeCalls += 1;
          return [];
        },
      }, undefined, { bootTimeMs });
      assert.equal(outcome.sealed, scenario.expectSealed, `${scenario.name}: ${JSON.stringify(outcome.blockers)}`);
      assert.equal(probeCalls, 0, `${scenario.name}: missing exact identity is never replaced with an unbound probe`);
      if (!scenario.expectSealed) {
        assert.ok(outcome.blockers.includes(`task_worker_identity_unknown:${scenario.taskId}:1`), scenario.name);
        assert.equal(jsonWriterFenceState(root), "draining", scenario.name);
      }
    } finally {
      if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
      await removeTempDir(root);
    }
  }
});

test("a pre-boot historical Attempt behind a queued continuation is excluded without weakening post-boot uncertainty", async () => {
  const bootTimeMs = Date.parse("2026-10-31T04:13:12.500Z");
  const scenarios = [
    {
      name: "queued continuation with pre-boot history",
      taskId: "queued_continuation_pre_boot",
      startedAt: "2026-10-27T15:40:01.478Z",
      expectSealed: true,
    },
    {
      name: "queued continuation with post-boot history",
      taskId: "queued_continuation_post_boot",
      startedAt: "2026-10-31T05:00:00.000Z",
      expectSealed: false,
    },
  ] as const;

  for (const scenario of scenarios) {
    const root = await makeTempDir("json-writer-queued-history-boot");
    let managerLease: string | undefined;
    try {
      const baseProbe = processProbe();
      await queuedContinuationWithStartedHistory(root, scenario.taskId, false, scenario.startedAt);
      managerLease = await registerManagerJsonWriter(root, await baseProbe.selfIdentity());
      const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
      await beginJsonWriterDrain(root);
      await releaseManagerJsonWriter(root, managerLease);
      managerLease = undefined;

      let probeCalls = 0;
      const outcome = await sealJsonWriterRoot(root, managerStore, {
        ...baseProbe,
        probe: async () => {
          probeCalls += 1;
          return [];
        },
      }, undefined, { bootTimeMs });
      assert.equal(outcome.sealed, scenario.expectSealed, `${scenario.name}: ${JSON.stringify(outcome.blockers)}`);
      assert.equal(probeCalls, 0, `${scenario.name}: a missing identity is never guessed from PID liveness`);
      if (scenario.expectSealed) {
        assert.equal(jsonWriterFenceState(root), "sealed", scenario.name);
      } else {
        assert.ok(
          outcome.blockers.includes(`task_worker_identity_unknown:${scenario.taskId}:1`),
          scenario.name,
        );
        assert.equal(jsonWriterFenceState(root), "draining", scenario.name);
      }
    } finally {
      if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
      await removeTempDir(root);
    }
  }
});

test("pre-boot history cannot hide a current result or malformed cleanup evidence", async () => {
  const bootTimeMs = Date.parse("2026-10-31T04:13:12.500Z");
  const scenarios = [
    {
      name: "current result without start timestamp",
      taskId: "current_result_without_start",
      blocker: "task_worker_identity_unknown:current_result_without_start:1",
      prepare(store: TaskStore, taskId: string) {
        writeFileSync(path.join(store.taskDir(taskId), "result.json"), `${JSON.stringify({
          task_id: taskId,
          attempt: 1,
          started_at: null,
          finished_at: "2026-10-27T15:41:00.000Z",
          status: "completed",
          zcode_output: "",
          exit_code: 0,
          session_id: null,
          summary: "completed without a durable start time",
          files_changed: [],
          tests: [],
          issues: [],
          needs_master_decision: false,
        }, null, 2)}\n`, "utf8");
      },
    },
    {
      name: "pre-boot malformed cleanup failure",
      taskId: "pre_boot_cleanup_failure_incomplete",
      blocker: "task_cleanup_failure_incomplete:pre_boot_cleanup_failure_incomplete:1",
      prepare(store: TaskStore, taskId: string) {
        store.writeAttemptMeta(taskId, 1, "started.json", {
          worker_pid: 42_002,
          started_at: "2026-10-27T15:40:01.478Z",
        });
        store.writeAttemptMeta(taskId, 1, "cleanup-failure.json", {
          member_pids: [42_002],
          complete: false,
        });
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const root = await makeTempDir("json-writer-pre-boot-guard");
    let managerLease: string | undefined;
    try {
      const probe = processProbe();
      const store = new TaskStore(root);
      store.createTask(makeTask({ task_id: scenario.taskId }), "2026-10-27T15:40:00.000Z");
      store.writeStatus(scenario.taskId, {
        status: "completed",
        attempt: 1,
        ...(scenario.name === "pre-boot malformed cleanup failure"
          ? { started_at: "2026-10-27T15:40:01.478Z" }
          : {}),
        finished_at: "2026-10-27T15:41:00.000Z",
        worker_pid: null,
        zcode_pid: null,
      }, 1);
      scenario.prepare(store, scenario.taskId);
      const managerLeaseRef: { value?: string } = {};
      const managerStore = await startDrainedHistoricalTask(root, probe, managerLeaseRef);
      managerLease = managerLeaseRef.value;
      const outcome = await sealJsonWriterRoot(root, managerStore, probe, undefined, { bootTimeMs });
      assert.equal(outcome.sealed, false, scenario.name);
      assert.ok(outcome.blockers.includes(scenario.blocker), `${scenario.name}: ${JSON.stringify(outcome.blockers)}`);
      assert.equal(jsonWriterFenceState(root), "draining", scenario.name);
    } finally {
      if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
      await removeTempDir(root);
    }
  }
});

test("trusted Result timing and cancellation-before-start replace missing executor identity only after reboot proof", async () => {
  const bootTimeMs = Date.parse("2026-10-31T04:13:12.500Z");
  const scenarios = [
    {
      name: "historical Result before boot",
      taskId: "historical_result_before_boot",
      prepare(store: TaskStore, taskId: string) {
        store.writeStatus(taskId, {
          status: "running",
          attempt: 1,
          started_at: "2026-09-28T23:44:45.871Z",
        }, 1);
        store.writeAttemptMeta(taskId, 1, "result.json", {
          task_id: taskId,
          attempt: 1,
          started_at: "2026-09-28T23:44:45.871Z",
          finished_at: "2026-09-28T23:44:46.030Z",
          zcode_output: "",
          exit_code: null,
          session_id: null,
          status: "failed",
          summary: "historical worker exited",
          files_changed: [],
          tests: [],
          issues: [],
          needs_master_decision: true,
          error_code: "worker_lost",
        });
        store.writeStatus(taskId, {
          status: "failed",
          attempt: 2,
          started_at: "2026-09-28T23:45:21.000Z",
          finished_at: "2026-09-28T23:45:22.000Z",
        });
      },
    },
    {
      name: "cancelled before start",
      taskId: "cancelled_before_start",
      prepare(store: TaskStore, taskId: string) {
        store.writeStatus(taskId, {
          status: "cancelled",
          attempt: 1,
          started_at: null,
          finished_at: "2026-10-04T17:55:48.696Z",
          worker_pid: null,
          zcode_pid: null,
        });
        writeFileSync(path.join(store.taskDir(taskId), "result.json"), `${JSON.stringify({
          task_id: taskId,
          attempt: 1,
          started_at: null,
          finished_at: "2026-10-04T17:55:48.696Z",
          zcode_output: "",
          exit_code: null,
          session_id: null,
          status: "cancelled",
          summary: "cancelled by request before the task started",
          files_changed: [],
          tests: [],
          issues: [],
          needs_master_decision: false,
        }, null, 2)}\n`, "utf8");
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const root = await makeTempDir("json-writer-trusted-result-timing");
    let managerLease: string | undefined;
    try {
      const probe = processProbe();
      const store = new TaskStore(root);
      store.createTask(makeTask({ task_id: scenario.taskId }), "2026-09-28T23:44:00.000Z");
      scenario.prepare(store, scenario.taskId);
      const managerLeaseRef: { value?: string } = {};
      const managerStore = await startDrainedHistoricalTask(root, probe, managerLeaseRef);
      managerLease = managerLeaseRef.value;
      let probeCalls = 0;
      const outcome = await sealJsonWriterRoot(root, managerStore, {
        ...probe,
        probe: async () => {
          probeCalls += 1;
          return [];
        },
      }, undefined, { bootTimeMs });
      assert.equal(outcome.sealed, true, `${scenario.name}: ${JSON.stringify(outcome.blockers)}`);
      assert.equal(probeCalls, 0, scenario.name);
      assert.equal(jsonWriterFenceState(root), "sealed", scenario.name);
    } finally {
      if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
      await removeTempDir(root);
    }
  }
});

test("historical cleanup-failure evidence must be complete and well-formed before sealing", async () => {
  const scenarios = [
    {
      name: "malformed JSON",
      blocker: "task_cleanup_failure_unknown",
      write: (store: TaskStore, taskId: string, root: string) => {
        const file = path.join(store.attemptDir(taskId, 1), "cleanup-failure.json");
        writeFileSync(file, "{not-json", "utf8");
        assert.ok(existsSync(path.join(root, ".tasks", taskId, "attempts", "1", "cleanup-failure.json")));
      },
    },
    {
      name: "explicitly incomplete",
      blocker: "task_cleanup_failure_incomplete",
      write: (store: TaskStore, taskId: string, _root: string) => {
        store.writeAttemptMeta(taskId, 1, "cleanup-failure.json", {
          member_pids: [42_001],
          complete: false,
          last_error: "known members exceeded the complete marker budget",
        });
      },
    },
    {
      name: "missing completeness",
      blocker: "task_cleanup_failure_incomplete",
      write: (store: TaskStore, taskId: string, _root: string) => {
        store.writeAttemptMeta(taskId, 1, "cleanup-failure.json", {
          member_pids: [],
          last_error: "legacy record omitted completeness",
        });
      },
    },
    {
      name: "invalid member list",
      blocker: "task_cleanup_failure_incomplete",
      write: (store: TaskStore, taskId: string, _root: string) => {
        store.writeAttemptMeta(taskId, 1, "cleanup-failure.json", {
          member_pids: [0],
          complete: true,
          last_error: "invalid member identity",
        });
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const root = await makeTempDir(`json-writer-cleanup-${scenario.blocker}`);
    let managerLease: string | undefined;
    try {
      const baseProbe = processProbe();
      const taskId = `historical_cleanup_${scenario.blocker}`;
      await queuedContinuationWithStartedHistory(root, taskId, true);
      const taskStore = new TaskStore(root);
      scenario.write(taskStore, taskId, root);

      managerLease = await registerManagerJsonWriter(root, await baseProbe.selfIdentity());
      const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
      await beginJsonWriterDrain(root);
      await releaseManagerJsonWriter(root, managerLease);
      managerLease = undefined;

      let probeCalls = 0;
      const outcome = await sealJsonWriterRoot(root, managerStore, {
        ...baseProbe,
        probe: async (requests) => {
          probeCalls += 1;
          return requests.map(() => ({
            state: "exited",
            reason_code: "pid_absent_after_complete_query",
            observed_at: new Date().toISOString(),
          }));
        },
      });
      assert.equal(outcome.sealed, false, scenario.name);
      assert.ok(
        outcome.blockers.some((blocker) => blocker.startsWith(`${scenario.blocker}:${taskId}:1`)),
        `${scenario.name}: ${JSON.stringify(outcome.blockers)}`,
      );
      assert.equal(probeCalls, 0, `${scenario.name}: incomplete cleanup evidence must block before an exited probe can authorize sealing`);
      assert.equal(jsonWriterFenceState(root), "draining", scenario.name);
    } finally {
      if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
      await removeTempDir(root);
    }
  }
});

test("a complete historical cleanup-failure record can be archived after its executor exited", async () => {
  const root = await makeTempDir("json-writer-cleanup-complete");
  let managerLease: string | undefined;
  try {
    const baseProbe = processProbe();
    const taskId = "historical_cleanup_complete";
    const identities = await queuedContinuationWithStartedHistory(root, taskId, true);
    const taskStore = new TaskStore(root);
    taskStore.writeAttemptMeta(taskId, 1, "cleanup-failure.json", {
      member_pids: [42_001, 42_002],
      complete: true,
      last_error: "cleanup was later verified",
    });

    managerLease = await registerManagerJsonWriter(root, await baseProbe.selfIdentity());
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    await beginJsonWriterDrain(root);
    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;

    const requestsSeen: Array<readonly { pid: number }[]> = [];
    const outcome = await sealJsonWriterRoot(root, managerStore, {
      ...baseProbe,
      probe: async (requests) => {
        requestsSeen.push(requests);
        return requests.map(() => ({
          state: "exited",
          reason_code: "pid_absent_after_complete_query",
          observed_at: new Date().toISOString(),
        }));
      },
    }, undefined, { bootTimeMs: Date.parse("2026-10-30T23:59:00.000Z") });
    assert.equal(outcome.sealed, true, JSON.stringify(outcome.blockers));
    assert.deepEqual(
      requestsSeen.map((requests) => requests.map((request) => request.pid)),
      [[identities.workerPid, identities.runtimePid, 42_001, 42_002]],
      "a complete historical failure record must preserve executor checks and probe every recorded member",
    );
    assert.equal(jsonWriterFenceState(root), "sealed");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("the production Windows process probe confirms a real exited cleanup member before sealing", {
  timeout: 30_000,
  skip: process.platform !== "win32",
}, async () => {
  const root = await makeTempDir("json-writer-cleanup-real-exited");
  const probe = processProbe();
  const managerLeaseRef: { value?: string } = {};
  const processes: OwnedProbeProcess[] = [];
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const worker = await startOwnedProbeProcess(probe);
    processes.push(worker);
    const runtime = await startOwnedProbeProcess(probe);
    processes.push(runtime);
    const member = await startOwnedProbeProcess(probe);
    processes.push(member);
    const taskId = "historical_cleanup_real_exited";
    await writeRealHistoricalCleanupAttempt(root, taskId, worker, runtime, member.pid);
    const managerStore = await startDrainedHistoricalTask(root, probe, managerLeaseRef);

    await stopOwnedProbeProcess(member);
    await stopOwnedProbeProcess(runtime);
    await stopOwnedProbeProcess(worker);
    const [memberVerdict] = await probe.probe([{ pid: member.pid, identity: null }]);
    assert.equal(memberVerdict?.state, "exited", JSON.stringify(memberVerdict));
    const outcome = await sealJsonWriterRoot(root, managerStore, probe);
    assert.equal(outcome.sealed, true, JSON.stringify(outcome.blockers));
    assert.equal(jsonWriterFenceState(root), "sealed");
  } catch (error) {
    primaryError = error;
  } finally {
    for (const processHandle of processes.slice().reverse()) {
      try {
        await stopOwnedProbeProcess(processHandle);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (managerLeaseRef.value) {
      try {
        await releaseManagerJsonWriter(root, managerLeaseRef.value);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await removeTempDir(root);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw cleanupErrors[0];
});

test("the production Windows process probe keeps the fence draining for a real live cleanup member", {
  timeout: 30_000,
  skip: process.platform !== "win32",
}, async () => {
  const root = await makeTempDir("json-writer-cleanup-real-live");
  const probe = processProbe();
  const managerLeaseRef: { value?: string } = {};
  const processes: OwnedProbeProcess[] = [];
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const worker = await startOwnedProbeProcess(probe);
    processes.push(worker);
    const runtime = await startOwnedProbeProcess(probe);
    processes.push(runtime);
    const member = await startOwnedProbeProcess(probe);
    processes.push(member);
    const taskId = "historical_cleanup_real_live";
    await writeRealHistoricalCleanupAttempt(root, taskId, worker, runtime, member.pid);
    const managerStore = await startDrainedHistoricalTask(root, probe, managerLeaseRef);

    await stopOwnedProbeProcess(runtime);
    await stopOwnedProbeProcess(worker);
    const [memberVerdict] = await probe.probe([{ pid: member.pid, identity: null }]);
    assert.notEqual(memberVerdict?.state, "exited", JSON.stringify(memberVerdict));
    const outcome = await sealJsonWriterRoot(root, managerStore, probe);
    assert.equal(outcome.sealed, false);
    assert.ok(outcome.blockers.includes(`task_cleanup_member_not_confirmed_exited:${taskId}`),
      JSON.stringify(outcome.blockers));
    assert.equal(jsonWriterFenceState(root), "draining");

    await stopOwnedProbeProcess(member);
    const [afterStop] = await probe.probe([{ pid: member.pid, identity: null }]);
    assert.equal(afterStop?.state, "exited", JSON.stringify(afterStop));
  } catch (error) {
    primaryError = error;
  } finally {
    for (const processHandle of processes.slice().reverse()) {
      try {
        await stopOwnedProbeProcess(processHandle);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (managerLeaseRef.value) {
      try {
        await releaseManagerJsonWriter(root, managerLeaseRef.value);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await removeTempDir(root);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw cleanupErrors[0];
});

test("a live or unidentifiable historical cleanup member keeps the JSON fence draining", async () => {
  const root = await makeTempDir("json-writer-cleanup-member-live");
  let managerLease: string | undefined;
  try {
    const baseProbe = processProbe();
    const taskId = "historical_cleanup_member_live";
    const identities = await queuedContinuationWithStartedHistory(root, taskId, true);
    const taskStore = new TaskStore(root);
    taskStore.writeAttemptMeta(taskId, 1, "cleanup-failure.json", {
      member_pids: [42_001, 42_002],
      complete: true,
      last_error: "a recorded descendant was not proven exited",
    });

    managerLease = await registerManagerJsonWriter(root, await baseProbe.selfIdentity());
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    await beginJsonWriterDrain(root);
    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;

    const requestsSeen: Array<readonly { pid: number; identity: unknown }[]> = [];
    const outcome = await sealJsonWriterRoot(root, managerStore, {
      ...baseProbe,
      probe: async (requests) => {
        requestsSeen.push(requests);
        return requests.map((request) => (
          request.pid === identities.workerPid || request.pid === identities.runtimePid
            ? {
                state: "exited" as const,
                reason_code: "pid_absent_after_complete_query",
                observed_at: new Date().toISOString(),
              }
            : {
                state: "unknown" as const,
                reason_code: "live_pid_no_fingerprint",
                observed_at: new Date().toISOString(),
              }
        ));
      },
    }, undefined, { bootTimeMs: Date.parse("2026-10-30T23:59:00.000Z") });

    assert.equal(outcome.sealed, false);
    assert.ok(outcome.blockers.some((blocker) => blocker === `task_cleanup_member_not_confirmed_exited:${taskId}`));
    assert.deepEqual(
      requestsSeen.map((requests) => requests.map((request) => request.pid)),
      [[identities.workerPid, identities.runtimePid, 42_001, 42_002]],
    );
    assert.equal(jsonWriterFenceState(root), "draining");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("a historical cleanup-failure record alone still requires exact executor identity", async () => {
  const root = await makeTempDir("json-writer-cleanup-identity-missing");
  let managerLease: string | undefined;
  try {
    const taskId = "historical_cleanup_identity_missing";
    const taskStore = new TaskStore(root);
    taskStore.createTask(makeTask({ task_id: taskId }), "2026-10-31T00:00:00.000Z");
    taskStore.writeStatus(taskId, {
      status: "running",
      started_at: "2026-10-31T00:00:01.000Z",
    }, 1);
    taskStore.writeStatus(taskId, {
      status: "completed",
      finished_at: "2026-10-31T00:01:00.000Z",
      worker_pid: null,
      zcode_pid: null,
    });
    taskStore.writeStatus(taskId, {
      status: "queued",
      attempt: 2,
      started_at: null,
      finished_at: null,
      worker_pid: null,
      zcode_pid: null,
    });
    taskStore.writeAttemptMeta(taskId, 1, "cleanup-failure.json", {
      member_pids: [42_001],
      complete: true,
      last_error: "cleanup was later verified without retaining executor identity",
    });

    const baseProbe = processProbe();
    managerLease = await registerManagerJsonWriter(root, await baseProbe.selfIdentity());
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    await beginJsonWriterDrain(root);
    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;

    const requestsSeen: number[][] = [];
    const outcome = await sealJsonWriterRoot(root, managerStore, {
      ...baseProbe,
      probe: async (requests) => {
        requestsSeen.push(requests.map((request) => request.pid));
        return requests.map(() => ({
          state: "exited",
          reason_code: "pid_absent_after_complete_query",
          observed_at: new Date().toISOString(),
        }));
      },
    });
    assert.equal(outcome.sealed, false);
    assert.ok(outcome.blockers.some((blocker) => blocker === `task_worker_identity_unknown:${taskId}:1`));
    assert.deepEqual(requestsSeen, [[42_001]], "recorded cleanup members are still probed, but their absence cannot replace the missing executor identity");
    assert.equal(jsonWriterFenceState(root), "draining");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("unknown Manager identity blocks sealing and a registered Worker can drain without writing after seal", async () => {
  const root = await makeTempDir("json-writer-worker-drain");
  let child: ReturnType<typeof spawn> | undefined;
  let managerLease: string | undefined;
  try {
    const initial = new TaskStore(root);
    const task = makeTask({ task_id: "worker_drain" });
    initial.createTask(task, new Date().toISOString());
    initial.writeStatus(task.task_id, { status: "running", started_at: new Date().toISOString() });

    const probe = processProbe();
    managerLease = await registerManagerJsonWriter(root, null);
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    const workerLease = registerPendingWorkerJsonWriter(root, task.task_id, 1);
    assert.ok(workerLease);

    const probeUrl = new URL("../src/runtime/process-probe.js", import.meta.url).href;
    const fenceUrl = new URL("../src/store/json-writer-quiescence.js", import.meta.url).href;
    const runTaskUrl = new URL("../src/worker/run-task.js", import.meta.url).href;
    const storeUrl = new URL("../src/store/task-store.js", import.meta.url).href;
    const fakeAdapterUrl = new URL("./manager-helpers.js", import.meta.url).href;
    const workerSource = [
      `import { createPlatformProbe } from ${JSON.stringify(probeUrl)};`,
      `import { activateWorkerJsonWriter, releaseWorkerJsonWriter } from ${JSON.stringify(fenceUrl)};`,
      `import { runWorkerTask } from ${JSON.stringify(runTaskUrl)};`,
      `import { TaskStore } from ${JSON.stringify(storeUrl)};`,
      `import { FakeAdapter } from ${JSON.stringify(fakeAdapterUrl)};`,
      "const [dataRoot, taskId, token] = process.argv.slice(1);",
      "const probe = createPlatformProbe();",
      "const identity = await probe.selfIdentity();",
      "await activateWorkerJsonWriter(dataRoot, token, taskId, 1, identity);",
      "const scopedStore = new TaskStore(dataRoot, { writerQuiescence: true, writerLeaseToken: token });",
      "let wrongTaskRejected = false;",
      "try { scopedStore.writeAttemptMeta('some_other_task', 1, 'probe.json', {}); } catch { wrongTaskRejected = true; }",
      "let wrongAttemptRejected = false;",
      "try { scopedStore.writeAttemptMeta(taskId, 2, 'probe.json', {}); } catch { wrongAttemptRejected = true; }",
      "if (!wrongTaskRejected || !wrongAttemptRejected) throw new Error('Worker lease escaped its Task/Attempt binding');",
      "console.log(JSON.stringify({ state: 'ready', pid: process.pid, scoped: true }));",
      "process.stdin.once('data', async () => {",
      "  await runWorkerTask({ dataRoot, taskId, attempt: 1, adapter: new FakeAdapter(), probe, writerQuiescence: true, writerLeaseToken: token });",
      "  await releaseWorkerJsonWriter(dataRoot, token);",
      "  console.log(JSON.stringify({ state: 'completed' }));",
      "});",
    ].join("\n");
    child = spawn(process.execPath, ["--input-type=module", "-e", workerSource, root, task.task_id, workerLease], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    assert.ok(child.pid);
    bindPendingWorkerJsonWriter(root, workerLease, child.pid);
    managerStore.patchRunningAttempt(task.task_id, 1, { worker_pid: child.pid });
    const stdout = createInterface({ input: child.stdout! });
    const stderrChunks: Buffer[] = [];
    child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const firstLine = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker readiness handshake timed out")), 15_000);
      stdout.once("line", (line) => { clearTimeout(timer); resolve(line); });
      child!.once("error", (error) => { clearTimeout(timer); reject(error); });
      child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Worker exited before readiness: ${code}; ${Buffer.concat(stderrChunks).toString("utf8")}`)); });
    });
    const ready = JSON.parse(firstLine) as { state: string; pid: number };
    assert.equal(ready.state, "ready");
    assert.equal(ready.pid, child.pid);

    await beginJsonWriterDrain(root);
    const blockedSeal = await sealJsonWriterRoot(root, managerStore, probe);
    assert.equal(blockedSeal.sealed, false);
    assert.ok(blockedSeal.blockers.some((item) => item.includes("writer_not_confirmed_exited"))
      || blockedSeal.blockers.some((item) => item.startsWith("task_not_terminal:")));
    const exitEvent = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    child.stdin!.end("drain\n");
    let exitTimer: NodeJS.Timeout | undefined;
    const exitResult = await Promise.race([
      exitEvent,
      new Promise<never>((_resolve, reject) => { exitTimer = setTimeout(() => reject(new Error("Worker drain exit timed out")), 15_000); }),
    ]);
    if (exitTimer) clearTimeout(exitTimer);
    const [exitCode, signal] = exitResult;
    assert.equal(exitCode, 0, Buffer.concat(stderrChunks).toString("utf8"));
    assert.equal(signal, null);
    stdout.close();
    assert.equal(managerStore.readStatus(task.task_id).status, "completed");
    assert.ok(managerStore.readEvents(task.task_id).events.some((event) => event.type === "task_finished"));
    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;
    const finalSeal = await sealJsonWriterRoot(root, managerStore, probe);
    assert.equal(finalSeal.sealed, true, JSON.stringify(finalSeal.blockers));
    assert.equal(finalSeal.state, "sealed");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit").catch(() => undefined);
    }
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("TaskStore mutation and drain transition serialize across processes", async () => {
  const root = await makeTempDir("json-writer-write-drain-order");
  let child: ReturnType<typeof spawn> | undefined;
  let managerLease: string | undefined;
  try {
    const legacyStore = new TaskStore(root);
    const task = makeTask({ task_id: "write_drain_order" });
    legacyStore.createTask(task, new Date().toISOString());
    legacyStore.writeStatus(task.task_id, { status: "running", started_at: new Date().toISOString() });

    const probe = processProbe();
    managerLease = await registerManagerJsonWriter(root, await probe.selfIdentity());
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    const workerLease = registerPendingWorkerJsonWriter(root, task.task_id, 1);
    assert.ok(workerLease);

    const probeUrl = new URL("../src/runtime/process-probe.js", import.meta.url).href;
    const fenceUrl = new URL("../src/store/json-writer-quiescence.js", import.meta.url).href;
    const storeUrl = new URL("../src/store/task-store.js", import.meta.url).href;
    const workerSource = [
      `import { createPlatformProbe } from ${JSON.stringify(probeUrl)};`,
      `import { activateWorkerJsonWriter, releaseWorkerJsonWriter, withJsonWriterWritePermit } from ${JSON.stringify(fenceUrl)};`,
      `import { TaskStore } from ${JSON.stringify(storeUrl)};`,
      `import { readSync } from 'node:fs';`,
      "const [dataRoot, taskId, token] = process.argv.slice(1);",
      "const identity = await createPlatformProbe().selfIdentity();",
      "await activateWorkerJsonWriter(dataRoot, token, taskId, 1, identity);",
      "const store = new TaskStore(dataRoot, { writerQuiescence: true, writerLeaseToken: token });",
      "console.log('READY');",
      "const input = Buffer.alloc(1); readSync(0, input, 0, 1, null);",
      "withJsonWriterWritePermit(dataRoot, token, taskId, 1, () => {",
      "  console.log('PERMIT_HELD');",
      "  readSync(0, input, 0, 1, null);",
      "  store.writeStatus(taskId, { status: 'cancelled', finished_at: new Date().toISOString() }, 1);",
      "  console.log('MUTATION_DONE');",
      "});",
      "await releaseWorkerJsonWriter(dataRoot, token);",
    ].join("\n");
    child = spawn(process.execPath, ["--input-type=module", "-e", workerSource, root, task.task_id, workerLease], {
      cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    assert.ok(child.pid);
    bindPendingWorkerJsonWriter(root, workerLease, child.pid);
    const workerIdentity = await probe.identityOf(child.pid);
    assert.ok(workerIdentity, 'Manager OS probe must observe the child identity before sealing');
    managerStore.writeExecutorIdentity(task.task_id, 1, { worker: workerIdentity as unknown as Record<string, unknown> });
    managerStore.writeStatus(task.task_id, { worker_pid: child.pid, status: "running" }, 1);
    const stdout = createInterface({ input: child.stdout! });
    const stderrChunks: Buffer[] = [];
    child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const nextLine = async (expected: string): Promise<void> => {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`expected ${expected} handshake timed out`)), 15_000);
        stdout.once("line", (value) => { clearTimeout(timer); resolve(value); });
        child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`child exited before ${expected}: ${code}; ${Buffer.concat(stderrChunks).toString("utf8")}`)); });
      });
      assert.equal(line, expected);
    };
    await nextLine("READY");
    child.stdin!.write("g");
    await nextLine("PERMIT_HELD");
    const exitEvent = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

    const drainPromise = beginJsonWriterDrain(root);
    child.stdin!.write("w");
    await nextLine("MUTATION_DONE");
    const drainState = await drainPromise;
    assert.equal(drainState, "draining");
    const exitResult = await Promise.race([
      exitEvent,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("writer child exit timed out")), 15_000)),
    ]);
    assert.equal(exitResult[0], 0, Buffer.concat(stderrChunks).toString("utf8"));
    stdout.close();
    assert.equal(managerStore.readStatus(task.task_id).status, "cancelled");

    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;
    const sealed = await sealJsonWriterRoot(root, managerStore, probe);
    assert.equal(sealed.sealed, true, JSON.stringify(sealed.blockers));
    assert.equal(sealed.state, "sealed");
    assert.throws(() => new TaskStore(root, { writerQuiescence: true }).writeStatus(task.task_id, { error: "late" }), /fence is sealed/);
    assert.equal(managerStore.readStatus(task.task_id).error, undefined);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit").catch(() => undefined);
    }
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("FailureFacts mutation and seal serialize across processes", async () => {
  const root = await makeTempDir("json-writer-write-drain-order");
  let child: ReturnType<typeof spawn> | undefined;
  let sealer: ReturnType<typeof spawn> | undefined;
  let managerLease: string | undefined;
  let releaseStateLock: (() => void) | null = null;
  try {
    const legacyStore = new TaskStore(root);
    const task = makeTask({ task_id: "write_drain_order" });
    legacyStore.createTask(task, new Date().toISOString());
    legacyStore.writeStatus(task.task_id, { status: "running", started_at: new Date().toISOString() });

    const probe = processProbe();
    managerLease = await registerManagerJsonWriter(root, await probe.selfIdentity());
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    const workerLease = registerPendingWorkerJsonWriter(root, task.task_id, 1);
    assert.ok(workerLease);

    const probeUrl = new URL("../src/runtime/process-probe.js", import.meta.url).href;
    const fenceUrl = new URL("../src/store/json-writer-quiescence.js", import.meta.url).href;
    const storeUrl = new URL("../src/store/task-store.js", import.meta.url).href;
    const workerSource = [
      `import { createPlatformProbe } from ${JSON.stringify(probeUrl)};`,
      `import { activateWorkerJsonWriter, releaseWorkerJsonWriter } from ${JSON.stringify(fenceUrl)};`,
      `import { TaskStore } from ${JSON.stringify(storeUrl)};`,
      `import { buildFailureFacts } from ${JSON.stringify(new URL("../src/diagnostics/failure-facts.js", import.meta.url).href)};`,
      `import { readSync } from 'node:fs';`,
      "const [dataRoot, taskId, token] = process.argv.slice(1);",
      "const identity = await createPlatformProbe().selfIdentity();",
      "await activateWorkerJsonWriter(dataRoot, token, taskId, 1, identity);",
      "const store = new TaskStore(dataRoot, { writerQuiescence: true, writerLeaseToken: token });",
      "console.log('READY');",
      "const input = Buffer.alloc(1); readSync(0, input, 0, 1, null);",
      "if (!store.claimWorkerExecution(taskId, 1)) throw new Error('claim failed');",
      "console.log('CLAIMED');",
      "readSync(0, input, 0, 1, null);",
      "const facts = buildFailureFacts({ source: 'turn_event', phase: 'turn_terminal', providerCode: 'insufficient_quota', accepted: 'yes' });",
      "if (store.writeFailureFacts(taskId, 1, process.pid, facts) !== 'written') throw new Error('failure facts not written');",
      "console.log('MUTATION_DONE');",
      "readSync(0, input, 0, 1, null);",
      "store.writeStatus(taskId, { status: 'cancelled', finished_at: new Date().toISOString() }, 1);",
      "await releaseWorkerJsonWriter(dataRoot, token);",
    ].join("\n");
    child = spawn(process.execPath, ["--input-type=module", "-e", workerSource, root, task.task_id, workerLease], {
      cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    assert.ok(child.pid);
    bindPendingWorkerJsonWriter(root, workerLease, child.pid);
    const workerIdentity = await probe.identityOf(child.pid);
    assert.ok(workerIdentity, 'Manager OS probe must observe the child identity before sealing');
    managerStore.writeExecutorIdentity(task.task_id, 1, { worker: workerIdentity as unknown as Record<string, unknown> });
    managerStore.writeStatus(task.task_id, { worker_pid: child.pid, status: "running" }, 1);
    const stdout = createInterface({ input: child.stdout! });
    const stderrChunks: Buffer[] = [];
    child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    const nextLine = async (expected: string): Promise<void> => {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`expected ${expected} handshake timed out`)), 15_000);
        stdout.once("line", (value) => { clearTimeout(timer); resolve(value); });
        child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`child exited before ${expected}: ${code}; ${Buffer.concat(stderrChunks).toString("utf8")}`)); });
      });
      assert.equal(line, expected);
    };
    await nextLine("READY");
    child.stdin!.write("c");
    await nextLine("CLAIMED");
    assert.equal(await beginJsonWriterDrain(root), "draining");
    releaseStateLock = tryAcquireProcessLock(path.join(root, ".tasks", task.task_id, "state.lock"));
    assert.ok(releaseStateLock, "test must own state lock before competing write");
    child.stdin!.write("g");
    const gateOwnerPath = path.join(root, ".tasks", ".writer-quiescence.lock", "owner.json");
    let observedGateOwner = false;
    const gateDeadline = Date.now() + 8_000;
    while (Date.now() < gateDeadline) {
      try {
        const owner = JSON.parse(readFileSync(gateOwnerPath, "utf8")) as { pid?: number };
        if (owner.pid === child.pid) { observedGateOwner = true; break; }
      } catch { /* lock publication may still be in progress */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(observedGateOwner, "FailureFacts write must hold the cross-process writer gate while waiting for state.lock");
    const exitEvent = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

    // Observe the actual acquisition attempt inside the separate Seal process.
    // The wrapper delegates to the real filesystem and emits only when the
    // exact writer gate is found occupied during Seal's lock acquisition.
    const sealerSource = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "const [dataRoot, lease] = process.argv.slice(1);",
      "const gate = path.join(dataRoot, '.tasks', '.writer-quiescence.lock');",
      "const realExists = fs.existsSync; let armed = false; let observed = false;",
      "fs.existsSync = function(p) { const present = realExists(p); if (armed && !observed && p === gate && present) { observed = true; console.log('GATE_CONTENDED'); } return present; };",
      "syncBuiltinESMExports();",
      `const { sealJsonWriterRoot } = await import(${JSON.stringify(fenceUrl)});`,
      `const { TaskStore } = await import(${JSON.stringify(storeUrl)});`,
      `const { createPlatformProbe } = await import(${JSON.stringify(probeUrl)});`,
      "armed = true;",
      "const result = await sealJsonWriterRoot(dataRoot, new TaskStore(dataRoot, { writerQuiescence: true, writerLeaseToken: lease }), createPlatformProbe({ timeoutMs: 5000 }));",
      "if (!observed) throw new Error('seal did not observe occupied writer gate');",
      "console.log('SEAL_RESULT ' + JSON.stringify(result));",
    ].join("\n");
    sealer = spawn(process.execPath, ["--input-type=module", "-e", sealerSource, root, managerLease], {
      cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const sealerStderr: Buffer[] = [];
    sealer.stderr!.on("data", (chunk: Buffer) => sealerStderr.push(chunk));
    const sealLines = createInterface({ input: sealer.stdout! });
    const sealIterator = sealLines[Symbol.asyncIterator]();
    const sealExit = once(sealer, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    const firstSealLine = await Promise.race([
      sealIterator.next(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("seal contention observation timed out")), 15_000)),
    ]);
    assert.equal(firstSealLine.value, "GATE_CONTENDED", "Seal must attempt the gate while FailureFacts still owns it");
    assert.equal(JSON.parse(readFileSync(gateOwnerPath, "utf8")).pid, child.pid, "writer still holds gate at observed contention");
    releaseStateLock();
    releaseStateLock = null;
    await nextLine("MUTATION_DONE");
    const resultLine = await sealIterator.next();
    assert.match(String(resultLine.value), /^SEAL_RESULT /u);
    const competingSealResult = JSON.parse(String(resultLine.value).slice("SEAL_RESULT ".length)) as { sealed: boolean };
    assert.equal(competingSealResult.sealed, false, "a live Worker must block Seal");
    const sealerExitResult = await sealExit;
    assert.equal(sealerExitResult[0], 0, Buffer.concat(sealerStderr).toString("utf8"));
    sealLines.close();
    child.stdin!.write("x");
    const exitResult = await Promise.race([
      exitEvent,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("writer child exit timed out")), 15_000)),
    ]);
    assert.equal(exitResult[0], 0, Buffer.concat(stderrChunks).toString("utf8"));
    stdout.close();
    assert.equal(managerStore.readStatus(task.task_id).status, "cancelled");
    assert.ok(managerStore.readFailureFacts(task.task_id, 1).facts, "the pre-drain FailureFacts write must be durable");

    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;
    const sealed = await sealJsonWriterRoot(root, managerStore, probe);
    assert.equal(sealed.sealed, true, JSON.stringify(sealed.blockers));
    assert.equal(sealed.state, "sealed");
    assert.throws(() => new TaskStore(root, { writerQuiescence: true }).writeStatus(task.task_id, { error: "late" }), /fence is sealed/);
    assert.throws(() => new TaskStore(root, { writerQuiescence: true }).writeFailureFacts(task.task_id, 1, child!.pid!, buildFailureFacts({ source: "turn_event", phase: "turn_terminal", providerCode: "insufficient_quota", accepted: "yes" })), /fence is sealed/);
    assert.equal(managerStore.readStatus(task.task_id).error, undefined);
  } finally {
    if (releaseStateLock) releaseStateLock();
    if (sealer && sealer.exitCode === null && sealer.signalCode === null) {
      sealer.kill();
      await once(sealer, "exit").catch(() => undefined);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit").catch(() => undefined);
    }
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("recovery does not respawn a never-started Worker after JSON drain begins", async () => {
  const root = await makeTempDir("json-writer-drain-no-recovery-spawn");
  let managerLease: string | undefined;
  let manager: BridgeTaskManager | undefined;
  try {
    const legacyStore = new TaskStore(root);
    const task = makeTask({ task_id: "drain_no_respawn" });
    legacyStore.createTask(task, new Date().toISOString());
    legacyStore.writeStatus(task.task_id, {
      status: "running",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      worker_pid: 2_000_000_000,
    });

    const realProbe = processProbe();
    managerLease = await registerManagerJsonWriter(root, await realProbe.selfIdentity());
    const store = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    const exitedProbe: ProcessProbe = {
      platform: process.platform,
      selfIdentity: () => realProbe.selfIdentity(),
      identityOf: (pid: number) => realProbe.identityOf(pid),
      probe: async (requests) => requests.map(() => ({
        state: "exited" as const,
        reason_code: "pid_absent",
        observed_at: new Date().toISOString(),
      })),
    };
    let spawnCount = 0;
    manager = new BridgeTaskManager({
      store,
      workspaceProvider: new DirectWorkspaceProvider(),
      pollIntervalMs: 0,
      workerStartGraceMs: 0,
      probe: exitedProbe,
      spawnWorker: () => { spawnCount += 1; return { pid: 12345 }; },
    });

    await manager.beginWriterQuiescence();
    await manager.recoverTasks();

    assert.equal(spawnCount, 0, "recovery dispatch must stop after CLOSING/DRAINING");
    assert.equal(store.readStatus(task.task_id).status, "failed");
    assert.equal(store.readStatus(task.task_id).error_code, "worker_lost");
    assert.equal(store.respawnClaimedAt(task.task_id, 1), null, "drain must not consume a respawn claim");
    assert.equal(store.readEvents(task.task_id).events.some((event) => event.type === "worker_respawned"), false);
  } finally {
    if (manager) await manager.shutdown();
    else if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});

test("open-fence recovery respawn registers and binds its Worker lease", async () => {
  const root = await makeTempDir("json-writer-open-recovery-roster");
  let managerLease: string | undefined;
  let manager: BridgeTaskManager | undefined;
  try {
    const legacyStore = new TaskStore(root);
    const task = makeTask({ task_id: "open_recovery_roster" });
    legacyStore.createTask(task, new Date().toISOString());
    legacyStore.writeStatus(task.task_id, {
      status: "running",
      started_at: new Date(Date.now() - 60_000).toISOString(),
      worker_pid: 2_000_000_000,
    });

    const realProbe = processProbe();
    managerLease = await registerManagerJsonWriter(root, await realProbe.selfIdentity());
    const store = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    const exitedProbe: ProcessProbe = {
      platform: process.platform,
      selfIdentity: () => realProbe.selfIdentity(),
      identityOf: (pid: number) => realProbe.identityOf(pid),
      probe: async (requests) => requests.map(() => ({
        state: "exited" as const,
        reason_code: "pid_absent",
        observed_at: new Date().toISOString(),
      })),
    };
    let spawnedLease: string | undefined;
    manager = new BridgeTaskManager({
      store,
      workspaceProvider: new DirectWorkspaceProvider(),
      pollIntervalMs: 0,
      workerStartGraceMs: 0,
      probe: exitedProbe,
      spawnWorker: (_dataRoot, _taskId, _attempt, lease) => {
        spawnedLease = lease;
        return { pid: process.pid };
      },
    });

    await manager.recoverTasks();

    assert.ok(spawnedLease, "recovery respawn must receive a durable lease token");
    const leaseFile = path.join(root, ".tasks", ".writer-roster", `${spawnedLease}.json`);
    assert.equal(existsSync(leaseFile), true);
    const lease = JSON.parse(readFileSync(leaseFile, "utf8")) as {
      schema_version: number; token: string; kind: string; pid: number; identity: unknown;
      task_id: string; attempt: number; created_at: string;
    };
    assert.equal(lease.schema_version, 1);
    assert.equal(lease.token, spawnedLease);
    assert.equal(lease.kind, "worker");
    assert.equal(lease.pid, process.pid);
    assert.equal(lease.identity, null);
    assert.equal(lease.task_id, task.task_id);
    assert.equal(lease.attempt, 1);
    assert.ok(Number.isFinite(Date.parse(lease.created_at)));
    assert.equal(store.readStatus(task.task_id).worker_pid, process.pid);
    assert.equal(store.readStatus(task.task_id).status, "running");
  } finally {
    if (manager) await manager.shutdown();
    else if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});


test("worker identity evidence persists through a delayed probe and seal confirms exit from exact identity", { timeout: 20_000 }, async () => {
  const root = await makeTempDir("json-writer-delayed-identity-seal");
  let child: ReturnType<typeof spawn> | undefined;
  let managerLease: string | undefined;
  try {
    const initial = new TaskStore(root);
    const task = makeTask({ task_id: "delayed_identity_seal" });
    initial.createTask(task, new Date().toISOString());
    initial.writeStatus(task.task_id, { status: "running", started_at: new Date().toISOString() });

    const probe = processProbe();
    managerLease = await registerManagerJsonWriter(root, null);
    const managerStore = new TaskStore(root, { writerQuiescence: true, writerLeaseToken: managerLease });
    const workerLease = registerPendingWorkerJsonWriter(root, task.task_id, 1);
    assert.ok(workerLease);

    // Same worker source as the seal test, but with an injected 2.5s identity
    // probe: slower than the old 2s reap budget, inside the 5s contract.
    const probeUrl = new URL("../src/runtime/process-probe.js", import.meta.url).href;
    const storeUrl = new URL("../src/store/task-store.js", import.meta.url).href;
    const fenceUrl = new URL("../src/store/json-writer-quiescence.js", import.meta.url).href;
    const workerSource = [
      "const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });",
      `import { createPlatformProbe } from ${JSON.stringify(probeUrl)};`,
      `import { activateWorkerJsonWriter, releaseWorkerJsonWriter } from ${JSON.stringify(fenceUrl)};`,
      `import { TaskStore } from ${JSON.stringify(storeUrl)};`,
      "const [dataRoot, taskId, token] = process.argv.slice(1);",
      "const probe = createPlatformProbe();",
      "const identityPromise = probe.selfIdentity();",
      "await sleep(2500);",
      "const identity = await identityPromise;",
      "await activateWorkerJsonWriter(dataRoot, token, taskId, 1, identity);",
      "const scopedStore = new TaskStore(dataRoot, { writerQuiescence: true, writerLeaseToken: token });",
      "scopedStore.writeStatus(taskId, { worker_pid: process.pid, status: 'completed', finished_at: new Date().toISOString() }, 1);",
      "await releaseWorkerJsonWriter(dataRoot, token);",
      "console.log('IDENTITY_DELAYED_DONE');",
    ].join("\n");
    child = spawn(process.execPath, ["--input-type=module", "-e", workerSource, root, task.task_id, workerLease], {
      cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    assert.ok(child.pid);
    bindPendingWorkerJsonWriter(root, workerLease, child.pid);
    const workerIdentity = await probe.identityOf(child.pid);
    assert.ok(workerIdentity, "Manager OS probe must observe the child identity");
    managerStore.writeExecutorIdentity(task.task_id, 1, { worker: workerIdentity as unknown as Record<string, unknown> });
    managerStore.writeStatus(task.task_id, { worker_pid: child.pid, status: "running" }, 1);
    const stdout = createInterface({ input: child.stdout! });
    const stderrChunks: Buffer[] = [];
    child.stderr!.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Delayed-identity worker timed out; ${Buffer.concat(stderrChunks).toString("utf8")}`)), 15_000);
      stdout.once("line", (line) => {
        clearTimeout(timer);
        if (line.trim() === "IDENTITY_DELAYED_DONE") resolve();
        else reject(new Error(`Unexpected worker output: ${line}`));
      });
      child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Worker exited early: ${code}; ${Buffer.concat(stderrChunks).toString("utf8")}`)); });
    });
    await once(child, "exit");
    child = undefined;

    await releaseManagerJsonWriter(root, managerLease);
    managerLease = undefined;
    await beginJsonWriterDrain(root);
    const seal = await sealJsonWriterRoot(root, managerStore, probe);
    assert.equal(seal.sealed, true, JSON.stringify(seal.blockers));
    assert.equal(seal.state, "sealed");
  } finally {
    if (managerLease) await releaseManagerJsonWriter(root, managerLease).catch(() => undefined);
    await removeTempDir(root);
  }
});
