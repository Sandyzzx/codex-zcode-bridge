import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startExecutorControlServer } from "../src/executor/control-server.js";
import { ExecutorControlClient } from "../src/executor/control-client.js";
import type {
  ExecutorControlMethod,
  ExecutorControlParamsByMethod,
  ExecutorControlResponse,
} from "../src/executor/protocol.js";
import { executorPipeName } from "../src/executor/pipe.js";
import { RemoteTaskManager } from "../src/executor/remote-task-manager.js";
import { runTaskCli, type TaskCliIo } from "../src/cli/main.js";
import type { ProgressTaskManager, TaskPackage, TaskStatusRecord } from "../src/interfaces.js";
import type { ExecutorTaskManagement, ListTasksInput, TaskListPage } from "../src/task-list.js";

function io(): { stream: TaskCliIo; stdout: () => string; stderr: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    stream: {
      stdout: (text) => { stdout += text; },
      stderr: (text) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function response(result: Record<string, unknown>): ExecutorControlResponse {
  return {
    protocol_version: 1,
    request_id: "test",
    ok: true,
    result,
    executor_state: { state: "active", lease_id: "lease-test" },
  };
}

function fakeClient(handler: (method: ExecutorControlMethod, params: unknown) => ExecutorControlResponse) {
  return {
    async connect() {},
    async request<M extends ExecutorControlMethod>(
      method: M,
      params: ExecutorControlParamsByMethod[M],
    ): Promise<ExecutorControlResponse> {
      return handler(method, params);
    },
    close() {},
  };
}

function status(taskId: string): TaskStatusRecord {
  return {
    task_id: taskId,
    status: "completed",
    attempt: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:01:00Z",
    started_at: "2026-01-01T00:00:10Z",
    finished_at: "2026-01-01T00:00:50Z",
    worker_pid: null,
    zcode_session_id: null,
    exit_code: 0,
  };
}

function result(taskId: string, size = 0) {
  return {
    task_id: taskId,
    status: "completed" as const,
    summary: "completed",
    files_changed: [],
    tests: [],
    issues: [],
    needs_master_decision: false,
    zcode_output: "x".repeat(size),
    exit_code: 0,
    session_id: null,
    attempt: 1,
    started_at: "2026-01-01T00:00:10Z",
    finished_at: "2026-01-01T00:00:50Z",
  };
}

function manager(workspace: string): ProgressTaskManager & ExecutorTaskManagement {
  const records = new Map<string, TaskStatusRecord>();
  return {
    async createTask(task: TaskPackage) {
      records.set(task.task_id, status(task.task_id));
      return { task_id: task.task_id, status: "queued", created_at: "2026-01-01T00:00:00Z" };
    },
    async getStatus(taskId) {
      return records.get(taskId) ?? status(taskId);
    },
    async getResult(taskId) { return result(taskId); },
    async continueTask() { throw Object.assign(new Error("unused"), { code: "TASK_STATE" }); },
    async cancelTask(taskId) { return status(taskId); },
    async getEvents() { return { task_id: "task", status: "completed" as const, events: [], next_seq: 0, has_more: false }; },
    async replyToInteraction() { return { task_id: "task", request_id: "req", state: "answered" as const }; },
    async listTasks(input: ListTasksInput): Promise<TaskListPage> {
      const ids = [...records.keys()].sort();
      const after = input.after_task_id ?? "";
      const visible = ids.filter((id) => id > after).slice(0, input.limit ?? 50);
      return {
        tasks: visible.map((task_id) => ({
          task_id,
          status: "queued" as const,
          attempt: 1,
          created_at: "2026-01-01T00:00:00Z",
          workspace,
          objective: "ACK",
        })),
        next_task_id: visible.length > 0 ? visible.at(-1)! : null,
        has_more: ids.filter((id) => id > after).length > visible.length,
      };
    },
  };
}

test("Task CLI parses bounded task list and status operations", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-cli-unit-"));
  const output = io();
  let seen: { method: string; params: unknown } | undefined;
  try {
    const code = await runTaskCli([
      "task", "list", "--after-task-id", "task-a", "--limit", "2", "--status", "queued",
      "--data-root", root,
    ], output.stream, {
      createClient: () => fakeClient((method, params) => {
        seen = { method, params };
        return response({
          tasks: [{
            task_id: "task-b",
            status: "queued",
            attempt: 1,
            created_at: "2026-01-01T00:00:00Z",
            workspace: root,
            objective: "ACK",
            wake: { state: "web_notify", reason_code: "policy_missing", at: "2026-01-01T00:01:00Z" },
          }],
          next_task_id: "task-b",
          has_more: false,
        });
      }),
    });
    assert.equal(code, 0);
    assert.deepEqual(seen, {
      method: "listTasks",
      params: { after_task_id: "task-a", limit: 2, status: "queued" },
    });
    const listed = JSON.parse(output.stdout()) as {
      next_task_id: string;
      tasks: Array<{ wake?: { state?: string; reason_code?: string } }>;
    };
    assert.equal(listed.next_task_id, "task-b");
    assert.deepEqual(listed.tasks[0]?.wake, {
      state: "web_notify",
      reason_code: "policy_missing",
      at: "2026-01-01T00:01:00Z",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task CLI wake-authorize writes one exact Owner policy and refuses overwrite", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-cli-wake-authorize-"));
  const fixedNow = Date.parse("2026-11-22T00:00:00.000Z");
  const dependencies = {
    now: () => fixedNow,
    createClient: () => fakeClient((method) => {
      assert.equal(method, "listTasks");
      return response({
        tasks: [{
          task_id: "task-wake-cli",
          status: "running",
          attempt: 2,
          created_at: "2026-11-21T23:00:00.000Z",
          workspace: root,
          objective: "Wake authorization fixture",
        }],
        next_task_id: null,
        has_more: false,
      });
    }),
  };
  try {
    const output = io();
    const code = await runTaskCli([
      "task", "wake-authorize", "task-wake-cli",
      "--attempt", "2",
      "--thread", "019c0000-0000-7000-8000-000000000001",
      "--model", "deepseek-v4.1-flash",
      "--model-provider", "deepseek",
      "--reasoning-effort", "low",
      "--expires-in-minutes", "30",
      "--confirm-owner",
      "--data-root", root,
    ], output.stream, dependencies);
    assert.equal(code, 0, output.stderr());
    const written = JSON.parse(output.stdout()) as Record<string, unknown>;
    assert.equal(written.task_id, "task-wake-cli");
    assert.equal(written.attempt, 2);
    assert.equal(written.authorization_scope, "one_turn");
    assert.equal(written.authorization_expires_at, "2026-11-22T00:30:00.000Z");
    const policy = JSON.parse(readFileSync(path.join(root, "wake-policy.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(policy.authorization, {
      scope: "one_turn",
      granted_by: "owner",
      granted_at: "2026-11-22T00:00:00.000Z",
      expires_at: "2026-11-22T00:30:00.000Z",
    });
    assert.equal(policy.fallback, "web_notify");
    assert.equal(String(policy.workspace).toLowerCase(), root.toLowerCase());

    const repeated = io();
    const repeatedCode = await runTaskCli([
      "task", "wake-authorize", "task-wake-cli",
      "--attempt", "2",
      "--thread", "019c0000-0000-7000-8000-000000000001",
      "--model", "deepseek-v4.1-flash",
      "--model-provider", "deepseek",
      "--reasoning-effort", "low",
      "--expires-in-minutes", "30",
      "--confirm-owner",
      "--data-root", root,
    ], repeated.stream, dependencies);
    assert.equal(repeatedCode, 1);
    assert.match(repeated.stderr(), /WAKE_POLICY_EXISTS/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task CLI wake-authorize requires owner confirmation and the exact current Attempt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-cli-wake-guard-"));
  const dependencies = {
    createClient: () => fakeClient((method) => {
      assert.equal(method, "listTasks");
      return response({
        tasks: [{
          task_id: "task-wake-guard",
          status: "queued",
          attempt: 1,
          created_at: "2026-11-21T23:00:00.000Z",
          workspace: root,
          objective: "Wake authorization guard",
        }],
        next_task_id: null,
        has_more: false,
      });
    }),
  };
  try {
    const noOwner = io();
    const noOwnerCode = await runTaskCli([
      "task", "wake-authorize", "task-wake-guard",
      "--attempt", "1",
      "--thread", "019c0000-0000-7000-8000-000000000001",
      "--model", "deepseek-v4.1-flash",
      "--model-provider", "deepseek",
      "--reasoning-effort", "low",
      "--expires-in-minutes", "30",
      "--data-root", root,
    ], noOwner.stream, dependencies);
    assert.equal(noOwnerCode, 2);
    assert.match(noOwner.stderr(), /--confirm-owner/u);
    assert.equal(existsSync(path.join(root, "wake-policy.json")), false);

    const mismatch = io();
    const mismatchCode = await runTaskCli([
      "task", "wake-authorize", "task-wake-guard",
      "--attempt", "2",
      "--thread", "019c0000-0000-7000-8000-000000000001",
      "--model", "deepseek-v4.1-flash",
      "--model-provider", "deepseek",
      "--reasoning-effort", "low",
      "--expires-in-minutes", "30",
      "--confirm-owner",
      "--data-root", root,
    ], mismatch.stream, dependencies);
    assert.equal(mismatchCode, 1);
    assert.match(mismatch.stderr(), /WAKE_ATTEMPT_MISMATCH/u);
    assert.equal(existsSync(path.join(root, "wake-policy.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task CLI keeps full Results off stdout unless explicitly bounded to a file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-cli-result-"));
  try {
    const summaryIo = io();
    const summaryCode = await runTaskCli(["task", "result", "task-a", "--data-root", root], summaryIo.stream, {
      createClient: () => fakeClient(() => response(result("task-a", 4_096))),
    });
    assert.equal(summaryCode, 0);
    const summary = JSON.parse(summaryIo.stdout()) as { projection?: { omitted_fields?: string[] } };
    assert.ok(summary.projection?.omitted_fields?.includes("zcode_output"));

    const fullIo = io();
    const fullCode = await runTaskCli([
      "task", "result", "task-a", "--view", "full", "--data-root", root,
    ], fullIo.stream, {
      createClient: () => fakeClient(() => response(result("task-a", 1024 * 1024))),
    });
    assert.equal(fullCode, 1);
    assert.match(fullIo.stderr(), /RESULT_OUTPUT_BOUNDED/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task CLI uses the same Executor Manager concurrently with the MCP remote adapter", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-cli-concurrent-"));
  const pipe = executorPipeName(root);
  const authority = manager(root);
  const server = await startExecutorControlServer({
    pipeName: pipe,
    manager: authority,
    leaseId: "lease-test",
  });
  const client = new ExecutorControlClient({ pipeName: pipe });
  const remote = new RemoteTaskManager(client);
  try {
    await remote.createTask({
      task_id: "task-concurrent",
      workspace: root,
      objective: "ACK",
      requirements: [],
      allowed_paths: [],
      forbidden_paths: [],
      acceptance_criteria: [],
      test_commands: [],
    });
    const output = io();
    const [mcpStatus, cliCode] = await Promise.all([
      remote.getStatus("task-concurrent"),
      runTaskCli(["task", "status", "task-concurrent", "--data-root", root], output.stream),
    ]);
    assert.equal(mcpStatus.task_id, "task-concurrent");
    assert.equal(cliCode, 0);
    assert.equal((JSON.parse(output.stdout()) as TaskStatusRecord).task_id, "task-concurrent");
  } finally {
    client.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task CLI start and stop use Executor Control without auto-spawning twice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-cli-start-"));
  let connects = 0;
  let spawned = 0;
  let spawnedInput: { readonly acceptUnleasedTransition?: true } | undefined;
  try {
    const startIo = io();
    const startCode = await runTaskCli([
      "executor", "start", "--timeout-ms", "2000", "--accept-unleased-transition", "--data-root", root,
      "--settings-directory", root,
    ], startIo.stream, {
      spawnExecutor: (input) => {
        spawned += 1;
        spawnedInput = input;
        return { pid: 1234 };
      },
      createClient: () => fakeClient(() => {
        connects += 1;
        if (connects === 1) throw Object.assign(new Error("not ready"), { code: "EXECUTOR_UNAVAILABLE" });
        return response({ state: "active", lease_id: "lease", idle: true, blockers: [] });
      }),
      sleep: async () => undefined,
    });
    assert.equal(startCode, 0);
    assert.equal(spawned, 1);
    assert.equal(spawnedInput?.acceptUnleasedTransition, true);

    const pipe = executorPipeName(root);
    let server: Awaited<ReturnType<typeof startExecutorControlServer>> | undefined;
    server = await startExecutorControlServer({
      pipeName: pipe,
      manager: manager(root),
      leaseId: "lease",
      executorIdleState: () => ({ idle: true, blockers: [] }),
      prepareShutdown: () => ({ status: "accepted", blockers: [] }),
      onShutdownAccepted: () => { void server!.close(); },
    });
    const stopIo = io();
    const stopCode = await runTaskCli(["executor", "stop", "--data-root", root], stopIo.stream);
    assert.equal(stopCode, 0);
    const stopped = JSON.parse(stopIo.stdout()) as { status?: string; state?: string };
    assert.ok(stopped.status === "closed" || stopped.state === "still_running");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task CLI start does not spawn when the Executor is already active", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-cli-already-running-"));
  const output = io();
  let spawned = 0;
  try {
    const code = await runTaskCli([
      "executor", "start", "--data-root", root, "--settings-directory", root,
    ], output.stream, {
      createClient: () => fakeClient(() => response({
        state: "active",
        lease_id: "lease-existing",
        idle: true,
        blockers: [],
      })),
      spawnExecutor: () => {
        spawned += 1;
        return { pid: 1234 };
      },
    });
    assert.equal(code, 0);
    assert.equal(spawned, 0);
    const value = JSON.parse(output.stdout()) as { status?: string; lease_id?: string };
    assert.equal(value.status, "already_running");
    assert.equal(value.lease_id, "lease-existing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task CLI stop returns nonzero when Executor shutdown remains unknown", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-cli-stop-unknown-"));
  const output = io();
  try {
    const code = await runTaskCli([
      "executor", "stop", "--timeout-ms", "500", "--data-root", root,
    ], output.stream, {
      createClient: () => fakeClient((method) => method === "shutdown"
        ? response({ status: "accepted", blockers: [] })
        : response({ state: "shutdown_pending", lease_id: "lease", idle: true, blockers: [] })),
    });
    assert.equal(code, 1);
    const value = JSON.parse(output.stdout()) as { status?: string; state?: string; reason?: string };
    assert.equal(value.status, "closed");
    assert.equal(value.state, "unknown");
    assert.equal(value.reason, "shutdown_timeout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Task CLI refuses lease clear without explicit owner-exit acknowledgement", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-cli-lease-"));
  const output = io();
  try {
    const code = await runTaskCli(["executor", "lease", "clear", "--data-root", root], output.stream);
    assert.equal(code, 2);
    assert.match(output.stderr(), /--confirm-owner-exited/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
