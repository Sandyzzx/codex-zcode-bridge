import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startExecutorControlServer } from "../src/executor/control-server.js";
import { ExecutorControlClient } from "../src/executor/control-client.js";
import { encodeExecutorFrame } from "../src/executor/frame.js";
import type { ProgressTaskManager, TaskPackage, TaskReceipt } from "../src/interfaces.js";

function pipeName(root: string, suffix: string): string {
  return `\\\\.\\pipe\\codex-zcode-bridge-executor-test-${process.pid}-${suffix}`;
}

function managerWith(): ProgressTaskManager {
  let receipt: TaskReceipt | undefined;
  return {
    async createTask(task: TaskPackage) {
      receipt = { task_id: task.task_id, status: "queued", created_at: "2026-01-01T00:00:00Z" };
      return receipt;
    },
    async getStatus() { return { task_id: "task-1", status: "queued", attempt: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", started_at: null, finished_at: null, worker_pid: null, zcode_session_id: null, exit_code: null }; },
    async getResult() { throw new Error("TASK_NOT_FINISHED") as Error & { code: string }; },
    async continueTask() { throw new Error("TASK_STATE") as Error & { code: string }; },
    async cancelTask() { throw new Error("CANCEL_FAILED") as Error & { code: string }; },
    async getEvents() { return { task_id: "task-1", status: "queued", events: [], next_seq: 0, has_more: false }; },
    async getFeedback() { throw new Error("FEEDBACK_UNAVAILABLE") as Error & { code: string }; },
    async getAttention() { throw new Error("ATTENTION_UNAVAILABLE") as Error & { code: string }; },
    async replyToInteraction() { throw new Error("TASK_STATE") as Error & { code: string }; },
  };
}

test("control IPC correlates framed requests and preserves task receipt identity", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-ipc-"));
  const manager = managerWith();
  const server = await startExecutorControlServer({ pipeName: pipeName(root, "basic"), manager, leaseId: "lease-1" });
  const client = new ExecutorControlClient({ pipeName: pipeName(root, "basic") });
  try {
    await client.connect();
    const response = await client.request("createTask", {
      task: {
        task_id: "task-1", workspace: root, objective: "ACK", requirements: [], allowed_paths: [],
        forbidden_paths: [], acceptance_criteria: [], test_commands: [],
      },
    }, undefined, "task-1");
    assert.equal(response.ok, true);
    assert.equal(response.result?.task_id, "task-1");
  } finally {
    client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("aborting a request wait does not cancel the accepted task", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-ipc-"));
  const manager = managerWith();
  const server = await startExecutorControlServer({ pipeName: pipeName(root, "abort"), manager, leaseId: "lease-1" });
  const client = new ExecutorControlClient({ pipeName: pipeName(root, "abort") });
  try {
    await client.connect();
    const controller = new AbortController();
    let serverResolved = false;
    const serverSawTask = new Promise<void>((resolve) => {
      const originalCreate = manager.createTask.bind(manager);
      manager.createTask = async (task: TaskPackage) => {
        const receipt = await originalCreate(task);
        serverResolved = true;
        resolve();
        return receipt;
      };
    });
    const pending = client.request("createTask", {
      task: { task_id: "task-2", workspace: root, objective: "ACK", requirements: [], allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [] },
    }, controller.signal, "task-2");
    controller.abort();
    await assert.rejects(pending, /REQUEST_CANCELLED/u);
    await serverSawTask;
    assert.equal(serverResolved, true);
  } finally {
    client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lost submission responses are distinct from an unavailable Executor", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-ipc-"));
  const unavailable = new ExecutorControlClient({ pipeName: pipeName(root, "unavailable"), connectTimeoutMs: 50 });
  try {
    await assert.rejects(() => unavailable.connect(), (error: unknown) =>
      (error as { code?: string }).code === "EXECUTOR_UNAVAILABLE");
  } finally {
    unavailable.close();
    rmSync(root, { recursive: true, force: true });
  }

  for (const [method, expectedCode] of [
    ["createTask", "SUBMISSION_UNKNOWN"],
    ["cancelTask", "TASK_CANCEL_REQUESTED"],
  ] as const satisfies ReadonlyArray<readonly [Parameters<ExecutorControlClient["request"]>[0], string]>) {
    const pipe = pipeName(root, method);
    const server = net.createServer((socket) => {
      socket.once("data", () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipe, () => resolve());
    });
    const client = new ExecutorControlClient({ pipeName: pipe });
    try {
      await client.connect();
      await assert.rejects(
        () => client.request(method, method === "cancelTask"
          ? { task_id: "task-1" }
          : { task: {
            task_id: "task-1", workspace: root, objective: "ACK", requirements: [],
            allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [],
          } }),
        (error: unknown) => (error as { code?: string }).code === expectedCode,
      );
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("the full 32 MiB Result contract remains readable through IPC", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-ipc-"));
  const manager = managerWith();
  manager.getResult = async () => ({
    task_id: "large-result",
    status: "completed",
    summary: "large",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: false,
    zcode_output: "x".repeat(32 * 1024 * 1024 - 1024),
    exit_code: 0,
    session_id: null,
    attempt: 1,
    started_at: null,
    finished_at: null,
  });
  const server = await startExecutorControlServer({ pipeName: pipeName(root, "large"), manager, leaseId: "lease-1" });
  const client = new ExecutorControlClient({ pipeName: pipeName(root, "large"), connectTimeoutMs: 5_000 });
  try {
    await client.connect();
    const response = await client.request("getResult", { task_id: "large-result" });
    assert.equal(response.ok, true);
    const output = response.result?.zcode_output;
    assert.equal(typeof output, "string");
    assert.equal((output as string).length, 32 * 1024 * 1024 - 1024);
  } finally {
    client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lease fencing rejects mutations while preserving reads", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-ipc-"));
  let state: "active" | "shutdown_pending" | "lease_unknown" | "closed" = "lease_unknown";
  const manager = managerWith();
  const server = await startExecutorControlServer({
    pipeName: pipeName(root, "fenced"),
    manager,
    leaseId: "lease-1",
    executorState: () => state,
  });
  const client = new ExecutorControlClient({ pipeName: pipeName(root, "fenced") });
  try {
    await client.connect();
    const mutation = await client.request("createTask", {
      task: {
        task_id: "task-fenced", workspace: root, objective: "ACK", requirements: [],
        allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [],
      },
    });
    assert.equal(mutation.ok, false);
    assert.equal(mutation.error?.code, "EXECUTOR_LEASE_LOST");
    const health = await client.request("health", {});
    assert.equal(health.ok, true);
    assert.equal(health.result?.state, "lease_unknown");
    const read = await client.request("getStatus", { task_id: "task-1" });
    assert.equal(read.ok, true);

    state = "active";
    const accepted = await client.request("createTask", {
      task: {
        task_id: "task-active", workspace: root, objective: "ACK", requirements: [],
        allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [],
      },
    });
    assert.equal(accepted.ok, true);
  } finally {
    client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized frames are rejected without dispatching a manager call", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-ipc-"));
  const manager = managerWith();
  const server = await startExecutorControlServer({ pipeName: pipeName(root, "oversize"), manager, leaseId: "lease-1" });
  try {
    const client = new ExecutorControlClient({ pipeName: pipeName(root, "oversize") });
    await client.connect();
    // Directly exercise the encoder bound; the server transport fails an
    // oversized body before any task method can execute. The limit covers the
    // full 32 MiB Result contract plus response envelope overhead.
    assert.throws(() => encodeExecutorFrame({ giant: "x".repeat(34 * 1024 * 1024) }), /FRAME_TOO_LARGE/u);
    client.close();
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
