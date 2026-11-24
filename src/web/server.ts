import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { ProgressTaskManager } from "../interfaces.js";
import type { ExecutorTaskManagement, ListTasksInput, TaskListPage } from "../task-list.js";
import { listTasksInputSchema } from "../task-list.js";
import { zcodeEventsInputSchema, zcodeInteractionReplyInputSchema } from "../api-schemas.js";
import type { GetEventsInput, TaskResult, ZCodeInteractionReplyInput } from "../interfaces.js";
import { readAutoWakeSetting, writeAutoWakeSetting } from "../runtime/auto-wake-setting.js";
import { OPERATIONS_CONSOLE_HTML } from "./console-ui.js";

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FULL_RESULT_BYTES = 2 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export type TaskConsoleManager = Pick<
  ProgressTaskManager,
  "getStatus" | "getEvents" | "getResult" | "cancelTask" | "replyToInteraction" | "getAttention"
> & Partial<ExecutorTaskManagement>;

export interface TaskConsoleServerOptions {
  readonly manager: TaskConsoleManager;
  readonly executorStatus?: () => Promise<Record<string, unknown>>;
  readonly costLab?: CostLabConsoleApplication;
  readonly runtimeCompatibility?: RuntimeCompatibilityConsoleApplication;
  readonly port?: number;
  readonly csrfToken?: string;
  /** Local discovery identity; never a credential or CSRF token. */
  readonly consoleId?: string;
  readonly authorityRootDigest?: string;
  /** Canonical per-host settings directory. Omitted servers expose no settings mutations. */
  readonly settingsDirectory?: string;
  readonly now?: () => number;
}

export interface CostLabConsoleApplication {
  mountEndpoints(input: { readonly origin: string; readonly port: number }): Promise<void>;
  handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(options?: { readonly abortActive?: boolean }): Promise<void>;
}

export interface RuntimeCompatibilityConsoleApplication {
  inspect(): Promise<unknown>;
  runAuthorizedProtocolProbe(): Promise<unknown>;
  candidateReport(): Promise<unknown>;
}

export interface TaskConsoleAddress {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly origin: string;
  readonly url: string;
}

export interface TaskConsoleServer {
  start(): Promise<TaskConsoleAddress>;
  close(): Promise<void>;
  readonly address: TaskConsoleAddress | null;
}

interface HttpFailure extends Error {
  readonly status: number;
  readonly code: string;
}

function failure(status: number, code: string, message: string): HttpFailure {
  return Object.assign(new Error(message), { status, code });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.end(body);
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
      + "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1";
}

function allowedHosts(port: number): Set<string> {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
}

function allowedOrigins(port: number): Set<string> {
  return new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
}

function validMutation(request: IncomingMessage, port: number, csrfToken: string): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !allowedOrigins(port).has(origin)) return false;
  if (request.headers["x-zcode-bridge-csrf"] !== csrfToken) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  return fetchSite === undefined || fetchSite === "same-origin" || fetchSite === "none";
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES) {
      throw failure(413, "WEB_BODY_TOO_LARGE", "request body exceeds the 64 KiB limit");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw failure(413, "WEB_BODY_TOO_LARGE", "request body exceeds the 64 KiB limit");
    chunks.push(bytes);
  }
  if (total === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw failure(400, "WEB_INVALID_JSON", "request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw failure(400, "WEB_INVALID_JSON", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function taskIdFromPath(value: string): string {
  if (!TASK_ID.test(value)) throw failure(400, "WEB_INVALID_TASK_ID", "task_id is invalid");
  return value;
}

function decodeTaskId(value: string): string {
  try {
    return taskIdFromPath(decodeURIComponent(value));
  } catch (error) {
    if (error && typeof error === "object" && "status" in error) throw error;
    throw failure(400, "WEB_INVALID_TASK_ID", "task_id is not valid URL encoding");
  }
}

function queryNumber(query: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/u.test(raw)) throw failure(400, "WEB_INVALID_QUERY", `${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw failure(400, "WEB_INVALID_QUERY", `${name} is outside its allowed range`);
  }
  return value;
}

function queryBoolean(query: URLSearchParams, name: string): boolean | undefined {
  const raw = query.get(name);
  if (raw === null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw failure(400, "WEB_INVALID_QUERY", `${name} must be true or false`);
}

function taskErrorStatus(error: unknown): number {
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  if (code === "TASK_NOT_FOUND" || code === "NOT_FOUND") return 404;
  if (code === "TASK_NOT_FINISHED" || code === "TASK_STATE" || code === "TASK_CANCEL_REQUESTED") return 409;
  if (code === "provider_config_invalid" || code === "PROVIDER_CONFIG_INVALID") return 400;
  if (code === "EXECUTOR_UNAVAILABLE" || code === "SUBMISSION_UNKNOWN") return 503;
  if (code === "REQUEST_CANCELLED") return 408;
  return 500;
}

function taskErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "WEB_INTERNAL_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function findTaskSummary(
  manager: TaskConsoleManager,
  taskId: string,
): Promise<TaskListPage["tasks"][number] | null> {
  let afterTaskId: string | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await manager.listTasks!({
      limit: 100,
      ...(afterTaskId === null ? {} : { after_task_id: afterTaskId }),
    });
    const task = page.tasks.find((candidate) => candidate.task_id === taskId);
    if (task) return task;
    if (!page.has_more || page.next_task_id === null) return null;
    afterTaskId = page.next_task_id;
  }
  return null;
}

export function createTaskConsoleServer(options: TaskConsoleServerOptions): TaskConsoleServer {
  const state = {
    server: null as http.Server | null,
    address: null as TaskConsoleAddress | null,
    csrfToken: options.csrfToken ?? randomBytes(32).toString("base64url"),
    sockets: new Set<Socket>(),
    closed: false,
  };

  const requestHandler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    securityHeaders(response);
    if (!isLoopback(request.socket.remoteAddress)) {
      throw failure(403, "WEB_LOCAL_ONLY", "Task Console accepts loopback connections only");
    }
    const address = state.address;
    if (!address) throw failure(503, "WEB_NOT_READY", "Task Console is not ready");
    const host = request.headers.host;
    if (typeof host !== "string" || !allowedHosts(address.port).has(host)) {
      throw failure(403, "WEB_HOST_REJECTED", "Host must be the local Task Console origin");
    }
    const url = new URL(request.url ?? "/", address.origin);
    if (url.pathname.startsWith("/api/cost-lab/")) {
      if (!options.costLab) throw failure(503, "COST_LAB_UNAVAILABLE", "Cost Lab is not configured");
      await options.costLab.handleRequest(request, response);
      return;
    }
    if (request.method === "GET" || request.method === "HEAD") {
      await handleRead(request, response, url);
      return;
    }
    if (request.method === "POST") {
      if (!validMutation(request, address.port, state.csrfToken)) {
        throw failure(403, "WEB_CSRF_REJECTED", "same-origin Origin and CSRF validation failed");
      }
      await handleMutation(request, response, url);
      return;
    }
    throw failure(405, "WEB_METHOD_NOT_ALLOWED", "method is not supported");
  };

  const handleRead = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const body = OPERATIONS_CONSOLE_HTML;
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Length", String(Buffer.byteLength(body)));
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (url.pathname === "/api/session") {
      let executor: Record<string, unknown> = { state: "unknown" };
      if (options.executorStatus) {
        try {
          executor = await options.executorStatus();
        } catch (error) {
          executor = { state: "unavailable", reason: errorMessage(error) };
        }
      }
      json(response, 200, {
        ok: true,
        result: {
          csrf_token: state.csrfToken,
          executor,
          console: {
            console_id: options.consoleId ?? null,
            authority_root_digest: options.authorityRootDigest ?? null,
            url: state.address?.url ?? null,
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/runtime") {
      if (!options.runtimeCompatibility) {
        throw failure(503, "RUNTIME_COMPATIBILITY_UNAVAILABLE", "Runtime compatibility is not configured");
      }
      json(response, 200, { ok: true, result: await options.runtimeCompatibility.inspect() });
      return;
    }
    if (url.pathname === "/api/runtime/candidate") {
      if (!options.runtimeCompatibility) {
        throw failure(503, "RUNTIME_COMPATIBILITY_UNAVAILABLE", "Runtime compatibility is not configured");
      }
      json(response, 200, { ok: true, result: await options.runtimeCompatibility.candidateReport() });
      return;
    }
    if (url.pathname === "/api/settings") {
      if (!options.settingsDirectory) {
        throw failure(503, "SETTINGS_UNAVAILABLE", "Bridge settings are not configured");
      }
      json(response, 200, {
        ok: true,
        result: { auto_wake: { enabled: await readAutoWakeSetting(options.settingsDirectory) } },
      });
      return;
    }
    if (url.pathname === "/api/tasks") {
      if (!options.manager.listTasks) throw failure(501, "WEB_LIST_UNAVAILABLE", "task listing is unavailable");
      const input = parseListQuery(url.searchParams);
      json(response, 200, { ok: true, result: await options.manager.listTasks(input) });
      return;
    }
    const match = /^\/api\/tasks\/([^/]+)(?:\/(status|summary|events|result|attention))?$/u.exec(url.pathname);
    if (!match) throw failure(404, "WEB_NOT_FOUND", "route not found");
    const taskId = decodeTaskId(match[1]!);
    const action = match[2] ?? "status";
    if (action === "status") {
      json(response, 200, { ok: true, result: await options.manager.getStatus(taskId) });
      return;
    }
    if (action === "summary") {
      if (!options.manager.listTasks) throw failure(501, "WEB_LIST_UNAVAILABLE", "task listing is unavailable");
      const summary = await findTaskSummary(options.manager, taskId);
      if (!summary) throw failure(404, "TASK_NOT_FOUND", `unknown task: ${taskId}`);
      json(response, 200, { ok: true, result: summary });
      return;
    }
    if (action === "events") {
      const input = parseEventsQuery(url.searchParams, taskId);
      json(response, 200, { ok: true, result: await options.manager.getEvents(input) });
      return;
    }
    if (action === "attention") {
      if (!options.manager.getAttention) {
        throw failure(501, "WEB_ATTENTION_UNAVAILABLE", "attention projection is unavailable");
      }
      json(response, 200, { ok: true, result: await options.manager.getAttention(taskId) });
      return;
    }
    const view = url.searchParams.get("view") ?? "summary";
    if (view !== "summary" && view !== "full") {
      throw failure(400, "WEB_INVALID_QUERY", "view must be summary or full");
    }
    // P1 §3.4B: the summary projection runs Executor-side; the Web console
    // stops transporting the full Result for summary reads.
    const value = await options.manager.getResult(taskId, view);
    const serialized = JSON.stringify(value);
    if (view === "full" && Buffer.byteLength(serialized) > MAX_FULL_RESULT_BYTES) {
      throw failure(413, "WEB_RESULT_TOO_LARGE", "full Result exceeds the 2 MiB Web response budget; read via the paged zcode_result MCP contract");
    }
    json(response, 200, { ok: true, result: value });
  };

  const handleMutation = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    if (url.pathname === "/api/runtime/check") {
      if (!options.runtimeCompatibility) {
        throw failure(503, "RUNTIME_COMPATIBILITY_UNAVAILABLE", "Runtime compatibility is not configured");
      }
      await readJson(request);
      json(response, 200, { ok: true, result: await options.runtimeCompatibility.inspect() });
      return;
    }
    if (url.pathname === "/api/runtime/protocol-probe") {
      if (!options.runtimeCompatibility) {
        throw failure(503, "RUNTIME_COMPATIBILITY_UNAVAILABLE", "Runtime compatibility is not configured");
      }
      await readJson(request);
      json(response, 200, { ok: true, result: await options.runtimeCompatibility.runAuthorizedProtocolProbe() });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw failure(415, "WEB_CONTENT_TYPE_REQUIRED", "mutations require application/json");
    }
    if (url.pathname === "/api/settings/auto-wake") {
      if (!options.settingsDirectory) {
        throw failure(503, "SETTINGS_UNAVAILABLE", "Bridge settings are not configured");
      }
      const body = await readJson(request);
      if (typeof body.enabled !== "boolean") {
        throw failure(400, "WEB_INVALID_SETTING", "enabled must be a boolean");
      }
      await writeAutoWakeSetting(options.settingsDirectory, body.enabled);
      json(response, 200, {
        ok: true,
        result: { auto_wake: { enabled: body.enabled } },
      });
      return;
    }
    const match = /^\/api\/tasks\/([^/]+)\/(cancel|reply)$/u.exec(url.pathname);
    if (!match) throw failure(404, "WEB_NOT_FOUND", "route not found");
    const taskId = decodeTaskId(match[1]!);
    const action = match[2];
    const body = await readJson(request);
    if (action === "cancel") {
      json(response, 200, { ok: true, result: await options.manager.cancelTask(taskId) });
      return;
    }
    let input: ZCodeInteractionReplyInput;
    try {
      input = zcodeInteractionReplyInputSchema.parse({ ...body, task_id: taskId }) as ZCodeInteractionReplyInput;
    } catch (error) {
      throw failure(400, "WEB_INVALID_INTERACTION_REPLY", errorMessage(error));
    }
    json(response, 200, { ok: true, result: await options.manager.replyToInteraction(input) });
  };

  const server = http.createServer((request, response) => {
    void requestHandler(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(response, taskErrorStatus(error), {
        ok: false,
        error: { code: taskErrorCode(error), message: errorMessage(error) },
      });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    state.sockets.add(socket);
    socket.once("close", () => state.sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  state.server = server;

  return {
    get address() {
      return state.address;
    },
    async start() {
      if (state.address !== null) return state.address;
      if (state.closed) throw failure(410, "WEB_CLOSED", "Task Console server is closed");
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port ?? 0, LOOPBACK_HOST);
      });
      const bound = server.address();
      if (!bound || typeof bound === "string") throw failure(500, "WEB_ADDRESS_UNAVAILABLE", "server address unavailable");
      state.address = {
        host: LOOPBACK_HOST,
        port: bound.port,
        origin: `http://${LOOPBACK_HOST}:${bound.port}`,
        url: `http://${LOOPBACK_HOST}:${bound.port}/`,
      };
      try {
        await options.costLab?.mountEndpoints({
          origin: state.address.origin,
          port: state.address.port,
        });
      } catch (error) {
        state.address = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      }
      return state.address;
    },
    async close() {
      if (state.closed) return;
      state.closed = true;
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        for (const socket of state.sockets) socket.end();
      });
      state.address = null;
      await options.costLab?.close({ abortActive: true });
    },
  };
}

function parseListQuery(query: URLSearchParams): ListTasksInput {
  const raw = {
    ...(query.get("after_task_id") === null ? {} : { after_task_id: query.get("after_task_id")! }),
    ...(queryNumber(query, "limit", 1, 100) === undefined ? {} : { limit: queryNumber(query, "limit", 1, 100)! }),
    ...(query.get("status") === null ? {} : { status: query.get("status")! }),
  };
  try {
    return listTasksInputSchema.parse(raw) as ListTasksInput;
  } catch (error) {
    throw failure(400, "WEB_INVALID_QUERY", errorMessage(error));
  }
}

function parseEventsQuery(query: URLSearchParams, taskId: string): GetEventsInput {
  const raw = {
    task_id: taskId,
    ...(queryNumber(query, "after_seq", 0, Number.MAX_SAFE_INTEGER) === undefined
      ? {}
      : { after_seq: queryNumber(query, "after_seq", 0, Number.MAX_SAFE_INTEGER)! }),
    ...(queryNumber(query, "limit", 1, 200) === undefined ? {} : { limit: queryNumber(query, "limit", 1, 200)! }),
    ...(queryNumber(query, "wait_ms", 0, 25_000) === undefined
      ? {}
      : { wait_ms: queryNumber(query, "wait_ms", 0, 25_000)! }),
    ...(query.get("view") === null ? {} : { view: query.get("view")! }),
    ...(queryBoolean(query, "include_attempt") === undefined
      ? {}
      : { include_attempt: queryBoolean(query, "include_attempt")! }),
    ...(query.get("scan_cursor") === null ? {} : { scan_cursor: query.get("scan_cursor")! }),
    ...(queryNumber(query, "max_bytes", 1_024, 33_554_432) === undefined
      ? {}
      : { max_bytes: queryNumber(query, "max_bytes", 1_024, 33_554_432)! }),
  };
  try {
    return zcodeEventsInputSchema.parse(raw) as GetEventsInput;
  } catch (error) {
    throw failure(400, "WEB_INVALID_QUERY", errorMessage(error));
  }
}

