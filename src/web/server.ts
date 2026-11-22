import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { ProgressTaskManager } from "../interfaces.js";
import type { ExecutorTaskManagement, ListTasksInput } from "../task-list.js";
import { listTasksInputSchema } from "../task-list.js";
import { zcodeEventsInputSchema, zcodeInteractionReplyInputSchema } from "../api-schemas.js";
import { summarizeTaskResult } from "../result-summary.js";
import type { GetEventsInput, TaskResult, ZCodeInteractionReplyInput } from "../interfaces.js";

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FULL_RESULT_BYTES = 2 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export type TaskConsoleManager = Pick<
  ProgressTaskManager,
  "getStatus" | "getEvents" | "getResult" | "cancelTask" | "replyToInteraction"
> & Partial<ExecutorTaskManagement>;

export interface TaskConsoleServerOptions {
  readonly manager: TaskConsoleManager;
  readonly executorStatus?: () => Promise<Record<string, unknown>>;
  readonly port?: number;
  readonly csrfToken?: string;
  readonly now?: () => number;
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
      const body = CONSOLE_HTML;
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
      json(response, 200, { ok: true, result: { csrf_token: state.csrfToken, executor } });
      return;
    }
    if (url.pathname === "/api/tasks") {
      if (!options.manager.listTasks) throw failure(501, "WEB_LIST_UNAVAILABLE", "task listing is unavailable");
      const input = parseListQuery(url.searchParams);
      json(response, 200, { ok: true, result: await options.manager.listTasks(input) });
      return;
    }
    const match = /^\/api\/tasks\/([^/]+)(?:\/(status|events|result))?$/u.exec(url.pathname);
    if (!match) throw failure(404, "WEB_NOT_FOUND", "route not found");
    const taskId = decodeTaskId(match[1]!);
    const action = match[2] ?? "status";
    if (action === "status") {
      json(response, 200, { ok: true, result: await options.manager.getStatus(taskId) });
      return;
    }
    if (action === "events") {
      const input = parseEventsQuery(url.searchParams, taskId);
      json(response, 200, { ok: true, result: await options.manager.getEvents(input) });
      return;
    }
    const view = url.searchParams.get("view") ?? "summary";
    if (view !== "summary" && view !== "full") {
      throw failure(400, "WEB_INVALID_QUERY", "view must be summary or full");
    }
    const result = await options.manager.getResult(taskId);
    const value = view === "full" ? result : summarizeTaskResult(result);
    const serialized = JSON.stringify(value);
    if (view === "full" && Buffer.byteLength(serialized) > MAX_FULL_RESULT_BYTES) {
      throw failure(413, "WEB_RESULT_TOO_LARGE", "full Result exceeds the 2 MiB Web response budget");
    }
    json(response, 200, { ok: true, result: value });
  };

  const handleMutation = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw failure(415, "WEB_CONTENT_TYPE_REQUIRED", "mutations require application/json");
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

const CONSOLE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Bridge Operations Desk</title>
<style>
:root{--ink:#1d211e;--paper:#f3f0e8;--panel:#fffdf7;--line:#c9c3b6;--orange:#f05a28;--sage:#78917c;--muted:#6b6d65;--mono:"Cascadia Code","Consolas",monospace;--display:"Bahnschrift SemiCondensed","Aptos Display",sans-serif;--serif:Georgia,"Times New Roman",serif}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 100% 0%,#ffe4d8 0,transparent 30rem),linear-gradient(135deg,#f3f0e8,#e8e5dc);color:var(--ink);font-family:var(--display);min-height:100vh}
body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.3;background-image:linear-gradient(rgba(29,33,30,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(29,33,30,.05) 1px,transparent 1px);background-size:28px 28px;z-index:-1}
.shell{max-width:1440px;margin:0 auto;padding:28px 34px 44px}.topline{display:flex;justify-content:space-between;align-items:end;border-bottom:2px solid var(--ink);padding-bottom:14px;gap:20px}.eyebrow,.mono{font-family:var(--mono);font-size:11px;letter-spacing:.11em;text-transform:uppercase}.eyebrow{color:var(--orange);font-weight:700}.title{margin:4px 0 0;font-family:var(--serif);font-size:clamp(30px,5vw,58px);line-height:.92;letter-spacing:-.04em;font-weight:500}.topline-right{text-align:right;min-width:170px}.topline-right strong{display:block;font:700 14px var(--mono)}.topline-right span{color:var(--muted);font-size:12px}
.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:18px 0}.stat{border:1px solid var(--line);background:rgba(255,253,247,.7);padding:12px 14px}.stat strong{display:block;font:700 24px var(--mono);letter-spacing:-.05em}.stat span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.stat.hot strong{color:var(--orange)}
.workspace{display:grid;grid-template-columns:minmax(0,1.18fr) minmax(350px,.82fr);gap:18px;align-items:start}.panel{border:1px solid var(--ink);background:var(--panel);box-shadow:6px 6px 0 rgba(29,33,30,.12)}
.panel-head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line);gap:12px}.panel-head h2{margin:0;font:700 14px var(--mono);text-transform:uppercase;letter-spacing:.12em}.filters{display:flex;gap:8px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--line);background:#f8f5ed}
input,select,textarea,button{font:13px var(--display)}input,select,textarea{border:1px solid var(--line);background:#fffdf7;color:var(--ink);padding:9px 10px;border-radius:0}input:focus,select:focus,textarea:focus,button:focus{outline:2px solid var(--orange);outline-offset:2px}
button{cursor:pointer;border:1px solid var(--ink);background:var(--ink);color:var(--paper);padding:9px 12px;font-weight:700;letter-spacing:.03em}button:hover{background:var(--orange);border-color:var(--orange)}button.secondary{background:var(--paper);color:var(--ink)}button.secondary:hover{background:#ffe4d8}
.task-list{padding:6px}.task-row{width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;text-align:left;background:transparent;color:var(--ink);border:0;border-bottom:1px solid #e4dfd4;padding:13px 10px;font-weight:400}.task-row:hover,.task-row.selected{background:#f1ece0;color:var(--ink)}.task-row:last-child{border-bottom:0}.task-id{font:700 12px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-objective{margin-top:4px;color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-badges{display:flex;align-items:center;justify-content:flex-end;gap:5px;flex-wrap:wrap}.chip{display:inline-block;font:700 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;padding:4px 6px;background:#e4dfd4;color:var(--ink);white-space:nowrap}.chip.running,.chip.waiting_for_master{background:#ffd8c7;color:#8a2d0d}.chip.completed,.chip.turn_started{background:#d8e6d8;color:#2d5636}.chip.failed,.chip.cancelled,.chip.submission_unknown{background:#f1c7c0;color:#7f1e21}.chip.queued,.chip.intent{background:#f8e3ad;color:#6d4d00}.wake-banner{margin:0 14px 10px;border-left:3px solid var(--orange);background:#fff0e8;padding:9px 10px;color:#71320f;font:700 11px var(--mono);letter-spacing:.02em}.wake-banner[hidden]{display:none}
.empty{padding:34px 16px;color:var(--muted);font-family:var(--serif);font-size:17px}.detail-body{padding:16px}.detail-title{display:flex;justify-content:space-between;gap:12px;align-items:start;margin-bottom:12px}.detail-title h3{margin:0;font:700 15px var(--mono);overflow-wrap:anywhere}.detail-title p{margin:6px 0 0;color:var(--muted);font-size:13px}.meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:14px 0}.meta div{border-top:1px solid var(--line);padding-top:8px}.meta label{display:block;color:var(--muted);font:10px var(--mono);text-transform:uppercase;letter-spacing:.08em}.meta strong{display:block;margin-top:3px;font:13px var(--mono);overflow-wrap:anywhere}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.pre{background:#20241f;color:#eae9dc;padding:12px;overflow:auto;max-height:270px;font:11px/1.6 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;border-left:3px solid var(--orange)}
.section-label{font:700 11px var(--mono);text-transform:uppercase;letter-spacing:.1em;margin:18px 0 8px;color:var(--orange)}.reply{border-top:1px solid var(--line);margin-top:18px;padding-top:14px}.reply-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.reply textarea{grid-column:1/-1;min-height:64px;resize:vertical}.status-line{min-height:20px;color:var(--orange);font:11px var(--mono);margin-top:10px}.error{border-left:3px solid var(--orange);background:#ffe4d8;padding:10px;color:#7f1e21;font-size:13px;margin:12px 16px;display:none}.footer{display:flex;justify-content:space-between;gap:12px;margin-top:22px;color:var(--muted);font:11px var(--mono);text-transform:uppercase;letter-spacing:.06em}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}.panel{animation:rise .45s ease both}.panel:nth-child(2){animation-delay:.08s}@media(max-width:900px){.shell{padding:20px 16px 32px}.workspace{grid-template-columns:1fr}.summary{grid-template-columns:repeat(2,1fr)}.topline{align-items:start}.title{font-size:42px}}@media(max-width:520px){.topline{display:block}.topline-right{text-align:left;margin-top:14px}.summary{grid-template-columns:1fr 1fr}.reply-grid{grid-template-columns:1fr}.meta{grid-template-columns:1fr 1fr}.footer{display:block}.footer span{display:block;margin-top:6px}}
</style>
</head>
<body>
<div class="shell">
  <header class="topline">
    <div><div class="eyebrow">Codex / ZCode Bridge</div><h1 class="title">Operations<br>Desk</h1></div>
    <div class="topline-right"><span>Executor link</span><strong id="executor-state">CONNECTING</strong><span id="lease-id">lease: --</span></div>
  </header>
  <section class="summary" aria-label="Task summary">
    <div class="stat"><strong id="count-total">--</strong><span>visible tasks</span></div>
    <div class="stat hot"><strong id="count-running">--</strong><span>running now</span></div>
    <div class="stat"><strong id="count-waiting">--</strong><span>needs master</span></div>
    <div class="stat hot"><strong id="count-wake">--</strong><span>wake signals</span></div>
    <div class="stat"><strong id="last-refresh">--:--</strong><span>last refresh</span></div>
  </section>
  <div class="error" id="error"></div>
  <main class="workspace">
    <section class="panel">
      <div class="panel-head"><h2>Task ledger</h2><button class="secondary" id="refresh">Refresh</button></div>
      <div class="filters"><input id="filter" placeholder="Filter task or objective" aria-label="Filter tasks"><select id="status-filter" aria-label="Status"><option value="">All statuses</option><option>queued</option><option>running</option><option>completed</option><option>failed</option><option>cancelled</option><option>waiting_for_master</option></select></div>
      <div id="wake-banner" class="wake-banner" hidden></div>
      <div id="task-list" class="task-list"><div class="empty">Loading the ledger...</div></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Inspection</h2><span class="mono">read-only + actions</span></div>
      <div class="detail-body" id="detail"><div class="empty">Choose a task to inspect its durable evidence.</div></div>
    </section>
  </main>
  <footer class="footer"><span>Loopback only / local account session</span><span>Page close never cancels a task</span></footer>
</div>
<script>
const state={csrf:"",tasks:[],selected:null,detail:null,events:null,result:null};
const byId=id=>document.getElementById(id);
function setError(message){const e=byId("error");e.textContent=message||"";e.style.display=message?"block":"none";}
function esc(value){return String(value??"")}
async function api(path,options={}){const headers={"Accept":"application/json",...(options.body?{"Content-Type":"application/json"}:{})};if(options.csrf)headers["X-ZCode-Bridge-CSRF"]=state.csrf;if(options.origin)headers["Origin"]=options.origin;const response=await fetch(path,{...options,headers:{...headers,...(options.headers||{})}});const body=await response.json().catch(()=>({ok:false,error:{code:"WEB_BAD_RESPONSE",message:"invalid server response"}}));if(!response.ok||!body.ok)throw new Error((body.error&&body.error.code?body.error.code+": ":"")+(body.error&&body.error.message||"request failed"));return body.result??body;}
function statusClass(status){return "chip "+String(status||"unknown").replace(/[^a-z_]/g,"")}
function renderTasks(){const list=byId("task-list");const filter=byId("filter").value.trim().toLowerCase();const status=byId("status-filter").value;const rows=state.tasks.filter(t=>(!status||t.status===status)&&(!filter||(t.task_id+" "+t.objective).toLowerCase().includes(filter)));const wakeRows=rows.filter(t=>t.wake);byId("count-total").textContent=String(rows.length);byId("count-running").textContent=String(rows.filter(t=>t.status==="running").length);byId("count-waiting").textContent=String(rows.filter(t=>t.status==="waiting_for_master").length);byId("count-wake").textContent=String(wakeRows.length);const banner=byId("wake-banner");banner.hidden=wakeRows.length===0;banner.textContent=wakeRows.length===0?"":wakeRows.length+" task"+(wakeRows.length===1?" has":"s have")+" an Executor Wake signal. Open the task and verify its durable event before acceptance.";list.replaceChildren();if(!rows.length){const empty=document.createElement("div");empty.className="empty";empty.textContent="No tasks match this view.";list.append(empty);return;}for(const task of rows){const button=document.createElement("button");button.className="task-row"+(state.selected===task.task_id?" selected":"");button.type="button";button.addEventListener("click",()=>{state.selected=task.task_id;renderTasks();loadDetail(task.task_id);});const left=document.createElement("span");left.style.minWidth="0";const id=document.createElement("span");id.className="task-id";id.textContent=task.task_id;const objective=document.createElement("span");objective.className="task-objective";objective.textContent=task.objective;left.append(id,objective);const badges=document.createElement("span");badges.className="task-badges";const chip=document.createElement("span");chip.className=statusClass(task.status);chip.textContent=task.status;badges.append(chip);if(task.wake){const wake=document.createElement("span");wake.className=statusClass(task.wake.state);wake.textContent="wake: "+task.wake.state;wake.title=task.wake.reason_code+" at "+task.wake.at;badges.append(wake);}button.append(left,badges);list.append(button);}}
function meta(label,value){const div=document.createElement("div");const l=document.createElement("label");l.textContent=label;const v=document.createElement("strong");v.textContent=esc(value??"--");div.append(l,v);return div;}
async function loadDetail(id){state.selected=id;state.events=null;state.result=null;const detail=byId("detail");detail.textContent="Loading evidence...";try{const [status,events,result]=await Promise.all([api("/api/tasks/"+encodeURIComponent(id)+"/status"),api("/api/tasks/"+encodeURIComponent(id)+"/events?limit=40&include_attempt=true"),api("/api/tasks/"+encodeURIComponent(id)+"/result?view=summary")]);state.detail=status;state.events=events;state.result=result;renderDetail();}catch(error){setError(error.message);detail.textContent="Evidence unavailable.";}}
function renderDetail(){const detail=byId("detail");const s=state.detail;if(!s){detail.textContent="Choose a task to inspect its durable evidence.";return;}detail.replaceChildren();const top=document.createElement("div");top.className="detail-title";const wrap=document.createElement("div");const h=document.createElement("h3");h.textContent=s.task_id;const p=document.createElement("p");p.textContent="Attempt "+s.attempt+" / "+s.status;wrap.append(h,p);const chip=document.createElement("span");chip.className=statusClass(s.status);chip.textContent=s.status;top.append(wrap,chip);detail.append(top);const grid=document.createElement("div");grid.className="meta";grid.append(meta("Created",s.created_at),meta("Updated",s.updated_at),meta("Worker PID",s.worker_pid),meta("Session",s.zcode_session_id),meta("Started",s.started_at),meta("Finished",s.finished_at));detail.append(grid);const actions=document.createElement("div");actions.className="actions";const cancel=document.createElement("button");cancel.className="secondary";cancel.type="button";cancel.textContent="Request cancel";cancel.addEventListener("click",()=>mutate("cancel",{}));actions.append(cancel);detail.append(actions);const label=document.createElement("div");label.className="section-label";label.textContent="Latest events";detail.append(label);const pre=document.createElement("pre");pre.className="pre";pre.textContent=JSON.stringify(state.events?.events??[],null,2);detail.append(pre);const resultLabel=document.createElement("div");resultLabel.className="section-label";resultLabel.textContent="Result summary";detail.append(resultLabel);const resultPre=document.createElement("pre");resultPre.className="pre";resultPre.textContent=JSON.stringify(state.result??{},null,2);detail.append(resultPre);if(s.status==="waiting_for_master"){const reply=document.createElement("form");reply.className="reply";reply.innerHTML='<div class="section-label">Interaction reply</div><div class="reply-grid"><input name="request_id" placeholder="request_id" required><select name="decision"><option value="allow">allow</option><option value="deny">deny</option><option value="accept">accept</option><option value="decline">decline</option></select><textarea name="reason" placeholder="reason (optional)"></textarea></div><button type="submit">Send reply</button>';reply.addEventListener("submit",event=>{event.preventDefault();const form=new FormData(reply);mutate("reply",{request_id:String(form.get("request_id")||""),decision:String(form.get("decision")||"allow"),...(String(form.get("reason")||"")?{reason:String(form.get("reason"))}:{})});});detail.append(reply);}const statusLine=document.createElement("div");statusLine.className="status-line";statusLine.id="detail-status";detail.append(statusLine);}
async function mutate(action,body){const target=state.selected;if(!target)return;setError("");try{await api("/api/tasks/"+encodeURIComponent(target)+"/"+action,{method:"POST",body:JSON.stringify(body),csrf:true,origin:location.origin});byId("detail-status").textContent=action+" accepted; refreshing evidence...";await loadDetail(target);}catch(error){setError(error.message);}}
async function refresh(){try{const session=await api("/api/session");state.csrf=session.csrf_token;byId("executor-state").textContent=String(session.executor?.state||"unknown").toUpperCase();byId("lease-id").textContent="lease: "+(session.executor?.lease_id||"--");const status=byId("status-filter").value;const page=await api("/api/tasks?limit=100"+(status?"&status="+encodeURIComponent(status):""));state.tasks=page.tasks||[];renderTasks();byId("last-refresh").textContent=new Date().toLocaleTimeString();}catch(error){setError(error.message);}}
byId("refresh").addEventListener("click",refresh);byId("filter").addEventListener("input",renderTasks);byId("status-filter").addEventListener("change",refresh);refresh();setInterval(refresh,5000);
</script>
</body>
</html>`;
