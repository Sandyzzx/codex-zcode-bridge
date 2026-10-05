// A4 fixed feedback template regressions: one stable structure for every
// outcome shape, explicit unknown/未报告 values, worker vs master verification
// boundaries, and publish-state honesty. Each test names its acceptance item.
import assert from "node:assert/strict";
import test from "node:test";
import { renderFeedback, formatTokens, formatDuration, escapeCell, feedbackInputFromRecord, type FeedbackInput } from "../src/feedback/template.js";
import type { NormalizedUsage, ExecutionProfile, TaskResult, TaskStatusRecord } from "../src/interfaces.js";

function baseInput(overrides: Partial<FeedbackInput> = {}): FeedbackInput {
  return {
    objective: "修复登录页崩溃并补齐回归测试",
    task_id: "task_1",
    attempt: 1,
    bridge_status: "completed",
    delivered: ["src/login.ts"],
    blockers: [],
    decisions: [],
    next_steps: [],
    ...overrides,
  };
}

test("A4-01: every outcome shape renders the same core fields without blank cells or fake success", () => {
  const shapes: Array<[string, FeedbackInput]> = [
    ["成功", baseInput({
      bridge_status: "completed",
      usage: { source: "zcode_runtime_turn", scope: null, observed_at: null, finality: "reported", input_tokens: 1200, output_tokens: 300, total_tokens: 1500, cached_input_tokens: null, reasoning_tokens: null, conflicts: [], dropped_unknown_keys: 0 },
      model: { executor: "zcode", provider_id: "p", model_id: "m", requested_model: null, requested_reasoning_level: null, effective_reasoning_level: "high", effective_reasoning_level_source: "runtime", selection_source: "runtime", effective_at: null, session_id: "s", turn_id: null },
      timing: { queue_ms: 120, execution_ms: 95_000, verify_ms: 30_000, wall_ms: 95_000, derived: false, notes: [] },
      verification: { outcome: "通过", scope: "独立运行 npm test 与 diff 检查", items: [{ item: "npm test", result: "独立实测通过", evidence: "42 passed" }] },
    })],
    ["启动失败", baseInput({ bridge_status: "failed", delivered: [], result: { task_id: "task_1", status: "failed", summary: "spawn_failed: node missing", files_changed: [], tests: [], issues: [], needs_master_decision: true, zcode_output: "", exit_code: null, session_id: null, attempt: 1, started_at: null, finished_at: "2026-10-04T00:00:00Z", error_code: "spawn_failed" } as TaskResult })],
    ["取消", baseInput({ bridge_status: "cancelled", delivered: [] })],
    ["超时", baseInput({ bridge_status: "failed", status_note: "执行超出 60 分钟预算" })],
    ["等待审批", baseInput({ bridge_status: "waiting_for_master", decisions: ["worker 请求决定 X"] })],
    ["清理未确认", baseInput({ bridge_status: "completed", observation: undefined })],
    ["无效报告", baseInput({ bridge_status: "failed", result: { task_id: "task_1", status: "failed", summary: "invalid_agent_report", files_changed: [], tests: [], issues: [], needs_master_decision: true, zcode_output: "", exit_code: 0, session_id: "s", attempt: 1, started_at: null, finished_at: "2026-10-04T00:00:00Z", error_code: "invalid_agent_report", report_candidate: { summary: "half" } } as TaskResult })],
  ];
  for (const [label, input] of shapes) {
    const rendered = renderFeedback(input);
    for (const row of ["目标与交付", "执行标识", "执行状态", "独立验收", "接收与发布", "本次耗时", "Codex 主会话 token", "ZCode 执行 token", "模型与推理档位", "后续动作"]) {
      assert.ok(rendered.includes(`| ${row} |`), `${label} 缺少核心字段 ${row}`);
    }
    assert.ok(rendered.includes("### 验收证据"), `${label} 缺少验收证据表`);
    assert.ok(rendered.includes("### 待处理事项"), `${label} 缺少待处理事项`);
    assert.ok(!rendered.includes("|  |"), `${label} 存在空单元格`);
  }
});

test("A4-02: verified deliverables with unverified cleanup show both facts separately", () => {
  const rendered = renderFeedback(baseInput({
    bridge_status: "completed",
    verification: { outcome: "通过", scope: "diff + tests", items: [{ item: "diff 审查", result: "独立实测通过", evidence: "符合 AC1" }] },
    observation: {
      schema_version: 1,
      worker: { state: "unknown", reason_code: "worker_exited_unverified", observed_at: "2026-10-04T00:00:00Z" },
      runtime: { state: "unknown", reason_code: "persisted_pid_no_probe", observed_at: "2026-10-04T00:00:00Z" },
      activity: { code: "finalizing", reason_code: "task_terminal", observed_at: "2026-10-04T00:00:00Z" },
      result: "committed",
      cleanup: "unverified",
      stalled: false,
      evidence: { heartbeat_age_ms: null, last_event_age_ms: null, last_event_seq: 9, last_event_type: "task_finished", session_id: "s", turn_id: null, attempt: 1, status_updated_at: null },
    },
  }));
  assert.match(rendered, /独立验收 \| 通过/);
  assert.match(rendered, /cleanup 未确认|清理未确认|cleanup unverified/i);
  assert.match(rendered, /进程清理/);
});

test("A4-03: commit/push/release states are explicit with evidence; nothing claims published without an operation", () => {
  const rendered = renderFeedback(baseInput({ delivery: {} }));
  assert.match(rendered, /未提交/);
  assert.match(rendered, /未推送/);
  assert.match(rendered, /未发布/);
  const explicit = renderFeedback(baseInput({
    delivery: {
      committed: { state: "yes", evidence: "git log abc123" },
      pushed: { state: "no", evidence: "本次未执行推送" },
      released: { state: "not_applicable", evidence: "任务无发布要求" },
    },
  }));
  assert.match(explicit, /已提交；依据：git log abc123/);
  assert.match(explicit, /未推送；依据：本次未执行推送/);
  assert.match(explicit, /不适用；依据：任务无发布要求/);
});

test("A4-04: missing/partial usage and missing host tokens are explicit, never zeros or invented totals", () => {
  // No usage at all.
  const missing = renderFeedback(baseInput({}));
  assert.match(missing, /ZCode 执行 token \| 未报告/);
  assert.match(missing, /未取得：当前宿主未提供本次调用统计/);
  // Partial attempts: the note carries the partial coverage.
  const partial = renderFeedback(baseInput({ usage: {
    source: "zcode_runtime_turn", scope: null, observed_at: null, finality: "partial",
    input_tokens: null, output_tokens: 42, total_tokens: null, cached_input_tokens: null, reasoning_tokens: null,
    conflicts: [], dropped_unknown_keys: 0,
  }, usage_note: "2 个 attempt 中 1 个有统计" }));
  assert.match(partial, /输出 42/);
  assert.match(partial, /字段不完整/);
  assert.match(partial, /2 个 attempt 中 1 个有统计/);
  assert.ok(!partial.includes("输入 0"), "缺失输入不得填 0");
});

test("A4-05: running feedback shows phase, elapsed, last progress, and an as-of token note", () => {
  const rendered = renderFeedback(baseInput({
    bridge_status: "running",
    running: { phase: "executing", elapsed_ms: 185_000, last_progress_at: "2026-10-04T00:03:05Z", blockers: [], tokens_note: "截至当前未取得最终 token（任务未结束）" },
  }));
  assert.match(rendered, /仍在运行：当前阶段 executing/);
  assert.match(rendered, /已执行 3 分 5 秒/);
  assert.match(rendered, /最后业务进展 2026-10-04T00:03:05Z/);
  assert.match(rendered, /截至当前未取得最终 token/);
});

test("A4-06: table cells escape pipes/newlines/links and stay narrow; model info separates requested vs confirmed", () => {
  const cell = escapeCell("a|b\nc [x](http://evil.example)");
  assert.ok(!cell.includes("\n"));
  assert.ok(cell.includes("a\\|b"));
  assert.ok(!/\[[^\]]+\]\(http/.test(cell));
  const rendered = renderFeedback(baseInput({
    model: { executor: "zcode", provider_id: "glm", model_id: "glm-4.7", requested_model: "glm/glm-4.6", requested_reasoning_level: "high", effective_reasoning_level: "low", effective_reasoning_level_source: "runtime", selection_source: "runtime", effective_at: null, session_id: null, turn_id: null },
  }));
  assert.match(rendered, /实际 glm\/glm-4.7/);
  assert.match(rendered, /档位 low（runtime 确认）/);
  assert.match(rendered, /请求 glm\/glm-4.6/);
  assert.match(rendered, /请求与实际不一致/);
  // Unreported reasoning level never impersonates a confirmed value.
  const unreported = renderFeedback(baseInput({
    model: { executor: "zcode", provider_id: null, model_id: null, requested_model: null, requested_reasoning_level: null, effective_reasoning_level: null, effective_reasoning_level_source: "not_reported", selection_source: null, effective_at: null, session_id: null, turn_id: null },
  }));
  assert.match(unreported, /档位 未报告（runtime 未确认）/);
});

test("A4-07: the four drill questions are each answerable from a fixed position", () => {
  const rendered = renderFeedback(baseInput({
    verification: { outcome: "部分验证", scope: "AC1 实测，AC2 未验证", items: [{ item: "AC1", result: "独立实测通过", evidence: "npm test" }, { item: "AC2", result: "NOT RUN", evidence: "未取得测试环境" }] },
    usage: { source: "zcode_runtime_turn", scope: null, observed_at: null, finality: "reported", input_tokens: 12_345, output_tokens: 678, total_tokens: 13_023, cached_input_tokens: 0, reasoning_tokens: 100, conflicts: [], dropped_unknown_keys: 0 },
    decisions: ["是否豁免 AC2？"],
  }));
  const overview = rendered.slice(rendered.indexOf("### 任务总览"), rendered.indexOf("### 验收证据"));
  const evidence = rendered.slice(rendered.indexOf("### 验收证据"), rendered.indexOf("### 待处理事项"));
  // 1) 完成了什么 → 总览的 目标与交付
  assert.match(overview, /目标与交付/);
  // 2) 验证到哪一步 → 验收证据表逐条结果
  assert.match(evidence, /\| AC1 \| 独立实测通过 \|/);
  assert.match(evidence, /\| AC2 \| NOT RUN \|/);
  // 3) 花了多少 → token 与耗时行
  assert.match(overview, /13,023/);
  assert.match(overview, /本次耗时/);
  // 4) 还需要决定什么 → 待处理事项
  assert.match(rendered, /待处理事项[\s\S]*需决定：是否豁免 AC2？/);
});

test("formatting helpers: thousands separators, duration units, real zero vs unknown", () => {
  assert.equal(formatTokens(13_023), "13,023");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(null), "未报告");
  assert.equal(formatDuration(59_000), "59 秒");
  assert.equal(formatDuration(61_000), "1 分 1 秒");
  assert.equal(formatDuration(3_723_000), "1 小时 2 分 3 秒");
  assert.equal(formatDuration(null), "未知");
  assert.equal(formatDuration(-5), "未知", "负耗时不得显示");
});

test("feedbackInputFromRecord: running records never reuse a previous task's token totals", () => {
  const record: TaskStatusRecord = {
    task_id: "t2", status: "running", attempt: 1, created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:01:00Z",
    started_at: "2026-10-04T00:00:30Z", finished_at: null, worker_pid: 1, zcode_session_id: null, exit_code: null,
  };
  const previousUsage: NormalizedUsage = { source: "old", scope: null, observed_at: null, finality: "reported", input_tokens: 999, output_tokens: 999, total_tokens: 1998, cached_input_tokens: null, reasoning_tokens: null, conflicts: [], dropped_unknown_keys: 0 };
  const input = feedbackInputFromRecord(record, { task_id: "t2", status: "completed", summary: "old", files_changed: [], tests: [], issues: [], needs_master_decision: false, zcode_output: "", exit_code: 0, session_id: null, attempt: 0, started_at: null, finished_at: null, usage: previousUsage } as unknown as TaskResult);
  assert.equal(input.running?.tokens_note.includes("截至当前未取得"), true);
  assert.equal(input.usage, null, "running feedback never carries stale usage");
  const rendered = renderFeedback({ ...input, objective: "x" });
  assert.ok(!rendered.includes("999"), "running feedback must not show a previous task's usage");
});
