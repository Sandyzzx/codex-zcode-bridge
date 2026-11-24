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

export interface ExecutorTaskManagement {
  listTasks(input: ListTasksInput): Promise<TaskListPage>;
}
