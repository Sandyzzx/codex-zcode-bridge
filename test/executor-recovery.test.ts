import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlatformProbe, PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe, type ProbeVerdict } from "../src/runtime/process-probe.js";
import { fingerprintRuntimeArtifact } from "../src/runtime/build-provenance.js";
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
import {
  createLaunchBootstrap,
  deriveAdmissionPolicySnapshotDigest,
  encodeLaunchBootstrap,
} from "../src/sqlite-candidate/wp6b2b1/launch-bootstrap.js";
import { spawnClaimOnlyWorker, type ClaimOnlyWorkerProcess } from "../src/manager/spawn-worker.js";
import { loadLifecycleCandidateModules } from "../src/store/lifecycle-gate.js";
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
const RECOVERY_SERVICE_ENTRY = path.join(PROJECT_ROOT, "dist-test", "test", "fixtures", "executor-recovery-service.js");
const RECOVERY_WORKER_WRAPPER = path.join(PROJECT_ROOT, "dist-test", "test", "fixtures", "executor-recovery-worker-wrapper.js");
const THIN_MCP_ENTRY = path.join(PROJECT_ROOT, "dist-test", "src", "mcp", "main.js");

interface RecoveryServiceProcess {
  readonly child: ChildProcess;
  readonly ready: Promise<{ readonly lease_id: string; readonly pipe_name: string }>;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly stderr: () => string;
}

function startRecoveryService(root: string): RecoveryServiceProcess {
  const child = spawn(process.execPath, [
    RECOVERY_SERVICE_ENTRY,
    root,
    TEST_BRIDGE_ENTRY,
    TEST_WORKER_ENTRY,
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
  const ready = new Promise<{ lease_id: string; pipe_name: string }>((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const poll = (): void => {
      const match = /^EXECUTOR_READY (.+)$/mu.exec(stdout);
      if (match) {
        resolve(JSON.parse(match[1]!) as { lease_id: string; pipe_name: string });
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error(`recovery Executor exited before ready (${String(child.exitCode)}/${String(child.signalCode)}): ${stderr}`));
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`recovery Executor ready timeout: ${stderr}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, ready, exit, stderr: () => stderr };
}

async function waitForText(read: () => string, expected: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read().includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`TEXT_TIMEOUT ${expected}: ${read()}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`PROCESS_EXIT_TIMEOUT ${pid}`);
}

function readSingleLineFrame(stream: NodeJS.ReadableStream, maximum: number, label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), 15_000);
    const finish = (error?: Error, value?: Buffer): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      if (error) reject(error);
      else resolve(value!);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maximum) {
        finish(new Error(`${label} exceeded ${maximum} bytes`));
        return;
      }
      chunks.push(bytes);
      const frame = Buffer.concat(chunks, total);
      const newline = frame.indexOf(0x0a);
      if (newline >= 0) {
        if (newline !== frame.length - 1) {
          finish(new Error(`${label} contained trailing bytes`));
          return;
        }
        finish(undefined, frame);
      }
    };
    const onEnd = (): void => finish(new Error(`${label} closed before one complete frame`));
    const onError = (error: Error): void => finish(error);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function startThinMcp(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [THIN_MCP_ENTRY], {
    cwd: PROJECT_ROOT,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffered = "";
  const messages: Array<Record<string, unknown>> = [];
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      if (typeof message.id === "number") waiters.get(message.id)?.(message);
    }
  });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const waitForResponse = (id: number): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const observed = messages.find((message) => message.id === id);
    if (observed) {
      resolve(observed);
      return;
    }
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`THIN_MCP_RESPONSE_TIMEOUT ${id}\n${stderr}`));
    }, 20_000);
    waiters.set(id, (message) => {
      clearTimeout(timer);
      waiters.delete(id);
      resolve(message);
    });
  });
  return { child, exit, waitForResponse, stderr: () => stderr };
}

function readAuthoritySnapshot(root: string): Promise<{
  readonly operations: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly events: ReadonlyArray<Readonly<Record<string, unknown>>>;
}> {
  return loadLifecycleCandidateModules().then((modules) => {
    const store = modules.Store.openForRecovery(root, {
      databaseFileName: FRESH_SQLITE_DATABASE_FILE,
      managedDataDirectory: true,
    });
    assert.ok(store);
    try {
      return modules.createPort(store).readRecoverySnapshot() as {
        operations: ReadonlyArray<Readonly<Record<string, unknown>>>;
        events: ReadonlyArray<Readonly<Record<string, unknown>>>;
      };
    } finally {
      store.close();
    }
  });
}

function operationSnapshot(
  snapshot: Awaited<ReturnType<typeof readAuthoritySnapshot>>,
  operationId: string,
): Readonly<Record<string, unknown>> {
  const operation = snapshot.operations.find((item) => item.operation_id === operationId);
  assert.ok(operation);
  return {
    operation,
    events: snapshot.events.filter((event) => event.operation_id === operationId),
  };
}

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

async function startProductionWorkerClaim(
  fixture: ReturnType<typeof initializeAuthority>,
  settingsDirectory: string,
  wrapperPath: string,
  spawnLog: string,
): Promise<{
  readonly child: ClaimOnlyWorkerProcess;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly report: Readonly<Record<string, unknown>>;
  readonly stderr: () => string;
}> {
  const intent = fixture.store.createLaunchIntent(fixture.launch);
  const worker = fingerprintRuntimeArtifact(wrapperPath);
  assert.ok(worker.path && worker.sha256, "the Worker wrapper must be fingerprintable");
  const spawnDirectory = path.dirname(spawnLog);
  assert.equal(path.basename(spawnLog), "executor-recovery-worker-spawns.log");
  const previousTemp = process.env["TEMP"];
  const previousTmp = process.env["TMP"];
  let child: ClaimOnlyWorkerProcess;
  try {
    process.env["TEMP"] = spawnDirectory;
    process.env["TMP"] = spawnDirectory;
    child = spawnClaimOnlyWorker(wrapperPath, {
      bridge: { path: null, sha256: null },
      worker,
    }, { interactionChannel: true });
  } finally {
    if (previousTemp === undefined) delete process.env["TEMP"];
    else process.env["TEMP"] = previousTemp;
    if (previousTmp === undefined) delete process.env["TMP"];
    else process.env["TMP"] = previousTmp;
  }
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const policy = {
    operation_id: fixture.operationId,
    task_id: fixture.taskId,
    attempt: 1,
    generation: fixture.launch.generation,
    workspace_ref: fixture.workspace,
    authorization_source: "trusted_local_policy" as const,
    policy_revision: "executor-recovery-policy-v1",
    policy_digest: "b".repeat(64),
    execution_profile_id: "local-build-v1",
  };
  const policySnapshot = {
    ...policy,
    policy_snapshot_digest: deriveAdmissionPolicySnapshotDigest(policy),
  };
  assert.ok(child.bootstrapChannel);
  child.bootstrapChannel.end(encodeLaunchBootstrap(createLaunchBootstrap({
    ...fixture.launch,
    policy_snapshot: policySnapshot,
  })));
  assert.ok(child.reportChannel);
  const reportFrame = await readSingleLineFrame(child.reportChannel, 8_192, "Worker identity report");
  const report = JSON.parse(reportFrame.subarray(0, -1).toString("utf8")) as Record<string, unknown>;
  assert.equal(report.process_id, child.pid);
  assert.equal(typeof report.worker_id, "string");

  const processProbe = createPlatformProbe();
  const observed = await processProbe.identityOf(child.pid!);
  assert.ok(observed.fingerprint && observed.fingerprint_precision === "exact");
  assert.equal(report.start_fingerprint, observed.fingerprint);
  const launchEvidence = {
    source: "manager_os_spawn_observation",
    fixture: false,
    launch_id: fixture.launch.launch_id,
    generation: fixture.launch.generation,
    process_id: child.pid!,
    start_fingerprint: observed.fingerprint,
    fingerprint_precision: "exact",
    identity_version: PROCESS_IDENTITY_VERSION,
    platform: process.platform,
    captured_at: observed.captured_at,
  };
  const receipt = fixture.store.recordLaunchReceipt({
    ...fixture.launch,
    revision: intent.revision,
    receipt_id: `receipt-${fixture.taskId}`,
    launch_identity: {
      ...launchEvidence,
      evidence_digest: digest(launchEvidence),
    },
  });
  const workerEvidence = {
    source: "manager_verified_process_probe",
    fixture: false,
    worker_id: String(report.worker_id),
    process_id: child.pid!,
    start_fingerprint: observed.fingerprint,
    fingerprint_precision: "exact",
    identity_version: PROCESS_IDENTITY_VERSION,
    platform: process.platform,
    captured_at: observed.captured_at,
  };
  fixture.store.commitPermanentClaim({
    ...fixture.launch,
    revision: receipt.revision,
    claim_id: `claim-${fixture.taskId}`,
    worker_identity: {
      ...workerEvidence,
      evidence_digest: digest(workerEvidence),
    },
  });
  const execution = {
    protocol: "bridge-sqlite-execution-envelope-v1",
    operation_id: fixture.operationId,
    task_id: fixture.taskId,
    attempt: 1,
    generation: fixture.launch.generation,
    workspace_ref: fixture.workspace,
    policy_snapshot_digest: policySnapshot.policy_snapshot_digest,
    execution_profile_id: policy.execution_profile_id,
    adapter_mode: "test_fake",
    task: fixture.store.readTask(fixture.taskId),
    host_profile: { name: "executor-recovery-test", settingsDirectory },
    continuation: null,
    previous_result: null,
  };
  assert.ok(child.decisionChannel);
  child.decisionChannel.end(Buffer.from(`${JSON.stringify({
    protocol: "bridge-claim-decision-v1",
    state: "claim_committed",
    execution,
  })}\n`, "utf8"));
  await waitForText(() => stderr, "stage=worker bind read", 15_000);
  return { child, exit, report, stderr: () => stderr };
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

test("Thin MCP blocks recovery when an Executor crash leaves a real production Worker alive", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const fixtureBase = process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA)
    ? path.join(process.env.LOCALAPPDATA, "Temp")
    : tmpdir();
  mkdirSync(fixtureBase, { recursive: true });
  const fixture = mkdtempSync(path.join(fixtureBase, "executor-recovery-production-worker-"));
  const localAppData = path.join(fixture, "local-app-data");
  const userProfile = path.join(fixture, "user-profile");
  const tempDirectory = path.join(fixture, "temp");
  const root = path.join(localAppData, "CodexZCodeBridge", "state");
  const settingsDirectory = path.join(userProfile, ".codex", "codex-zcode-bridge");
  const spawnLog = path.join(fixture, "executor-recovery-worker-spawns.log");
  for (const directory of [root, settingsDirectory, tempDirectory]) mkdirSync(directory, { recursive: true });
  writeFileSync(spawnLog, "", "utf8");

  let authority: ReturnType<typeof initializeAuthority> | undefined;
  let service: RecoveryServiceProcess | undefined;
  let worker: Awaited<ReturnType<typeof startProductionWorkerClaim>> | undefined;
  let session: ReturnType<typeof startThinMcp> | undefined;
  let taskId: string | undefined;
  let operationId: string | undefined;
  const observedPids = new Set<number>();
  let succeeded = false;
  try {
    authority = initializeAuthority(root, "production-worker");
    taskId = authority.taskId;
    operationId = authority.operationId;
    service = startRecoveryService(root);
    const executorReady = await service.ready;
    assert.equal(executorReady.lease_id, JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8")).lease_id);
    observedPids.add(service.child.pid!);
    worker = await startProductionWorkerClaim(
      authority,
      settingsDirectory,
      RECOVERY_WORKER_WRAPPER,
      spawnLog,
    );
    const workerPid = worker.child.pid!;
    observedPids.add(workerPid);
    assert.match(worker.stderr(), /stage=worker bind read/u);
    assert.deepEqual(
      readFileSync(spawnLog, "utf8").trim().split(/\r?\n/u).filter(Boolean),
      [String(workerPid)],
    );

    authority.store.close();
    authority = undefined;
    service.child.kill("SIGKILL");
    assert.deepEqual(await service.exit, { code: null, signal: "SIGKILL" });
    const leaseFile = path.join(root, EXECUTOR_LEASE_FILE);
    assert.equal(existsSync(leaseFile), true);
    const crashedLeaseBytes = readFileSync(leaseFile);
    const crashedLease = JSON.parse(crashedLeaseBytes.toString("utf8")) as ExecutorLeaseRecord;
    assert.equal(crashedLease.owner.process_id, service.child.pid);
    const before = operationSnapshot(await readAuthoritySnapshot(root), operationId);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LOCALAPPDATA: localAppData,
      USERPROFILE: userProfile,
      HOME: userProfile,
      TEMP: tempDirectory,
      TMP: tempDirectory,
      TMPDIR: tempDirectory,
      ZCODE_BRIDGE_MCP_TRANSPORT: "control",
      ZCODE_BRIDGE_EXECUTOR_AUTO_RECOVER: "1",
      ZCODE_BRIDGE_TASK_CONSOLE: "off",
    };
    delete env.ZCODE_BRIDGE_DATA_DIR;
    delete env.ZCODE_BRIDGE_PLUGIN_MODE;
    delete env.ZCODE_DATA_BASE_DIR;
    delete env.ZCODE_WINDOWS_APP_INSTALL_DIR;
    session = startThinMcp(env);
    session.child.stdin!.write([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "executor-recovery-production-worker", version: "1" },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "",
    ].join("\n"));
    assert.ok((await session.waitForResponse(1)).result);
    session.child.stdin!.write([
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "zcode_status", arguments: { task_id: taskId } },
      }),
      "",
    ].join("\n"));
    const response = await session.waitForResponse(2) as {
      result?: {
        isError?: boolean;
        structuredContent?: { error?: { code?: string; message?: string } };
      };
    };
    assert.equal(response.result?.isError, true, session.stderr());
    assert.equal(response.result?.structuredContent?.error?.code, "EXECUTOR_RECOVERY_WORKER_ACTIVE");
    assert.match(
      response.result?.structuredContent?.error?.message ?? "",
      /worker_still_alive:task-production-worker\/1/u,
    );
    assert.doesNotMatch(session.stderr(), /EXECUTOR_START_RECOVERED/u);

    assert.doesNotThrow(() => process.kill(workerPid, 0), "the original Worker must still be alive");
    assert.deepEqual(readFileSync(leaseFile), crashedLeaseBytes);
    assert.equal(existsSync(path.join(settingsDirectory, "executor-recovery.lock")), false);
    assert.deepEqual(
      readFileSync(spawnLog, "utf8").trim().split(/\r?\n/u).filter(Boolean),
      [String(workerPid)],
    );
    const controlProbe = new ExecutorControlClient({
      pipeName: executorPipeName(root),
      connectTimeoutMs: 500,
    });
    try {
      await assert.rejects(
        () => controlProbe.connect(),
        (error: unknown) => (error as { readonly code?: unknown }).code === "EXECUTOR_UNAVAILABLE",
      );
    } finally {
      controlProbe.close();
    }
    const after = operationSnapshot(await readAuthoritySnapshot(root), operationId);
    assert.deepEqual(after, before);

    worker.child.kill("SIGKILL");
    const workerExit = await worker.exit;
    assert.equal(workerExit.signal, "SIGKILL");
    const safe = await inspectExecutorWorkerSafety(root);
    assert.deepEqual(safe, { safe: true, blockers: [] });
    session.child.stdin!.end();
    const hostExit = await session.exit;
    assert.equal(hostExit.code, 0, session.stderr());
    succeeded = true;
  } finally {
    try { authority?.store.close(); } catch { /* already closed */ }
    session?.child.kill("SIGKILL");
    await session?.exit.catch(() => undefined);
    if (worker && worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill("SIGKILL");
      await worker.exit.catch(() => undefined);
    }
    try {
      const lease = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8")) as ExecutorLeaseRecord;
      observedPids.add(lease.owner.process_id);
    } catch { /* no current lease */ }
    try {
      for (const line of readFileSync(spawnLog, "utf8").trim().split(/\r?\n/u)) {
        if (/^\d+$/u.test(line)) observedPids.add(Number(line));
      }
    } catch { /* fixture did not reach a spawn */ }
    for (const pid of observedPids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
      await waitForProcessExit(pid, 15_000).catch(() => undefined);
    }
    if (!succeeded) {
      console.error(`production Worker recovery fixture retained on failure: ${fixture}`);
      console.error(`service stderr:\n${service?.stderr() ?? ""}`);
      console.error(`worker stderr:\n${worker?.stderr() ?? ""}`);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 500));
      rmSync(fixture, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    }
  }
});
