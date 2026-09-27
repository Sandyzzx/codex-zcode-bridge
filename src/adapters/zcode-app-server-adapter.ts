// Streaming ZCode Protocol adapter for Phase 7. The wire protocol is versioned
// with the installed ZCode runtime; docs/PHASE7_LIVE_PROGRESS.md records the
// local 0.16.9 observations and compatibility boundary.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AgentHandle,
  AgentProcessStatus,
  CodingAgentAdapter,
  RuntimeResolver,
  TaskPackage,
  TaskResult,
  WorkspaceRef,
  ZCodeRuntimeConfig,
} from "../interfaces.js";
import { parseAgentReport } from "./agent-report.js";
import type { ZCodeRunOutcome } from "./zcode-adapter.js";
import { buildContinuePrompt, buildTaskPrompt } from "../prompts/task-prompt.js";
import { BridgeError } from "../runtime/errors.js";
import { NodeRuntimeResolver } from "../runtime/resolver.js";
import { terminateProcessTree } from "./process-spawn.js";
import { createMinimalOsEnv } from "../runtime/child-env.js";

type ProgressEvent = { type: string; summary: string; details?: Record<string, unknown> };
type ProgressSink = (event: ProgressEvent) => void;
type JsonRecord = Record<string, unknown>;

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface AppServerClient {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params: JsonRecord): Promise<unknown>;
  close(): Promise<void>;
  readonly stderr: string;
}

interface RunEntry {
  handle: AgentHandle;
  child: ChildProcessWithoutNullStreams | null;
  client: AppServerClient | null;
  sessionId: string | null;
  finished: boolean;
  timedOut: boolean;
  cancelRequested: boolean;
  outcome: ZCodeRunOutcome | null;
  error: unknown;
  runPromise: Promise<ZCodeRunOutcome>;
  resolveTurn: (value: { response: string; usage: Record<string, unknown> | null; resultType: string | null }) => void;
  rejectTurn: (error: Error) => void;
  onEvent: ProgressSink;
  textOutputStarted: boolean;
  selectedModel: string | null;
  lastEventSeq: number;
}

export interface ZCodeAppServerAdapterOptions {
  resolver?: RuntimeResolver;
  onEvent?: ProgressSink;
  timeoutMs?: number;
  childEnvBase?: NodeJS.ProcessEnv;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_CHARS = 2_000_000;

/**
 * Runs one task in a ZCode app-server session and persists safe progress
 * events through onEvent. Only visible text deltas are emitted; reasoning and
 * raw tool input/output are deliberately excluded.
 */
export class ZCodeAppServerAdapter implements CodingAgentAdapter {
  readonly #resolver: RuntimeResolver;
  readonly #onEvent: ProgressSink;
  readonly #timeoutMs: number;
  readonly #childEnvBase: NodeJS.ProcessEnv;
  readonly #now: () => Date;
  readonly #runs = new Map<AgentHandle, RunEntry>();
  readonly #workspaceByTask = new Map<string, string>();

  constructor(options: ZCodeAppServerAdapterOptions = {}) {
    this.#resolver = options.resolver ?? new NodeRuntimeResolver();
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#childEnvBase = options.childEnvBase ?? process.env;
    this.#now = options.now ?? (() => new Date());
  }

  async startTask(input: { task: TaskPackage; workspace: WorkspaceRef; attempt: number }): Promise<AgentHandle> {
    return this.#launch(input.task, input.workspace, input.attempt, buildTaskPrompt(input.task), null);
  }

  async continueTask(input: {
    task: TaskPackage;
    workspace: WorkspaceRef;
    attempt: number;
    feedback: string;
    additionalRequirements: string[];
    previousSessionId: string | null;
    previousResult: TaskResult | null;
  }): Promise<AgentHandle> {
    const priorWorkspace = this.#workspaceByTask.get(input.task.task_id);
    if (priorWorkspace !== undefined && priorWorkspace !== input.workspace.canonicalPath) {
      throw new Error(`continuation workspace mismatch for task ${input.task.task_id}`);
    }
    return this.#launch(
      input.task,
      input.workspace,
      input.attempt,
      buildContinuePrompt({
        task: input.task,
        feedback: input.feedback,
        additionalRequirements: input.additionalRequirements,
        previousSessionId: input.previousSessionId,
        previousResult: input.previousResult,
      }),
      input.previousSessionId,
    );
  }

  async getStatus(handle: AgentHandle): Promise<AgentProcessStatus> {
    const entry = this.#require(handle, "getStatus");
    return {
      state: entry.finished ? "exited" : entry.child ? "running" : "starting",
      workerPid: handle.workerPid,
      zcodePid: entry.child?.pid ?? null,
      exitCode: entry.outcome?.exitCode ?? null,
      signal: entry.outcome?.signal ?? null,
    };
  }

  async getResult(handle: AgentHandle): Promise<ZCodeRunOutcome> {
    const entry = this.#require(handle, "getResult");
    if (entry.error) throw entry.error;
    if (entry.outcome) return entry.outcome;
    return entry.runPromise;
  }

  async cancelTask(handle: AgentHandle): Promise<void> {
    const entry = this.#require(handle, "cancelTask");
    if (entry.finished) return;
    entry.cancelRequested = true;
    const pid = entry.child?.pid;
    if (pid) await terminateProcessTree(pid);
  }

  async #launch(
    task: TaskPackage,
    workspace: WorkspaceRef,
    attempt: number,
    prompt: string,
    resumeSessionId: string | null,
  ): Promise<AgentHandle> {
    const handle: AgentHandle = {
      taskId: task.task_id,
      attempt,
      workerPid: process.pid,
      zcodePid: null,
      startedAt: this.#now().toISOString(),
    };
    let resolveTurn!: RunEntry["resolveTurn"];
    let rejectTurn!: RunEntry["rejectTurn"];
    const turn = new Promise<{ response: string; usage: Record<string, unknown> | null; resultType: string | null }>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    void turn.catch(() => undefined);
    const entry: RunEntry = {
      handle,
      child: null,
      client: null,
      sessionId: resumeSessionId,
      finished: false,
      timedOut: false,
      cancelRequested: false,
      outcome: null,
      error: null,
      runPromise: Promise.resolve(null as unknown as ZCodeRunOutcome),
      resolveTurn,
      rejectTurn,
      onEvent: this.#onEvent,
      textOutputStarted: false,
      selectedModel: null,
      lastEventSeq: 0,
    };
    this.#runs.set(handle, entry);
    this.#workspaceByTask.set(task.task_id, workspace.canonicalPath);
    entry.runPromise = this.#execute(entry, task, workspace, prompt, resumeSessionId, turn);
    void entry.runPromise.then(
      (outcome) => { entry.outcome = outcome; entry.finished = true; },
      (error) => { entry.error = error; entry.finished = true; },
    );
    return handle;
  }

  async #execute(
    entry: RunEntry,
    task: TaskPackage,
    workspace: WorkspaceRef,
    prompt: string,
    resumeSessionId: string | null,
    turn: Promise<{ response: string; usage: Record<string, unknown> | null; resultType: string | null }>,
  ): Promise<ZCodeRunOutcome> {
    const startedAt = this.#now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const config = await this.#resolver.resolve();
      const childEnv = this.#buildChildEnv(config);
      entry.onEvent({ type: "zcode_starting", summary: "Starting ZCode streaming runtime" });
      const client = this.#startAppServer(config, workspace.canonicalPath, childEnv, entry);
      entry.client = client;
      entry.child = client.child;
      timer = setTimeout(() => {
        entry.timedOut = true;
        const pid = entry.child?.pid;
        if (pid) void terminateProcessTree(pid).catch(() => undefined);
        entry.rejectTurn(new Error(`ZCode run exceeded ${this.#timeoutMs}ms wall-clock budget`));
      }, this.#timeoutMs);
      timer.unref();

      let snapshot: JsonRecord;
      if (resumeSessionId) {
        snapshot = asRecord(await client.request("session/resume", {
          sessionId: resumeSessionId,
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: workspace.canonicalPath },
        }));
        const returnedId = nestedString(snapshot, ["session", "sessionId"]);
        if (returnedId && returnedId !== resumeSessionId) {
          throw new Error(`resume session mismatch: requested ${resumeSessionId}, runtime returned ${returnedId}`);
        }
      } else {
        snapshot = asRecord(await client.request("session/create", {
          workspace: { workspacePath: workspace.canonicalPath, workspaceKey: workspace.canonicalPath },
          mode: "yolo",
          persistence: "immediate",
        }));
      }
      const sessionId = nestedString(snapshot, ["session", "sessionId"]);
      if (!sessionId) throw new Error("ZCode app-server session snapshot did not contain session.sessionId");
      entry.sessionId = sessionId;
      if (task.model) {
        const requested = `${task.model.provider_id}/${task.model.model_id}`;
        // session/create already selected this exact model. Keeping its
        // effective options is important for models requiring reasoningLevel.
        const current = readSelectedModelSelection(snapshot);
        const modelState = current?.providerId === task.model.provider_id && current.modelId === task.model.model_id
          ? snapshot
          : asRecord(await client.request("session/setModel", {
              sessionId,
              model: {
                providerId: task.model.provider_id,
                modelId: task.model.model_id,
                ...(task.model.reasoning_level
                  ? { options: { reasoningLevel: task.model.reasoning_level } }
                  : {}),
              },
              // Keep the override scoped to this session; do not change the
              // user's project-wide last-used model.
              persistAsWorkspaceLastUsed: false,
            }));
        const selected = readSelectedModelSelection(modelState);
        if (!selected) {
          throw new Error(`ZCode accepted model override ${requested} but did not report the selected model`);
        }
        if (
          selected.providerId !== task.model.provider_id ||
          selected.modelId !== task.model.model_id
        ) {
          throw new Error(
            `ZCode model override mismatch: requested ${requested}, runtime selected ${selected.providerId}/${selected.modelId}`,
          );
        }
        entry.selectedModel = readSelectedModel(modelState) ?? requested;
        entry.onEvent({
          type: "model_selected",
          summary: `ZCode selected requested model ${entry.selectedModel}`,
          details: {
            requested_model: requested,
            selected_model: entry.selectedModel,
            provider_id: selected.providerId,
            model_id: selected.modelId,
          },
        });
      }
      const model = readSelectedModel(snapshot);
      entry.selectedModel = entry.selectedModel ?? model;
      entry.onEvent({
        type: "session_ready",
        summary: `ZCode session ready${entry.selectedModel ? `; selected model ${entry.selectedModel}` : "; selected model not reported"}`,
        details: {
          session_id: sessionId,
          source_path: task.workspace,
          workspace_path: workspace.canonicalPath,
          execution_mode: "yolo",
          ...(entry.selectedModel ? { selected_model: entry.selectedModel } : {}),
        },
      });
      const runtimeSeq = nestedNumber(snapshot, ["runtime", "eventSeq"]) ?? 0;
      entry.lastEventSeq = runtimeSeq;
      await client.request("session/subscribe", {
        sessionId,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
        afterSeq: runtimeSeq,
      });
      await client.request("session/send", { sessionId, content: prompt });
      entry.onEvent({ type: "turn_started", summary: "ZCode accepted the task and started a turn" });
      const turnResult = await turn;
      await client.close().catch(() => undefined);
      entry.child = null;

      if (turnResult.resultType && turnResult.resultType !== "success") {
        return {
          attempts: 1,
          cancelled: turnResult.resultType === "cancelled",
          stdout: turnResult.response,
          stderr: client.stderr,
          exitCode: 1,
          signal: null,
          sessionId,
          response: turnResult.response,
          usage: turnResult.usage,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          agentReport: null,
          reportError: `ZCode turn ended with resultType ${turnResult.resultType}`,
          errorCode: turnResult.resultType === "cancelled" ? "cancelled" : "zcode_nonzero_exit",
        };
      }

      const parsed = parseAgentReport(turnResult.response);
      const stdout = turnResult.response;
      const base = {
        attempts: 1,
        cancelled: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdout,
        stderr: client.stderr,
        exitCode: 0,
        signal: null,
        sessionId,
        response: turnResult.response,
        usage: turnResult.usage,
        timedOut: false,
      };
      if (!parsed.report) {
        return {
          ...base,
          agentReport: null,
          reportError: parsed.error,
          errorCode: "invalid_agent_report",
        };
      }
      entry.onEvent({
        type: "report_ready",
        summary: "ZCode produced its structured execution report",
        details: { needs_master_decision: parsed.report.needs_master_decision },
      });
      return { ...base, agentReport: parsed.report, reportError: null, errorCode: null };
    } catch (error) {
      if (entry.child?.pid) await terminateProcessTree(entry.child.pid).catch(() => undefined);
      entry.child = null;
      const baseMessage = error instanceof Error ? error.message : String(error);
      const runtimeStderr = entry.client?.stderr.trim();
      const message = runtimeStderr
        ? baseMessage + "; app-server stderr: " + runtimeStderr.slice(0, 1_500)
        : baseMessage;
      const code = entry.timedOut ? "timeout" : entry.cancelRequested ? "cancelled" : "zcode_nonzero_exit";
      entry.onEvent({ type: "error", summary: message.slice(0, 1_500), details: { error_code: code } });
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(code, message);
    } finally {
      if (timer) clearTimeout(timer);
      entry.finished = true;
      void startedAt;
    }
  }

  #startAppServer(
    config: ZCodeRuntimeConfig,
    cwd: string,
    env: NodeJS.ProcessEnv,
    entry: RunEntry,
  ): AppServerClient {
    const child = spawn(config.nodeExecutable, [config.zcodeEntrypoint, "app-server", "--stdio"], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdoutBuffer = "";
    let rpcId = 0;
    let closed = false;
    const pending = new Map<string | number, PendingRpc>();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > MAX_CAPTURE_CHARS) stdoutBuffer = stdoutBuffer.slice(-MAX_CAPTURE_CHARS);
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as JsonRecord;
          this.#handleMessage(message, entry, pending, (reply) => {
            child.stdin.write(`${JSON.stringify(reply)}\n`);
          });
        } catch (error) {
          if (error instanceof SyntaxError) {
            entry.rejectTurn(new Error(`invalid ZCode app-server protocol line: ${line.slice(0, 500)}`));
          }
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk.slice(0, 64_000 - stderr.length);
    });
    child.on("error", (error) => entry.rejectTurn(error));
    child.on("close", (code, signal) => {
      closed = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error(`ZCode app-server exited (${String(code)}${signal ? `, ${signal}` : ""})`));
      }
      pending.clear();
      if (!entry.finished && !entry.timedOut && !entry.cancelRequested) {
        entry.rejectTurn(new Error(`ZCode app-server exited before turn completion (${String(code)})`));
      }
    });

    const request = (method: string, params: JsonRecord): Promise<unknown> => {
      if (closed) return Promise.reject(new Error(`ZCode app-server is closed before ${method}`));
      const id = ++rpcId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`ZCode app-server request timed out: ${method}`));
        }, RPC_TIMEOUT_MS);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (!error) return;
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        });
      });
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      child.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 1_000);
        timer.unref();
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      if (!closed && child.pid) await terminateProcessTree(child.pid).catch(() => undefined);
    };
    return { child, request, close, get stderr() { return stderr; } };
  }

  #handleMessage(
    message: JsonRecord,
    entry: RunEntry,
    pending: Map<string | number, PendingRpc>,
    write: (message: JsonRecord) => void,
  ): void {
    if (message.method === "session/requestRuntimePreferences") {
      const id = message.id;
      if (typeof id === "string" || typeof id === "number") {
        write({
          id,
          result: {
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false,
          },
        });
      }
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const id = message.id as string | number;
      const call = pending.get(id);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(id);
      if (message.error && typeof message.error === "object") {
        const error = message.error as JsonRecord;
        call.reject(new Error(typeof error.message === "string" ? error.message : "ZCode app-server request failed"));
      } else {
        call.resolve(message.result);
      }
      return;
    }
    if (message.method === "session/event") {
      const params = asRecord(message.params);
      if (typeof params.seq === "number") entry.lastEventSeq = params.seq;
      const type = typeof params.type === "string" ? params.type : "";
      const payload = asRecord(params.payload);
      this.#publishSessionEvent(type, payload, entry);
      if (type === "turn.completed") {
        entry.resolveTurn({
          response: typeof payload.response === "string" ? payload.response : "",
          usage: isRecord(payload.usage) ? payload.usage : null,
          resultType: typeof payload.resultType === "string" ? payload.resultType : null,
        });
      } else if (type === "turn.failed") {
        const problem = asRecord(payload.error);
        entry.rejectTurn(new Error(typeof problem.message === "string" ? problem.message : "ZCode turn failed"));
      }
      return;
    }
    if (message.method === "state.updated") {
      const params = asRecord(message.params);
      const patch = asRecord(params.patch);
      const state = typeof patch.status === "string" ? patch.status : undefined;
      if (state) entry.onEvent({ type: "runtime_state", summary: `ZCode runtime state: ${state}` });
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      write({ id: message.id, error: { code: -32601, message: `Unsupported ZCode app-server request: ${message.method}` } });
    }
  }

  #publishSessionEvent(type: string, payload: JsonRecord, entry: RunEntry): void {
    if (type === "turn.started") {
      entry.onEvent({
        type: "turn_started",
        summary: `ZCode turn started${entry.selectedModel ? ` with selected model ${entry.selectedModel}` : ""}`,
      });
    } else if (type === "model.streaming") {
      const kind = payload.kind;
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if ((kind === "text_start" || kind === "text_delta") && !entry.textOutputStarted) {
        entry.textOutputStarted = true;
        entry.onEvent({
          type: "model_output_started",
          summary: `ZCode began returning visible model output${entry.selectedModel ? ` (${entry.selectedModel})` : ""}`,
          details: entry.selectedModel ? { selected_model: entry.selectedModel } : undefined,
        });
      }
      if (kind === "text_delta" && delta) {
        entry.onEvent({ type: "model_output", summary: delta });
      } else if (kind === "tool_call") {
        const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
        const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
        entry.onEvent({
          type: "model_tool_call",
          summary: `Model requested tool ${name}`,
          details: { tool_name: name, ...(callId ? { tool_call_id: callId } : {}) },
        });
      }
    } else if (type === "tool.updated") {
      const name = typeof payload.toolName === "string" ? payload.toolName : "tool";
      const state = typeof payload.kind === "string" ? payload.kind : "updated";
      const callId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
      entry.onEvent({
        type: "tool_status",
        summary: `${name}: ${state}`,
        details: { tool_name: name, state, ...(callId ? { tool_call_id: callId } : {}) },
      });
    } else if (type === "turn.completed") {
      entry.onEvent({
        type: "turn_completed",
        summary: "ZCode turn completed",
        details: {
          ...(typeof payload.tokenCount === "number" ? { token_count: payload.tokenCount } : {}),
          ...(typeof payload.toolCallCount === "number" ? { tool_call_count: payload.toolCallCount } : {}),
          ...(isRecord(payload.usage) ? { usage: payload.usage } : {}),
        },
      });
    } else if (type === "turn.failed") {
      const problem = asRecord(payload.error);
      entry.onEvent({
        type: "turn_failed",
        summary: typeof problem.message === "string" ? problem.message : "ZCode turn failed",
      });
    }
  }

  #buildChildEnv(config: ZCodeRuntimeConfig): NodeJS.ProcessEnv {
    const env = createMinimalOsEnv(this.#childEnvBase);
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config.providerBuiltinConfigFile;
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.providerPersonalConfigFile;
    return env;
  }

  #require(handle: AgentHandle, method: string): RunEntry {
    const entry = this.#runs.get(handle);
    if (!entry) throw new Error(`${method}: unknown agent handle (task ${handle.taskId})`);
    return entry;
  }
}

function readSelectedModel(snapshot: JsonRecord): string | null {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const current = asRecord(modelSettings.current);
  const modelId = typeof current.modelId === "string" ? current.modelId : null;
  const providerId = typeof current.providerId === "string" ? current.providerId : null;
  if (!modelId) return null;
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  const match = available.find((entry) => {
    const ref = asRecord(asRecord(entry).ref);
    return ref.modelId === modelId && (providerId === null || ref.providerId === providerId);
  });
  const label = match && typeof asRecord(match).label === "string" ? asRecord(match).label as string : modelId;
  return providerId ? `${label} (${providerId}/${modelId})` : label;
}

function readSelectedModelSelection(snapshot: JsonRecord): { providerId: string; modelId: string } | null {
  const settings = asRecord(snapshot.settings);
  const modelSettings = asRecord(settings.model);
  const current = asRecord(modelSettings.current);
  if (typeof current.providerId !== "string" || typeof current.modelId !== "string") return null;
  return { providerId: current.providerId, modelId: current.modelId };
}

function nestedString(record: JsonRecord, path: string[]): string | null {
  let value: unknown = record;
  for (const part of path) value = asRecord(value)[part];
  return typeof value === "string" ? value : null;
}

function nestedNumber(record: JsonRecord, path: string[]): number | null {
  let value: unknown = record;
  for (const part of path) value = asRecord(value)[part];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
