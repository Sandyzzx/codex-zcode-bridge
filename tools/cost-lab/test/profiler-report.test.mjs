import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeProfilerSnapshot,
  compareProfilerReports,
  createAggregateUsage,
  normalizeUsage,
  profilerFileIdentity,
  readProfilerReport,
  readProfilerSnapshot,
  renderProfilerMarkdown,
  validateProfilerReport,
  validateProfilerSnapshot,
  writeProfilerReport,
  writeProfilerSnapshot,
} from "../profiler/index.mjs";

const SEVERITY_ORDER = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  INFO: 3,
};

function observedUsage(input, cached, output, reasoning = 0) {
  return normalizeUsage({
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  }, {
    model: "gpt-report-test",
    provider: "openai",
    reasoningEffort: "high",
  });
}

function buildSnapshot(totalMultiplier = 1) {
  const responses = Array.from({ length: 6 }, (_, index) => ({
    response_id: `response-${index + 1}`,
    agent_id: "agent-master",
    thread_id: "thread-master",
    turn_id: `turn-${index + 1}`,
    root_turn_id: "turn-1",
    model: "gpt-report-test",
    provider: "openai",
    reasoning_effort: "high",
    observed_at: `2026-11-19T03:00:0${index}.000Z`,
    usage: observedUsage(
      100 * totalMultiplier,
      25 * totalMultiplier,
      10 * totalMultiplier,
      index % 2,
    ),
    usage_unknown: false,
    event_ref: `source-report:${index}`,
    evidence_level: "OBSERVED",
    content_retained: false,
  }));
  const usage = createAggregateUsage({
    responseUsages: responses.map((response) => response.usage),
    cumulativeUsages: [],
    unknownUsageResponseCount: 0,
    model: "gpt-report-test",
    provider: "openai",
    reasoningEffort: "high",
  });
  const compactions = Array.from({ length: 3 }, (_, index) => ({
    compaction_id: `compaction-${index + 1}`,
    agent_id: "agent-master",
    thread_id: "thread-master",
    observed_at: `2026-11-19T03:01:0${index}.000Z`,
    window_number: index + 1,
    previous_window_id: `window-${index}`,
    window_id: `window-${index + 1}`,
    before_usage: index === 0 ? null : responses[index].usage,
    after_usage: responses[index + 1]?.usage ?? null,
    cumulative_before_usage: null,
    cumulative_after_usage: null,
    input_change_tokens: -10,
    replacement_item_count: 2 + index,
    replacement_bytes: 200 + index,
    retained_context_bytes: 100 + index,
    estimated_retained_context_tokens: 25 + index,
    evidence_level: "ESTIMATED",
    content_retained: false,
  }));
  const agent = {
    agent_id: "agent-master",
    kind: "MASTER",
    parent_agent_id: null,
    parent_thread_id: null,
    root_agent_id: "agent-master",
    lineage: ["agent-master"],
    goal_id: "goal-report-test",
    thread_id: "thread-master",
    session_id: "thread-master",
    root_thread_id: "thread-master",
    task_id: null,
    nickname: null,
    agent_path: null,
    model: "gpt-report-test",
    provider: "openai",
    reasoning_effort: "high",
    started_at: responses[0].observed_at,
    ended_at: responses.at(-1).observed_at,
    duration_ms: 5000,
    response_count: responses.length,
    unknown_usage_response_count: 0,
    usage,
    context_window: 100000,
    source_refs: ["source-report"],
    correlation: {
      status: "ROOT",
      evidence: "session_meta",
    },
    warnings: [],
    content_retained: false,
  };
  return {
    schema_version: 1,
    kind: "profiler_snapshot",
    snapshot_id: `snapshot-report-${totalMultiplier}`,
    captured_at: "2026-11-20T00:00:00.000Z",
    generated_at: "2026-11-20T00:00:00.000Z",
    event_horizon_at: "2026-11-19T03:01:02.000Z",
    read_only: true,
    collection_mode: "FULL",
    sources: [],
    goals: [{
      goal_id: "goal-report-test",
      agent_ids: ["agent-master"],
      agent_kinds: ["MASTER"],
      master_agent_ids: ["agent-master"],
      subagent_agent_ids: [],
      worker_agent_ids: [],
      unresolved_agent_ids: [],
    }],
    agents: [agent],
    responses,
    usage_checkpoints: [],
    tools: [],
    context_items: [],
    compactions,
    bridge_tasks: [],
    warnings: [{
      code: "rollout_partial_tail_deferred",
      source_id: "source-report",
      bytes: 12,
    }],
    limitations: ["Synthetic report fixture."],
  };
}

test("report schema, phase conservation, cache, compaction, and sanitized timeline stay stable", () => {
  const snapshot = buildSnapshot();
  assert.equal(validateProfilerSnapshot(snapshot).valid, true);
  const report = analyzeProfilerSnapshot(snapshot, { timelineLimit: 3 });
  assert.equal(validateProfilerReport(report).valid, true);
  assert.equal(report.usage.overall.total_tokens, 660);
  assert.equal(report.phases.conservation.status, "CONSERVED");
  assert.equal(report.context.cache.overall_cache_hit_rate, 0.25);
  assert.equal(report.context.compactions.count, 3);
  assert.equal(report.timeline_meta.event_count, 3);
  assert.equal(report.timeline_meta.total_event_count, 9);
  assert.equal(report.timeline_meta.truncated, true);
  assert.equal(report.timeline.length, 3);
  assert.equal(report.timeline_meta.content_retained, false);
  assert.equal(JSON.stringify(report).includes("SENTINEL"), false);
  const untruncatedReport = analyzeProfilerSnapshot(snapshot, { timelineLimit: 20 });
  assert.notEqual(untruncatedReport.report_id, report.report_id);
  assert.equal(untruncatedReport.timeline_meta.truncated, false);
  for (let index = 1; index < report.diagnostics.length; index += 1) {
    assert.ok(
      SEVERITY_ORDER[report.diagnostics[index - 1].severity]
        <= SEVERITY_ORDER[report.diagnostics[index].severity],
    );
  }
  assert.ok(report.diagnostics.some((diagnostic) => (
    diagnostic.id === "diagnostic:frequent_compaction"
  )));
  const roundTrip = JSON.parse(JSON.stringify(report));
  assert.equal(validateProfilerReport(roundTrip).valid, true);
});

test("comparison uses stable metric names and Markdown renders evidence boundaries", () => {
  const before = analyzeProfilerSnapshot(buildSnapshot(1));
  const after = analyzeProfilerSnapshot(buildSnapshot(2));
  const comparison = compareProfilerReports(before, after);
  assert.equal(comparison.kind, "profiler_comparison");
  assert.equal(comparison.compatibility.status, "COMPARABLE");
  assert.equal(comparison.metrics.total_tokens.before, 660);
  assert.equal(comparison.metrics.total_tokens.after, 1320);
  assert.equal(comparison.metrics.total_tokens.delta, 660);
  assert.equal(comparison.metrics.mcp_output_bytes.delta, 0);
  assert.equal(comparison.metrics.mcps_output_bytes, undefined);
  assert.equal(comparison.mcp.total_output_bytes.before, 0);
  const markdown = renderProfilerMarkdown(comparison);
  assert.match(markdown, /^# Agent Token Profiler Comparison/mu);
  assert.match(markdown, /Provider and model groups remain separate/u);
});

test("time filters recompute usage from response-level events instead of cumulative agent totals", () => {
  const snapshot = buildSnapshot();
  snapshot.context_items = [{
    context_event_id: "context-inside",
    agent_id: "agent-master",
    observed_at: "2026-11-19T03:00:02.500Z",
    category: "file_read",
    tool_name: "read_file",
    path_hash: "inside",
    bytes: 100,
    estimated_tokens: 25,
    evidence_level: "ESTIMATED",
    content_retained: false,
  }, {
    context_event_id: "context-outside",
    agent_id: "agent-master",
    observed_at: "2026-11-19T03:00:05.500Z",
    category: "file_read",
    tool_name: "read_file",
    path_hash: "outside",
    bytes: 900,
    estimated_tokens: 225,
    evidence_level: "ESTIMATED",
    content_retained: false,
  }, {
    context_event_id: "context-untimed",
    agent_id: "agent-master",
    category: "file_read",
    tool_name: "read_file",
    path_hash: "untimed",
    bytes: 500,
    estimated_tokens: 125,
    evidence_level: "ESTIMATED",
    content_retained: false,
  }];

  const report = analyzeProfilerSnapshot(snapshot, {
    from: "2026-11-19T03:00:02.000Z",
    to: "2026-11-19T03:00:03.999Z",
  });

  assert.equal(report.usage.overall.total_tokens, 220);
  assert.equal(report.usage.overall.response_count, 2);
  assert.equal(report.agents[0].usage.total_tokens, 220);
  assert.equal(report.agents[0].usage.accounting_mode, "RESPONSE_LEVEL");
  assert.equal(report.agents[0].response_count, 2);
  assert.equal(report.context.context.total_observed_content_bytes, 100);
  assert.equal(report.phases.conservation.status, "CONSERVED");
});

test("snapshot and report persistence are atomic, typed, and bounded to allowed roots", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "profiler-persistence-"));
  try {
    const snapshot = buildSnapshot();
    const report = analyzeProfilerSnapshot(snapshot);
    const snapshotPath = path.join(root, "snapshot.json");
    const reportPath = path.join(root, "report.json");
    const snapshotWrite = writeProfilerSnapshot(snapshot, snapshotPath, {
      allowedRoots: [root],
    });
    const reportWrite = writeProfilerReport(report, reportPath, {
      allowedRoots: [root],
    });
    assert.ok(snapshotWrite.bytes > 0);
    assert.ok(reportWrite.bytes > 0);
    assert.deepEqual(readProfilerSnapshot(snapshotPath), snapshot);
    assert.deepEqual(readProfilerReport(reportPath), report);
    assert.ok(profilerFileIdentity(reportPath).bytes > 0);
    assert.equal(validateProfilerReport(readProfilerReport(reportPath)).valid, true);
    assert.throws(
      () => writeProfilerReport(report, path.join(os.tmpdir(), "outside-report.json"), {
        allowedRoots: [root],
      }),
      /profiler_output_outside_allowed_root/u,
    );
    const rendered = renderProfilerMarkdown(report);
    assert.match(rendered, /^# Agent Token Profiler/mu);
    assert.match(rendered, /Raw prompt, source code, reasoning text, and tool-output content are not retained/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
