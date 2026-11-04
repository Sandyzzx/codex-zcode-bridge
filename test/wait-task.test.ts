import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isSupportedNodeVersion } from "../src/runtime/node-runtime.js";
import { waitForAttentionSnapshot } from "../src/attention/wait.js";
import { resolveWaitDataRoot } from "../src/cli/wait-task.js";
import type { TaskAttentionSnapshot } from "../src/interfaces.js";

const WAITER = fileURLToPath(new URL("../src/cli/wait-task.js", import.meta.url));
const sqliteCapable = isSupportedNodeVersion(process.versions.node);

type StoreModule = typeof import("../src/sqlite-candidate/wp6b2b1/store.mjs");
type Store = ReturnType<StoreModule["IsolatedAdmissionStore"]["initialize"]>;
type CandidateTask = Parameters<Store["createTask"]>[0];

const allow = () => ({ state: "allow", fixture: true });
const gates = { workspaceValidator: allow, executionPermissionCheck: allow };

function fixtureRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "bridge-thin-wait-"));
}

// test-isolated redirects Node's TMP under the repository, while SQLite
// authority roots are explicitly rejected inside the package tree.
function systemTempRoot(): string {
  return path.parse(tmpdir()).root;
}

async function storeModule(): Promise<StoreModule> {
  return import("../src/sqlite-candidate/wp6b2b1/store.mjs");
}

function task(taskId: string, workspace: string): CandidateTask {
  return {
    task_id: taskId,
    workspace,
    objective: "synthetic thin waiter task",
    requirements: [],
    allowed_paths: [],
    forbidden_paths: [],
    acceptance_criteria: [],
    test_commands: [],
  };
}

function initializeStore(module: StoreModule, root: string): Store {
  const store = module.IsolatedAdmissionStore.initialize(root, {
    databaseFileName: "bridge.sqlite",
    managedDataDirectory: true,
    freshInstallReceiptId: "thin-waiter-test",
    verifierVersion: "thin-waiter-test",
    freshInstallCapacityLimit: 8,
  });
  return store;
}

function startRunningTask(store: Store, taskId: string, workspace: string, requestIds: string[] = []): string {
  mkdirSync(workspace, { recursive: true });
  const operationId = `operation-${taskId}`;
  store.createTask(task(taskId, workspace), "2026-11-02T00:00:00.000Z");
  const admitted = store.admitOperation({ operation_id: operationId, task_id: taskId, attempt: 1, workspace_ref: workspace }, gates);
  const launch = {
    operation_id: operationId,
    task_id: taskId,
    attempt: 1,
    generation: admitted.generation,
    revision: admitted.revision,
    launch_id: `launch-${taskId}`,
    launch_epoch: 1,
    launch_token: `launch-token-${taskId}-0123456789`,
  };
  const intent = store.createLaunchIntent(launch);
  const receipt = store.recordLaunchReceipt({
    ...launch,
    revision: intent.revision,
    receipt_id: `receipt-${taskId}`,
    launch_identity: { source: "synthetic_fixture", fixture: true, process_id: 43111, start_fingerprint: `start-${taskId}` },
  });
  store.commitPermanentClaim({
    ...launch,
    revision: receipt.revision,
    claim_id: `claim-${taskId}`,
    worker_identity: {
      source: "synthetic_fixture",
      fixture: true,
      worker_id: `worker-${taskId}`,
      incarnation: `incarnation-${taskId}`,
      process_id: 43111,
      start_fingerprint: `start-${taskId}`,
    },
  });
  for (const requestId of requestIds) {
    const operation = store.readOperation(operationId);
    store.recordInteractionRequest({
      operation_id: operationId,
      task_id: taskId,
      attempt: operation.attempt,
      generation: operation.generation,
      expected_revision: operation.revision,
      claim_id: operation.claim_id,
      worker_identity_digest: operation.claim_worker_identity_digest,
      request: {
        method: "interaction/requestPermission",
        params: { options: [{ kind: "allow_once", label: "Allow" }] },
        request_id: requestId,
      },
    });
  }
  return operationId;
}

function completeTask(store: Store, taskId: string): void {
  const operationId = `operation-${taskId}`;
  const operation = store.readOperation(operationId);
  store.commitResult({
    operation_id: operationId,
    task_id: taskId,
    attempt: 1,
    generation: operation.generation,
    revision: operation.revision,
    claim_id: operation.claim_id,
    claim_worker_identity_digest: operation.claim_worker_identity_digest,
    result_status: "completed",
    result: {
      task_id: taskId,
      attempt: 1,
      status: "completed",
      summary: "synthetic completion",
      files_changed: [],
      tests: [],
      issues: [],
      needs_master_decision: false,
      zcode_output: "",
      exit_code: 0,
      session_id: null,
      started_at: "2026-11-02T00:00:00.000Z",
      finished_at: "2026-11-02T00:00:01.000Z",
    },
  });
}

function run(dataRoot: string, taskId: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, [WAITER, "--task", taskId, "--data-dir", dataRoot, ...extra], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    json: result.stdout.trim() ? JSON.parse(result.stdout) as Record<string, unknown> : null,
  };
}

function startWaiter(dataRoot: string, taskId: string, extra: string[] = []) {
  const child = spawn(process.execPath, [WAITER, "--task", taskId, "--data-dir", dataRoot, ...extra], {
    timeout: 20_000,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const completed = new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completed };
}

function forceStop(child: ChildProcessWithoutNullStreams | null): void {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
}

function digest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fileState(file: string): { exists: boolean; size: number | null; sha256: string | null; mtime_ms: number | null } {
  if (!existsSync(file)) return { exists: false, size: null, sha256: null, mtime_ms: null };
  const stat = statSync(file);
  return { exists: true, size: stat.size, sha256: digest(file), mtime_ms: stat.mtimeMs };
}

function snapshot(root: string): string[] {
  return readdirSync(root, { recursive: true }).map(String).sort().map((name) => {
    const stat = statSync(path.join(root, name));
    return `${name}:${stat.size}:${stat.mtimeMs}`;
  });
}

test("thin waiter reports current-Attempt pending IDs and does not modify SQLite", { skip: !sqliteCapable }, async () => {
  const root = fixtureRoot();
  const workspace = path.join(root, "workspace");
  const module = await storeModule();
  const store = initializeStore(module, root);
  try {
    startRunningTask(store, "wait-pending", workspace, ["request-z", "request-a"]);
  } finally {
    store.close();
  }
  try {
    const database = path.join(root, "bridge.sqlite");
    const before = {
      database: fileState(database),
      wal: fileState(`${database}-wal`),
      shm: fileState(`${database}-shm`),
    };
    const result = run(root, "wait-pending", ["--timeout-s", "5"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json?.reason, "interaction");
    assert.equal(result.json?.status, "running");
    assert.equal(result.json?.attempt, 1);
    assert.deepEqual(result.json?.pending_requests, ["request-z", "request-a"]);
    assert.equal(result.json?.pending_count, 2);
    const after = {
      database: fileState(database),
      wal: fileState(`${database}-wal`),
      shm: fileState(`${database}-shm`),
    };
    assert.equal(after.database.sha256, before.database.sha256, "the business database bytes must not change");
    if (before.wal.exists) {
      assert.equal(after.wal.sha256, before.wal.sha256, "an existing WAL must not be written by the waiter");
    } else if (after.wal.exists) {
      assert.equal(after.wal.size, 0, "a read-only open may create only an empty WAL sidecar");
    }
    if (!before.shm.exists && after.shm.exists) {
      assert.ok(after.shm.size !== null && after.shm.size > 0, "new SHM state is an allowed SQLite read side effect");
    }
    assert.equal(existsSync(path.join(root, "WRITER_INTENT.json")), false);
    assert.equal(existsSync(path.join(root, "ROOT_POISONED.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("thin waiter records allowed sidecars while preserving business database and WAL bytes", { skip: !sqliteCapable }, async () => {
  const root = fixtureRoot();
  const module = await storeModule();
  const store = initializeStore(module, root);
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    startRunningTask(store, "wait-side-effects", path.join(root, "workspace"));
  } finally {
    store.close();
  }
  const database = path.join(root, "bridge.sqlite");
  const before = {
    database: fileState(database),
    wal: fileState(`${database}-wal`),
    shm: fileState(`${database}-shm`),
  };
  try {
    const pending = startWaiter(root, "wait-side-effects", ["--timeout-s", "2", "--poll-ms", "250"]);
    child = pending.child;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const during = {
      database: fileState(database),
      wal: fileState(`${database}-wal`),
      shm: fileState(`${database}-shm`),
    };
    assert.equal(during.database.sha256, before.database.sha256, "the active reader must not modify business database bytes");
    if (before.wal.exists) {
      assert.equal(during.wal.sha256, before.wal.sha256, "the active reader must not modify an existing WAL");
    } else if (during.wal.exists) {
      assert.equal(during.wal.size, 0, "a read-only open may create only an empty WAL sidecar");
    }
    if (!before.shm.exists && during.shm.exists) {
      assert.ok(during.shm.size !== null && during.shm.size > 0, "SQLite may create SHM read state");
    }
    const result = await pending.completed;
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 3, result.stderr);
    const after = {
      database: fileState(database),
      wal: fileState(`${database}-wal`),
      shm: fileState(`${database}-shm`),
    };
    assert.equal(after.database.sha256, before.database.sha256, "database bytes must remain unchanged after exit");
    if (before.wal.exists) {
      assert.equal(after.wal.sha256, before.wal.sha256, "an existing WAL must remain unchanged after exit");
    } else if (after.wal.exists) {
      assert.equal(after.wal.size, 0, "the reader may leave only an empty WAL sidecar after exit");
    }
    assert.equal(existsSync(path.join(root, "WRITER_INTENT.json")), false);
    assert.equal(existsSync(path.join(root, "ROOT_POISONED.json")), false);
  } finally {
    forceStop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("thin waiter sees committed WAL state while the Authority remains open", { skip: !sqliteCapable }, async () => {
  const root = fixtureRoot();
  const module = await storeModule();
  const store = initializeStore(module, root);
  try {
    startRunningTask(store, "wait-live", path.join(root, "workspace"), ["request-live"]);
    const result = run(root, "wait-live", ["--timeout-s", "5"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json?.reason, "interaction");
    assert.deepEqual(result.json?.pending_requests, ["request-live"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("thin waiter observes a WAL created after it opened a checkpointed database", { skip: !sqliteCapable }, async () => {
  const root = fixtureRoot();
  const module = await storeModule();
  const options = { databaseFileName: "bridge.sqlite", managedDataDirectory: true };
  const initial = initializeStore(module, root);
  let writer: Store | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  try {
    startRunningTask(initial, "wait-new-wal", path.join(root, "workspace"));
  } finally {
    initial.close();
  }
  const database = path.join(root, "bridge.sqlite");
  assert.equal(existsSync(`${database}-wal`), false, "the fixture must start checkpointed before the waiter opens");
  try {
    const pending = startWaiter(root, "wait-new-wal", ["--timeout-s", "8", "--poll-ms", "250"]);
    child = pending.child;
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(child.exitCode, null, "the waiter must still be polling when the writer starts");

    writer = module.IsolatedAdmissionStore.open(root, options);
    completeTask(writer, "wait-new-wal");
    assert.equal(existsSync(`${database}-wal`), true, "the writer must publish the completion through a new WAL");

    const result = await pending.completed;
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(json.reason, "terminal");
    assert.equal(json.status, "completed");
    assert.equal(json.attempt, 1);
  } finally {
    forceStop(child);
    writer?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("documented installed-plugin layout starts without a development package.json or plugin-mode env", { skip: !sqliteCapable }, async () => {
  const fixtureRootPath = path.join(process.cwd(), ".run");
  mkdirSync(fixtureRootPath, { recursive: true });
  const root = mkdtempSync(path.join(fixtureRootPath, "bridge-installed-waiter-"));
  const module = await storeModule();
  const pluginRoot = path.join(root, "a", "b", "c", "d", "e", "f", "g", "plugin");
  const settings = path.join(root, "home", ".codex", "codex-zcode-bridge");
  const appRoot = mkdtempSync(path.join(systemTempRoot(), "bridge-waiter-app-"));
  const stateRoot = path.join(appRoot, "state");
  mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
  mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(settings, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  copyFileSync(path.join(process.cwd(), "plugins", "codex-zcode-bridge", "dist", "wait-task.mjs"), path.join(pluginRoot, "dist", "wait-task.mjs"));
  copyFileSync(path.join(process.cwd(), "plugins", "codex-zcode-bridge", "dist", "schema.sql"), path.join(pluginRoot, "dist", "schema.sql"));
  copyFileSync(path.join(process.cwd(), "plugins", "codex-zcode-bridge", "dist", "admin-abandonment.sql"), path.join(pluginRoot, "dist", "admin-abandonment.sql"));
  copyFileSync(path.join(process.cwd(), "plugins", "codex-zcode-bridge", "launch-node24.mjs"), path.join(pluginRoot, "launch-node24.mjs"));
  copyFileSync(path.join(process.cwd(), "plugins", "codex-zcode-bridge", ".codex-plugin", "plugin.json"), path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  writeFileSync(path.join(settings, "authority.json"), JSON.stringify({
    schema_version: 1,
    authority: "sqlite",
    data_root: appRoot,
  }), "utf8");

  const store = initializeStore(module, stateRoot);
  try {
    startRunningTask(store, "wait-installed-plugin", path.join(root, "workspace"), ["request-installed"]);
  } finally {
    store.close();
  }
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
    };
    delete env.ZCODE_BRIDGE_PLUGIN_MODE;
    const result = spawnSync(process.execPath, [
      path.join(pluginRoot, "dist", "wait-task.mjs"),
      "--task", "wait-installed-plugin",
      "--timeout-s", "5",
      "--poll-ms", "250",
    ], { cwd: root, env, encoding: "utf8", timeout: 20_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(json.reason, "interaction");
    assert.deepEqual(json.pending_requests, ["request-installed"]);
  } finally {
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("thin waiter exits on a terminal task and times out with exit 3", { skip: !sqliteCapable }, async () => {
  const terminalRoot = fixtureRoot();
  const timeoutRoot = fixtureRoot();
  const module = await storeModule();
  const terminalStore = initializeStore(module, terminalRoot);
  const timeoutStore = initializeStore(module, timeoutRoot);
  try {
    startRunningTask(terminalStore, "wait-terminal", path.join(terminalRoot, "workspace"), ["stale-terminal-request"]);
    completeTask(terminalStore, "wait-terminal");
    startRunningTask(timeoutStore, "wait-timeout", path.join(timeoutRoot, "workspace"));
  } finally {
    terminalStore.close();
    timeoutStore.close();
  }
  try {
    const terminal = run(terminalRoot, "wait-terminal", ["--timeout-s", "5"]);
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.equal(terminal.json?.reason, "terminal");
    assert.equal(terminal.json?.status, "completed");
    assert.deepEqual(terminal.json?.pending_requests, [], "terminal status must win over historical pending rows");

    const timedOut = run(timeoutRoot, "wait-timeout", ["--timeout-s", "1", "--poll-ms", "250"]);
    assert.equal(timedOut.status, 3, timedOut.stderr);
    assert.equal(timedOut.json?.reason, "timeout");
    assert.deepEqual(timedOut.json?.pending_requests, []);
  } finally {
    rmSync(terminalRoot, { recursive: true, force: true });
    rmSync(timeoutRoot, { recursive: true, force: true });
  }
});

test("thin waiter rejects missing or non-SQLite storage without creating or falling back", { skip: !sqliteCapable }, () => {
  const root = fixtureRoot();
  try {
    const before = snapshot(root);
    const missing = run(root, "wait-missing", ["--timeout-s", "1"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /database_missing/u);
    assert.deepEqual(snapshot(root), before, "missing SQLite must not trigger initialization or JSON fallback");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared wait predicate prioritizes terminal, supports multiple pending, and detects Attempt changes", async () => {
  const terminal: TaskAttentionSnapshot = {
    task_id: "task_1",
    attempt: 1,
    status: "completed",
    pending_requests: ["stale-request"],
  };
  const terminalResult = await waitForAttentionSnapshot({ read: async () => terminal, timeoutMs: 0 });
  assert.equal(terminalResult.reason, "terminal");

  const pending: TaskAttentionSnapshot = {
    task_id: "task_1",
    attempt: 1,
    status: "running",
    pending_requests: ["a", "b"],
  };
  const pendingResult = await waitForAttentionSnapshot({ read: async () => pending, timeoutMs: 0 });
  assert.equal(pendingResult.reason, "interaction");
  assert.deepEqual(pendingResult.snapshot.pending_requests, ["a", "b"]);

  let reads = 0;
  const switched = await waitForAttentionSnapshot({
    read: async () => reads++ === 0
      ? { task_id: "task_1", attempt: 1, status: "running", pending_requests: [] }
      : { task_id: "task_1", attempt: 2, status: "queued", pending_requests: [] },
    timeoutMs: 1_000,
    pollMs: 250,
  });
  assert.equal(switched.reason, "attempt_changed");
  assert.equal(switched.snapshot.attempt, 2);
});

test("thin waiter rejects invalid arguments before opening storage", () => {
  const result = spawnSync(process.execPath, [WAITER, "--task", "../escape"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node wait-task\.mjs/u);
});

test("an explicit JSON upgrade hint still resolves SQLite and never falls back to JSON", { skip: !sqliteCapable }, () => {
  const home = fixtureRoot();
  const appRoot = mkdtempSync(path.join(systemTempRoot(), "bridge-waiter-config-app-"));
  try {
    const settings = path.join(home, ".codex", "codex-zcode-bridge");
    mkdirSync(settings, { recursive: true });
    writeFileSync(path.join(settings, "authority.json"), JSON.stringify({ schema_version: 1, authority: "json" }), "utf8");
    const resolved = resolveWaitDataRoot(null, { LOCALAPPDATA: appRoot }, home);
    assert.equal(path.basename(resolved.databaseFileName), "bridge.sqlite");
    assert.equal(resolved.dataRoot.endsWith(`${path.sep}state`), true);
    assert.equal(existsSync(path.join(resolved.dataRoot, ".tasks")), false, "waiter resolution must not choose a legacy JSON task root");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
