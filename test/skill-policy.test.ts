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
  assert.match(skill, /调用前必须取得用户明确授权/);
  assert.match(recovery, /failed \+ cleanup_unverified/);
  assert.match(recovery, /MCP 没有 Task 枚举工具/);
  assert.match(recovery, /`zcode_status` 不返回 workspace/);
  assert.match(recovery, /明确授权/);
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

const evaluation = JSON.parse(readFileSync(path.resolve("test/fixtures/master-skill-evaluation-20261111.json"), "utf8")) as {
  readonly comparison: string;
  readonly model: string;
  readonly scenarios: ReadonlyArray<{
    readonly id: string;
    readonly expected: string;
    readonly new: Readonly<Record<"planning" | "boundary" | "acceptance" | "efficiency", number> & { total: number }>;
  }>;
};

test("Master Skill offline evaluation is paired and covers the required scenarios", () => {
  assert.match(evaluation.comparison, /static offline paired comparison/);
  assert.equal(evaluation.model, "none");
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
