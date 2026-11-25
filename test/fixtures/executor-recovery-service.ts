import type { TaskPackage } from "../../src/interfaces.js";
import { startExecutorService, type ExecutorAuthority } from "../../src/executor/service.js";

const [dataRoot, bridgeEntryPath, workerEntryPath] = process.argv.slice(2);
if (!dataRoot || !bridgeEntryPath || !workerEntryPath) {
  throw new Error("data root, bridge entry, and worker entry are required");
}

const idleAuthority: ExecutorAuthority = {
  async createTask(task: TaskPackage) {
    return { task_id: task.task_id, status: "queued", created_at: new Date().toISOString() };
  },
  async getStatus(taskId: string) {
    return {
      task_id: taskId,
      status: "queued",
      attempt: 1,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      started_at: null,
      finished_at: null,
      worker_pid: null,
      zcode_session_id: null,
      exit_code: null,
    };
  },
  async getResult() {
    throw new Error("TASK_NOT_FINISHED");
  },
  async continueTask() {
    throw new Error("TASK_STATE");
  },
  async cancelTask(taskId: string) {
    return this.getStatus(taskId);
  },
  async getEvents(input) {
    return { task_id: input.task_id, status: "queued", events: [], next_seq: 0, has_more: false };
  },
  async getFeedback() {
    throw new Error("FEEDBACK_UNAVAILABLE");
  },
  async getAttention(taskId: string) {
    return { task_id: taskId, attempt: 1, status: "queued", pending_requests: [] };
  },
  async replyToInteraction() {
    throw new Error("TASK_STATE");
  },
  getExecutorIdleState: () => ({ idle: true, blockers: [] }),
  async closeIfIdle() {
    return { closed: true, blockers: [] };
  },
};

const service = await startExecutorService({
  dataRoot,
  bridgeEntryPath,
  testWorkerEntryPath: workerEntryPath,
  testAuthority: idleAuthority,
  acceptUnleasedExistingRoot: true,
});
console.log(`EXECUTOR_READY ${JSON.stringify({ lease_id: service.leaseId, pipe_name: service.pipeName })}`);
await service.closed;
