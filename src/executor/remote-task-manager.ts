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
import type { ExecutorControlClient } from "./control-client.js";
import type { ExecutorControlResponse } from "./protocol.js";

export class RemoteTaskManager implements ProgressTaskManager {
  readonly #client: ExecutorControlClient;

  constructor(client: ExecutorControlClient) {
    this.#client = client;
  }

  async #call(method: Parameters<ExecutorControlClient["request"]>[0], params: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.#client.connect();
    const { idempotency_key: idempotencyKey, ...transportParams } = params;
    const response = await this.#client.request(
      method,
      transportParams,
      undefined,
      typeof idempotencyKey === "string" ? idempotencyKey : undefined,
    );
    if (!response.ok) {
      const error = new Error(response.error?.message ?? "EXECUTOR_REQUEST_FAILED") as Error & { code?: string };
      error.code = response.error?.code ?? "EXECUTOR_REQUEST_FAILED";
      throw error;
    }
    return response.result ?? {};
  }

  async createTask(task: TaskPackage): Promise<TaskReceipt> {
    return this.#call("createTask", { task, idempotency_key: task.task_id }) as unknown as TaskReceipt;
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    return this.#call("getStatus", { task_id: taskId }) as unknown as TaskStatusRecord;
  }

  async getResult(taskId: string): Promise<TaskResult> {
    return this.#call("getResult", { task_id: taskId }) as unknown as TaskResult;
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskReceipt> {
    return this.#call("continueTask", { input, idempotency_key: input.operation_id ?? `${input.task_id}:continue` }) as unknown as TaskReceipt;
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
