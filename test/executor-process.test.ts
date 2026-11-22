import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { ExecutorControlClient } from "../src/executor/control-client.js";
import { EXECUTOR_LEASE_FILE, EXECUTOR_LEASE_RELEASED_FILE } from "../src/executor/lease.js";
import { startExecutorService, type ExecutorAuthority } from "../src/executor/service.js";
import { codexHostProfile } from "../src/host/profile.js";
import { loadLifecycleCandidateModules } from "../src/store/lifecycle-gate.js";
import type { TaskPackage } from "../src/interfaces.js";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const executorEntry = path.join(projectRoot, "dist-test", "src", "executor", "main.js");
const workerEntry = path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js");
const thinMcpEntry = path.join(projectRoot, "dist-test", "src", "mcp", "main.js");
const bridgeEntry = fileURLToPath(import.meta.url);

interface ExecutorProcess {
  readonly child: ReturnType<typeof spawn>;
  readonly close: () => void;
  readonly ready: Promise<{ readonly lease_id: string; readonly pipe_name: string }>;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

function startExecutor(
  root: string,
  heartbeatMs: string,
  settingsDirectory?: string,
  options: { readonly workerEntryPath?: string; readonly env?: NodeJS.ProcessEnv } = {},
): ExecutorProcess {
  const child = spawn(process.execPath, [
    executorEntry,
    "--data-root", root,
    "--bridge-entry", bridgeEntry,
    "--worker-entry", options.workerEntryPath ?? workerEntry,
    "--heartbeat-ms", heartbeatMs,
    "--test-only-fake-adapter",
    ...(settingsDirectory ? ["--settings-directory", settingsDirectory] : []),
  ], { cwd: projectRoot, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  let readyTimer: NodeJS.Timeout | undefined;
  const ready = new Promise<{ lease_id: string; pipe_name: string }>((resolve, reject) => {
    let buffered = "";
    readyTimer = setTimeout(() => reject(new Error(`EXECUTOR_READY_TIMEOUT\n${stderr}`)), 60_000);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      const match = /^EXECUTOR_READY (.+)$/mu.exec(buffered);
      if (match) {
        clearTimeout(readyTimer);
        resolve(JSON.parse(match[1]!) as { lease_id: string; pipe_name: string });
      }
    });
    child.once("error", (error) => {
      clearTimeout(readyTimer);
      reject(error);
    });
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const close = (): void => {
    if (readyTimer) clearTimeout(readyTimer);
    child.kill();
  };
  return {
    child,
    close,
    ready,
    exit,
  };
}

async function waitForHeartbeat(root: string, initialAt: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const lease = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8")) as { heartbeat_at: string };
    if (lease.heartbeat_at !== initialAt) return lease.heartbeat_at;
    if (Date.now() > deadline) throw new Error("EXECUTOR_HEARTBEAT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForLifecycleEvent(client: ExecutorControlClient, taskId: string, eventType: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  let lastEvents: unknown = null;
  while (Date.now() < deadline) {
    const response = await client.request("getEvents", {
      input: { task_id: taskId, after_seq: 0, limit: 200 },
    });
    assert.equal(response.ok, true);
    const events = Array.isArray(response.result?.events) ? response.result.events as Array<Record<string, unknown>> : [];
    lastEvents = events;
    if (events.some((event) => event.type === eventType)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`EXECUTOR_EVENT_TIMEOUT ${eventType} ${JSON.stringify(lastEvents)}`);
}

function startThinMcp(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [thinMcpEntry], {
    cwd: projectRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let buffered = "";
  const messages: Array<Record<string, unknown>> = [];
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      messages.push(message);
      const id = message.id;
      if (typeof id === "number") waiters.get(id)?.(message);
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const waitForResponse = (id: number): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const observed = messages.find((message) => message.id === id);
    if (observed) {
      resolve(observed);
      return;
    }
    const timer = setTimeout(() => reject(new Error(`THIN_MCP_RESPONSE_TIMEOUT ${id}\n${stderr}`)), 20_000);
    waiters.set(id, (message) => {
      clearTimeout(timer);
      waiters.delete(id);
      resolve(message);
    });
  });
  return {
    child,
    exit,
    waitForResponse,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test("a real Executor process holds exact single-instance ownership and heartbeats", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-process-"));
  const settingsDirectory = mkdtempSync(path.join(tmpdir(), "executor-settings-"));
  mkdirSync(settingsDirectory, { recursive: true });
  const first = startExecutor(root, "50", settingsDirectory);
  try {
    const ready = await first.ready;
    const client = new ExecutorControlClient({ pipeName: ready.pipe_name });
    await client.connect();
    const initialHealth = await client.request("health", {});
    assert.equal(initialHealth.ok, true);
    const initialHeartbeat = (JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8")) as { heartbeat_at: string }).heartbeat_at;
    await waitForHeartbeat(root, initialHeartbeat);
    const second = startExecutor(root, "50", settingsDirectory);
    const secondExit = await second.exit;
    assert.equal(secondExit.code, 1);
    second.close();
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), true);

    try {
      const health = await client.request("health", {});
      assert.equal(health.ok, true);
      assert.equal(health.executor_state.lease_id, ready.lease_id);
    } finally {
      client.close();
    }
  } finally {
    first.close();
    await first.exit;
    rmSync(root, { recursive: true, force: true });
    rmSync(settingsDirectory, { recursive: true, force: true });
  }
});

test("the internal Executor entry point reports its supported arguments", async () => {
  const help = spawn(process.execPath, [executorEntry, "--help"], { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] });
  let output = "";
  help.stderr.setEncoding("utf8");
  help.stderr.on("data", (chunk: string) => { output += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    help.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(await exit, { code: 0, signal: null });
  assert.match(output, /EXECUTOR_USAGE: node dist\/src\/executor\/main\.js --data-root <absolute-path>/u);
  assert.match(output, /--settings-directory <absolute-path>/u);
});

test("an idle-only shutdown refusal restores admission and task control", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-idle-refusal-"));
  let idle = false;
  let authorityClosed = false;
  let leasePresentAtStoreClose = false;
  const created: string[] = [];
  const authority: ExecutorAuthority = {
    async createTask(task: TaskPackage) {
      created.push(task.task_id);
      return { task_id: task.task_id, status: "queued", created_at: new Date().toISOString() };
    },
    async getStatus(taskId: string) {
      return {
        task_id: taskId, status: "queued", attempt: 1, created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z", started_at: null, finished_at: null,
        worker_pid: null, zcode_session_id: null, exit_code: null,
      };
    },
    async getResult() { throw new Error("TASK_NOT_FINISHED"); },
    async continueTask() { throw new Error("TASK_STATE"); },
    async cancelTask(taskId: string) { return this.getStatus(taskId); },
    async getEvents(input) {
      return { task_id: input.task_id, status: "queued", events: [], next_seq: 0, has_more: false };
    },
    async getFeedback() { throw new Error("FEEDBACK_UNAVAILABLE"); },
    async getAttention(taskId: string) {
      return { task_id: taskId, attempt: 1, status: "queued", pending_requests: [] };
    },
    async replyToInteraction() { throw new Error("TASK_STATE"); },
    getExecutorIdleState: () => idle ? { idle: true, blockers: [] } : { idle: false, blockers: ["active_run"] },
    async closeIfIdle() {
      if (!idle) return { closed: false, blockers: ["active_run"] };
      leasePresentAtStoreClose = existsSync(path.join(root, EXECUTOR_LEASE_FILE));
      authorityClosed = true;
      return { closed: true, blockers: [] };
    },
  };
  const service = await startExecutorService({
    dataRoot: root,
    bridgeEntryPath: bridgeEntry,
    heartbeatMs: 100,
    testWorkerEntryPath: workerEntry,
    testOnlyFakeAdapter: true,
    testAuthority: authority,
  });
  const client = new ExecutorControlClient({ pipeName: service.pipeName });
  try {
    await client.connect();
    const first = await client.request("createTask", {
      task: {
        task_id: "idle-refusal-a", workspace: process.cwd(), objective: "Hold dispatch", requirements: [],
        allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [],
      },
    });
    assert.equal(first.ok, true);

    const refused = await service.shutdown();
    assert.equal(refused.status, "not_idle");
    assert.equal(service.state(), "active");
    const health = await client.request("health", {});
    assert.equal(health.ok, true);
    assert.equal(health.executor_state.state, "active");

    const second = await client.request("createTask", {
      task: {
        task_id: "idle-refusal-b", workspace: process.cwd(), objective: "Continue after refusal", requirements: [],
        allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [],
      },
    });
    assert.equal(second.ok, true);
    assert.deepEqual(created, ["idle-refusal-a", "idle-refusal-b"]);
    idle = true;
    const closed = await service.shutdown();
    assert.equal(closed.status, "closed");
    assert.equal(service.state(), "closed");
    assert.equal(authorityClosed, true);
    assert.equal(leasePresentAtStoreClose, true);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), false);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_RELEASED_FILE)), true);
  } finally {
    client.close();
    if (service.state() !== "closed") await service.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Thin MCP disconnect leaves the accepted Task in the Executor and reconnects to its Result", { timeout: 90_000 }, async () => {
  const fixtureBase = process.env.LOCALAPPDATA
    && path.isAbsolute(process.env.LOCALAPPDATA)
    ? path.join(process.env.LOCALAPPDATA, "Temp")
    : tmpdir();
  mkdirSync(fixtureBase, { recursive: true });
  const fixture = mkdtempSync(path.join(fixtureBase, "executor-thin-"));
  const localAppData = path.join(fixture, "local-app-data");
  const userProfile = path.join(fixture, "user-profile");
  const tempDirectory = path.join(fixture, "temp");
  const root = path.join(localAppData, "CodexZCodeBridge", "state");
  const settingsDirectory = path.join(userProfile, ".codex", "codex-zcode-bridge");
  const workspace = path.join(fixture, "workspace");
  const spawnLog = path.join(fixture, "worker-spawns.log");
  const workerWrapper = path.join(fixture, "worker-wrapper.mjs");
  for (const directory of [root, settingsDirectory, workspace, tempDirectory]) mkdirSync(directory, { recursive: true });
  writeFileSync(spawnLog, "", "utf8");
  writeFileSync(workerWrapper, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(spawnLog)}, "spawn\\n");`,
    `const { runWorkerMain } = await import(${JSON.stringify(pathToFileURL(workerEntry).href)});`,
    "await runWorkerMain({}, process.argv.slice(2));",
    "",
  ].join("\n"), "utf8");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    USERPROFILE: userProfile,
    HOME: userProfile,
    TEMP: tempDirectory,
    TMP: tempDirectory,
    TMPDIR: tempDirectory,
    ZCODE_BRIDGE_MCP_TRANSPORT: "control",
  };
  delete env.ZCODE_BRIDGE_DATA_DIR;
  delete env.ZCODE_BRIDGE_PLUGIN_MODE;

  const executor = startExecutor(root, "100", settingsDirectory, {
    workerEntryPath: workerWrapper,
    env,
  });
  const ready = await executor.ready;
  const directClient = new ExecutorControlClient({ pipeName: ready.pipe_name });
  let firstSession: ReturnType<typeof startThinMcp> | undefined;
  let secondSession: ReturnType<typeof startThinMcp> | undefined;
  try {
    const taskId = `thin-mcp-${Date.now()}`;
    firstSession = startThinMcp(env);
    firstSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "thin-test", version: "0.0.0" } },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: {
          name: "zcode_task",
          arguments: {
            task_id: taskId,
            workspace,
            objective: "Thin MCP synthetic E2E",
            requirements: ["Do not use a real model"],
            allowed_paths: [],
            forbidden_paths: [],
            acceptance_criteria: ["Commit one Result"],
            test_commands: [],
          },
        },
      }),
      "",
    ].join("\n"));
    assert.ok((await firstSession.waitForResponse(1)).result);
    const taskResponse = await firstSession.waitForResponse(2) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(taskResponse.result?.isError, true, firstSession.stderr());
    assert.equal(taskResponse.result?.structuredContent?.task_id, taskId);
    firstSession.child.stdin.end();
    const firstExit = await Promise.race([
      firstSession.exit,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`THIN_MCP_EXIT_TIMEOUT\n${firstSession!.stderr()}`)), 15_000)),
    ]);
    assert.equal(firstExit.code, 0, firstSession.stderr());

    await directClient.connect();
    await waitForLifecycleEvent(directClient, taskId, "released");
    const result = await directClient.request("getResult", { task_id: taskId });
    assert.equal(result.ok, true);
    assert.equal((result.result as { status?: unknown }).status, "completed");
    assert.equal((result.result as { attempt?: unknown }).attempt, 1);
    const spawns = readFileSync(spawnLog, "utf8").split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(spawns, ["spawn"]);

    secondSession = startThinMcp(env);
    secondSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "thin-test-reconnect", version: "0.0.0" } },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "zcode_result", arguments: { task_id: taskId } },
      }),
      "",
    ].join("\n"));
    assert.ok((await secondSession.waitForResponse(1)).result);
    const reconnectResult = await secondSession.waitForResponse(2) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(reconnectResult.result?.isError, true, secondSession.stderr());
    assert.equal(reconnectResult.result?.structuredContent?.task_id, taskId);
    assert.equal(reconnectResult.result?.structuredContent?.status, "completed");
    assert.equal(reconnectResult.result?.structuredContent?.attempt, 1);
    secondSession.child.stdin.end();
    const secondExit = await Promise.race([
      secondSession.exit,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`THIN_MCP_RECONNECT_EXIT_TIMEOUT\n${secondSession!.stderr()}`)), 15_000)),
    ]);
    assert.equal(secondExit.code, 0, secondSession.stderr());

  } finally {
    firstSession?.child.kill();
    secondSession?.child.kill();
    directClient.close();
    executor.child.kill("SIGKILL");
    await executor.exit;
    await new Promise((resolve) => setTimeout(resolve, 100));
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a real Executor commits a synthetic Worker Result, Cleanup, and Release across processes", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-e2e-"));
  const settingsDirectory = mkdtempSync(path.join(tmpdir(), "executor-e2e-settings-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "executor-e2e-workspace-"));
  const taskId = `executor-fake-e2e-${Date.now()}`;
  const executor = startExecutor(root, "250", settingsDirectory);
  let client: ExecutorControlClient | undefined;
  try {
    const ready = await executor.ready;
    client = new ExecutorControlClient({ pipeName: ready.pipe_name });
    await client.connect();
    const created = await client.request("createTask", {
      task: {
        task_id: taskId,
        workspace,
        objective: "Synthetic Executor E2E",
        requirements: ["Do not use a real model"],
        allowed_paths: [],
        forbidden_paths: [],
        acceptance_criteria: ["Commit the original Attempt Result"],
        test_commands: [],
      },
    }, undefined, taskId);
    assert.equal(created.ok, true);
    assert.equal(created.result?.status, "queued");

    const deadline = Date.now() + 10_000;
    let status: { status?: unknown } | undefined;
    while (Date.now() < deadline) {
      const response = await client.request("getStatus", { task_id: taskId });
      assert.equal(response.ok, true);
      status = response.result as { status?: unknown };
      if (["completed", "failed", "cancelled", "waiting_for_master"].includes(String(status.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status?.status, "completed");

    const resultResponse = await client.request("getResult", { task_id: taskId });
    assert.equal(resultResponse.ok, true);
    assert.equal((resultResponse.result as { status?: unknown }).status, "completed");
    assert.equal((resultResponse.result as { attempt?: unknown }).attempt, 1);
    await waitForLifecycleEvent(client, taskId, "released");

    const modules = await loadLifecycleCandidateModules();
    const recovery = modules.Store.openForRecovery(root, { databaseFileName: "bridge.sqlite", managedDataDirectory: true });
    assert.ok(recovery, "the synthetic Executor root must remain readable after the Worker exits");
    try {
      const snapshot = modules.createPort(recovery).readRecoverySnapshot() as {
        operations: Array<Record<string, unknown>>;
        events: Array<{ event_type: string; operation_id: string }>;
      };
      const operation = snapshot.operations.find((item) => item.task_id === taskId);
      assert.ok(operation, "the original Attempt Operation must remain persisted");
      assert.equal(operation.phase, "released");
      assert.notEqual(operation.result_digest, null);
      assert.equal(operation.result_status, "completed");
      const eventTypes = snapshot.events.filter((event) => event.operation_id === operation.operation_id)
        .map((event) => event.event_type);
      for (const expected of ["result_committed", "cleanup_pending", "cleanup_verified", "released"]) {
        assert.equal(eventTypes.includes(expected), true, `missing lifecycle event ${expected}`);
      }
      assert.equal(eventTypes.filter((event) => event === "result_committed").length, 1);
    } finally {
      recovery.close();
    }
  } finally {
    client?.close();
    executor.close();
    await executor.exit;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(settingsDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
