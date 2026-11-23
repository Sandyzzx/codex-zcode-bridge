import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AppServerProxyConnector,
  QueueCommandRunner,
  createExecutorWakeCoordinator,
  type ExecutorWakeObservationInput,
  type ExecutorWakeRecorder,
  type WakeAppServerSession,
  type WakeQueueSubmission,
  type WakeThreadPreflight,
} from "../src/executor/wake.js";
import type { ExecutorWakeReleaseFact } from "../src/manager/sqlite-lifecycle-mcp-authority.js";

const NOW = Date.parse("2026-11-22T00:00:00.000Z");
const THREAD_ID = "019c0000-0000-7000-8000-000000000001";
const APP_SERVER_FIXTURE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "fixtures",
  "fake-app-server-proxy.mjs",
);

function fixture() {
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
  };
  return { root, workspace, release };
}

function policy(workspace: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    enabled: true,
    task_id: "task-wake",
    attempt: 1,
    thread_id: THREAD_ID,
    workspace,
    model: "deepseek-v4.1-flash",
    model_provider: "deepseek",
    reasoning_effort: "low",
    fallback: "web_notify",
    authorization: {
      scope: "one_turn",
      granted_by: "owner",
      granted_at: "2026-11-21T23:55:00.000Z",
      expires_at: "2026-11-22T00:55:00.000Z",
    },
    ...overrides,
  };
}

function preflight(
  cwd: string,
  overrides: Partial<WakeThreadPreflight> = {},
): WakeThreadPreflight {
  return {
    loaded: true,
    status: "idle",
    can_accept_direct_input: true,
    cwd,
    model: "deepseek-v4.1-flash",
    model_provider: "deepseek",
    reasoning_effort: "low",
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

function appServer(value: WakeThreadPreflight, observeTurn = true) {
  const calls = { connect: 0, preflight: 0, observe: 0, close: 0 };
  let observedThreadId: string | null = null;
  let observedBaseline: readonly string[] = [];
  const connector = {
    async connect() {
      calls.connect += 1;
      const session: WakeAppServerSession = {
        async preflight(threadId) {
          calls.preflight += 1;
          assert.equal(threadId, THREAD_ID);
          return value;
        },
        async observeNewInProgressTurn(threadId, baseline) {
          calls.observe += 1;
          observedThreadId = threadId;
          observedBaseline = baseline;
          return observeTurn;
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

function queue(result: Partial<WakeQueueSubmission> = {}) {
  const calls: Array<{ threadId: string; message: string; timeoutMs: number }> = [];
  return {
    calls,
    runner: {
      async submit(input: { threadId: string; message: string; timeoutMs: number }) {
        calls.push({ threadId: input.threadId, message: input.message, timeoutMs: input.timeoutMs });
        return {
          started: true,
          exit_code: 0,
          signal: null,
          timed_out: false,
          stdout: "Queued message",
          stderr: "",
          queue_message_id: "019c0000-0000-7000-8000-000000000099",
          ...result,
        };
      },
    },
  };
}

function writePolicy(root: string, value: Record<string, unknown>): void {
  writeFileSync(path.join(root, "wake-policy.json"), `${JSON.stringify(value)}\n`, "utf8");
}

test("missing or invalid policy records Web Notify without contacting App Server or Queue", async () => {
  for (const [name, content] of [
    ["missing", null],
    ["invalid", policy(path.join(tmpdir(), "wake-invalid-workspace"))],
  ] as const) {
    const f = fixture();
    const observed = recorder();
    const app = appServer(preflight(f.workspace));
    const queued = queue();
    const notifications: string[] = [];
    try {
      if (content !== null) {
        const value = { ...content, reasoning_effort: "high" };
        writePolicy(f.root, value);
      }
      const coordinator = createExecutorWakeCoordinator({
        authorityRoot: f.root,
        now: () => NOW,
        recorder: observed.value,
        appServer: app.connector,
        queue: queued.runner,
        notifyWeb: (input) => notifications.push(input.reason_code),
      });
      const result = await coordinator.handle(f.release);
      assert.equal(result.state, "web_notify");
      assert.equal(result.reason_code, name === "missing" ? "policy_missing" : "policy_invalid");
      assert.deepEqual(observed.observations.map((item) => item.state), ["web_notify"]);
      assert.equal(observed.observations[0]?.thread_id, name === "missing" ? null : THREAD_ID);
      assert.deepEqual(app.calls, { connect: 0, preflight: 0, observe: 0, close: 0 });
      assert.equal(queued.calls.length, 0);
      assert.equal(notifications.length, 1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("disabled policy, unavailable App Server, and preflight failures all fail closed to Web Notify", async () => {
  const cases: Array<{
    readonly name: string;
    readonly policy: (workspace: string) => Record<string, unknown>;
    readonly preflight?: (workspace: string) => WakeThreadPreflight;
    readonly connectFails?: boolean;
    readonly reason: string;
  }> = [
    {
      name: "disabled",
      policy: (workspace) => policy(workspace, { enabled: false }),
      reason: "policy_disabled",
    },
    {
      name: "app-server",
      policy: (workspace) => policy(workspace),
      connectFails: true,
      reason: "app_server_unavailable",
    },
    {
      name: "unloaded",
      policy: (workspace) => policy(workspace),
      preflight: (workspace) => preflight(workspace, { loaded: false }),
      reason: "thread_not_loaded",
    },
    {
      name: "active",
      policy: (workspace) => policy(workspace),
      preflight: (workspace) => preflight(workspace, { status: "active" }),
      reason: "thread_status_active",
    },
    {
      name: "system-error",
      policy: (workspace) => policy(workspace),
      preflight: (workspace) => preflight(workspace, { status: "systemError" }),
      reason: "thread_status_systemError",
    },
    {
      name: "direct-input",
      policy: (workspace) => policy(workspace),
      preflight: (workspace) => preflight(workspace, { can_accept_direct_input: false }),
      reason: "thread_direct_input_unavailable",
    },
    {
      name: "workspace",
      policy: (workspace) => policy(workspace),
      preflight: () => preflight(path.resolve("..")),
      reason: "thread_workspace_mismatch",
    },
    {
      name: "model",
      policy: (workspace) => policy(workspace),
      preflight: (workspace) => preflight(workspace, { model: "another-model" }),
      reason: "thread_model_mismatch",
    },
    {
      name: "provider",
      policy: (workspace) => policy(workspace),
      preflight: (workspace) => preflight(workspace, { model_provider: "another-provider" }),
      reason: "thread_provider_mismatch",
    },
    {
      name: "effort",
      policy: (workspace) => policy(workspace),
      preflight: (workspace) => preflight(workspace, { reasoning_effort: "minimal" }),
      reason: "thread_reasoning_mismatch",
    },
  ];

  for (const item of cases) {
    const f = fixture();
    const observed = recorder();
    const queued = queue();
    const notifications: string[] = [];
    writePolicy(f.root, item.policy(f.workspace));
    try {
      const app = item.preflight === undefined ? null : appServer(item.preflight(f.workspace));
      const coordinator = createExecutorWakeCoordinator({
        authorityRoot: f.root,
        now: () => NOW,
        recorder: observed.value,
        appServer: item.connectFails === true || item.preflight === undefined
          ? { async connect() { throw new Error("app_server_unavailable"); } }
          : app!.connector,
        queue: queued.runner,
        notifyWeb: (input) => notifications.push(input.reason_code),
        controlTimeoutMs: 250,
      });
      const result = await coordinator.handle(f.release);
      assert.equal(result.state, "web_notify", item.name);
      assert.equal(result.reason_code, item.reason, item.name);
      assert.equal(observed.observations.length, 1, item.name);
      assert.equal(observed.observations[0]?.state, "web_notify", item.name);
      assert.equal(queued.calls.length, 0, item.name);
      assert.equal(notifications.length, 1, item.name);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("eligible loaded idle Thread records intent before one Queue submission and observes Turn start", async () => {
  const f = fixture();
  const observed = recorder();
  const app = appServer(preflight(f.workspace), true);
  const queued = queue();
  writePolicy(f.root, policy(f.workspace));
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      now: () => NOW,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
      turnObservationMs: 1_000,
      turnPollMs: 25,
      notifyWeb: () => assert.fail("eligible wake must not use Web Notify"),
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "turn_started");
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "queued", "turn_started"]);
    assert.equal(queued.calls.length, 1);
    assert.equal(queued.calls[0]?.threadId, THREAD_ID);
    assert.match(queued.calls[0]?.message ?? "", /task-wake/u);
    assert.doesNotMatch(queued.calls[0]?.message ?? "", /--resume/u);
    assert.deepEqual(app.observed(), {
      threadId: THREAD_ID,
      baseline: ["turn-old"],
    });
    assert.deepEqual(app.calls, { connect: 1, preflight: 1, observe: 1, close: 1 });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("trusted-local policy submits exactly one Queue without a control socket and records Turn start as unverified", async () => {
  const f = fixture();
  const observed = recorder();
  const queued = queue();
  const notifications: string[] = [];
  writePolicy(f.root, policy(f.workspace, { delivery_mode: "trusted_local" }));
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      now: () => NOW,
      recorder: observed.value,
      appServer: {
        async connect() {
          assert.fail("trusted-local Wake must not require the Desktop private control socket");
        },
      },
      queue: queued.runner,
      notifyWeb: (input) => notifications.push(input.reason_code),
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "web_notify");
    assert.equal(result.reason_code, "trusted_local_turn_start_unverified");
    assert.equal(result.queue_message_id, "019c0000-0000-7000-8000-000000000099");
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "queued", "web_notify"]);
    assert.equal(observed.observations[1]?.queue_message_id, "019c0000-0000-7000-8000-000000000099");
    assert.equal(queued.calls.length, 1);
    assert.equal(queued.calls[0]?.threadId, THREAD_ID);
    assert.match(queued.calls[0]?.message ?? "", /zcode_status/u);
    assert.match(queued.calls[0]?.message ?? "", /zcode_result\(view="summary"\)/u);
    assert.match(queued.calls[0]?.message ?? "", /Cleanup/u);
    assert.match(queued.calls[0]?.message ?? "", /released/u);
    assert.doesNotMatch(queued.calls[0]?.message ?? "", /--resume/u);
    assert.deepEqual(notifications, ["trusted_local_turn_start_unverified"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("trusted-local policy still fails closed for expired authorization and Task binding mismatch", async () => {
  const cases = [
    {
      name: "expired",
      value: {
        delivery_mode: "trusted_local",
        authorization: {
          scope: "one_turn",
          granted_by: "owner",
          granted_at: "2026-11-20T23:55:00.000Z",
          expires_at: "2026-11-21T00:55:00.000Z",
        },
      },
      reason: "policy_invalid",
    },
    {
      name: "task",
      value: {
        delivery_mode: "trusted_local",
        task_id: "another-task",
      },
      reason: "policy_task_mismatch",
    },
  ] as const;

  for (const item of cases) {
    const f = fixture();
    const observed = recorder();
    const queued = queue();
    writePolicy(f.root, policy(f.workspace, item.value));
    try {
      const coordinator = createExecutorWakeCoordinator({
        authorityRoot: f.root,
        now: () => NOW,
        recorder: observed.value,
        appServer: {
          async connect() {
            assert.fail("trusted-local policy rejection must not contact App Server");
          },
        },
        queue: queued.runner,
      });
      const result = await coordinator.handle(f.release);
      assert.equal(result.state, "web_notify", item.name);
      assert.equal(result.reason_code, item.reason, item.name);
      assert.equal(queued.calls.length, 0, item.name);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("trusted-local Queue timeout remains submission_unknown with no retry or Web resubmission", async () => {
  const f = fixture();
  const observed = recorder();
  const queued = queue({ timed_out: true, exit_code: null, queue_message_id: null });
  writePolicy(f.root, policy(f.workspace, { delivery_mode: "trusted_local" }));
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      now: () => NOW,
      recorder: observed.value,
      appServer: {
        async connect() {
          assert.fail("trusted-local Wake must not require the Desktop private control socket");
        },
      },
      queue: queued.runner,
      notifyWeb: () => assert.fail("unknown Queue submission must not be represented as a safe fallback"),
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "submission_unknown");
    assert.equal(result.reason_code, "queue_submission_timeout");
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "submission_unknown"]);
    assert.equal(queued.calls.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("App Server proxy transport performs JSON-RPC preflight and new-Turn observation", async () => {
  const f = fixture();
  const observed = recorder();
  const queued = queue();
  writePolicy(f.root, policy(f.workspace));
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
      now: () => NOW,
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

test("Queue timeout or lost acknowledgement records submission_unknown exactly once and never retries", async () => {
  for (const [name, submission] of [
    ["timeout", { timed_out: true, exit_code: null }],
    ["non-zero", { exit_code: 1 }],
    ["signal", { signal: "SIGTERM", exit_code: null }],
  ] as const) {
    const f = fixture();
    const observed = recorder();
    const app = appServer(preflight(f.workspace), false);
    const queued = queue(submission);
    writePolicy(f.root, policy(f.workspace));
    try {
      const coordinator = createExecutorWakeCoordinator({
        authorityRoot: f.root,
        now: () => NOW,
        recorder: observed.value,
        appServer: app.connector,
        queue: queued.runner,
        notifyWeb: () => assert.fail("unknown submission must remain observable rather than claim a fallback delivery"),
      });
      const result = await coordinator.handle(f.release);
      assert.equal(result.state, "submission_unknown", name);
      assert.deepEqual(observed.observations.map((item) => item.state), ["intent", "submission_unknown"], name);
      assert.equal(queued.calls.length, 1, name);
      assert.equal(app.calls.observe, 0, name);
      assert.equal(app.calls.close, 1, name);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("Queue runner extracts the official message ID from the bounded CLI acknowledgement", async () => {
  const messageId = "019c0000-0000-7000-8000-000000000099";
  const fakeSpawn = (() => spawn(
    process.execPath,
    ["-e", `process.stdout.write("Queued message ${messageId} for thread ${THREAD_ID}.\\n")`],
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
  assert.equal(submission.queue_message_id, messageId);
});

test("a Queue process that never starts records Web Notify rather than a Queue delivery", async () => {
  const f = fixture();
  const observed = recorder();
  const app = appServer(preflight(f.workspace));
  const queued = queue({ started: false, exit_code: null });
  const notifications: string[] = [];
  writePolicy(f.root, policy(f.workspace));
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      now: () => NOW,
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
    assert.deepEqual(notifications, ["queue_command_unavailable"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a prior intent is one-shot and cannot submit Queue again", async () => {
  const f = fixture();
  const observed = recorder({ duplicateIntent: true });
  const app = appServer(preflight(f.workspace));
  const queued = queue();
  writePolicy(f.root, policy(f.workspace));
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      now: () => NOW,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "already_handled");
    assert.deepEqual(observed.observations.map((item) => item.state), ["intent"]);
    assert.equal(queued.calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a previous Wake history blocks a new Queue submission", async () => {
  const f = fixture();
  const observed = recorder({ failIntentCode: "executor_wake_intent_not_first" });
  const app = appServer(preflight(f.workspace));
  const queued = queue();
  writePolicy(f.root, policy(f.workspace));
  try {
    const coordinator = createExecutorWakeCoordinator({
      authorityRoot: f.root,
      now: () => NOW,
      recorder: observed.value,
      appServer: app.connector,
      queue: queued.runner,
    });
    const result = await coordinator.handle(f.release);
    assert.equal(result.state, "already_handled");
    assert.equal(result.reason_code, "wake_history_already_exists");
    assert.equal(queued.calls.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
