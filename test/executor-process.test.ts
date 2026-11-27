import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { ExecutorControlClient } from "../src/executor/control-client.js";
import type { ExecutorControlResponse } from "../src/executor/protocol.js";
import { EXECUTOR_LEASE_FILE, EXECUTOR_LEASE_RELEASED_FILE } from "../src/executor/lease.js";
import { executorPipeName } from "../src/executor/pipe.js";
import { startExecutorService, type ExecutorAuthority } from "../src/executor/service.js";
import { codexHostProfile } from "../src/runtime/host-profile.js";
import { loadLifecycleCandidateModules } from "../src/store/lifecycle-gate.js";
import type { TaskPackage } from "../src/interfaces.js";
import {
  officialHostWorkerEntryPath,
  writeFakeRuntime,
} from "./sqlite-candidate/wp6b-wiring/mvp-real-adapter-harness.js";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const executorEntry = path.join(projectRoot, "dist-test", "src", "executor", "main.js");
const testExecutorEntry = path.join(projectRoot, "dist-test", "test", "fixtures", "executor-test-main.js");
const workerEntry = path.join(projectRoot, "dist-test", "src", "worker", "worker-main.js");
const thinMcpEntry = path.join(projectRoot, "dist-test", "src", "mcp", "main.js");
const shippedBridgeEntry = path.join(projectRoot, "plugins", "codex-zcode-bridge", "dist", "bridge.mjs");
const bridgeEntry = fileURLToPath(import.meta.url);

interface ExecutorProcess {
  readonly child: ReturnType<typeof spawn>;
  readonly close: () => void;
  readonly ready: Promise<{ readonly lease_id: string; readonly pipe_name: string }>;
  readonly exit: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  readonly stderr: () => string;
}

function startExecutor(
  root: string,
  heartbeatMs: string,
  settingsDirectory?: string,
  options: {
    readonly workerEntryPath?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly fakeAdapter?: boolean;
  } = {},
): ExecutorProcess {
  const child = spawn(process.execPath, [
    testExecutorEntry,
    "--data-root", root,
    "--bridge-entry", bridgeEntry,
    "--worker-entry", options.workerEntryPath ?? workerEntry,
    "--heartbeat-ms", heartbeatMs,
    ...(options.fakeAdapter === false ? [] : ["--test-only-fake-adapter"]),
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
    stderr: () => stderr,
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

async function waitForExecutorWakeEvent(
  client: ExecutorControlClient,
  taskId: string,
  state: "queued" | "submission_unknown" | "turn_started" | "web_notify",
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastEvents: unknown = null;
  while (Date.now() < deadline) {
    const response = await client.request("getEvents", {
      input: { task_id: taskId, after_seq: 0, limit: 200 },
    });
    assert.equal(response.ok, true);
    const events = Array.isArray(response.result?.events)
      ? response.result.events as Array<Record<string, unknown>>
      : [];
    lastEvents = events;
    if (events.some((event) => {
      const details = event.details;
      return event.type === "observation_recorded" && typeof details === "object" && details !== null
        && (details as Record<string, unknown>).reason === "executor_wake"
        && (details as Record<string, unknown>).state === state;
    })) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`EXECUTOR_WAKE_EVENT_TIMEOUT ${state} ${JSON.stringify(lastEvents)}`);
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`PROCESS_EXIT_TIMEOUT ${pid}`);
}

async function waitForTextFile(file: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`FILE_TIMEOUT ${file}`);
}

async function waitForInteractionRequest(
  client: ExecutorControlClient,
  taskId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000;
  let lastEvents: unknown = null;
  while (Date.now() < deadline) {
    const response = await client.request("getEvents", {
      input: { task_id: taskId, after_seq: 0, limit: 200 },
    });
    assert.equal(response.ok, true);
    const events = Array.isArray(response.result?.events)
      ? response.result.events as Array<Record<string, unknown>>
      : [];
    lastEvents = events;
    const interaction = events.find((event) => event.type === "interaction_requested");
    if (interaction) return interaction;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  let terminal = "unavailable";
  try {
    const response = await client.request("getResult", { task_id: taskId });
    terminal = JSON.stringify(response);
  } catch { /* preserve the primary timeout */ }
  throw new Error(`EXECUTOR_INTERACTION_TIMEOUT ${JSON.stringify(lastEvents)} result=${terminal}`);
}

function startThinMcp(env: NodeJS.ProcessEnv, entry = thinMcpEntry) {
  const child = spawn(process.execPath, [entry], {
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

function idleAuthority(overrides: Partial<ExecutorAuthority> = {}): ExecutorAuthority {
  const authority: ExecutorAuthority = {
    async createTask(task: TaskPackage) {
      return { task_id: task.task_id, status: "queued", created_at: new Date().toISOString() };
    },
    async getStatus(taskId: string) {
      return {
        task_id: taskId, status: "queued", attempt: 1,
        created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        started_at: null, finished_at: null, worker_pid: null, zcode_session_id: null, exit_code: null,
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
    getExecutorIdleState: () => ({ idle: true, blockers: [] }),
    async closeIfIdle() { return { closed: true, blockers: [] }; },
    ...overrides,
  };
  return authority;
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
  assert.match(output, /--accept-unleased-transition/u);
  assert.match(output, /--settings-directory <absolute-path>/u);
  assert.doesNotMatch(output, /test-only-fake-adapter/u);
  assert.doesNotMatch(output, /--worker-entry/u);
});

test("the production Executor entry rejects synthetic execution options before acquiring a lease", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-production-cli-"));
  try {
    for (const extra of [
      ["--test-only-fake-adapter"],
      ["--worker-entry", workerEntry],
    ]) {
      const child = spawn(process.execPath, [
        executorEntry,
        "--data-root", root,
        "--bridge-entry", bridgeEntry,
        ...extra,
      ], { cwd: projectRoot, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(exit.code, 1, stderr);
      assert.match(stderr, /unknown_argument/u);
      assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup pipe failure releases an exact lease only after a verified idle Store close", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-startup-pipe-"));
  const pipe = executorPipeName(root);
  const blocker = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(pipe, () => resolve());
  });
  let authorityClosed = false;
  try {
    await assert.rejects(() => startExecutorService({
      dataRoot: root,
      bridgeEntryPath: bridgeEntry,
      testWorkerEntryPath: workerEntry,
      testOnlyFakeAdapter: true,
      testAuthority: idleAuthority({
        async closeIfIdle() {
          authorityClosed = true;
          assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), true);
          return { closed: true, blockers: [] };
        },
      }),
    }), /EADDRINUSE|listen/u);
    assert.equal(authorityClosed, true);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), false);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_RELEASED_FILE)), true);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("Authority startup failure retains the lease and blocks a second owner", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-startup-authority-"));
  try {
    await assert.rejects(() => startExecutorService({
      dataRoot: root,
      bridgeEntryPath: bridgeEntry,
      testWorkerEntryPath: workerEntry,
      testOnlyFakeAdapter: true,
      testAuthorityFactory: async () => {
        throw new Error("SYNTHETIC_AUTHORITY_START_FAILURE");
      },
    }), /SYNTHETIC_AUTHORITY_START_FAILURE/u);
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), true);
    await assert.rejects(() => startExecutorService({
      dataRoot: root,
      bridgeEntryPath: bridgeEntry,
      testWorkerEntryPath: workerEntry,
      testOnlyFakeAdapter: true,
      testAuthority: idleAuthority(),
    }), /EXECUTOR_ALREADY_ACTIVE/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lease release failure keeps the Executor fail closed after Store close", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-release-failure-"));
  mkdirSync(path.join(root, EXECUTOR_LEASE_RELEASED_FILE));
  const service = await startExecutorService({
    dataRoot: root,
    bridgeEntryPath: bridgeEntry,
    testWorkerEntryPath: workerEntry,
    testOnlyFakeAdapter: true,
    heartbeatMs: 100,
    testUnrefHeartbeat: true,
    testAuthority: idleAuthority(),
  });
  try {
    const shutdown = await service.shutdown();
    assert.equal(shutdown.status, "release_unknown");
    assert.equal(service.state(), "lease_unknown");
    const lease = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8")) as { state?: string };
    assert.equal(lease.state, "released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    ZCODE_BRIDGE_TASK_CONSOLE: "off",
  };
  delete env.ZCODE_BRIDGE_DATA_DIR;
  delete env.ZCODE_BRIDGE_PLUGIN_MODE;
  // A host session (for example a ZCode Desktop agent shell) may export its own
  // ZCODE_DATA_BASE_DIR/ZCODE_WINDOWS_APP_INSTALL_DIR. Both would fight the
  // fixture's ZCODE_HOME and redirect install discovery at the real Desktop.
  delete env.ZCODE_DATA_BASE_DIR;
  delete env.ZCODE_WINDOWS_APP_INSTALL_DIR;

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
      "",
    ].join("\n"));
    assert.ok((await firstSession.waitForResponse(1)).result);
    firstSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "zcode_default_model", arguments: {} },
      }),
      "",
    ].join("\n"));
    const initialDefault = await firstSession.waitForResponse(2) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(initialDefault.result?.isError, true, firstSession.stderr());
    assert.equal(initialDefault.result?.structuredContent?.configured, false);
    firstSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: {
          name: "zcode_set_default_model",
          arguments: { provider_id: "synthetic-provider", model_id: "synthetic-model", reasoning_level: "low" },
        },
      }),
      "",
    ].join("\n"));
    const setDefault = await firstSession.waitForResponse(3) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(setDefault.result?.isError, true, firstSession.stderr());
    assert.equal(setDefault.result?.structuredContent?.configured, true);
    firstSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "zcode_default_model", arguments: {} },
      }),
      "",
    ].join("\n"));
    const currentDefault = await firstSession.waitForResponse(4) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(currentDefault.result?.isError, true, firstSession.stderr());
    assert.deepEqual(currentDefault.result?.structuredContent?.model, {
      provider_id: "synthetic-provider",
      model_id: "synthetic-model",
      reasoning_level: "low",
    });
    assert.equal(existsSync(path.join(settingsDirectory, "runtime-config.json")), true);
    firstSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 5, method: "tools/call",
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
    const taskResponse = await firstSession.waitForResponse(5) as {
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
    const persistedSettings = JSON.parse(readFileSync(path.join(settingsDirectory, "runtime-config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(persistedSettings.ZCODE_BRIDGE_DEFAULT_PROVIDER_ID, "synthetic-provider");
    assert.equal(persistedSettings.ZCODE_BRIDGE_DEFAULT_MODEL_ID, "synthetic-model");
    assert.equal(persistedSettings.ZCODE_BRIDGE_DEFAULT_REASONING_LEVEL, "low");
    const directDefault = await directClient.request("getDefaultModel", {});
    assert.equal(directDefault.ok, true);
    assert.deepEqual(directDefault.result?.model, {
      provider_id: "synthetic-provider",
      model_id: "synthetic-model",
      reasoning_level: "low",
    });
    const spawns = readFileSync(spawnLog, "utf8").split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(spawns, ["spawn"]);

    secondSession = startThinMcp(env);
    secondSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "thin-test-reconnect", version: "0.0.0" } },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "",
    ].join("\n"));
    assert.ok((await secondSession.waitForResponse(1)).result);
    secondSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "zcode_result", arguments: { task_id: taskId } },
      }),
      "",
    ].join("\n"));
    const reconnectResult = await secondSession.waitForResponse(2) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(reconnectResult.result?.isError, true, secondSession.stderr());
    assert.equal(reconnectResult.result?.structuredContent?.task_id, taskId);
    assert.equal(reconnectResult.result?.structuredContent?.status, "completed");
    assert.equal(reconnectResult.result?.structuredContent?.attempt, 1);
    secondSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "zcode_default_model", arguments: {} },
      }),
      "",
    ].join("\n"));
    const reconnectDefault = await secondSession.waitForResponse(3) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(reconnectDefault.result?.isError, true, secondSession.stderr());
    assert.deepEqual(reconnectDefault.result?.structuredContent?.model, {
      provider_id: "synthetic-provider",
      model_id: "synthetic-model",
      reasoning_level: "low",
    });
    secondSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "zcode_doctor", arguments: {} },
      }),
      "",
    ].join("\n"));
    const doctorResponse = await secondSession.waitForResponse(4) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(doctorResponse.result?.isError, true, secondSession.stderr());
    const checks = Array.isArray(doctorResponse.result?.structuredContent?.checks)
      ? doctorResponse.result!.structuredContent!.checks as Array<{ name?: unknown }>
      : [];
    assert.equal(checks.some((check) => check.name === "active_tasks"), true);
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
    // Windows can keep the test-owned SQLite/WAL directory handle visible for
    // a short interval after the terminated process has exited.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a shipped MCP Host process exit cannot cancel the original Attempt Result, Cleanup, or Release", {
  timeout: 120_000,
}, async () => {
  const fixtureBase = process.env.LOCALAPPDATA
    && path.isAbsolute(process.env.LOCALAPPDATA)
    ? path.join(process.env.LOCALAPPDATA, "Temp")
    : tmpdir();
  mkdirSync(fixtureBase, { recursive: true });
  const fixture = mkdtempSync(path.join(fixtureBase, "executor-host-exit-"));
  const localAppData = path.join(fixture, "local-app-data");
  const userProfile = path.join(fixture, "user-profile");
  const tempDirectory = path.join(fixture, "temp");
  const root = path.join(localAppData, "CodexZCodeBridge", "state");
  const settingsDirectory = path.join(userProfile, ".codex", "codex-zcode-bridge");
  const workspace = path.join(fixture, "workspace");
  const spawnLog = path.join(fixture, "worker-spawns.log");
  const workerPidFile = path.join(fixture, "worker-pid.txt");
  const workerGate = path.join(fixture, "worker-gate");
  const workerWrapper = path.join(fixture, "worker-wrapper.mjs");
  for (const directory of [root, settingsDirectory, workspace, tempDirectory]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(spawnLog, "", "utf8");
  writeFileSync(workerWrapper, [
    'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(spawnLog)}, "spawn\\n");`,
    `writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid), "utf8");`,
    `const gate = ${JSON.stringify(workerGate)};`,
    "const deadline = Date.now() + 60_000;",
    "while (!existsSync(gate) && Date.now() < deadline) {",
    "  await new Promise((resolve) => setTimeout(resolve, 25));",
    "}",
    "if (!existsSync(gate)) process.exit(70);",
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
    ZCODE_BRIDGE_TASK_CONSOLE: "off",
  };
  delete env.ZCODE_BRIDGE_DATA_DIR;
  delete env.ZCODE_BRIDGE_PLUGIN_MODE;
  // A host session (for example a ZCode Desktop agent shell) may export its own
  // ZCODE_DATA_BASE_DIR/ZCODE_WINDOWS_APP_INSTALL_DIR. Both would fight the
  // fixture's ZCODE_HOME and redirect install discovery at the real Desktop.
  delete env.ZCODE_DATA_BASE_DIR;
  delete env.ZCODE_WINDOWS_APP_INSTALL_DIR;

  assert.equal(existsSync(shippedBridgeEntry), true, "the shipped MCP Host artifact must exist");
  const executor = startExecutor(root, "100", settingsDirectory, {
    workerEntryPath: workerWrapper,
    env,
  });
  const ready = await executor.ready;
  const directClient = new ExecutorControlClient({ pipeName: ready.pipe_name, connectTimeoutMs: 5_000 });
  let host: ReturnType<typeof startThinMcp> | undefined;
  let reconnectHost: ReturnType<typeof startThinMcp> | undefined;
  let workerPid: number | undefined;
  let succeeded = false;
  try {
    const taskId = `host-exit-${Date.now()}`;
    host = startThinMcp(env, shippedBridgeEntry);
    host.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "host-exit", version: "1" } },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "",
    ].join("\n"));
    assert.ok((await host.waitForResponse(1)).result);
    host.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: {
          name: "zcode_task",
          arguments: {
            task_id: taskId,
            workspace,
            objective: "Prove Host process exit preserves the accepted Attempt",
            requirements: ["Use only the synthetic Worker"],
            allowed_paths: [],
            forbidden_paths: [],
            acceptance_criteria: ["Commit exactly one original Attempt Result"],
            test_commands: [],
          },
        },
      }),
      "",
    ].join("\n"));
    const accepted = await host.waitForResponse(2) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(accepted.result?.isError, true, host.stderr());
    assert.equal(accepted.result?.structuredContent?.task_id, taskId);

    await directClient.connect();
    await waitForLifecycleEvent(directClient, taskId, "launch_intent");
    workerPid = Number(await waitForTextFile(workerPidFile, 10_000));
    assert.equal(Number.isSafeInteger(workerPid) && workerPid > 0, true);
    host.child.kill();
    const hostExit = await Promise.race([
      host.exit,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error(`HOST_EXIT_TIMEOUT\n${host!.stderr()}`)),
        15_000,
      )),
    ]);
    assert.ok(hostExit.code !== 0 || hostExit.signal !== null, host.stderr());

    const health = await directClient.request("health", {});
    assert.equal(health.ok, true);
    assert.equal(health.executor_state.state, "active");

    writeFileSync(workerGate, "continue", "utf8");
    await waitForLifecycleEvent(directClient, taskId, "released");
    await waitForProcessExit(workerPid, 30_000);
    await waitForExecutorWakeEvent(directClient, taskId, "web_notify");
    const resultResponse = await directClient.request("getResult", { task_id: taskId });
    assert.equal(resultResponse.ok, true);
    assert.equal((resultResponse.result as { status?: unknown }).status, "completed");
    assert.equal((resultResponse.result as { attempt?: unknown }).attempt, 1);

    const listResponse = await directClient.request("listTasks", { limit: 100 });
    assert.equal(listResponse.ok, true);
    const listed = (listResponse.result as {
      tasks?: Array<{ task_id?: string; wake?: { state?: string; reason_code?: string; at?: string } }>;
    });
    const listedTask = listed.tasks?.find((task) => task.task_id === taskId);
    assert.equal(listedTask?.wake?.state, "web_notify");
    assert.equal(listedTask?.wake?.reason_code, "owner_thread_unavailable");
    assert.equal(typeof listedTask?.wake?.at, "string");

    const spawns = readFileSync(spawnLog, "utf8").split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(spawns, ["spawn"]);
    const modules = await loadLifecycleCandidateModules();
    const recovery = modules.Store.openForRecovery(root, {
      databaseFileName: "bridge.sqlite",
      managedDataDirectory: true,
    });
    assert.ok(recovery);
    try {
      const snapshot = modules.createPort(recovery).readRecoverySnapshot() as {
        operations: Array<Record<string, unknown>>;
        events: Array<{ event_type: string; operation_id: string }>;
      };
      const operation = snapshot.operations.find((item) => item.task_id === taskId);
      assert.ok(operation);
      assert.equal(operation.phase, "released");
      assert.notEqual(operation.result_digest, null);
      assert.equal(operation.result_status, "completed");
      const eventTypes = snapshot.events
        .filter((event) => event.operation_id === operation.operation_id)
        .map((event) => event.event_type);
      for (const expected of ["launch_intent", "result_committed", "cleanup_verified", "released"]) {
        assert.equal(eventTypes.filter((event) => event === expected).length, 1, expected);
      }
    } finally {
      recovery.close();
    }

    reconnectHost = startThinMcp(env, shippedBridgeEntry);
    reconnectHost.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "host-exit-reconnect", version: "1" } },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "",
    ].join("\n"));
    assert.ok((await reconnectHost.waitForResponse(1)).result);
    reconnectHost.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "zcode_result", arguments: { task_id: taskId } },
      }),
      "",
    ].join("\n"));
    const reconnectResult = await reconnectHost.waitForResponse(2) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(reconnectResult.result?.isError, true, reconnectHost.stderr());
    assert.equal(reconnectResult.result?.structuredContent?.task_id, taskId);
    assert.equal(reconnectResult.result?.structuredContent?.attempt, 1);
    reconnectHost.child.stdin.end();
    const reconnectExit = await Promise.race([
      reconnectHost.exit,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error(`HOST_RECONNECT_EXIT_TIMEOUT\n${reconnectHost!.stderr()}`)),
        15_000,
      )),
    ]);
    assert.equal(reconnectExit.code, 0, reconnectHost.stderr());
    succeeded = true;
  } finally {
    host?.child.kill();
    reconnectHost?.child.kill();
    directClient.close();
    executor.child.kill("SIGKILL");
    await executor.exit;
    if (workerPid !== undefined) {
      try {
        process.kill(workerPid, "SIGKILL");
        await waitForProcessExit(workerPid, 5_000);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (succeeded) {
      rmSync(fixture, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    } else {
      console.error(`host-exit fixture retained: ${fixture}`);
    }
  }
});

test("Thin MCP -> Executor -> Worker -> Official Adapter completes against a controlled app-server", {
  timeout: 180_000,
  skip: process.platform !== "win32" || process.arch !== "x64",
}, async () => {
  const fixtureBase = process.env.LOCALAPPDATA && path.isAbsolute(process.env.LOCALAPPDATA)
    ? path.join(process.env.LOCALAPPDATA, "Temp")
    : tmpdir();
  mkdirSync(fixtureBase, { recursive: true });
  const fixture = mkdtempSync(path.join(fixtureBase, "executor-four-layer-"));
  const localAppData = path.join(fixture, "local-app-data");
  const userProfile = path.join(fixture, "user-profile");
  const tempDirectory = path.join(fixture, "temp");
  const root = path.join(localAppData, "CodexZCodeBridge", "state");
  const settingsDirectory = path.join(userProfile, ".codex", "codex-zcode-bridge");
  const workspace = path.join(fixture, "workspace");
  const spawnLog = path.join(fixture, "worker-spawns.log");
  const workerWrapper = path.join(fixture, "worker-wrapper.mjs");
  for (const directory of [root, settingsDirectory, workspace, tempDirectory]) mkdirSync(directory, { recursive: true });
  const runtime = writeFakeRuntime(`executor-four-layer-${randomUUID()}`, "success");
  writeFileSync(path.join(runtime.runtimeRoot, "loopback-interaction"), "1", "utf8");
  writeFileSync(path.join(runtime.runtimeRoot, "loopback-requests.jsonl"), "", "utf8");
  writeFileSync(spawnLog, "", "utf8");
  writeFileSync(workerWrapper, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(spawnLog)}, "spawn\\n");`,
    `await import(${JSON.stringify(pathToFileURL(officialHostWorkerEntryPath).href)});`,
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
    ZCODE_BRIDGE_TASK_CONSOLE: "off",
    ZCODE_BRIDGE_ZCODE_CJS: runtime.entrypoint,
    ZCODE_BRIDGE_NODE: process.execPath,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: runtime.builtinConfig,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: runtime.personalConfig,
    ZCODE_HOME: path.dirname(runtime.zcodeHomeV2),
  };
  delete env.ZCODE_BRIDGE_DATA_DIR;
  delete env.ZCODE_BRIDGE_PLUGIN_MODE;
  // A host session (for example a ZCode Desktop agent shell) may export its own
  // ZCODE_DATA_BASE_DIR/ZCODE_WINDOWS_APP_INSTALL_DIR. Both would fight the
  // fixture's ZCODE_HOME and redirect install discovery at the real Desktop.
  delete env.ZCODE_DATA_BASE_DIR;
  delete env.ZCODE_WINDOWS_APP_INSTALL_DIR;

  const executor = startExecutor(root, "100", settingsDirectory, {
    workerEntryPath: workerWrapper,
    env,
    fakeAdapter: false,
  });
  const ready = await executor.ready;
  const client = new ExecutorControlClient({ pipeName: ready.pipe_name, connectTimeoutMs: 5_000 });
  let firstSession: ReturnType<typeof startThinMcp> | undefined;
  let secondSession: ReturnType<typeof startThinMcp> | undefined;
  let succeeded = false;
  try {
    const taskId = `four-layer-${Date.now()}`;
    firstSession = startThinMcp(env);
    firstSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "four-layer", version: "1" } },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "",
    ].join("\n"));
    assert.ok((await firstSession.waitForResponse(1)).result);
    firstSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: {
          name: "zcode_task",
          arguments: {
            task_id: taskId,
            workspace,
            objective: "Exercise the four-layer executor architecture",
            requirements: ["Use the controlled fake app-server"],
            allowed_paths: [],
            forbidden_paths: [],
            acceptance_criteria: ["Persist one original Attempt Result"],
            test_commands: [],
          },
        },
      }),
      "",
    ].join("\n"));
    const created = await firstSession.waitForResponse(2) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(created.result?.isError, true, firstSession.stderr());
    assert.equal(created.result?.structuredContent?.task_id, taskId);
    assert.equal(created.result?.structuredContent?.status, "queued");

    // Disconnect the MCP wire while the accepted Worker is still waiting for
    // its real Adapter permission interaction.
    firstSession.child.stdin.end();
    const firstExit = await Promise.race([
      firstSession.exit,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error(`FOUR_LAYER_MCP_EXIT_TIMEOUT\n${firstSession!.stderr()}`)),
        15_000,
      )),
    ]);
    assert.equal(firstExit.code, 0, firstSession.stderr());

    await client.connect();
    const interaction = await waitForInteractionRequest(client, taskId);
    const details = interaction.details as Record<string, unknown>;
    const payload = details.payload as Record<string, unknown> | undefined;
    const requestId = String(details.request_id ?? payload?.request_id ?? "permission-1");
    const reply = await client.request("replyToInteraction", {
      input: { task_id: taskId, request_id: requestId, decision: "allow" },
    });
    assert.equal(reply.ok, true);
    await waitForLifecycleEvent(client, taskId, "released");

    secondSession = startThinMcp(env);
    secondSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "four-layer-reconnect", version: "1" } },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "",
    ].join("\n"));
    assert.ok((await secondSession.waitForResponse(3)).result);
    secondSession.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "zcode_result", arguments: { task_id: taskId } },
      }),
      "",
    ].join("\n"));
    const result = await secondSession.waitForResponse(4) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    assert.notEqual(result.result?.isError, true, secondSession.stderr());
    assert.equal(result.result?.structuredContent?.task_id, taskId);
    assert.equal(result.result?.structuredContent?.status, "completed");
    assert.equal(result.result?.structuredContent?.attempt, 1);

    const spawns = readFileSync(spawnLog, "utf8").split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(spawns, ["spawn"]);
    const requests = readFileSync(path.join(runtime.runtimeRoot, "loopback-requests.jsonl"), "utf8")
      .trim().split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(requests.filter((message) => message.method === "session/create").length, 1);
    assert.equal(requests.filter((message) => message.method === "session/send").length, 1);

    const modules = await loadLifecycleCandidateModules();
    const recovery = modules.Store.openForRecovery(root, {
      databaseFileName: "bridge.sqlite",
      managedDataDirectory: true,
    });
    assert.ok(recovery);
    try {
      const snapshot = modules.createPort(recovery).readRecoverySnapshot() as {
        operations: Array<Record<string, unknown>>;
        events: Array<{ event_type: string; operation_id: string }>;
      };
      const operation = snapshot.operations.find((item) => item.task_id === taskId);
      assert.ok(operation);
      assert.equal(operation.phase, "released");
      assert.notEqual(operation.result_digest, null);
      const events = snapshot.events.filter((event) => event.operation_id === operation.operation_id)
        .map((event) => event.event_type);
      for (const expected of ["claim_committed", "launch_intent", "result_committed", "cleanup_verified", "released"]) {
        assert.equal(events.includes(expected), true, `missing ${expected}`);
      }
      assert.equal(events.filter((event) => event === "result_committed").length, 1);
      assert.equal(events.filter((event) => event === "launch_intent").length, 1);
    } finally {
      recovery.close();
    }

    secondSession.child.stdin.end();
    const secondExit = await Promise.race([
      secondSession.exit,
      new Promise<never>((_resolve, reject) => setTimeout(
        () => reject(new Error(`FOUR_LAYER_RECONNECT_EXIT_TIMEOUT\n${secondSession!.stderr()}`)),
        15_000,
      )),
    ]);
    assert.equal(secondExit.code, 0, secondSession.stderr());
    succeeded = true;
  } finally {
    firstSession?.child.kill();
    secondSession?.child.kill();
    client.close();
    if (!succeeded) {
      console.error(`four-layer executor stderr:\n${executor.stderr()}`);
      if (existsSync(runtime.requestLog)) {
        console.error(`four-layer runtime requests:\n${readFileSync(runtime.requestLog, "utf8")}`);
      }
      if (existsSync(runtime.exitLog)) {
        console.error(`four-layer runtime exit:\n${readFileSync(runtime.exitLog, "utf8")}`);
      }
    }
    executor.child.kill("SIGKILL");
    await executor.exit;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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
      const response: ExecutorControlResponse = await client.request("getStatus", { task_id: taskId });
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
    await waitForExecutorWakeEvent(client, taskId, "web_notify");

    const modules = await loadLifecycleCandidateModules();
    const recovery = modules.Store.openForRecovery(root, { databaseFileName: "bridge.sqlite", managedDataDirectory: true });
    assert.ok(recovery, "the synthetic Executor root must remain readable after the Worker exits");
    try {
      const snapshot = modules.createPort(recovery).readRecoverySnapshot() as {
        operations: Array<Record<string, unknown>>;
        events: Array<{ event_type: string; operation_id: string; evidence_json: string }>;
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
      const wakeEvents = snapshot.events.filter((event) => {
        if (event.operation_id !== operation.operation_id || event.event_type !== "observation_recorded") return false;
        return (JSON.parse(event.evidence_json) as { reason?: unknown }).reason === "executor_wake";
      });
      assert.equal(wakeEvents.length, 1);
      const wake = JSON.parse(wakeEvents[0]!.evidence_json) as Record<string, unknown>;
      assert.equal(wake.state, "web_notify");
      assert.equal(wake.reason_code, "owner_thread_unavailable");
      assert.equal(wake.thread_id, null);
      assert.equal(operation.phase, "released");
      assert.equal(operation.result_status, "completed");
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

test("thin MCP automatically recovers an unavailable Executor before serving a read", {
  skip: process.platform !== "win32",
  timeout: 90_000,
}, async () => {
  const fixtureBase = process.env.LOCALAPPDATA
    && path.isAbsolute(process.env.LOCALAPPDATA)
    ? path.join(process.env.LOCALAPPDATA, "Temp")
    : tmpdir();
  mkdirSync(fixtureBase, { recursive: true });
  const fixture = mkdtempSync(path.join(fixtureBase, "executor-thin-auto-recovery-"));
  const localAppData = path.join(fixture, "local-app-data");
  const userProfile = path.join(fixture, "user-profile");
  const tempDirectory = path.join(fixture, "temp");
  const root = path.join(localAppData, "CodexZCodeBridge", "state");
  const settingsDirectory = path.join(userProfile, ".codex", "codex-zcode-bridge");
  for (const directory of [root, settingsDirectory, tempDirectory]) mkdirSync(directory, { recursive: true });
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
  let session: ReturnType<typeof startThinMcp> | undefined;
  let recoveredPid: number | undefined;
  let client: ExecutorControlClient | undefined;
  try {
    session = startThinMcp(env);
    session.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "auto-recovery", version: "0.0.0" } },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "",
    ].join("\n"));
    assert.ok((await session.waitForResponse(1)).result);
    session.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "zcode_status", arguments: { task_id: "ghost-after-crash" } },
      }),
      "",
    ].join("\n"));
    const response = await session.waitForResponse(2) as {
      result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } };
    };
    assert.equal(response.result?.isError, true, session.stderr());
    assert.equal(response.result?.structuredContent?.error?.code, "TASK_NOT_FOUND");
    assert.match(session.stderr(), /EXECUTOR_START_RECOVERED/u);
    const lease = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8")) as {
      owner?: { process_id?: number };
    };
    recoveredPid = lease.owner?.process_id;
    assert.ok(Number.isSafeInteger(recoveredPid));
    const firstProcessId = recoveredPid!;
    process.kill(firstProcessId, "SIGKILL");
    await waitForProcessExit(firstProcessId, 15_000);
    recoveredPid = undefined;
    await new Promise((resolve) => setTimeout(resolve, 200));

    session.child.stdin.write([
      JSON.stringify({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "zcode_status", arguments: { task_id: "ghost-after-crash" } },
      }),
      "",
    ].join("\n"));
    const recovered = await session.waitForResponse(3) as {
      result?: { isError?: boolean; structuredContent?: { error?: { code?: string } } };
    };
    assert.equal(recovered.result?.isError, true, session.stderr());
    assert.equal(recovered.result?.structuredContent?.error?.code, "TASK_NOT_FOUND");
    assert.match(session.stderr(), /EXECUTOR_LEASE_RECOVERED/u);
    const recoveredLease = JSON.parse(readFileSync(path.join(root, EXECUTOR_LEASE_FILE), "utf8")) as {
      owner?: { process_id?: number };
    };
    recoveredPid = recoveredLease.owner?.process_id;
    assert.ok(Number.isSafeInteger(recoveredPid));
    assert.notEqual(recoveredPid, firstProcessId);
    client = new ExecutorControlClient({ pipeName: executorPipeName(root), connectTimeoutMs: 3_000 });
    await client.connect();
    const shutdown = await client.request("shutdown", {});
    assert.equal(shutdown.ok, true);
    const deadline = Date.now() + 15_000;
    while (existsSync(path.join(root, EXECUTOR_LEASE_FILE)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(path.join(root, EXECUTOR_LEASE_FILE)), false);
    await waitForProcessExit(recoveredPid!, 15_000);
    recoveredPid = undefined;
    session.child.stdin.end();
    const exit = await session.exit;
    assert.equal(exit.code, 0, session.stderr());
  } finally {
    client?.close();
    session?.child.kill();
    if (recoveredPid !== undefined) {
      try { process.kill(recoveredPid, "SIGKILL"); } catch { /* already exited */ }
      await waitForProcessExit(recoveredPid, 15_000).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    rmSync(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
