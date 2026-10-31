import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ContinueTaskInput,
  GetEventsInput,
  ProgressTaskManager,
  TaskFeedbackSnapshotV01,
  TaskPackage,
  TaskProgressEvent,
  TaskProgressPage,
  TaskReceipt,
  TaskResult,
  TaskStatus,
  TaskStatusRecord,
  ExecutionObservation,
  ZCodeInteractionReplyInput,
} from "../interfaces.js";
import type { ClaimOnlyDriverOptions, CandidateTaskPackage, ClaimOnlyRunResult } from "../store/lifecycle-gate.js";
import { openClaimOnlyDriver } from "../store/lifecycle-gate.js";
import { TaskManagerError } from "./errors.js";
import { createPlatformProbe, PROCESS_IDENTITY_VERSION, type ProcessIdentity, type ProcessProbe } from "../runtime/process-probe.js";

const EXECUTION_OBSERVATION_PROBE_BUDGET_MS = 5_000;
const DEFAULT_HOST_SHUTDOWN_WAIT_MS = 60_000;

type Driver = Awaited<ReturnType<typeof openClaimOnlyDriver>>;
type SqliteAuthorityOptions = ClaimOnlyDriverOptions & {
  readonly testBeforeDispatch?: () => Promise<void>;
  readonly testOnScheduler?: (stage: string, detail: Readonly<Record<string, unknown>>) => void;
  readonly testShutdownWaitMs?: number;
};

/**
 * MCP-facing adapter for the existing SQLite Lifecycle Port. It owns no
 * persistence facts: Task, Attempt, Operation, Result, Event and Claim reads
 * all come from the bound SQLite driver. The outer BridgeTaskManager remains
 * the single public Manager contract and delegates to this binding only when
 * explicitly constructed for an isolated SQLite composition.
 */
export class SqliteLifecycleMcpAuthority implements ProgressTaskManager {
  readonly #driver: Driver;
  readonly #queue: Array<{ taskId: string; attempt: number }> = [];
  readonly #activeRuns = new Map<string, Promise<ClaimOnlyRunResult>>();
  readonly #queued = new Set<string>();
  #active = false;
  #closed = false;
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | null = null;
  #pumpPromise: Promise<void> | null = null;
  #recoveryComplete = false;
  #pumpPending = false;
  #awaitingDispatchPrerequisite = false;
  #pumpRetryTimer: ReturnType<typeof setTimeout> | null = null;
  #capacityRetryMs = 100;
  #pumpFailure: { readonly taskId: string; readonly reason: string } | null = null;
  #dispatchingTaskId: string | null = null;
  #dispatchingKey: string | null = null;
  #recoveryBlocked: string | null = null;
  readonly #testBeforeDispatch?: () => Promise<void>;
  readonly #testOnScheduler?: (stage: string, detail: Readonly<Record<string, unknown>>) => void;
  readonly #shutdownWaitMs: number;
  readonly #context: NonNullable<ClaimOnlyDriverOptions["trustedLocalContext"]>;
  readonly #processProbe: ProcessProbe;

  private constructor(driver: Driver, context: NonNullable<ClaimOnlyDriverOptions["trustedLocalContext"]>, processProbe: ProcessProbe,
    testBeforeDispatch?: () => Promise<void>, testOnScheduler?: SqliteAuthorityOptions["testOnScheduler"],
    shutdownWaitMs = DEFAULT_HOST_SHUTDOWN_WAIT_MS) {
    this.#driver = driver;
    this.#context = context;
    this.#processProbe = processProbe;
    this.#testBeforeDispatch = testBeforeDispatch;
    this.#testOnScheduler = testOnScheduler;
    this.#shutdownWaitMs = shutdownWaitMs;
  }

  async createTask(task: TaskPackage): Promise<TaskReceipt> {
    this.#assertOpen();
    this.#assertAccepting();
    this.#assertRecoveryReady();
    validateTaskPackage(task);
    const policy = this.#driverTrustedPolicy();
    const requestedPath = task.worktree_path ?? task.workspace;
    const decision = policy.validateWorkspace({ requestedPath, canonicalPath: requestedPath });
    if (decision.state !== "allow") throw new TaskManagerError("TASK_INVALID", `SQLite admission rejected: ${decision.state === "unknown" ? decision.reason : decision.reason}`);
    const use = policy.validateWorkspaceForUse(requestedPath);
    if (use.state !== "allow") throw new TaskManagerError("TASK_INVALID", `SQLite admission rejected: ${use.state === "unknown" ? use.reason : use.reason}`);
    const permission = policy.checkPermission({ workspace: requestedPath, task: { ...task, operation_id: `preflight-${task.task_id}`, attempt: 1 } });
    if (permission.state !== "allow") throw new TaskManagerError("TASK_INVALID", `SQLite admission rejected: ${permission.state === "unknown" ? permission.reason : permission.reason}`);

    const existingValue = this.#driver.readTaskLifecycle(task.task_id);
    if (existingValue) {
      const existing = asRecord(existingValue);
      if (canonicalJson(existing.task) !== canonicalJson(task)) {
        throw new TaskManagerError("TASK_ID_CONFLICT", `task_id already belongs to a different SQLite request: ${task.task_id}`);
      }
      const projection = asRecord(existing.projection);
      return receipt(task.task_id, projection.status, projection.created_at);
    }

    try {
      this.#driver.createTask(task as CandidateTaskPackage);
    } catch (error) {
      const raced = asRecord(this.#driver.readTaskLifecycle(task.task_id));
      if (!raced || canonicalJson(raced.task) !== canonicalJson(task)) {
        if (errorCode(error) === "task_already_exists") throw new TaskManagerError("TASK_ID_CONFLICT", `task_id already exists with different SQLite input: ${task.task_id}`);
        throw error;
      }
    }
    const snapshot = asRecord(this.#driver.readTaskLifecycle(task.task_id));
    const projection = asRecord(snapshot.projection);
    this.#enqueue(task.task_id, Number(projection.current_attempt));
    return { task_id: task.task_id, status: "queued", created_at: string(projection.created_at, "task_created_at_missing") };
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    const snapshot = this.#readSnapshot(taskId);
    const projection = asRecord(snapshot.projection);
    if (this.#pumpFailure && projection.status === "queued") {
      throw new TaskManagerError("TASK_STATE", `SQLite dispatch is blocked after ${this.#pumpFailure.reason}; queued lifecycle facts remain persisted and no automatic retry was attempted`);
    }
    const attempt = asRecord(snapshot.attempt);
    const operation = snapshot.operation ? asRecord(snapshot.operation) : null;
    const result = snapshot.result ? asRecord(snapshot.result) : null;
    const events = this.#driver.readTaskEvents(taskId, { afterCursor: 0, limit: 200 }) as { events?: readonly Record<string, unknown>[] };
    const lastAt = events.events?.at(-1)?.at;
    const createdAt = string(projection.created_at, "task_created_at_missing");
    const status = taskStatus(projection.status);
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
      ...(executionObservation ? { execution_observation: executionObservation } : {}),
      ...(Number(attempt.attempt) > 0 ? {} : {}),
    };
  }

  async getResult(taskId: string): Promise<TaskResult> {
    const snapshot = this.#readSnapshot(taskId);
    if (!snapshot.result) throw new TaskManagerError("TASK_NOT_FINISHED", `task ${taskId} has no committed SQLite Result`);
    return snapshot.result as unknown as TaskResult;
  }

  async getEvents(input: GetEventsInput): Promise<TaskProgressPage> {
    this.#assertOpen();
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
    const deadline = Date.now() + waitMs;
    while (true) {
      const snapshot = this.#readSnapshot(input.task_id);
      const page = this.#driver.readTaskEvents(input.task_id, { afterCursor: cursor, limit }) as {
        events: readonly Record<string, unknown>[]; nextCursor: number; hasMore: boolean;
      };
      let events = page.events.map((value) => {
        const event = toProgressEvent(value);
        if (event.type !== "interaction_requested" || !event.details || typeof event.details.request_id !== "string") return event;
        const persisted = this.#driver.readInteractionRequest(input.task_id, event.details.request_id);
        if (!persisted) return event;
        const request = asRecord(persisted.request);
        return { ...event, details: { ...event.details, method: request.method, params: request.params } };
      });
      let nextCursor = page.nextCursor;
      let scanIncomplete = false;
      if (input.max_bytes !== undefined) {
        if (!Number.isInteger(input.max_bytes) || input.max_bytes < 1024 || input.max_bytes > 32 * 1024 * 1024) {
          throw new TaskManagerError("TASK_INVALID", "max_bytes must be between 1024 and 33554432");
        }
        let bytes = 0;
        let kept = 0;
        for (const event of events) {
          const size = Buffer.byteLength(canonicalJson(event), "utf8");
          if (kept > 0 && bytes + size > input.max_bytes) break;
          if (kept === 0 && size > input.max_bytes) { scanIncomplete = true; break; }
          bytes += size;
          kept += 1;
        }
        if (kept < events.length) {
          events = events.slice(0, kept);
          nextCursor = events.at(-1)?.seq ?? cursor;
          scanIncomplete = true;
        }
      }
      const status = taskStatus(asRecord(snapshot.projection).status);
      if (events.length || isTerminal(status) || Date.now() >= deadline) {
        return {
          task_id: input.task_id,
          status,
          events,
          next_seq: nextCursor,
          has_more: page.hasMore || scanIncomplete,
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
        return { task_id: input.task_id, status: "queued", created_at: string(replay.created_at, "continue_created_at_missing") };
      } catch (error) {
        if (errorCode(error) !== "continue_cas_required") throw error;
      }
    }
    const snapshot = this.#readSnapshot(input.task_id);
    if (!snapshot.operation) throw new TaskManagerError("TASK_STATE", "the prior SQLite Attempt has no released Operation");
    const operation = asRecord(snapshot.operation);
    const result = snapshot.result as Record<string, unknown> | null;
    const outcome = asRecord(this.#driver.createNextAttempt({
      ...common,
      previous_attempt: Number(asRecord(snapshot.attempt).attempt),
      previous_operation_id: string(operation.operation_id, "continue_operation_missing"),
      expected_generation: Number(operation.generation),
      expected_revision: Number(operation.revision),
      claim_id: string(operation.claim_id, "continue_claim_missing"),
      claim_worker_identity_digest: string(operation.claim_worker_identity_digest, "continue_worker_identity_missing"),
      previous_result: result,
    }));
    this.#enqueue(input.task_id, Number(outcome.attempt));
    return { task_id: input.task_id, status: "queued", created_at: string(outcome.created_at, "continue_created_at_missing") };
  }

  async cancelTask(taskId: string): Promise<TaskStatusRecord> {
    this.#assertOpen();
    this.#assertRecoveryReady();
    const snapshot = this.#readSnapshot(taskId);
    const projection = asRecord(snapshot.projection);
    const attempt = asRecord(snapshot.attempt);
    if (projection.status === "queued") {
      this.#driver.cancelQueuedAttempt({ task_id: taskId, expected_attempt: Number(attempt.attempt) });
      this.#queued.delete(queueKey(taskId, Number(attempt.attempt)));
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
    throw new TaskManagerError("TASK_STATE", `zcode_cancel is not allowed from SQLite status ${String(projection.status)}`);
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

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (this.#closed) return;
    this.#shuttingDown = true;
    if (this.#pumpRetryTimer) clearTimeout(this.#pumpRetryTimer);
    this.#pumpRetryTimer = null;
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
      try {
        const status = await waitUntilDeadline(this.cancelTask(taskId), deadline);
        if (status.status === "running" || status.status === "queued") failures.push(`${taskId}:shutdown_cancel_unconfirmed`);
      } catch (error) {
        failures.push(`${taskId}:${errorCode(error) ?? (error instanceof Error && error.message === "shutdown_wait_timeout"
          ? "shutdown_wait_timeout" : "shutdown_cancel_failed")}`);
      }
    }
    const pump = this.#pumpPromise;
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
    if (failures.length > 0) {
      // Keep the SQLite handle and Host alive. An uncertain shutdown must not
      // release Writer ownership or make a possibly active Worker look closed.
      throw new TaskManagerError("CANCEL_FAILED", `SQLite Host shutdown retained its Root because Worker cleanup is unverified: ${failures.join(",")}`);
    }
    this.#closed = true;
    this.#driver.close();
  }

  async recoverTasks(): Promise<void> {
    this.#assertOpen();
    if (this.#recoveryComplete) {
      throw new TaskManagerError("TASK_STATE", "SQLite Recovery is startup-only; restart the Manager to refresh persisted Recovery facts");
    }
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
        const outcome = asRecord(await this.#driver.recoverOperation(operationId));
        this.#schedulerStage("operation_recovery_classified", {
          operation_id: operationId, phase: operation.phase, state: outcome.state ?? "unknown", reason: outcome.reason ?? null,
        });
        if (outcome.state === "held") {
          // Manual-Recovery treats an unresolved active executor as a Root
          // safety boundary. Keep read APIs available, but do not dispatch
          // another queued Operation or accept new lifecycle writes on this
          // Manager while any persisted Operation remains held.
          this.#recoveryBlocked = `operation ${operationId} is held: ${String(outcome.reason ?? "recovery_evidence_unknown")}`;
          this.#schedulerStage("recovery_root_read_only", { operation_id: operationId, reason: this.#recoveryBlocked });
          break;
        }
      }
      snapshot = this.#validateRecoverySnapshot(this.#driver.readRecoverySnapshot());
      const queued = this.#recoveryBlocked ? [] : this.#driver.readRecoverableQueuedAttempts();
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
      this.#schedulerStage("recovery_complete", { recoverable_queued_attempts: queued.filter((value) => value.dispatchable === true).length,
        root_read_only: this.#recoveryBlocked !== null });
      if (!this.#recoveryBlocked) this.#schedulePump();
    } catch (error) {
      this.#recoveryBlocked = error instanceof Error ? error.message : String(error);
      this.#pumpFailure = { taskId: "root", reason: errorCode(error) ?? "recovery_snapshot_unavailable" };
      this.#recoveryComplete = false;
      throw error;
    }
  }

  async #executionObservation(taskId: string, snapshot: TaskSnapshot, status: TaskStatus): Promise<ExecutionObservation | undefined> {
    const operation = snapshot.operation;
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

  #validateRecoverySnapshot(value: unknown): { readonly operations: readonly unknown[] } {
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
    return { operations: snapshot.operations };
  }

  #driverTrustedPolicy(): NonNullable<ClaimOnlyDriverOptions["trustedLocalContext"]>["policy"] {
    const context = this.#context;
    return context.policy;
  }

  static async create(options: SqliteAuthorityOptions): Promise<SqliteLifecycleMcpAuthority> {
    if (!options.trustedLocalContext) throw new TaskManagerError("TASK_STATE", "trusted local context is required");
    const { testBeforeDispatch, testOnScheduler, testShutdownWaitMs, ...driverOptions } = options;
    const shutdownWaitMs = testShutdownWaitMs ?? DEFAULT_HOST_SHUTDOWN_WAIT_MS;
    if (!Number.isSafeInteger(shutdownWaitMs) || shutdownWaitMs < 1 || shutdownWaitMs > DEFAULT_HOST_SHUTDOWN_WAIT_MS) {
      throw new TaskManagerError("TASK_STATE", "invalid Host shutdown wait budget");
    }
    const processProbe = options.processProbe ?? createPlatformProbe();
    const authority = new SqliteLifecycleMcpAuthority(await openClaimOnlyDriver({ ...driverOptions, processProbe }), options.trustedLocalContext,
      processProbe, testBeforeDispatch, testOnScheduler, shutdownWaitMs);
    try {
      await authority.recoverTasks();
      return authority;
    } catch (error) {
      await authority.shutdown().catch(() => undefined);
      throw error;
    }
  }

  #readSnapshot(taskId: string): { task: TaskPackage; projection: Record<string, unknown>; attempt: Record<string, unknown>; operation: Record<string, unknown> | null; result: TaskResult | null; continuation: Record<string, unknown> | null } {
    this.#assertOpen();
    const value = this.#driver.readTaskLifecycle(taskId);
    if (!value) throw new TaskManagerError("TASK_NOT_FOUND", `unknown SQLite task: ${taskId}`);
    const snapshot = asRecord(value);
    return {
      task: snapshot.task as TaskPackage,
      projection: asRecord(snapshot.projection),
      attempt: asRecord(snapshot.attempt),
      operation: snapshot.operation ? asRecord(snapshot.operation) : null,
      result: snapshot.result as TaskResult | null,
      continuation: snapshot.continuation ? asRecord(snapshot.continuation) : null,
    };
  }

  #enqueue(taskId: string, attempt: number): void {
    if (this.#pumpFailure) {
      this.#schedulerStage("enqueue_blocked", { task_id: taskId, attempt, reason: this.#pumpFailure.reason });
      return;
    }
    const key = queueKey(taskId, attempt);
    if (this.#queued.has(key) || this.#dispatchingKey === key) {
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
    if (this.#pumpRetryTimer) {
      this.#schedulerStage("schedule_waiting_for_capacity", { retry_ms: this.#capacityRetryMs, queue_depth: this.#queue.length });
      return;
    }
    this.#pumpPending = true;
    this.#schedulerStage("schedule", { active: this.#active, queue_depth: this.#queue.length });
    queueMicrotask(() => {
      this.#pumpPending = false;
      this.#schedulerStage("scheduled_callback", { active: this.#active, queue_depth: this.#queue.length });
      const running = this.#pump();
      this.#pumpPromise = running;
      const failedTaskId = this.#dispatchingTaskId;
      void running.catch((error: unknown) => {
        const reason = errorCode(error) ?? "dispatch_failed";
        this.#pumpFailure = { taskId: failedTaskId ?? "unknown", reason };
      }).finally(() => {
        if (this.#pumpPromise === running) this.#pumpPromise = null;
      });
    });
  }

  async #pump(): Promise<void> {
    if (this.#closed || this.#shuttingDown || this.#active) {
      this.#schedulerStage("pump_skipped", { closed: this.#closed, shutting_down: this.#shuttingDown, active: this.#active, queue_depth: this.#queue.length });
      return;
    }
    this.#active = true;
    this.#schedulerStage("pump_started", { queue_depth: this.#queue.length });
    let capacityBlocked = false;
    try {
      while (!this.#closed && !this.#shuttingDown && this.#queue.length > 0) {
        const next = this.#queue.shift()!;
        const nextKey = queueKey(next.taskId, next.attempt);
        this.#schedulerStage("dispatch_dequeued", { task_id: next.taskId, attempt: next.attempt, queue_depth: this.#queue.length });
        this.#dispatchingTaskId = next.taskId;
        this.#dispatchingKey = nextKey;
        this.#queued.delete(nextKey);
        let snapshot: TaskSnapshot;
        try { snapshot = this.#readSnapshot(next.taskId); } catch { continue; }
        if (snapshot.projection.status !== "queued" || Number(snapshot.attempt.attempt) !== next.attempt) continue;
        const operationId = operationIdFor(next.taskId, next.attempt);
        if (this.#testBeforeDispatch) {
          this.#awaitingDispatchPrerequisite = true;
          try { await this.#testBeforeDispatch(); }
          finally { this.#awaitingDispatchPrerequisite = false; }
        }
        // Shutdown may occur while a gate or future dispatch prerequisite is
        // pending. The durable queued Attempt remains authoritative; never
        // start a Worker after this Manager has closed its SQLite handle.
        if (this.#closed || this.#shuttingDown) break;
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
        finally { if (this.#activeRuns.get(nextKey) === runPromise) this.#activeRuns.delete(nextKey); }
        this.#schedulerStage("driver_run_returned", { task_id: next.taskId, attempt: next.attempt, state: run.state, queue_depth: this.#queue.length });
        this.#acceptRunOutcome(run);
        const after = this.#readSnapshot(next.taskId);
        if (after.projection.status === "queued" && after.operation === null && run.reason === "capacity_exhausted") {
          // Capacity failure occurs before Operation creation or Spawn. Keep
          // the persisted Attempt queued and retry only with bounded backoff.
          this.#queue.unshift(next);
          this.#queued.add(queueKey(next.taskId, next.attempt));
          capacityBlocked = true;
          this.#capacityRetryMs = Math.min(this.#capacityRetryMs * 2, 2_000);
          break;
        }
        this.#capacityRetryMs = 100;
        if (after.operation?.phase === "released") continue;
        if (after.operation && after.operation.phase !== "released" && after.operation.phase !== "cancelled_before_launch") break;
      }
    } finally {
      this.#active = false;
      this.#dispatchingTaskId = null;
      this.#dispatchingKey = null;
      this.#schedulerStage("pump_finished", { queue_depth: this.#queue.length, pump_failure: this.#pumpFailure?.reason ?? null });
      if (capacityBlocked && !this.#closed && !this.#pumpFailure && this.#queue.length > 0) {
        this.#pumpRetryTimer = setTimeout(() => {
          this.#pumpRetryTimer = null;
          this.#schedulePump();
        }, this.#capacityRetryMs);
        this.#pumpRetryTimer.unref?.();
      } else this.#schedulePump();
    }
  }

  #acceptRunOutcome(_run: ClaimOnlyRunResult): void {
    // Authority facts are read from the SQLite projection on every MCP call.
    // The in-memory return value is never used to claim a Result commit.
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

interface TaskSnapshot {
  readonly task: TaskPackage;
  readonly projection: Record<string, unknown>;
  readonly attempt: Record<string, unknown>;
  readonly operation: Record<string, unknown> | null;
  readonly result: TaskResult | null;
  readonly continuation: Record<string, unknown> | null;
}

function validateTaskPackage(task: TaskPackage): void {
  if (!task || typeof task.task_id !== "string" || !task.task_id.trim() || task.task_id.length > 128
    || typeof task.workspace !== "string" || !task.workspace.trim() || !pathIsAbsolute(task.workspace)
    || typeof task.objective !== "string" || !task.objective.trim()
    || !Array.isArray(task.requirements) || !Array.isArray(task.allowed_paths) || !Array.isArray(task.forbidden_paths)
    || !Array.isArray(task.acceptance_criteria) || !Array.isArray(task.test_commands)) {
    throw new TaskManagerError("TASK_INVALID", "invalid SQLite TaskPackage");
  }
}

function pathIsAbsolute(value: string): boolean {
  return process.platform === "win32" ? /^[A-Za-z]:\\/u.test(value) : value.startsWith("/");
}

function taskStatus(value: unknown): TaskStatus {
  if (typeof value !== "string" || !["queued", "running", "completed", "failed", "cancelled", "waiting_for_master"].includes(value)) {
    throw new TaskManagerError("TASK_STATE", "SQLite Task projection has an unknown status");
  }
  return value as TaskStatus;
}

function receipt(taskId: string, status: unknown, createdAt: unknown): TaskReceipt {
  return { task_id: taskId, status: status === "running" ? "running" : "queued", created_at: string(createdAt, "task_created_at_missing") };
}

function toProgressEvent(value: Record<string, unknown>): TaskProgressEvent {
  let details: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(string(value.evidence_json, "event_evidence_missing"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
  } catch { throw new TaskManagerError("TASK_STATE", "SQLite lifecycle event evidence is corrupt"); }
  return {
    seq: Number(value.cursor ?? value.sequence),
    at: string(value.at, "event_time_missing"),
    type: string(value.event_type, "event_type_missing"),
    summary: `SQLite lifecycle: ${string(value.event_type, "event_type_missing")}`,
    ...(details ? { details } : {}),
  };
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

function queueKey(taskId: string, attempt: number): string { return `${taskId}\0${attempt}`; }
function isTerminal(status: TaskStatus): boolean { return ["completed", "failed", "cancelled", "waiting_for_master"].includes(status); }
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
  try { return asRecord(JSON.parse(string(value, "identity_missing"))); }
  catch { throw new TaskManagerError("TASK_STATE", "SQLite Worker identity projection is corrupt"); }
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
