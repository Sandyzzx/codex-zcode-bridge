import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ContinueTaskInput,
  GetEventsInput,
  ProgressTaskManager,
  TaskAttentionSnapshot,
  TaskFeedbackSnapshotV01,
  TaskAdmission,
  TaskPackage,
  TaskProgressEvent,
  TaskProgressPage,
  TaskReceipt,
  TaskResult,
  TaskStatus,
  TaskStatusRecord,
  TaskOwnerBinding,
  DispatchBlocker,
  ExecutionObservation,
  ZCodeInteractionReplyInput,
} from "../interfaces.js";
import type { ClaimOnlyDriverOptions, CandidateTaskPackage, ClaimOnlyRunResult } from "../store/lifecycle-gate.js";
import { openClaimOnlyDriver } from "../store/lifecycle-gate.js";
import { TaskManagerError } from "./errors.js";
import { summarizeTaskResult } from "../result-summary.js";
import { waitForAttentionSnapshot } from "../attention/wait.js";
import { parseTaskAttentionSnapshot } from "../attention/snapshot.js";
import { createPlatformProbe, PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe } from "../runtime/process-probe.js";
import { buildSqliteDoctorChecks } from "../runtime/sqlite-doctor.js";
import type { DoctorCheck } from "../runtime/doctor.js";
import type { TaskModelRouter } from "../runtime/model-routing.js";
import {
  DEFAULT_TASK_LIST_LIMIT,
  type ConsoleTaskAttemptProjection,
  type ConsoleTaskBucket,
  type ConsoleTaskCleanupProjection,
  type ConsoleTaskDetail,
  type ConsoleTaskDiscountProjection,
  type ConsoleTaskHoldProjection,
  type ConsoleTaskListItem,
  type ConsoleTaskListInput,
  type ConsoleTaskListPage,
  type ConsoleTaskModelProjection,
  type ConsoleTaskPlanProjection,
  type ConsoleTaskReleaseProjection,
  type ConsoleTaskResultProjection,
  type ConsoleTaskUsageProjection,
  type ConsoleTaskWakeProjection,
  type ListTasksInput,
  type TaskListItem,
  type TaskListPage,
  type TaskListWakeSummary,
  resolveConsoleActionCapabilities,
} from "../task-list.js";
import { BIGMODEL_START_PLAN_PROVIDER_ID } from "../runtime/account-provider.js";
import { isOfficialCodingPlanProvider } from "../runtime/official-app-server-runtime.js";

const EXECUTION_OBSERVATION_PROBE_BUDGET_MS = 5_000;
const DEFAULT_HOST_SHUTDOWN_WAIT_MS = 60_000;
const PUMP_FAILURE_RECOVERY_RETRY_MS = 250;
const EXECUTOR_IDLE_OPERATION_PHASES = new Set(["released", "cancelled_before_launch"]);
/** Bound normal event pages while preserving cursor-based recovery for every persisted event. */
export const DEFAULT_EVENT_PAGE_MAX_BYTES = 32 * 1024;

type Driver = Awaited<ReturnType<typeof openClaimOnlyDriver>>;
export interface ExecutorWakeReleaseFact {
  readonly task_id: string;
  readonly attempt: number;
  readonly operation_id: string;
  readonly generation: number;
  readonly task_status: TaskStatus;
  readonly result_status: TaskResult["status"];
  readonly result_digest: string;
  readonly result_commit_ref: string;
  readonly workspace: string;
  readonly owner_thread_id: string | null;
  readonly owner_binding_state: "bound" | "unavailable";
}

export interface AuthorityExecutorWakeObservationInput {
  readonly operation_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly generation: number;
  readonly state: "intent" | "queued" | "submission_unknown" | "turn_started" | "web_notify";
  readonly thread_id: string | null;
  readonly delivery_id: string;
  readonly policy_digest: string;
  readonly authorization_digest: string;
  readonly reason_code: string;
  readonly queue_message_id?: string;
}

export type AuthorityExecutorWakeRecorder = (
  input: AuthorityExecutorWakeObservationInput,
) => {
  readonly duplicate: boolean;
  readonly state: AuthorityExecutorWakeObservationInput["state"];
};

export type SqliteAuthorityOptions = ClaimOnlyDriverOptions & {
  readonly testBeforeDispatch?: () => Promise<void>;
  readonly testOnScheduler?: (stage: string, detail: Readonly<Record<string, unknown>>) => void;
  readonly testShutdownWaitMs?: number;
  /** Host-supplied ADR-031 task-creation routing hook. `route` runs before
   * TaskPackage validation and persistence so every stored task carries the
   * fully resolved provider/model selection; `confirmRouting` is invoked only
   * after durable persistence, so a failure before the first persistence
   * leaves no routing-cache reservation. */
  readonly routeTaskModel?: TaskModelRouter;
  /** Executor-only Wake hook. It runs after a terminal Result and durable
   * Release, outside SQLite transactions; failure never rolls back the Result
   * or changes Task/Result/Cleanup/Release facts. */
  readonly onOperationReleased?: (
    fact: ExecutorWakeReleaseFact,
    recorder: AuthorityExecutorWakeRecorder,
  ) => Promise<void>;
  /** P1 §3.2 Lease Spawn Fence. While it returns a blocker reason, the
   * Manager may not start any new Worker Spawn (pump, retry timers, and
   * post-recovery redispatch all route through the same gate). Already
   * dispatched Workers keep settling under their own lifecycle rules and
   * queued Attempts stay durable in SQLite for a future owner. */
  readonly dispatchFence?: () => string | null;
};

/** SQLite Lifecycle Manager. Owns scheduling; the bound driver owns durable facts. */
export class SqliteLifecycleMcpAuthority implements ProgressTaskManager {
  readonly #driver: Driver;
  readonly #queue: Array<{ taskId: string; attempt: number }> = [];
  readonly #activeRuns = new Map<string, Promise<ClaimOnlyRunResult>>();
  readonly #recoveryRuns = new Map<string, Promise<TaskStatusRecord>>();
  readonly #dispatchingPaths = new Set<string>();
  readonly #queued = new Set<string>();
  #active = 0;
  #closed = false;
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | null = null;
  readonly #pumpPromises = new Set<Promise<void>>();
  #recoveryComplete = false;
  #recoveryInProgress = false;
  #recoveryPromise: Promise<void> | null = null;
  #pumpPending = false;
  #awaitingDispatchPrerequisite = false;
  #pumpRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #pumpFailureRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #workspaceRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #capacityRetryMs = 100;
  #pumpFailure: { readonly taskId: string; readonly reason: string } | null = null;
  #recoveryBlocked: string | null = null;
  readonly #testBeforeDispatch?: () => Promise<void>;
  readonly #testOnScheduler?: (stage: string, detail: Readonly<Record<string, unknown>>) => void;
  readonly #shutdownWaitMs: number;
  readonly #context: NonNullable<ClaimOnlyDriverOptions["trustedLocalContext"]>;
  readonly #processProbe: ProcessProbe;
  readonly #startPlanAuthAvailable: boolean;
  readonly #startPlanAuthInjected: boolean;
  readonly #startPlanPrivateAuthFactory?: () => Promise<NonNullable<ClaimOnlyDriverOptions["startPlanPrivateAuth"]> | null>;
  readonly #testOnlyFakeAdapter: boolean;
  readonly #routeTaskModel?: TaskModelRouter;
  readonly #onOperationReleased?: SqliteAuthorityOptions["onOperationReleased"];
  readonly #dispatchFence?: SqliteAuthorityOptions["dispatchFence"];

  private constructor(driver: Driver, context: NonNullable<ClaimOnlyDriverOptions["trustedLocalContext"]>, processProbe: ProcessProbe,
    testBeforeDispatch?: () => Promise<void>, testOnScheduler?: SqliteAuthorityOptions["testOnScheduler"],
    shutdownWaitMs = DEFAULT_HOST_SHUTDOWN_WAIT_MS, startPlanAuthAvailable = false, testOnlyFakeAdapter = false,
    routeTaskModel?: TaskModelRouter,
    startPlanAuthInjected = false,
    startPlanPrivateAuthFactory?: () => Promise<NonNullable<ClaimOnlyDriverOptions["startPlanPrivateAuth"]> | null>,
    onOperationReleased?: SqliteAuthorityOptions["onOperationReleased"],
    dispatchFence?: SqliteAuthorityOptions["dispatchFence"]) {
    this.#driver = driver;
    this.#context = context;
    this.#processProbe = processProbe;
    this.#testBeforeDispatch = testBeforeDispatch;
    this.#testOnScheduler = testOnScheduler;
    this.#shutdownWaitMs = shutdownWaitMs;
    this.#startPlanAuthAvailable = startPlanAuthAvailable;
    this.#startPlanAuthInjected = startPlanAuthInjected;
    this.#startPlanPrivateAuthFactory = startPlanPrivateAuthFactory;
    this.#testOnlyFakeAdapter = testOnlyFakeAdapter;
    this.#routeTaskModel = routeTaskModel;
    this.#onOperationReleased = onOperationReleased;
    this.#dispatchFence = dispatchFence;
  }

  #spawnFenceReason(): string | null {
    return this.#dispatchFence?.() ?? null;
  }

  async createTask(
    task: TaskPackage,
    admission: TaskAdmission = { owner_thread_id: null, source: "non_host_admission" },
  ): Promise<TaskReceipt> {
    this.#assertOpen();
    this.#assertAccepting();
    this.#assertRecoveryReady();
    // ADR-031: routing runs before validation so a provider-less model input
    // is resolved to the actual provider/model that will be persisted. The
    // routing cache is confirmed only after durable persistence below, so a
    // rejection on any path before that point leaves no cache reservation.
    task = this.#routeTaskModel ? await this.#routeTaskModel.route(task) : task;
    if (task.model && !task.model.provider_id?.trim()) {
      throw new TaskManagerError("TASK_INVALID", "model.provider_id is required because task model routing is not configured");
    }
    validateTaskPackage(task);
    const policy = this.#driverTrustedPolicy();
    const sourceDecision = policy.validateWorkspace({ requestedPath: task.workspace, canonicalPath: task.workspace });
    if (sourceDecision.state !== "allow") throw new TaskManagerError("TASK_INVALID", `SQLite admission rejected: ${sourceDecision.reason}`);
    const executionPath = task.worktree_path ?? task.workspace;
    const executionDecision = policy.validateWorkspace({ requestedPath: executionPath, canonicalPath: executionPath });
    if (executionDecision.state !== "allow") throw new TaskManagerError("TASK_INVALID", `SQLite admission rejected: ${executionDecision.reason}`);
    const normalizedTask: TaskPackage = {
      ...task,
      workspace: sourceDecision.canonical_path,
      ...(task.worktree_path === undefined ? {} : { worktree_path: executionDecision.canonical_path }),
    };
    const permission = policy.checkPermission({
      workspace: executionDecision.canonical_path,
      task: { ...normalizedTask, operation_id: `preflight-${task.task_id}`, attempt: 1 },
    });
    if (permission.state !== "allow") throw new TaskManagerError("TASK_INVALID", `SQLite admission rejected: ${permission.state === "unknown" ? permission.reason : permission.reason}`);
    const existingValue = this.#driver.readTaskLifecycle(task.task_id);
    if (existingValue) {
      const existing = asRecord(existingValue);
      if (canonicalJson(existing.task) !== canonicalJson(normalizedTask)) {
        throw new TaskManagerError("TASK_ID_CONFLICT", `task_id already belongs to a different SQLite request: ${task.task_id}`);
      }
      const existingBinding = taskOwnerBinding(existing.owner_binding);
      if (existingBinding.state === "bound" && admission.owner_thread_id !== null
        && existingBinding.owner_thread_id !== admission.owner_thread_id) {
        throw new TaskManagerError(
          "TASK_ID_CONFLICT",
          `task_id is already bound to a different Codex Thread: ${task.task_id}`,
        );
      }
      const projection = asRecord(existing.projection);
      // The persisted TaskPackage equals this routing; accept it so an
      // identical re-submission replays from the routing cache as well.
      this.#routeTaskModel?.confirmRouting(task);
      return receipt(task.task_id, projection.status, projection.created_at, existingBinding);
    }

    // ADR-031: Start Plan credential discovery is on-demand for genuinely new
    // tasks. Existing tasks are resolved against SQLite first so logout cannot
    // replace an equality replay or TASK_ID_CONFLICT with a credential error.
    // This pre-intent refusal still precedes Operation/Launch Intent creation,
    // so a logged-out new task is rejected before launch-outcome-unknown.
    if (task.model?.provider_id === "account:bigmodel-start-plan" && !this.#testOnlyFakeAdapter) {
      if (!this.#startPlanAuthAvailable) throw new TaskManagerError("TASK_INVALID", "official Start Plan credentials are unavailable");
      if (!this.#startPlanAuthInjected) {
        const issuer = await this.#startPlanPrivateAuthFactory?.().catch(() => null) ?? null;
        if (!issuer) throw new TaskManagerError("TASK_INVALID", "official Start Plan credentials are unavailable");
      }
    }

    try {
      this.#driver.createTask(normalizedTask as CandidateTaskPackage, admission);
    } catch (error) {
      const raced = asRecord(this.#driver.readTaskLifecycle(task.task_id));
      if (!raced || canonicalJson(raced.task) !== canonicalJson(normalizedTask)) {
        if (errorCode(error) === "task_already_exists") throw new TaskManagerError("TASK_ID_CONFLICT", `task_id already exists with different SQLite input: ${task.task_id}`);
        throw error;
      }
    }
    // Durable persistence succeeded (fresh or race-verified). Confirm this
    // call's exact routing before any later queueing can fail.
    this.#routeTaskModel?.confirmRouting(task);
    const snapshot = asRecord(this.#driver.readTaskLifecycle(task.task_id));
    const projection = asRecord(snapshot.projection);
    const ownerBinding = taskOwnerBinding(snapshot.owner_binding);
    this.#enqueue(task.task_id, Number(projection.current_attempt));
    return {
      task_id: task.task_id,
      status: "queued",
      created_at: string(projection.created_at, "task_created_at_missing"),
      owner_binding: ownerBinding,
    };
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    const snapshot = this.#readSnapshot(taskId);
    const projection = asRecord(snapshot.projection);
    if (this.#pumpFailure && projection.status === "queued") {
      throw new TaskManagerError("TASK_STATE", `SQLite dispatch is blocked after ${this.#pumpFailure.reason}; ${this.#queue.length} queued attempt(s) remain persisted while automatic Recovery retry is pending or exhausted; resolve the dispatch cause and restart the Executor to clear the latch`);
    }
    const attempt = asRecord(snapshot.attempt);
    const operation = snapshot.operation ? asRecord(snapshot.operation) : null;
    const result = snapshot.result ? asRecord(snapshot.result) : null;
    // P2 §4.5: updated_at must reflect the latest persisted event, not the
    // tail of an arbitrary first page. The dedicated read touches one row per
    // event source and falls back to the page read only when unavailable.
    let lastAt: unknown;
    try {
      const latest = asRecord(this.#driver.readTaskLatestEventAt(taskId));
      lastAt = latest?.at;
    } catch {
      const events = this.#driver.readTaskEvents(taskId, { afterCursor: 0, limit: 200 }) as { events?: readonly Record<string, unknown>[] };
      lastAt = events.events?.at(-1)?.at;
    }
    const createdAt = string(projection.created_at, "task_created_at_missing");
    const status = taskStatus(projection.status);
    const dispatchBlocker = status === "queued"
      ? await this.#dispatchBlocker(taskId, snapshot)
      : undefined;
    const workerIdentity = operation?.claim_worker_identity_json ? parseRecord(operation.claim_worker_identity_json) : null;
    const launchIdentity = !workerIdentity && operation?.launch_identity_json ? parseRecord(operation.launch_identity_json) : null;
    const workerPid = status === "running"
      ? positiveOrNull(workerIdentity?.process_id ?? launchIdentity?.process_id)
      : null;
    const executionObservation = await this.#executionObservation(taskId, snapshot, status);
    return {
      task_id: taskId,
      status,
      attempt: Number(projection.current_attempt),
      created_at: createdAt,
      updated_at: typeof lastAt === "string" ? lastAt : createdAt,
      started_at: typeof result?.started_at === "string" ? result.started_at : operation && status === "running" ? createdAt : null,
      finished_at: typeof result?.finished_at === "string" ? result.finished_at : null,
      worker_pid: workerPid,
      zcode_session_id: typeof result?.session_id === "string" ? result.session_id : null,
      exit_code: typeof result?.exit_code === "number" ? result.exit_code : null,
      ...(typeof result?.error_code === "string" ? { error_code: result.error_code } : {}),
      ...(typeof result?.summary === "string" && status === "failed" ? { error: result.summary } : {}),
      ...(!result && typeof snapshot.result_submission_error === "string" ? {
        error_code: snapshot.result_submission_error,
        error: `Worker Result not committed: ${snapshot.result_submission_error}; execution is not retried and resources remain held pending identity-bound Recovery`,
      } : {}),
      ...(executionObservation ? { execution_observation: executionObservation } : {}),
      ...(dispatchBlocker ? { dispatch_blocker: dispatchBlocker } : {}),
      owner_binding: taskOwnerBinding(snapshot.owner_binding),
      ...(Number(attempt.attempt) > 0 ? {} : {}),
    };
  }

  async listTasks(input: ListTasksInput = {}): Promise<TaskListPage> {
    this.#assertOpen();
    const page = asRecord(this.#driver.readTaskProjections({
      afterTaskId: input.after_task_id ?? null,
      limit: input.limit ?? DEFAULT_TASK_LIST_LIMIT,
      status: input.status ?? null,
    }));
    if (!Array.isArray(page.tasks)
      || (page.next_task_id !== null && typeof page.next_task_id !== "string")
      || typeof page.has_more !== "boolean") {
      throw new TaskManagerError("TASK_STATE", "invalid SQLite task list projection");
    }
    const tasks = page.tasks.map((value): TaskListItem => {
      const item = asRecord(value);
      return {
        task_id: string(item.task_id, "task_list_id_missing"),
        status: taskStatus(item.status),
        attempt: Number(item.attempt),
        created_at: string(item.created_at, "task_list_created_at_missing"),
        workspace: string(item.workspace, "task_list_workspace_missing"),
        objective: string(item.objective, "task_list_objective_missing"),
        owner_binding: taskOwnerBinding(item.owner_binding),
        ...(taskListWakeSummary(item.wake_evidence_json, item.wake_at) ?? {}),
      };
    });
    return {
      tasks,
      next_task_id: page.next_task_id as string | null,
      has_more: page.has_more,
    };
  }

  async listConsoleTasks(input: ConsoleTaskListInput = {}): Promise<ConsoleTaskListPage> {
    this.#assertOpen();
    const limit = input.limit ?? DEFAULT_TASK_LIST_LIMIT;
    const bucket = input.bucket;
    if (bucket === undefined) {
      const page = asRecord(this.#driver.readTaskProjections({
        afterTaskId: input.after_task_id ?? null,
        limit,
        status: null,
      }));
      const tasks = (Array.isArray(page.tasks) ? page.tasks : []).map((value) => {
        const taskId = string(asRecord(value).task_id, "task_list_id_missing");
        const raw = this.#driver.readTaskConsoleProjection(taskId, { includeAttempts: false });
        if (!raw) throw new TaskManagerError("TASK_NOT_FOUND", `Task disappeared during projection: ${taskId}`);
        return consoleTaskListItem(raw);
      });
      return {
        tasks,
        next_task_id: typeof page.next_task_id === "string" ? page.next_task_id : null,
        has_more: page.has_more === true,
      };
    }
    // Bucket filtering happens after the durable projection is derived, so a
    // page may scan several source pages before it can fill its result page.
    const tasks: ConsoleTaskListItem[] = [];
    let cursor = input.after_task_id ?? null;
    let lastScanned: string | null = null;
    let sourceHasMore = false;
    for (let scannedPages = 0; scannedPages < 100; scannedPages += 1) {
      const page = asRecord(this.#driver.readTaskProjections({ afterTaskId: cursor, limit: 100, status: null }));
      const rows = Array.isArray(page.tasks) ? page.tasks : [];
      for (const value of rows) {
        const taskId = string(asRecord(value).task_id, "task_list_id_missing");
        lastScanned = taskId;
        const raw = this.#driver.readTaskConsoleProjection(taskId, { includeAttempts: false });
        if (!raw) continue;
        const item = consoleTaskListItem(raw);
        if (consoleTaskBucket(item) === bucket) tasks.push(item);
        if (tasks.length > limit) break;
      }
      if (tasks.length > limit) {
        sourceHasMore = true;
        break;
      }
      if (page.has_more !== true || typeof page.next_task_id !== "string") break;
      sourceHasMore = true;
      cursor = page.next_task_id;
    }
    const visible = tasks.slice(0, limit);
    return {
      tasks: visible,
      next_task_id: visible.at(-1)?.task_id ?? lastScanned,
      has_more: sourceHasMore,
    };
  }

  async getConsoleTaskDetail(taskId: string): Promise<ConsoleTaskDetail> {
    this.#assertOpen();
    const raw = this.#driver.readTaskConsoleProjection(taskId, { includeAttempts: true });
    if (!raw) throw new TaskManagerError("TASK_NOT_FOUND", `unknown SQLite task: ${taskId}`);
    return consoleTaskDetail(raw);
  }

  async getAttention(taskId: string): Promise<TaskAttentionSnapshot> {
    this.#assertOpen();
    let value: unknown;
    try {
      value = this.#driver.readTaskAttention(taskId);
    } catch (error) {
      const code = errorCode(error);
      if (code === "interaction_reply_outcome_unknown") {
        throw new TaskManagerError(code, code);
      }
      throw new TaskManagerError(
        "TASK_STATE",
        `SQLite attention read failed${code ? `: ${code}` : ""}`,
      );
    }
    if (value === null) throw new TaskManagerError("TASK_NOT_FOUND", `unknown SQLite task: ${taskId}`);
    return parseTaskAttentionSnapshot(value, taskId);
  }

  async getResult(taskId: string, view?: "summary" | "full"): Promise<TaskResult> {
    const snapshot = this.#readSnapshot(taskId);
    if (!snapshot.result) throw new TaskManagerError("TASK_NOT_FINISHED", `task ${taskId} has no committed SQLite Result${snapshot.result_submission_error ? `: ${String(snapshot.result_submission_error)}; Recovery required; no automatic retry` : ""}`);
    // P1 §3.4B: the summary projection runs Executor-side on the same Attempt
    // snapshot so MCP/CLI/Web summary reads stop transporting the full Result.
    if (view === "summary") return summarizeTaskResult(snapshot.result as unknown as TaskResult) as unknown as TaskResult;
    return snapshot.result as unknown as TaskResult;
  }

  /** P1 §3.4A: bounded page over the exact stored canonical Result JSON. The
   * returned next_offset always lands on a UTF-8 codepoint boundary;
   * concatenating every page's data reproduces the stored bytes whose SHA-256
   * is `page.content_digest`. This content digest is independent from the
   * persisted Result-envelope `result_digest`; they are not asserted equal. */
  async getResultPage(taskId: string, offsetBytes: number, maxBytes: number): Promise<Record<string, unknown>> {
    this.#assertOpen();
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 4_194_304) {
      throw new TaskManagerError("TASK_INVALID", "offset_bytes must be a non-negative integer and max_bytes must be between 1024 and 4194304");
    }
    const snapshot = this.#readSnapshot(taskId);
    if (!snapshot.result) throw new TaskManagerError("TASK_NOT_FINISHED", `task ${taskId} has no committed SQLite Result`);
    let page: Record<string, unknown>;
    try {
      page = this.#driver.readTaskResultPage(taskId, offsetBytes, maxBytes) as Record<string, unknown>;
    } catch (error) {
      const code = errorCode(error);
      if (code === "invalid_result_page_offset") throw new TaskManagerError("TASK_INVALID", "offset_bytes is beyond the stored Result");
      throw error;
    }
    const committed = snapshot.result as unknown as TaskResult;
    return {
      // Core committed-Result identity fields (bounded by the storage
      // contract; the large zcode_output stays behind the page cursor).
      task_id: committed.task_id,
      attempt: committed.attempt,
      status: committed.status,
      summary: committed.summary,
      files_changed: committed.files_changed,
      tests: committed.tests,
      issues: committed.issues,
      needs_master_decision: committed.needs_master_decision,
      exit_code: committed.exit_code,
      session_id: committed.session_id,
      started_at: committed.started_at,
      finished_at: committed.finished_at,
      ...(committed.error_code ? { error_code: committed.error_code } : {}),
      result_status: page.result_status,
      result_digest: page.result_digest,
      result_content_digest: page.result_content_digest,
      result_commit_ref: page.result_commit_ref,
      page: {
        offset_bytes: page.offset_bytes,
        next_offset: page.next_offset,
        total_bytes: page.total_bytes,
        data: page.data,
      },
    };
  }

  recordExecutorWakeObservation(input: AuthorityExecutorWakeObservationInput): {
    readonly duplicate: boolean;
    readonly state: AuthorityExecutorWakeObservationInput["state"];
  } {
    this.#assertOpen();
    const result = this.#driver.recordExecutorWakeObservation(input) as {
      readonly duplicate: boolean;
      readonly state: AuthorityExecutorWakeObservationInput["state"];
    };
    return result;
  }

  async getEvents(input: GetEventsInput): Promise<TaskProgressPage> {
    this.#assertOpen();
    if (input.wait_for !== undefined && input.wait_for !== "attention") throw new TaskManagerError("TASK_INVALID", "wait_for must be attention when provided");
    if (input.view !== undefined && input.view !== "raw" && input.view !== "summary") throw new TaskManagerError("TASK_INVALID", "view must be raw or summary");
    if (input.max_bytes !== undefined && (!Number.isInteger(input.max_bytes) || input.max_bytes < 1024 || input.max_bytes > 32 * 1024 * 1024)) throw new TaskManagerError("TASK_INVALID", "max_bytes must be between 1024 and 33554432");
    const afterSeq = input.after_seq ?? 0;
    const limit = input.limit ?? 100;
    const waitMs = input.wait_ms ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200
      || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25_000) {
      throw new TaskManagerError("TASK_INVALID", "invalid SQLite event cursor, limit or wait_ms");
    }
    let cursor = afterSeq;
    if (input.scan_cursor !== undefined) {
      const decoded = decodeCursor(input.scan_cursor, input.task_id);
      if (input.after_seq !== undefined && input.after_seq !== decoded) throw new TaskManagerError("TASK_INVALID", "after_seq conflicts with scan_cursor");
      cursor = decoded;
    }
    if (input.wait_for === "attention") {
      await waitForAttentionSnapshot({ read: () => this.getAttention(input.task_id), timeoutMs: waitMs });
      const page = await this.getEvents({ ...input, wait_for: undefined, wait_ms: 0 });
      const attention = await this.getAttention(input.task_id);
      return { ...page, status: attention.status, attention };
    }
    const includeAttempt = input.include_attempt === true;
    const eventBudget = resolveEventPageBudget(input.max_bytes);
    const deadline = Date.now() + waitMs;
    while (true) {
      const snapshot = this.#readSnapshot(input.task_id);
      const page = this.#driver.readTaskEvents(input.task_id, { afterCursor: cursor, limit }) as {
        events: readonly Record<string, unknown>[]; nextCursor: number; hasMore: boolean;
      };
      const visiblePage = input.view === "summary"
        ? mergeAdjacentModelOutputRows(page.events, eventBudget.maxBytes, includeAttempt)
        : { rows: page.events, omittedEvents: 0, omittedEventsByRow: page.events.map(() => 0) };
      const projectedEvents = visiblePage.rows.map((value) => {
        const event = toProgressEvent(value, includeAttempt);
        if (event.type !== "interaction_requested" || !event.details || typeof event.details.request_id !== "string") return event;
        const persisted = this.#driver.readInteractionRequest(input.task_id, event.details.request_id);
        if (!persisted) return event;
        const request = asRecord(persisted.request);
        return { ...event, details: { ...event.details, method: request.method, params: request.params } };
      });
      const bounded = applyEventByteBudget(projectedEvents, page.nextCursor, eventBudget.maxBytes, cursor, {
        allowOversizedFirstEvent: eventBudget.allowOversizedFirstEvent,
      });
      const { events, nextCursor, scanIncomplete } = bounded;
      const omittedEvents = visiblePage.omittedEventsByRow
        .slice(0, events.length)
        .reduce((total, count) => total + count, 0);
      const status = taskStatus(asRecord(snapshot.projection).status);
      if (events.length || scanIncomplete || isTerminal(status) || Date.now() >= deadline) {
        return {
          task_id: input.task_id,
          status,
          events,
          next_seq: nextCursor,
          has_more: page.hasMore || scanIncomplete,
          ...(omittedEvents > 0 ? { omitted_events: omittedEvents } : {}),
          ...(scanIncomplete ? { scan_incomplete: true, scan_cursor: encodeCursor(input.task_id, nextCursor) } : {}),
        };
      }
      await delay(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  async getFeedback(taskId: string): Promise<TaskFeedbackSnapshotV01> {
    this.#readSnapshot(taskId);
    return this.#driver.readTaskFeedback(taskId) as TaskFeedbackSnapshotV01;
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskReceipt> {
    this.#assertOpen();
    this.#assertAccepting();
    this.#assertRecoveryReady();
    if (typeof input.feedback !== "string" || !input.feedback.trim()) throw new TaskManagerError("TASK_INVALID", "feedback must be non-empty");
    const common = {
      ...(input.operation_id ? { operation_id: input.operation_id } : {}),
      task_id: input.task_id,
      feedback: input.feedback,
      additional_requirements: input.additional_requirements ?? [],
    };
    // The Store checks an existing idempotency key before requiring a new
    // Attempt CAS fence. This permits a lost-response replay even after the
    // new Attempt has become current or the prior Operation is no longer the
    // current snapshot. A missing-fence result means this is a first request;
    // it has no side effect and the full CAS path below must authorize it.
    if (input.operation_id) {
      try {
        const replay = asRecord(this.#driver.createNextAttempt(common));
        this.#enqueue(input.task_id, Number(replay.attempt));
        return {
          task_id: input.task_id,
          status: "queued",
          created_at: string(replay.created_at, "continue_created_at_missing"),
          owner_binding: taskOwnerBinding(replay.owner_binding),
        };
      } catch (error) {
        if (errorCode(error) !== "continue_cas_required") throw error;
      }
    }
    const snapshot = this.#readSnapshot(input.task_id);
    if (!snapshot.operation) throw new TaskManagerError("TASK_STATE", "the prior SQLite Attempt has no released Operation");
    const operation = asRecord(snapshot.operation);
    const result = snapshot.result as Record<string, unknown> | null;
    const releaseEvent = this.#driver.readAllLifecycleEvents(
      string(operation.operation_id, "continue_operation_missing"),
    ).map(asRecord).reverse().find((event) => event.event_type === "released");
    const releaseRevision = Number(releaseEvent?.sequence);
    if (!Number.isSafeInteger(releaseRevision) || releaseRevision < 1) {
      throw new TaskManagerError("TASK_STATE", "the prior SQLite Attempt has no durable Release fact");
    }
    const outcome = asRecord(this.#driver.createNextAttempt({
      ...common,
      previous_attempt: Number(asRecord(snapshot.attempt).attempt),
      previous_operation_id: string(operation.operation_id, "continue_operation_missing"),
      expected_generation: Number(operation.generation),
      // Wake observations append Operation revisions after Release. The
      // continuation CAS must bind the durable Release event, not the later
      // read-only Wake revision.
      expected_revision: releaseRevision,
      claim_id: string(operation.claim_id, "continue_claim_missing"),
      claim_worker_identity_digest: string(operation.claim_worker_identity_digest, "continue_worker_identity_missing"),
      previous_result: result,
    }));
    this.#enqueue(input.task_id, Number(outcome.attempt));
    return {
      task_id: input.task_id,
      status: "queued",
      created_at: string(outcome.created_at, "continue_created_at_missing"),
      owner_binding: taskOwnerBinding(outcome.owner_binding),
    };
  }

  async cancelTask(taskId: string, options: { readonly acceptWorkerRisk?: boolean } = {}): Promise<TaskStatusRecord> {
    const existing = this.#recoveryRuns.get(taskId);
    if (existing) return existing;
    const cancellation = Promise.resolve().then(() => this.#cancelTaskOnce(taskId, true, options));
    this.#recoveryRuns.set(taskId, cancellation);
    try { return await cancellation; }
    finally { if (this.#recoveryRuns.get(taskId) === cancellation) this.#recoveryRuns.delete(taskId); }
  }

  async #cancelTaskOnce(taskId: string, reconcileClaimRace = true,
    options: { readonly acceptWorkerRisk?: boolean } = {}): Promise<TaskStatusRecord> {
    this.#assertOpen();
    this.#assertRecoveryReady();
    const snapshot = this.#readSnapshot(taskId);
    const projection = asRecord(snapshot.projection);
    const attempt = asRecord(snapshot.attempt);
    if (projection.status === "queued") {
      try { this.#driver.cancelQueuedAttempt({ task_id: taskId, expected_attempt: Number(attempt.attempt) }); }
      catch (error) {
        const current = this.#readSnapshot(taskId);
        if (reconcileClaimRace && current.projection.status === "running"
          && Number(current.attempt.attempt) === Number(attempt.attempt)) {
          return this.#cancelTaskOnce(taskId, false, options);
        }
        throw error;
      }
      this.#queued.delete(queueKey(taskId, Number(attempt.attempt)));
      this.#schedulePump();
      if (options.acceptWorkerRisk === true) {
        return await this.#userAuthorizedRelease(taskId, this.#readSnapshot(taskId), {}, true);
      }
      return this.getStatus(taskId);
    }
    if (projection.status === "running") {
      const attemptNumber = Number(attempt.attempt);
      const key = queueKey(taskId, attemptNumber);
      let cancellation: Record<string, unknown>;
      try { cancellation = asRecord(await this.#driver.cancelRunning(taskId, attemptNumber)); }
      catch (error) {
        throw new TaskManagerError("CANCEL_FAILED", `SQLite Worker cancellation could not be verified: ${error instanceof Error ? error.message : String(error)}`);
      }
      const activeRun = this.#activeRuns.get(key);
      if (activeRun) await activeRun.catch(() => undefined);
      if (cancellation.result_won === true) return this.getStatus(taskId);
      let completion: Record<string, unknown>;
      try { completion = asRecord(await this.#driver.completeRunningCancellation(taskId, attemptNumber)); }
      catch (error) {
        throw new TaskManagerError("CANCEL_FAILED", `SQLite cancellation Result/Cleanup could not be committed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (completion.cancelled !== true || completion.cleanup_verified !== true || completion.phase !== "released") {
        throw new TaskManagerError("CANCEL_FAILED", "SQLite cancellation did not verify Cleanup and Release; Operation occupancy remains retained");
      }
      this.#schedulePump();
      return this.getStatus(taskId);
    }
    const operation = snapshot.operation ? asRecord(snapshot.operation) : null;
    if (projection.status === "cancelled" && operation?.phase === "launch_intent" && operation.claim_id === null) {
      return await this.#userAuthorizedRelease(taskId, snapshot, {}, options.acceptWorkerRisk === true);
    }
    if (projection.status === "cancelled" && (!operation || operation.phase === "cancelled_before_launch")) return this.getStatus(taskId);
    if (isTerminal(projection.status as TaskStatus) && operation?.phase === "released") {
      // A repeated recovery request is a read-only no-op after the durable
      // Release; do not append another lifecycle event or stop a new PID.
      return this.getStatus(taskId);
    }
    if (isTerminal(projection.status as TaskStatus) && operation
      && ["result_committed", "cleanup_pending", "cleanup_unverified", "cleanup_verified"].includes(String(operation.phase))) {
      // Recovery verifies the committed Result binding in the Driver before
      // CAS/Release; do not duplicate it with a snapshot truthiness check.
      const recovery = Promise.resolve().then(async () => {
        const readReleased = async (): Promise<TaskStatusRecord | null> => {
          const latest = this.#readSnapshot(taskId);
          const latestProjection = asRecord(latest.projection);
          const latestOperation = latest.operation ? asRecord(latest.operation) : null;
          return isTerminal(latestProjection.status as TaskStatus) && latestOperation?.phase === "released"
            ? this.getStatus(taskId)
            : null;
        };
        let outcome: Record<string, unknown>;
        try {
          outcome = asRecord(await this.#driver.recoverOperation(
            string(operation.operation_id, "operation_id_missing"),
            { stopAliveWorker: true },
          ));
        } catch (error) {
          // A concurrent Recovery may have won the revision CAS. Re-read the
          // SQLite Authority before returning the race as an error.
          const released = await readReleased();
          if (released) return released;
          throw error;
        }
        if (outcome.state !== "released" && outcome.state !== "complete") {
          // A stale Recovery can report a changed revision instead of throwing
          // from the CAS. Re-read here too; only durable Release is success.
          const released = await readReleased();
          if (released) return released;
          const reason = typeof outcome.reason === "string" ? outcome.reason : "worker_cleanup_unverified";
          const latestProjection = asRecord(this.#readSnapshot(taskId).projection);
          if (String(operation.phase) === "cleanup_unverified"
            && canUserAuthorizeUnverifiedRelease(outcome)) {
            return await this.#userAuthorizedRelease(taskId, this.#readSnapshot(taskId), outcome);
          }
          throw new TaskManagerError("CANCEL_FAILED", `Cleanup remains unverified for this workspace: ${reason}`);
        }
        this.#schedulePump();
        return this.getStatus(taskId);
      });
      return recovery;
    }
    throw new TaskManagerError("TASK_STATE", `zcode_cancel is not allowed from SQLite status ${String(projection.status)}`);
  }

  async #userAuthorizedRelease(
    taskId: string,
    snapshot: TaskSnapshot,
    authorizationEvidence: Record<string, unknown> = {},
    acceptWorkerRisk = false,
  ): Promise<TaskStatusRecord> {
    const operation = snapshot.operation ? asRecord(snapshot.operation) : null;
    const projection = asRecord(snapshot.projection);
    const terminalStatuses = ["completed", "failed", "waiting_for_master", "cancelled"];
    const statusMatches = operation?.phase === "launch_intent"
      ? projection.status === "cancelled"
      : projection.status === operation?.result_status;
    if (!terminalStatuses.includes(String(projection.status)) || !statusMatches) {
      throw new TaskManagerError("TASK_STATE", "user-authorized unverified release requires a terminal Result bound to the Operation");
    }
    if (!operation || operation.phase !== "launch_intent" && operation.phase !== "cleanup_unverified") {
      throw new TaskManagerError("TASK_STATE", "zcode_cancel has no user-authorized unverified release path for this Operation");
    }
    if (operation.phase === "launch_intent"
      && (operation.launch_receipt_id !== null
        || operation.launch_receipt_digest !== null
        || operation.launch_identity_json !== null)
      && !acceptWorkerRisk) {
      throw new TaskManagerError(
        "CANCEL_FAILED",
        "launch_intent has durable spawn evidence; user-authorized unverified release is not allowed",
      );
    }
    const attempt = asRecord(snapshot.attempt);
    const recoveryEvidenceDigest = operation.phase === "cleanup_unverified"
      ? typeof authorizationEvidence.evidence_digest === "string" ? authorizationEvidence.evidence_digest : null
      : null;
    let releaseBinding: Record<string, unknown> = {};
    let cancelId: string | null = null;
    if (operation.phase === "launch_intent") {
      if (typeof attempt.queued_cancel_id !== "string") {
        throw new TaskManagerError("CANCEL_FAILED", "user-authorized unverified release requires the original durable cancellation Result");
      }
      cancelId = attempt.queued_cancel_id;
    } else if (operation.phase === "cleanup_unverified") {
      if (!recoveryEvidenceDigest || typeof operation.result_digest !== "string"
        || typeof operation.result_commit_ref !== "string" || typeof operation.claim_id !== "string"
        || typeof operation.claim_worker_identity_digest !== "string") {
        throw new TaskManagerError("CANCEL_FAILED", "user-authorized terminal release lacks bound Result or recovery evidence");
      }
      releaseBinding = {
        claim_id: operation.claim_id,
        result_commit_ref: operation.result_commit_ref,
        result_digest: operation.result_digest,
        recovery_evidence_digest: recoveryEvidenceDigest,
        worker_identity_digest: operation.claim_worker_identity_digest,
      };
    }
    const releaseRequest: Record<string, unknown> = {
      operation_id: string(operation.operation_id, "operation_id_missing"),
      task_id: taskId,
      attempt: Number(attempt.attempt),
      generation: Number(operation.generation),
      revision: Number(operation.revision),
      release_reason: "user_authorized_release_unverified",
      ...releaseBinding,
    };
    if (cancelId !== null) releaseRequest.cancel_id = cancelId;
    if (operation.phase === "launch_intent" && acceptWorkerRisk) {
      if (typeof operation.launch_receipt_digest !== "string") {
        throw new TaskManagerError("CANCEL_FAILED", "forced launch release requires the persisted Receipt digest");
      }
      releaseRequest.accept_worker_risk = true;
      releaseRequest.launch_receipt_digest = operation.launch_receipt_digest;
    }
    const outcome = asRecord(this.#driver.userAuthorizedReleaseUnverifiedOperation(releaseRequest as never));
    if (outcome.phase !== "released" || outcome.cleanup_verified !== false) {
      throw new TaskManagerError("CANCEL_FAILED", "SQLite user-authorized unverified release did not persist a distinct Release fact");
    }
    this.#schedulerStage("user_authorized_release_unverified", {
      task_id: taskId, attempt: Number(attempt.attempt), operation_id: operation.operation_id,
      duplicate: outcome.duplicate === true,
    });
    this.#schedulePump();
    return await this.getStatus(taskId);
  }

  async replyToInteraction(input: ZCodeInteractionReplyInput): Promise<{ task_id: string; request_id: string; state: "answered" }> {
    this.#assertOpen();
    this.#assertRecoveryReady();
    const request = this.#driver.readInteractionRequest(input.task_id, input.request_id);
    if (!request) throw new TaskManagerError("TASK_NOT_FOUND", `unknown SQLite interaction request: ${input.request_id}`);
    if (request.state !== "pending") throw new TaskManagerError("TASK_STATE", `SQLite interaction request is ${String(request.state)} and cannot be answered`);
    try {
      await this.#driver.replyToInteractionRequest(input);
    } catch (error) {
      const code = errorCode(error);
      if (code === "interaction_channel_unavailable" || code === "interaction_worker_not_live"
        || code === "interaction_channel_identity_mismatch" || code === "interaction_channel_identity_unknown") {
        throw new TaskManagerError("CANCEL_FAILED", `SQLite interaction Worker could not be verified: ${code}`);
      }
      throw error;
    }
    return { task_id: input.task_id, request_id: input.request_id, state: "answered" };
  }

  async #dispatchBlocker(taskId: string, snapshot: TaskSnapshot): Promise<DispatchBlocker | undefined> {
    const attempt = asRecord(snapshot.attempt);
    if (snapshot.operation || Number(attempt.generation ?? 0) !== 0) return undefined;
    const recoverySnapshot = this.#validateRecoverySnapshot(this.#driver.readRecoverySnapshot());
    const task = snapshot.task;
    const executionPath = taskExecutionPath(task);
    const operations = recoverySnapshot.operations.map(asRecord).filter((operation) => operation.capacity_occupied === true);
    const workspaceOccupied = operations.find((operation) => {
      if (operation.task_id === taskId) return false;
      const workspace = typeof operation.workspace_ref === "string" ? operation.workspace_ref : null;
      return workspace !== null && executionPathsOverlap(workspace, executionPath);
    });
    const capacityOccupied = operations.length >= recoverySnapshot.capacity.capacity_limit
      ? operations.find((operation) => operation.task_id !== taskId)
      : undefined;
    const occupied = workspaceOccupied ?? capacityOccupied;
    if (!occupied) return undefined;
    const createdAt = string(projectionCreated(snapshot), "task_created_at_missing");
    const now = Date.now();
    const operationCreated = typeof occupied.created_at === "string" ? Date.parse(occupied.created_at) : null;
    const blockingWorkspace = string(occupied.workspace_ref, "blocking_workspace_missing");
    const queuedCreated = Date.parse(createdAt);
    const sameWorkspace = workspaceOccupied !== undefined;
    return {
      reason: sameWorkspace ? "workspace_occupied" : "capacity_occupied",
      task_id: string(occupied.task_id, "blocking_task_id_missing"),
      operation_id: string(occupied.operation_id, "blocking_operation_id_missing"),
      phase: string(occupied.phase, "blocking_phase_missing"),
      workspace: blockingWorkspace,
      queued_duration_ms: nonNegativeDuration(now, queuedCreated),
      blocked_duration_ms: nonNegativeDuration(now, operationCreated ?? 0),
    };
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (this.#closed) return;
    this.#shuttingDown = true;
    if (this.#pumpRetryTimer) clearTimeout(this.#pumpRetryTimer);
    this.#pumpRetryTimer = null;
    if (this.#pumpFailureRetryTimer) clearTimeout(this.#pumpFailureRetryTimer);
    this.#pumpFailureRetryTimer = null;
    if (this.#workspaceRetryTimer) clearTimeout(this.#workspaceRetryTimer);
    this.#workspaceRetryTimer = null;
    const attempt = this.#shutdownGracefully();
    let tracked: Promise<void>;
    tracked = attempt.catch((error: unknown) => {
      // A failed, fail-closed shutdown can be retried after the operator has
      // resolved the still-live or unknown Worker condition.
      if (this.#shutdownPromise === tracked) this.#shutdownPromise = null;
      throw error;
    });
    this.#shutdownPromise = tracked;
    return tracked;
  }

  async #shutdownGracefully(): Promise<void> {
    const deadline = Date.now() + this.#shutdownWaitMs;
    // Let a scheduled pump enter and either observe the shutdown fence before
    // Spawn or publish its active run. No new queue item may start afterward.
    await Promise.resolve();
    const active = [...this.#activeRuns.keys()];
    const failures: string[] = [];
    for (const key of active) {
      const separator = key.lastIndexOf("\0");
      const taskId = key.slice(0, separator);
      const attempt = Number(key.slice(separator + 1));
      let alreadyTerminal = false;
      try {
        const snapshot = this.#readSnapshot(taskId);
        const projection = asRecord(snapshot.projection);
        // Result may already be durably terminal while Cleanup and Capacity
        // Release are still completing inside the active run Promise. Wait for
        // that Promise instead of trying to cancel an Attempt that can no
        // longer be cancelled. Final state is separately required to be
        // terminal and released below.
        alreadyTerminal = Number(snapshot.attempt.attempt) === attempt
          && isTerminal(taskStatus(projection.status));
      } catch {
        // An unreadable or mismatched snapshot is not evidence of safe state;
        // retain the original cancellation path and fail closed.
      }
      if (alreadyTerminal) continue;
      try {
        const status = await waitUntilDeadline(this.cancelTask(taskId), deadline);
        if (status.status === "running" || status.status === "queued") failures.push(`${taskId}:shutdown_cancel_unconfirmed`);
      } catch (error) {
        failures.push(`${taskId}:${errorCode(error) ?? (error instanceof Error && error.message === "shutdown_wait_timeout"
          ? "shutdown_wait_timeout" : "shutdown_cancel_failed")}`);
      }
    }
    const pump = Promise.allSettled(this.#pumpPromises).then(() => undefined);
    // A pump waiting before Spawn has no Worker to clean up. The monotonic
    // shutdown fence makes it stop immediately after its prerequisite wakes;
    // waiting for that prerequisite could make shutdown depend on a blocked
    // scheduler hook and is unnecessary before closing the Store.
    if (pump && (active.length > 0 || !this.#awaitingDispatchPrerequisite)) {
      try { await waitUntilDeadline(pump, deadline); }
      catch { failures.push("root:shutdown_pump_wait_timeout_or_failure"); }
    }
    if (this.#activeRuns.size > 0) {
      try { await waitUntilDeadline(Promise.allSettled(this.#activeRuns.values()).then(() => undefined), deadline); }
      catch { failures.push("root:shutdown_worker_wait_timeout"); }
    }
    for (const key of active) {
      const separator = key.lastIndexOf("\0");
      const taskId = key.slice(0, separator);
      const attempt = Number(key.slice(separator + 1));
      try {
        const snapshot = this.#readSnapshot(taskId);
        const projection = asRecord(snapshot.projection);
        const operation = snapshot.operation ? asRecord(snapshot.operation) : null;
        const released = Number(snapshot.attempt.attempt) === attempt
          && isTerminal(taskStatus(projection.status))
          && operation?.phase === "released";
        if (!released) failures.push(`${taskId}:shutdown_release_unverified`);
      } catch {
        failures.push(`${taskId}:shutdown_release_unknown`);
      }
    }
    if (failures.length > 0) {
      // Keep the SQLite handle and Host alive. An uncertain shutdown must not
      // release Writer ownership or make a possibly active Worker look closed.
      throw new TaskManagerError("CANCEL_FAILED", `SQLite Host shutdown retained its Root because Worker cleanup is unverified: ${failures.join(",")}`);
    }
    this.#closed = true;
    this.#driver.close();
  }

  /** Read-only Executor shutdown evidence. A non-empty list means idle-only
   * close must be refused without latching the legacy Host shutdown fence. */
  getExecutorIdleState(): { readonly idle: boolean; readonly blockers: readonly string[] } {
    this.#assertOpen();
    const blockers: string[] = [];
    if (this.#queue.length > 0) blockers.push("queued_attempt");
    if (this.#queued.size > 0) blockers.push("queued_attempt");
    if (this.#activeRuns.size > 0) blockers.push("active_run");
    if (this.#active > 0) blockers.push("active_pump");
    if (this.#pumpPending) blockers.push("pump_pending");
    if (this.#dispatchingPaths.size > 0) blockers.push("dispatching_path");
    if (this.#recoveryRuns.size > 0) blockers.push("recovery_run");
    if (this.#awaitingDispatchPrerequisite) blockers.push("dispatch_prerequisite_pending");
    if (this.#recoveryInProgress || !this.#recoveryComplete || this.#recoveryBlocked) {
      blockers.push("recovery_pending");
    }
    if (this.#pumpFailure) blockers.push(`pump_failure:${this.#pumpFailure.reason}`);
    try {
      const snapshot = this.#validateRecoverySnapshot(this.#driver.readRecoverySnapshot());
      const rootBlockers = Array.isArray((snapshot as unknown as { readonly root_blockers?: readonly unknown[] }).root_blockers)
        ? (snapshot as unknown as { readonly root_blockers: readonly unknown[] }).root_blockers
        : [];
      blockers.push(...rootBlockers.map((blocker) => `root:${String(blocker)}`));
      for (const value of snapshot.operations) {
        const operation = asRecord(value);
        const recoveryBlockers = Array.isArray(operation.recovery_blockers)
          ? operation.recovery_blockers.map(String)
          : [];
        if (recoveryBlockers.includes("interaction_reply_outcome_unknown")) blockers.push("pending_interaction");
        // A fresh SQLite root commits one capacity-policy fact at bootstrap.
        // It is not executable work and must not block an idle-only shutdown.
        if (String(operation.operation_kind) !== "capacity_policy_change"
          && !EXECUTOR_IDLE_OPERATION_PHASES.has(String(operation.phase))) {
          const operationId = typeof operation.operation_id === "string" ? operation.operation_id : "unknown";
          blockers.push(`operation:${operationId}:${String(operation.phase)}`);
        }
      }
    } catch (error) {
      blockers.push(`recovery_snapshot:${errorCode(error) ?? "unknown"}`);
    }
    return { idle: blockers.length === 0, blockers: [...new Set(blockers)] };
  }

  /** Executor-only close. Unlike shutdown(), this never cancels or waits for
   * work; the caller must keep the Lifetime Lease active whenever it rejects. */
  async closeIfIdle(): Promise<{ readonly closed: boolean; readonly blockers: readonly string[] }> {
    this.#assertOpen();
    const { idle, blockers } = this.getExecutorIdleState();
    if (!idle) return { closed: false, blockers };
    this.#closed = true;
    try {
      this.#driver.close();
    } catch (error) {
      // Keep #closed true: the close result is unknown and a second Store
      // owner must never be admitted. The executor lease remains active.
      throw new TaskManagerError("EXECUTOR_STORE_CLOSE_UNKNOWN", error instanceof Error ? error.message : String(error));
    }
    return { closed: true, blockers: [] };
  }

  /** Read the same SQLite root and Manager fence used by lifecycle mutations. */
  getDoctorChecks(): DoctorCheck[] {
    this.#assertOpen();
    return buildSqliteDoctorChecks(this.#driver.readRecoverySnapshot(), this.#recoveryBlocked);
  }

  async recoverTasks(): Promise<void> {
    this.#assertOpen();
    if (this.#recoveryPromise) return this.#recoveryPromise;
    const recovery = this.#recoverTasksOnce();
    this.#recoveryPromise = recovery;
    try { await recovery; }
    finally { if (this.#recoveryPromise === recovery) this.#recoveryPromise = null; }
  }

  async #recoverTasksOnce(): Promise<void> {
    this.#recoveryComplete = false;
    this.#recoveryInProgress = true;
    try {
      let snapshot = this.#validateRecoverySnapshot(this.#driver.readRecoverySnapshot());
      this.#recoveryBlocked = null;
      this.#schedulerStage("recovery_snapshot_verified", {
        operation_count: snapshot.operations.length,
        occupied_count: snapshot.operations.filter((operation) => Boolean(asRecord(operation).capacity_occupied)).length,
        writes_allowed: false,
      });
      for (const value of snapshot.operations) {
        const operation = asRecord(value);
        const operationId = operation.operation_id;
        if (typeof operationId !== "string") throw new TaskManagerError("TASK_STATE", "Recovery snapshot contains an Operation without identity");
        const taskId = typeof operation.task_id === "string" ? operation.task_id : null;
        const attempt = Number(operation.attempt);
        if (String(operation.phase) === "running" && operation.result_digest === null
          && taskId !== null && this.#activeRuns.has(queueKey(taskId, attempt))) {
          this.#schedulerStage("operation_recovery_deferred_active_host", {
            operation_id: operationId, task_id: taskId, attempt, reason: "host_run_is_active",
          });
          continue;
        }
        if (String(operation.phase) === "running" && operation.result_digest === null
          && taskId !== null && this.#isAutomaticRecoveryAttempt(taskId, attempt)) {
          this.#schedulerStage("operation_recovery_requeue_budget_exhausted", {
            operation_id: operationId, task_id: taskId, attempt,
            reason: "automatic_recovery_attempt_interrupted",
          });
          continue;
        }
        const outcome = asRecord(await this.#driver.recoverOperation(operationId, {
          stopAliveWorker: true,
          allowInterruptRequeue: true,
        }));
        this.#schedulerStage("operation_recovery_classified", {
          operation_id: operationId, phase: operation.phase, state: outcome.state ?? "unknown", reason: outcome.reason ?? null,
        });
        if (outcome.state === "requeued" && typeof outcome.task_id === "string"
          && Number.isSafeInteger(outcome.attempt) && Number(outcome.attempt) > 0) {
          this.#enqueue(outcome.task_id, Number(outcome.attempt));
        }
        if (outcome.state === "held") {
          // An unresolved executor or cleanup failure holds only its own
          // Operation/workspace. The dispatch gate prevents another Worker
          // in that path while unrelated work continues.
          this.#schedulerStage("recovery_workspace_scoped", {
            operation_id: operationId,
            reason: outcome.reason ?? "recovery_evidence_unknown",
          });
        }
      }
      snapshot = this.#validateRecoverySnapshot(this.#driver.readRecoverySnapshot());
      const queued = this.#driver.readRecoverableQueuedAttempts();
      for (const value of queued) {
        const candidate = asRecord(value);
        if (candidate.dispatchable === true && typeof candidate.task_id === "string"
          && Number.isSafeInteger(candidate.attempt) && Number(candidate.attempt) > 0) {
          this.#enqueue(candidate.task_id, Number(candidate.attempt));
        } else {
          this.#schedulerStage("queued_recovery_held", {
            task_id: candidate.task_id ?? null, attempt: candidate.attempt ?? null,
            operation_id: candidate.operation_id ?? null, phase: candidate.phase ?? null,
            reason: candidate.reason ?? "queued_attempt_not_proven_dispatchable",
          });
        }
      }
      this.#recoveryComplete = true;
      this.#pumpFailure = null;
      this.#schedulerStage("recovery_complete", { recoverable_queued_attempts: queued.filter((value) => value.dispatchable === true).length,
        root_read_only: false });
      // P1 §3.3: an Executor can exit between the durable Release commit and
      // the Wake intent write. Recovery re-runs the notification for released
      // operations that carry a committed Result but no executor_wake
      // observation at all; operations with any recorded wake fact keep their
      // existing dedup/visibility contract and are never re-queued.
      await this.#recoverUnnotifiedReleases(snapshot);
      this.#schedulePump();
    } catch (error) {
      this.#recoveryBlocked = error instanceof Error ? error.message : String(error);
      this.#pumpFailure = { taskId: "root", reason: errorCode(error) ?? "recovery_snapshot_unavailable" };
      this.#recoveryComplete = false;
      throw error;
    } finally {
      this.#recoveryInProgress = false;
    }
  }

  async #executionObservation(taskId: string, snapshot: TaskSnapshot, status: TaskStatus): Promise<ExecutionObservation | undefined> {
    const operation = snapshot.operation;
    if (status === "cancelled" && operation?.phase === "launch_intent" && operation.claim_id === null) {
      return this.#makeExecutionObservation("cleanup_held", taskId, snapshot, "cancelled_before_claim_cleanup_unverified", new Date().toISOString());
    }
    if (operation && ["cleanup_pending", "cleanup_unverified", "cleanup_reverified", "cleanup_incomplete"].includes(String(operation.phase))) {
      return this.#makeExecutionObservation("cleanup_held", taskId, snapshot, "cleanup_phase_held", new Date().toISOString());
    }
    if (status !== "running") return undefined;
    const attempt = Number(snapshot.projection.current_attempt);
    if (this.#activeRuns.has(queueKey(taskId, attempt))) return undefined;
    const persisted = operation?.claim_worker_identity_json
      ? parseRecord(operation.claim_worker_identity_json)
      : operation?.launch_identity_json ? parseRecord(operation.launch_identity_json) : null;
    const pid = positiveOrNull(persisted?.process_id);
    const startFingerprint = typeof persisted?.start_fingerprint === "string" ? persisted.start_fingerprint : null;
    if (!persisted || pid === null || persisted.fingerprint_precision !== "exact"
      || startFingerprint === null || !startFingerprint
      || typeof persisted.platform !== "string" || persisted.identity_version !== PROCESS_IDENTITY_VERSION) {
      return this.#makeExecutionObservation("worker_identity_unknown", taskId, snapshot, "persisted_identity_unavailable", new Date().toISOString());
    }
    const identity: ProcessIdentity = {
      pid,
      fingerprint: startFingerprint,
      fingerprint_precision: "exact",
      identity_version: PROCESS_IDENTITY_VERSION,
      platform: persisted.platform,
      captured_at: typeof persisted.captured_at === "string" ? persisted.captured_at : "",
    };
    let verdict: Awaited<ReturnType<ProcessProbe["probe"]>>[number] | undefined;
    try {
      verdict = (await boundedObservationProbe(this.#processProbe, pid, identity)) ?? undefined;
    } catch { /* A failed observation is Unknown, never proof of exit. */ }
    const observedAt = verdict?.observed_at ?? new Date().toISOString();
    const state = verdict?.state === "alive" ? "worker_alive_unmanaged"
      : verdict?.state === "exited" ? "interrupted_without_result" : "worker_identity_unknown";
    return this.#makeExecutionObservation(state, taskId, snapshot, verdict?.reason_code ?? "process_probe_unknown", observedAt);
  }

  #makeExecutionObservation(state: ExecutionObservation["state"], taskId: string, snapshot: TaskSnapshot, reason: string, observedAt: string): ExecutionObservation {
    const operation = snapshot.operation;
    const reference = createHash("sha256").update(canonicalJson({
      task_id: taskId,
      attempt: Number(snapshot.projection.current_attempt),
      operation_id: operation?.operation_id ?? null,
      generation: operation?.generation ?? null,
      revision: operation?.revision ?? null,
      phase: operation?.phase ?? null,
      worker_identity_digest: operation?.claim_worker_identity_digest ?? null,
      state,
      reason,
      observed_at: observedAt,
    }), "utf8").digest("hex");
    return { state, observed_at: observedAt, evidence_ref: reference };
  }

  #validateRecoverySnapshot(value: unknown): {
    readonly operations: readonly unknown[];
    readonly events: readonly unknown[];
    readonly taskProjections: readonly unknown[];
    readonly capacity: Readonly<{ capacity_limit: number }>;
  } {
    const snapshot = asRecord(value);
    const capacity = snapshot.capacity ? asRecord(snapshot.capacity) : null;
    if (snapshot.root_status !== "consistent_read_only" || snapshot.writes_allowed !== false
      || snapshot.cleanup_performed !== false || snapshot.claim_release_performed !== false
      || snapshot.operation_release_performed !== false || !Array.isArray(snapshot.operations)
      || !capacity || Number(capacity.policy_version) !== 1 || !Number.isSafeInteger(capacity.policy_generation)
      || Number(capacity.policy_generation) < 1 || !Number.isSafeInteger(capacity.capacity_limit)
      || Number(capacity.capacity_limit) < 1 || Number(capacity.capacity_limit) > 8) {
      const blockers = Array.isArray(snapshot.root_blockers) ? snapshot.root_blockers.map(String).join(",") : "recovery_snapshot_invalid";
      throw new TaskManagerError("TASK_STATE", `SQLite Recovery is blocked (${blockers || "root_not_consistent"}); no lifecycle side effect was attempted`);
    }
    return {
      operations: snapshot.operations,
      events: Array.isArray(snapshot.events) ? snapshot.events : [],
      taskProjections: Array.isArray(snapshot.task_projections) ? snapshot.task_projections : [],
      capacity: { capacity_limit: Number(capacity.capacity_limit) },
    };
  }

  #driverTrustedPolicy(): NonNullable<ClaimOnlyDriverOptions["trustedLocalContext"]>["policy"] {
    const context = this.#context;
    return context.policy;
  }

  static async create(options: SqliteAuthorityOptions): Promise<SqliteLifecycleMcpAuthority> {
    if (!options.trustedLocalContext) throw new TaskManagerError("TASK_STATE", "trusted local context is required");
    const {
      testBeforeDispatch, testOnScheduler, testShutdownWaitMs, routeTaskModel, onOperationReleased, dispatchFence, ...driverOptions
    } = options;
    const shutdownWaitMs = testShutdownWaitMs ?? DEFAULT_HOST_SHUTDOWN_WAIT_MS;
    if (!Number.isSafeInteger(shutdownWaitMs) || shutdownWaitMs < 1 || shutdownWaitMs > DEFAULT_HOST_SHUTDOWN_WAIT_MS) {
      throw new TaskManagerError("TASK_STATE", "invalid Host shutdown wait budget");
    }
    const processProbe = options.processProbe ?? createPlatformProbe();
    const authority = new SqliteLifecycleMcpAuthority(await openClaimOnlyDriver({ ...driverOptions, processProbe }), options.trustedLocalContext,
      processProbe, testBeforeDispatch, testOnScheduler, shutdownWaitMs,
      options.startPlanPrivateAuth !== undefined || options.startPlanPrivateAuthFactory !== undefined,
      options.testOnlyFakeAdapter === true, routeTaskModel,
      options.startPlanPrivateAuth !== undefined, options.startPlanPrivateAuthFactory, onOperationReleased, dispatchFence);
    try {
      await authority.recoverTasks();
      return authority;
    } catch (error) {
      await authority.shutdown().catch(() => undefined);
      throw error;
    }
  }

  #readSnapshot(taskId: string): { task: TaskPackage; projection: Record<string, unknown>; owner_binding?: unknown; attempt: Record<string, unknown>; operation: Record<string, unknown> | null; result: TaskResult | null; continuation: Record<string, unknown> | null; result_submission_error: string | null } {
    this.#assertOpen();
    const value = this.#driver.readTaskLifecycle(taskId);
    if (!value) throw new TaskManagerError("TASK_NOT_FOUND", `unknown SQLite task: ${taskId}`);
    const snapshot = asRecord(value);
    return {
      task: snapshot.task as TaskPackage,
      projection: asRecord(snapshot.projection),
      ...(snapshot.owner_binding === undefined ? {} : { owner_binding: snapshot.owner_binding }),
      attempt: asRecord(snapshot.attempt),
      operation: snapshot.operation ? asRecord(snapshot.operation) : null,
      result: snapshot.result as TaskResult | null,
      continuation: snapshot.continuation ? asRecord(snapshot.continuation) : null,
      result_submission_error: typeof snapshot.result_submission_error === "string" ? snapshot.result_submission_error : null,
    };
  }

  #isAutomaticRecoveryAttempt(taskId: string, attempt: number): boolean {
    try {
      const snapshot = this.#readSnapshot(taskId);
      if (Number(snapshot.attempt.attempt) !== attempt
        || typeof snapshot.continuation?.previous_operation_id !== "string") return false;
      const previous = this.#driver.readCommittedResult(snapshot.continuation.previous_operation_id);
      const result = previous?.result;
      if (!result || result.status !== "failed"
        || !["interrupted_by_upgrade", "worker_exited_without_result", "worker_terminated_without_result"].includes(result.error_code ?? "")) {
        return false;
      }
      return result.issues.some((issue) => /^interruption_evidence:[0-9a-f]{64}$/u.test(issue));
    } catch {
      // If continuation identity cannot be read, retain occupancy rather than
      // creating an unbounded retry chain.
      return true;
    }
  }

  #enqueue(taskId: string, attempt: number): void {
    if (this.#pumpFailure && !this.#recoveryInProgress) {
      this.#schedulerStage("enqueue_blocked", { task_id: taskId, attempt, reason: this.#pumpFailure.reason });
      return;
    }
    const key = queueKey(taskId, attempt);
    if (this.#queued.has(key) || this.#activeRuns.has(key)) {
      this.#schedulerStage("enqueue_duplicate", { task_id: taskId, attempt, queue_depth: this.#queue.length });
      return;
    }
    this.#queued.add(key);
    this.#queue.push({ taskId, attempt });
    this.#schedulerStage("enqueue", { task_id: taskId, attempt, queue_depth: this.#queue.length });
    this.#schedulePump();
  }

  #schedulePump(): void {
    if (this.#closed || this.#shuttingDown || !this.#recoveryComplete || this.#pumpFailure || this.#pumpPending || this.#queue.length === 0) {
      this.#schedulerStage("schedule_skipped", { closed: this.#closed, recovery_complete: this.#recoveryComplete,
        pump_failure: this.#pumpFailure?.reason ?? null, pump_pending: this.#pumpPending, active: this.#active, queue_depth: this.#queue.length });
      return;
    }
    const fenceReason = this.#spawnFenceReason();
    if (fenceReason !== null) {
      // Lease ownership is unknown (P1 §3.2): no new Spawn may leave this
      // Manager through any timer or recovery path. Queued Attempts stay
      // durable; a future lease owner re-collects them.
      this.#schedulerStage("schedule_fenced", { reason: fenceReason, queue_depth: this.#queue.length });
      return;
    }
    if (this.#pumpRetryTimer || this.#workspaceRetryTimer) {
      this.#schedulerStage("schedule_waiting_for_capacity", { retry_ms: this.#capacityRetryMs, queue_depth: this.#queue.length });
      return;
    }
    this.#pumpPending = true;
    this.#schedulerStage("schedule", { active: this.#active, queue_depth: this.#queue.length });
    queueMicrotask(() => {
      this.#pumpPending = false;
      this.#schedulerStage("scheduled_callback", { active: this.#active, queue_depth: this.#queue.length });
      const running = this.#pump();
      this.#pumpPromises.add(running);
      void running.catch((error: unknown) => {
        const reason = errorCode(error) ?? "dispatch_failed";
        this.#pumpFailure = { taskId: "unknown", reason };
        this.#schedulePumpFailureRecovery(reason);
      }).finally(() => {
        this.#pumpPromises.delete(running);
      });
    });
  }

  #schedulePumpFailureRecovery(reason: string): void {
    if (this.#closed || this.#shuttingDown || this.#pumpFailureRetryTimer) return;
    this.#schedulerStage("pump_failure_recovery_scheduled", {
      reason,
      retry_ms: PUMP_FAILURE_RECOVERY_RETRY_MS,
    });
    this.#pumpFailureRetryTimer = setTimeout(() => {
      this.#pumpFailureRetryTimer = null;
      if (this.#closed || this.#shuttingDown) return;
      this.#schedulerStage("pump_failure_recovery_started", { reason });
      void this.recoverTasks().then(() => {
        this.#schedulerStage("pump_failure_recovery_complete", { reason });
      }).catch((error: unknown) => {
        // Recovery remains latched after this single automatic attempt. A
        // repeated failure must not create an unbounded background retry loop.
        this.#schedulerStage("pump_failure_recovery_failed", {
          reason,
          recovery_error: errorCode(error) ?? "recovery_failed",
        });
      });
    }, PUMP_FAILURE_RECOVERY_RETRY_MS);
    this.#pumpFailureRetryTimer.unref?.();
  }

  #scheduleWorkspaceRetry(): void {
    if (this.#closed || this.#shuttingDown || !this.#recoveryComplete || this.#pumpFailure || this.#queue.length === 0) return;
    if (this.#workspaceRetryTimer) return;
    this.#workspaceRetryTimer = setTimeout(() => {
      this.#workspaceRetryTimer = null;
      this.#schedulePump();
    }, 1_000);
    this.#workspaceRetryTimer.unref?.();
  }

  #activeExecutionPaths(excludeOperationId?: string): readonly string[] {
    const snapshot = this.#validateRecoverySnapshot(this.#driver.readRecoverySnapshot());
    return snapshot.operations.flatMap((value) => {
      const operation = asRecord(value);
      return operation.operation_id !== excludeOperationId && operation.capacity_occupied === true && typeof operation.workspace_ref === "string"
        ? [operation.workspace_ref]
        : [];
    });
  }

  async #pump(): Promise<void> {
    if (this.#closed || this.#shuttingDown) {
      this.#schedulerStage("pump_skipped", { closed: this.#closed, shutting_down: this.#shuttingDown, active: this.#active, queue_depth: this.#queue.length });
      return;
    }
    const initialFence = this.#spawnFenceReason();
    if (initialFence !== null) {
      this.#schedulerStage("pump_fenced", { reason: initialFence, queue_depth: this.#queue.length });
      return;
    }
    this.#active += 1;
    this.#schedulerStage("pump_started", { queue_depth: this.#queue.length });
    let capacityBlocked = false;
    const deferredByWorkspace: Array<{ taskId: string; attempt: number }> = [];
    try {
      while (!this.#closed && !this.#shuttingDown && this.#queue.length > 0) {
        const next = this.#queue.shift()!;
        const nextKey = queueKey(next.taskId, next.attempt);
        this.#schedulerStage("dispatch_dequeued", { task_id: next.taskId, attempt: next.attempt, queue_depth: this.#queue.length });
        this.#queued.delete(nextKey);
        let snapshot: TaskSnapshot;
        try { snapshot = this.#readSnapshot(next.taskId); } catch { continue; }
        if (snapshot.projection.status !== "queued" || Number(snapshot.attempt.attempt) !== next.attempt) continue;
        const operationId = operationIdFor(next.taskId, next.attempt);
        const executionPath = taskExecutionPath(snapshot.task);
        const workspaceConflict = [...this.#activeExecutionPaths(operationId), ...this.#dispatchingPaths]
          .find((occupiedPath) => executionPathsOverlap(occupiedPath, executionPath));
        if (workspaceConflict) {
          this.#schedulerStage("dispatch_deferred_workspace_occupied", {
            task_id: next.taskId, attempt: next.attempt, execution_path: executionPath, occupied_path: workspaceConflict,
          });
          deferredByWorkspace.push(next);
          this.#queued.add(nextKey);
          continue;
        }
        if (this.#testBeforeDispatch) {
          this.#awaitingDispatchPrerequisite = true;
          try { await this.#testBeforeDispatch(); }
          finally { this.#awaitingDispatchPrerequisite = false; }
        }
        // Shutdown may occur while a gate or future dispatch prerequisite is
        // pending. The durable queued Attempt remains authoritative; never
        // start a Worker after this Manager has closed its SQLite handle.
        if (this.#closed || this.#shuttingDown) break;
        const dispatchFenceReason = this.#spawnFenceReason();
        if (dispatchFenceReason !== null) {
          this.#schedulerStage("dispatch_fenced", { task_id: next.taskId, attempt: next.attempt, reason: dispatchFenceReason });
          this.#queue.unshift(next);
          this.#queued.add(nextKey);
          break;
        }
        const dispatchPathKey = normalizeExecutionPath(executionPath);
        this.#dispatchingPaths.add(dispatchPathKey);
        const runPromise = this.#driver.run({
          task: snapshot.task as CandidateTaskPackage,
          operationId,
          launchId: `launch-${operationId}`,
          launchToken: randomBytes(32).toString("base64url"),
          attempt: next.attempt,
          continuation: snapshot.continuation,
          previousResult: snapshot.continuation?.previous_operation_id
            ? this.#driver.readCommittedResult(String(snapshot.continuation.previous_operation_id))?.result ?? null
            : null,
        });
        this.#activeRuns.set(nextKey, runPromise);
        let run: ClaimOnlyRunResult;
        try { run = await runPromise; }
        finally {
          if (this.#activeRuns.get(nextKey) === runPromise) this.#activeRuns.delete(nextKey);
          this.#dispatchingPaths.delete(dispatchPathKey);
        }
        this.#schedulerStage("driver_run_returned", { task_id: next.taskId, attempt: next.attempt, state: run.state, queue_depth: this.#queue.length });
        await this.#recoverAfterRun(next, run);
        const after = this.#readSnapshot(next.taskId);
        await this.#notifyOperationReleased(after);
        if (after.projection.status === "queued" && after.operation === null && run.reason === "capacity_exhausted") {
          // Capacity failure occurs before Operation creation or Spawn. Keep
          // the persisted Attempt queued and retry only with bounded backoff.
          this.#queue.unshift(next);
          this.#queued.add(queueKey(next.taskId, next.attempt));
          capacityBlocked = true;
          this.#capacityRetryMs = Math.min(this.#capacityRetryMs * 2, 2_000);
          break;
        }
        if (after.projection.status === "queued" && after.operation === null && run.reason === "workspace_already_occupied") {
          // A different Bridge Manager may have won the SQLite admission race
          // after this Manager's snapshot. Keep the Attempt queued and retry
          // after a bounded delay; the transactional workspace fence prevents
          // a second Worker from entering during that window.
          deferredByWorkspace.push(next);
          this.#queued.add(queueKey(next.taskId, next.attempt));
          this.#schedulerStage("dispatch_deferred_workspace_admission_race", {
            task_id: next.taskId, attempt: next.attempt, reason: run.reason,
          });
          continue;
        }
        this.#capacityRetryMs = 100;
        if (after.operation?.phase === "released") continue;
        if (after.operation && after.operation.phase !== "released" && after.operation.phase !== "cancelled_before_launch") break;
      }
      for (const item of deferredByWorkspace.reverse()) {
        this.#queue.unshift(item);
      }
    } finally {
      this.#active = Math.max(0, this.#active - 1);
      this.#schedulerStage("pump_finished", { queue_depth: this.#queue.length, pump_failure: this.#pumpFailure?.reason ?? null });
      if (capacityBlocked && !this.#closed && !this.#pumpFailure && this.#queue.length > 0) {
        this.#pumpRetryTimer = setTimeout(() => {
          this.#pumpRetryTimer = null;
          this.#schedulePump();
        }, this.#capacityRetryMs);
        this.#pumpRetryTimer.unref?.();
      } else if (deferredByWorkspace.length > 0 && !this.#closed && !this.#pumpFailure && this.#queue.length > 0) {
        this.#scheduleWorkspaceRetry();
      } else this.#schedulePump();
    }
  }

  async #recoverAfterRun(item: { readonly taskId: string; readonly attempt: number }, run: ClaimOnlyRunResult): Promise<void> {
    let snapshot: TaskSnapshot;
    try { snapshot = this.#readSnapshot(item.taskId); }
    catch { return; }
    if (Number(snapshot.attempt.attempt) !== item.attempt || !snapshot.operation) return;
    const operation = snapshot.operation;
    const phase = String(operation.phase);
    const operationId = String(operation.operation_id);
    // `result_rejected` means this run produced no committed Result. The
    // Recovery Driver still has to prove the exact Worker exited and that the
    // recorded tree is clean, so a missing close code cannot authorize a
    // second Writer by itself. `result_outcome_unknown` is different: a commit
    // acknowledgement may have been lost, so it is never retried automatically.
    const workerCanBeRecoveredWithoutResult = run.state === "result_rejected"
      || (run.state === "result_outcome_unknown" && run.workerExitCode !== null);
    const interruptible = snapshot.projection.status === "running"
      && phase === "running" && operation.result_digest === null
      && workerCanBeRecoveredWithoutResult
      && !this.#isAutomaticRecoveryAttempt(item.taskId, item.attempt);
    const cleanupRecoverable = ["result_committed", "cleanup_pending", "cleanup_unverified", "cleanup_verified"].includes(phase);
    if (!interruptible && !cleanupRecoverable) {
      if (phase === "running" && operation.result_digest === null && workerCanBeRecoveredWithoutResult) {
        this.#schedulerStage("post_run_recovery_held", {
          task_id: item.taskId, attempt: item.attempt, operation_id: operationId,
          reason: "automatic_recovery_requeue_budget_exhausted",
        });
      }
      return;
    }
    try {
      const outcome = asRecord(await this.#driver.recoverOperation(operationId, {
        stopAliveWorker: false,
        allowInterruptRequeue: interruptible,
        ...(interruptible ? { interruptionReason: "worker_exited_without_result" as const } : {}),
      }));
      this.#schedulerStage("post_run_recovery_classified", {
        task_id: item.taskId, attempt: item.attempt, operation_id: operationId,
        state: outcome.state ?? "unknown", reason: outcome.reason ?? null,
      });
      if (outcome.state === "requeued" && typeof outcome.task_id === "string"
        && Number.isSafeInteger(outcome.attempt) && Number(outcome.attempt) > 0) {
        this.#enqueue(outcome.task_id, Number(outcome.attempt));
      } else if (outcome.state !== "complete" && outcome.state !== "released") {
        this.#schedulerStage("post_run_recovery_workspace_scoped", {
          task_id: item.taskId, attempt: item.attempt, operation_id: operationId,
          reason: outcome.reason ?? "recovery_evidence_unknown",
        });
      }
    } catch (error) {
      this.#schedulerStage("post_run_recovery_failed", {
        task_id: item.taskId, attempt: item.attempt, operation_id: operationId,
        reason: errorCode(error) ?? "post_run_recovery_failed",
      });
    }
  }

  async #notifyOperationReleased(snapshot: TaskSnapshot): Promise<void> {
    if (!this.#onOperationReleased) return;
    const operation = snapshot.operation;
    const result = snapshot.result;
    if (!operation || !result || result.status === "cancelled" || String(operation.phase) !== "released"
      || typeof operation.result_digest !== "string" || typeof operation.result_commit_ref !== "string") return;
    const attempt = Number(snapshot.attempt.attempt);
    const generation = Number(operation.generation);
    if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(generation) || generation < 1) return;
    const ownerBinding = taskOwnerBinding(snapshot.owner_binding);
    const fact: ExecutorWakeReleaseFact = {
      task_id: String(operation.task_id),
      attempt,
      operation_id: String(operation.operation_id),
      generation,
      task_status: taskStatus(snapshot.projection.status),
      result_status: result.status,
      result_digest: operation.result_digest,
      result_commit_ref: operation.result_commit_ref,
      workspace: snapshot.task.workspace,
      owner_thread_id: ownerBinding.owner_thread_id,
      owner_binding_state: ownerBinding.state,
    };
    try {
      await this.#onOperationReleased(fact, (input) => this.recordExecutorWakeObservation(input));
    } catch (error) {
      this.#schedulerStage("post_release_wake_failed", {
        task_id: fact.task_id,
        attempt: fact.attempt,
        operation_id: fact.operation_id,
        reason: errorCode(error) ?? "executor_wake_failed",
      });
    }
  }

  /** P1 §3.3: restart-safe Release→Wake recovery. Selects released operations
   * with a committed Result and zero executor_wake observations, and re-runs
   * the single notification hook for each. The Wake coordinator and the
   * observation state machine remain the dedup authority: an operation with
   * any recorded wake fact (intent, queued, submission_unknown, turn_started,
   * web_notify) is deliberately skipped so recovery never duplicates a Queue
   * submission whose acknowledgement outcome is unknown. */
  async #recoverUnnotifiedReleases(snapshot: {
    readonly operations: readonly unknown[];
    readonly events: readonly unknown[];
    readonly taskProjections: readonly unknown[];
  }): Promise<void> {
    if (!this.#onOperationReleased) return;
    const wakeNotified = new Set<string>();
    for (const value of snapshot.events) {
      const event = asRecord(value);
      if (String(event.event_type) !== "observation_recorded" || typeof event.operation_id !== "string") continue;
      try {
    const evidence = parseBoundedRecord(event.evidence_json, "SQLite Wake evidence is invalid");
        if (evidence.reason === "executor_wake") wakeNotified.add(event.operation_id);
      } catch {
        // Malformed evidence cannot prove a prior notification; the operation
        // stays selected and the fresh notification records new facts.
      }
    }
    const taskProjectionByTaskId = new Map<string, Record<string, unknown>>();
    for (const value of snapshot.taskProjections) {
      const projection = asRecord(value);
      if (typeof projection.task_id === "string") taskProjectionByTaskId.set(projection.task_id, projection);
    }
    for (const value of snapshot.operations) {
      const operation = asRecord(value);
      const operationId = operation.operation_id;
      if (typeof operationId !== "string" || String(operation.phase) !== "released"
        || wakeNotified.has(operationId)) continue;
      if (typeof operation.result_digest !== "string" || typeof operation.result_commit_ref !== "string") continue;
      if (String(operation.result_status) === "cancelled") continue;
      const taskId = operation.task_id;
      const attempt = Number(operation.attempt);
      const generation = Number(operation.generation);
      const projection = typeof taskId === "string" ? taskProjectionByTaskId.get(taskId) : undefined;
      const workspace = typeof projection?.workspace === "string" ? projection.workspace : null;
      if (typeof taskId !== "string" || !Number.isSafeInteger(attempt) || attempt < 1
        || !Number.isSafeInteger(generation) || generation < 1 || !workspace) continue;
      const ownerBinding = taskOwnerBinding(projection?.owner_binding);
      const fact: ExecutorWakeReleaseFact = {
        task_id: taskId,
        attempt,
        operation_id: operationId,
        generation,
        task_status: taskStatus(projection!.status),
        result_status: String(operation.result_status) as ExecutorWakeReleaseFact["result_status"],
        result_digest: operation.result_digest,
        result_commit_ref: operation.result_commit_ref,
        workspace,
        owner_thread_id: ownerBinding.owner_thread_id,
        owner_binding_state: ownerBinding.state,
      };
      this.#schedulerStage("release_wake_recovery_selected", {
        task_id: taskId, attempt, operation_id: operationId,
      });
      try {
        await this.#onOperationReleased(fact, (input) => this.recordExecutorWakeObservation(input));
      } catch (error) {
        this.#schedulerStage("release_wake_recovery_failed", {
          task_id: taskId, attempt, operation_id: operationId,
          reason: errorCode(error) ?? "executor_wake_failed",
        });
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new TaskManagerError("TASK_STATE", "SQLite lifecycle authority is closed");
  }

  #assertAccepting(): void {
    if (this.#shuttingDown) throw new TaskManagerError("TASK_STATE", "SQLite lifecycle authority is shutting down and no new task lifecycle mutation is accepted");
  }

  #assertRecoveryReady(): void {
    if (this.#recoveryBlocked) throw new TaskManagerError("TASK_STATE", `SQLite lifecycle authority is blocked by Recovery: ${this.#recoveryBlocked}`);
  }

  #schedulerStage(stage: string, detail: Readonly<Record<string, unknown>>): void {
    this.#testOnScheduler?.(stage, detail);
  }
}

function consoleTaskListItem(value: unknown): ConsoleTaskListItem {
  const raw = asRecord(value);
  const task = asRecord(raw.task) as unknown as TaskPackage;
  const projection = asRecord(raw.projection);
  const currentAttemptNumber = Number(projection.current_attempt);
  const current = consoleAttemptProjection(raw.current, task, currentAttemptNumber);
  const attentionReasons = consoleAttentionReasons(taskStatus(projection.status), current);
  return {
    task_id: string(projection.task_id, "console_task_id_missing"),
    name: clipText(task.objective, 160),
    status: taskStatus(projection.status),
    attempt: currentAttemptNumber,
    created_at: string(projection.created_at, "console_task_created_at_missing"),
    updated_at: consoleIsoTime(raw.updated_at, string(projection.created_at, "console_task_created_at_missing")),
    workspace: task.workspace,
    objective: task.objective,
    owner_binding: taskOwnerBinding(raw.owner_binding),
    ...(current.wake ? {
      wake: current.wake,
    } : {}),
    model: current.model,
    plan: current.plan,
    usage: current.usage,
    discount: current.discount,
    cleanup: current.cleanup,
    release: current.release,
    needs_attention: attentionReasons.length > 0,
    attention_reasons: attentionReasons,
    action_capabilities: resolveConsoleActionCapabilities(current),
  };
}

function consoleTaskDetail(value: unknown): ConsoleTaskDetail {
  const raw = asRecord(value);
  const item = consoleTaskListItem(raw);
  const task = asRecord(raw.task) as unknown as TaskPackage;
  const attempts = Array.isArray(raw.attempts) ? raw.attempts : [];
  const currentAttempt = attempts
    .map((attempt) => consoleAttemptProjection(attempt, task, item.attempt))
    .find((attempt) => attempt.current);
  return {
    ...item,
    task,
    attempts: attempts.map((attempt) => consoleAttemptProjection(attempt, task, item.attempt)),
    master_usage: {
      state: "not_observed",
      reason_code: "bridge_authority_does_not_record_master_usage",
    },
    result_submission_error: currentAttempt
      ? resultSubmissionErrorFromRaw(raw.current)
      : null,
  };
}

function consoleAttemptProjection(
  value: unknown,
  task: TaskPackage,
  currentAttempt: number,
): ConsoleTaskAttemptProjection {
  const raw = asRecord(value);
  const attempt = Number(raw.attempt);
  const status = taskStatus(raw.status);
  const operation = raw.operation ? asRecord(raw.operation) : null;
  const operationPhase = operation && typeof operation.phase === "string" ? operation.phase : null;
  const result = raw.result && typeof raw.result === "object" && !Array.isArray(raw.result)
    ? asRecord(raw.result)
    : null;
  const model = consoleModelProjection(task, result);
  const plan = consolePlanProjection(model);
  const pendingRequests = stringArray(raw.pending_requests, 128);
  const replyOutcomeUnknownRequests = stringArray(raw.reply_outcome_unknown_requests, 128);
  return {
    attempt,
    status,
    created_at: string(raw.created_at, "console_attempt_created_at_missing"),
    updated_at: consoleIsoTime(raw.updated_at, string(raw.created_at, "console_attempt_created_at_missing")),
    current: attempt === currentAttempt,
    operation_phase: operationPhase,
    model,
    plan,
    usage: consoleUsageProjection(result),
    discount: consoleDiscountProjection(plan),
    result: consoleResultProjection(result),
    wake: consoleWakeProjection(raw.wake),
    cleanup: consoleCleanupProjection(operation),
    release: consoleReleaseProjection(operation),
    hold: consoleHoldProjection(raw.hold, operation),
    pending_requests: pendingRequests,
    reply_outcome_unknown_requests: replyOutcomeUnknownRequests,
  };
}

function consoleModelProjection(
  task: TaskPackage,
  result: Record<string, unknown> | null,
): ConsoleTaskModelProjection {
  const runtimeModel = result?.model && typeof result.model === "object" && !Array.isArray(result.model)
    ? asRecord(result.model)
    : null;
  if (runtimeModel && typeof runtimeModel.provider_id === "string" && runtimeModel.provider_id
    && typeof runtimeModel.model_id === "string" && runtimeModel.model_id) {
    const runtimeEffort = typeof runtimeModel.effective_reasoning_level === "string"
      && runtimeModel.effective_reasoning_level
      ? runtimeModel.effective_reasoning_level
      : null;
    const requestedEffort = typeof runtimeModel.requested_reasoning_level === "string"
      && runtimeModel.requested_reasoning_level
      ? runtimeModel.requested_reasoning_level
      : null;
    return {
      state: "observed",
      provider_id: runtimeModel.provider_id,
      model_id: runtimeModel.model_id,
      source: "runtime",
      effort: runtimeEffort
        ? { state: "observed", value: runtimeEffort, source: "runtime" }
        : requestedEffort
          ? { state: "requested", value: requestedEffort, source: "runtime" }
          : { state: "not_observed", value: null, source: "none" },
    };
  }
  const requested = task.model;
  if (requested?.provider_id && requested.model_id) {
    return {
      state: "requested",
      provider_id: requested.provider_id,
      model_id: requested.model_id,
      source: "task_request",
      effort: requested.reasoning_level
        ? { state: "requested", value: requested.reasoning_level, source: "task_request" }
        : { state: "not_observed", value: null, source: "none" },
    };
  }
  if (runtimeModel && typeof runtimeModel.requested_model === "string" && runtimeModel.requested_model) {
    const requestedEffort = typeof runtimeModel.requested_reasoning_level === "string"
      && runtimeModel.requested_reasoning_level
      ? runtimeModel.requested_reasoning_level
      : null;
    return {
      state: "requested",
      provider_id: null,
      model_id: runtimeModel.requested_model,
      source: "runtime",
      effort: requestedEffort
        ? { state: "requested", value: requestedEffort, source: "runtime" }
        : { state: "not_observed", value: null, source: "none" },
    };
  }
  return {
    state: "not_observed",
    provider_id: null,
    model_id: null,
    source: "none",
    effort: { state: "not_observed", value: null, source: "none" },
  };
}

function consolePlanProjection(model: ConsoleTaskModelProjection): ConsoleTaskPlanProjection {
  const providerId = model.provider_id;
  const source = model.state === "observed"
    ? "runtime"
    : model.state === "requested"
      ? model.source === "runtime" ? "runtime" : "task_request"
      : "none";
  if (providerId === BIGMODEL_START_PLAN_PROVIDER_ID) {
    return { kind: "start_plan", provider_id: providerId, source };
  }
  if (isOfficialCodingPlanProvider(providerId ?? undefined)) {
    return { kind: "coding_plan", provider_id: providerId, source };
  }
  if (providerId) return { kind: "other", provider_id: providerId, source };
  return { kind: "not_observed", provider_id: null, source: "none" };
}

function consoleUsageProjection(result: Record<string, unknown> | null): ConsoleTaskUsageProjection {
  const usage = result?.usage && typeof result.usage === "object" && !Array.isArray(result.usage)
    ? asRecord(result.usage)
    : null;
  if (!usage) {
    return {
      state: "not_observed",
      source: null,
      scope: null,
      observed_at: null,
      finality: null,
      input_tokens: null,
      cached_input_tokens: null,
      cached_write_input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      total_tokens: null,
      conflicts: [],
      provider_cost: consoleProviderCostProjection(),
    };
  }
  const finality = usage.finality === "reported" || usage.finality === "derived" || usage.finality === "partial"
    ? usage.finality
    : null;
  return {
    state: "observed",
    source: nullableString(usage.source),
    scope: nullableString(usage.scope),
    observed_at: nullableString(usage.observed_at),
    finality,
    input_tokens: nullableNonNegativeInteger(usage.input_tokens),
    cached_input_tokens: nullableNonNegativeInteger(usage.cached_input_tokens),
    cached_write_input_tokens: nullableNonNegativeInteger(usage.cached_write_input_tokens),
    output_tokens: nullableNonNegativeInteger(usage.output_tokens),
    reasoning_tokens: nullableNonNegativeInteger(usage.reasoning_tokens),
    total_tokens: nullableNonNegativeInteger(usage.total_tokens),
    conflicts: stringArray(usage.conflicts, 64),
    provider_cost: consoleProviderCostProjection(),
  };
}

function consoleProviderCostProjection() {
  return {
    state: "not_observed" as const,
    scope: "per_attempt" as const,
    amount: null,
    currency: null,
    reason_code: "bridge_authority_has_no_provider_settlement" as const,
  };
}

function consoleDiscountProjection(plan: ConsoleTaskPlanProjection): ConsoleTaskDiscountProjection {
  if (plan.kind === "start_plan") {
    return {
      state: "not_applicable",
      source: "provider_kind",
      reason_code: "start_plan_coding_discount_not_applicable",
    };
  }
  if (plan.kind === "coding_plan") {
    return {
      state: "not_observed",
      source: "per_attempt_settlement",
      reason_code: "no_per_attempt_settlement_evidence",
    };
  }
  return {
    state: "not_observed",
    source: "none",
    reason_code: "provider_settlement_not_observed",
  };
}

function consoleResultProjection(result: Record<string, unknown> | null): ConsoleTaskResultProjection | null {
  if (!result) return null;
  const status = result.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled" && status !== "waiting_for_master") {
    throw new TaskManagerError("TASK_STATE", "SQLite Result has an unknown status");
  }
  const tests = Array.isArray(result.tests)
    ? result.tests.slice(0, 50).map((value): ConsoleTaskResultProjection["tests"][number] => {
      const test = asRecord(value);
      const testStatus = test.status === "passed" || test.status === "failed" || test.status === "not_run"
        ? test.status
        : "not_run";
      return {
        command: clipText(typeof test.command === "string" ? test.command : "", 1000),
        status: testStatus,
        details: typeof test.details === "string" ? clipText(test.details, 2000) : null,
      };
    })
    : [];
  return {
    status,
    summary: clipText(typeof result.summary === "string" ? result.summary : "", 4000),
    error_code: typeof result.error_code === "string" ? result.error_code : null,
    issues: stringArray(result.issues, 50).map((issue) => clipText(issue, 2000)),
    files_changed: stringArray(result.files_changed, 100).map((file) => clipText(file, 1000)),
    tests,
    needs_master_decision: result.needs_master_decision === true,
    started_at: nullableString(result.started_at),
    finished_at: nullableString(result.finished_at),
  };
}

function consoleWakeProjection(value: unknown): ConsoleTaskWakeProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const wake = asRecord(value);
  if (typeof wake.state !== "string"
    || !["intent", "queued", "submission_unknown", "turn_started", "web_notify"].includes(wake.state)
    || typeof wake.reason_code !== "string" || typeof wake.at !== "string") return null;
  return {
    state: wake.state as ConsoleTaskWakeProjection["state"],
    reason_code: clipText(wake.reason_code, 256),
    at: wake.at,
  };
}

function consoleCleanupProjection(operation: Record<string, unknown> | null): ConsoleTaskCleanupProjection {
  const phase = operation && typeof operation.phase === "string" ? operation.phase : null;
  if (phase === "cancelled_before_launch") return { state: "not_required", reason_code: phase };
  if (phase === "cleanup_pending") return { state: "pending", reason_code: phase };
  if (phase === "cleanup_verified" || phase === "cleanup_reverified") return { state: "verified", reason_code: phase };
  if (phase === "cleanup_unverified" || phase === "quarantined" || phase === "admin_abandoned") {
    return { state: "unverified", reason_code: phase };
  }
  if (phase === "released") {
    if (operation?.cleanup_verified === true) return { state: "verified", reason_code: phase };
    if (operation?.administrative_release === true) return { state: "unverified", reason_code: "administrative_release" };
    return { state: "unknown", reason_code: phase };
  }
  if (phase === null) return { state: "not_started", reason_code: null };
  return { state: "not_started", reason_code: phase };
}

function consoleReleaseProjection(operation: Record<string, unknown> | null): ConsoleTaskReleaseProjection {
  const phase = operation && typeof operation.phase === "string" ? operation.phase : null;
  if (phase === "released") {
    const verified = operation?.cleanup_verified === true
      ? true
      : operation?.administrative_release === true ? false : null;
    return {
      state: "released",
      cleanup_verified: verified,
      reason_code: verified === false ? "administrative_release_unverified" : "released",
    };
  }
  if (phase && ["result_committed", "cleanup_pending", "cleanup_unverified", "cleanup_verified", "cleanup_reverified", "quarantined"].includes(phase)) {
    return { state: "held", cleanup_verified: null, reason_code: phase };
  }
  return { state: "not_released", cleanup_verified: null, reason_code: phase };
}

function consoleHoldProjection(
  value: unknown,
  operation: Record<string, unknown> | null,
): ConsoleTaskHoldProjection {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const hold = asRecord(value);
    if (typeof hold.reason_code === "string") {
      return {
        active: true,
        reason_code: hold.reason_code,
        at: nullableString(hold.at),
      };
    }
  }
  const phase = operation && typeof operation.phase === "string" ? operation.phase : null;
  if (phase === "cleanup_unverified") {
    return { active: true, reason_code: "cleanup_unverified", at: null };
  }
  if (phase === "quarantined") {
    return { active: true, reason_code: "recovery_quarantine", at: null };
  }
  if (phase === "admin_abandoned") {
    return { active: true, reason_code: "administrative_release_unverified", at: null };
  }
  return { active: false, reason_code: null, at: null };
}

function consoleAttentionReasons(status: TaskStatus, current: ConsoleTaskAttemptProjection): string[] {
  const reasons = new Set<string>();
  if (current.pending_requests.length > 0) reasons.add("pending_interaction");
  if (current.reply_outcome_unknown_requests.length > 0) reasons.add("interaction_reply_outcome_unknown");
  if (current.cleanup.state === "pending") reasons.add("cleanup_pending");
  if (current.cleanup.state === "unverified") reasons.add("cleanup_unverified");
  if (current.hold.active && current.hold.reason_code) reasons.add(`hold:${current.hold.reason_code}`);
  if (status === "waiting_for_master") reasons.add("waiting_for_master");
  if (current.result?.needs_master_decision) reasons.add("needs_master_decision");
  if (status === "failed") reasons.add("task_failed");
  if (current.wake?.state === "submission_unknown") reasons.add("wake_submission_unknown");
  if (current.wake?.state === "web_notify") reasons.add("wake_web_notify");
  return [...reasons];
}

function consoleTaskBucket(task: ConsoleTaskListItem): ConsoleTaskBucket {
  if (task.needs_attention) return "attention";
  if (task.status === "queued" || task.status === "running") return "running";
  return "completed";
}

function resultSubmissionErrorFromRaw(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = asRecord(value);
  return typeof raw.result_submission_error === "string" ? raw.result_submission_error : null;
}

function consoleIsoTime(value: unknown, fallback: string): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").slice(0, limit);
}

function clipText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

interface TaskSnapshot {
  readonly task: TaskPackage;
  readonly projection: Record<string, unknown>;
  readonly owner_binding?: unknown;
  readonly attempt: Record<string, unknown>;
  readonly operation: Record<string, unknown> | null;
  readonly result: TaskResult | null;
  readonly continuation: Record<string, unknown> | null;
}

function validateTaskPackage(task: TaskPackage): void {
  const worktreePath: unknown = task.worktree_path;
  if (!task || typeof task.task_id !== "string" || !task.task_id.trim() || task.task_id.length > 128
    || typeof task.workspace !== "string" || !task.workspace.trim() || !pathIsAbsolute(task.workspace)
    || (worktreePath !== undefined
      && (typeof worktreePath !== "string" || !worktreePath.trim() || !pathIsAbsolute(worktreePath)))
    || typeof task.objective !== "string" || !task.objective.trim()
    || !Array.isArray(task.requirements) || !Array.isArray(task.allowed_paths) || !Array.isArray(task.forbidden_paths)
    || !Array.isArray(task.acceptance_criteria) || !Array.isArray(task.test_commands)) {
    throw new TaskManagerError("TASK_INVALID", "invalid SQLite TaskPackage");
  }
}

function pathIsAbsolute(value: string): boolean {
  return process.platform === "win32" ? /^[A-Za-z]:[\\/]/u.test(value) : value.startsWith("/");
}

function taskStatus(value: unknown): TaskStatus {
  if (typeof value !== "string" || !["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"].includes(value)) {
    throw new TaskManagerError("TASK_STATE", "SQLite Task projection has an unknown status");
  }
  return value as TaskStatus;
}

function taskListWakeSummary(
  evidenceJson: unknown,
  at: unknown,
): { readonly wake: TaskListWakeSummary } | null {
  if (typeof evidenceJson !== "string" || typeof at !== "string"
    || !Number.isFinite(Date.parse(at))) return null;
  try {
    const evidence = asRecord(JSON.parse(evidenceJson));
    if (evidence.reason !== "executor_wake"
      || typeof evidence.state !== "string"
      || !["intent", "queued", "submission_unknown", "turn_started", "web_notify"].includes(evidence.state)
      || typeof evidence.reason_code !== "string"
      || evidence.reason_code.length === 0
      || evidence.reason_code.length > 256) return null;
    return {
      wake: {
        state: evidence.state as TaskListWakeSummary["state"],
        reason_code: evidence.reason_code,
        at,
      },
    };
  } catch {
    return null;
  }
}

function receipt(taskId: string, status: unknown, createdAt: unknown, ownerBinding?: TaskOwnerBinding): TaskReceipt {
  return {
    task_id: taskId,
    status: status === "running" ? "running" : "queued",
    created_at: string(createdAt, "task_created_at_missing"),
    ...(ownerBinding ? { owner_binding: ownerBinding } : {}),
  };
}

function taskOwnerBinding(value: unknown): TaskOwnerBinding {
  const binding = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const state = binding.state === "bound" ? "bound" : "unavailable";
  const source = ["mcp_meta", "mcp_meta_missing", "mcp_meta_invalid", "non_host_admission", "legacy_unavailable"].includes(String(binding.source))
    ? String(binding.source) as TaskOwnerBinding["source"]
    : "legacy_unavailable";
  return {
    task_id: String(binding.task_id ?? ""),
    state,
    owner_thread_id: state === "bound" && typeof binding.owner_thread_id === "string"
      ? binding.owner_thread_id : null,
    source,
    bound_at: typeof binding.bound_at === "string" ? binding.bound_at : null,
    reason_code: state === "unavailable" ? "owner_thread_unavailable" : null,
  };
}

function toProgressEvent(value: Record<string, unknown>, includeAttempt: boolean): TaskProgressEvent {
  let details: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(string(value.evidence_json, "event_evidence_missing"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
  } catch { throw new TaskManagerError("TASK_STATE", "SQLite lifecycle event evidence is corrupt"); }
  const attempt = includeAttempt ? positiveOrNull(value.operation_attempt) : null;
  const wakeSummary = details?.reason === "executor_wake" && typeof details.state === "string"
    ? `Executor Wake: ${details.state}${typeof details.reason_code === "string" ? ` (${details.reason_code})` : ""}`
    : null;
  return {
    seq: Number(value.cursor ?? value.sequence),
    at: string(value.at, "event_time_missing"),
    type: string(value.event_type, "event_type_missing"),
    summary: typeof value.summary === "string"
      ? value.summary
      : wakeSummary ?? `SQLite lifecycle: ${string(value.event_type, "event_type_missing")}`,
    ...(attempt === null ? {} : { attempt }),
    ...(details ? { details } : {}),
  };
}

/** Merge only adjacent, sanitized model-text rows from the same Operation and
 * Attempt. Every other row is a boundary; page and raw cursor semantics remain
 * owned by the Store. */
export function mergeAdjacentModelOutputRows(
  rows: readonly Record<string, unknown>[],
  maxBytes?: number,
  includeAttempt = false,
): {
  readonly rows: readonly Record<string, unknown>[];
  readonly omittedEvents: number;
  readonly omittedEventsByRow: readonly number[];
} {
  const merged: Record<string, unknown>[] = [];
  const omittedEventsByRow: number[] = [];
  let omittedEvents = 0;
  for (const row of rows) {
    const safeText = row.event_type === "model_output"
      && typeof row.operation_id === "string"
      && Number.isSafeInteger(row.operation_attempt)
      && typeof row.summary === "string"
      && row.summary.length > 0
      && emptyEvidence(row.evidence_json);
    const previous = merged.at(-1);
    const previousText = previous?.event_type === "model_output"
      && previous.operation_id === row.operation_id
      && previous.operation_attempt === row.operation_attempt
      && emptyEvidence(previous.evidence_json);
    const candidate = safeText && previous && previousText
      ? {
          ...previous,
          summary: `${String(previous.summary)}${row.summary}`,
          cursor: row.cursor,
          sequence: row.sequence,
          at: row.at,
        }
      : null;
    const mergeFits = candidate !== null
      && (maxBytes === undefined
        || Buffer.byteLength(canonicalJson(toProgressEvent(candidate, includeAttempt)), "utf8") <= maxBytes);
    if (candidate && mergeFits) {
      merged[merged.length - 1] = candidate;
      omittedEventsByRow[omittedEventsByRow.length - 1] = Number(omittedEventsByRow.at(-1)) + 1;
      omittedEvents += 1;
    } else {
      merged.push({ ...row });
      omittedEventsByRow.push(0);
    }
  }
  return { rows: merged, omittedEvents, omittedEventsByRow };
}

export function applyEventByteBudget(
  events: readonly TaskProgressEvent[],
  pageNextCursor: number,
  maxBytes: number | undefined,
  previousCursor = 0,
  options: { readonly allowOversizedFirstEvent?: boolean } = {},
): { events: TaskProgressEvent[]; nextCursor: number; scanIncomplete: boolean } {
  if (maxBytes === undefined) {
    return { events: [...events], nextCursor: pageNextCursor, scanIncomplete: false };
  }
  let bytes = 0;
  let kept = 0;
  for (const event of events) {
    const size = Buffer.byteLength(canonicalJson(event), "utf8");
    if (kept > 0 && bytes + size > maxBytes) break;
    if (kept === 0 && size > maxBytes) {
      if (!options.allowOversizedFirstEvent) {
        return { events: [], nextCursor: previousCursor, scanIncomplete: true };
      }
      const first = events[0]!;
      const nextCursor = first.seq;
      return {
        events: [first],
        nextCursor,
        scanIncomplete: events.length > 1 || nextCursor < pageNextCursor,
      };
    }
    bytes += size;
    kept += 1;
  }
  if (kept === events.length) {
    return { events: [...events], nextCursor: pageNextCursor, scanIncomplete: false };
  }
  const visible = events.slice(0, kept);
  return {
    events: visible,
    nextCursor: visible.at(-1)?.seq ?? previousCursor,
    scanIncomplete: true,
  };
}

export function resolveEventPageBudget(maxBytes: number | undefined): {
  readonly maxBytes: number;
  readonly allowOversizedFirstEvent: boolean;
} {
  // Explicit callers keep the historical hard-budget behavior. The implicit
  // default may return one oversized event so a large interaction cannot stall
  // cursor progress forever.
  return maxBytes === undefined
    ? { maxBytes: DEFAULT_EVENT_PAGE_MAX_BYTES, allowOversizedFirstEvent: true }
    : { maxBytes, allowOversizedFirstEvent: false };
}

function emptyEvidence(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      && Object.keys(parsed as Record<string, unknown>).length === 0;
  } catch {
    return false;
  }
}

function decodeCursor(value: string, taskId: string): number {
  if (typeof value !== "string" || value.length > 2048) throw new TaskManagerError("TASK_INVALID", "invalid scan_cursor");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    const cursor = asRecord(parsed);
    if (cursor.v !== 1 || cursor.task_id !== taskId || !Number.isSafeInteger(cursor.cursor) || Number(cursor.cursor) < 0) throw new Error("invalid cursor");
    return Number(cursor.cursor);
  } catch { throw new TaskManagerError("TASK_INVALID", "scan_cursor is not valid for this SQLite Task"); }
}

function encodeCursor(taskId: string, cursor: number): string {
  return Buffer.from(JSON.stringify({ v: 1, task_id: taskId, cursor }), "utf8").toString("base64url");
}

function operationIdFor(taskId: string, attempt: number): string {
  const digest = createHash("sha256").update(`${taskId}\0${attempt}`, "utf8").digest("hex").slice(0, 32);
  return `sqlite-${digest}`;
}

function taskExecutionPath(task: TaskPackage): string {
  return task.worktree_path ?? task.workspace;
}

function executionPathsOverlap(left: string, right: string): boolean {
  const leftPath = normalizeExecutionPath(left);
  const rightPath = normalizeExecutionPath(right);
  return leftPath === rightPath || leftPath.startsWith(rightPath + path.sep)
    || rightPath.startsWith(leftPath + path.sep);
}

function normalizeExecutionPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function nonNegativeDuration(now: number, createdAt: string | number): number {
  const created = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
  return Number.isFinite(created) ? Math.max(0, now - created) : 0;
}

function queueKey(taskId: string, attempt: number): string { return `${taskId}\0${attempt}`; }
function isTerminal(status: TaskStatus): boolean { return ["completed", "failed", "cancelled", "waiting_for_master"].includes(status); }
function projectionCreated(snapshot: TaskSnapshot): string {
  return asRecord(snapshot.projection).created_at as string;
}
function canUserAuthorizeUnverifiedRelease(outcome: Record<string, unknown>): boolean {
  // These are historical Cleanup evidence gaps only. An alive Worker or a
  // failed termination is not in this set and must retain occupancy.
  const reason = typeof outcome.reason === "string" ? outcome.reason : "";
  const identityState = typeof outcome.identity_state === "string" ? outcome.identity_state : "";
  const probeReason = typeof outcome.probe_reason === "string" ? outcome.probe_reason : "";
  const disposition = typeof outcome.recovery_disposition === "string" ? outcome.recovery_disposition : "";
  const stopFailure = probeReason === "worker_stop_unverified" || probeReason === "worker_stop_exit_unverified";
  const treeEvidenceBlocks = disposition === "worker_still_alive"
    || disposition === "process_tree_still_live"
    || disposition === "process_tree_not_verified"
    || disposition === "process_tree_probe_timeout"
    || disposition === "process_tree_probe_rejected"
    || outcome.process_tree_scan_clean === false;
  return !stopFailure && !treeEvidenceBlocks
    && identityState === "exited"
    && outcome.process_tree_scan_clean === true
    && outcome.process_tree_root_observed === true
    && (reason === "adapter_cleanup_unverified"
      || reason === "cleanup_incomplete"
      || disposition === "complete_cleanup_closure_unavailable");
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntilDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new TaskManagerError("CANCEL_FAILED", "shutdown_wait_timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TaskManagerError("CANCEL_FAILED", "shutdown_wait_timeout")), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function boundedObservationProbe(probe: ProcessProbe, pid: number, identity: ProcessIdentity): Promise<Awaited<ReturnType<ProcessProbe["probe"]>>[number] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe.probe([{ pid, identity }]).then((values) => values[0] ?? null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EXECUTION_OBSERVATION_PROBE_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskManagerError("TASK_STATE", "invalid SQLite lifecycle projection");
  return value as Record<string, unknown>;
}
function parseRecord(value: unknown): Record<string, unknown> {
  const raw = string(value, "identity_missing");
  if (raw.length > 64 * 1024) throw new TaskManagerError("TASK_STATE", "SQLite Worker identity projection is oversized");
  try { return asRecord(JSON.parse(raw)); }
  catch { throw new TaskManagerError("TASK_STATE", "SQLite Worker identity projection is corrupt"); }
}

function parseBoundedRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "string" || !value || value.length > 64 * 1024) {
    throw new TaskManagerError("TASK_STATE", code);
  }
  try { return asRecord(JSON.parse(value)); }
  catch { throw new TaskManagerError("TASK_STATE", code); }
}
function string(value: unknown, code: string): string {
  if (typeof value !== "string" || !value) throw new TaskManagerError("TASK_STATE", code);
  return value;
}
function positiveOrNull(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null; }
function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error) || typeof (error as { code?: unknown }).code !== "string") return null;
  return (error as { code: string }).code;
}
