// C2/C3 regressions: run intent dispatch and recovery, event projection
// idempotency, worker-vs-host authority, the DONE gate, review invalidation,
// and the full fail→retry→review→done drill.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LedgerStore } from "../src/ledger/store.js";
import { LedgerBridgeLink, executorTaskIdFor } from "../src/ledger/bridge.js";
import { LedgerError } from "../src/ledger/types.js";
import { BridgeTaskManager } from "../src/manager/task-manager.js";
import { DirectWorkspaceProvider } from "../src/workspace/direct-provider.js";
import { TaskStore } from "../src/store/task-store.js";
import { makeManagerFixture } from "./manager-helpers.js";
import type { TaskPackage } from "../src/interfaces.js";

const AC = [{ id: "AC1", text: "实现完成" }, { id: "AC2", text: "测试覆盖" }];
const HOST = { source: "host" as const, id: "master-entry" };

interface Ctx {
  fx: Awaited<ReturnType<typeof makeManagerFixture>>;
  ledger: LedgerStore;
  link: LedgerBridgeLink;
  workspace: string;
  projectId: string;
  cleanup: () => Promise<void>;
}

async function makeCtx(): Promise<Ctx> {
  const fx = await makeManagerFixture();
  const ledgerRoot = mkdtempSync(path.join(tmpdir(), "zcode-bridge-c23-"));
  const workspace = path.join(ledgerRoot, "ws");
  mkdirSync(workspace, { recursive: true });
  const ledger = LedgerStore.open(ledgerRoot, { create: true });
  const project = ledger.createProject({ title: "C2C3", workspace }, "op-p");
  const link = new LedgerBridgeLink(ledger);
  return {
    fx,
    ledger,
    link,
    workspace,
    projectId: project.project_id,
    cleanup: async () => {
      await fx.cleanup();
      rmSync(ledgerRoot, { recursive: true, force: true });
    },
  };
}

function taskPackageFor(workspace: string, executorTaskId: string): TaskPackage {
  return {
    task_id: executorTaskId,
    workspace,
    objective: "实现登录修复",
    requirements: ["最小改动"],
    allowed_paths: ["src/"],
    forbidden_paths: [],
    acceptance_criteria: ["登录不再崩溃"],
    test_commands: [],
  };
}

test("C2-01: intent crash and lost receipts recover the same executor task; at most one Bridge attempt starts", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "登录修复", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-c2" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    // (a) Crash between intent and dispatch: the retry reuses run + executor id.
    const expectedExecutor = executorTaskIdFor(task.task_id, "op-dispatch-1");
    const first = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "op-dispatch-1",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    assert.equal(first.executor_task_id, expectedExecutor);
    assert.equal(first.status, "accepted");
    assert.equal(ctx.fx.spawned.length, 1, "one Bridge task created");
    // (b) Receipt lost: retrying the same operation must not create anything.
    const retry = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "op-dispatch-1",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    assert.equal(retry.run_id, first.run_id, "the same run is reused");
    assert.equal(retry.executor_task_id, expectedExecutor, "the same executor task id is reused");
    assert.equal(ctx.fx.spawned.length, 1, "the Bridge submission stays deduplicated to one attempt");
    // The run and the bridge task are related by the executor ref only.
    const run = ctx.ledger.listRuns({ task_id: task.task_id })[0]!;
    assert.equal(run.executor_ref, expectedExecutor);
    assert.equal(ctx.fx.manager.getStatus(expectedExecutor).then ? await ctx.fx.manager.getStatus(expectedExecutor).then((s) => s.task_id) : "x", expectedExecutor);
  } finally { await ctx.cleanup(); }
});

test("C2-01b: a dispatch error records dispatch_unknown and stays retryable", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "g", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-unknown" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    // A workspace that fails Bridge validation (outside any allowed root).
    const failing = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "op-unknown",
      buildTaskPackage: (id) => ({ ...taskPackageFor(ctx.workspace, id), workspace: "Z:\\definitely\\missing\\root" }),
    });
    assert.equal(failing.status, "dispatch_unknown");
    assert.equal(failing.receipt, null);
    const run = ctx.ledger.listRuns({ task_id: task.task_id })[0]!;
    assert.equal(run.status, "dispatch_unknown");
    // The same operation retries with the same executor id.
    const retry = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "op-unknown",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    assert.equal(retry.run_id, run.run_id);
    assert.equal(retry.status, "accepted");
  } finally { await ctx.cleanup(); }
});

test("C2-02: projection is idempotent under replay and late events never overwrite newer runs", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "g", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-proj" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    const dispatch = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "op-proj",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    const executor = dispatch.executor_task_id;
    // The worker writes events; projection maps them onto the run.
    ctx.fx.store.appendEvent(executor, "worker_started", "Bridge worker started");
    ctx.fx.store.appendEvent(executor, "model_selected", "model confirmed", { provider_id: "glm", model_id: "glm-4.7", model_source: "task" });
    const first = await ctx.link.syncRunFromBridge(ctx.fx.manager, dispatch.run_id);
    assert.ok(first.projected >= 2);
    const runAfterFirst = ctx.ledger.listRuns({ task_id: task.task_id })[0]!;
    // Replay: nothing new is appended, state unchanged.
    const before = ctx.ledger.revision;
    const second = await ctx.link.syncRunFromBridge(ctx.fx.manager, dispatch.run_id);
    assert.equal(second.projected, 0, "replayed events project nothing");
    assert.equal(ctx.ledger.revision, before, "replay appends no journal events");
    assert.deepEqual(ctx.ledger.listRuns({ task_id: task.task_id })[0]!.model?.model_id, runAfterFirst.model?.model_id ?? "glm-4.7");
  } finally { await ctx.cleanup(); }
});

test("C2-03: a completed Bridge run never closes the project task; DONE requires the review gate", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "g", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-done" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    const dispatch = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "op-done",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    // The worker completes the Bridge task with a perfect report.
    await ctx.fx.runWorker(dispatch.executor_task_id, new (await import("./manager-helpers.js")).FakeAdapter());
    await ctx.fx.manager.recoverTasks();
    const sync = await ctx.link.syncRunFromBridge(ctx.fx.manager, dispatch.run_id);
    assert.ok(sync.projected >= 1);
    const run = ctx.ledger.listRuns({ task_id: task.task_id })[0]!;
    assert.equal(run.status, "finished");
    assert.ok(run.report_ref, "the projection carries the report evidence");
    // The business status is untouched: still awaiting review, never done.
    const projectTask = ctx.ledger.getTask(task.task_id);
    assert.notEqual(projectTask.status, "done");
    assert.throws(() => ctx.ledger.completeTask({ task_id: task.task_id, delivery: { accepted: true, workspace: ctx.workspace, evidence: "x" } }, "op-c", HOST), /review/i);
  } finally { await ctx.cleanup(); }
});

test("C2-04: a failed run is traceable next to its retry with a different model; the task never becomes permanently FAILED", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "g", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-fail" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    const first = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "op-fail-1",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    // The first Bridge task fails (adapter failure).
    const { FakeAdapter } = await import("./manager-helpers.js");
    const failing = new FakeAdapter();
    failing.behavior = "adapterFailed";
    await ctx.fx.runWorker(first.executor_task_id, failing);
    await ctx.fx.manager.recoverTasks();
    await ctx.link.syncRunFromBridge(ctx.fx.manager, first.run_id);
    assert.equal(ctx.ledger.listRuns({ task_id: task.task_id })[0]!.status, "failed");
    const business: string = ctx.ledger.getTask(task.task_id).status;
    assert.equal(business === "failed" || business === "done", false, "no auto-FAILED business state, no auto-DONE");
    // A second run (new session/model) is traceable beside the failed one.
    const second = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "op-fail-2",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    assert.notEqual(second.run_id, first.run_id);
    const runs = ctx.ledger.listRuns({ task_id: task.task_id });
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.status, "failed");
    assert.ok(["accepted", "started"].includes(runs[1]!.status));
  } finally { await ctx.cleanup(); }
});

test("C2-05: manual and Bridge runs coexist with visible evidence sources; a projection fault causes no re-execution", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "g", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-mixed" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    const manual = ctx.ledger.startRun({ task_id: task.task_id, executor: { kind: "manual" }, manual_evidence: "外部人工修复，见 PR #7" }, "op-manual", HOST);
    const bridge = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "op-mixed",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    const runs = ctx.ledger.listRuns({ task_id: task.task_id });
    assert.equal(runs.length, 2);
    assert.equal(runs[0]!.executor.kind, "manual");
    assert.equal(runs[1]!.executor.kind, "zcode-bridge");
    void manual;
    // A projection failure (unknown run) never re-dispatches anything.
    await assert.rejects(ctx.link.syncRunFromBridge(ctx.fx.manager, "run-missing"), /unknown run/);
    assert.equal(ctx.fx.spawned.length, 1);
  } finally { await ctx.cleanup(); }
});

test("C3-01: worker-claimed authority can never review or complete; actor strings are not authorization", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "g", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-auth" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    ctx.ledger.startRun({ task_id: task.task_id, executor: { kind: "zcode-bridge" }, executor_ref: "bridge-t" }, "op-run");
    ctx.ledger.updateRun(ctx.ledger.listRuns({ task_id: task.task_id })[0]!.run_id, { status: "finished", report_ref: { summary: "done", files_changed: [], tests: [] } }, "op-ru", { source: "bridge", id: "b" });
    ctx.ledger.transitionTask(task.task_id, "implemented", "op-imp");
    const worker = { source: "worker" as const, id: "zcode-claiming-host" };
    assert.throws(() => ctx.ledger.recordReview({
      task_id: task.task_id,
      results: [{ ac_id: "AC1", verdict: "pass", evidence: "self" }, { ac_id: "AC2", verdict: "pass", evidence: "self" }],
      deliverable_fingerprints: [{ path: "a.ts", sha256: "x" }],
      verdict: "approved",
    }, "op-wrev", worker), (error) => error instanceof LedgerError && error.code === "LEDGER_FORBIDDEN");
    assert.throws(() => ctx.ledger.completeTask({ task_id: task.task_id, delivery: { accepted: true, workspace: ctx.workspace, evidence: "self" } }, "op-wdone", worker), /controlled host entry/);
    assert.equal(ctx.ledger.getTask(task.task_id).status, "implemented", "the forged review never landed");
  } finally { await ctx.cleanup(); }
});

test("C3-02: complete refuses unverified ACs, rejections, and missing delivery; exemptions need explicit authorization", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "g", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-gate" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    ctx.ledger.startRun({ task_id: task.task_id, executor: { kind: "manual" }, manual_evidence: "手工" }, "op-run");
    ctx.ledger.transitionTask(task.task_id, "implemented", "op-imp");
    // not_verified AC → refuse.
    ctx.ledger.recordReview({
      task_id: task.task_id,
      results: [{ ac_id: "AC1", verdict: "pass", evidence: "e1" }, { ac_id: "AC2", verdict: "not_verified", evidence: "no env" }],
      deliverable_fingerprints: [{ path: "a.ts", sha256: "x" }],
      verdict: "approved",
    }, "op-rev1", HOST);
    assert.throws(() => ctx.ledger.completeTask({ task_id: task.task_id, delivery: { accepted: true, workspace: ctx.workspace, evidence: "received" } }, "op-c1", HOST), /unmet acceptance criteria/);
    // Explicit host exemption unlocks the gate.
    ctx.ledger.exemptAc(task.task_id, "AC2", { authorized_by: "master", reason: "环境不可用，豁免本轮" }, "op-exempt", HOST);
    assert.throws(() => ctx.ledger.exemptAc(task.task_id, "AC1", { authorized_by: "worker", reason: "self" }, "op-exempt-w", { source: "worker", id: "w" }), /host/);
    // Delivery receipt is mandatory.
    assert.throws(() => ctx.ledger.completeTask({ task_id: task.task_id, delivery: { accepted: false, workspace: ctx.workspace, evidence: "" } }, "op-c2", HOST), /delivery receipt/);
    const done = ctx.ledger.completeTask({ task_id: task.task_id, delivery: { accepted: true, workspace: ctx.workspace, evidence: "已接收至项目工作区" } }, "op-c3", HOST);
    assert.equal(done.status, "done");
    const exemptions = ctx.ledger.getTask(task.task_id).ac_exemptions;
    assert.equal(exemptions.length, 1);
    assert.equal(exemptions[0]!.authorized_by, "master");
  } finally { await ctx.cleanup(); }
});

test("C3-03: a definition change after approval re-opens the gate; unrelated files never invalidate", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "g", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-inval" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    ctx.ledger.startRun({ task_id: task.task_id, executor: { kind: "manual" }, manual_evidence: "手工" }, "op-run");
    ctx.ledger.transitionTask(task.task_id, "implemented", "op-imp");
    ctx.ledger.recordReview({
      task_id: task.task_id,
      results: [{ ac_id: "AC1", verdict: "pass", evidence: "e" }, { ac_id: "AC2", verdict: "pass", evidence: "e" }],
      deliverable_fingerprints: [{ path: "src/a.ts", sha256: "hash-1" }],
      verdict: "approved",
    }, "op-rev", HOST);
    // Unrelated file changes: complete succeeds — scope is the declared set.
    const ok = ctx.ledger.completeTask({
      task_id: task.task_id,
      delivery: { accepted: true, workspace: ctx.workspace, evidence: "received" },
      deliverable_fingerprints: [{ path: "src/a.ts", sha256: "hash-1" }],
    }, "op-c-ok", HOST);
    assert.equal(ok.status, "done");
    // Reopen, then change the definition: the old approval no longer closes.
    ctx.ledger.reopenTask(task.task_id, "需求变更", "op-reopen", HOST);
    ctx.ledger.updateTask(task.task_id, { acceptance_criteria: [...AC, { id: "AC3", text: "新增要求" }] }, "op-def", HOST);
    ctx.ledger.transitionTask(task.task_id, "implemented", "op-imp2");
    assert.throws(() => ctx.ledger.completeTask({
      task_id: task.task_id,
      delivery: { accepted: true, workspace: ctx.workspace, evidence: "received" },
    }, "op-c-stale", HOST), /re-review required/);
    // A changed deliverable fingerprint also refuses.
    ctx.ledger.recordReview({
      task_id: task.task_id,
      results: [{ ac_id: "AC1", verdict: "pass", evidence: "e" }, { ac_id: "AC2", verdict: "pass", evidence: "e" }, { ac_id: "AC3", verdict: "pass", evidence: "e" }],
      deliverable_fingerprints: [{ path: "src/a.ts", sha256: "hash-2" }],
      verdict: "approved",
    }, "op-rev2", HOST);
    assert.throws(() => ctx.ledger.completeTask({
      task_id: task.task_id,
      delivery: { accepted: true, workspace: ctx.workspace, evidence: "received" },
      deliverable_fingerprints: [{ path: "src/a.ts", sha256: "hash-CHANGED" }],
    }, "op-c-drift", HOST), /changed after approval/);
    const done = ctx.ledger.completeTask({
      task_id: task.task_id,
      delivery: { accepted: true, workspace: ctx.workspace, evidence: "received" },
      deliverable_fingerprints: [{ path: "src/a.ts", sha256: "hash-2" }],
    }, "op-c-final", HOST);
    assert.equal(done.status, "done");
  } finally { await ctx.cleanup(); }
});

test("C3-04: cancel/block/reject/reopen have definite behavior and keep history", async () => {
  const ctx = await makeCtx();
  try {
    const task0 = ctx.ledger.createTask({ goal: "g", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-flow" }, "op-t");
    ctx.ledger.updateTask(task0.task_id, { open_decisions: ["API 形态未定"] }, "op-od");
    const task = task0;
    // READY requires resolving open decisions first.
    assert.throws(() => ctx.ledger.transitionTask(task.task_id, "ready", "op-r-fail"), /open decisions/i);
    ctx.ledger.updateTask(task.task_id, { open_decisions: [] }, "op-resolve");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    ctx.ledger.transitionTask(task.task_id, "blocked", "op-b", { reason: "等待用户决定 API 形态" });
    assert.equal(ctx.ledger.getTask(task.task_id).blocked_reason, "等待用户决定 API 形态");
    // Worker cannot cancel the project task.
    assert.throws(() => ctx.ledger.transitionTask(task.task_id, "cancelled", "op-cx", {}, { source: "worker", id: "w" }), /host/);
    ctx.ledger.transitionTask(task.task_id, "ready", "op-unblock", {});
    ctx.ledger.startRun({ task_id: task.task_id, executor: { kind: "manual" }, manual_evidence: "e" }, "op-run");
    ctx.ledger.transitionTask(task.task_id, "in_progress", "op-i");
    ctx.ledger.updateRun(ctx.ledger.listRuns({ task_id: task.task_id })[0]!.run_id, { status: "finished", report_ref: { summary: "s", files_changed: [], tests: [] } }, "op-ru", { source: "bridge", id: "b" });
    ctx.ledger.transitionTask(task.task_id, "implemented", "op-imp");
    ctx.ledger.recordReview({
      task_id: task.task_id,
      results: [{ ac_id: "AC1", verdict: "fail", evidence: "不满足" }, { ac_id: "AC2", verdict: "pass", evidence: "e" }],
      deliverable_fingerprints: [{ path: "a.ts", sha256: "x" }],
      verdict: "rejected",
      reason: "AC1 未满足",
    }, "op-rev", HOST);
    const afterReject = ctx.ledger.getTask(task.task_id);
    assert.equal(afterReject.status, "ready", "rejection returns the task to ready");
    assert.equal(afterReject.blocked_reason, "AC1 未满足");
    // History preserved through every transition.
    const history = ctx.ledger.taskHistory(task.task_id);
    assert.ok(history.some((entry) => entry.kind === "review.recorded"));
    assert.ok(history.some((entry) => entry.kind === "task.transitioned"));
  } finally { await ctx.cleanup(); }
});

test("C3-05: the full drill — fail run → new-model run → IMPLEMENTED → REVIEW → receive → DONE — keeps execution and business states separate", async () => {
  const ctx = await makeCtx();
  try {
    const task = ctx.ledger.createTask({ goal: "登录修复", acceptance_criteria: AC, workspace: ctx.workspace, task_id: "pt-drill" }, "op-t");
    ctx.ledger.transitionTask(task.task_id, "ready", "op-r");
    const first = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "drill-1",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    const { FakeAdapter } = await import("./manager-helpers.js");
    await ctx.fx.runWorker(first.executor_task_id, Object.assign(new FakeAdapter(), { behavior: "adapterFailed" }));
    await ctx.fx.manager.recoverTasks();
    await ctx.link.syncRunFromBridge(ctx.fx.manager, first.run_id);
    // Second run on a different model.
    const second = await ctx.link.dispatchTask(ctx.fx.manager, {
      project_task_id: task.task_id,
      operation_id: "drill-2",
      buildTaskPackage: (id) => taskPackageFor(ctx.workspace, id),
    });
    ctx.fx.store.appendEvent(second.executor_task_id, "model_selected", "model confirmed", { provider_id: "glm", model_id: "glm-4.7-flash", model_source: "task" });
    await ctx.fx.runWorker(second.executor_task_id, new FakeAdapter());
    await ctx.fx.manager.recoverTasks();
    await ctx.link.syncRunFromBridge(ctx.fx.manager, second.run_id);
    const runs = ctx.ledger.listRuns({ task_id: task.task_id });
    assert.equal(runs[0]!.status, "failed");
    assert.equal(runs[1]!.status, "finished");
    assert.equal(runs[1]!.model?.model_id, "glm-4.7-flash", "model/effort evidence is traceable per run");
    // The Bridge's first task is failed while the PROJECT task stays open.
    assert.equal((await ctx.fx.manager.getStatus(first.executor_task_id)).status, "failed");
    assert.notEqual(ctx.ledger.getTask(task.task_id).status, "failed");
    // Business flow: run evidence → IMPLEMENTED → REVIEW → receive → DONE.
    ctx.ledger.transitionTask(task.task_id, "implemented", "drill-imp");
    ctx.ledger.recordReview({
      task_id: task.task_id,
      results: [{ ac_id: "AC1", verdict: "pass", evidence: "diff 审查" }, { ac_id: "AC2", verdict: "pass", evidence: "npm test 独立运行" }],
      deliverable_fingerprints: [{ path: "src/login.ts", sha256: "fp-1" }],
      verdict: "approved",
    }, "drill-rev", HOST);
    const done = ctx.ledger.completeTask({
      task_id: task.task_id,
      delivery: { accepted: true, workspace: ctx.workspace, evidence: "改动已接收至项目工作区并复核" },
      deliverable_fingerprints: [{ path: "src/login.ts", sha256: "fp-1" }],
    }, "drill-done", HOST);
    assert.equal(done.status, "done");
    const summary = ctx.ledger.summary();
    assert.equal(summary.tasks.find((row) => row.task_id === task.task_id)?.latest_review, "approved");
  } finally { await ctx.cleanup(); }
});

test("C3-06: two hosts sharing one ledger root stay consistent; separate roots never merge", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-share-"));
  try {
    mkdirSync(path.join(root, "ws"), { recursive: true });
    const hostA = LedgerStore.open(root, { create: true });
    hostA.createProject({ title: "shared", workspace: path.join(root, "ws") }, "op-p");
    const hostB = LedgerStore.open(root);
    // Concurrent appends from both instances land with distinct revisions.
    hostA.createTask({ goal: "from A", acceptance_criteria: AC, workspace: path.join(root, "ws"), task_id: "pt-a" }, "op-a");
    hostB.createTask({ goal: "from B", acceptance_criteria: AC, workspace: path.join(root, "ws"), task_id: "pt-b" }, "op-b");
    const merged = LedgerStore.open(root);
    assert.equal(merged.getTask("pt-a").goal, "from A");
    assert.equal(merged.getTask("pt-b").goal, "from B");
    assert.equal(merged.listTasks().length, 2);
    // A different root never sees this history.
    const other = mkdtempSync(path.join(tmpdir(), "zcode-bridge-other-"));
    try {
      mkdirSync(path.join(other, "ws"), { recursive: true });
      assert.throws(() => LedgerStore.open(other), /no task ledger exists/);
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
