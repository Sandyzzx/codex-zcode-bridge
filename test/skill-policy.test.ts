import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve("plugins/codex-zcode-bridge/skills/zcode-bridge");
const skill = readFileSync(path.join(root, "SKILL.md"), "utf8");
const reference = (name: string) => readFileSync(path.join(root, "references", name), "utf8");

test("Skill requires current scoped authorization before selecting dispatch strategy", () => {
  assert.match(skill, /默认不为新独立目标调用 Bridge/);
  assert.match(skill, /历史|此前/);
  assert.match(skill, /新独立目标|下一独立目标/);
  assert.match(skill, /不构成|不扩大/);
  assert.match(skill, /明确选择 ZCode\/Bridge[\s\S]*不得仅因 Master 自认为更快/);
});

test("compact Skill routes operations to references and preserves safety duties", () => {
  assert.ok(skill.length < 6000);
  for (const phrase of ["只读当前行为需要", "权限", "额度", "取消", "独立验收", "同时修改"]) assert.ok(skill.includes(phrase), phrase);
  for (const name of readdirSync(path.join(root, "references"))) {
    assert.ok(skill.includes(name), name);
  }
});

test("all Skill Markdown reference targets exist", () => {
  for (const file of ["SKILL.md", ...readdirSync(path.join(root, "references")).map(n => `references/${n}`)]) {
    for (const match of readFileSync(path.join(root, file), "utf8").matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(match[1]!)) continue;
      assert.ok(existsSync(path.resolve(root, path.dirname(file), match[1]!.split("#")[0]!)), `${file}: ${match[1]}`);
    }
  }
});

test("whole-task is the default and staged is reserved for a real gate", () => {
  const policy = reference("delegation-policy.md");
  for (const phrase of ["whole_task", "staged", "默认", "例外", "不是", "授权", "审批", "zcode_continue"]) assert.ok(policy.includes(phrase), phrase);
  assert.match(policy, /whole_task.*默认/);
  assert.match(policy, /staged.*例外/);
  assert.doesNotMatch(policy, /只读 `auto`|\bauto\b/u);
  assert.match(reference("task-dispatch.md"), /whole_task.*staged.*不是额外字段/);
  assert.match(reference("task-dispatch.md"), /provider_id.*可选/);
  assert.match(reference("task-dispatch.md"), /相同 ID、相同内容[\s\S]*不产生第二次执行/);
  assert.match(reference("task-dispatch.md"), /TASK_ID_CONFLICT[\s\S]*查询原任务/);
  assert.match(reference("task-dispatch.md"), /回执丢失或结果未知[\s\S]*不生成新 ID/);
  assert.match(reference("task-dispatch.md"), /前序 Attempt 已 Release 时用 `zcode_continue`/);
  const dispatch = reference("task-dispatch.md");
  for (const phrase of ["no_entitlement", "quota_exhausted", "model_unavailable", "3007/3012", "401/403", "不触发回退"]) {
    assert.ok(dispatch.includes(phrase), phrase);
  }
});

test("approval, quota-stop and independent acceptance survive progressive disclosure", () => {
  assert.match(reference("monitoring-and-approval.md"), /只有用户明确授权/);
  assert.match(reference("review-and-recovery.md"), /zcode_usage_exhausted/);
  assert.match(reference("review-and-recovery.md"), /独立/);
  assert.match(reference("runtime-boundaries.md"), /不是.*凭证|不是.*鉴权/);
});

test("Master proactively reports known cleanup Holds and gates Recovery on authorization", () => {
  const recovery = reference("review-and-recovery.md");
  assert.match(skill, /已知 SQLite 清理 Hold 不得绕过/);
  assert.match(skill, /`zcode_cancel` 是唯一标准恢复入口/);
  assert.match(skill, /可能终止原身份 Worker/);
  assert.match(skill, /一次调用就是用户授权/);
  assert.match(skill, /不决定是否需要额外用户资格/);
  assert.match(recovery, /failed \+ cleanup_unverified/);
  assert.match(recovery, /核心 MCP 没有 Bridge Task\/Attempt 全局枚举工具/);
  assert.doesNotMatch(recovery, /可选 Ledger|ProjectTask/);
  assert.match(recovery, /不得猜 workspace 或扫描其他任务/);
  assert.match(recovery, /`zcode_status` 不返回 workspace/);
  assert.match(recovery, /明确授权/);
  assert.match(recovery, /当前明确 Recovery 操作，不是无限期终止权限/);
  assert.match(recovery, /同一 Operation 一次只发起一个 cancel/);
  assert.match(recovery, /原授权范围内可再次尝试/);
  assert.match(recovery, /不得并发重复发出终止信号/);
  assert.match(recovery, /先检查原 workspace Git diff\/WIP/);
  assert.match(recovery, /不得拼接底层清理命令/);
});

test("Skill does not claim SQLite or unmerged release-intent behavior is deployed", () => {
  assert.doesNotMatch(skill, /SQLite 协作合同允许/);
  assert.match(reference("runtime-boundaries.md"), /当前没有 release-intent/);
  assert.match(reference("runtime-boundaries.md"), /不引入新状态机/);
  for (const file of ["SKILL.md", ...readdirSync(path.join(root, "references")).map(n => `references/${n}`)]) {
    const text = readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /npm run test:(affected|full)/, `${file}: project-specific test entry`);
  }
});

test("Async Handoff is default, bounded, and uses Events for lifecycle proof", () => {
  const handoff = reference("async-handoff.md");
  const monitoring = reference("monitoring-and-approval.md");
  const dispatch = reference("task-dispatch.md");
  assert.match(handoff, /async_wake.*默认/);
  assert.match(handoff, /不要等待\s*`turn_started`/);
  assert.match(handoff, /owner_thread_unavailable[\s\S]*auto_wake_disabled[\s\S]*Web\s*Notify[\s\S]*结束\s*Turn/);
  assert.match(handoff, /Executor Authority 无法核实[\s\S]*保持未决/);
  assert.match(skill, /owner_thread_unavailable[\s\S]*auto_wake_disabled[\s\S]*Web Notify[\s\S]*结束 Turn/);
  assert.match(skill, /回执未知、启动错误、清理未决或 Authority 边界无法确认[\s\S]*保持未决/);
  assert.match(handoff, /result_committed[\s\S]*cleanup_verified[\s\S]*released/);
  assert.match(handoff, /Result 摘要只提供 Worker 交付内容，不证明 digest、Cleanup 或\s*Release/);
  assert.match(monitoring, /## Async 受理核对/);
  assert.match(monitoring, /不要为等待 `turn_started`/);
  assert.doesNotMatch(monitoring, /2,000|2000/);
  assert.doesNotMatch(dispatch, /2,000|2000/);
  assert.match(dispatch, /不等待 `turn_started`/);
});

type HandoffScenario = {
  readonly name: string;
  readonly authorized: boolean;
  readonly scope: "whole_task" | "staged";
  readonly receipt: "accepted" | "unknown" | "none";
  readonly authorityKnown: boolean;
  readonly threadKnown: boolean;
  readonly pendingInteraction: boolean;
  readonly event: "none" | "turn_end" | "disconnect" | "cancel";
  readonly cancelAuthorized: boolean;
  readonly wakeIdentity: "none" | "match" | "mismatch";
  readonly resultEvidence: boolean;
  readonly expected: {
    readonly action:
      | "request_authorization"
      | "reconcile_same_task"
      | "hold_unresolved"
      | "foreground_pending"
      | "async_wake"
      | "async_web_notify"
      | "recover_and_verify"
      | "identity_conflict"
      | "no_cancel"
      | "authorized_cancel";
    readonly endTurn: boolean;
    readonly continuePolling: boolean;
    readonly cancel: boolean;
    readonly accepted: boolean;
  };
};

// This is an executable decision contract for the Markdown workflow. It is not
// evidence that a model actually follows the Skill on a live Host.
function decideHandoff(input: HandoffScenario): HandoffScenario["expected"] {
  if (!input.authorized) {
    return { action: "request_authorization", endTurn: false, continuePolling: false, cancel: false, accepted: false };
  }
  if (input.event === "cancel") {
    return input.cancelAuthorized
      ? { action: "authorized_cancel", endTurn: true, continuePolling: false, cancel: true, accepted: false }
      : { action: "no_cancel", endTurn: false, continuePolling: false, cancel: false, accepted: false };
  }
  if (input.event === "turn_end" || input.event === "disconnect") {
    return { action: "no_cancel", endTurn: input.event === "turn_end", continuePolling: false, cancel: false, accepted: false };
  }
  if (input.wakeIdentity === "mismatch") {
    return { action: "identity_conflict", endTurn: false, continuePolling: false, cancel: false, accepted: false };
  }
  if (input.wakeIdentity === "match") {
    return {
      action: "recover_and_verify",
      endTurn: false,
      continuePolling: false,
      cancel: false,
      accepted: false,
    };
  }
  if (input.receipt === "unknown") {
    return { action: "reconcile_same_task", endTurn: false, continuePolling: false, cancel: false, accepted: false };
  }
  if (input.receipt === "none") {
    return { action: "request_authorization", endTurn: false, continuePolling: false, cancel: false, accepted: false };
  }
  if (input.pendingInteraction) {
    return { action: "foreground_pending", endTurn: false, continuePolling: false, cancel: false, accepted: false };
  }
  if (!input.authorityKnown) {
    return { action: "hold_unresolved", endTurn: false, continuePolling: false, cancel: false, accepted: false };
  }
  return input.threadKnown
    ? { action: "async_wake", endTurn: true, continuePolling: false, cancel: false, accepted: false }
    : { action: "async_web_notify", endTurn: true, continuePolling: false, cancel: false, accepted: false };
}

test("deterministic Async Handoff workflow separates scope, handoff, Wake and acceptance", () => {
  const base: HandoffScenario = {
    name: "accepted",
    authorized: true,
    scope: "whole_task",
    receipt: "accepted",
    authorityKnown: true,
    threadKnown: true,
    pendingInteraction: false,
    event: "none",
    cancelAuthorized: false,
    wakeIdentity: "none",
    resultEvidence: false,
    expected: {
      action: "async_wake",
      endTurn: true,
      continuePolling: false,
      cancel: false,
      accepted: false,
    },
  };
  const scenarios: readonly HandoffScenario[] = [
    base,
    { ...base, name: "unauthorized", authorized: false, expected: { action: "request_authorization", endTurn: false, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "staged", scope: "staged" },
    { ...base, name: "readonly-whole-task", scope: "whole_task" },
    { ...base, name: "authority-unknown-holds", authorityKnown: false, expected: { action: "hold_unresolved", endTurn: false, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "web-fallback", threadKnown: false, expected: { action: "async_web_notify", endTurn: true, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "unknown-receipt", receipt: "unknown", expected: { action: "reconcile_same_task", endTurn: false, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "pending-before-handoff", pendingInteraction: true, expected: { action: "foreground_pending", endTurn: false, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "turn-end-does-not-cancel", event: "turn_end", expected: { action: "no_cancel", endTurn: true, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "disconnect-does-not-cancel", event: "disconnect", expected: { action: "no_cancel", endTurn: false, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "cancel-without-owner-authorization", event: "cancel", expected: { action: "no_cancel", endTurn: false, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "explicit-authorized-cancel", event: "cancel", cancelAuthorized: true, expected: { action: "authorized_cancel", endTurn: true, continuePolling: false, cancel: true, accepted: false } },
    { ...base, name: "wake-identity-mismatch", wakeIdentity: "mismatch", expected: { action: "identity_conflict", endTurn: false, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "wake-is-not-acceptance", wakeIdentity: "match", resultEvidence: true, expected: { action: "recover_and_verify", endTurn: false, continuePolling: false, cancel: false, accepted: false } },
    { ...base, name: "wake-pending-is-not-acceptance", wakeIdentity: "match", pendingInteraction: true, expected: { action: "recover_and_verify", endTurn: false, continuePolling: false, cancel: false, accepted: false } },
  ];

  for (const scenario of scenarios) assert.deepEqual(decideHandoff(scenario), scenario.expected, scenario.name);

  const handoff = reference("async-handoff.md");
  for (const phrase of [
    "whole_task",
    "staged",
    "async_wake",
    "foreground",
    "可靠受理",
    "SUBMISSION_UNKNOWN",
    "同一",
    "Turn 结束",
    "停止轮询",
    "Pending Interaction",
    "QUEUED",
    "TURN_STARTED",
    "TURN_COMPLETED",
    "DESKTOP_VISIBLE",
    "UNKNOWN",
    "Cleanup",
    "released",
    "diff",
    "测试",
    "不是",
    "codex queue",
    "owner_thread_unavailable",
    "auto_wake_disabled",
    "console_link",
    "task console-url",
    "web_url",
    "真实可访问",
    "CSRF",
  ]) assert.ok(handoff.includes(phrase), phrase);
  assert.match(handoff, /Turn 结束、Host 断开、MCP Stop[\s\S]*不.*取消/);
  assert.match(handoff, /回执未知[\s\S]*原 `task_id`[\s\S]*不得生成替换 Task ID/);
  assert.match(handoff, /Wake[\s\S]*不是 Master 已恢复[\s\S]*Task 已接收/);
  assert.match(handoff, /Cleanup[\s\S]*Release[\s\S]*Master acceptance/);
  assert.match(handoff, /`web_url`[\s\S]*不证明[\s\S]*Result/);
  assert.match(handoff, /Console 不可用[\s\S]*替代/);
});

test("Wake readback uses native Host MCP rather than a sandboxed shell child", () => {
  const handoff = reference("async-handoff.md");
  assert.match(skill, /Host 已注册的原生 `zcode_status`/);
  assert.match(skill, /`zcode_result\(view="summary", expected_attempt=<Attempt>\)`/);
  assert.match(skill, /不要在受限 Thread 中[\s\S]*Thin MCP 或 Task CLI/);
  assert.match(handoff, /直接使用 Host 已注册的原生 MCP 工具/);
  assert.match(handoff, /原生 `zcode_result\(view="summary", expected_attempt=<Attempt>\)`/);
  assert.match(handoff, /不要在受限 Thread 中用[\s\S]*Thin MCP 或 Task CLI/);
  assert.match(handoff, /把 Queue ACK 或固定 ACK 当作验收/);
});

const evaluation = JSON.parse(readFileSync(path.resolve("test/fixtures/master-skill-evaluation-20261111.json"), "utf8")) as {
  readonly comparison: string;
  readonly model: string;
  readonly method: string;
  readonly automated_model_execution: boolean;
  readonly scoring_source: string;
  readonly pass_rule: { readonly forbidden: readonly string[] };
  readonly scenarios: ReadonlyArray<{
    readonly id: string;
    readonly expected: string;
    readonly new: Readonly<Record<"planning" | "boundary" | "acceptance" | "efficiency", number> & { total: number }>;
  }>;
};

test("Master Skill offline evaluation is paired and covers the required scenarios", () => {
  assert.match(evaluation.comparison, /manual static paired review matrix/);
  assert.equal(evaluation.model, "none");
  assert.equal(evaluation.method, "manual static review");
  assert.equal(evaluation.automated_model_execution, false);
  assert.equal(evaluation.scoring_source, "human reviewer");
  const forbidden = evaluation.pass_rule.forbidden.join("\n");
  for (const phrase of ["unauthorized dispatch", "usage exhaustion", "Worker report", "Auto as a dispatch mode", "meaningless stage gate"]) {
    assert.ok(forbidden.includes(phrase), phrase);
  }
  const requiredIds = new Set([
    "single-file-repair",
    "cross-file-feature",
    "open-public-api",
    "research-only",
    "parallel-independent-tasks",
    "dependent-stage",
    "unknown-worker-capability",
    "worker-autonomous-completion",
    "bridge-unauthorized",
    "user-selected-executor",
    "session-level-authorization",
    "readonly-whole-task",
    "same-task-rework",
    "sqlite-hold-recovery",
    "usage-exhausted",
  ]);
  const actualIds = new Set(evaluation.scenarios.map((scenario) => scenario.id));
  for (const id of requiredIds) assert.ok(actualIds.has(id), id);
  assert.ok(evaluation.scenarios.length >= 14);
});

test("Every new-version offline scenario scores at least 7/8 without a zero dimension", () => {
  const dimensions = ["planning", "boundary", "acceptance", "efficiency"] as const;
  for (const scenario of evaluation.scenarios) {
    for (const dimension of dimensions) {
      const score = scenario.new[dimension];
      assert.ok(score >= 0 && score <= 2, `${scenario.id}.${dimension}: ${score}`);
      assert.notEqual(score, 0, `${scenario.id}.${dimension} must not be zero`);
    }
    assert.equal(scenario.new.total, dimensions.reduce((sum, dimension) => sum + scenario.new[dimension], 0), scenario.id);
    assert.ok(scenario.new.total >= 7 && scenario.new.total <= 8, `${scenario.id}: ${scenario.new.total}`);
    assert.ok(scenario.expected.trim().length > 0, scenario.id);
  }
});

type AutonomyAction = "accept" | "continue_rework" | "linked_rework" | "circuit_break" | "hold" | "reconcile_queue";
type AutonomyBlocker =
  | "none"
  | "authorization_scope"
  | "contract_decision"
  | "pending_interaction"
  | "usage_exhausted"
  | "hold_unknown"
  | "queue_unknown";
type AutonomyCase = {
  readonly id: string;
  readonly accepted: boolean;
  readonly blocker: AutonomyBlocker;
  readonly continue_eligible: boolean;
  readonly workspace_safe: boolean;
  readonly previous_rework: boolean;
  readonly same_root_cause: boolean;
  readonly progress: boolean;
  readonly expected: {
    readonly action: AutonomyAction;
    readonly preserve_evidence: boolean;
    readonly inherit_fields: boolean;
    readonly lower_acceptance: boolean;
    readonly queue_resubmit: boolean;
    readonly approval_for_ordinary_defect: boolean;
  };
};
type AutonomyFixture = {
  readonly kind: string;
  readonly evidence_boundary: string;
  readonly token_budget: {
    readonly tokenizer_package: string;
    readonly tokenizer_version: string;
    readonly encoding: string;
    readonly preview16_commit: string;
    readonly load_order: readonly string[];
    readonly preview16_full_tokens: number;
    readonly preview17_full_tokens: number;
    readonly net_increase: number;
    readonly hard_max_net_increase: number;
    readonly target_net_increase: number;
    readonly stable_prefix_tokens: number;
    readonly stable_prefix_percent_of_preview16: number;
    readonly preview16_sha256_normalized_lf: Readonly<Record<string, string>>;
    readonly preview17_sha256_normalized_lf: Readonly<Record<string, string>>;
  };
  readonly r10_regression: {
    readonly scope: string;
    readonly must_fail_acceptance: ReadonlyArray<{ readonly id: string; readonly observation: string; readonly reason: string }>;
    readonly expected_action: AutonomyAction;
  };
  readonly cases: readonly AutonomyCase[];
};

const autonomy = JSON.parse(readFileSync(path.resolve("test/fixtures/master-goal-autonomy-20261125.json"), "utf8")) as AutonomyFixture;

function decideAutonomyFollowup(input: AutonomyCase): AutonomyCase["expected"] {
  const base = {
    preserve_evidence: true,
    lower_acceptance: false,
    queue_resubmit: false,
    approval_for_ordinary_defect: false,
  } as const;
  if (input.accepted) return { ...base, action: "accept", inherit_fields: false };
  if (input.blocker === "queue_unknown") return { ...base, action: "reconcile_queue", inherit_fields: false };
  if (input.blocker !== "none") return { ...base, action: "hold", inherit_fields: false };
  if (input.previous_rework && input.same_root_cause && !input.progress) {
    return { ...base, action: "circuit_break", inherit_fields: false };
  }
  if (input.continue_eligible) return { ...base, action: "continue_rework", inherit_fields: true };
  if (input.workspace_safe) return { ...base, action: "linked_rework", inherit_fields: true };
  return { ...base, action: "hold", inherit_fields: false };
}

test("Master autonomy keeps the complete Skill within the Preview.16 token and prefix budget", () => {
  const budget = autonomy.token_budget;
  assert.equal(autonomy.kind, "deterministic Master acceptance-followup contract");
  assert.match(autonomy.evidence_boundary, /no live model execution/);
  assert.equal(budget.tokenizer_package, "js-tiktoken");
  assert.equal(budget.tokenizer_version, "1.0.21");
  assert.equal(budget.encoding, "o200k_base");
  assert.equal(budget.preview16_commit, "6af69b55d7ecb660c2ad2c923888cf7f1e8886c8");
  assert.equal(budget.load_order.length, 9);
  assert.equal(budget.preview17_full_tokens - budget.preview16_full_tokens, budget.net_increase);
  assert.ok(budget.net_increase <= budget.target_net_increase);
  assert.ok(budget.net_increase <= budget.hard_max_net_increase);
  assert.ok(budget.stable_prefix_tokens > budget.preview16_full_tokens * 0.6);
  assert.ok(budget.stable_prefix_percent_of_preview16 > 60);

  for (const file of budget.load_order) {
    const text = readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    const digest = createHash("sha256").update(text).digest("hex");
    assert.equal(budget.preview17_sha256_normalized_lf[file], digest, file);
    if (file === "references/review-and-recovery.md") {
      assert.notEqual(budget.preview16_sha256_normalized_lf[file], digest, file);
    } else {
      assert.equal(budget.preview16_sha256_normalized_lf[file], digest, file);
    }
  }
});

test("Master autonomously continues, links or circuits acceptance rework without lowering the bar", () => {
  const review = reference("review-and-recovery.md");
  for (const phrase of [
    "Master 对最终目标负责",
    "普通工程缺陷直接返工，不请求批准",
    "首次失败至少完成一次返工",
    "同一根因无进展才熔断",
    "关联返工 Task",
    "zcode_continue",
    "zcode_task",
    "继承最终目标",
    "请求的模型与 reasoning effort",
    "timeout",
    "只可补充或收紧验收，不得降低或重解释",
    "保留失败 Task/Attempt/Result/Events",
    "不得重复未知 Queue submission",
    "用户取消/停止",
    "不新增 Goal Skill",
    "第二授权体系",
  ]) {
    assert.ok(review.includes(phrase), phrase);
  }
  assert.match(review, /主窗口前台不证明对话框或控件获得输入/);
  assert.match(review, /部分发送后继续执行也不证明成功/);

  for (const scenario of autonomy.cases) {
    assert.deepEqual(decideAutonomyFollowup(scenario), scenario.expected, scenario.id);
    assert.equal(scenario.expected.lower_acceptance, false, scenario.id);
    assert.equal(scenario.expected.queue_resubmit, false, scenario.id);
    assert.equal(scenario.expected.approval_for_ordinary_defect, false, scenario.id);
    assert.equal(scenario.expected.preserve_evidence, true, scenario.id);
  }
});

test("R10 input-target protection cases fail acceptance and rework semantically without live data access", () => {
  const regression = autonomy.r10_regression;
  assert.match(regression.scope, /do not re-dispatch historical R10/);
  assert.match(regression.scope, /LumeCAE production data/);
  assert.equal(regression.expected_action, "continue_rework");
  assert.equal(regression.must_fail_acceptance.length, 2);
  assert.deepEqual(
    new Set(regression.must_fail_acceptance.map((entry) => entry.id)),
    new Set(["main-window-foreground", "partial-mouse-events"]),
  );
  for (const id of ["r10-main-window-foreground", "r10-partial-mouse-events"]) {
    const scenario = autonomy.cases.find((entry) => entry.id === id);
    assert.ok(scenario, id);
    assert.equal(decideAutonomyFollowup(scenario).action, "continue_rework", id);
  }
});
