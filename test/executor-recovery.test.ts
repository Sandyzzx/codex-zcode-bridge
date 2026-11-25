import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlatformProbe, PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe, type ProbeVerdict } from "../src/runtime/process-probe.js";
import {
  acquireExecutorLease,
  EXECUTOR_LEASE_CLEARED_FILE,
  EXECUTOR_LEASE_FILE,
  EXECUTOR_LEASE_RELEASED_FILE,
  type ExecutorLeaseRecord,
} from "../src/executor/lease.js";
import {
  createExecutorRecoveryCoordinator,
  ExecutorRecoveryError,
  inspectExecutorWorkerSafety,
} from "../src/executor/recovery.js";
import { ExecutorControlClient } from "../src/executor/control-client.js";
import { executorPipeName } from "../src/executor/pipe.js";
import { digest, IsolatedAdmissionStore } from "../src/sqlite-candidate/wp6b2b1/store.mjs";
import { FRESH_SQLITE_DATABASE_FILE } from "../src/runtime/sqlite-install-config.js";

function identity(pid: number, fingerprint: string): ProcessIdentity {
  return {
    pid,
    fingerprint,
    fingerprint_precision: "exact",
    identity_version: PROCESS_IDENTITY_VERSION,
    platform: process.platform,
    captured_at: new Date().toISOString(),
  };
}

function probeWith(verdict: ProbeVerdict, expectedPid = 999_999): ProcessProbe {
  return {
    platform: process.platform,
    identityOf: async (pid) => identity(pid, verdict.state === "alive" ? "live" : "dead"),
    selfIdentity: async () => identity(process.pid, "self"),
    probe: async (requests) => requests.map((request) => request.pid === expectedPid
      ? verdict
      : { state: "exited", reason_code: "pid_absent", observed_at: new Date().toISOString() }),
  };
}

const ALIVE: ProbeVerdict = {
  state: "alive",
  reason_code: "pid_and_fingerprint_match",
  observed_at: new Date().toISOString(),
};
const EXITED: ProbeVerdict = {
  state: "exited",
  reason_code: "pid_absent",
  observed_at: new Date().toISOString(),
};
const REUSED = {
  ...EXITED,
  reason_code: "pid_reused",
} as const;
const UNKNOWN: ProbeVerdict = {
  state: "unknown",
  reason_code: "probe_failed",
  observed_at: new Date().toISOString(),
};

function recoveryOptions(root: string, overrides: Partial<Parameters<typeof createExecutorRecoveryCoordinator>[0]> = {}) {
  return {
    dataRoot: root,
    settingsDirectory: path.join(root, "settings"),
    bridgeEntryPath: path.join(root, "bridge.mjs"),
    startupTimeoutMs: 500,
    lockTimeoutMs: 5_000,
    ...overrides,
  };
}

interface SyntheticExecutorProcess {
  readonly child: ChildProcess;
  readonly exit: Promise<void>;
  readonly stderr: () => string;
}

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");
const TEST_EXECUTOR_ENTRY = path.join(PROJECT_ROOT, "dist-test", "test", "fixtures", "executor-test-main.js");
const TEST_BRIDGE_ENTRY = path.join(PROJECT_ROOT, "dist-test", "src", "mcp", "main.js");
const TEST_WORKER_ENTRY = path.join(PROJECT_ROOT, "dist-test", "src", "worker", "worker-main.js");
const RECOVERY_CHILD_ENTRY = path.join(PROJECT_ROOT, "dist-test", "test", "fixtures", "executor-recovery-child.js");

function startSyntheticExecutor(root: string, settingsDirectory: string): SyntheticExecutorProcess {
  const child = spawn(process.execPath, [
    TEST_EXECUTOR_ENTRY,
    "--data-root", root,
    "--bridge-entry", TEST_BRIDGE_ENTRY,
    "--worker-entry", TEST_WORKER_ENTRY,
    "--settings-directory", settingsDirectory,
    "--heartbeat-ms", "100",
    "--test-only-fake-adapter",
  ], {
    cwd: PROJECT_ROOT,
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout?.resume();
  const exit = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  return { child, exit, stderr: () => stderr };
}

async function shutdownSyntheticExecutor(root: string): Promise<void> {
  const client = new ExecutorControlClient({ pipeName: executorPipeName(root), connectTimeoutMs: 2_000 });
  try {
    await client.connect();
    const response = await client.request("shutdown", {});
    assert.equal(response.ok, true);
  } finally {
    client.close();
  }
}

test("concurrent Host requests coalesce to one Executor spawn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-concurrent-"));
  let ready = false;
  let spawns = 0;
  try {
    const coordinator = createExecutorRecoveryCoordinator(recoveryOptions(root, {
      dependencies: {
        probeStatus: async () => ready ? { lease_id: "new-lease" } : null,
        spawnExecutor: () => {
          spawns += 1;
          ready = true;
          return { pid: 42_000 };
        },
        sleep: async () => undefined,
      },
    }));
    const [left, right] = await Promise.all([coordinator.ensureRunning(), coordinator.ensureRunning()]);
    assert.equal(spawns, 1);
    assert.equal(left.status, "started");
    assert.equal(right.status, "started");
    assert.equal(left.lease_id, "new-lease");
    assert.equal(right.lease_id, "new-lease");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two independent processes sharing a root serialize recovery and spawn once", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-cross-process-"));
  const settingsDirectory = path.join(root, "settings");
  mkdirSync(settingsDirectory, { recursive: true });
  const run = () => new Promise<{ child: ChildProcess; result: Record<string, unknown>; stderr: () => string }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      RECOVERY_CHILD_ENTRY,
      root,
      settingsDirectory,
    ], {
      cwd: PROJECT_ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`recovery child exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve({
          child,
          result: JSON.parse(stdout.trim()) as Record<string, unknown>,
          stderr: () => stderr,
        });
      } catch (error) {
        reject(new Error(`recovery child returned invalid output: ${stdout}`, { cause: error }));
      }
    });
  });
  try {
    const children = await Promise.all([run(), run()]);
    assert.deepEqual(children.map(({ result }) => result.status).sort(), ["already_running", "started"]);
    assert.deepEqual(children.map(({ result }) => result.lease_id), ["cross-process-lease", "cross-process-lease"]);
    const spawnRecords = readFileSync(path.join(root, "recovery-child-spawns.txt"), "utf8")
      .trim().split(/\r?\n/u).filter(Boolean);
    assert.equal(spawnRecords.length, 1);
    assert.match(children.map(({ stderr }) => stderr()).join("\n"), /EXECUTOR_START_RECOVERED/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a proven-exited Lease is archived exactly once before startup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-stale-"));
  try {
    const lease = await acquireExecutorLease({
      authorityRoot: root,
      ownerKind: "executor",
      processProbe: probeWith(EXITED),
      identity: identity(999_999, "dead-owner"),
      bridgeSha256: "a".repeat(64),
      workerSha256: "b".repeat(64),
      pipeName: "test-pipe",
    });
    let ready = false;
    let spawns = 0;
    const coordinator = createExecutorRecoveryCoordinator(recoveryOptions(root, {
      processProbe: probeWith(EXITED),
      dependencies: {
        probeStatus: async () => ready ? { lease_id: "replacement-lease" } : null,
        inspectWorkerSafety: async () => ({ safe: true, blockers: [] }),
        spawnExecutor: () => {
          spawns += 1;
          ready = true;
          return { pid: 42_001 };
        },
      },
    }));
    const result = await coordinator.ensureRunning();
    assert.equal(result.status, "recovered");
    assert.equal(result.archived_lease_id, lease.lease.lease_id);
    assert.equal(result.lease_id, "replacement-lease");
    assert.equal(spawns, 1);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), false);
    assert.equal(existsSync(path.join(root, `${EXECUTOR_LEASE_CLEARED_FILE}.${lease.lease.lease_id}`)), true);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_RELEASED_FILE)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reused PID is archived only after exact identity mismatch proves the old owner exited", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-reused-pid-"));
  try {
    const lease = await acquireExecutorLease({
      authorityRoot: root,
      ownerKind: "executor",
      processProbe: probeWith(EXITED),
      identity: identity(999_999, "previous-owner"),
      bridgeSha256: "a".repeat(64),
      workerSha256: "b".repeat(64),
      pipeName: "test-pipe",
    });
    let ready = false;
    const coordinator = createExecutorRecoveryCoordinator(recoveryOptions(root, {
      processProbe: probeWith(REUSED),
      dependencies: {
        probeStatus: async () => ready ? { lease_id: "reused-pid-replacement" } : null,
        inspectWorkerSafety: async () => ({ safe: true, blockers: [] }),
        spawnExecutor: () => {
          ready = true;
          return { pid: 42_011 };
        },
      },
    }));
    const result = await coordinator.ensureRunning();
    assert.equal(result.status, "recovered");
    assert.equal(result.archived_lease_id, lease.lease.lease_id);
    assert.equal(existsSync(path.join(root, `${EXECUTOR_LEASE_CLEARED_FILE}.${lease.lease.lease_id}`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unverifiable owner blocks archival and startup", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-owner-unknown-"));
  let spawns = 0;
  try {
    const lease = await acquireExecutorLease({
      authorityRoot: root,
      ownerKind: "executor",
      processProbe: probeWith(EXITED),
      identity: identity(999_999, "unknown-owner"),
      bridgeSha256: "a".repeat(64),
      workerSha256: "b".repeat(64),
      pipeName: "test-pipe",
    });
    const coordinator = createExecutorRecoveryCoordinator(recoveryOptions(root, {
      processProbe: probeWith(UNKNOWN),
      dependencies: {
        probeStatus: async () => null,
        spawnExecutor: () => {
          spawns += 1;
          return { pid: 42_012 };
        },
      },
    }));
    await assert.rejects(() => coordinator.ensureRunning(), (error: unknown) =>
      error instanceof ExecutorRecoveryError && error.code === "EXECUTOR_RECOVERY_OWNER_UNKNOWN");
    assert.equal(spawns, 0);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), true);
    assert.equal(existsSync(path.join(root, `${EXECUTOR_LEASE_CLEARED_FILE}.${lease.lease.lease_id}`)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovery remains fail-closed when archival has an unknown outcome, then resumes on the next request", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-archive-race-"));
  try {
    const lease = await acquireExecutorLease({
      authorityRoot: root,
      ownerKind: "executor",
      processProbe: probeWith(EXITED),
      identity: identity(999_999, "archive-race-owner"),
      bridgeSha256: "a".repeat(64),
      workerSha256: "b".repeat(64),
      pipeName: "test-pipe",
    });
    const leaseFile = path.join(root, EXECUTOR_LEASE_FILE);
    const archiveFile = path.join(root, `${EXECUTOR_LEASE_CLEARED_FILE}.${lease.lease.lease_id}`);
    let ready = false;
    const first = createExecutorRecoveryCoordinator(recoveryOptions(root, {
      processProbe: probeWith(EXITED),
      dependencies: {
        probeStatus: async () => null,
        inspectWorkerSafety: async () => ({ safe: true, blockers: [] }),
        clearLease: async (dataRoot) => {
          const record = JSON.parse(readFileSync(leaseFile, "utf8")) as ExecutorLeaseRecord;
          renameSync(leaseFile, path.join(dataRoot, `${EXECUTOR_LEASE_CLEARED_FILE}.${record.lease_id}`));
          throw new Error("simulated Executor crash after archive rename");
        },
        spawnExecutor: () => {
          throw new Error("must not spawn while archival outcome is unknown");
        },
      },
    }));
    await assert.rejects(() => first.ensureRunning(), (error: unknown) =>
      error instanceof ExecutorRecoveryError && error.code === "EXECUTOR_RECOVERY_BLOCKED");
    assert.equal(existsSync(leaseFile), false);
    assert.equal(existsSync(archiveFile), true);

    const second = createExecutorRecoveryCoordinator(recoveryOptions(root, {
      processProbe: probeWith(EXITED),
      dependencies: {
        probeStatus: async () => ready ? { lease_id: "post-archive-lease" } : null,
        inspectWorkerSafety: async () => ({ safe: true, blockers: [] }),
        spawnExecutor: () => {
          ready = true;
          return { pid: 42_013 };
        },
      },
    }));
    const recovered = await second.ensureRunning();
    assert.equal(recovered.status, "started");
    assert.equal(recovered.lease_id, "post-archive-lease");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live but temporarily unreachable owner is never archived or duplicated", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-live-"));
  let spawns = 0;
  try {
    await acquireExecutorLease({
      authorityRoot: root,
      ownerKind: "executor",
      processProbe: probeWith(ALIVE, process.pid),
      identity: identity(process.pid, "self"),
      bridgeSha256: "a".repeat(64),
      workerSha256: "b".repeat(64),
      pipeName: "test-pipe",
    });
    const coordinator = createExecutorRecoveryCoordinator(recoveryOptions(root, {
      startupTimeoutMs: 100,
      processProbe: probeWith(ALIVE, process.pid),
      dependencies: {
        probeStatus: async () => null,
        spawnExecutor: () => {
          spawns += 1;
          return { pid: 42_002 };
        },
        sleep: async () => undefined,
      },
    }));
    await assert.rejects(() => coordinator.ensureRunning(), (error: unknown) =>
      error instanceof ExecutorRecoveryError && error.code === "EXECUTOR_START_TIMEOUT");
    assert.equal(spawns, 0);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live or unknown Worker keeps the old Lease and blocks restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-worker-"));
  let cleared = 0;
  let spawns = 0;
  try {
    await acquireExecutorLease({
      authorityRoot: root,
      ownerKind: "executor",
      processProbe: probeWith(EXITED),
      identity: identity(999_999, "dead-owner"),
      bridgeSha256: "a".repeat(64),
      workerSha256: "b".repeat(64),
      pipeName: "test-pipe",
    });
    const coordinator = createExecutorRecoveryCoordinator(recoveryOptions(root, {
      processProbe: probeWith(EXITED),
      dependencies: {
        probeStatus: async () => null,
        inspectWorkerSafety: async () => ({
          safe: false,
          blockers: ["worker_still_alive:task-1/1"],
        }),
        clearLease: async () => {
          cleared += 1;
          throw new Error("must not clear");
        },
        spawnExecutor: () => {
          spawns += 1;
          return { pid: 42_003 };
        },
      },
    }));
    await assert.rejects(() => coordinator.ensureRunning(), (error: unknown) =>
      error instanceof ExecutorRecoveryError
      && error.code === "EXECUTOR_RECOVERY_WORKER_ACTIVE"
      && error.blockers.includes("worker_still_alive:task-1/1"));
    assert.equal(cleared, 0);
    assert.equal(spawns, 0);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function initializeAuthority(root: string, label: string) {
  const workspace = path.join(root, `workspace-${label}`);
  mkdirSync(workspace, { recursive: true });
  const store = IsolatedAdmissionStore.initialize(root, {
    databaseFileName: FRESH_SQLITE_DATABASE_FILE,
    managedDataDirectory: true,
    freshInstallReceiptId: `fresh-${label}`,
    verifierVersion: "executor-recovery-test-v1",
    freshInstallCapacityLimit: 2,
  });
  const taskId = `task-${label}`;
  store.createTask({
    task_id: taskId,
    workspace,
    objective: "test Executor recovery Worker safety",
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
  });
  const operationId = `operation-${label}`;
  const admitted = store.admitOperation({
    operation_id: operationId,
    task_id: taskId,
    attempt: 1,
    workspace_ref: workspace,
  }, {
    workspaceValidator: () => ({ state: "allow", fixture: true }),
    executionPermissionCheck: () => ({ state: "allow", fixture: true }),
  });
  const launch = {
    operation_id: operationId,
    task_id: taskId,
    attempt: 1,
    generation: admitted.generation,
    revision: admitted.revision,
    launch_id: `launch-${label}`,
    launch_epoch: 1,
    launch_token: `executor-recovery-token-${label}-0123456789`,
  };
  return { store, workspace, taskId, operationId, launch };
}

test("a launch intent without a receipt blocks automatic restart", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-launch-unknown-"));
  try {
    const fixture = initializeAuthority(root, "unknown");
    try {
      fixture.store.createLaunchIntent(fixture.launch);
    } finally {
      fixture.store.close();
    }
    const result = await inspectExecutorWorkerSafety(root);
    assert.equal(result.safe, false);
    assert.ok(result.blockers.some((blocker) => blocker.startsWith("launch_outcome_unknown:")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Worker safety inspection reads a concurrent open Authority without changing its state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-open-authority-"));
  try {
    const fixture = initializeAuthority(root, "open");
    try {
      const result = await inspectExecutorWorkerSafety(root);
      assert.deepEqual(result, { safe: true, blockers: [] });
      assert.equal(fixture.store.readTaskProjection(fixture.taskId).current_attempt, 1);
      assert.equal(fixture.store.readOperation(fixture.operationId).phase, "reserved");
    } finally {
      fixture.store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Executor normal and crash exits recover the same Authority without a second Worker spawn", {
  skip: process.platform !== "win32",
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-real-process-"));
  const settingsDirectory = `${root}-settings`;
  mkdirSync(settingsDirectory, { recursive: true });
  const processes: SyntheticExecutorProcess[] = [];
  try {
    const coordinator = createExecutorRecoveryCoordinator(recoveryOptions(root, {
      settingsDirectory,
      startupTimeoutMs: 45_000,
      lockTimeoutMs: 15_000,
      dependencies: {
        spawnExecutor: () => {
          const child = startSyntheticExecutor(root, settingsDirectory);
          processes.push(child);
          return { pid: child.child.pid };
        },
      },
    }));

    const first = await coordinator.ensureRunning().catch((error: unknown) => {
      const diagnostics = processes.map((child) => child.stderr()).join("\n");
      throw new Error(`real Executor failed to become recoverable: ${diagnostics}`, { cause: error });
    });
    assert.equal(first.status, "started");
    assert.equal(processes.length, 1);
    await shutdownSyntheticExecutor(root);
    await processes[0]!.exit;
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), false);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_RELEASED_FILE)), true);

    const afterCleanExit = await coordinator.ensureRunning();
    assert.equal(afterCleanExit.status, "started");
    assert.equal(processes.length, 2);
    processes[1]!.child.kill("SIGKILL");
    await processes[1]!.exit;
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), true);

    const afterCrash = await coordinator.ensureRunning();
    assert.equal(afterCrash.status, "recovered");
    assert.equal(processes.length, 3);
    assert.notEqual(afterCrash.lease_id, afterCleanExit.lease_id);
    assert.equal(existsSync(path.join(root, `${EXECUTOR_LEASE_CLEARED_FILE}.${afterCleanExit.lease_id}`)), true);
    await shutdownSyntheticExecutor(root);
    await processes[2]!.exit;
  } finally {
    for (const child of processes) {
      if (child.child.exitCode === null && child.child.signalCode === null) {
        child.child.kill("SIGKILL");
      }
    }
    await Promise.allSettled(processes.map((child) => child.exit));
    rmSync(root, { recursive: true, force: true });
    rmSync(settingsDirectory, { recursive: true, force: true });
  }
});

test("a persisted exact live Worker blocks automatic restart", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-recovery-worker-live-"));
  try {
    const fixture = initializeAuthority(root, "live");
    const processProbe = createPlatformProbe();
    const current = await processProbe.selfIdentity();
    assert.ok(current.fingerprint && current.fingerprint_precision === "exact");
    const launchEvidence = {
      source: "manager_os_spawn_observation",
      fixture: false,
      launch_id: fixture.launch.launch_id,
      generation: fixture.launch.generation,
      process_id: current.pid,
      start_fingerprint: current.fingerprint,
      fingerprint_precision: "exact",
      identity_version: PROCESS_IDENTITY_VERSION,
      platform: process.platform,
      captured_at: current.captured_at,
    };
    const workerEvidence = {
      source: "manager_verified_process_probe",
      fixture: false,
      worker_id: `worker-${fixture.taskId}`,
      process_id: current.pid,
      start_fingerprint: current.fingerprint,
      fingerprint_precision: "exact",
      identity_version: PROCESS_IDENTITY_VERSION,
      platform: process.platform,
      captured_at: current.captured_at,
    };
    try {
      const intent = fixture.store.createLaunchIntent(fixture.launch);
      const receipt = fixture.store.recordLaunchReceipt({
        ...fixture.launch,
        revision: intent.revision,
        receipt_id: `receipt-${fixture.taskId}`,
        launch_identity: {
          ...launchEvidence,
          evidence_digest: digest(launchEvidence),
        },
      });
      fixture.store.commitPermanentClaim({
        ...fixture.launch,
        revision: receipt.revision,
        claim_id: `claim-${fixture.taskId}`,
        worker_identity: {
          ...workerEvidence,
          evidence_digest: digest(workerEvidence),
        },
      });
    } finally {
      fixture.store.close();
    }
    const result = await inspectExecutorWorkerSafety(root, processProbe);
    assert.equal(result.safe, false);
    assert.ok(result.blockers.some((blocker) => blocker.startsWith("worker_still_alive:")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
