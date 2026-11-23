import assert from "node:assert/strict";
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

test("auto chooses whole-task or a bounded stage without adding a tool field", () => {
  const policy = reference("delegation-policy.md");
  for (const phrase of ["whole_task", "staged", "auto", "不是", "授权", "审批", "zcode_continue"]) assert.ok(policy.includes(phrase), phrase);
  assert.match(reference("task-dispatch.md"), /auto.*不是额外字段/);
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
  assert.match(recovery, /可选 Ledger 只能枚举其管理的 ProjectTask/);
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

type HandoffScenario = {
  readonly name: string;
  readonly authorized: boolean;
  readonly scope: "whole_task" | "staged" | "auto";
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
  return input.authorityKnown && input.threadKnown
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
    { ...base, name: "readonly-auto", scope: "auto" },
    { ...base, name: "web-fallback-authority-unknown", authorityKnown: false, expected: { action: "async_web_notify", endTurn: true, continuePolling: false, cancel: false, accepted: false } },
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
    "trusted-local",
    "trusted_local_turn_start_unverified",
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
  for (const phrase of ["unauthorized dispatch", "usage exhaustion", "Worker report", "auto as an MCP field", "meaningless stage gate"]) {
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
    "auto-read-only",
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
