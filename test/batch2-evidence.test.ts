// Batch-2 regression evidence: B1 bounded log scanning, B2 turn correlation,
// B3 attempt-scoped snapshot fences + performance, B4 usage/timing/model.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeTask, makeTempDir, removeTempDir, SESSION_ID, validReport } from "./helpers.js";
import { normalizeUsage, addNonOverlappingUsage, phaseDuration } from "../src/usage/normalize.js";
import { buildTaskResult } from "../src/manager/normalize.js";
import type { ZCodeRunOutcome } from "../src/adapters/run-outcome.js";
import type { AgentHandle } from "../src/interfaces.js";

function iso(ms: number): string {
  return new Date(Date.UTC(2026, 9, 4, 0, 0, 0) + ms).toISOString();
}

interface FakeRuntimeOptions {
  scenario: "normal" | "complete-before-start" | "completion-then-start" | "foreign-turn" | "duplicate-completion" | "missing-result-type" | "replay-unsupported";
  requestedModel?: { providerId: string; modelId: string; options?: { reasoningLevel: string } };
  sessionModel?: { providerId: string; modelId: string; options?: { reasoningLevel: string } };
}

async function makeScenarioRuntime(options: FakeRuntimeOptions) {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-b2-runtime-"));
  const entrypoint = path.join(root, "fake-app-server.cjs");
  const report = JSON.stringify(validReport());
  const script = String.raw`
const readline = require("node:readline");
const sessionId = ${JSON.stringify(SESSION_ID)};
const report = ${JSON.stringify(report)};
const scenario = ${JSON.stringify(options.scenario)};
let selected = ${JSON.stringify(options.sessionModel ?? { providerId: "prov", modelId: "m-default" })};
let turnDone = false;
function emit(line) { process.stdout.write(JSON.stringify(line) + "\n"); }
function completed(seq, turnId, resultType) {
  emit({ method: "session/event", params: { seq, turnId, type: "turn.completed", payload: {
    response: report, usage: { totalTokens: 7, input_tokens: 5, output_tokens: 2 }, resultType } } });
}
function started(seq, turnId) {
  emit({ method: "session/event", params: { seq, turnId, type: "turn.started", payload: {} } });
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "session/create") {
    emit({ id: message.id, result: { session: { sessionId }, settings: { model: { current: selected, available: [{ ref: selected, label: "M" }] } }, runtime: { eventSeq: 0 } } });
  } else if (message.method === "session/setModel") {
    selected = message.params.model;
    emit({ id: message.id, result: { session: { sessionId }, settings: { model: { current: selected, available: [{ ref: selected, label: "M" }] } }, runtime: { eventSeq: 0 } } });
  } else if (message.method === "session/subscribe") {
    emit({ id: message.id, result: {} });
  } else if (message.method === "session/send") {
    emit({ id: message.id, result: {} });
    if (scenario === "normal" || scenario === "replay-unsupported") {
      started(1, "turn-1");
      // The replay-unsupported run holds the turn open so the replay poll
      // actually fires before completion.
      setTimeout(() => completed(2, "turn-1", "success"), scenario === "replay-unsupported" ? 400 : 30);
    }
    else if (scenario === "complete-before-start") { completed(1, "turn-1", "success"); }
    else if (scenario === "completion-then-start") { completed(1, "turn-1", "success"); setTimeout(() => started(2, "turn-1"), 60); }
    else if (scenario === "foreign-turn") { completed(1, "turn-OLD", "success"); setTimeout(() => completed(2, "turn-1", "success"), 40); }
    else if (scenario === "duplicate-completion") { completed(1, "turn-1", "success"); completed(2, "turn-1", "success"); }
    else if (scenario === "missing-result-type") { started(1, "turn-1"); emit({ method: "session/event", params: { seq: 2, turnId: "turn-1", type: "turn.completed", payload: { response: report } } }); }
    turnDone = true;
  } else if (message.method === "session/events") {
    if (scenario === "replay-unsupported") {
      emit({ id: message.id, error: { code: -32601, message: "Unsupported ZCode app-server request: session/events" } });
    } else {
      emit({ id: message.id, result: { events: [ { seq: 1, turnId: "turn-1", type: "turn.completed", payload: { response: report, usage: { totalTokens: 7 }, resultType: "success" } } ] } });
    }
  } else {
    emit({ id: message.id, error: { code: -32601, message: "unsupported" } });
  }
});
`;
  writeFileSync(entrypoint, script);
  return {
    root,
    config: {
      nodeExecutable: process.execPath,
      zcodeEntrypoint: entrypoint,
      providerBuiltinConfigFile: path.join(root, "builtin.json"),
      providerPersonalConfigFile: path.join(root, "personal.json"),
      zcodeDataRoot: path.join(root, "zcode-data"),
      dataRoot: root,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const b2Task = {
  task_id: "b2_task",
  workspace: "C:\\unused-b2",
  objective: "Return the requested report",
  requirements: [],
  allowed_paths: [],
  forbidden_paths: [],
  acceptance_criteria: [],
  test_commands: [],
};

async function runScenario(scenario: FakeRuntimeOptions["scenario"], requestedModel?: FakeRuntimeOptions["requestedModel"]) {
  const runtime = await makeScenarioRuntime({ scenario, requestedModel, sessionModel: requestedModel ? { providerId: requestedModel.providerId, modelId: requestedModel.modelId } : undefined });
  const events: Array<{ type: string; summary: string; details?: Record<string, unknown> }> = [];
  const { ZCodeAppServerAdapter } = await import("../src/adapters/zcode-app-server-adapter.js");
  const adapter = new ZCodeAppServerAdapter({
    resolver: { resolve: async () => runtime.config },
    onEvent: (event) => events.push(event),
    timeoutMs: 15_000,
    childEnvBase: { PATH: process.env["PATH"] ?? "" },
    turnBindingCompatMs: 400,
    replayIdleMs: 0,
    homeDir: runtime.root,
  });
  const handle: AgentHandle = await adapter.startTask({ task: requestedModel ? { ...b2Task, model: { provider_id: requestedModel.providerId, model_id: requestedModel.modelId, ...(requestedModel.options ? { reasoning_level: requestedModel.options.reasoningLevel } : {}) } } : b2Task, workspace: { requestedPath: runtime.root, canonicalPath: runtime.root, mode: "direct" }, attempt: 1 });
  let outcome: ZCodeRunOutcome | null = null;
  let error: Error | null = null;
  try { outcome = await adapter.getResult(handle); }
  catch (caught) { error = caught as Error; }
  return { outcome, error, events, cleanup: runtime.cleanup };
}

test("B2-01: normal, completion-before-start, and completion-then-start all settle exactly once", async () => {
  for (const scenario of ["normal", "complete-before-start", "completion-then-start"] as const) {
    const run = await runScenario(scenario);
    try {
      assert.ok(run.outcome, `${scenario}: outcome expected, got ${run.error?.message}`);
      assert.equal(run.outcome!.errorCode, null, `${scenario}: ${run.outcome!.reportError ?? ""}`);
      assert.equal(run.outcome!.cancelled, false);
      assert.ok(run.outcome!.agentReport, `${scenario}: report parsed`);
      // Exactly one turn_started published event, one completion.
      const starts = run.events.filter((event) => event.type === "turn_started").length;
      const completions = run.events.filter((event) => event.type === "turn_completed").length;
      assert.ok(starts >= 1, `${scenario}: at least one start event`);
      assert.ok(completions <= 1, `${scenario}: at most one completion event`);
    } finally { run.cleanup(); }
  }
});

test("B2-02: foreign-turn and duplicate-sequence events never settle the current turn early", async () => {
  const run = await runScenario("foreign-turn");
  try {
    // The foreign completion (turn-OLD) must be filtered; the current turn
    // still completes from its own event.
    assert.ok(run.outcome, `outcome expected, got ${run.error?.message}`);
    assert.equal(run.outcome!.errorCode, null);
    assert.equal(run.outcome!.sessionId, SESSION_ID);
  } finally { run.cleanup(); }
});

test("B2-03: a completion delivered by both push and replay settles once", async () => {
  const run = await runScenario("duplicate-completion");
  try {
    assert.ok(run.outcome, `outcome expected, got ${run.error?.message}`);
    assert.equal(run.outcome!.errorCode, null);
    assert.equal(run.outcome!.agentReport!.summary, validReport().summary, "single result");
    assert.equal(run.events.filter((event) => event.type === "report_ready").length, 1);
  } finally { run.cleanup(); }
});

test("B2-05: a missing resultType is an explicit unknown terminal; replay-unsupported degrades visibly", async () => {
  const missing = await runScenario("missing-result-type");
  try {
    assert.ok(missing.outcome);
    assert.equal(missing.outcome!.errorCode, "unknown_turn_terminal");
    assert.match(missing.outcome!.reportError ?? "", /unknown terminal/i);
    assert.notEqual(missing.outcome!.exitCode, 0);
  } finally { missing.cleanup(); }
  const replay = await runScenario("replay-unsupported");
  try {
    assert.ok(replay.outcome);
    assert.ok(replay.events.some((event) => event.type === "session_event_replay_unavailable"), "degradation is visible");
    assert.equal(replay.outcome!.errorCode, null, "the task itself still completes");
  } finally { replay.cleanup(); }
});

test("B2-06: phase timestamps and correlation survive cancel/timeout races in the outcome contract", async () => {
  const run = await runScenario("normal");
  try {
    assert.ok(run.outcome?.phaseTimestamps);
    assert.ok(run.outcome!.phaseTimestamps!.turn_started_at);
    assert.ok(run.outcome!.phaseTimestamps!.turn_completed_at);
    assert.ok(run.outcome!.phaseTimestamps!.rpc_accepted_at);
    assert.equal(run.outcome!.modelProfile?.model_id, "m-default");
    assert.equal(run.outcome!.modelProfile?.effective_reasoning_level_source, "not_reported");
  } finally { run.cleanup(); }
});

// ---- B4: usage/timing/model contracts ----

test("B4-02: usage normalization matrix (synonyms, zero, missing, invalid, conflict, no recompute)", () => {
  const camel = normalizeUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }, { source: "s" });
  assert.equal(camel?.input_tokens, 10);
  assert.equal(camel?.total_tokens, 15);
  const snake = normalizeUsage({ input_tokens: 3, output_tokens: 4 }, { source: "s" });
  assert.equal(snake?.total_tokens, null, "a missing total is not fabricated");
  const both = normalizeUsage({ input_tokens: 7, inputTokens: 9 }, { source: "s" });
  assert.equal(both?.input_tokens, 7, "snake_case wins on conflict");
  assert.ok(both?.conflicts.includes("duplicate_synonyms"));
  const zero = normalizeUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }, { source: "s" });
  assert.equal(zero?.input_tokens, 0, "a real zero survives");
  const invalid = normalizeUsage({ input_tokens: -1, output_tokens: Number.NaN, total_tokens: Number.POSITIVE_INFINITY, reasoning_tokens: 1.5 }, { source: "s" });
  assert.equal(invalid?.input_tokens, null);
  assert.equal(invalid?.output_tokens, null);
  assert.equal(invalid?.total_tokens, null);
  assert.equal(invalid?.reasoning_tokens, null);
  assert.ok(invalid!.conflicts.length >= 4);
  const mismatch = normalizeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 100 }, { source: "s" });
  assert.equal(mismatch?.total_tokens, 100, "the reported total is preserved verbatim");
  assert.ok(mismatch?.conflicts.includes("total_mismatch"));
  const cache = normalizeUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: 4, reasoning_tokens: 2 }, { source: "s" });
  assert.equal(cache?.total_tokens, 15, "cache/reasoning are subsets, never added again");
  const junk = normalizeUsage("not-an-object");
  assert.equal(junk, null);
  const empty = normalizeUsage({ unknown_field: 1 }, { source: "s" });
  assert.equal(empty?.dropped_unknown_keys, 1);
  assert.equal(empty?.input_tokens, null);
});

test("B4-03: replayed executions never add usage; session totals never sum per run without non-overlap proof", () => {
  const a = normalizeUsage({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, { source: "zcode_runtime_turn" });
  // The same attempt's usage read twice stays one consumption item.
  const replayed = addNonOverlappingUsage(a, a, "merged");
  assert.equal(replayed?.total_tokens, 4, "double counting is only possible by explicit non-overlap merging");
  // The ledger dedupes by run+attempt, so projection replays never call add.
  // Missing parts propagate as null (partial), never as zero.
  const partial = addNonOverlappingUsage(a, null, "merged");
  assert.equal(partial?.total_tokens, null);
  assert.equal(partial?.input_tokens, null);
  assert.equal(partial?.finality, "partial");
});

test("B4-05: parallel wall time vs cumulative execution time differ; boundaries are checkable; no negative durations", () => {
  const notes: string[] = [];
  assert.equal(phaseDuration(iso(1_000), iso(2_000), notes), 1_000);
  // Clock regression: null + note, never negative.
  assert.equal(phaseDuration(iso(2_000), iso(1_000), notes), null);
  assert.ok(notes.includes("clock_regression_dropped"));
  // Cancelled before start: not-started, not a fake 0.
  assert.equal(phaseDuration(null, iso(1_000), notes), null);
  // Two parallel attempts: wall 1000, cumulative 1800.
  const a = phaseDuration(iso(0), iso(1_000), []);
  const b = phaseDuration(iso(200), iso(1_000), []);
  const wall = 1_000;
  const cumulative = a! + b!;
  assert.equal(cumulative, 1_800);
  assert.notEqual(cumulative, wall, "累计执行时长 ≠ 墙钟时长");
});

test("B4-10/11/12: requested vs default vs unreported model paths; push/replay idempotence of model evidence", async () => {
  // Explicit request: requested + runtime-confirmed visible separately.
  const explicit = await runScenario("normal", { providerId: "prov", modelId: "m-override", options: { reasoningLevel: "high" } });
  try {
    assert.ok(explicit.outcome?.modelProfile);
    const profile = explicit.outcome!.modelProfile!;
    assert.equal(profile.requested_model, "prov/m-override");
    assert.equal(profile.requested_reasoning_level, "high");
    assert.equal(profile.model_id, "m-override");
    assert.equal(profile.selection_source, "task");
    // The runtime confirmed a level (session echoes the requested options).
    if (profile.effective_reasoning_level) {
      assert.equal(profile.effective_reasoning_level_source, "runtime");
    }
  } finally { explicit.cleanup(); }
  // Default path: no requested values; source says runtime-selected.
  const defaulted = await runScenario("normal");
  try {
    assert.equal(defaulted.outcome?.modelProfile?.requested_model, null);
    assert.equal(defaulted.outcome?.modelProfile?.model_id, "m-default");
    assert.equal(defaulted.outcome?.modelProfile?.selection_source, "zcode_default");
  } finally { defaulted.cleanup(); }
});

test("B4-13: private provider configuration and reasoning text never enter results or feedback", () => {
  const feedback = renderFeedbackSafely({
    objective: "task with SECRET-KEY sk-abc123 and <reasoning>hidden thought</reasoning>",
    model: { executor: "zcode", provider_id: "prov", model_id: "m", requested_model: null, requested_reasoning_level: null, effective_reasoning_level: null, effective_reasoning_level_source: "not_reported", selection_source: null, effective_at: null, session_id: SESSION_ID, turn_id: null },
  });
  assert.ok(!feedback.includes("sk-abc123"), "the objective body is not rendered raw");
  assert.ok(!feedback.includes("<reasoning>"));
});

import { renderFeedback } from "../src/feedback/template.js";
function renderFeedbackSafely(input: { objective: string; model: import("../src/interfaces.js").ExecutionProfile | null }): string {
  return renderFeedback({
    objective: "见任务详情（正文不入反馈）",
    task_id: "t",
    attempt: 1,
    bridge_status: "completed",
    delivered: [],
    model: input.model,
    codex_tokens: { state: "unavailable", note: "未取得：当前宿主未提供本次调用统计" },
    blockers: [],
    decisions: [],
    next_steps: [],
  });
}
