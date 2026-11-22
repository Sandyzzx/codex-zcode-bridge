import { createHash } from "node:crypto";
import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ExecutorWakeReleaseFact } from "../manager/sqlite-lifecycle-mcp-authority.js";

const WAKE_POLICY_FILE = "wake-policy.json";
const WAKE_POLICY_MAX_BYTES = 16 * 1024;
const WAKE_AUTHORIZATION_MAX_MS = 24 * 60 * 60 * 1000;
const WAKE_AUTHORIZATION_MIN_MS = 60 * 1000;
const WAKE_CONTROL_FRAME_MAX_BYTES = 1024 * 1024;
const WAKE_CONTROL_STDERR_MAX_BYTES = 8 * 1024;
const WAKE_QUEUE_TIMEOUT_MS = 10_000;
const WAKE_CONTROL_TIMEOUT_MS = 2_000;
const WAKE_TURN_OBSERVATION_MS = 2_000;
const WAKE_TURN_POLL_MS = 200;
const WAKE_LOADED_PAGE_LIMIT = 200;
const WAKE_LOADED_MAX_PAGES = 50;
const SAFE_REASONING_EFFORTS = new Set(["minimal", "low", "medium"]);
const WAKE_POLICY_KEYS = [
  "attempt",
  "authorization",
  "enabled",
  "fallback",
  "model",
  "model_provider",
  "reasoning_effort",
  "schema_version",
  "task_id",
  "thread_id",
  "workspace",
] as const;
const WAKE_AUTHORIZATION_KEYS = ["expires_at", "granted_at", "granted_by", "scope"] as const;

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
}

export interface ExecutorWakeRecorder {
  recordExecutorWakeObservation(input: ExecutorWakeObservationInput): {
    readonly duplicate: boolean;
    readonly state: ExecutorWakeState;
  };
}

export interface ExecutorWakePolicy {
  readonly schema_version: 1;
  readonly enabled: boolean;
  readonly task_id: string;
  readonly attempt: number;
  readonly thread_id: string;
  readonly workspace: string;
  readonly model: string;
  readonly model_provider: string;
  readonly reasoning_effort: "minimal" | "low" | "medium";
  readonly fallback: "web_notify";
  readonly authorization: {
    readonly scope: "one_turn";
    readonly granted_by: "owner";
    readonly granted_at: string;
    readonly expires_at: string;
  };
}

export interface ExecutorWakePolicyGrant {
  readonly task_id: string;
  readonly attempt: number;
  readonly thread_id: string;
  readonly workspace: string;
  readonly model: string;
  readonly model_provider: string;
  readonly reasoning_effort: "minimal" | "low" | "medium";
  readonly expires_in_ms: number;
}

type WakePolicyRead =
  | {
    readonly ok: true;
    readonly policy: ExecutorWakePolicy;
    readonly policy_digest: string;
    readonly authorization_digest: string;
  }
  | {
    readonly ok: false;
    readonly reason_code: string;
    readonly policy_digest: string;
    readonly authorization_digest: string;
    readonly thread_id: string | null;
  };

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
}

export interface ExecutorWakeCoordinator {
  handle(release: ExecutorWakeReleaseFact, recorder?: ExecutorWakeRecorder): Promise<{
    readonly state: "queued" | "submission_unknown" | "turn_started" | "web_notify" | "already_handled";
    readonly reason_code: string;
    readonly desktop_visible: "UNKNOWN";
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

/** Create the single Owner-authorized Wake policy. Existing policies are never overwritten. */
export function writeExecutorWakePolicy(
  authorityRoot: string,
  grant: ExecutorWakePolicyGrant,
  nowMs = Date.now(),
): {
  readonly path: string;
  readonly policy: ExecutorWakePolicy;
  readonly policy_digest: string;
  readonly authorization_digest: string;
} {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("EXECUTOR_WAKE_NOW_INVALID");
  if (!Number.isSafeInteger(grant.expires_in_ms)
    || grant.expires_in_ms < WAKE_AUTHORIZATION_MIN_MS
    || grant.expires_in_ms > WAKE_AUTHORIZATION_MAX_MS) {
    throw new Error("EXECUTOR_WAKE_AUTHORIZATION_DURATION_INVALID");
  }
  const root = path.resolve(authorityRoot);
  if (!lstatSync(root).isDirectory()) throw new Error("EXECUTOR_WAKE_AUTHORITY_ROOT_INVALID");
  const policyPath = path.join(root, WAKE_POLICY_FILE);
  const value = {
    schema_version: 1,
    enabled: true,
    task_id: grant.task_id,
    attempt: grant.attempt,
    thread_id: grant.thread_id,
    workspace: grant.workspace,
    model: grant.model,
    model_provider: grant.model_provider,
    reasoning_effort: grant.reasoning_effort,
    fallback: "web_notify",
    authorization: {
      scope: "one_turn",
      granted_by: "owner",
      granted_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + grant.expires_in_ms).toISOString(),
    },
  } as const;
  const policy = parseWakePolicy(value, nowMs);
  try {
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw Object.assign(
        new Error("A Wake policy already exists; refusing to overwrite Owner authorization"),
        { code: "WAKE_POLICY_EXISTS" },
      );
    }
    throw error;
  }
  return {
    path: policyPath,
    policy,
    policy_digest: wakeDigest(policy),
    authorization_digest: wakeDigest(policy.authorization),
  };
}

export function createExecutorWakeCoordinator(
  options: ExecutorWakeCoordinatorOptions,
): ExecutorWakeCoordinator {
  const authorityRoot = path.resolve(options.authorityRoot);
  const now = options.now ?? Date.now;
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
      const policyRead = readWakePolicy(authorityRoot, now());
      if (!policyRead.ok) {
        return recordWebFallback(recorder, notifyWeb, release, policyRead.thread_id,
          policyRead.policy_digest, policyRead.authorization_digest, policyRead.reason_code);
      }
      const bindingFailure = validatePolicyBinding(policyRead.policy, release);
      if (bindingFailure) {
        return recordWebFallback(recorder, notifyWeb, release, policyRead.policy.thread_id,
          policyRead.policy_digest, policyRead.authorization_digest, bindingFailure);
      }
      if (!policyRead.policy.enabled) {
        return recordWebFallback(recorder, notifyWeb, release, policyRead.policy.thread_id,
          policyRead.policy_digest, policyRead.authorization_digest, "policy_disabled");
      }
      if (!SAFE_REASONING_EFFORTS.has(policyRead.policy.reasoning_effort)) {
        return recordWebFallback(recorder, notifyWeb, release, policyRead.policy.thread_id,
          policyRead.policy_digest, policyRead.authorization_digest, "unsafe_reasoning_effort");
      }

      let session: WakeAppServerSession;
      try {
        session = await appServer.connect({ socketPath, executable: codexExecutable, timeoutMs: controlTimeoutMs });
      } catch {
        return recordWebFallback(recorder, notifyWeb, release, policyRead.policy.thread_id,
          policyRead.policy_digest, policyRead.authorization_digest, "app_server_unavailable");
      }

      try {
        let preflight: WakeThreadPreflight;
        try {
          preflight = await session.preflight(policyRead.policy.thread_id, controlTimeoutMs);
        } catch {
          return await recordWebFallback(recorder, notifyWeb, release, policyRead.policy.thread_id,
            policyRead.policy_digest, policyRead.authorization_digest, "app_server_preflight_failed");
        }
        const preflightFailure = validatePreflight(policyRead.policy, preflight);
        if (preflightFailure) {
          return await recordWebFallback(recorder, notifyWeb, release, policyRead.policy.thread_id,
            policyRead.policy_digest, policyRead.authorization_digest, preflightFailure);
        }

        const baselineTurnIds = preflight.recent_turns.map((turn) => turn.id);
        const deliveryId = wakeDeliveryId(release, policyRead.policy_digest);
        const intent: ExecutorWakeObservationInput = {
          operation_id: release.operation_id,
          task_id: release.task_id,
          attempt: release.attempt,
          generation: release.generation,
          state: "intent",
          thread_id: policyRead.policy.thread_id,
          delivery_id: deliveryId,
          policy_digest: policyRead.policy_digest,
          authorization_digest: policyRead.authorization_digest,
          reason_code: "queue_preflight_passed",
        };
        try {
          const recorded = recorder.recordExecutorWakeObservation(intent);
          if (recorded.duplicate) return wakeResult("already_handled", "prior_intent_already_recorded");
        } catch (error) {
          const code = errorCode(error);
          if (code === "executor_wake_intent_not_first") {
            return wakeResult("already_handled", "wake_history_already_exists");
          }
          throw error;
        }

        let submission: WakeQueueSubmission;
        try {
          submission = await queue.submit({
            executable: codexExecutable,
            threadId: policyRead.policy.thread_id,
            message: wakeMessage(release),
            timeoutMs: queueTimeoutMs,
          });
        } catch {
          return await recordObservation(recorder, notifyWeb, release, policyRead,
            deliveryId, "submission_unknown", "queue_submission_outcome_unknown", policyRead.policy.thread_id);
        }

        if (!submission.started) {
          return await recordObservation(recorder, notifyWeb, release, policyRead,
            deliveryId, "web_notify", "queue_command_unavailable", policyRead.policy.thread_id);
        }
        if (submission.timed_out || submission.signal !== null || submission.exit_code !== 0) {
          return await recordObservation(recorder, notifyWeb, release, policyRead,
            deliveryId, "submission_unknown",
            submission.timed_out ? "queue_submission_timeout" : "queue_submission_outcome_unknown",
            policyRead.policy.thread_id);
        }

        const queued = await recordObservation(recorder, notifyWeb, release, policyRead,
          deliveryId, "queued", "queue_command_accepted", policyRead.policy.thread_id);
        if (queued.state !== "queued" || turnObservationMs === 0) return queued;

        const deadline = Date.now() + turnObservationMs;
        do {
          try {
            if (await session.observeNewInProgressTurn(
              policyRead.policy.thread_id,
              baselineTurnIds,
              Math.max(1, Math.min(controlTimeoutMs, deadline - Date.now())),
            )) {
              return await recordObservation(recorder, notifyWeb, release, policyRead,
                deliveryId, "turn_started", "turn_in_progress_observed", policyRead.policy.thread_id);
            }
          } catch {
            break;
          }
          if (Date.now() >= deadline) break;
          await delay(Math.min(turnPollMs, Math.max(1, deadline - Date.now())));
        } while (Date.now() < deadline);
        return queued;
      } finally {
        await session.close().catch(() => undefined);
      }
    },
  };
}

function validatePolicyBinding(policy: ExecutorWakePolicy, release: ExecutorWakeReleaseFact): string | null {
  if (policy.task_id !== release.task_id) return "policy_task_mismatch";
  if (policy.attempt !== release.attempt) return "policy_attempt_mismatch";
  if (normalizeWorkspace(policy.workspace) !== normalizeWorkspace(release.workspace)) return "policy_workspace_mismatch";
  return null;
}

function validatePreflight(policy: ExecutorWakePolicy, preflight: WakeThreadPreflight): string | null {
  if (!preflight.loaded) return "thread_not_loaded";
  if (preflight.status !== "idle") return `thread_status_${preflight.status}`;
  if (preflight.can_accept_direct_input !== true) return "thread_direct_input_unavailable";
  if (preflight.cwd === null || normalizeWorkspace(preflight.cwd) !== normalizeWorkspace(policy.workspace)) {
    return "thread_workspace_mismatch";
  }
  if (preflight.model !== policy.model) return "thread_model_mismatch";
  if (preflight.model_provider !== policy.model_provider) return "thread_provider_mismatch";
  if (preflight.reasoning_effort !== policy.reasoning_effort) return "thread_reasoning_mismatch";
  if (preflight.reasoning_effort !== null && !SAFE_REASONING_EFFORTS.has(preflight.reasoning_effort)) {
    return "unsafe_reasoning_effort";
  }
  return null;
}

async function recordWebFallback(
  recorder: ExecutorWakeRecorder,
  notifyWeb: NonNullable<ExecutorWakeCoordinatorOptions["notifyWeb"]>,
  release: ExecutorWakeReleaseFact,
  threadId: string | null,
  policyDigest: string,
  authorizationDigest: string,
  reasonCode: string,
) {
  return recordObservation(
    recorder,
    notifyWeb,
    release,
    { policy_digest: policyDigest, authorization_digest: authorizationDigest },
    wakeDeliveryId(release, policyDigest),
    "web_notify",
    reasonCode,
    threadId,
  );
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
) {
  if (state !== "web_notify" && threadId === null) {
    throw new Error("EXECUTOR_WAKE_THREAD_BINDING_INTERNAL");
  }
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
  return wakeResult(state, reasonCode, result.duplicate);
}

function wakeResult(
  state: "queued" | "submission_unknown" | "turn_started" | "web_notify" | "already_handled",
  reasonCode: string,
  duplicate = false,
) {
  return {
    state,
    reason_code: reasonCode,
    desktop_visible: "UNKNOWN" as const,
    ...(duplicate ? { duplicate: true as const } : {}),
  };
}

function readWakePolicy(authorityRoot: string, nowMs: number): WakePolicyRead {
  const policyPath = path.join(authorityRoot, WAKE_POLICY_FILE);
  if (!existsSync(policyPath)) {
    return {
      ok: false,
      reason_code: "policy_missing",
      policy_digest: wakeDigest({ state: "missing", schema_version: 1 }),
      authorization_digest: wakeDigest({ state: "not_granted", schema_version: 1 }),
      thread_id: null,
    };
  }
  let raw = "";
  try {
    const stat = lstatSync(policyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > WAKE_POLICY_MAX_BYTES) {
      throw new Error("wake_policy_file_invalid");
    }
    raw = readFileSync(policyPath, "utf8");
    const value: unknown = JSON.parse(raw);
    const policy = parseWakePolicy(value, nowMs);
    return {
      ok: true,
      policy,
      policy_digest: wakeDigest(policy),
      authorization_digest: wakeDigest(policy.authorization),
    };
  } catch {
    return {
      ok: false,
      reason_code: "policy_invalid",
      policy_digest: createHash("sha256").update(raw || "wake-policy:invalid", "utf8").digest("hex"),
      authorization_digest: wakeDigest({ state: "invalid", schema_version: 1 }),
      thread_id: safeThreadHint(raw),
    };
  }
}

function parseWakePolicy(value: unknown, nowMs: number): ExecutorWakePolicy {
  if (!isRecord(value) || !hasExactKeys(value, WAKE_POLICY_KEYS)) throw new Error("wake_policy_shape_invalid");
  if (value.schema_version !== 1 || typeof value.enabled !== "boolean" || value.fallback !== "web_notify") {
    throw new Error("wake_policy_version_invalid");
  }
  const taskId = boundedIdentifier(value.task_id);
  const threadId = boundedIdentifier(value.thread_id);
  const model = boundedText(value.model, 256);
  const provider = boundedText(value.model_provider, 256);
  if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1) throw new Error("wake_policy_attempt_invalid");
  if (typeof value.workspace !== "string" || !path.isAbsolute(value.workspace)) throw new Error("wake_policy_workspace_invalid");
  if (value.reasoning_effort !== "minimal" && value.reasoning_effort !== "low" && value.reasoning_effort !== "medium") {
    throw new Error("wake_policy_reasoning_invalid");
  }
  if (!isRecord(value.authorization) || !hasExactKeys(value.authorization, WAKE_AUTHORIZATION_KEYS)) {
    throw new Error("wake_authorization_shape_invalid");
  }
  if (value.authorization.scope !== "one_turn" || value.authorization.granted_by !== "owner") {
    throw new Error("wake_authorization_scope_invalid");
  }
  const grantedAt = Date.parse(String(value.authorization.granted_at));
  const expiresAt = Date.parse(String(value.authorization.expires_at));
  if (!Number.isFinite(grantedAt) || !Number.isFinite(expiresAt)
    || grantedAt > nowMs || expiresAt <= nowMs || expiresAt <= grantedAt
    || expiresAt - grantedAt > WAKE_AUTHORIZATION_MAX_MS) {
    throw new Error("wake_authorization_time_invalid");
  }
  return {
    schema_version: 1,
    enabled: value.enabled,
    task_id: taskId,
    attempt: Number(value.attempt),
    thread_id: threadId,
    workspace: normalizeWorkspace(value.workspace),
    model,
    model_provider: provider,
    reasoning_effort: value.reasoning_effort,
    fallback: "web_notify",
    authorization: {
      scope: "one_turn",
      granted_by: "owner",
      granted_at: String(value.authorization.granted_at),
      expires_at: String(value.authorization.expires_at),
    },
  };
}

function safeThreadHint(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) && typeof value.thread_id === "string" && isIdentifier(value.thread_id)
      ? value.thread_id
      : null;
  } catch {
    return null;
  }
}

function wakeMessage(release: ExecutorWakeReleaseFact): string {
  return [
    "[CODEX-ZCODE BRIDGE WAKE]",
    `Task ${release.task_id} attempt ${release.attempt} completed with status ${release.result_status}.`,
    `Operation ${release.operation_id} released; result digest ${release.result_digest}.`,
    "Read the persisted result with zcode_result (view=summary) before deciding the next action.",
    "This Wake reports delivery only. It does not accept the Task, release Bridge resources, or authorize new work.",
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

function normalizeWorkspace(value: string): string {
  const resolved = path.resolve(value);
  try {
    const canonical = realpathSync.native(resolved);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}

function boundedDuration(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("EXECUTOR_WAKE_DURATION_INVALID");
  return value;
}

function boundedIdentifier(value: unknown): string {
  if (!isIdentifier(value)) throw new Error("wake_identifier_invalid");
  return value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/u.test(value) && value === value.normalize("NFC");
}

function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes
    || value !== value.normalize("NFC")) {
    throw new Error("wake_text_invalid");
  }
  return value;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
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
        });
      });
    });
  }
}
