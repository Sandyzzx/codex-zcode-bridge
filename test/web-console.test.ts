import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { TaskStatusRecord } from "../src/interfaces.js";
import type { ListTasksInput, TaskListPage } from "../src/task-list.js";
import { createTaskConsoleServer, type TaskConsoleManager } from "../src/web/server.js";

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
            reason_code: "policy_missing",
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
    assert.match(String(page.json), /Operations Desk/u);
    assert.match(String(page.json), /id="count-wake"/u);
    assert.match(String(page.json), /id="wake-banner"/u);
    const inlineScript = /<script>([\s\S]+)<\/script>/u.exec(String(page.json))?.[1];
    assert.ok(inlineScript);
    assert.doesNotThrow(() => new Function(inlineScript));

    const list = await request(address, "/api/tasks?limit=5");
    assert.equal(list.status, 200);
    const listed = (list.json as { result: { tasks: Array<{ wake?: Record<string, unknown> }> } }).result;
    assert.equal(listed.tasks.length, 1);
    assert.deepEqual(listed.tasks[0]?.wake, {
      state: "web_notify",
      reason_code: "policy_missing",
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
