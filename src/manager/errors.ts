// TaskManager error taxonomy. TASK_NOT_FOUND and TASK_NOT_FINISHED are the
// frozen MCP error names from docs/INTERFACES.md; the others are internal
// manager errors that the MCP layer maps onto error responses later.
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
  | "CANCEL_FAILED";

export class TaskManagerError extends Error {
  readonly code: TaskManagerErrorCode;

  constructor(code: TaskManagerErrorCode, message: string) {
    super(message);
    this.name = "TaskManagerError";
    this.code = code;
  }
}
