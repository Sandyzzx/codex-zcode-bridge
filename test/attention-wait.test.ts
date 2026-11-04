import assert from "node:assert/strict";
import test from "node:test";
import type {
  ContinueTaskInput,
  GetEventsInput,
  ProgressTaskManager,
  TaskAttentionSnapshot,
  TaskPackage,
  TaskProgressPage,
  TaskReceipt,
  TaskResult,
  TaskStatusRecord,
  ZCodeInteractionReplyInput,
} from "../src/interfaces.js";
import { BridgeTaskManager } from "../src/manager/task-manager.js";
import { TaskManagerError } from "../src/manager/errors.js";
import type { TaskStore } from "../src/store/task-store.js";

class FakeAttentionAuthority implements ProgressTaskManager {
  readonly attentionReads: string[] = [];
  readonly eventReads: GetEventsInput[] = [];
  readonly attention: TaskAttentionSnapshot[];
  #attentionIndex = 0;

  constructor(attention: TaskAttentionSnapshot[]) {
    this.attention = attention;
  }

  async getAttention(taskId: string): Promise<TaskAttentionSnapshot> {
    this.attentionReads.push(taskId);
    const value = this.attention[Math.min(this.#attentionIndex, this.attention.length - 1)]!;
    this.#attentionIndex += 1;
    return { ...value, task_id: taskId };
  }

  async getEvents(input: GetEventsInput): Promise<TaskProgressPage> {
    this.eventReads.push(input);
    return {
      task_id: input.task_id,
      status: "running",
      events: [{ seq: 1, at: "2026-11-02T00:00:00.000Z", type: "model_output", summary: "ordinary progress" }],
      next_seq: 1,
      has_more: false,
    };
  }

  async createTask(_task: TaskPackage): Promise<TaskReceipt> { throw new Error("unused"); }
  async getStatus(_taskId: string): Promise<TaskStatusRecord> { throw new Error("unused"); }
  async getResult(_taskId: string): Promise<TaskResult> { throw new Error("unused"); }
  async continueTask(_input: ContinueTaskInput): Promise<TaskReceipt> { throw new Error("unused"); }
  async cancelTask(_taskId: string): Promise<TaskStatusRecord> { throw new Error("unused"); }
  async replyToInteraction(_input: ZCodeInteractionReplyInput): Promise<{ task_id: string; request_id: string; state: "answered" }> {
    throw new Error("unused");
  }
}

function managerFor(authority: FakeAttentionAuthority): BridgeTaskManager {
  return new BridgeTaskManager({ lifecycleAuthority: authority, pollIntervalMs: 0 });
}

const running = (attempt = 1, pending: string[] = []): TaskAttentionSnapshot => ({
  task_id: "task_1",
  attempt,
  status: "running",
  pending_requests: pending,
});

test("attention wait ignores ordinary events and ends on a current-Attempt pending request", async () => {
  const authority = new FakeAttentionAuthority([running(), running(1, ["request-1"])]);
  const manager = managerFor(authority);
  const started = Date.now();
  const page = await manager.getEvents({ task_id: "task_1", after_seq: 0, wait_ms: 350, wait_for: "attention" });
  assert.ok(Date.now() - started >= 200, "ordinary event page must not wake attention mode");
  assert.equal(page.events[0]?.type, "model_output");
  assert.equal(page.next_seq, 1);
  assert.deepEqual(page.attention, running(1, ["request-1"]));
  assert.equal(authority.eventReads.length, 1);
  assert.equal(authority.eventReads[0]?.wait_ms, 0);
});

test("attention wait returns a terminal snapshot without polling", async () => {
  const authority = new FakeAttentionAuthority([{ task_id: "task_1", attempt: 2, status: "completed", pending_requests: [] }]);
  const manager = managerFor(authority);
  const page = await manager.getEvents({ task_id: "task_1", wait_ms: 25_000, wait_for: "attention" });
  assert.equal(page.status, "completed");
  assert.equal(page.attention?.attempt, 2);
  assert.equal(authority.attentionReads.length, 2, "one read for the wait and one final authoritative read");
});

test("attention wait ends when the Attempt changes", async () => {
  const authority = new FakeAttentionAuthority([running(1), { ...running(2), status: "queued" }]);
  const manager = managerFor(authority);
  const page = await manager.getEvents({ task_id: "task_1", wait_ms: 350, wait_for: "attention" });
  assert.equal(page.status, "queued");
  assert.equal(page.attention?.attempt, 2);
  assert.deepEqual(page.attention?.pending_requests, []);
});

test("attention read failures are not converted into empty success", async () => {
  const authority = new FakeAttentionAuthority([running(), running(1, ["request-1"])]);
  authority.getAttention = async (taskId: string): Promise<TaskAttentionSnapshot> => {
    authority.attentionReads.push(taskId);
    if (authority.attentionReads.length === 1) return running();
    throw new TaskManagerError("TASK_STATE", "SQLite attention read failed: interaction_reply_outcome_unknown");
  };
  const manager = managerFor(authority);
  await assert.rejects(
    manager.getEvents({ task_id: "task_1", wait_ms: 350, wait_for: "attention" }),
    (error: unknown) => error instanceof TaskManagerError
      && error.code === "TASK_STATE"
      && /interaction_reply_outcome_unknown/u.test(error.message),
  );
  assert.equal(authority.eventReads.length, 0, "the event cursor must not be read or advanced after an Attention failure");
});

test("attention validates cursor inputs before entering the wait loop", async () => {
  const authority = new FakeAttentionAuthority([running()]);
  const manager = managerFor(authority);
  const started = Date.now();
  await assert.rejects(
    manager.getEvents({ task_id: "task_1", wait_ms: 25_000, wait_for: "attention", scan_cursor: "not-a-cursor" }),
    (error: unknown) => error instanceof TaskManagerError
      && error.code === "TASK_INVALID"
      && /scan_cursor/u.test(error.message),
  );
  assert.ok(Date.now() - started < 1_000, "invalid input must fail without waiting for attention");
  assert.equal(authority.attentionReads.length, 0);
  assert.equal(authority.eventReads.length, 0);
});

test("JSON Authority explicitly rejects attention waiting", async () => {
  const manager = new BridgeTaskManager({
    store: {} as TaskStore,
    workspaceProvider: {
      resolve: async (requestedPath) => ({ requestedPath, canonicalPath: requestedPath, mode: "direct" }),
      release: async () => undefined,
    },
  });
  await assert.rejects(
    manager.getEvents({ task_id: "task_1", wait_for: "attention" }),
    (error: unknown) => error instanceof TaskManagerError
      && error.code === "TASK_STATE"
      && /unsupported for the JSON Authority/u.test(error.message),
  );
});
