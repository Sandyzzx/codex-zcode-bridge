import type {
  ContinueTaskInput,
  GetEventsInput,
  TaskPackage,
  ZCodeInteractionReplyInput,
} from "../interfaces.js";

export const EXECUTOR_CONTROL_PROTOCOL_VERSION = 1 as const;
// getResult can return the full 32 MiB TaskResult. Keep a 1 MiB allowance for
// response/protocol JSON so no valid existing Result becomes unreadable.
export const EXECUTOR_CONTROL_FRAME_LIMIT_BYTES = 33 * 1024 * 1024;

export type ExecutorControlMethod =
  | "createTask"
  | "getStatus"
  | "getResult"
  | "continueTask"
  | "cancelTask"
  | "getEvents"
  | "getFeedback"
  | "getAttention"
  | "replyToInteraction"
  | "health";

export interface ExecutorControlRequest {
  readonly protocol_version: typeof EXECUTOR_CONTROL_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly method: ExecutorControlMethod;
  readonly params: Record<string, unknown>;
  readonly idempotency_key?: string;
}

export interface ExecutorControlError {
  readonly code: string;
  readonly message: string;
}

export interface ExecutorControlResponse {
  readonly protocol_version: typeof EXECUTOR_CONTROL_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: ExecutorControlError;
  readonly executor_state: {
    readonly state: "active" | "shutdown_pending" | "lease_unknown" | "closed";
    readonly lease_id: string;
  };
}

export interface ExecutorControlParamsByMethod {
  createTask: { readonly task: TaskPackage };
  getStatus: { readonly task_id: string };
  getResult: { readonly task_id: string };
  continueTask: { readonly input: ContinueTaskInput };
  cancelTask: { readonly task_id: string };
  getEvents: { readonly input: GetEventsInput };
  getFeedback: { readonly task_id: string };
  getAttention: { readonly task_id: string };
  replyToInteraction: { readonly input: ZCodeInteractionReplyInput };
  health: Record<string, never>;
}

export type ExecutorControlResultByMethod = Record<string, unknown>;
