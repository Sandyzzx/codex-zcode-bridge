// TaskStore tests: atomic JSON persistence, bounded separate logs, terminal
// results, attempt archives, and task-id path safety.
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/store/task-store.js";
import { makeTask, makeTempDir, removeTempDir } from "./helpers.js";

test("create/read roundtrip and duplicate rejection", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    const createdAt = "2026-09-27T00:00:00.000Z";
    store.createTask(makeTask(), createdAt);
    assert.equal(store.readTask("task_1").objective, makeTask().objective);
    const status = store.readStatus("task_1");
    assert.equal(status.status, "queued");
    assert.equal(status.attempt, 1);
    assert.equal(status.created_at, createdAt);
    assert.deepEqual(store.listTaskIds(), ["task_1"]);
    assert.throws(() => store.createTask(makeTask(), createdAt), /already exists/);
    assert.equal(store.readResult("task_1"), null);
  } finally {
    await removeTempDir(root);
  }
});

test("task evidence uses private POSIX permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows access is controlled by inherited ACLs rather than POSIX mode bits");
    return;
  }
  const root = await makeTempDir("store-private");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask({ task_id: "private_task" }), new Date().toISOString());
    store.appendLog("private_task", "stdout", "private evidence");
    assert.equal(statSync(path.join(root, ".tasks")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(root, ".tasks", "private_task")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(root, ".tasks", "private_task", "task.json")).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(root, ".tasks", "private_task", "stdout.log")).mode & 0o777, 0o600);
  } finally {
    await removeTempDir(root);
  }
});

test("invalid task ids are rejected before touching the filesystem", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    for (const bad of ["../evil", "a/b", ".hidden", "x".repeat(65), ""]) {
      assert.throws(
        () => store.taskDir(bad),
        /invalid task_id/,
        `expected rejection for ${JSON.stringify(bad)}`,
      );
    }
    assert.throws(
      () => store.createTask(makeTask({ task_id: "../evil" }), "2026-09-27T00:00:00.000Z"),
      /invalid task_id/,
    );
    assert.deepEqual(store.listTaskIds(), []);
  } finally {
    await removeTempDir(root);
  }
});

test("writeStatus merges patches, bumps updated_at, and leaves no temp files", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    const updated = store.writeStatus("task_1", {
      status: "running",
      worker_pid: 4242,
      started_at: "2026-09-27T00:00:01.000Z",
    });
    assert.equal(updated.status, "running");
    assert.equal(updated.worker_pid, 4242);
    assert.equal(updated.attempt, 1, "unpatched fields survive the merge");
    const reread = store.readStatus("task_1");
    assert.equal(reread.worker_pid, 4242);
    // Nulls clear optional fields.
    store.writeStatus("task_1", { worker_pid: null });
    assert.equal(store.readStatus("task_1").worker_pid, null);
    // No *.tmp leftovers anywhere in the task dir.
    const leftovers = readdirSync(path.join(root, ".tasks", "task_1"), { recursive: true })
      .filter((name) => String(name).endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await removeTempDir(root);
  }
});

test("corrupt status records are reported, not silently accepted", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(root, ".tasks", "task_1", "status.json"), "{{{", "utf8");
    assert.throws(() => store.readStatus("task_1"));
  } finally {
    await removeTempDir(root);
  }
});

test("logs are append-only, separate, and byte-bounded", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root, { maxLogBytes: 64 });
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    assert.equal(store.appendLog("task_1", "stdout", "o".repeat(200)).truncated, true);
    assert.equal(store.appendLog("task_1", "stderr", "e".repeat(10)).truncated, false);
    const stdout = store.readLog("task_1", "stdout");
    const stderr = store.readLog("task_1", "stderr");
    assert.ok(Buffer.byteLength(stdout, "utf8") <= 64);
    assert.equal(stderr, "e".repeat(10), "stderr must not be affected by the stdout cap");
    // Further appends beyond the cap are dropped.
    store.appendLog("task_1", "stdout", "more");
    assert.equal(Buffer.byteLength(store.readLog("task_1", "stdout"), "utf8"), 64);
  } finally {
    await removeTempDir(root);
  }
});

test("result.json exists only after a terminal write; archive moves it into attempts/", async () => {
  const root = await makeTempDir("store");
  try {
    const store = new TaskStore(root);
    store.createTask(makeTask(), "2026-09-27T00:00:00.000Z");
    assert.equal(store.readResult("task_1"), null);
    const result = {
      task_id: "task_1",
      status: "completed" as const,
      summary: "done",
      files_changed: [],
      tests: [],
      issues: [],
      needs_master_decision: false,
      zcode_output: "",
      exit_code: 0,
      session_id: "sess_x",
      attempt: 1,
      started_at: null,
      finished_at: "2026-09-27T00:00:05.000Z",
    };
    store.writeResult("task_1", result);
    assert.equal(store.readResult("task_1")?.summary, "done");
    store.writeAttemptMeta("task_1", 1, "outcome.json", { ok: true });
    store.writeAttemptFile("task_1", 1, "prompt.txt", "PROMPT TEXT");
    store.archiveResultToAttempt("task_1", 1);
    assert.equal(store.readResult("task_1"), null, "result.json must move out of the task dir");
    assert.equal(store.readArchivedResult("task_1", 1)?.summary, "done");
    assert.deepEqual(store.readAttemptMeta("task_1", 1, "outcome.json"), { ok: true });
    assert.equal(store.readAttemptText("task_1", 1, "prompt.txt"), "PROMPT TEXT");
    assert.ok(existsSync(path.join(root, ".tasks", "task_1", "attempts", "1", "result.json")));
  } finally {
    await removeTempDir(root);
  }
});
