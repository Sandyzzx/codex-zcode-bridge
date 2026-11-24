import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskPackage, TaskStatusRecord } from "../src/interfaces.js";
import type { ListTasksInput, TaskListPage } from "../src/task-list.js";
import { createTaskConsoleServer, type TaskConsoleManager } from "../src/web/server.js";
import {
  fetchTaskConsoleSession,
  inspectTaskConsoleDiscovery,
  publishTaskConsoleDiscovery,
  removeTaskConsoleDiscovery,
  TaskConsoleDiscoveryError,
} from "../src/web/discovery.js";
import { authorityRootDigest } from "../src/executor/lease.js";
import { createPlatformProbe } from "../src/runtime/process-probe.js";
import { startExecutorControlServer } from "../src/executor/control-server.js";
import { executorPipeName } from "../src/executor/pipe.js";
import { taskConsoleAutostartEnabled } from "../src/web/console-link.js";

test("Task Console autostart honors only explicit opt-out values", () => {
  assert.equal(taskConsoleAutostartEnabled({}), true);
  assert.equal(taskConsoleAutostartEnabled({ ZCODE_BRIDGE_TASK_CONSOLE: "auto" }), true);
  assert.equal(taskConsoleAutostartEnabled({ ZCODE_BRIDGE_TASK_CONSOLE: "ON" }), true);
  assert.equal(taskConsoleAutostartEnabled({ ZCODE_BRIDGE_TASK_CONSOLE: "off" }), false);
  assert.equal(taskConsoleAutostartEnabled({ ZCODE_BRIDGE_TASK_CONSOLE: " FALSE " }), false);
  assert.equal(taskConsoleAutostartEnabled({ ZCODE_BRIDGE_TASK_CONSOLE: "0" }), false);
});

function manager(): TaskConsoleManager & {
  readonly calls: { cancel: number; reply: number };
} {
  const calls = { cancel: 0, reply: 0 };
  const status = (taskId: string): TaskStatusRecord => ({
    task_id: taskId,
    status: "waiting_for_master",
    attempt: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:02:00Z",
    started_at: "2026-01-01T00:00:10Z",
    finished_at: null,
    worker_pid: 42,
    zcode_session_id: "session-1",
    exit_code: null,
  });
  return {
    calls,
    async listTasks(input: ListTasksInput): Promise<TaskListPage> {
      return {
        tasks: [{
          task_id: "task-a",
          status: "waiting_for_master",
          attempt: 2,
          created_at: "2026-01-01T00:00:00Z",
          workspace: "C:\\work",
          objective: "Inspect the durable result",
          wake: {
            state: "web_notify",
            reason_code: "owner_thread_unavailable",
            at: "2026-01-01T00:02:30Z",
          },
        }],
        next_task_id: null,
        has_more: false,
      };
    },
    async getStatus(taskId) {
      return status(taskId);
    },
    async getEvents() {
      return { task_id: "task-a", status: "waiting_for_master", events: [], next_seq: 0, has_more: false };
    },
    async getResult(taskId) {
      return {
        task_id: taskId,
        status: "waiting_for_master",
        summary: "Result is ready",
        files_changed: [],
        tests: [],
        issues: [],
        needs_master_decision: true,
        zcode_output: "evidence",
        exit_code: 0,
        session_id: "session-1",
        attempt: 2,
        started_at: "2026-01-01T00:00:10Z",
        finished_at: "2026-01-01T00:02:00Z",
      };
    },
    async cancelTask(taskId) {
      calls.cancel += 1;
      return { ...status(taskId), status: "cancelled" as const };
    },
    async replyToInteraction() {
      calls.reply += 1;
      return { task_id: "task-a", request_id: "request-a", state: "answered" as const };
    },
    async getAttention(taskId) {
      return {
        task_id: taskId,
        attempt: 2,
        status: "waiting_for_master" as const,
        pending_requests: ["request-a"],
      };
    },
  };
}

function controlManager() {
  const fixture = manager();
  return {
    ...fixture,
    async createTask(task: TaskPackage) {
      return {
        task_id: task.task_id,
        status: "queued" as const,
        created_at: "2026-01-01T00:00:00Z",
      };
    },
    async continueTask() {
      return {
        task_id: "task-a",
        status: "queued" as const,
        created_at: "2026-01-01T00:00:00Z",
      };
    },
  };
}

interface HttpResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly json: unknown;
}

function request(
  address: { readonly origin: string },
  path: string,
  options: { readonly method?: string; readonly body?: unknown; readonly headers?: http.OutgoingHttpHeaders } = {},
): Promise<HttpResponse> {
  const url = new URL(path, address.origin);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers: {
        Host: `127.0.0.1:${url.port}`,
        ...(body === undefined ? {} : {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        }),
        ...options.headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function replyJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

test("Web Console serves a loopback task inspection surface without mutations", async () => {
  const fixture = manager();
  const server = createTaskConsoleServer({ manager: fixture, executorStatus: async () => ({ state: "active", lease_id: "lease-a" }) });
  try {
    const address = await server.start();
    assert.equal(address.host, "127.0.0.1");
    const session = await request(address, "/api/session");
    assert.equal(session.status, 200);
    const sessionJson = session.json as { result: { csrf_token: string; executor: { state: string } } };
    assert.equal(sessionJson.result.executor.state, "active");
    assert.ok(sessionJson.result.csrf_token.length > 20);
    assert.equal(session.headers["x-frame-options"], "DENY");
    assert.match(String(session.headers["content-security-policy"]), /connect-src 'self'/u);

    const page = await request(address, "/");
    assert.equal(page.status, 200);
    assert.match(String(page.json), /Bridge Operations Console/u);
    assert.match(String(page.json), /id="language"/u);
    assert.match(String(page.json), /id="theme"/u);
    assert.match(String(page.json), /id="page-cost-lab"/u);
    assert.match(String(page.json), /id="page-runtime"/u);
    assert.match(String(page.json), /id="count-wake"/u);
    assert.match(String(page.json), /id="dashboard-wake"/u);
    const inlineScript = /<script>([\s\S]+)<\/script>/u.exec(String(page.json))?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new Function(inlineScript));

    const list = await request(address, "/api/tasks?limit=5");
    assert.equal(list.status, 200);
    const listed = (list.json as { result: { tasks: Array<{ wake?: Record<string, unknown> }> } }).result;
    assert.equal(listed.tasks.length, 1);
    assert.deepEqual(listed.tasks[0]?.wake, {
      state: "web_notify",
      reason_code: "owner_thread_unavailable",
      at: "2026-01-01T00:02:30Z",
    });

    const events = await request(address, "/api/tasks/task-a/events?limit=5&include_attempt=true");
    assert.equal(events.status, 200);
    const result = await request(address, "/api/tasks/task-a/result?view=summary");
    assert.equal(result.status, 200);
    assert.equal((result.json as { result: { task_id: string } }).result.task_id, "task-a");
    assert.equal(fixture.calls.cancel, 0);
  } finally {
    await server.close();
  }
});

test("Web Console Auto Wake setting defaults ON and persists a CSRF-protected toggle", async () => {
  const fixture = manager();
  const settingsDirectory = mkdtempSync(path.join(tmpdir(), "web-auto-wake-"));
  const server = createTaskConsoleServer({ manager: fixture, settingsDirectory });
  try {
    const address = await server.start();
    const session = await request(address, "/api/session");
    const token = (session.json as { result: { csrf_token: string } }).result.csrf_token;
    const initial = await request(address, "/api/settings");
    assert.equal(initial.status, 200);
    assert.equal((initial.json as { result: { auto_wake: { enabled: boolean } } }).result.auto_wake.enabled, true);

    const rejected = await request(address, "/api/settings/auto-wake", {
      method: "POST",
      body: { enabled: false },
      headers: { Origin: address.origin },
    });
    assert.equal(rejected.status, 403);
    const updated = await request(address, "/api/settings/auto-wake", {
      method: "POST",
      body: { enabled: false },
      headers: { Origin: address.origin, "X-ZCode-Bridge-CSRF": token },
    });
    assert.equal(updated.status, 200);
    assert.equal((updated.json as { result: { auto_wake: { enabled: boolean } } }).result.auto_wake.enabled, false);
    const saved = JSON.parse(readFileSync(path.join(settingsDirectory, "runtime-config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(saved.ZCODE_BRIDGE_AUTO_WAKE, "false");
    const after = await request(address, "/api/settings");
    assert.equal((after.json as { result: { auto_wake: { enabled: boolean } } }).result.auto_wake.enabled, false);
  } finally {
    await server.close();
    rmSync(settingsDirectory, { recursive: true, force: true });
  }
});

test("Web Console mutations require same-origin CSRF and preserve task actions", async () => {
  const fixture = manager();
  const server = createTaskConsoleServer({ manager: fixture });
  try {
    const address = await server.start();
    const session = await request(address, "/api/session");
    const token = (session.json as { result: { csrf_token: string } }).result.csrf_token;

    const missing = await request(address, "/api/tasks/task-a/cancel", {
      method: "POST",
      body: {},
      headers: { Origin: address.origin },
    });
    assert.equal(missing.status, 403);
    const foreign = await request(address, "/api/tasks/task-a/cancel", {
      method: "POST",
      body: {},
      headers: { Origin: "https://evil.invalid", "X-ZCode-Bridge-CSRF": token },
    });
    assert.equal(foreign.status, 403);

    const cancelled = await request(address, "/api/tasks/task-a/cancel", {
      method: "POST",
      body: {},
      headers: { Origin: address.origin, "X-ZCode-Bridge-CSRF": token },
    });
    assert.equal(cancelled.status, 200);
    assert.equal(fixture.calls.cancel, 1);

    const replied = await request(address, "/api/tasks/task-a/reply", {
      method: "POST",
      body: { request_id: "request-a", decision: "allow", reason: "reviewed" },
      headers: { Origin: address.origin, "X-ZCode-Bridge-CSRF": token },
    });
    assert.equal(replied.status, 200);
    assert.equal(fixture.calls.reply, 1);
  } finally {
    await server.close();
  }
});

test("Web Console mounts Cost Lab behind the same loopback origin and CSRF boundary", async () => {
  const fixture = manager();
  const mounted: Array<{ origin: string; port: number }> = [];
  const handled: string[] = [];
  let closed = false;
  const costLab = {
    async mountEndpoints(input: { readonly origin: string; readonly port: number }): Promise<void> {
      mounted.push(input);
    },
    async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
      handled.push(`${request.method} ${request.url}`);
      if (request.method === "POST"
        && (request.headers.origin !== mounted[0]?.origin
          || request.headers["x-cost-lab-csrf"] !== "cost-token")) {
        replyJson(response, 403, {
          ok: false,
          error: { code: "COST_LAB_CSRF_REJECTED", message: "rejected" },
        });
        return;
      }
      replyJson(response, 200, {
        ok: true,
        data: request.url === "/api/cost-lab/session"
          ? { csrf_token: "cost-token", provider: "test" }
          : { accepted: true },
      });
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
  const server = createTaskConsoleServer({ manager: fixture, costLab });
  try {
    const address = await server.start();
    assert.deepEqual(mounted, [{ origin: address.origin, port: address.port }]);
    const session = await request(address, "/api/cost-lab/session");
    assert.equal(session.status, 200);
    assert.equal((session.json as { data: { csrf_token: string } }).data.csrf_token, "cost-token");

    const rejected = await request(address, "/api/cost-lab/billing/snapshot", {
      method: "POST",
      body: {},
      headers: { Origin: address.origin, "X-Cost-Lab-CSRF": "wrong" },
    });
    assert.equal(rejected.status, 403);
    const accepted = await request(address, "/api/cost-lab/billing/snapshot", {
      method: "POST",
      body: {},
      headers: { Origin: address.origin, "X-Cost-Lab-CSRF": "cost-token" },
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(handled, [
      "GET /api/cost-lab/session",
      "POST /api/cost-lab/billing/snapshot",
      "POST /api/cost-lab/billing/snapshot",
    ]);
  } finally {
    await server.close();
  }
  assert.equal(closed, true);
});

test("Web Console exposes Runtime inspection and authorized zero-model probe routes", async () => {
  const fixture = manager();
  const calls: string[] = [];
  const runtimeCompatibility = {
    async inspect() {
      calls.push("inspect");
      return { fingerprint: "a".repeat(64), model_requests: 0 };
    },
    async runAuthorizedProtocolProbe() {
      calls.push("probe");
      return { fingerprint: "a".repeat(64), protocol: "PASS", model_requests: 0 };
    },
    async candidateReport() {
      calls.push("candidate");
      return { kind: "runtime_compatibility_candidate" };
    },
  };
  const server = createTaskConsoleServer({ manager: fixture, runtimeCompatibility });
  try {
    const address = await server.start();
    const runtime = await request(address, "/api/runtime");
    const candidate = await request(address, "/api/runtime/candidate");
    assert.equal(runtime.status, 200);
    assert.equal(candidate.status, 200);

    const missingCsrf = await request(address, "/api/runtime/protocol-probe", {
      method: "POST",
      body: {},
      headers: { Origin: address.origin },
    });
    assert.equal(missingCsrf.status, 403);
    const session = await request(address, "/api/session");
    const token = (session.json as { result: { csrf_token: string } }).result.csrf_token;
    const probe = await request(address, "/api/runtime/protocol-probe", {
      method: "POST",
      body: {},
      headers: { Origin: address.origin, "X-ZCode-Bridge-CSRF": token },
    });
    assert.equal(probe.status, 200);
    assert.deepEqual(calls, ["inspect", "candidate", "probe"]);
  } finally {
    await server.close();
  }
});

test("Web Console rejects invalid hosts, task ids, and oversized mutation bodies", async () => {
  const fixture = manager();
  const server = createTaskConsoleServer({ manager: fixture });
  try {
    const address = await server.start();
    const session = await request(address, "/api/session");
    const token = (session.json as { result: { csrf_token: string } }).result.csrf_token;
    const invalidHost = await request(address, "/api/tasks/task-a/status", {
      headers: { Host: "example.invalid" },
    });
    assert.equal(invalidHost.status, 403);
    const invalidId = await request(address, "/api/tasks/bad%2Fid/status");
    assert.equal(invalidId.status, 400);
    const oversized = await request(address, "/api/tasks/task-a/reply", {
      method: "POST",
      body: { request_id: "x".repeat(70_000), decision: "allow" },
      headers: { Origin: address.origin, "X-ZCode-Bridge-CSRF": token },
    });
    assert.equal(oversized.status, 413);
  } finally {
    await server.close();
  }
});

test("Web Console exposes non-secret discovery identity and resolves deep links outside page one", async () => {
  const fixture = manager();
  fixture.listTasks = async (input: ListTasksInput): Promise<TaskListPage> => {
    if (input.after_task_id === undefined) {
      return {
        tasks: [{
          task_id: "task-page-one",
          status: "queued",
          attempt: 1,
          created_at: "2026-01-01T00:00:00Z",
          workspace: "C:\\work",
          objective: "First page",
        }],
        next_task_id: "task-page-one",
        has_more: true,
      };
    }
    return {
      tasks: [{
        task_id: "task-deep",
        status: "running",
        attempt: 3,
        created_at: "2026-01-01T00:00:00Z",
        workspace: "C:\\work",
        objective: "Deep-linked task",
      }],
      next_task_id: null,
      has_more: false,
    };
  };
  const server = createTaskConsoleServer({
    manager: fixture,
    consoleId: "console-test-1",
    authorityRootDigest: "a".repeat(64),
    executorStatus: async () => ({ state: "active", lease_id: "lease-a" }),
  });
  try {
    const address = await server.start();
    const summary = await request(address, "/api/tasks/task-deep/summary");
    assert.equal(summary.status, 200);
    assert.equal((summary.json as { result: { task_id: string } }).result.task_id, "task-deep");
    const page = await request(address, "/?task_id=task-deep");
    assert.equal(page.status, 200);
    const html = String(page.json);
    assert.match(html, /taskIdFromLocation/u);
    assert.match(html, /history\.replaceState/u);
    assert.match(html, /Promise\.allSettled/u);
    assert.match(html, /Result pending/u);
    assert.match(html, /\/summary/u);
    const attention = await request(address, "/api/tasks/task-a/attention");
    assert.equal(attention.status, 200);
    assert.deepEqual((attention.json as { result: { pending_requests: string[] } }).result.pending_requests, ["request-a"]);
  } finally {
    await server.close();
  }
});

test("Web Console keeps status and events readable when Result is not finished", async () => {
  const fixture = manager();
  fixture.getResult = async () => {
    throw Object.assign(new Error("task is not finished"), { code: "TASK_NOT_FINISHED" });
  };
  const server = createTaskConsoleServer({ manager: fixture });
  try {
    const address = await server.start();
    const status = await request(address, "/api/tasks/task-a/status");
    const events = await request(address, "/api/tasks/task-a/events?limit=5");
    const result = await request(address, "/api/tasks/task-a/result?view=summary");
    assert.equal(status.status, 200);
    assert.equal(events.status, 200);
    assert.equal(result.status, 409);
    assert.equal((result.json as { error: { code: string } }).error.code, "TASK_NOT_FINISHED");
  } finally {
    await server.close();
  }
});

test("Task Console discovery is exclusive, CAS-releasable, and session-verifiable", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "web-console-discovery-"));
  const fixture = manager();
  const consoleId = "console-discovery-test";
  const digest = authorityRootDigest(root);
  const server = createTaskConsoleServer({
    manager: fixture,
    consoleId,
    authorityRootDigest: digest,
    executorStatus: async () => ({ state: "active", lease_id: "lease-discovery" }),
  });
  try {
    const address = await server.start();
    const first = await publishTaskConsoleDiscovery({
      dataRoot: root,
      consoleId,
      origin: address.origin,
      url: address.url,
      port: address.port,
    });
    assert.equal(first.authority_root_digest, digest);
    const inspection = await inspectTaskConsoleDiscovery(root, createPlatformProbe());
    assert.equal(inspection.state, "active_owner");
    assert.equal(inspection.record?.record_digest, first.record_digest);
    const session = await fetchTaskConsoleSession(first);
    assert.equal(session.console.console_id, consoleId);
    assert.equal(session.console.url, address.url);
    await assert.rejects(
      publishTaskConsoleDiscovery({
        dataRoot: root,
        consoleId: "console-second",
        origin: address.origin,
        url: address.url,
        port: address.port,
      }),
      (error: unknown) => error instanceof TaskConsoleDiscoveryError && error.code === "WEB_CONSOLE_DISCOVERY_EXISTS",
    );
    assert.throws(
      () => removeTaskConsoleDiscovery(root, { console_id: "console-other", record_digest: first.record_digest }),
      (error: unknown) => error instanceof TaskConsoleDiscoveryError && error.code === "WEB_CONSOLE_DISCOVERY_CHANGED",
    );
    removeTaskConsoleDiscovery(root, first);
    assert.equal((await inspectTaskConsoleDiscovery(root, createPlatformProbe())).state, "absent");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function waitForConsoleReady(child: ChildProcessWithoutNullStreams, timeoutMs = 8_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Task Console did not become ready: ${stderr || stdout}`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer | string): void => {
      stdout += String(chunk);
      const line = stdout.split(/\r?\n/u).find((value) => value.startsWith("TASK_CONSOLE_READY "));
      if (!line) return;
      try {
        const value = JSON.parse(line.slice("TASK_CONSOLE_READY ".length)) as Record<string, unknown>;
        cleanup();
        resolve(value);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onErrorData = (chunk: Buffer | string): void => {
      stderr += String(chunk);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Task Console exited before ready (${code}): ${stderr || stdout}`));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Task Console child did not exit"));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
  });
}

test("A second Console process reuses the same Authority URL instead of creating a second authority", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "web-console-reuse-"));
  const pipe = executorPipeName(root);
  const authority = controlManager();
  const control = await startExecutorControlServer({
    pipeName: pipe,
    manager: authority,
    leaseId: "lease-console-reuse",
    executorIdleState: () => ({ idle: true, blockers: [] }),
  });
  const entry = path.resolve("dist-test/src/web/main.js");
  let first: ChildProcessWithoutNullStreams | undefined;
  let second: ChildProcessWithoutNullStreams | undefined;
  try {
    first = spawn(process.execPath, [
      entry,
      "--data-root", root,
      "--settings-directory", root,
      "--port", "0",
    ], { windowsHide: true });
    const firstReady = await waitForConsoleReady(first);
    assert.equal(firstReady.reused, false);
    assert.equal(typeof firstReady.url, "string");
    assert.equal(typeof firstReady.port, "number");

    second = spawn(process.execPath, [
      entry,
      "--data-root", root,
      "--settings-directory", root,
      "--port", "0",
    ], { windowsHide: true });
    const secondReady = await waitForConsoleReady(second);
    assert.equal(secondReady.reused, true);
    assert.equal(secondReady.url, firstReady.url);
    assert.equal(secondReady.console_id, firstReady.console_id);
    await waitForExit(second);

    const inspection = await inspectTaskConsoleDiscovery(root, createPlatformProbe());
    assert.equal(inspection.state, "active_owner");
    assert.equal(inspection.record?.console_id, firstReady.console_id);
  } finally {
    for (const child of [first, second]) {
      if (child && child.exitCode === null) child.kill();
    }
    if (first) {
      try { await waitForExit(first); } catch { /* test child termination is best effort */ }
    }
    const inspection = await inspectTaskConsoleDiscovery(root, createPlatformProbe()).catch(() => null);
    if (inspection?.record) {
      try { removeTaskConsoleDiscovery(root, inspection.record); } catch { /* test cleanup */ }
    }
    await control.close();
    rmSync(root, { recursive: true, force: true });
  }
});
