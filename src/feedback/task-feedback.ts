import type {
  TaskFeedbackSnapshotV01,
  TaskProgressEvent,
  TaskResult,
  TaskStatusRecord,
} from "../interfaces.js";
import { buildTaskFeedbackSnapshotV01 as project } from "./task-feedback-projection.mjs";

/** Shared runtime-neutral projection used by both the JSON-era callers and
 * the SQLite Store without creating a second Feedback implementation. */
export function buildTaskFeedbackSnapshotV01(input: {
  readonly status: TaskStatusRecord;
  readonly events: readonly TaskProgressEvent[];
  readonly result: TaskResult | null;
}): TaskFeedbackSnapshotV01 {
  return project(input) as TaskFeedbackSnapshotV01;
}
