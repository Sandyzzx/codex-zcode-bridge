// C1 ledger regressions: identity persistence, definition validation,
// idempotency/revision fencing, journal integrity, view consistency, and
// export privacy. Each test names its acceptance item.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LedgerStore } from "../src/ledger/store.js";
import { LedgerError } from "../src/ledger/types.js";

interface Fixture {
  root: string;
  workspace: string;
  cleanup: () => Promise<void>;
}

async function makeLedgerFixture(): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-bridge-ledger-"));
  const workspace = path.join(root, "project");
  mkdirSync(workspace, { recursive: true });
  return {
    root,
    workspace,
    cleanup: async () => { rmSync(root, { recursive: true, force: true }); },
  };
}

const AC = [
  { id: "AC1", text: "登录不再崩溃" },
  { id: "AC2", text: "回归测试覆盖" },
];

test("C1-01: task identity survives restarts, new executors, and worktrees; a moved project needs an explicit rebind", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "演示项目", workspace: fx.workspace }, "op-p1");
    const task = store.createTask({ goal: "修复登录", acceptance_criteria: AC, workspace: fx.workspace }, "op-t1");
    assert.equal(task.status, "backlog");
    // Reopen (new "session/executor"): identity preserved.
    const reopened = LedgerStore.open(fx.root);
    assert.equal(reopened.getTask(task.task_id).goal, "修复登录");
    assert.equal(reopened.revision, store.revision);
    // The ledger binds the workspace explicitly; a moved directory is NOT
    // auto-adopted by opening the old ledger, and a fresh root never silently
    // takes over the other path's history.
    const movedRoot = path.join(fx.root, "moved");
    mkdirSync(movedRoot, { recursive: true });
    assert.throws(() => LedgerStore.open(movedRoot), /no task ledger exists/, "a new root is opt-in");
    const rebound = LedgerStore.open(fx.root);
    const projectId = reopened.summary().project_id;
    rebound.rebindProject(projectId, movedRoot, "op-rebind");
    const after = LedgerStore.open(fx.root);
    assert.equal(after.getTask(task.task_id).task_id, task.task_id, "rebind keeps task identity");
    assert.equal(after.summary(projectId).project_id, projectId);
  } finally { await fx.cleanup(); }
});

test("C1-02: invalid definitions are rejected without overwriting anything", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-p");
    assert.throws(() => store.createTask({ goal: "", acceptance_criteria: AC, workspace: fx.workspace }, "op-bad1"), /goal/);
    assert.throws(() => store.createTask({ goal: "g", acceptance_criteria: [], workspace: fx.workspace }, "op-bad2"), /acceptance criteria/);
    store.createTask({ goal: "first", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-dup" }, "op-dup1");
    assert.throws(() => store.createTask({ goal: "second", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-dup" }, "op-dup2"), /duplicate task id/);
    // Dependency cycles are refused at creation and at update.
    const a = store.createTask({ goal: "A", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-a" }, "op-a");
    const b = store.createTask({ goal: "B", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-b", dependencies: [a.task_id] }, "op-b2");
    assert.throws(() => store.updateTask(a.task_id, { dependencies: [b.task_id] }, "op-cycle"), /cycle/);
    // Foreign content in an empty .agent-ledger is never overwritten.
    const foreignRoot = path.join(fx.root, "foreign-case");
    const foreignLedger = path.join(foreignRoot, ".agent-ledger", "tasks");
    mkdirSync(foreignLedger, { recursive: true });
    writeFileSync(path.join(foreignLedger, "keep.json"), JSON.stringify({ goal: "用户已有的定义" }));
    assert.throws(() => LedgerStore.open(foreignRoot, { create: true }), /foreign content/, "initialization refuses to clobber user content");
    assert.equal(readFileSync(path.join(foreignLedger, "keep.json"), "utf8").includes("用户已有的定义"), true, "user data preserved");
  } finally { await fx.cleanup(); }
});

test("C1-03: concurrent writers conflict on revision; identical operation replay is side-effect free; different input with the same id is refused", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-p");
    const revision = store.revision;
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-x" }, "op-x", { source: "host", id: "a" });
    // Same operation id + same input: replay returns the recorded result with no new event.
    const before = store.revision;
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-x" }, "op-x", { source: "host", id: "a" });
    assert.equal(store.revision, before, "replay must not append");
    // Same operation id + different input: conflict.
    assert.throws(() => store.createTask({ goal: "DIFFERENT", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-y" }, "op-x"), /belongs to different input/);
    // Two writers declaring the same expected revision: one wins, one conflicts.
    const second = LedgerStore.open(fx.root);
    const atRevision = store.revision;
    store.updateTask("pt-x", { assignee: "alice" }, "op-u1", { source: "host", id: "a" }, atRevision);
    assert.throws(() => second.updateTask("pt-x", { assignee: "bob" }, "op-u2", { source: "host", id: "b" }, atRevision), /revision conflict/);
    assert.equal(LedgerStore.open(fx.root).getTask("pt-x").assignee, "alice");
    assert.ok(store.revision >= revision);
  } finally { await fx.cleanup(); }
});

test("C1-03: operation replay survives reopen, returns complete records, and derives omitted IDs deterministically", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    const generatedProjectInput = { title: "Generated project", workspace: fx.workspace };
    const generatedProject = store.createProject(generatedProjectInput, "op-project-generated");
    const projectInput = { project_id: "proj-replay", title: "Replay project", workspace: fx.workspace };
    const project = store.createProject(projectInput, "op-project-replay");
    const taskInput = { goal: "Replay task", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-replay" };
    const task = store.createTask(taskInput, "op-task-replay");
    const generatedTask = store.createTask({ goal: "Generated ID", acceptance_criteria: AC, workspace: fx.workspace }, "op-task-generated");
    const generatedRunInput = { task_id: generatedTask.task_id, executor: { kind: "manual" as const }, manual_evidence: "run evidence" };
    const generatedRun = store.startRun(generatedRunInput, "op-run-generated");
    const revision = store.revision;

    const reopened = LedgerStore.open(fx.root);
    const replayedGeneratedProject = reopened.createProject(generatedProjectInput, "op-project-generated");
    const replayedProject = reopened.createProject(projectInput, "op-project-replay");
    const replayedTask = reopened.createTask(taskInput, "op-task-replay");
    const replayedGeneratedTask = reopened.createTask({ goal: "Generated ID", acceptance_criteria: AC, workspace: fx.workspace }, "op-task-generated");
    const replayedGeneratedRun = reopened.startRun(generatedRunInput, "op-run-generated");

    assert.equal(reopened.revision, revision, "replays after reopen must not append events");
    assert.deepEqual(replayedGeneratedProject, generatedProject);
    assert.deepEqual(replayedProject, project);
    assert.deepEqual(replayedTask, task);
    assert.deepEqual(replayedGeneratedTask, generatedTask);
    assert.deepEqual(replayedGeneratedRun, generatedRun);
    assert.ok(replayedTask.acceptance_criteria.length > 0, "replay returns the full record, not an ID-only summary");
    assert.throws(() => reopened.createProject({ ...projectInput, title: "Changed" }, "op-project-replay"), /belongs to different input/);
  } finally { await fx.cleanup(); }
});

test("C1-04: a torn tail is not a commit; mid-file corruption blocks mutations; the snapshot rebuilds from the journal", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-p");
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-j" }, "op-j");
    // (a) Torn trailing half-line: ignored on reload, no phantom commit.
    const journal = path.join(fx.root, ".agent-ledger", "ledger", "journal.jsonl");
    const good = readFileSync(journal, "utf8");
    writeFileSync(journal, `${good}{"event_id":"torn","revi`);
    const afterTorn = LedgerStore.open(fx.root);
    assert.equal(afterTorn.getTask("pt-j").goal, "T");
    assert.equal(afterTorn.revision, 2, "the torn tail is not a commit");
    // (b) Corruption mid-file blocks mutations.
    const lines = good.trimEnd().split("\n");
    lines.splice(1, 0, "{this is not json}");
    writeFileSync(journal, `${lines.join("\n")}\n`);
    // open() refuses a corrupt journal (LEDGER_CORRUPT): no partial state is
    // ever served, so no mutation can slip through either.
    try {
      LedgerStore.open(fx.root);
      assert.fail("opening a corrupt journal must fail");
    } catch (error) {
      assert.equal(error instanceof LedgerError && error.code === "LEDGER_CORRUPT", true);
    }
    // (c) Restore a good journal; delete the snapshot; the store rebuilds.
    writeFileSync(journal, good);
    LedgerStore.resetSnapshot(fx.root);
    assert.equal(existsSync(path.join(fx.root, ".agent-ledger", "ledger", "snapshot.json")), false);
    const rebuilt = LedgerStore.open(fx.root);
    assert.equal(rebuilt.getTask("pt-j").goal, "T");
    assert.equal(existsSync(path.join(fx.root, ".agent-ledger", "ledger", "snapshot.json")), true, "snapshot cache rebuilt");
    assert.equal(rebuilt.revision, 2);
  } finally { await fx.cleanup(); }
});

test("C1-05: summary, detail, and history agree for one revision; leaf tasks are not double counted", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-p");
    const parent = store.createTask({ goal: "epic", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-epic" }, "op-e1");
    const leaf1 = store.createTask({ goal: "leaf 1", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-l1" }, "op-l1");
    store.createTask({ goal: "leaf 2", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-l2", dependencies: [leaf1.task_id], epic_id: parent.task_id }, "op-l2");
    // Only the host may cancel; cancelled stays in the denominator.
    store.transitionTask("pt-l1", "ready", "op-r1");
    store.startRun({ task_id: "pt-l1", executor: { kind: "manual" }, manual_evidence: "手工修复记录" }, "op-run1");
    store.transitionTask("pt-l1", "in_progress", "op-i1");
    // The run finishes with an implementation report, then the task is
    // IMPLEMENTED — available for review, not accepted.
    store.updateRun(store.getTask("pt-l1").run_ids[0]!, {
      status: "finished",
      report_ref: { summary: "手工修复完成", files_changed: ["src/login.ts"], tests: [{ command: "npm test", status: "passed" }] },
    }, "op-run2", { source: "manual", id: "tech-writer" });
    store.transitionTask("pt-l1", "implemented", "op-imp1");
    const review = store.recordReview({
      task_id: "pt-l1",
      results: [{ ac_id: "AC1", verdict: "pass", evidence: "checked" }, { ac_id: "AC2", verdict: "pass", evidence: "tests" }],
      deliverable_fingerprints: [{ path: "src/a.ts", sha256: "aaa" }],
      verdict: "approved",
    }, "op-rev1", { source: "host", id: "reviewer-1" });
    assert.equal(review.review.verdict, "approved");
    store.completeTask({ task_id: "pt-l1", delivery: { accepted: true, workspace: fx.workspace, evidence: "已合并到项目工作区" } }, "op-done1");
    const summary = store.summary();
    assert.equal(summary.total_leaf_tasks, 2, "the epic parent is not a leaf");
    assert.equal(summary.accepted_leaf_tasks, 1);
    assert.equal(summary.cancelled_leaf_tasks, 0);
    assert.match(summary.coverage_note, /不是整体工程完成度/);
    const history = store.taskHistory("pt-l1");
    const revisions = history.map((entry) => entry.revision);
    assert.equal(new Set(revisions).size, revisions.length, "history rows are distinct events");
    assert.equal(store.revision, Math.max(...revisions), "history and state agree on one revision");
    // No fake percentage: the summary reports counts with a coverage note.
    assert.ok(!JSON.stringify(summary).match(/\d+%/), "no percentage without coverage");
  } finally { await fx.cleanup(); }
});

test("C1-06: exports and views carry no credentials, reasoning, or session content", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-p");
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-s" }, "op-s");
    store.startRun({ task_id: "pt-s", executor: { kind: "zcode-bridge" }, executor_ref: "bridge_task_9" }, "op-run");
    store.updateRun(store.listTasks()[0]!.run_ids[0]!, {
      status: "finished",
      report_ref: { summary: "done", files_changed: ["a.ts"], tests: [{ command: "npm test", status: "passed" }] },
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    }, "op-run2", { source: "bridge", id: "bridge-1" });
    const exported = JSON.stringify(store.export());
    assert.ok(!exported.includes("reasoning"), "no hidden reasoning in exports");
    assert.ok(!exported.includes("session"), "no session content in exports");
    assert.ok(!/sk-[a-z0-9]/i.test(exported), "no credential-shaped values in exports");
    // The summary view likewise stays bounded.
    const summary = JSON.stringify(store.summary());
    assert.ok(!summary.includes("reasoning"));
  } finally { await fx.cleanup(); }
});

test("C3: rejected review replay remains idempotent after its task returns to ready", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-review-p");
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-review-reject" }, "op-review-task");
    store.startRun({ task_id: "pt-review-reject", executor: { kind: "manual" }, manual_evidence: "implementation record" }, "op-review-run");
    store.transitionTask("pt-review-reject", "in_progress", "op-review-start");
    store.transitionTask("pt-review-reject", "implemented", "op-review-implemented");
    const input = {
      task_id: "pt-review-reject",
      results: [{ ac_id: "AC1", verdict: "fail" as const, evidence: "not done" }, { ac_id: "AC2", verdict: "pass" as const, evidence: "checked" }],
      deliverable_fingerprints: [{ path: "src/a.ts", sha256: "aaa" }],
      verdict: "rejected" as const,
      reason: "AC1 is incomplete",
    };
    const first = store.recordReview(input, "op-review-rejected", { source: "host", id: "reviewer" });
    const revision = store.revision;
    const reopened = LedgerStore.open(fx.root);
    const replayed = reopened.recordReview(input, "op-review-rejected", { source: "host", id: "reviewer" });
    assert.equal(reopened.revision, revision);
    assert.deepEqual(replayed, first);
    assert.equal(replayed.task.status, "ready");
    assert.equal(replayed.review.review_id, first.review.review_id);
  } finally { await fx.cleanup(); }
});

test("C3: a rejected review still replays across reopen after the rework started a new run", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-rej2-p");
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-rej2" }, "op-rej2-t");
    store.startRun({ task_id: "pt-rej2", executor: { kind: "manual" }, manual_evidence: "第一轮实施" }, "op-rej2-run1");
    store.transitionTask("pt-rej2", "in_progress", "op-rej2-ip1");
    store.transitionTask("pt-rej2", "implemented", "op-rej2-imp1");
    const input = {
      task_id: "pt-rej2",
      results: [{ ac_id: "AC1", verdict: "fail" as const, evidence: "未完成" }, { ac_id: "AC2", verdict: "pass" as const, evidence: "checked" }],
      deliverable_fingerprints: [{ path: "src/a.ts", sha256: "aaa" }],
      verdict: "rejected" as const,
      reason: "AC1 未完成",
    };
    const first = store.recordReview(input, "op-rej2-review", { source: "host", id: "reviewer" });
    assert.equal(first.task.status, "ready");
    assert.equal(first.review.run_id, store.getTask("pt-rej2").run_ids[0], "the rejection binds the run current at review time");
    // The rework takes a NEW run; the old review operation must still replay
    // against its original binding, not conflict on the moved run pointer.
    store.startRun({ task_id: "pt-rej2", executor: { kind: "manual" }, manual_evidence: "返工第二轮" }, "op-rej2-run2");
    const revision = store.revision;
    const reopened = LedgerStore.open(fx.root);
    const replayed = reopened.recordReview(input, "op-rej2-review", { source: "host", id: "reviewer" });
    assert.equal(reopened.revision, revision, "replay after a new run must not append");
    assert.deepEqual(replayed, first);
    assert.equal(replayed.review.run_id, first.review.run_id);
    // Different review input under the same operation id is still a conflict.
    assert.throws(() => reopened.recordReview({ ...input, verdict: "approved" }, "op-rej2-review", { source: "host", id: "reviewer" }), /belongs to different input/);
  } finally { await fx.cleanup(); }
});

test("C1-03: exemption replay is idempotent across reopen; the store-generated granted_at is not part of the input", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-ex-p");
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-ex" }, "op-ex-t");
    const exempted = store.exemptAc("pt-ex", "AC2", { authorized_by: "master", reason: "环境不可用，豁免本轮" }, "op-ex-exempt", { source: "host", id: "master" });
    const revision = store.revision;
    const reopened = LedgerStore.open(fx.root);
    const replayed = reopened.exemptAc("pt-ex", "AC2", { authorized_by: "master", reason: "环境不可用，豁免本轮" }, "op-ex-exempt", { source: "host", id: "master" });
    assert.equal(reopened.revision, revision, "exemption replay must not append");
    assert.deepEqual(replayed, exempted);
    assert.equal(replayed.ac_exemptions[0]!.ac_id, "AC2");
    assert.throws(() => reopened.exemptAc("pt-ex", "AC2", { authorized_by: "someone-else", reason: "环境不可用，豁免本轮" }, "op-ex-exempt", { source: "host", id: "master" }), /belongs to different input/);
  } finally { await fx.cleanup(); }
});

test("C1-03: updateTask replay returns the recorded change after later edits and terminal states", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-up-p");
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-up" }, "op-up-t");
    const first = store.updateTask("pt-up", { assignee: "alice" }, "op-up-u1");
    const revisionAfterFirst = store.revision;
    // A later definition change (and its version bump) must not turn the
    // recorded operation into a spurious conflict on replay.
    store.updateTask("pt-up", { goal: "T2" }, "op-up-u2");
    const reopened = LedgerStore.open(fx.root);
    const replayed = reopened.updateTask("pt-up", { assignee: "alice" }, "op-up-u1");
    assert.equal(reopened.revision, revisionAfterFirst + 1, "replay appends nothing");
    assert.deepEqual(replayed, first, "the recorded result is returned verbatim");
    assert.equal(replayed.definition_version, 1, "the replayed record is the one from the original operation");
    // After a terminal state the same operation still replays; new input refuses.
    reopened.transitionTask("pt-up", "ready", "op-up-ready");
    reopened.startRun({ task_id: "pt-up", executor: { kind: "manual" }, manual_evidence: "手工" }, "op-up-run");
    reopened.transitionTask("pt-up", "in_progress", "op-up-ip");
    reopened.transitionTask("pt-up", "cancelled", "op-up-cancel", {}, { source: "host", id: "host" });
    assert.throws(() => reopened.updateTask("pt-up", { assignee: "bob" }, "op-up-u3"), /cancelled task/);
    assert.deepEqual(reopened.updateTask("pt-up", { assignee: "alice" }, "op-up-u1"), first);
  } finally { await fx.cleanup(); }
});

test("C1-03: recorded operations replay from the journal even after the task reached DONE", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-dn-p");
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-dn" }, "op-dn-t");
    const ready = store.transitionTask("pt-dn", "ready", "op-dn-ready");
    const started = store.startRun({ task_id: "pt-dn", executor: { kind: "manual" }, manual_evidence: "实施记录" }, "op-dn-run");
    const inProgress = store.transitionTask("pt-dn", "in_progress", "op-dn-ip");
    const implemented = store.transitionTask("pt-dn", "implemented", "op-dn-imp");
    const reviewInput = {
      task_id: "pt-dn",
      results: [{ ac_id: "AC1", verdict: "pass" as const, evidence: "e1" }, { ac_id: "AC2", verdict: "pass" as const, evidence: "e2" }],
      deliverable_fingerprints: [{ path: "src/a.ts", sha256: "h" }],
      verdict: "approved" as const,
    };
    const review = store.recordReview(reviewInput, "op-dn-review", { source: "host", id: "reviewer" });
    const done = store.completeTask({ task_id: "pt-dn", delivery: { accepted: true, workspace: fx.workspace, evidence: "已接收" } }, "op-dn-done");
    const revision = store.revision;

    const reopened = LedgerStore.open(fx.root);
    assert.equal(reopened.revision, revision);
    assert.deepEqual(reopened.transitionTask("pt-dn", "ready", "op-dn-ready"), ready);
    assert.deepEqual(reopened.startRun({ task_id: "pt-dn", executor: { kind: "manual" }, manual_evidence: "实施记录" }, "op-dn-run"), started);
    assert.deepEqual(reopened.transitionTask("pt-dn", "in_progress", "op-dn-ip"), inProgress);
    assert.deepEqual(reopened.transitionTask("pt-dn", "implemented", "op-dn-imp"), implemented);
    const reviewReplay = reopened.recordReview(reviewInput, "op-dn-review", { source: "host", id: "reviewer" });
    assert.deepEqual(reviewReplay.review, review.review);
    assert.deepEqual(reopened.completeTask({ task_id: "pt-dn", delivery: { accepted: true, workspace: fx.workspace, evidence: "已接收" } }, "op-dn-done"), done);
    assert.equal(reopened.getTask("pt-dn").status, "done");
    assert.equal(reopened.revision, revision, "no replay appended an event");
  } finally { await fx.cleanup(); }
});

test("C3-02: a direct transition to done is refused; completion only passes the review gate", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-gp");
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-gate2" }, "op-gt");
    assert.throws(() => store.transitionTask("pt-gate2", "done", "op-g-bypass"), /review\/DONE gate/);
    assert.throws(() => store.transitionTask("pt-gate2", "done", "op-g-bypass2", {}, { source: "bridge", id: "bridge-1" }), /review\/DONE gate/);
    assert.equal(store.getTask("pt-gate2").status, "backlog", "the bypass never landed");
    assert.equal(store.revision, 2, "refused transitions append nothing");
  } finally { await fx.cleanup(); }
});

test("ledger errors are typed and the done-gate refuses unmet criteria", async () => {
  const fx = await makeLedgerFixture();
  try {
    const store = LedgerStore.open(fx.root, { create: true });
    store.createProject({ title: "P", workspace: fx.workspace }, "op-p");
    store.createTask({ goal: "T", acceptance_criteria: AC, workspace: fx.workspace, task_id: "pt-g" }, "op-g");
    try {
      store.completeTask({ task_id: "pt-g", delivery: { accepted: true, workspace: fx.workspace, evidence: "x" } }, "op-c1");
      assert.fail("complete must refuse without a review");
    } catch (error) {
      assert.equal(error instanceof LedgerError && error.code === "LEDGER_STATE", true);
    }
  } finally { await fx.cleanup(); }
});
