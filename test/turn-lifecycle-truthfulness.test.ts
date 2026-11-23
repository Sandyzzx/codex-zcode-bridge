// P1 §3.1 Turn Lifecycle Truthfulness fault injection (2026-11-24).
//
// Contract under test (Master execution doc, Phase P1):
// - Request Accepted (session/send ACK), Turn Started, Turn Completed, Turn
//   Failed and Turn Cancelled are distinct facts. Only a native turn.started
//   event may establish the Started fact; the send ACK is acceptance only.
// - Terminal events that arrive while the Adapter is still waiting for
//   turn.started (fresh send on a session with prior events, or a runtime that
//   emits completed/failed before started) must not be dropped: a completion is
//   held in the bounded pending boundary, and a late native turn.started
//   settles it with strict binding. A failure settles directly.
// - The current attempt settles exactly once; stale or foreign turn events
//   never pollute it; when the turn cannot be recovered the adapter fails with
//   an explicit error instead of inventing execution state.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ZCodeAppServerTestAdapter } from "../src/adapters/zcode-app-server-adapter.js";
import type { TaskPackage, ZCodeRuntimeConfig } from "../src/interfaces.js";
import { makeWorkspace, SESSION_ID, validReport } from "./helpers.js";

interface ScriptedEvent {
  readonly delayMs: number;
  readonly seq: number;
  readonly type: string;
  readonly turnId?: string;
  readonly payload?: Record<string, unknown>;
}

interface RuntimeScript {
  /** session/create snapshot runtime.eventSeq baseline (0 = fresh session). */
  readonly runtimeEventSeq: number;
  /** Events emitted after the session/send ACK, each after its delay. */
  readonly afterAck: readonly ScriptedEvent[];
  /** When false, session/events replies with the unsupported-request error. */
  readonly replaySupported: boolean;
}

interface ScriptedRuntime {
  readonly root: string;
  readonly config: ZCodeRuntimeConfig;
}

async function writeScriptedRuntime(script: RuntimeScript): Promise<ScriptedRuntime> {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-turn-lifecycle-"));
  const entrypoint = path.join(root, "scripted-app-server.cjs");
  const scriptPath = path.join(root, "script.json");
  await writeFile(scriptPath, JSON.stringify(script), "utf8");
  const runtimeScript = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const script = JSON.parse(fs.readFileSync(${JSON.stringify(scriptPath)}, "utf8"));
const sessionId = ${JSON.stringify(SESSION_ID)};
const report = ${JSON.stringify(validReport())};
function snapshot() {
  return {
    session: { sessionId },
    settings: { model: { current: { providerId: "provider-default", modelId: "model-default" }, available: [] } },
    runtime: { eventSeq: script.runtimeEventSeq },
  };
}
function emit(event) {
  const params = { sessionId, seq: event.seq, type: event.type, payload: event.payload
    || (event.type === "turn.completed"
      ? { response: JSON.stringify(report), usage: { totalTokens: 4 }, resultType: "success" }
      : event.type === "turn.failed"
        ? { error: { message: "scripted turn failure" } }
        : {}) };
  if (event.turnId) params.turnId = event.turnId;
  process.stdout.write(JSON.stringify({ method: "session/event", params }) + "\n");
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "session/create" || message.method === "session/setModel") {
    process.stdout.write(JSON.stringify({ id: message.id, result: snapshot() }) + "\n");
  } else if (message.method === "session/subscribe") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
  } else if (message.method === "session/send") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
    for (const event of script.afterAck) setTimeout(() => emit(event), event.delayMs);
  } else if (message.method === "session/events") {
    if (!script.replaySupported) {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Unsupported ZCode app-server request: session/events" } }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify({ id: message.id, result: { events: [] } }) + "\n");
  } else if (message.id !== undefined) {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
  }
});
setInterval(() => {}, 1000);
`;
  await writeFile(entrypoint, runtimeScript, "utf8");
  return {
    root,
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      zcodeDataRoot: path.join(root, "data"),
      dataRoot: path.join(root, "data"),
      providerBuiltinConfigFile: path.join(root, "unused-builtin.json"),
      providerPersonalConfigFile: "unused-personal.json",
    },
  };
}

const task: TaskPackage = {
  task_id: "turn-lifecycle-truthfulness",
  workspace: process.cwd(),
  objective: "Exercise turn lifecycle fact boundaries",
  requirements: [],
  allowed_paths: [],
  forbidden_paths: [],
  acceptance_criteria: [],
  test_commands: [],
};

interface ObservedEvent {
  readonly type: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;
}

async function runScriptedTurn(
  script: RuntimeScript,
  options: { readonly timeoutMs?: number; readonly turnBindingCompatMs?: number } = {},
): Promise<{
  readonly events: readonly ObservedEvent[];
  readonly outcome: import("../src/adapters/run-outcome.js").ZCodeRunOutcome | null;
  readonly error: unknown;
}> {
  const runtime = await writeScriptedRuntime(script);
  const events: ObservedEvent[] = [];
  try {
    const adapter = new ZCodeAppServerTestAdapter({
      resolver: { resolve: async () => runtime.config },
      timeoutMs: options.timeoutMs ?? 10_000,
      turnBindingCompatMs: options.turnBindingCompatMs ?? 400,
      replayIdleMs: 150,
      childEnvBase: { PATH: process.env.PATH },
      homeDir: runtime.root,
      onEvent: (event) => events.push({ type: event.type, details: event.details }),
    });
    try {
      const handle = await adapter.startTask({ task, workspace: makeWorkspace(runtime.root), attempt: 1 });
      const outcome = await adapter.getResult(handle);
      return { events, outcome, error: null };
    } catch (error) {
      return { events, outcome: null, error };
    }
  } finally {
    await rm(runtime.root, { recursive: true, force: true });
  }
}

function eventTypes(events: readonly ObservedEvent[]): string[] {
  return events.map((event) => event.type);
}

test("ack followed by native started and completed establishes Started only from the native event", async () => {
  const { events, outcome, error } = await runScriptedTurn({
    runtimeEventSeq: 0,
    replaySupported: true,
    afterAck: [
      { delayMs: 20, seq: 1, type: "turn.started", turnId: "turn-1" },
      { delayMs: 80, seq: 2, type: "turn.completed", turnId: "turn-1" },
    ],
  });
  assert.equal(error, null);
  const types = eventTypes(events);
  assert.ok(types.includes("turn_accepted"), "the send ACK must publish turn_accepted");
  const acceptedIndex = types.indexOf("turn_accepted");
  const startedIndex = types.indexOf("turn_started");
  assert.ok(startedIndex > acceptedIndex, "turn_started must follow turn_accepted");
  const startedEvent = events[startedIndex]!;
  assert.notEqual(startedEvent.details?.["rpc_accepted"], true,
    "turn_started must come from the native event, not the ACK");
  assert.ok(outcome?.phaseTimestamps?.turn_started_at, "native started must set startedAt");
  assert.ok(outcome?.phaseTimestamps?.rpc_accepted_at, "the ACK must set rpcAcceptedAt");
  assert.equal(eventTypes(events).includes("turn_binding_compat"), false, "native started binds strictly without compat degradation");
});

test("completed before started on a fresh session settles immediately without fabricating Started", async () => {
  const { events, outcome, error } = await runScriptedTurn({
    runtimeEventSeq: 0,
    replaySupported: true,
    afterAck: [
      { delayMs: 20, seq: 1, type: "turn.completed", turnId: "turn-2" },
      { delayMs: 250, seq: 2, type: "turn.started", turnId: "turn-2" },
    ],
  });
  assert.equal(error, null);
  assert.ok(outcome, "a fresh session does not await binding; the completion settles immediately");
  const completions = eventTypes(events).filter((type) => type === "turn_completed");
  assert.equal(completions.length, 1, "the completion publishes exactly once");
  assert.equal(outcome?.phaseTimestamps?.turn_started_at, null,
    "Started stays unknown when the native started arrives only after the settle");
  assert.equal(eventTypes(events).includes("turn_started"), false,
    "the late started must not fabricate a Started fact for the already-settled attempt");
});

test("started and completed in the same coalesced batch settle exactly once", async () => {
  const { events, outcome, error } = await runScriptedTurn({
    runtimeEventSeq: 0,
    replaySupported: true,
    afterAck: [
      { delayMs: 20, seq: 1, type: "turn.started", turnId: "turn-3" },
      { delayMs: 21, seq: 2, type: "turn.completed", turnId: "turn-3" },
    ],
  });
  assert.equal(error, null);
  assert.equal(eventTypes(events).filter((type) => type === "turn_completed").length, 1);
  assert.ok(outcome?.phaseTimestamps?.turn_started_at);
});

test("a session with prior events holds a completion that races turn.started instead of dropping it", async () => {
  const { events, outcome, error } = await runScriptedTurn({
    runtimeEventSeq: 5,
    replaySupported: true,
    afterAck: [
      { delayMs: 20, seq: 6, type: "turn.completed", turnId: "turn-4" },
      { delayMs: 250, seq: 7, type: "turn.started", turnId: "turn-4" },
    ],
  });
  assert.equal(error, null);
  assert.ok(outcome, "awaiting-turn-start must not drop the terminal completion");
  assert.equal(eventTypes(events).filter((type) => type === "turn_completed").length, 1);
  assert.ok(outcome?.phaseTimestamps?.turn_started_at);
});

test("a missing started degrades through the bounded compat window with an explicit event and no fabricated Started", async () => {
  const { events, outcome, error } = await runScriptedTurn({
    runtimeEventSeq: 5,
    replaySupported: false,
    afterAck: [
      { delayMs: 20, seq: 6, type: "turn.completed", turnId: "turn-5" },
    ],
  }, { turnBindingCompatMs: 300 });
  assert.equal(error, null);
  assert.ok(outcome, "the held completion settles through the compat window");
  assert.ok(eventTypes(events).includes("turn_binding_compat"), "compat degradation is visible");
  assert.equal(outcome?.phaseTimestamps?.turn_started_at, null,
    "without a native started the Started fact stays unknown");
  assert.ok(eventTypes(events).includes("turn_binding_compat"));
  const startedEvents = events.filter((event) => event.type === "turn_started");
  assert.equal(startedEvents.length, 0, "no turn_started may be fabricated from the ACK");
});

test("turn.failed while awaiting turn.started settles the failure instead of being dropped", async () => {
  const { events, outcome, error } = await runScriptedTurn({
    runtimeEventSeq: 5,
    replaySupported: false,
    afterAck: [
      { delayMs: 20, seq: 6, type: "turn.failed", turnId: "turn-6", payload: { error: { message: "scripted pre-start failure" } } },
    ],
  }, { turnBindingCompatMs: 300 });
  assert.notEqual(error, null, "the pre-start failure must reject the turn");
  const types = eventTypes(events);
  assert.ok(types.includes("turn_failed"), "the failure event publishes");
  assert.equal(types.includes("turn_started"), false);
  assert.equal(outcome, null);
});

test("duplicate terminal events settle the attempt exactly once", async () => {
  const { events, error } = await runScriptedTurn({
    runtimeEventSeq: 0,
    replaySupported: true,
    afterAck: [
      { delayMs: 20, seq: 1, type: "turn.started", turnId: "turn-7" },
      { delayMs: 60, seq: 2, type: "turn.completed", turnId: "turn-7" },
      { delayMs: 150, seq: 3, type: "turn.completed", turnId: "turn-7" },
    ],
  });
  assert.equal(error, null);
  assert.equal(eventTypes(events).filter((type) => type === "turn_completed").length, 1);
});

test("a stale started from another turn never establishes Started for the current attempt", async () => {
  const { events, outcome, error } = await runScriptedTurn({
    runtimeEventSeq: 5,
    replaySupported: true,
    afterAck: [
      { delayMs: 20, seq: 6, type: "turn.completed", turnId: "turn-8" },
      { delayMs: 250, seq: 7, type: "turn.started", turnId: "turn-other" },
    ],
  }, { turnBindingCompatMs: 300 });
  assert.equal(error, null);
  assert.ok(outcome, "the held completion settles through the compat window");
  assert.equal(eventTypes(events).includes("turn_started"), false,
    "a foreign turn.started must not publish Started for this attempt");
  assert.ok(eventTypes(events).includes("turn_binding_compat"), "compat degradation is visible");
});
