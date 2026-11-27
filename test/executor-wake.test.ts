import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AppServerProxyConnector,
  QueueCommandRunner,
  createExecutorWakeCoordinator,
  type ExecutorWakeObservationInput,
  type ExecutorWakeRecorder,
  type WakeAppServerConnector,
  type WakeAppServerSession,
  type WakeQueueRunner,
  type WakeQueueSubmission,
  type WakeThreadPreflight,
} from "../src/executor/wake.js";
import type { ExecutorWakeReleaseFact } from "../src/manager/sqlite-lifecycle-mcp-authority.js";

const THREAD_ID = "019c0000-0000-7000-8000-000000000001";
const QUEUE_MESSAGE_ID = "019c0000-0000-7000-8000-000000000099";
const APP_SERVER_FIXTURE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "fixtures",
  "fake-app-server-proxy.mjs",
);

function fixture(overrides: Partial<ExecutorWakeReleaseFact> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "executor-wake-"));
  const workspace = path.join(root, "workspace");
  const release: ExecutorWakeReleaseFact = {
    task_id: "task-wake",
    attempt: 1,
    operation_id: "operation-wake",
    generation: 1,
    task_status: "completed",
    result_status: "completed",
    result_digest: "a".repeat(64),
    result_commit_ref: "result-commit-wake",
    workspace,
    owner_thread_id: THREAD_ID,
    owner_binding_state: "bound",
    ...overrides,
  };
  return { root, workspace, release };
}

function preflight(overrides: Partial<WakeThreadPreflight> = {}): WakeThreadPreflight {
  return {
    loaded: true,
    status: "idle",
    can_accept_direct_input: true,
    cwd: "ignored",
    model: "ignored",
    model_provider: "ignored",
    reasoning_effort: "ignored",
    recent_turns: [{ id: "turn-old", status: "completed" }],
    ...overrides,
  };
}

function recorder(options: {
  readonly duplicateIntent?: boolean;
  readonly failIntentCode?: string;
} = {}) {
  const observations: ExecutorWakeObservationInput[] = [];
  const value: ExecutorWakeRecorder = {
    recordExecutorWakeObservation(input) {
      observations.push(input);
      if (input.state === "intent" && options.failIntentCode) {
        throw Object.assign(new Error(options.failIntentCode), { code: options.failIntentCode });
      }
      return {
        duplicate: input.state === "intent" && options.duplicateIntent === true,
        state: input.state,
      };
    },
  };
  return { value, observations };
}

function appServer(options: {
  readonly observeTurn?: boolean;
  readonly connectError?: string;
  readonly preflightError?: string;
  readonly observed?: WakeThreadPreflight;
} = {}) {
  const calls = { connect: 0, preflight: 0, observe: 0, close: 0 };
  let observedThreadId: string | null = null;
  let observedBaseline: readonly string[] = [];
  const connector: WakeAppServerConnector = {
    async connect() {
      calls.connect += 1;
      if (options.connectError) throw new Error(options.connectError);
      const session: WakeAppServerSession = {
        async preflight(threadId) {
          calls.preflight += 1;
          assert.equal(threadId, THREAD_ID);
          if (options.preflightError) throw new Error(options.preflightError);
          return options.observed ?? preflight();
        },
        async observeNewInProgressTurn(threadId, baseline) {
          calls.observe += 1;
          observedThreadId = threadId;
          observedBaseline = baseline;
          return options.observeTurn ?? true;
        },
        async close() {
          calls.close += 1;
        },
      };
      return session;
    },
  };
  return {
    connector,
    calls,
    observed: () => ({ threadId: observedThreadId, baseline: observedBaseline }),
  };
}

function queue(
  result: Partial<WakeQueueSubmission> = {},
  failure?: string,
) {
  const calls: Array<{ threadId: string; message: string; timeoutMs: number }> = [];
  const runner: WakeQueueRunner = {
    async submit(input) {
      calls.push({ threadId: input.threadId, message: input.message, timeoutMs: input.timeoutMs });
      if (failure) throw new Error(failure);
      return {
        started: true,
        exit_code: 0,
        signal: null,
        timed_out: false,
        stdout: "Queued message",
        stderr: "",
        queue_message_id: QUEUE_MESSAGE_ID,
        ...result,
      };
    },
  };
  return { calls, runner };
}

test("missing Owner Binding records only an explicit Web fallback", async () => {
  const f = fixture({ owner_thread_id: null, owner_binding_state: "unavailable" });
  const observed = recorder();
  const app = appServer();
  const queued = queue();
  const notifications: string[] = [];
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
      notifyWeb: (input) => notifications.push(input.reason_code),
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "web_notify");
    assert.equal(result.reason_code, "owner_thread_unavailable");
    assert.deepEqual(observed.observations.map((item) => item.state), ["web_notify"]);
    assert.equal(observed.observations[0]?.thread_id, null);
    assert.deepEqual(app.calls, { connect: 0, preflight: 0, observe: 0, close: 0 });
    assert.equal(queued.calls.length, 0);
    assert.deepEqual(notifications, ["owner_thread_unavailable"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Auto Wake disabled records Web fallback without Intent or Queue", async () => {
  const f = fixture();
  const observed = recorder();
  const app = appServer();
  const queued = queue();
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
      autoWakeEnabled: () => false,
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "web_notify");
    assert.equal(result.reason_code, "auto_wake_disabled");
    assert.deepEqual(observed.observations.map((item) => item.state), ["web_notify"]);
    assert.equal(observed.observations[0]?.thread_id, THREAD_ID);
    assert.deepEqual(app.calls, { connect: 0, preflight: 0, observe: 0, close: 0 });
    assert.equal(queued.calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a ZCode Runtime Session ID never substitutes for a missing Owner Binding", async () => {
  const f = fixture();
  const release = {
    ...f.release,
    owner_thread_id: null,
    owner_binding_state: "unavailable" as const,
    zcode_session_id: "zcode-runtime-session-not-a-codex-thread",
  } as ExecutorWakeReleaseFact;
  const observed = recorder();
  const app = appServer();
  const queued = queue();
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
    });
    const result = await coordinator.handle(release);
    assert.equal(result.state, "web_notify");
    assert.equal(result.reason_code, "owner_thread_unavailable");
    assert.equal(observed.observations[0]?.thread_id, null);
    assert.equal(queued.calls.length, 0);
    assert.deepEqual(app.calls, { connect: 0, preflight: 0, observe: 0, close: 0 });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a bound Thread needs no wake-policy file and submits exactly one official Queue", async () => {
  const f = fixture();
  const observed = recorder();
  const app = appServer({ connectError: "control_socket_missing" });
  const queued = queue();
  const notifications: string[] = [];
  try {
    assert.equal(existsSync(path.join(f.root, "wake-policy.json")), false);
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
      notifyWeb: (input) => notifications.push(input.reason_code),
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "web_notify");
    assert.equal(result.reason_code, "turn_start_unverified");
    assert.equal(result.queue_message_id, QUEUE_MESSAGE_ID);
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "queued", "web_notify"]);
    assert.equal(observed.observations[0]?.reason_code, "plugin_installed_auto_wake");
    assert.equal(observed.observations[0]?.thread_id, THREAD_ID);
    assert.equal(observed.observations[1]?.queue_message_id, QUEUE_MESSAGE_ID);
    assert.equal(queued.calls.length, 1);
    assert.equal(queued.calls[0]?.threadId, THREAD_ID);
    assert.match(queued.calls[0]?.message ?? "", /task-wake/u);
    assert.match(queued.calls[0]?.message ?? "", /zcode_status/u);
    assert.match(queued.calls[0]?.message ?? "", /zcode_result\(view="summary", expected_attempt=1\)/u);
    assert.doesNotMatch(queued.calls[0]?.message ?? "", /--resume/u);
    assert.deepEqual(app.calls, { connect: 1, preflight: 0, observe: 0, close: 0 });
    assert.deepEqual(notifications, ["turn_start_unverified"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Queue acknowledgement is not Turn-start evidence", async () => {
  const f = fixture();
  const observed = recorder();
  const app = appServer({ observeTurn: false });
  const queued = queue();
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
      turnObservationMs: 1,
      turnPollMs: 25,
      notifyWeb: () => undefined,
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "web_notify");
    assert.equal(result.reason_code, "turn_start_unverified");
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "queued", "web_notify"]);
    assert.equal(observed.observations.some((item) => item.state === "turn_started"), false);
    assert.equal(queued.calls.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a lost Queue acknowledgement ID still records queued and never claims delivery", async () => {
  const f = fixture();
  const observed = recorder();
  const app = appServer({ observeTurn: false });
  const queued = queue({ queue_message_id: null });
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
      turnObservationMs: 1,
      turnPollMs: 25,
      notifyWeb: () => undefined,
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "web_notify");
    assert.equal(result.reason_code, "turn_start_unverified");
    assert.equal(result.queue_message_id, undefined);
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "queued", "web_notify"]);
    assert.equal(observed.observations[1]?.queue_message_id, undefined);
    assert.equal(queued.calls.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an observed new in-progress Turn records turn_started", async () => {
  const f = fixture();
  const observed = recorder();
  const app = appServer();
  const queued = queue();
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
      turnObservationMs: 1_000,
      turnPollMs: 25,
      notifyWeb: () => assert.fail("an observed Turn must not use Web fallback"),
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "turn_started");
    assert.equal(result.reason_code, "turn_in_progress_observed");
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "queued", "turn_started"]);
    assert.deepEqual(app.observed(), { threadId: THREAD_ID, baseline: ["turn-old"] });
    assert.deepEqual(app.calls, { connect: 1, preflight: 1, observe: 1, close: 1 });
    assert.equal(queued.calls.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Queue timeout, non-zero exit, signal, or rejected spawn remains submission_unknown once", async () => {
  const cases: Array<{ readonly name: string; readonly result?: Partial<WakeQueueSubmission>; readonly failure?: string }> = [
    { name: "timeout", result: { timed_out: true, exit_code: null } },
    { name: "non-zero", result: { exit_code: 1 } },
    { name: "signal", result: { signal: "SIGTERM", exit_code: null } },
    { name: "spawn-error", failure: "spawn_failed" },
  ];
  for (const item of cases) {
    const f = fixture();
    const observed = recorder();
    const app = appServer();
    const queued = queue(item.result, item.failure);
    try {
      const coordinator = createExecutorWakeCoordinator({
        authorityRoot: f.root,
        recorder: observed.value,
        appServer: app.connector,
        queue: queued.runner,
        notifyWeb: () => assert.fail("unknown submission must not claim a safe fallback"),
      });
      const result = await coordinator.handle(f.release);
      assert.equal(result.state, "submission_unknown", item.name);
      assert.deepEqual(observed.observations.map((entry) => entry.state), ["intent", "submission_unknown"], item.name);
      assert.equal(queued.calls.length, 1, item.name);
      assert.deepEqual(app.calls, { connect: 0, preflight: 0, observe: 0, close: 0 }, item.name);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("a Queue command that never starts records queue_command_unavailable", async () => {
  const f = fixture();
  const observed = recorder();
  const app = appServer();
  const queued = queue({ started: false, exit_code: null, queue_message_id: null });
  const notifications: string[] = [];
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
      notifyWeb: (input) => notifications.push(input.reason_code),
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "web_notify");
    assert.equal(result.reason_code, "queue_command_unavailable");
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "web_notify"]);
    assert.equal(queued.calls.length, 1);
    assert.deepEqual(app.calls, { connect: 0, preflight: 0, observe: 0, close: 0 });
    assert.deepEqual(notifications, ["queue_command_unavailable"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a prior Intent is one-shot and cannot submit Queue again", async () => {
  const f = fixture();
  const observed = recorder({ duplicateIntent: true });
  const app = appServer();
  const queued = queue();
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "already_handled");
    assert.equal(result.reason_code, "prior_intent_already_recorded");
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent"]);
    assert.equal(queued.calls.length, 0);
    assert.deepEqual(app.calls, { connect: 0, preflight: 0, observe: 0, close: 0 });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("existing Wake history blocks a new Queue submission", async () => {
  const f = fixture();
  const observed = recorder({ failIntentCode: "executor_wake_intent_not_first" });
  const app = appServer();
  const queued = queue();
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "already_handled");
    assert.equal(result.reason_code, "wake_history_already_exists");
    assert.equal(queued.calls.length, 0);
    assert.deepEqual(app.calls, { connect: 0, preflight: 0, observe: 0, close: 0 });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Queue runner extracts the official message ID from the bounded CLI acknowledgement", async () => {
  const fakeSpawn = (() => spawn(
    process.execPath,
    ["-e", `process.stdout.write("Queued message ${QUEUE_MESSAGE_ID} for thread ${THREAD_ID}.\\n")`],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false },
  )) as unknown as typeof spawn;
  const runner = new QueueCommandRunner({ spawnImpl: fakeSpawn });
  const submission = await runner.submit({
    executable: "fixture-codex",
    threadId: THREAD_ID,
    message: "WAKE_TEST",
    timeoutMs: 2_000,
  });
  assert.equal(submission.started, true);
  assert.equal(submission.exit_code, 0);
  assert.equal(submission.queue_message_id, QUEUE_MESSAGE_ID);
});

test("App Server proxy transport observes a new in-progress Turn without gating Queue", async () => {
  const f = fixture();
  const observed = recorder();
  const queued = queue();
  const socketPath = path.join(f.root, "app-server-control.sock");
  writeFileSync(socketPath, "fixture", "utf8");
  const fakeSpawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const child: ChildProcess = spawn(process.execPath, [APP_SERVER_FIXTURE, ...args], {
      ...options,
      env: {
        ...process.env,
        ...(options.env as NodeJS.ProcessEnv | undefined),
        WAKE_FIXTURE_WORKSPACE: f.workspace,
        WAKE_FIXTURE_THREAD_ID: THREAD_ID,
      },
      windowsHide: true,
      shell: false,
    });
    assert.equal(command, "fixture-codex");
    return child;
  }) as typeof spawn;
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      recorder: observed.value,
      appServer: new AppServerProxyConnector({ spawnImpl: fakeSpawn }),
      queue: queued.runner,
      codexExecutable: "fixture-codex",
      socketPath,
      controlTimeoutMs: 2_000,
      turnObservationMs: 500,
      turnPollMs: 25,
      notifyWeb: () => assert.fail("valid proxy fixture must not fall back"),
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "turn_started");
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "queued", "turn_started"]);
    assert.equal(queued.calls.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
