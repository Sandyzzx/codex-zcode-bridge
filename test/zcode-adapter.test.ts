// ZCodeAdapter unit tests with a fake spawn and fake tree termination: argv
// construction (including paths with spaces/Chinese), child environment pair,
// JSON envelope/report handling, nonzero exits, transient retries, timeout,
// cancellation, resume verification, and prompt-file cleanup. No model calls.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { BridgeError } from "../src/runtime/errors.js";
import { ZCodeAdapter, type ZCodeRunOutcome } from "../src/adapters/zcode-adapter.js";
import type { TerminateProcessTree } from "../src/adapters/process-spawn.js";
import {
  FakeSpawn,
  SESSION_ID,
  TRANSIENT_STDERR,
  makeTask,
  makeTempDir,
  makeWorkspace,
  fakeConfig,
  removeTempDir,
  stubResolver,
  successEnvelope,
  validReport,
} from "./helpers.js";

interface Fixture {
  fake: FakeSpawn;
  adapter: ZCodeAdapter;
  promptDir: string;
  terminateCalls: number[];
  cleanup: () => Promise<void>;
}

async function makeFixture(options: {
  timeoutMs?: number;
  maxOutputBytes?: number;
  retryBackoffMs?: number;
  maxTransientRetries?: number;
} = {}): Promise<Fixture> {
  const fake = new FakeSpawn();
  const terminateCalls: number[] = [];
  const terminate: TerminateProcessTree = async (pid) => {
    terminateCalls.push(pid);
    const record = fake.recordForPid(pid);
    record?.child.emitClose(null, "SIGKILL");
    return { pid, signal: "SIGKILL", verified: true };
  };
  const promptDir = await makeTempDir("prompt");
  const adapter = new ZCodeAdapter({
    resolver: stubResolver(),
    spawnImpl: fake.spawnFn,
    terminateProcessTreeImpl: terminate,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
    retryBackoffMs: options.retryBackoffMs ?? 1,
    maxTransientRetries: options.maxTransientRetries ?? 2,
    promptTmpDir: promptDir,
    childEnvBase: { PATH: "C:\\Windows", ZCODE_HTTP_PROXY: "http://127.0.0.1:9", ZCODE_STALE: "1", ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION: "1", PRIVATE_API_TOKEN: "do-not-inherit" },
  });
  return {
    fake,
    adapter,
    promptDir,
    terminateCalls,
    cleanup: () => removeTempDir(promptDir),
  };
}

test("invocation uses an argv array with the loader, forwards frozen switches, and injects only the provider pair", async () => {
  const fx = await makeFixture();
  try {
    const workspaceDir = "C:\\work dir 中文\\demo";
    fx.fake.script.push((child, record) => {
      record.promptContent = readFileSync(record.args[2]!, "utf8");
      child.emitStdout(successEnvelope(validReport()));
      child.emitClose(0, null);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(workspaceDir),
      attempt: 1,
    });
    const outcome = (await fx.adapter.getResult(handle)) as ZCodeRunOutcome;
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.errorCode, null);
    assert.equal(outcome.reportError, null);

    assert.equal(fx.fake.records.length, 1);
    const record = fx.fake.records[0]!;
    assert.equal(record.file, "node-fake");
    assert.deepEqual(record.args.slice(3), ["--json", "--mode", "yolo", "--cwd", workspaceDir]);
    assert.ok(!record.args.some((arg) => arg.includes("--max-turns")));
    assert.equal(record.options.cwd, workspaceDir);
    assert.equal(record.options.shell, false);
    assert.match(record.args[0]!, /zcode-loader\.cjs$/);
    assert.equal(record.args[1], "C:\\fake\\zcode.cjs");

    const zcodeEnvKeys = Object.keys(record.options.env).filter((key) => key.startsWith("ZCODE_"));
    assert.deepEqual(zcodeEnvKeys.sort(), [
      "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    ]);
    assert.equal(record.options.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, "C:\\fake\\zcode-builtin.json");
    assert.equal(record.options.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, "C:\\fake\\provider_config.json");
    assert.equal(record.options.env.ZCODE_HTTP_PROXY, undefined);
    assert.equal(record.options.env.PATH, "C:\\Windows");

    assert.ok(record.promptContent!.includes(makeTask().objective));
    assert.ok(record.promptContent!.includes("needs_master_decision"));
    assert.ok(!existsSync(record.args[2]!), "prompt file must be removed after the run");
    assert.ok(record.args[2]!.startsWith(fx.promptDir));
  } finally {
    await fx.cleanup();
  }
});

test("successful run normalizes envelope and AgentReport", async () => {
  const fx = await makeFixture();
  try {
    fx.fake.script.push((child) => {
      child.emitStdout(successEnvelope(validReport()));
      child.emitClose(0, null);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const outcome = await fx.adapter.getResult(handle);
    assert.equal(outcome.sessionId, SESSION_ID);
    assert.equal(outcome.agentReport?.summary, "Created the requested file");
    assert.deepEqual(outcome.agentReport?.files_changed, ["bridge-smoke.txt"]);
    assert.equal(outcome.agentReport?.needs_master_decision, false);
    assert.deepEqual(outcome.usage, { source: "provider", totalTokens: 100 });
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.attempts, 1);
  } finally {
    await fx.cleanup();
  }
});

test("report embedded in prose is extracted; needs_master_decision=true is preserved", async () => {
  const fx = await makeFixture();
  try {
    const report = validReport({ needs_master_decision: true, issues: ["unsure about scope"] });
    fx.fake.script.push((child) => {
      child.emitStdout(
        JSON.stringify({
          sessionId: SESSION_ID,
          response: `I finished.\n\nHere is my report:\n${JSON.stringify(report, null, 2)}\nThanks!`,
        }),
      );
      child.emitClose(0, null);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const outcome = await fx.adapter.getResult(handle);
    assert.equal(outcome.errorCode, null);
    assert.equal(outcome.agentReport?.needs_master_decision, true);
    assert.deepEqual(outcome.agentReport?.issues, ["unsure about scope"]);
  } finally {
    await fx.cleanup();
  }
});

test("exit 0 with non-JSON stdout is invalid_json and never a success", async () => {
  const fx = await makeFixture();
  try {
    fx.fake.script.push((child) => {
      child.emitStdout("hello, not json at all");
      child.emitClose(0, null);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const outcome = await fx.adapter.getResult(handle);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.errorCode, "invalid_json");
    assert.equal(outcome.agentReport, null);
    assert.equal(outcome.sessionId, null);
    assert.match(outcome.reportError!, /not a single JSON document/);
    assert.equal(outcome.stdout, "hello, not json at all");
  } finally {
    await fx.cleanup();
  }
});

test("missing needs_master_decision is invalid_agent_report, never synthesized", async () => {
  const fx = await makeFixture();
  try {
    const partial = { summary: "done", files_changed: [], tests: [], issues: [] };
    fx.fake.script.push((child) => {
      child.emitStdout(JSON.stringify({ sessionId: SESSION_ID, response: JSON.stringify(partial) }));
      child.emitClose(0, null);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const outcome = await fx.adapter.getResult(handle);
    assert.equal(outcome.errorCode, "invalid_agent_report");
    assert.equal(outcome.agentReport, null);
    assert.match(outcome.reportError!, /needs_master_decision/);
  } finally {
    await fx.cleanup();
  }
});

test("nonzero exit maps to zcode_nonzero_exit with stderr evidence; JSON is not parsed", async () => {
  const fx = await makeFixture();
  try {
    fx.fake.script.push((child) => {
      child.emitStderr("Error: Model creation failed (traceId: x)");
      child.emitClose(1, null);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const outcome = await fx.adapter.getResult(handle);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.errorCode, "zcode_nonzero_exit");
    assert.equal(outcome.sessionId, null);
    assert.match(outcome.reportError!, /exited with code 1/);
    assert.match(outcome.reportError!, /Model creation failed/);
    assert.equal(fx.fake.records.length, 1, "non-transient failures must not be retried");
  } finally {
    await fx.cleanup();
  }
});

test("transient release error is retried at most twice, then succeeds", async () => {
  const fx = await makeFixture();
  try {
    fx.fake.script.push((child) => {
      child.emitStderr(TRANSIENT_STDERR);
      child.emitClose(1, null);
    });
    fx.fake.script.push((child) => {
      child.emitStderr(TRANSIENT_STDERR);
      child.emitClose(1, null);
    });
    fx.fake.script.push((child) => {
      child.emitStdout(successEnvelope(validReport()));
      child.emitClose(0, null);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const outcome = await fx.adapter.getResult(handle);
    assert.equal(outcome.errorCode, null);
    assert.equal(outcome.sessionId, SESSION_ID);
    assert.equal(outcome.attempts, 3);
    assert.equal(fx.fake.records.length, 3);
  } finally {
    await fx.cleanup();
  }
});

test("persistent transient failure exhausts retries and reports zcode_nonzero_exit", async () => {
  const fx = await makeFixture();
  try {
    for (let i = 0; i < 5; i++) {
      fx.fake.script.push((child) => {
        child.emitStderr(TRANSIENT_STDERR);
        child.emitClose(1, null);
      });
    }
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const outcome = await fx.adapter.getResult(handle);
    assert.equal(outcome.errorCode, "zcode_nonzero_exit");
    assert.equal(outcome.attempts, 3, "initial attempt plus at most two retries");
    assert.equal(fx.fake.records.length, 3);
    assert.match(outcome.reportError!, /均不可用/);
  } finally {
    await fx.cleanup();
  }
});

test("timeout terminates the process tree, reports timeout, and cleans the prompt file", async () => {
  const fx = await makeFixture({ timeoutMs: 30 });
  let promptPathDuringRun: string | null = null;
  try {
    fx.fake.script.push((child, record) => {
      promptPathDuringRun = record.args[2]!;
      // never closes on its own
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const outcome = await fx.adapter.getResult(handle);
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.errorCode, "timeout");
    assert.equal(outcome.agentReport, null);
    assert.match(outcome.reportError!, /wall-clock budget/);
    assert.equal(fx.terminateCalls.length, 1);
    assert.equal(fx.terminateCalls[0], fx.fake.records[0]!.child.pid);
    assert.ok(promptPathDuringRun);
    assert.ok(!existsSync(promptPathDuringRun));
  } finally {
    await fx.cleanup();
  }
});

test("cancelTask terminates the tree and the outcome reports cancelled; repeat cancels are idempotent", async () => {
  const fx = await makeFixture();
  let promptPathDuringRun: string | null = null;
  try {
    fx.fake.script.push((_child, record) => {
      promptPathDuringRun = record.args[2]!;
      // never closes on its own; the terminate fake emits the close
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    await waitForSpawn(fx.adapter, handle);
    await fx.adapter.cancelTask(handle);
    await fx.adapter.cancelTask(handle);
    const outcome = await fx.adapter.getResult(handle);
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.errorCode, "cancelled");
    assert.equal(outcome.timedOut, false);
    assert.equal(fx.terminateCalls.length, 1, "termination must be triggered once");
    const status = await fx.adapter.getStatus(handle);
    assert.equal(status.state, "exited");
    assert.ok(promptPathDuringRun);
    assert.ok(!existsSync(promptPathDuringRun), "prompt file must be removed after cancel");
  } finally {
    await fx.cleanup();
  }
});

test("cancellation whose tree termination cannot be verified throws from cancelTask; a natural clean completion still yields the completed result", async () => {
  const fake = new FakeSpawn();
  const terminate: TerminateProcessTree = async (pid) => {
    void pid;
    // taskkill-style failure: nothing is killed, no close event follows.
    throw new Error("taskkill exited with code 128");
  };
  const promptDir = await makeTempDir("prompt");
  try {
    const adapter = new ZCodeAdapter({
      resolver: stubResolver(),
      spawnImpl: fake.spawnFn,
      terminateProcessTreeImpl: terminate,
      promptTmpDir: promptDir,
      childEnvBase: { PATH: "C:\\Windows", ZCODE_BRIDGE_ALLOW_UNRESTRICTED_EXECUTION: "1" },
    });
    fake.script.push(() => {
      // The stubborn process stays alive until it completes on its own below.
    });
    const handle = await adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    await waitForSpawn(adapter, handle);
    await assert.rejects(adapter.cancelTask(handle), /taskkill exited with code 128/);
    const status = await adapter.getStatus(handle);
    assert.equal(status.state, "running", "task must stay nonterminal when verification fails");
    fake.records[0]!.child.emitStdout(successEnvelope(validReport()));
    fake.records[0]!.child.emitClose(0, null);
    const outcome = await adapter.getResult(handle);
    assert.equal(outcome.errorCode, null, "natural completion after failed cancellation is reported as-is");
    assert.equal(outcome.sessionId, SESSION_ID);
    assert.equal(outcome.cancelled, false);
  } finally {
    await removeTempDir(promptDir);
  }
});

test("continueTask resumes with --resume, rejects workspace switches, and verifies the returned session id", async () => {
  const fx = await makeFixture();
  try {
    // First run establishes the task workspace.
    fx.fake.script.push((child) => {
      child.emitStdout(successEnvelope(validReport()));
      child.emitClose(0, null);
    });
    const startHandle = await fx.adapter.startTask({
      task: makeTask({ task_id: "task_cont" }),
      workspace: makeWorkspace("C:\\work\\same place"),
      attempt: 1,
    });
    await fx.adapter.getResult(startHandle);

    fx.fake.script.push((child, record) => {
      assert.deepEqual(record.args.slice(3), [
        "--json",
        "--mode",
        "yolo",
        "--cwd",
        "C:\\work\\same place",
        "--resume",
        SESSION_ID,
      ]);
      child.emitStdout(successEnvelope(validReport(), SESSION_ID));
      child.emitClose(0, null);
    });
    const continueHandle = await fx.adapter.continueTask({
      task: makeTask({ task_id: "task_cont" }),
      workspace: makeWorkspace("C:\\work\\same place"),
      attempt: 2,
      feedback: "Fix the failing test",
      additionalRequirements: ["Also update the README"],
      previousSessionId: SESSION_ID,
      previousResult: null,
    });
    const outcome = await fx.adapter.getResult(continueHandle);
    assert.equal(outcome.errorCode, null);
    assert.equal(outcome.sessionId, SESSION_ID);
    assert.equal(outcome.attempts, 1);
    const status = await fx.adapter.getStatus(continueHandle);
    assert.equal(status.state, "exited");
  } finally {
    await fx.cleanup();
  }
});

test("continueTask to a different workspace is rejected before any spawn", async () => {
  const fx = await makeFixture();
  try {
    fx.fake.script.push((child) => {
      child.emitStdout(successEnvelope(validReport()));
      child.emitClose(0, null);
    });
    const startHandle = await fx.adapter.startTask({
      task: makeTask({ task_id: "task_switch" }),
      workspace: makeWorkspace("C:\\work\\original"),
      attempt: 1,
    });
    await fx.adapter.getResult(startHandle);
    await assert.rejects(
      fx.adapter.continueTask({
        task: makeTask({ task_id: "task_switch" }),
        workspace: makeWorkspace("C:\\work\\elsewhere"),
        attempt: 2,
        feedback: "continue",
        additionalRequirements: [],
        previousSessionId: SESSION_ID,
        previousResult: null,
      }),
      /continuation workspace mismatch/,
    );
    assert.equal(fx.fake.records.length, 1);
  } finally {
    await fx.cleanup();
  }
});

test("resume session id mismatch is surfaced as invalid_json with both ids in the message", async () => {
  const fx = await makeFixture();
  try {
    fx.fake.script.push((child) => {
      child.emitStdout(successEnvelope(validReport()));
      child.emitClose(0, null);
    });
    const startHandle = await fx.adapter.startTask({
      task: makeTask({ task_id: "task_resume" }),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    await fx.adapter.getResult(startHandle);

    const other = "sess_99999999-ffff-4eee-8ddd-dddddddddddd";
    fx.fake.script.push((child) => {
      child.emitStdout(successEnvelope(validReport(), other));
      child.emitClose(0, null);
    });
    const continueHandle = await fx.adapter.continueTask({
      task: makeTask({ task_id: "task_resume" }),
      workspace: makeWorkspace(),
      attempt: 2,
      feedback: "continue",
      additionalRequirements: [],
      previousSessionId: SESSION_ID,
      previousResult: null,
    });
    const outcome = await fx.adapter.getResult(continueHandle);
    assert.equal(outcome.errorCode, "invalid_json");
    assert.equal(outcome.sessionId, other);
    assert.match(outcome.reportError!, new RegExp(SESSION_ID));
    assert.match(outcome.reportError!, new RegExp(other));
    assert.equal(outcome.agentReport, null);
  } finally {
    await fx.cleanup();
  }
});

test("spawn throwing synchronously rejects getResult with spawn_failed", async () => {
  const fx = await makeFixture();
  try {
    fx.fake.spawnThrows = new Error("ENOENT: no such loader");
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    await assert.rejects(
      fx.adapter.getResult(handle),
      (error: unknown) => error instanceof BridgeError && error.code === "spawn_failed",
    );
  } finally {
    await fx.cleanup();
  }
});

test("spawn error events reject getResult with spawn_failed and clean the prompt file", async () => {
  const fx = await makeFixture();
  let promptPathDuringRun: string | null = null;
  try {
    fx.fake.script.push((child, record) => {
      promptPathDuringRun = record.args[2]!;
      child.emitError(new Error("EACCES: spawn denied"));
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    await assert.rejects(
      fx.adapter.getResult(handle),
      (error: unknown) => error instanceof BridgeError && error.code === "spawn_failed",
    );
    assert.ok(promptPathDuringRun);
    assert.ok(!existsSync(promptPathDuringRun));
  } finally {
    await fx.cleanup();
  }
});

test("outputs are bounded separately", async () => {
  const fx = await makeFixture({ maxOutputBytes: 64 });
  try {
    fx.fake.script.push((child) => {
      child.emitStdout("x".repeat(200));
      child.emitStderr("e".repeat(200));
      child.emitClose(1, null);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const outcome = await fx.adapter.getResult(handle);
    assert.ok(Buffer.byteLength(outcome.stdout, "utf8") <= 64);
    assert.ok(Buffer.byteLength(outcome.stderr, "utf8") <= 64);
    assert.equal(outcome.stdoutTruncated, true);
    assert.equal(outcome.stderrTruncated, true);
  } finally {
    await fx.cleanup();
  }
});

test("getStatus reports running before completion and exited with evidence after", async () => {
  const fx = await makeFixture();
  try {
    fx.fake.script.push((child) => {
      // Delay the close so the running state is observable.
      setTimeout(() => {
        child.emitStdout(successEnvelope(validReport()));
        child.emitClose(0, null);
      }, 30);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    await waitForSpawn(fx.adapter, handle);
    const running = await fx.adapter.getStatus(handle);
    assert.equal(running.state, "running");
    assert.equal(running.zcodePid, fx.fake.records[0]!.child.pid);
    await fx.adapter.getResult(handle);
    const exited = await fx.adapter.getStatus(handle);
    assert.equal(exited.state, "exited");
    assert.equal(exited.exitCode, 0);
  } finally {
    await fx.cleanup();
  }
});

/** Waits until the adapter has actually spawned the fake child process. */
async function waitForSpawn(adapter: ZCodeAdapter, handle: Parameters<ZCodeAdapter["getStatus"]>[0]): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const status = await adapter.getStatus(handle);
    if (status.zcodePid !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the adapter never spawned a child process");
}

test("getResult returns the identical settled outcome on repeated calls", async () => {
  const fx = await makeFixture();
  try {
    fx.fake.script.push((child) => {
      child.emitStdout(successEnvelope(validReport()));
      child.emitClose(0, null);
    });
    const handle = await fx.adapter.startTask({
      task: makeTask(),
      workspace: makeWorkspace(),
      attempt: 1,
    });
    const first = await fx.adapter.getResult(handle);
    const second = await fx.adapter.getResult(handle);
    assert.equal(first, second);
  } finally {
    await fx.cleanup();
  }
});
