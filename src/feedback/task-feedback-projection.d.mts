import type {
  TaskFeedbackSnapshotV01,
  TaskProgressEvent,
  TaskResult,
  TaskStatusRecord,
} from "../interfaces.js";

export function buildTaskFeedbackSnapshotV01(input: {
  readonly status: TaskStatusRecord;
  readonly events: readonly TaskProgressEvent[];
  readonly result: TaskResult | null;
}): TaskFeedbackSnapshotV01;
