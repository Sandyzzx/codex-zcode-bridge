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
import { TaskManagerError } from "../manager/errors.js";

/**
 * Keeps the legacy in-process MCP Manager on the same lifetime lease as a
 * background Executor. Reads remain available, but lease uncertainty fences
 * every lifecycle mutation.
 */
export class LeaseGuardedTaskManager implements ProgressTaskManager {
  readonly #delegate: ProgressTaskManager;
  readonly #leaseSafe: () => boolean;

  constructor(delegate: ProgressTaskManager, leaseSafe: () => boolean) {
    this.#delegate = delegate;
    this.#leaseSafe = leaseSafe;
  }

  #assertMutationAllowed(): void {
    if (!this.#leaseSafe()) {
      throw new TaskManagerError(
        "TASK_STATE",
        "SQLite lifecycle authority is fenced because Executor lifetime lease ownership is unknown",
      );
    }
  }

  async createTask(task: TaskPackage): Promise<TaskReceipt> {
    this.#assertMutationAllowed();
    return this.#delegate.createTask(task);
  }

  async getStatus(taskId: string): Promise<TaskStatusRecord> {
    return this.#delegate.getStatus(taskId);
  }

  async getResult(taskId: string): Promise<TaskResult> {
    return this.#delegate.getResult(taskId);
  }

  async continueTask(input: ContinueTaskInput): Promise<TaskReceipt> {
    this.#assertMutationAllowed();
    return this.#delegate.continueTask(input);
  }

  async cancelTask(taskId: string): Promise<TaskStatusRecord> {
    this.#assertMutationAllowed();
    return this.#delegate.cancelTask(taskId);
  }

  async getEvents(input: GetEventsInput): Promise<TaskProgressPage> {
    return this.#delegate.getEvents(input);
  }

  async getFeedback(taskId: string): Promise<TaskFeedbackSnapshotV01> {
    if (!this.#delegate.getFeedback) throw new Error("FEEDBACK_UNAVAILABLE");
    return this.#delegate.getFeedback(taskId);
  }

  async getAttention(taskId: string): Promise<TaskAttentionSnapshot> {
    if (!this.#delegate.getAttention) throw new Error("ATTENTION_UNAVAILABLE");
    return this.#delegate.getAttention(taskId);
  }

  async replyToInteraction(input: ZCodeInteractionReplyInput): Promise<{ task_id: string; request_id: string; state: "answered" }> {
    this.#assertMutationAllowed();
    return this.#delegate.replyToInteraction(input);
  }
}
