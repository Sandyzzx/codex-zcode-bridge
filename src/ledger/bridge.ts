// C2: Bridge run correlation for the project ledger. A run intent (with its
// deterministic executor task id) is persisted BEFORE dispatching to the
// Bridge, so a lost receipt or crash recovers the same execution instead of
// starting a second one. Event projection maps Bridge evidence onto the run
// with dedupe by (run, attempt, seq); the cursor advances only after the
// projection is durable. The ledger never inspects PIDs, never kills
// processes, and never changes Bridge status — cancellation always goes
// through the executor API with the request and confirmation recorded.
import type { BridgeTaskManager } from "../manager/task-manager.js";
import type { TaskPackage, TaskReceipt, TaskResult, TaskStatusRecord } from "../interfaces.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tryAcquireProcessLock } from "../store/process-lock.js";
import { LedgerError, type LedgerActor, type RunRecord } from "./types.js";
import type { LedgerStore } from "./store.js";

export interface DispatchPlan {
  readonly project_task_id: string;
  readonly operation_id: string;
  /** Builds the Bridge TaskPackage; must be deterministic per operation. */
  readonly buildTaskPackage: (executorTaskId: string) => TaskPackage;
  readonly actor?: LedgerActor;
}

export interface DispatchOutcome {
  readonly run_id: string;
  readonly executor_task_id: string;
  readonly receipt: TaskReceipt | null;
  readonly status: "accepted" | "dispatch_unknown";
}

/** Deterministic Bridge task id for (project task, operation): a retry after
 * a lost receipt reuses exactly this id, so the Bridge's own submission
 * idempotency guarantees at most one execution. */
export function executorTaskIdFor(projectTaskId: string, operationId: string): string {
  const raw = `b-${projectTaskId}-${operationId}`.replace(/[^A-Za-z0-9_-]/gu, "_");
  return raw.slice(0, 64).replace(/[_-]+$/u, "");
}

export class LedgerBridgeLink {
  readonly #ledger: LedgerStore;
  readonly #ledgerDir: string;
  readonly #cursorFile: string;

  constructor(ledger: LedgerStore) {
    this.#ledger = ledger;
    this.#ledgerDir = path.join(ledger.root, ".agent-ledger", "ledger");
    this.#cursorFile = path.join(this.#ledgerDir, "bridge-cursors.json");
  }

  /** Persists the run intent, then dispatches; every retry of the same
   * operation keeps the same run and the same executor task id (C2-01). */
  async dispatchTask(manager: BridgeTaskManager, plan: DispatchPlan): Promise<DispatchOutcome> {
    const task = this.#ledger.getTask(plan.project_task_id);
    if (task.status === "done" || task.status === "cancelled") {
      throw new LedgerError("LEDGER_STATE", `cannot dispatch a ${task.status} project task`);
    }
    const executorTaskId = executorTaskIdFor(plan.project_task_id, plan.operation_id);
    // Step 1 — the intent (idempotent by operation_id): a crash right here
    // leaves a recorded intent whose replay reuses the same executor id.
    const run = this.#ledger.startRun({
      task_id: plan.project_task_id,
      executor: { kind: "zcode-bridge" },
      executor_ref: executorTaskId,
      run_id: findRunIdByRef(this.#ledger, executorTaskId) ?? undefined,
    }, `dispatch:${plan.operation_id}`, plan.actor ?? { source: "host", id: "local" });
    // Step 2 — dispatch through the Bridge API. The Bridge dedupes identical
    // submissions by task_id, so a retry cannot start a second execution.
    try {
      const receipt = await manager.createTask(plan.buildTaskPackage(executorTaskId));
      this.#ledger.updateRun(run.run_id, {
        status: receipt.status === "running" ? "started" : "accepted",
        executor_ref: executorTaskId,
      }, `accepted:${plan.operation_id}`, { source: "bridge", id: "ledger-link" });
      return { run_id: run.run_id, executor_task_id: executorTaskId, receipt, status: "accepted" };
    } catch {
      // Accept state unverifiable → dispatch_unknown; the operation stays
      // retryable under the same operation id (C2-01).
      this.#ledger.updateRun(run.run_id, {
        status: "dispatch_unknown",
        executor_ref: executorTaskId,
      }, `dispatch-unknown:${plan.operation_id}`, { source: "bridge", id: "ledger-link" });
      return { run_id: run.run_id, executor_task_id: executorTaskId, receipt: null, status: "dispatch_unknown" };
    }
  }

  /** Cancels through the executor API and records request + confirmation. */
  async cancelRun(manager: BridgeTaskManager, runId: string, operationId: string): Promise<TaskStatusRecord> {
    const run = this.#requireRun(runId);
    if (run.executor.kind !== "zcode-bridge" || !run.executor_ref) {
      throw new LedgerError("LEDGER_STATE", "only Bridge runs can be cancelled through the executor API");
    }
    const status = await manager.cancelTask(run.executor_ref);
    this.#ledger.updateRun(runId, {
      status: status.status === "cancelled" ? "cancelled" : run.status,
    }, `cancel:${operationId}`, { source: "bridge", id: "ledger-link" });
    return status;
  }

  /** Projects Bridge evidence onto the run. Idempotent: replaying the same
   * Bridge events appends nothing (journal operation dedupe by run+attempt+seq). */
  async syncRunFromBridge(manager: BridgeTaskManager, runId: string): Promise<{ projected: number; cursor: number }> {
    const run = this.#requireRun(runId);
    if (run.executor.kind !== "zcode-bridge" || !run.executor_ref) {
      throw new LedgerError("LEDGER_STATE", "projection requires a Bridge run");
    }
    const cursorState = this.#readCursors();
    const cursor = cursorState[runId]?.last_seq ?? 0;
    let projected = 0;
    let lastSeq = cursor;
    const page = await manager.getEvents({ task_id: run.executor_ref, after_seq: cursor, limit: 200 });
    const status = await manager.getStatus(run.executor_ref).catch(() => null);
    const attempt = status?.attempt ?? null;
    for (const event of page.events) {
      // Dedupe key binds executor task, attempt, and Bridge-local seq; local
      // and runtime sequences are never mixed.
      const operationId = `proj:${runId}:a${String(attempt)}:s${String(event.seq)}`;
      const projection = projectEvent(event.type, event.details);
      if (!projection) {
        lastSeq = Math.max(lastSeq, event.seq);
        continue;
      }
      try {
        this.#ledger.updateRun(runId, projection, operationId, { source: "bridge", id: "ledger-link" });
        projected += 1;
      } catch (error) {
        if (!(error instanceof LedgerError) || error.code !== "LEDGER_CONFLICT") throw error;
        // Same operation with identical input replays as a no-op; a conflict
        // here means a different projection already used the slot — keep the
        // first (durable) projection.
      }
      lastSeq = Math.max(lastSeq, event.seq);
    }
    // Terminal facts: the run reflects the Bridge result, but the project
    // task's business status is NEVER derived from it (C2-03) — completion
    // requires the review/DONE gate.
    if (status && ["completed", "failed", "cancelled", "waiting_for_master"].includes(status.status)) {
      const result = await manager.getResult(run.executor_ref).catch(() => null);
      const operationId = `proj:${runId}:terminal:${status.status}:${String(status.attempt)}`;
      try {
        this.#ledger.updateRun(runId, {
          status: status.status === "completed" || status.status === "waiting_for_master" ? "finished" : status.status === "cancelled" ? "cancelled" : "failed",
          // Only a runtime-confirmed model identity may overwrite the
          // projection; an all-null worker profile means "not reported".
          model: result?.model?.model_id
            ? { provider_id: result.model.provider_id, model_id: result.model.model_id, requested_model: result.model.requested_model, effective_reasoning_level: result.model.effective_reasoning_level, source: result.model.selection_source }
            : undefined,
          usage: result?.usage as Record<string, unknown> | undefined ?? undefined,
          timing: result?.timing as Record<string, unknown> | undefined ?? undefined,
          report_ref: result ? { summary: result.summary.slice(0, 500), files_changed: result.files_changed, tests: result.tests.map((test) => ({ command: test.command, status: test.status })) } : undefined,
        }, operationId, { source: "bridge", id: "ledger-link" });
        projected += 1;
      } catch (error) {
        if (!(error instanceof LedgerError) || error.code !== "LEDGER_CONFLICT") throw error;
      }
    }
    // The consumption cursor advances only after the durable projection.
    if (lastSeq !== cursor) this.#writeCursor(runId, run.executor_ref, lastSeq);
    return { projected, cursor: lastSeq };
  }

  #requireRun(runId: string): RunRecord {
    const run = this.#ledger.listRuns().find((candidate) => candidate.run_id === runId);
    if (!run) throw new LedgerError("LEDGER_NOT_FOUND", `unknown run: ${runId}`);
    return run;
  }

  #readCursors(): Record<string, { executor_task_id: string; last_seq: number }> {
    if (!existsSync(this.#cursorFile)) return {};
    try {
      return JSON.parse(readFileSync(this.#cursorFile, "utf8")) as Record<string, { executor_task_id: string; last_seq: number }>;
    } catch {
      return {};
    }
  }

  #writeCursor(runId: string, executorTaskId: string, lastSeq: number): void {
    const cursors = this.#readCursors();
    cursors[runId] = { executor_task_id: executorTaskId, last_seq: lastSeq };
    mkdirSync(this.#ledgerDir, { recursive: true });
    const release = tryAcquireProcessLock(path.join(this.#ledgerDir, "cursor.lock"));
    if (!release) return; // cursor writes are advisory; the journal is authoritative
    try {
      writeFileSync(this.#cursorFile, JSON.stringify(cursors, null, 2), { mode: 0o600 });
    } finally {
      release();
    }
  }
}

import type { TaskProgressEvent } from "../interfaces.js";

function findRunIdByRef(ledger: LedgerStore, executorTaskId: string): string | null {
  return ledger.listRuns().find((run) => run.executor_ref === executorTaskId)?.run_id ?? null;
}

/** Maps a Bridge event type onto run-level projection fields. Uninteresting
 * events project to null (cursor still advances). */
function projectEvent(type: string, details: Record<string, unknown> | undefined): Partial<RunRecord> | null {
  switch (type) {
    case "queued":
      return { status: "accepted" };
    case "worker_started":
      return { status: "started" };
    case "model_selected":
      return {
        model: {
          provider_id: typeof details?.["provider_id"] === "string" ? details["provider_id"] as string : null,
          model_id: typeof details?.["model_id"] === "string" ? details["model_id"] as string : null,
          requested_model: typeof details?.["requested_model"] === "string" ? details["requested_model"] as string : null,
          effective_reasoning_level: typeof details?.["reasoning_level"] === "string" ? details["reasoning_level"] as string : null,
          source: typeof details?.["model_source"] === "string" ? details["model_source"] as string : null,
        },
      };
    case "interaction_requested":
      return { status: "started" }; // blocking fact stays in the event log; run status unchanged
    case "cleanup_unverified":
      return { status: "finished" };
    default:
      return null;
  }
}

export type { TaskResult, TaskProgressEvent };
