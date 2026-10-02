import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { runWorkerTask } from "../src/worker/run-task.js";
import { loadPersistedRuntimeEnvironment } from "../src/runtime/resolver.js";
import { buildContinuePrompt, buildTaskPrompt } from "../src/prompts/task-prompt.js";
import { buildTaskResult } from "../src/manager/normalize.js";
import { FakeAdapter, fakeOutcome, makeManagerFixture } from "./manager-helpers.js";
import { withProcessLock } from "../src/store/process-lock.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const storeUrl = new URL("../src/store/task-store.js", import.meta.url).href;
const workerUrl = new URL("../src/worker/run-task.js", import.meta.url).href;
const managerUrl = new URL("../src/manager/task-manager.js", import.meta.url).href;
const providerUrl = new URL("../src/workspace/direct-provider.js", import.meta.url).href;

function childScript(source: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("two real workers can enter an attempt only once; terminal and stale attempts never execute", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask(), new Date().toISOString());
    const calls = path.join(fx.dataRoot, "calls.jsonl");
    const source = `import {runWorkerTask} from ${JSON.stringify(workerUrl)}; import {appendFileSync} from 'node:fs';
      const adapter = { startTask: async x => { appendFileSync(${JSON.stringify(calls)}, JSON.stringify(x.attempt)+'\\n'); return {}; }, getResult: async () => { await new Promise(r=>setTimeout(r,200)); return ${JSON.stringify(fakeOutcome())}; } };
      try { await runWorkerTask({dataRoot:${JSON.stringify(fx.dataRoot)},taskId:'task_1',attempt:1,adapter}); } catch(e) { if (!/claimed|stale|terminal/.test(String(e))) throw e; }`;
    const outcomes = await Promise.all([childScript(source), childScript(source)]);
    for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.output);
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
    const adapter = new FakeAdapter();
    await assert.rejects(runWorkerTask({ dataRoot: fx.dataRoot, taskId: "task_1", attempt: 1, adapter }), /claimed|terminal/);
    fx.store.writeStatus("task_1", { status: "queued", attempt: 2 });
    await assert.rejects(runWorkerTask({ dataRoot: fx.dataRoot, taskId: "task_1", attempt: 1, adapter }), /stale/);
    assert.equal(adapter.calls.length, 0);
    assert.throws(() => fx.store.writeResult("task_1", { ...fx.store.readArchivedResult("task_1", 1)!, attempt: 1 }), /stale/);
  } finally { await fx.cleanup(); }
});

test("separate manager processes serialize submissions sharing an execution directory", async () => {
  const fx = await makeManagerFixture();
  try {
    const calls = path.join(fx.dataRoot, "spawns.jsonl");
    const source = (taskId: string) => `import {TaskStore} from ${JSON.stringify(storeUrl)}; import {BridgeTaskManager} from ${JSON.stringify(managerUrl)}; import {DirectWorkspaceProvider} from ${JSON.stringify(providerUrl)}; import {appendFileSync} from 'node:fs';
      const manager=new BridgeTaskManager({store:new TaskStore(${JSON.stringify(fx.dataRoot)}),workspaceProvider:new DirectWorkspaceProvider(),pollIntervalMs:0,isProcessRunning:()=>true,spawnWorker:()=>{appendFileSync(${JSON.stringify(calls)},'spawn\\n');return {pid:process.pid};}});
      await manager.createTask(${JSON.stringify(fx.makeTask({ task_id: taskId }))}); manager.dispose();`;
    const outcomes = await Promise.all([childScript(source("one")), childScript(source("two"))]);
    for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.output);
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
    assert.deepEqual([fx.store.readStatus("one").status, fx.store.readStatus("two").status].sort(), ["queued", "running"]);
  } finally { await fx.cleanup(); }
});

test("interaction answers are attempt-scoped and parameter collisions are refused", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask(), new Date().toISOString());
    const request = { request_id: "rpc-1", method: "interaction/requestPermission" as const, params: { sessionId: "session-one", input: { command: "safe" } } };
    fx.store.writeInteractionRequest("task_1", request);
    fx.store.answerInteractionRequest("task_1", "rpc-1", { decision: "allow" });
    assert.throws(() => fx.store.writeInteractionRequest("task_1", { ...request, params: { sessionId: "other" } }), /collision/);
    fx.store.writeStatus("task_1", { attempt: 2 });
    assert.equal(fx.store.readInteractionRequest("task_1", "rpc-1"), null);
    const next = fx.store.writeInteractionRequest("task_1", { ...request, params: { input: { command: "different" } } });
    assert.equal(next.created, true);
    assert.equal(next.record.state, "pending");
    assert.equal(next.record.answer, undefined);
  } finally { await fx.cleanup(); }
});

test("invalid existing runtime settings fail closed while missing settings permit discovery", async () => {
  const fx = await makeManagerFixture();
  try {
    const host = { name: "test-host", settingsDirectory: path.join(fx.dataRoot, "settings") };
    assert.equal(loadPersistedRuntimeEnvironment({ ZCODE_BRIDGE_MODE: "build" }, fx.dataRoot, host).ZCODE_BRIDGE_MODE, "build");
    mkdirSync(host.settingsDirectory);
    for (const invalid of ["{broken", "[]", JSON.stringify({ ZCODE_BRIDGE_MODE: 42 }), " ".repeat(65_537)]) {
      writeFileSync(path.join(host.settingsDirectory, "runtime-config.json"), invalid);
      assert.throws(() => loadPersistedRuntimeEnvironment({}, fx.dataRoot, host), /runtime setting|runtime settings/);
    }
  } finally { await fx.cleanup(); }
});

test("oversized constraints are rejected before accepting a task or continuation", async () => {
  const fx = await makeManagerFixture();
  try {
    const task = fx.makeTask({ requirements: ["r".repeat(65_000)], forbidden_paths: ["never-touch"] });
    assert.throws(() => buildTaskPrompt(task), /exceeds/);
    await assert.rejects(fx.manager.createTask(task), /exceeds/);
    assert.equal(fx.store.hasTask("task_1"), false);
    assert.throws(() => buildContinuePrompt({ task: fx.makeTask(), feedback: "f".repeat(65_000), additionalRequirements: [], previousSessionId: null, previousResult: null }), /exceeds/);
  } finally { await fx.cleanup(); }
});

test("corrupt status is isolated and does not block a healthy unrelated task", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask({ task_id: "corrupt" }), new Date().toISOString());
    writeFileSync(path.join(fx.store.taskDir("corrupt"), "status.json"), "{invalid");
    await fx.manager.createTask(fx.makeTask({ task_id: "healthy", workspace: fx.dataRoot }));
    await fx.manager.recoverTasks();
    assert.equal((await fx.manager.getStatus("healthy")).status, "running");
    await assert.rejects(fx.manager.getStatus("corrupt"), /JSON/);
  } finally { await fx.cleanup(); }
});

test("continuation preparation survives interruption and old results cannot finish new attempts", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    await fx.runWorker("task_1", new FakeAdapter());
    const original = await fx.manager.getResult("task_1");
    fx.store.archiveResultToAttempt("task_1", 1);
    await fx.manager.recoverTasks();
    assert.deepEqual(await fx.manager.getResult("task_1"), original);
    fx.store.writeStatus("task_1", { status: "queued", attempt: 2 });
    assert.equal(fx.store.readResult("task_1"), null);
  } finally { await fx.cleanup(); }
});

test("runtime cancellation normalizes to cancelled without an invalid-report failure", () => {
  const result = buildTaskResult({ task: { task_id: "cancelled" } as never, attempt: 1, startedAt: null, finishedAt: new Date().toISOString(), outcome: { ...fakeOutcome("adapterFailed"), cancelled: true, errorCode: "cancelled" } });
  assert.equal(result.status, "cancelled");
  assert.equal(result.needs_master_decision, false);
});

test("a known session survives adapter failure and is supplied to continuation", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    const adapter = new FakeAdapter();
    adapter.getResult = async () => { fx.store.writeStatus("task_1", { zcode_session_id: "known-session" }); throw new Error("turn failed"); };
    await fx.runWorker("task_1", adapter);
    assert.equal((await fx.manager.getResult("task_1")).session_id, "known-session");
    await fx.manager.continueTask({ task_id: "task_1", feedback: "retry safely" });
    assert.equal(fx.store.readAttemptMeta("task_1", 2, "continue.json")?.previous_session_id, "known-session");
  } finally { await fx.cleanup(); }
});

test("cleanup failure reserves the execution path until termination is verified", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    await fx.runWorker("task_1", new FakeAdapter());
    fx.store.writeStatus("task_1", { cleanup_unverified: true, zcode_pid: 4444 });
    await fx.manager.createTask(fx.makeTask({ task_id: "later" }));
    assert.equal((await fx.manager.getStatus("later")).status, "queued");
    await assert.rejects(fx.manager.continueTask({ task_id: "task_1", feedback: "retry" }), /cleanup/);
    fx.setTerminateError(new Error("kill failed"));
    await assert.rejects(fx.manager.cancelTask("task_1"), /cleanup/);
    assert.equal((await fx.manager.getStatus("later")).status, "queued");
    fx.setTerminateError(null);
    await fx.manager.cancelTask("task_1");
    assert.equal((await fx.manager.getStatus("later")).status, "running");
  } finally { await fx.cleanup(); }
});

test("process lock protects asynchronous sections across manager instances", async () => {
  const fx = await makeManagerFixture();
  try {
    const events: string[] = [];
    const lock = path.join(fx.dataRoot, "test.lock");
    await Promise.all([1, 2].map((id) => withProcessLock(lock, async () => { events.push(`begin${id}`); await delay(50); events.push(`end${id}`); })));
    assert.deepEqual(events, ["begin1", "end1", "begin2", "end2"]);
  } finally { await fx.cleanup(); }
});

test("cancelling an orphaned live runtime reaches a terminal state before releasing queued work", async () => {
  const fx = await makeManagerFixture();
  try {
    await fx.manager.createTask(fx.makeTask());
    fx.store.writeStatus("task_1", { zcode_pid: 4444, zcode_session_id: "orphan-session" });
    fx.pidsAlive.delete(fx.spawned[0]!.pid);
    fx.pidsAlive.add(4444);
    assert.equal((await fx.manager.getStatus("task_1")).status, "running");
    assert.equal(fx.store.readStatus("task_1").cleanup_unverified, true);
    await fx.manager.createTask(fx.makeTask({ task_id: "later" }));
    const result = await fx.manager.cancelTask("task_1");
    assert.equal(result.status, "cancelled");
    assert.equal((await fx.manager.getResult("task_1")).session_id, "orphan-session");
    assert.equal((await fx.manager.getStatus("later")).status, "running");
    assert.deepEqual(fx.terminateCalls, [4444]);
  } finally { await fx.cleanup(); }
});

test("a worker already in flight cannot overwrite a later attempt", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask(), new Date().toISOString());
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const adapter = new FakeAdapter();
    adapter.getResult = async () => { await waiting; return fakeOutcome(); };
    const run = runWorkerTask({ dataRoot: fx.dataRoot, taskId: "task_1", attempt: 1, adapter });
    await delay(20);
    fx.store.writeStatus("task_1", { status: "running", attempt: 2, worker_pid: 2222 });
    finish();
    await assert.rejects(run, /stale/);
    assert.equal(fx.store.readResult("task_1"), null);
    assert.equal(fx.store.readStatus("task_1").worker_pid, 2222);
  } finally { await fx.cleanup(); }
});

test("event append reads only a tail byte and paged Unicode events remain complete", async () => {
  const fx = await makeManagerFixture();
  try {
    fx.store.createTask(fx.makeTask(), new Date().toISOString());
    const source = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {TaskStore} from ${JSON.stringify(storeUrl)};
      let fullReads=0;const original=fs.readFileSync;fs.readFileSync=function(file,...args){if(String(file).endsWith('events.jsonl'))fullReads++;return original.call(this,file,...args);};syncBuiltinESMExports();
      const store=new TaskStore(${JSON.stringify(fx.dataRoot)});for(let i=0;i<250;i++)store.appendEvent('task_1','model_output','文字🙂'.repeat(200));console.log(fullReads);`;
    const result = await childScript(source);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.output.trim(), "0");
    let cursor = 0;
    const sequences: number[] = [];
    while (true) {
      const page = fx.store.readEvents("task_1", cursor, 37);
      for (const event of page.events) { assert.equal(event.summary, "文字🙂".repeat(200)); sequences.push(event.seq); }
      cursor = page.nextSeq;
      if (!page.hasMore) break;
    }
    assert.deepEqual(sequences, Array.from({ length: 250 }, (_, index) => index + 1));
  } finally { await fx.cleanup(); }
});
