// Worker execution body: runs one attempt of one task against the adapter and
// persists all evidence via the TaskStore. The worker process shell
// (worker-main.ts) calls this with a real ZCodeAdapter; tests call it directly
// with a fake adapter. Only paths, statuses, bounded logs, and attempt
// metadata are persisted — never child environments or credentials.
import type {
  AgentHandle,
  CodingAgentAdapter,
  RuntimeResolver,
  TaskResult,
  WorkspaceRef,
  ZCodeInteractionRequest,
} from "../interfaces.js";
import { ZCodeAppServerAdapter } from "../adapters/zcode-app-server-adapter.js";
import type { ZCodeRunOutcome } from "../adapters/zcode-adapter.js";
import { BridgeError } from "../runtime/errors.js";
import { buildContinuePrompt, buildTaskPrompt } from "../prompts/task-prompt.js";
import { buildTaskResult, type TaskFailure } from "../manager/normalize.js";
import { TaskStore } from "../store/task-store.js";

/**
 * The worker needs the frozen adapter contract except that getResult must
 * expose the adapter-normalization evidence (agentReport/errorCode/...).
 */
export type WorkerAdapter = Omit<CodingAgentAdapter, "getResult"> & {
  getResult(handle: AgentHandle): Promise<ZCodeRunOutcome>;
};

export interface ContinueSpec {
  readonly feedback: string;
  readonly additional_requirements?: string[];
  readonly previous_session_id: string | null;
  readonly previous_attempt: number;
}

export interface RunWorkerTaskOptions {
  readonly dataRoot: string;
  readonly taskId: string;
  adapter?: WorkerAdapter;
  resolver?: RuntimeResolver;
  now?: () => Date;
}

export interface RunWorkerTaskResult {
  readonly status: TaskResult["status"];
  readonly result: TaskResult;
}

export async function runWorkerTask(options: RunWorkerTaskOptions): Promise<RunWorkerTaskResult> {
  const store = new TaskStore(options.dataRoot);
  const now = options.now ?? (() => new Date());
  const taskId = options.taskId;
  const task = store.readTask(taskId);
  const initialStatus = store.readStatus(taskId);
  const attempt = initialStatus.attempt;

  // Defensive: the manager normally cancels before the worker starts; if the
  // intent was recorded first, finish as cancelled without touching the agent.
  if (initialStatus.cancel_requested === true) {
    const finishedAt = now().toISOString();
    const result = buildTaskResult({
      task,
      attempt,
      startedAt: initialStatus.started_at,
      finishedAt,
      outcome: null,
      failure: { code: "cancelled", message: "cancelled by request before the worker started the agent" },
      cancelled: true,
    });
    store.writeResult(taskId, result);
    store.writeStatus(taskId, { status: "cancelled", finished_at: finishedAt, worker_pid: null });
    return { status: result.status, result };
  }

  const startedAt = initialStatus.started_at ?? now().toISOString();
  store.writeStatus(taskId, { status: "running", started_at: startedAt, worker_pid: process.pid });
  store.appendEvent(taskId, "worker_running", "Task worker is preparing the ZCode runtime");
  store.writeAttemptMeta(taskId, attempt, "started.json", {
    worker_pid: process.pid,
    started_at: startedAt,
  });

  const continueSpec = store.readAttemptMeta<ContinueSpec>(taskId, attempt, "continue.json");
  const previousResult = continueSpec
    ? store.readArchivedResult(taskId, continueSpec.previous_attempt ?? attempt - 1)
    : null;

  // Archive the exact prompt for this attempt (pure rebuild from the same
  // inputs the adapter uses).
  const promptText = continueSpec
    ? buildContinuePrompt({
        task,
        feedback: continueSpec.feedback,
        additionalRequirements: continueSpec.additional_requirements ?? [],
        previousSessionId: continueSpec.previous_session_id,
        previousResult,
      })
    : buildTaskPrompt(task);
  store.writeAttemptFile(taskId, attempt, "prompt.txt", promptText);

  let outcome: ZCodeRunOutcome | null = null;
  let failure: TaskFailure | null = null;
  let pendingModelOutput = "";
  let lastModelOutputAt = 0;
  const flushModelOutput = (): void => {
    if (!pendingModelOutput) return;
    store.appendEvent(taskId, "model_output", pendingModelOutput);
    pendingModelOutput = "";
    lastModelOutputAt = Date.now();
  };
  try {
    if (options.resolver) {
      // Surface configuration problems before spending an adapter run; the
      // real adapter resolves internally as well.
      await options.resolver.resolve();
    }
    const adapter = options.adapter ?? new ZCodeAppServerAdapter({
      onEvent: (event) => {
        if (event.type === "model_output") {
          pendingModelOutput += event.summary;
          if (pendingModelOutput.length >= 4_000 || Date.now() - lastModelOutputAt >= 500) flushModelOutput();
          return;
        }
        flushModelOutput();
        store.appendEvent(taskId, event.type, event.summary, event.details);
        const sessionId = event.type === "session_ready" ? event.details?.["session_id"] : undefined;
        if (typeof sessionId === "string") store.writeStatus(taskId, { zcode_session_id: sessionId });
      },
      resolveInteraction: async (request) => {
        const safeRequest = sanitizeInteractionRequest(request);
        const { record, created } = store.writeInteractionRequest(taskId, safeRequest, now().toISOString());
        if (created) {
          const interactionEvent = store.appendEvent(
            taskId,
            "interaction_requested",
            interactionSummary(safeRequest),
            { ...publicInteractionDetails(safeRequest) },
            record.created_at,
          );
          if (!interactionEvent) {
            const fallback = interactionDecline(request.method, "Bridge could not publish this request to Codex");
            store.answerInteractionRequest(taskId, request.request_id, fallback, now().toISOString());
            return fallback;
          }
        }
        while (true) {
          const current = store.readInteractionRequest(taskId, request.request_id);
          if (current?.state === "answered" && current.answer) return current.answer;
          await sleep(250);
        }
      },
    });
    const workspaceRef: WorkspaceRef = store.readWorkspaceRef(taskId) ?? {
      requestedPath: task.workspace,
      canonicalPath: task.worktree_path ?? task.workspace,
      mode: task.worktree_path ? "worktree" : "direct",
      ...(task.worktree_path ? { sourcePath: task.workspace } : {}),
    };
    const handle = continueSpec
      ? await adapter.continueTask({
          task,
          workspace: workspaceRef,
          attempt,
          feedback: continueSpec.feedback,
          additionalRequirements: [...(continueSpec.additional_requirements ?? [])],
          previousSessionId: continueSpec.previous_session_id,
          previousResult,
        })
      : await adapter.startTask({ task, workspace: workspaceRef, attempt });
    outcome = await adapter.getResult(handle);
    flushModelOutput();
  } catch (error) {
    flushModelOutput();
    failure = {
      code: error instanceof BridgeError ? error.code : "worker_error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const finishedAt = now().toISOString();
  const stdoutLog = store.appendLog(taskId, "stdout", outcome?.stdout ? `${outcome.stdout}\n` : "");
  const stderrLog = store.appendLog(
    taskId,
    "stderr",
    outcome?.stderr
      ? `${outcome.stderr}\n`
      : failure
        ? `${failure.code}: ${failure.message}\n`
        : "",
  );

  store.writeAttemptMeta(taskId, attempt, "outcome.json", {
    started_at: startedAt,
    finished_at: finishedAt,
    failure,
    outcome: outcome
      ? {
          exitCode: outcome.exitCode,
          signal: outcome.signal,
          sessionId: outcome.sessionId,
          response: outcome.response,
          usage: outcome.usage,
          timedOut: outcome.timedOut,
          cancelled: outcome.cancelled,
          attempts: outcome.attempts,
          errorCode: outcome.errorCode,
          reportError: outcome.reportError,
          stdoutTruncated: outcome.stdoutTruncated,
          stderrTruncated: outcome.stderrTruncated,
          agentReport: outcome.agentReport,
          reportCandidate: outcome.reportCandidate,
        }
      : null,
    logs: { stdout_truncated: stdoutLog.truncated, stderr_truncated: stderrLog.truncated },
  });

  const result = buildTaskResult({
    task,
    attempt,
    startedAt,
    finishedAt,
    outcome,
    failure,
    cancelled: false,
  });
  store.appendEvent(taskId, "task_finished", `Task reached terminal status: ${result.status}`, {
    status: result.status,
    needs_master_decision: result.needs_master_decision,
  }, finishedAt);
  store.writeResult(taskId, result);
  store.writeStatus(taskId, {
    status: result.status,
    finished_at: finishedAt,
    exit_code: result.exit_code,
    zcode_session_id: result.session_id,
    error_code: result.error_code ?? null,
    error: result.status === "failed" ? result.summary : null,
  });
  return { status: result.status, result };
}

function interactionSummary(request: ZCodeInteractionRequest): string {
  const params = request.params;
  if (request.method === "interaction/requestPermission") {
    const toolName = typeof params.toolName === "string" ? params.toolName : "tool";
    const reason = typeof params.reason === "string" ? `: ${params.reason}` : "";
    return `ZCode is waiting for Codex to decide whether ${toolName} may proceed${reason}`;
  }
  if (asRecord(params.schema).interaction === "plan_approval") {
    return "ZCode is waiting for Codex to approve or reject its plan";
  }
  return "ZCode is waiting for Codex to answer a question";
}

function publicInteractionDetails(request: ZCodeInteractionRequest): Record<string, unknown> {
  const params = request.params;
  const details: Record<string, unknown> = {
    request_id: request.request_id,
    method: request.method,
    ...(typeof params.sessionId === "string" ? { session_id: params.sessionId } : {}),
    ...(typeof params.toolCallId === "string" ? { tool_call_id: params.toolCallId } : {}),
  };
  for (const key of ["toolName", "reason", "input", "options", "schema", "questions"] as const) {
    if (params[key] !== undefined) details[key] = params[key];
  }
  if (details["questions"] === undefined && Array.isArray(asRecord(params.input).questions)) {
    details["questions"] = asRecord(params.input).questions;
  }
  return details;
}

function sanitizeInteractionRequest(request: ZCodeInteractionRequest): ZCodeInteractionRequest {
  const params: Record<string, unknown> = {};
  for (const key of ["sessionId", "toolCallId", "toolName", "reason", "input", "options", "schema", "questions"] as const) {
    if (request.params[key] !== undefined) params[key] = request.params[key];
  }
  if (params["questions"] === undefined && Array.isArray(asRecord(params["input"]).questions)) {
    params["questions"] = asRecord(params["input"]).questions;
  }
  return { request_id: request.request_id, method: request.method, params };
}

function interactionDecline(method: ZCodeInteractionRequest["method"], reason: string): Record<string, unknown> {
  return method === "interaction/requestPermission"
    ? { decision: "deny", reason }
    : { action: "decline" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
