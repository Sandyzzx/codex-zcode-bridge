import type {
  ContinueTaskInput,
  GetEventsInput,
  ProgressTaskManager,
  TaskAttentionSnapshot,
  TaskFeedbackSnapshotV01,
  TaskPackage,
  TaskProgressPage,
  TaskReceipt,
  TaskResult,
  TaskStatusRecord,
  ZCodeInteractionReplyInput,
} from "../interfaces.js";
import type {
  ExecutorTaskManagement,
  ListTasksInput,
  TaskListPage,
} from "../task-list.js";
import { TaskManagerError, type TaskManagerErrorCode } from "../task-errors.js";
import type { ExecutorControlClient } from "./control-client.js";
import type {
  ExecutorControlMethod,
  ExecutorControlParamsByMethod,
} from "./protocol.js";

const TASK_MANAGER_ERROR_CODES = new Set<TaskManagerErrorCode>([
  "TASK_NOT_FOUND",
  "TASK_NOT_FINISHED",
  "TASK_ALREADY_EXISTS",
  "TASK_ID_CONFLICT",
  "CONTINUE_OPERATION_CONFLICT",
  "BRIDGE_BUSY",
  "REQUEST_QUEUE_TIMEOUT",
  "TASK_INVALID",
  "TASK_STATE",
  "CANCEL_FAILED",
  "EXECUTOR_STORE_CLOSE_UNKNOWN",
  "interaction_reply_outcome_unknown",
]);

export class RemoteTaskManager implements ProgressTaskManager, ExecutorTaskManagement {
  readonly #client: ExecutorControlClient;

  constructor(client: ExecutorControlClient) {
    this.#client = client;
  }

  async #call<M extends ExecutorControlMethod>(
    method: M,
    params: ExecutorControlParamsByMethod[M],
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    await this.#client.connect();
    const response = await this.#client.request(
      method,
      params,
      undefined,
      idempotencyKey,
    );
    if (!response.ok) {
      const code = response.error?.code ?? "EXECUTOR_REQUEST_FAILED";
      if (TASK_MANAGER_ERROR_CODES.has(code as TaskManagerErrorCode)) {
        throw new TaskManagerError(
          code as TaskManagerErrorCode,
          response.error?.message ?? code,
        );
      }
      const error = new Error(response.error?.message ?? "EXECUTOR_REQUEST_FAILED") as Error & { code?: string };
      error.code = code;
      throw error;
    }
    return response.result ?? {};
  }

  async createTask(task: TaskPackage): Promise<TaskReceipt> {
    return this.#call("createTask", { task }, task.task_id) as unknown as TaskReceipt;
  }

  async listTasks(input: ListTasksInput = {}): Promise<TaskListPage> {
    return this.#call("listTasks", input) as unknown as TaskListPage;
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    return this.#call("getStatus", { task_id: taskId }) as unknown as TaskStatusRecord;
  }

  async getResult(taskId: string): Promise<TaskResult> {
    return this.#call("getResult", { task_id: taskId }) as unknown as TaskResult;
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskReceipt> {
    return this.#call(
      "continueTask",
      { input },
      input.operation_id ?? `${input.task_id}:continue`,
    ) as unknown as TaskReceipt;
  }

  async cancelTask(taskId: string): Promise<TaskStatusRecord> {
    return this.#call("cancelTask", { task_id: taskId }) as unknown as TaskStatusRecord;
  }

  async getEvents(input: GetEventsInput): Promise<TaskProgressPage> {
    return this.#call("getEvents", { input }) as unknown as TaskProgressPage;
  }

  async getFeedback(taskId: string): Promise<TaskFeedbackSnapshotV01> {
    return this.#call("getFeedback", { task_id: taskId }) as unknown as TaskFeedbackSnapshotV01;
  }

  async getAttention(taskId: string): Promise<TaskAttentionSnapshot> {
    return this.#call("getAttention", { task_id: taskId }) as unknown as TaskAttentionSnapshot;
  }

  async replyToInteraction(input: ZCodeInteractionReplyInput): Promise<{ task_id: string; request_id: string; state: "answered" }> {
    return this.#call("replyToInteraction", { input }) as unknown as { task_id: string; request_id: string; state: "answered" };
  }
}
