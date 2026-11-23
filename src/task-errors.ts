/** Stable task-control error taxonomy shared by MCP and Executor IPC. */
export type TaskManagerErrorCode =
  | "TASK_NOT_FOUND"
  | "TASK_NOT_FINISHED"
  | "TASK_ALREADY_EXISTS"
  | "TASK_ID_CONFLICT"
  | "CONTINUE_OPERATION_CONFLICT"
  | "BRIDGE_BUSY"
  | "REQUEST_QUEUE_TIMEOUT"
  | "TASK_INVALID"
  | "TASK_STATE"
  | "CANCEL_FAILED"
  | "EXECUTOR_STORE_CLOSE_UNKNOWN"
  | "interaction_reply_outcome_unknown";

export class TaskManagerError extends Error {
  readonly code: TaskManagerErrorCode;

  constructor(code: TaskManagerErrorCode, message: string) {
    super(message);
    this.name = "TaskManagerError";
    this.code = code;
  }
}
