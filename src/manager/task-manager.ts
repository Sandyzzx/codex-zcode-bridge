// TaskManager: validates requests, owns the one global worker slot, persists
// state via the TaskStore, launches and
// reconciles detached workers, and enforces state transitions.
//
// Concurrency model: all state mutations run through a single promise-chain
// mutex, and an interval tick (recoverTasks) reconciles non-terminal tasks:
// a persisted worker PID that is gone without a terminal result becomes
// failed/worker_lost; a terminal result.json whose status lags aligns the
// status record; queued tasks start FIFO while the slot is free.
import type {
  ContinueTaskInput,
  ProgressTaskManager,
  TaskPackage,
  TaskProgressPage,
  TaskReceipt,
  TaskResult,
  TaskStatusRecord,
  WorkspaceProvider,
} from "../interfaces.js";
import { isTerminalStatus, TaskStore, toPublicStatus } from "../store/task-store.js";
import { buildTaskResult, type TaskFailure } from "./normalize.js";
import { TaskManagerError } from "./errors.js";
import { defaultSpawnWorker, type SpawnWorker } from "./spawn-worker.js";
import { isProcessRunning, terminateProcessTree, type TerminateProcessTree } from "../adapters/process-spawn.js";

export interface TaskManagerOptions {
  store: TaskStore;
  workspaceProvider: WorkspaceProvider;
  /** Defaults to spawning the detached worker-main.js process. */
  spawnWorker?: SpawnWorker;
  /** Defaults to a real PID liveness check. */
  isProcessRunning?: (pid: number) => boolean;
  /** Defaults to real process-tree termination with verification. */
  terminateProcessTree?: TerminateProcessTree;
  /** Reconcile/pump interval; 0 disables the timer (tests drive manually). */
  pollIntervalMs?: number;
  now?: () => Date;
}

export class BridgeTaskManager implements ProgressTaskManager {
  readonly #store: TaskStore;
  readonly #workspaceProvider: WorkspaceProvider;
  readonly #spawnWorker: SpawnWorker;
  readonly #isProcessRunning: (pid: number) => boolean;
  readonly #terminateProcessTree: TerminateProcessTree;
  readonly #now: () => Date;
  readonly #dataRoot: string;
  #timer: NodeJS.Timeout | null = null;
  #mutex: Promise<unknown> = Promise.resolve();

  constructor(options: TaskManagerOptions) {
    this.#store = options.store;
    this.#workspaceProvider = options.workspaceProvider;
    this.#spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
    this.#isProcessRunning = options.isProcessRunning ?? isProcessRunning;
    this.#terminateProcessTree = options.terminateProcessTree ?? terminateProcessTree;
    this.#now = options.now ?? (() => new Date());
    this.#dataRoot = options.store.dataRoot;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    if (pollIntervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.recoverTasks().catch(() => undefined);
      }, pollIntervalMs);
      this.#timer.unref();
    }
  }

  /** Stops the reconcile timer; safe to call repeatedly. */
  dispose(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Scans all non-terminal tasks and reconciles them, then pumps the queue. */
  async recoverTasks(): Promise<void> {
    return this.#exclusive(async () => {
      for (const taskId of this.#store.listTaskIds()) {
        const status = this.#store.readStatus(taskId);
        if (isTerminalStatus(status.status)) continue;
        if (status.status === "running") {
          this.#reconcileRunningLocked(taskId, status);
        }
      }
      this.#pumpLocked();
    });
  }

  async createTask(task: TaskPackage): Promise<TaskReceipt> {
    return this.#exclusive(async () => {
      this.#validateTaskPackage(task);
      const existingRunning = this.#runningTaskIdLocked();
      if (this.#store.hasTask(task.task_id)) {
        throw new TaskManagerError("TASK_ALREADY_EXISTS", `task_id already used: ${task.task_id}`);
      }
      let workspaceRef;
      try {
        workspaceRef = await this.#workspaceProvider.resolve(task.workspace, task.task_id);
      } catch (error) {
        throw new TaskManagerError(
          "TASK_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      const createdAt = this.#now().toISOString();
      try {
        const sourcePath = workspaceRef.sourcePath ?? workspaceRef.canonicalPath;
        this.#store.createTask({ ...task, workspace: sourcePath }, createdAt);
        this.#store.writeWorkspaceRef(task.task_id, workspaceRef);
      } catch (error) {
        await this.#workspaceProvider.release(workspaceRef).catch(() => undefined);
        throw error;
      }
      this.#store.appendEvent(task.task_id, "queued", "Task accepted and queued", undefined, createdAt);
      this.#store.appendEvent(task.task_id, "workspace_ready", workspaceRef.mode === "worktree"
        ? "Isolated Git worktree created for this task"
        : "Task will run in the requested workspace", {
          source_path: workspaceRef.sourcePath ?? workspaceRef.canonicalPath,
          workspace_path: workspaceRef.canonicalPath,
          mode: workspaceRef.mode,
          ...(workspaceRef.branchName ? { branch_name: workspaceRef.branchName } : {}),
        }, createdAt);
      if (!existingRunning) {
        this.#startWorkerLocked(task.task_id);
      }
      const status = this.#store.readStatus(task.task_id);
      return {
        task_id: task.task_id,
        status: status.status === "running" ? "running" : "queued",
        created_at: createdAt,
      };
    });
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    return this.#exclusive(async () => {
      this.#requireTask(taskId);
      this.#reconcileOneLocked(taskId);
      return toPublicStatus(this.#store.readStatus(taskId));
    });
  }

  async getEvents(input: {
    task_id: string;
    after_seq?: number;
    limit?: number;
    wait_ms?: number;
  }): Promise<TaskProgressPage> {
    const afterSeq = input.after_seq ?? 0;
    const limit = input.limit ?? 100;
    const waitMs = input.wait_ms ?? 0;
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new TaskManagerError("TASK_INVALID", "after_seq must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new TaskManagerError("TASK_INVALID", "limit must be an integer from 1 to 200");
    }
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new TaskManagerError("TASK_INVALID", "wait_ms must be an integer from 0 to 25000");
    }
    const deadline = Date.now() + waitMs;
    while (true) {
      const page = await this.#exclusive(async () => {
        this.#requireTask(input.task_id);
        this.#reconcileOneLocked(input.task_id);
        const status = this.#store.readStatus(input.task_id);
        const read = this.#store.readEvents(input.task_id, afterSeq, limit);
        return {
          task_id: input.task_id,
          status: status.status,
          events: read.events,
          next_seq: read.nextSeq,
          has_more: read.hasMore,
        } satisfies TaskProgressPage;
      });
      if (page.events.length || isTerminalStatus(page.status) || Date.now() >= deadline) return page;
      await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  async getResult(taskId: string): Promise<TaskResult> {
    return this.#exclusive(async () => {
      this.#requireTask(taskId);
      this.#reconcileOneLocked(taskId);
      const status = this.#store.readStatus(taskId);
      if (!isTerminalStatus(status.status)) {
        throw new TaskManagerError(
          "TASK_NOT_FINISHED",
          `task ${taskId} is not finished (status: ${status.status})`,
        );
      }
      const result = this.#store.readResult(taskId);
      if (!result) {
        throw new TaskManagerError(
          "TASK_NOT_FINISHED",
          `task ${taskId} has terminal status ${status.status} but no persisted result`,
        );
      }
      return result;
    });
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskReceipt> {
    return this.#exclusive(async () => {
      const taskId = input.task_id;
      this.#requireTask(taskId);
      if (typeof input.feedback !== "string" || input.feedback.trim().length === 0) {
        throw new TaskManagerError("TASK_INVALID", "feedback must be a non-empty string");
      }
      if (
        input.additional_requirements !== undefined &&
        (!Array.isArray(input.additional_requirements) ||
          input.additional_requirements.some((item) => typeof item !== "string"))
      ) {
        throw new TaskManagerError("TASK_INVALID", "additional_requirements must be an array of strings");
      }
      const status = this.#store.readStatus(taskId);
      if (!["completed", "failed", "waiting_for_master"].includes(status.status)) {
        throw new TaskManagerError(
          "TASK_STATE",
          `zcode_continue is not allowed from status ${status.status}`,
        );
      }
      const task = this.#store.readTask(taskId);
      // The continuation reuses the original workspace; it must still resolve
      // to the same canonical directory.
      try {
        const ref = await this.#workspaceProvider.resolve(task.workspace, taskId);
        const recorded = this.#store.readWorkspaceRef(taskId);
        if (recorded && ref.canonicalPath !== recorded.canonicalPath) {
          throw new Error(`workspace no longer resolves to ${task.workspace}`);
        }
      } catch (error) {
        throw new TaskManagerError(
          "TASK_INVALID",
          error instanceof Error ? error.message : String(error),
        );
      }
      const previousAttempt = status.attempt;
      const previousResult = this.#store.readResult(taskId);
      const nextAttempt = previousAttempt + 1;
      const createdAt = this.#now().toISOString();

      // Preserve prior evidence: the previous terminal result is archived into
      // its attempt directory before the new attempt starts.
      this.#store.archiveResultToAttempt(taskId, previousAttempt);
      this.#store.writeAttemptMeta(taskId, nextAttempt, "continue.json", {
        feedback: input.feedback,
        additional_requirements: [...(input.additional_requirements ?? [])],
        previous_session_id: previousResult?.session_id ?? null,
        previous_attempt: previousAttempt,
      });
      this.#store.writeStatus(taskId, {
        status: "queued",
        attempt: nextAttempt,
        started_at: null,
        finished_at: null,
        worker_pid: null,
        zcode_session_id: null,
        exit_code: null,
        error_code: null,
        error: null,
        cancel_requested: null,
      });
      this.#pumpLocked();
      const after = this.#store.readStatus(taskId);
      return {
        task_id: taskId,
        status: after.status === "running" ? "running" : "queued",
        created_at: after.updated_at,
      };
    });
  }

  async cancelTask(taskId: string): Promise<TaskStatusRecord> {
    return this.#exclusive(async () => {
      this.#requireTask(taskId);
      const status = this.#store.readStatus(taskId);
      if (isTerminalStatus(status.status)) {
        throw new TaskManagerError(
          "TASK_STATE",
          `zcode_cancel is not allowed from status ${status.status}`,
        );
      }
      const task = this.#store.readTask(taskId);

      if (status.status === "queued") {
        const finishedAt = this.#now().toISOString();
        const result = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: null,
          finishedAt,
          outcome: null,
          failure: { code: "cancelled", message: "cancelled by request before the task started" },
          cancelled: true,
        });
        this.#store.writeResult(taskId, result);
        this.#store.writeStatus(taskId, { status: "cancelled", finished_at: finishedAt });
        this.#store.appendEvent(taskId, "cancelled", "Queued task cancelled before worker start", undefined, finishedAt);
        return toPublicStatus(this.#store.readStatus(taskId));
      }

      // Running: persist the intent, then terminate and verify the worker
      // process tree before recording the cancelled terminal state.
      this.#store.writeStatus(taskId, { cancel_requested: true });
      this.#store.appendEvent(taskId, "cancel_requested", "Cancellation requested; waiting for process-tree confirmation");
      const pid = status.worker_pid;
      if (pid === null) {
        // No worker process was recorded; nothing to terminate, record loss.
        const finishedAt = this.#now().toISOString();
        const result = buildTaskResult({
          task,
          attempt: status.attempt,
          startedAt: status.started_at,
          finishedAt,
          outcome: null,
          failure: { code: "worker_lost", message: "running task had no worker pid recorded" },
        });
        this.#store.writeResult(taskId, result);
        this.#store.writeStatus(taskId, {
          status: "failed",
          finished_at: finishedAt,
          error_code: "worker_lost",
          error: result.summary,
        });
        return toPublicStatus(this.#store.readStatus(taskId));
      }
      try {
        await this.#terminateProcessTree(pid, { graceMs: 500, killWaitMs: 5_000 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#store.writeStatus(taskId, {
          error: `cancellation could not be verified: ${message}`,
        });
        this.#store.appendEvent(taskId, "cancel_failed", message);
        throw new TaskManagerError(
          "CANCEL_FAILED",
          `process-tree termination for task ${taskId} (pid ${pid}) could not be verified: ${message}`,
        );
      }
      // The worker may have completed while termination was in flight; a
      // persisted terminal result always wins over our cancellation.
      const raced = this.#store.readResult(taskId);
      if (raced) {
        this.#store.writeStatus(taskId, {
          status: raced.status,
          finished_at: raced.finished_at,
          exit_code: raced.exit_code,
          zcode_session_id: raced.session_id,
          error_code: raced.error_code ?? null,
          error: raced.status === "failed" ? raced.summary : null,
          worker_pid: null,
          cancel_requested: null,
        });
        this.#pumpLocked();
        return toPublicStatus(this.#store.readStatus(taskId));
      }
      const finishedAt = this.#now().toISOString();
      const result = buildTaskResult({
        task,
        attempt: status.attempt,
        startedAt: status.started_at,
        finishedAt,
        outcome: null,
        failure: {
          code: "cancelled",
          message: `cancelled by request; worker process tree (pid ${pid}) was terminated and verified`,
        },
        cancelled: true,
      });
      this.#store.writeResult(taskId, result);
      this.#store.appendEvent(taskId, "cancelled", "Worker process tree terminated and cancellation confirmed", undefined, finishedAt);
      this.#store.writeStatus(taskId, {
        status: "cancelled",
        finished_at: finishedAt,
        worker_pid: null,
        cancel_requested: null,
      });
      this.#pumpLocked();
      return toPublicStatus(this.#store.readStatus(taskId));
    });
  }

  // ---- internals (must be called under the mutex) ----

  #reconcileOneLocked(taskId: string): void {
    const status = this.#store.readStatus(taskId);
    if (status.status === "running") {
      this.#reconcileRunningLocked(taskId, status);
    }
  }

  #reconcileRunningLocked(taskId: string, status: { worker_pid: number | null; attempt: number; started_at: string | null }): void {
    const persistedResult = this.#store.readResult(taskId);
    if (persistedResult) {
      // The worker wrote the result but died before updating the status file.
      this.#store.writeStatus(taskId, {
        status: persistedResult.status,
        finished_at: persistedResult.finished_at,
        exit_code: persistedResult.exit_code,
        zcode_session_id: persistedResult.session_id,
        error_code: persistedResult.error_code ?? null,
        error: persistedResult.status === "failed" ? persistedResult.summary : null,
        worker_pid: null,
      });
      return;
    }
    const pid = status.worker_pid;
    const alive = pid !== null && this.#isProcessRunning(pid);
    if (alive) return; // still running (possibly from before a manager restart)
    const task = this.#store.readTask(taskId);
    const finishedAt = this.#now().toISOString();
    const failure: TaskFailure = {
      code: "worker_lost",
      message: `worker pid ${String(pid)} is gone without a terminal result`,
    };
    const result = buildTaskResult({
      task,
      attempt: status.attempt,
      startedAt: status.started_at,
      finishedAt,
      outcome: null,
      failure,
    });
    this.#store.writeResult(taskId, result);
    this.#store.writeStatus(taskId, {
      status: "failed",
      finished_at: finishedAt,
      error_code: "worker_lost",
      error: result.summary,
      worker_pid: null,
    });
    this.#store.appendEvent(taskId, "error", result.summary, { error_code: "worker_lost" }, finishedAt);
  }

  #runningTaskIdLocked(): string | null {
    for (const taskId of this.#store.listTaskIds()) {
      if (this.#store.readStatus(taskId).status === "running") {
        return taskId;
      }
    }
    return null;
  }

  #queuedTaskIdsLocked(): string[] {
    return this.#store
      .listTaskIds()
      .map((taskId) => ({ taskId, status: this.#store.readStatus(taskId) }))
      .filter((entry) => entry.status.status === "queued")
      .sort((a, b) => a.status.created_at.localeCompare(b.status.created_at))
      .map((entry) => entry.taskId);
  }

  #pumpLocked(): void {
    if (this.#runningTaskIdLocked()) return;
    const [next] = this.#queuedTaskIdsLocked();
    if (next) this.#startWorkerLocked(next);
  }

  #startWorkerLocked(taskId: string): void {
    const status = this.#store.readStatus(taskId);
    if (status.status !== "queued") return;
    this.#store.writeStatus(taskId, {
      status: "running",
      started_at: this.#now().toISOString(),
      worker_pid: null,
    });
    let pid: number;
    try {
      const spawned = this.#spawnWorker(this.#dataRoot, taskId);
      pid = spawned.pid;
    } catch (error) {
      const finishedAt = this.#now().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const task = this.#store.readTask(taskId);
      const result = buildTaskResult({
        task,
        attempt: status.attempt,
        startedAt: null,
        finishedAt,
        outcome: null,
        failure: { code: "spawn_failed", message },
      });
      this.#store.writeResult(taskId, result);
      this.#store.writeStatus(taskId, {
        status: "failed",
        finished_at: finishedAt,
        error_code: "spawn_failed",
        error: result.summary,
      });
      this.#store.appendEvent(taskId, "error", result.summary, { error_code: "spawn_failed" }, finishedAt);
      return;
    }
    this.#store.writeStatus(taskId, { worker_pid: pid });
    this.#store.appendEvent(taskId, "worker_started", "Bridge worker started", { worker_pid: pid });
  }

  #requireTask(taskId: string): void {
    if (!this.#store.hasTask(taskId)) {
      throw new TaskManagerError("TASK_NOT_FOUND", `unknown task_id: ${taskId}`);
    }
  }

  #validateTaskPackage(task: TaskPackage): void {
    if (typeof task !== "object" || task === null) {
      throw new TaskManagerError("TASK_INVALID", "task package must be an object");
    }
    if (typeof task.task_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(task.task_id)) {
      throw new TaskManagerError(
        "TASK_INVALID",
        "task_id must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}",
      );
    }
    if (typeof task.objective !== "string" || task.objective.trim().length === 0) {
      throw new TaskManagerError("TASK_INVALID", "objective must be a non-empty string");
    }
    for (const field of [
      "requirements",
      "allowed_paths",
      "forbidden_paths",
      "acceptance_criteria",
      "test_commands",
    ] as const) {
      const value = task[field];
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new TaskManagerError("TASK_INVALID", `${field} must be an array of strings (may be empty)`);
      }
    }
    if (task.context !== undefined && typeof task.context !== "string") {
      throw new TaskManagerError("TASK_INVALID", "context must be a string when present");
    }
    if (typeof task.workspace !== "string" || task.workspace.trim().length === 0) {
      throw new TaskManagerError("TASK_INVALID", "workspace is required");
    }
    if (task.model !== undefined && (
      typeof task.model !== "object" || task.model === null ||
      typeof task.model.provider_id !== "string" || task.model.provider_id.trim().length === 0 ||
      typeof task.model.model_id !== "string" || task.model.model_id.trim().length === 0 ||
      (task.model.reasoning_level !== undefined &&
        (typeof task.model.reasoning_level !== "string" || task.model.reasoning_level.trim().length === 0))
    )) {
      throw new TaskManagerError("TASK_INVALID", "model must include non-empty provider_id and model_id strings");
    }
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutex.then(operation, operation);
    this.#mutex = run.catch(() => undefined);
    return run;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
