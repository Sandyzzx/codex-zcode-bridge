import type { TaskAttentionSnapshot, TaskStatus } from "../interfaces.js";
import { TaskManagerError } from "../manager/errors.js";

const TASK_STATUSES = new Set<TaskStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "waiting_for_master",
]);

/** Validate the SQLite attention projection without giving it any control authority. */
export function parseTaskAttentionSnapshot(value: unknown, expectedTaskId?: string): TaskAttentionSnapshot {
  if (!isRecord(value)) throw new TaskManagerError("TASK_STATE", "SQLite attention projection is invalid");
  const taskId = value.task_id;
  const attempt = value.attempt;
  const status = value.status;
  const pending = value.pending_requests;
  if (typeof taskId !== "string" || !taskId
    || (expectedTaskId !== undefined && taskId !== expectedTaskId)
    || !Number.isSafeInteger(attempt) || Number(attempt) < 1
    || typeof status !== "string" || !TASK_STATUSES.has(status as TaskStatus)
    || !Array.isArray(pending)
    || pending.some((requestId) => typeof requestId !== "string" || requestId.length < 1 || requestId.length > 512)) {
    throw new TaskManagerError("TASK_STATE", "SQLite attention projection is invalid");
  }
  return {
    task_id: taskId,
    attempt: Number(attempt),
    status: status as TaskStatus,
    pending_requests: [...pending] as string[],
  };
}

export function isAttentionTerminalStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "waiting_for_master";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
