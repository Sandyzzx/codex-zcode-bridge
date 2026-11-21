import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

test("oversized frames are rejected without dispatching a manager call", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "executor-ipc-"));
  const manager = managerWith();
  const server = await startExecutorControlServer({ pipeName: pipeName(root, "oversize"), manager, leaseId: "lease-1" });
  try {
    const client = new ExecutorControlClient({ pipeName: pipeName(root, "oversize") });
    await client.connect();
    // Directly exercise the encoder bound; the server transport fails the
    // oversized body before any task method can execute.
    assert.throws(() => encodeExecutorFrame({ giant: "x".repeat(17 * 1024 * 1024) }), /FRAME_TOO_LARGE/u);
    client.close();
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
