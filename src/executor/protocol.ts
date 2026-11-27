import type {
  ContinueTaskInput,
  GetEventsInput,
  TaskAdmission,
  ZCodeInteractionReplyInput,
} from "../interfaces.js";
import {
  consoleTaskListInputSchema,
  listTasksInputSchema,
  type ConsoleTaskListInput,
  type ListTasksInput,
} from "../task-list.js";
import * as z from "zod/v4";
import {
  zcodeContinueInputSchema,
  zcodeDefaultModelInputSchema,
  zcodeEventsInputSchema,
  zcodeInteractionReplyInputSchema,
  zcodeModelCatalogInputSchema,
  zcodeTaskInputSchema,
  type ZcodeTaskInput,
} from "../api-schemas.js";

export const EXECUTOR_CONTROL_PROTOCOL_VERSION = 1 as const;
// getResult can return the full 32 MiB TaskResult. Keep a 1 MiB allowance for
// response/protocol JSON so no valid existing Result becomes unreadable.
export const EXECUTOR_CONTROL_FRAME_LIMIT_BYTES = 33 * 1024 * 1024;

export type ExecutorControlMethod =
  | "createTask"
  | "listTasks"
  | "listConsoleTasks"
  | "getConsoleTaskDetail"
  | "getStatus"
  | "getResult"
  | "getResultPage"
  | "continueTask"
  | "cancelTask"
  | "getEvents"
  | "getFeedback"
  | "getAttention"
  | "replyToInteraction"
  | "listModels"
  | "getDefaultModel"
  | "setDefaultModel"
  | "clearDefaultModel"
  | "doctor"
  | "executorStatus"
  | "shutdown"
  | "health";

interface ExecutorControlRequestBase<M extends ExecutorControlMethod> {
  readonly protocol_version: typeof EXECUTOR_CONTROL_PROTOCOL_VERSION;
  readonly request_id: string;
  readonly method: M;
  readonly params: ExecutorControlParamsByMethod[M];
  readonly idempotency_key?: string;
}

export type ExecutorControlRequest = {
  [M in ExecutorControlMethod]: ExecutorControlRequestBase<M>;
}[ExecutorControlMethod];

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
  createTask: { readonly task: ZcodeTaskInput; readonly admission?: TaskAdmission };
  listTasks: ListTasksInput;
  listConsoleTasks: ConsoleTaskListInput;
  getConsoleTaskDetail: { readonly task_id: string };
  getStatus: { readonly task_id: string };
  getResult: { readonly task_id: string; readonly view?: "summary" | "full" };
  getResultPage: { readonly task_id: string; readonly offset_bytes: number; readonly max_bytes: number };
  continueTask: { readonly input: ContinueTaskInput };
  cancelTask: { readonly task_id: string };
  getEvents: { readonly input: GetEventsInput };
  getFeedback: { readonly task_id: string };
  getAttention: { readonly task_id: string };
  replyToInteraction: { readonly input: ZCodeInteractionReplyInput };
  listModels: { readonly workspace: string };
  getDefaultModel: Record<string, never>;
  setDefaultModel: {
    readonly provider_id: string;
    readonly model_id: string;
    readonly reasoning_level?: string;
  };
  clearDefaultModel: Record<string, never>;
  doctor: Record<string, never>;
  executorStatus: Record<string, never>;
  shutdown: Record<string, never>;
  health: Record<string, never>;
}

export type ExecutorControlResultByMethod = Record<string, unknown>;

const nonEmptyString = z.string().min(1);
const emptyParams = z.strictObject({});
const taskAdmissionSchema = z.strictObject({
  owner_thread_id: z.string().nullable(),
  source: z.enum(["mcp_meta", "mcp_meta_missing", "mcp_meta_invalid", "non_host_admission"]),
}).refine(
  (value) => (value.source === "mcp_meta") === (value.owner_thread_id !== null),
  { message: "owner_thread_id must be present only for mcp_meta admission" },
);

export const executorControlParamsSchemas: {
  readonly [M in ExecutorControlMethod]: z.ZodType<ExecutorControlParamsByMethod[M]>;
} = {
  createTask: z.strictObject({ task: zcodeTaskInputSchema, admission: taskAdmissionSchema.optional() }),
  listTasks: listTasksInputSchema,
  listConsoleTasks: consoleTaskListInputSchema,
  getConsoleTaskDetail: z.strictObject({ task_id: nonEmptyString }),
  getStatus: z.strictObject({ task_id: nonEmptyString }),
  getResult: z.strictObject({ task_id: nonEmptyString, view: z.enum(["summary", "full"]).optional() }),
  getResultPage: z.strictObject({ task_id: nonEmptyString, offset_bytes: z.number().int().nonnegative(), max_bytes: z.number().int().min(1024).max(4_194_304) }),
  continueTask: z.strictObject({ input: zcodeContinueInputSchema }),
  cancelTask: z.strictObject({ task_id: nonEmptyString }),
  getEvents: z.strictObject({ input: zcodeEventsInputSchema }),
  getFeedback: z.strictObject({ task_id: nonEmptyString }),
  getAttention: z.strictObject({ task_id: nonEmptyString }),
  replyToInteraction: z.strictObject({ input: zcodeInteractionReplyInputSchema }),
  listModels: zcodeModelCatalogInputSchema,
  getDefaultModel: emptyParams,
  setDefaultModel: zcodeDefaultModelInputSchema,
  clearDefaultModel: emptyParams,
  doctor: emptyParams,
  executorStatus: emptyParams,
  shutdown: emptyParams,
  health: emptyParams,
};

/** Validate a method's parameters before an Executor-side cast or dispatch. */
export function parseExecutorControlParams<M extends ExecutorControlMethod>(
  method: M,
  params: unknown,
): ExecutorControlParamsByMethod[M] {
  const parsed = executorControlParamsSchemas[method].safeParse(params);
  if (!parsed.success) {
    throw Object.assign(new Error("EXECUTOR_CONTROL_REQUEST_INVALID"), {
      code: "EXECUTOR_CONTROL_REQUEST_INVALID",
    });
  }
  return parsed.data;
}
