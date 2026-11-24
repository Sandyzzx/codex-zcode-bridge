import { createHash } from "node:crypto";
import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ExecutorWakeReleaseFact } from "../manager/sqlite-lifecycle-mcp-authority.js";

const WAKE_CONTROL_FRAME_MAX_BYTES = 1024 * 1024;
const WAKE_CONTROL_STDERR_MAX_BYTES = 8 * 1024;
const WAKE_QUEUE_TIMEOUT_MS = 10_000;
const WAKE_CONTROL_TIMEOUT_MS = 2_000;
const WAKE_TURN_OBSERVATION_MS = 2_000;
const WAKE_TURN_POLL_MS = 200;
const WAKE_LOADED_PAGE_LIMIT = 200;
const WAKE_LOADED_MAX_PAGES = 50;

export type ExecutorWakeState = "intent" | "queued" | "submission_unknown" | "turn_started" | "web_notify";

export interface ExecutorWakeObservationInput {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly state: ExecutorWakeState;
  readonly thread_id: string | null;
  readonly delivery_id: string;
  readonly policy_digest: string;
  readonly authorization_digest: string;
  readonly reason_code: string;
  readonly queue_message_id?: string;
}

export interface ExecutorWakeRecorder {
  recordExecutorWakeObservation(input: ExecutorWakeObservationInput): {
    readonly duplicate: boolean;
    readonly state: ExecutorWakeState;
  };
}

export interface WakeThreadTurn {
  readonly id: string;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
}

export interface WakeThreadPreflight {
  readonly loaded: boolean;
  readonly status: "notLoaded" | "idle" | "active" | "systemError" | "unknown";
  readonly can_accept_direct_input: boolean | null;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly model_provider: string | null;
  readonly reasoning_effort: string | null;
  readonly recent_turns: readonly WakeThreadTurn[];
}

export interface WakeAppServerSession {
  preflight(threadId: string, timeoutMs: number): Promise<WakeThreadPreflight>;
  observeNewInProgressTurn(
    threadId: string,
    baselineTurnIds: readonly string[],
    timeoutMs: number,
  ): Promise<boolean>;
  close(): Promise<void>;
}

export interface WakeAppServerConnector {
  connect(input: {
    readonly socketPath: string;
    readonly executable: string;
    readonly timeoutMs: number;
  }): Promise<WakeAppServerSession>;
}

export interface WakeQueueSubmission {
  readonly started: boolean;
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly timed_out: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly queue_message_id: string | null;
}

export interface WakeQueueRunner {
  submit(input: {
    readonly executable: string;
    readonly threadId: string;
    readonly message: string;
    readonly timeoutMs: number;
  }): Promise<WakeQueueSubmission>;
}

export interface ExecutorWakeCoordinatorOptions {
  readonly authorityRoot: string;
  readonly recorder?: ExecutorWakeRecorder;
  readonly appServer?: WakeAppServerConnector;
  readonly queue?: WakeQueueRunner;
  readonly codexExecutable?: string;
  readonly socketPath?: string;
  readonly now?: () => number;
  readonly notifyWeb?: (input: {
    readonly task_id: string;
    readonly attempt: number;
    readonly operation_id: string;
    readonly reason_code: string;
    readonly state: "web_notify";
  }) => void;
  readonly queueTimeoutMs?: number;
  readonly controlTimeoutMs?: number;
  readonly turnObservationMs?: number;
  readonly turnPollMs?: number;
  /** Read at delivery time so a settings change applies to later Wake attempts. */
  readonly autoWakeEnabled?: () => boolean;
}

export interface ExecutorWakeCoordinator {
  handle(release: ExecutorWakeReleaseFact, recorder?: ExecutorWakeRecorder): Promise<{
    readonly state: "queued" | "submission_unknown" | "turn_started" | "web_notify" | "already_handled";
    readonly reason_code: string;
    readonly desktop_visible: "UNKNOWN";
    readonly queue_message_id?: string;
  }>;
}

export interface AppServerProxyConnectorOptions {
  readonly spawnImpl?: typeof spawn;
  readonly clientVersion?: string;
}

export interface QueueCommandRunnerOptions {
  readonly spawnImpl?: typeof spawn;
}

export function defaultAppServerControlSocket(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
): string {
  const override = env.ZCODE_BRIDGE_APP_SERVER_CONTROL_SOCKET?.trim();
  if (override) return path.resolve(override);
  const codexHome = env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
  return path.join(path.resolve(codexHome), "app-server-control", "app-server-control.sock");
}

export function defaultCodexExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_BRIDGE_CODEX_EXECUTABLE?.trim() || (process.platform === "win32" ? "codex.exe" : "codex");
}

export function createExecutorWakeCoordinator(
  options: ExecutorWakeCoordinatorOptions,
): ExecutorWakeCoordinator {
  const appServer = options.appServer ?? new AppServerProxyConnector();
  const queue = options.queue ?? new QueueCommandRunner();
  const codexExecutable = options.codexExecutable ?? defaultCodexExecutable();
  const socketPath = options.socketPath ?? defaultAppServerControlSocket();
  const queueTimeoutMs = boundedDuration(options.queueTimeoutMs, WAKE_QUEUE_TIMEOUT_MS, 1, 60_000);
  const controlTimeoutMs = boundedDuration(options.controlTimeoutMs, WAKE_CONTROL_TIMEOUT_MS, 250, 10_000);
  const turnObservationMs = boundedDuration(options.turnObservationMs, WAKE_TURN_OBSERVATION_MS, 0, 10_000);
  const turnPollMs = boundedDuration(options.turnPollMs, WAKE_TURN_POLL_MS, 25, 1_000);
  const notifyWeb = options.notifyWeb ?? ((input) => {
    console.error(`EXECUTOR_WAKE_WEB_NOTIFY ${JSON.stringify(input)}`);
  });

  return {
    async handle(release, recorderOverride) {
      const recorder = recorderOverride ?? options.recorder;
      if (!recorder) throw new Error("EXECUTOR_WAKE_RECORDER_UNAVAILABLE");
      const threadId = release.owner_binding_state === "bound" ? release.owner_thread_id : null;
      const policyDigest = wakeDigest({
        contract: "auto-wake-release-v2",
        task_id: release.task_id,
        attempt: release.attempt,
        operation_id: release.operation_id,
        generation: release.generation,
        result_digest: release.result_digest,
        result_commit_ref: release.result_commit_ref,
        owner_thread_id: threadId,
      });
      const authorizationDigest = wakeDigest({
        contract: "plugin-installed-auto-wake-v1",
        schema_version: 2,
        state: "accepted",
      });
      const deliveryId = wakeDeliveryId(release, policyDigest);
      if (threadId === null) {
        return recordObservation(
          recorder,
          notifyWeb,
          release,
          { policy_digest: policyDigest, authorization_digest: authorizationDigest },
          deliveryId,
          "web_notify",
          "owner_thread_unavailable",
          null,
        );
      }
      if (options.autoWakeEnabled?.() === false) {
        return recordObservation(
          recorder,
          notifyWeb,
          release,
          { policy_digest: policyDigest, authorization_digest: authorizationDigest },
          deliveryId,
          "web_notify",
          "auto_wake_disabled",
          threadId,
        );
      }

      const recordIntent = (reasonCode: string): ReturnType<typeof wakeResult> | null => {
        const intent: ExecutorWakeObservationInput = {
          operation_id: release.operation_id,
          task_id: release.task_id,
          attempt: release.attempt,
          generation: release.generation,
          state: "intent",
          thread_id: threadId,
          delivery_id: deliveryId,
          policy_digest: policyDigest,
          authorization_digest: authorizationDigest,
          reason_code: reasonCode,
        };
        try {
          const recorded = recorder.recordExecutorWakeObservation(intent);
          if (recorded.duplicate) {
            return wakeResult("already_handled", "prior_intent_already_recorded");
          }
          return null;
        } catch (error) {
          if (errorCode(error) === "executor_wake_intent_not_first") {
            return wakeResult("already_handled", "wake_history_already_exists");
          }
          throw error;
        }
      };

      const alreadyHandled = recordIntent("plugin_installed_auto_wake");
      if (alreadyHandled) return alreadyHandled;
      const queued = await submitWakeQueue(
        recorder,
        notifyWeb,
        release,
        { policy_digest: policyDigest, authorization_digest: authorizationDigest },
        deliveryId,
        threadId,
        queue,
        codexExecutable,
        queueTimeoutMs,
      );
      if (queued.state !== "queued") return queued;

      // Queue acknowledgement is not Turn-start evidence. Observe the real
      // Thread when the local control channel is available; otherwise retain
      // the durable Queue fact and record an explicit fallback observation.
      const turnStarted = await observeTurnStart({
        appServer,
        socketPath,
        codexExecutable,
        threadId,
        controlTimeoutMs,
        turnObservationMs,
        turnPollMs,
      });
      if (turnStarted) {
        return recordObservation(
          recorder,
          notifyWeb,
          release,
          { policy_digest: policyDigest, authorization_digest: authorizationDigest },
          deliveryId,
          "turn_started",
          "turn_in_progress_observed",
          threadId,
        );
      }
      const fallback = await recordObservation(
        recorder,
        notifyWeb,
        release,
        { policy_digest: policyDigest, authorization_digest: authorizationDigest },
        deliveryId,
        "web_notify",
        "turn_start_unverified",
        threadId,
      );
      return {
        ...fallback,
        ...(queued.queue_message_id ? { queue_message_id: queued.queue_message_id } : {}),
      };
    },
  };
}

async function observeTurnStart(input: {
  readonly appServer: WakeAppServerConnector;
  readonly socketPath: string;
  readonly codexExecutable: string;
  readonly threadId: string;
  readonly controlTimeoutMs: number;
  readonly turnObservationMs: number;
  readonly turnPollMs: number;
}): Promise<boolean> {
  if (input.turnObservationMs === 0) return false;
  let session: WakeAppServerSession;
  try {
    session = await input.appServer.connect({
      socketPath: input.socketPath,
      executable: input.codexExecutable,
      timeoutMs: input.controlTimeoutMs,
    });
  } catch {
    return false;
  }
  try {
    let preflight: WakeThreadPreflight;
    try {
      preflight = await session.preflight(input.threadId, input.controlTimeoutMs);
    } catch {
      return false;
    }
    const baselineTurnIds = preflight.recent_turns.map((turn) => turn.id);
    const deadline = Date.now() + input.turnObservationMs;
    do {
      try {
        if (await session.observeNewInProgressTurn(
          input.threadId,
          baselineTurnIds,
          Math.max(1, Math.min(input.controlTimeoutMs, deadline - Date.now())),
        )) return true;
      } catch {
        return false;
      }
      if (Date.now() >= deadline) return false;
      await delay(Math.min(input.turnPollMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return false;
  } finally {
    await session.close().catch(() => undefined);
  }
}

async function submitWakeQueue(
  recorder: ExecutorWakeRecorder,
  notifyWeb: NonNullable<ExecutorWakeCoordinatorOptions["notifyWeb"]>,
  release: ExecutorWakeReleaseFact,
  binding: {
    readonly policy_digest: string;
    readonly authorization_digest: string;
  },
  deliveryId: string,
  threadId: string,
  queue: WakeQueueRunner,
  codexExecutable: string,
  queueTimeoutMs: number,
) {
  let submission: WakeQueueSubmission;
  try {
    submission = await queue.submit({
      executable: codexExecutable,
      threadId,
      message: wakeMessage(release),
      timeoutMs: queueTimeoutMs,
    });
  } catch {
    return recordObservation(recorder, notifyWeb, release, binding,
      deliveryId, "submission_unknown", "queue_submission_outcome_unknown", threadId);
  }

  if (!submission.started) {
    return recordObservation(recorder, notifyWeb, release, binding,
      deliveryId, "web_notify", "queue_command_unavailable", threadId);
  }
  if (submission.timed_out || submission.signal !== null || submission.exit_code !== 0) {
    return recordObservation(recorder, notifyWeb, release, binding,
      deliveryId, "submission_unknown",
      submission.timed_out ? "queue_submission_timeout" : "queue_submission_outcome_unknown",
      threadId);
  }
  return recordObservation(recorder, notifyWeb, release, binding,
    deliveryId, "queued", "queue_command_accepted", threadId,
    submission.queue_message_id);
}

async function recordObservation(
  recorder: ExecutorWakeRecorder,
  notifyWeb: NonNullable<ExecutorWakeCoordinatorOptions["notifyWeb"]>,
  release: ExecutorWakeReleaseFact,
  binding: {
    readonly policy_digest: string;
    readonly authorization_digest: string;
  },
  deliveryId: string,
  state: "queued" | "submission_unknown" | "turn_started" | "web_notify",
  reasonCode: string,
  threadId: string | null,
  queueMessageId?: string | null,
) {
  if (state !== "web_notify" && threadId === null) {
    throw new Error("EXECUTOR_WAKE_THREAD_BINDING_INTERNAL");
  }
  const queueMessageIdForEvidence = state === "queued" && isIdentifier(queueMessageId)
    ? queueMessageId
    : undefined;
  const result = recorder.recordExecutorWakeObservation({
    operation_id: release.operation_id,
    task_id: release.task_id,
    attempt: release.attempt,
    generation: release.generation,
    state,
    thread_id: threadId,
    delivery_id: deliveryId,
    policy_digest: binding.policy_digest,
    authorization_digest: binding.authorization_digest,
    reason_code: reasonCode,
    ...(queueMessageIdForEvidence ? { queue_message_id: queueMessageIdForEvidence } : {}),
  });
  if (state === "web_notify" && !result.duplicate) {
    try {
      notifyWeb({
        task_id: release.task_id,
        attempt: release.attempt,
        operation_id: release.operation_id,
        reason_code: reasonCode,
        state: "web_notify",
      });
    } catch {
      // The SQLite Wake fact is authoritative; presentation failure is not submission evidence.
    }
  }
  return wakeResult(state, reasonCode, result.duplicate, queueMessageIdForEvidence);
}

function wakeResult(
  state: "queued" | "submission_unknown" | "turn_started" | "web_notify" | "already_handled",
  reasonCode: string,
  duplicate = false,
  queueMessageId: string | null | undefined = undefined,
) {
  return {
    state,
    reason_code: reasonCode,
    desktop_visible: "UNKNOWN" as const,
    ...(duplicate ? { duplicate: true as const } : {}),
    ...(queueMessageId ? { queue_message_id: queueMessageId } : {}),
  };
}

function wakeMessage(release: ExecutorWakeReleaseFact): string {
  return [
    "[CODEX-ZCODE BRIDGE WAKE - VERIFIED RELEASE FACTS]",
    `Task: ${release.task_id}`,
    `Attempt: ${release.attempt}`,
    `Operation: ${release.operation_id} (released)`,
    `Result status: ${release.result_status}`,
    `Result digest: ${release.result_digest}`,
    `Result commit: ${release.result_commit_ref}`,
    "Required readback: use the host-registered native MCP tools directly: call zcode_status for this Task and Attempt, then call " +
      `zcode_result(view="summary", expected_attempt=${release.attempt}) and verify the same Result digest.`,
    "Do not launch bridge.mjs, Thin MCP, the Task CLI, Node, PowerShell, or another shell child for readback; a sandboxed shell child is not the native Host MCP path.",
    "Check Cleanup verified and Operation released before independently checking the Task's acceptance criteria.",
    "Do not create a duplicate Task. A fixed ACK alone is not acceptance. This Wake does not authorize new work.",
  ].join("\n");
}

function wakeDeliveryId(release: ExecutorWakeReleaseFact, policyDigest: string): string {
  return wakeDigest({
    contract: "executor-wake-delivery-v1",
    task_id: release.task_id,
    attempt: release.attempt,
    operation_id: release.operation_id,
    generation: release.generation,
    result_digest: release.result_digest,
    result_commit_ref: release.result_commit_ref,
    policy_digest: policyDigest,
  });
}

function boundedDuration(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("EXECUTOR_WAKE_DURATION_INVALID");
  return value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/u.test(value) && value === value.normalize("NFC");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wakeDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("wake_digest_number_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("wake_digest_value_invalid");
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class AppServerProxyConnector implements WakeAppServerConnector {
  readonly #spawnImpl: typeof spawn;
  readonly #clientVersion: string;

  constructor(options: AppServerProxyConnectorOptions = {}) {
    this.#spawnImpl = options.spawnImpl ?? spawn;
    this.#clientVersion = options.clientVersion ?? "2.0.0-preview.11";
  }

  async connect(input: {
    readonly socketPath: string;
    readonly executable: string;
    readonly timeoutMs: number;
  }): Promise<WakeAppServerSession> {
    if (!existsSync(input.socketPath)) throw new Error("app_server_control_socket_unavailable");
    const child = this.#spawnImpl(
      input.executable,
      ["app-server", "proxy", "--sock", input.socketPath],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false },
    ) as ChildProcessWithoutNullStreams;
    const session = new AppServerProxySession(child, this.#clientVersion);
    try {
      await session.initialize(input.timeoutMs);
      return session;
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }
}

class AppServerProxySession implements WakeAppServerSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #clientVersion: string;
  readonly #pending = new Map<number, {
    readonly method: string;
    readonly resolve: (value: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();
  #nextId = 1;
  #buffer = "";
  #stderr = "";
  #closed = false;

  constructor(child: ChildProcessWithoutNullStreams, clientVersion: string) {
    this.#child = child;
    this.#clientVersion = clientVersion;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-WAKE_CONTROL_STDERR_MAX_BYTES);
    });
    child.once("error", (error) => this.#fail(new Error(`app_server_proxy_spawn_failed:${error.message}`)));
    child.once("close", () => this.#fail(new Error("app_server_proxy_closed")));
  }

  async initialize(timeoutMs: number): Promise<void> {
    await this.#request("initialize", {
      clientInfo: { name: "codex-zcode-bridge-executor", version: this.#clientVersion },
      capabilities: { experimentalApi: false },
    }, timeoutMs);
    this.#write({ method: "initialized" });
  }

  async preflight(threadId: string, timeoutMs: number): Promise<WakeThreadPreflight> {
    let loaded = false;
    let cursor: string | null = null;
    for (let page = 0; page < WAKE_LOADED_MAX_PAGES; page += 1) {
      const value = await this.#request("thread/loaded/list", {
        cursor,
        limit: WAKE_LOADED_PAGE_LIMIT,
      }, timeoutMs);
      if (!Array.isArray(value.data) || !value.data.every((item) => typeof item === "string")) {
        throw new Error("app_server_loaded_list_invalid");
      }
      if (value.data.includes(threadId)) loaded = true;
      if (loaded || value.nextCursor === null || value.nextCursor === undefined) break;
      if (typeof value.nextCursor !== "string" || value.nextCursor === cursor) throw new Error("app_server_loaded_cursor_invalid");
      cursor = value.nextCursor;
    }

    const read = await this.#request("thread/read", { threadId, includeTurns: false }, timeoutMs);
    const thread = read.thread;
    if (!isRecord(thread) || thread.id !== threadId || !isRecord(thread.status)) {
      throw new Error("app_server_thread_read_invalid");
    }
    const status = typeof thread.status.type === "string" ? thread.status.type : "unknown";
    const turns = await this.#turns(threadId, timeoutMs);
    return {
      loaded,
      status: status as WakeThreadPreflight["status"],
      can_accept_direct_input: typeof thread.canAcceptDirectInput === "boolean" ? thread.canAcceptDirectInput : null,
      cwd: typeof thread.cwd === "string" ? thread.cwd : null,
      model: typeof thread.model === "string" ? thread.model : null,
      model_provider: typeof thread.modelProvider === "string" ? thread.modelProvider : null,
      reasoning_effort: typeof thread.reasoningEffort === "string" ? thread.reasoningEffort : null,
      recent_turns: turns,
    };
  }

  async observeNewInProgressTurn(
    threadId: string,
    baselineTurnIds: readonly string[],
    timeoutMs: number,
  ): Promise<boolean> {
    const baseline = new Set(baselineTurnIds);
    const turns = await this.#turns(threadId, timeoutMs);
    return turns.some((turn) => !baseline.has(turn.id) && turn.status === "inProgress");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new Error("app_server_proxy_session_closed"));
    if (!this.#child.killed) this.#child.kill();
    await Promise.race([
      new Promise<void>((resolve) => this.#child.once("close", () => resolve())),
      delay(250),
    ]);
  }

  async #turns(threadId: string, timeoutMs: number): Promise<readonly WakeThreadTurn[]> {
    const value = await this.#request("thread/turns/list", {
      threadId,
      cursor: null,
      limit: 5,
      sortDirection: "desc",
      itemsView: "notLoaded",
    }, timeoutMs);
    if (!Array.isArray(value.data)) throw new Error("app_server_turn_list_invalid");
    return value.data.flatMap((item): WakeThreadTurn[] => {
      if (!isRecord(item) || typeof item.id !== "string"
        || !["completed", "interrupted", "failed", "inProgress"].includes(String(item.status))) return [];
      return [{ id: item.id, status: item.status as WakeThreadTurn["status"] }];
    });
  }

  #request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new Error("app_server_proxy_session_closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`app_server_proxy_timeout:${method}`));
        void this.close();
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  #write(value: Record<string, unknown>): void {
    if (this.#closed || !this.#child.stdin.writable) throw new Error("app_server_proxy_write_unavailable");
    this.#child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) this.#fail(new Error(`app_server_proxy_write_failed:${error.message}`));
    });
  }

  #onData(chunk: string): void {
    if (this.#closed) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > WAKE_CONTROL_FRAME_MAX_BYTES && !this.#buffer.includes("\n")) {
      this.#fail(new Error("app_server_proxy_frame_oversize"));
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#onLine(line);
      if (this.#closed) return;
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > WAKE_CONTROL_FRAME_MAX_BYTES) {
      this.#fail(new Error("app_server_proxy_frame_oversize"));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#fail(new Error("app_server_proxy_frame_invalid"));
      return;
    }
    if (!isRecord(value)) {
      this.#fail(new Error("app_server_proxy_message_invalid"));
      return;
    }
    if (typeof value.id === "number" && typeof value.method === "string") {
      this.#write({ id: value.id, error: { code: -32601, message: "unsupported app-server request" } });
      return;
    }
    if (typeof value.id !== "number") return;
    const pending = this.#pending.get(value.id);
    if (!pending) return;
    this.#pending.delete(value.id);
    clearTimeout(pending.timer);
    if (isRecord(value.error)) {
      pending.reject(new Error(
        `app_server_proxy_request_failed:${pending.method}:${String(value.error.code ?? "unknown")}`,
      ));
      return;
    }
    if (!isRecord(value.result)) {
      pending.reject(new Error(`app_server_proxy_result_invalid:${pending.method}`));
      return;
    }
    pending.resolve(value.result);
  }

  #fail(error: Error): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export class QueueCommandRunner implements WakeQueueRunner {
  readonly #spawnImpl: typeof spawn;

  constructor(options: QueueCommandRunnerOptions = {}) {
    this.#spawnImpl = options.spawnImpl ?? spawn;
  }

  submit(input: {
    readonly executable: string;
    readonly threadId: string;
    readonly message: string;
    readonly timeoutMs: number;
  }): Promise<WakeQueueSubmission> {
    return new Promise((resolve) => {
      let started = false;
      let settled = false;
      let timedOut = false;
      let stdout = "";
      let stderr = "";
      const child = this.#spawnImpl(
        input.executable,
        ["queue", "--thread", input.threadId, "--message", input.message],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false },
      ) as ChildProcessByStdio<null, Readable, Readable>;
      const finish = (submission: WakeQueueSubmission): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(submission);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (!child.killed) child.kill();
        finish({
          started,
          exit_code: null,
          signal: null,
          timed_out: true,
          stdout,
          stderr,
          queue_message_id: parseQueueMessageId(stdout),
        });
      }, input.timeoutMs);
      timer.unref?.();
      child.once("spawn", () => {
        started = true;
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(-8 * 1024);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-8 * 1024);
      });
      child.once("error", () => {
        finish({
          started,
          exit_code: null,
          signal: null,
          timed_out: timedOut,
          stdout,
          stderr,
          queue_message_id: parseQueueMessageId(stdout),
        });
      });
      child.once("close", (exitCode, signal) => {
        finish({
          started,
          exit_code: exitCode,
          signal,
          timed_out: timedOut,
          stdout,
          stderr,
          queue_message_id: parseQueueMessageId(stdout),
        });
      });
    });
  }
}

function parseQueueMessageId(stdout: string): string | null {
  const match = /^Queued message ([A-Za-z0-9._:-]{1,128}) for thread [A-Za-z0-9._:-]{1,128}\.?$/mu.exec(stdout.trim());
  return match?.[1] ?? null;
}
