import * as z from "zod/v4";
import { taskIdSchema } from "./api-schemas.js";
import type { TaskOwnerBinding, TaskStatus } from "./interfaces.js";

export const DEFAULT_TASK_LIST_LIMIT = 50;
export const MAX_TASK_LIST_LIMIT = 100;

export const listTasksInputSchema = z.strictObject({
  after_task_id: taskIdSchema.optional(),
  limit: z.number().int().min(1).max(MAX_TASK_LIST_LIMIT).optional(),
  status: z.enum([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "waiting_for_master",
  ]).optional(),
});

export type ListTasksInput = z.infer<typeof listTasksInputSchema>;

export interface TaskListWakeSummary {
  readonly state: "intent" | "queued" | "submission_unknown" | "turn_started" | "web_notify";
  readonly reason_code: string;
  readonly at: string;
}

export interface TaskListItem {
  readonly task_id: string;
  readonly status: TaskStatus;
  readonly attempt: number;
  readonly created_at: string;
  readonly workspace: string;
  readonly objective: string;
  readonly owner_binding?: TaskOwnerBinding;
  readonly wake?: TaskListWakeSummary;
}

export interface TaskListPage {
  readonly tasks: readonly TaskListItem[];
  readonly next_task_id: string | null;
  readonly has_more: boolean;
}

export type ConsoleTaskBucket = "running" | "attention" | "completed";

export const consoleTaskListInputSchema = z.strictObject({
  after_task_id: taskIdSchema.optional(),
  limit: z.number().int().min(1).max(MAX_TASK_LIST_LIMIT).optional(),
  bucket: z.enum(["running", "attention", "completed"]).optional(),
});

export type ConsoleTaskListInput = z.infer<typeof consoleTaskListInputSchema>;

export interface ConsoleTaskModelProjection {
  readonly state: "observed" | "requested" | "not_observed";
  readonly provider_id: string | null;
  readonly model_id: string | null;
  readonly source: "runtime" | "task_request" | "none";
  readonly effort: {
    readonly state: "observed" | "requested" | "not_observed";
    readonly value: string | null;
    readonly source: "runtime" | "task_request" | "none";
  };
}

export interface ConsoleTaskPlanProjection {
  readonly kind: "coding_plan" | "start_plan" | "other" | "not_observed";
  readonly provider_id: string | null;
  readonly source: "runtime" | "task_request" | "none";
}

export interface ConsoleTaskProviderCostProjection {
  readonly state: "not_observed";
  readonly scope: "per_attempt";
  readonly amount: null;
  readonly currency: null;
  readonly reason_code: "bridge_authority_has_no_provider_settlement";
}

export interface ConsoleTaskUsageProjection {
  readonly state: "observed" | "not_observed";
  readonly source: string | null;
  readonly scope: string | null;
  readonly observed_at: string | null;
  readonly finality: "reported" | "derived" | "partial" | null;
  readonly input_tokens: number | null;
  readonly cached_input_tokens: number | null;
  readonly cached_write_input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly total_tokens: number | null;
  readonly conflicts: readonly string[];
  readonly provider_cost: ConsoleTaskProviderCostProjection;
}

export interface ConsoleTaskDiscountProjection {
  readonly state: "applied" | "not_applied" | "not_observed" | "not_applicable";
  readonly source: "per_attempt_settlement" | "provider_kind" | "none";
  readonly reason_code: string | null;
}

export interface ConsoleTaskResultProjection {
  readonly status: "completed" | "failed" | "cancelled" | "waiting_for_master";
  readonly summary: string;
  readonly error_code: string | null;
  readonly issues: readonly string[];
  readonly files_changed: readonly string[];
  readonly tests: ReadonlyArray<{
    readonly command: string;
    readonly status: "passed" | "failed" | "not_run";
    readonly details: string | null;
  }>;
  readonly needs_master_decision: boolean;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export interface ConsoleTaskWakeProjection {
  readonly state: TaskListWakeSummary["state"];
  readonly reason_code: string;
  readonly at: string;
}

export interface ConsoleTaskCleanupProjection {
  readonly state: "not_required" | "not_started" | "pending" | "verified" | "unverified" | "unknown";
  readonly reason_code: string | null;
}

export interface ConsoleTaskReleaseProjection {
  readonly state: "not_released" | "held" | "released";
  readonly cleanup_verified: boolean | null;
  readonly reason_code: string | null;
}

export interface ConsoleTaskHoldProjection {
  readonly active: boolean;
  readonly reason_code: string | null;
  readonly at: string | null;
}

export interface ConsoleTaskActionCapabilities {
  readonly can_continue: boolean;
  readonly can_rework: boolean;
  readonly can_cancel: boolean;
  readonly can_recover_cleanup: boolean;
  readonly can_reply: boolean;
  /** Reasons the current Attempt cannot be Continued or rewritten. */
  readonly blockers: readonly string[];
}

export interface ConsoleTaskAttemptProjection {
  readonly attempt: number;
  readonly status: TaskStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly current: boolean;
  readonly operation_phase: string | null;
  readonly model: ConsoleTaskModelProjection;
  readonly plan: ConsoleTaskPlanProjection;
  readonly usage: ConsoleTaskUsageProjection;
  readonly discount: ConsoleTaskDiscountProjection;
  readonly result: ConsoleTaskResultProjection | null;
  readonly wake: ConsoleTaskWakeProjection | null;
  readonly cleanup: ConsoleTaskCleanupProjection;
  readonly release: ConsoleTaskReleaseProjection;
  readonly hold: ConsoleTaskHoldProjection;
  readonly pending_requests: readonly string[];
  readonly reply_outcome_unknown_requests: readonly string[];
}

export function resolveConsoleActionCapabilities(
  current: ConsoleTaskAttemptProjection,
): ConsoleTaskActionCapabilities {
  const phase = current.operation_phase;
  const terminal = ["completed", "failed", "waiting_for_master", "cancelled"].includes(current.status);
  const released = phase === "released" && current.release.state === "released";
  const wakeSettled = current.wake?.state !== "submission_unknown";
  const noInteractionRisk = current.pending_requests.length === 0
    && current.reply_outcome_unknown_requests.length === 0;
  const cleanupVerified = current.cleanup.state === "verified"
    && current.release.cleanup_verified === true;
  const workerActive = !terminal
    || (phase !== null && ["reserved", "launch_intent", "launch_unknown", "launch_failed", "running"].includes(phase));
  const blockers = new Set<string>();
  if (workerActive) blockers.add("worker_active");
  if (current.wake?.state === "submission_unknown") blockers.add("wake_submission_unknown");
  if (current.pending_requests.length > 0) blockers.add("pending_interaction");
  if (current.reply_outcome_unknown_requests.length > 0) blockers.add("interaction_reply_outcome_unknown");
  if (current.hold.active) {
    const reason = current.hold.reason_code;
    if (reason && reason !== "cleanup_unverified") blockers.add(`hold:${reason}`);
  }
  if (current.cleanup.state === "pending") blockers.add("cleanup_pending");
  if (!cleanupVerified) blockers.add("cleanup_unverified");
  if (!released) blockers.add("release_not_completed");
  else if (current.release.cleanup_verified !== true) blockers.add("release_cleanup_unverified");
  return {
    can_continue: ["completed", "failed", "waiting_for_master"].includes(current.status)
      && released
      && cleanupVerified
      && !current.hold.active
      && noInteractionRisk
      && wakeSettled,
    can_rework: terminal
      && released
      && cleanupVerified
      && !current.hold.active
      && noInteractionRisk
      && wakeSettled,
    can_cancel: current.status === "queued" || current.status === "running",
    can_recover_cleanup: terminal && (
      (current.status === "cancelled" && phase === "launch_intent")
      || ["result_committed", "cleanup_pending", "cleanup_unverified", "cleanup_verified"].includes(phase ?? "")
    ),
    can_reply: current.pending_requests.length > 0,
    blockers: [...blockers],
  };
}

export interface ConsoleTaskListItem {
  readonly task_id: string;
  readonly name: string;
  readonly status: TaskStatus;
  readonly attempt: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly workspace: string;
  readonly objective: string;
  readonly owner_binding?: TaskOwnerBinding;
  readonly wake?: TaskListWakeSummary;
  readonly model: ConsoleTaskModelProjection;
  readonly plan: ConsoleTaskPlanProjection;
  readonly usage: ConsoleTaskUsageProjection;
  readonly discount: ConsoleTaskDiscountProjection;
  readonly cleanup: ConsoleTaskCleanupProjection;
  readonly release: ConsoleTaskReleaseProjection;
  readonly needs_attention: boolean;
  readonly attention_reasons: readonly string[];
  readonly action_capabilities: ConsoleTaskActionCapabilities;
}

export interface ConsoleTaskListPage {
  readonly tasks: readonly ConsoleTaskListItem[];
  readonly next_task_id: string | null;
  readonly has_more: boolean;
}

export interface ConsoleTaskDetail extends ConsoleTaskListItem {
  readonly task: import("./interfaces.js").TaskPackage;
  readonly attempts: readonly ConsoleTaskAttemptProjection[];
  readonly master_usage: {
    readonly state: "not_observed";
    readonly reason_code: "bridge_authority_does_not_record_master_usage";
  };
  readonly result_submission_error: string | null;
}

export interface ExecutorTaskManagement {
  listTasks(input: ListTasksInput): Promise<TaskListPage>;
  listConsoleTasks?(input: ConsoleTaskListInput): Promise<ConsoleTaskListPage>;
  getConsoleTaskDetail?(taskId: string): Promise<ConsoleTaskDetail>;
}
