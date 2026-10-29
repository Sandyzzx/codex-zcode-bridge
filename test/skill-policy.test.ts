import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve("plugins/codex-zcode-bridge/skills/zcode-bridge");
const skill = readFileSync(path.join(root, "SKILL.md"), "utf8");
const reference = (name: string) => readFileSync(path.join(root, "references", name), "utf8");

test("Skill requires current scoped authorization before selecting dispatch strategy", () => {
  assert.match(skill, /默认不自动调用 Bridge/);
  assert.match(skill, /历史|此前/);
  assert.match(skill, /新独立目标|下一独立目标/);
  assert.match(skill, /不构成|不扩大/);
});

test("compact Skill routes operations to references and preserves safety duties", () => {
  assert.ok(skill.length < 6000);
  for (const phrase of ["按需", "权限", "额度", "取消", "独立验收", "同时修改"]) assert.ok(skill.includes(phrase), phrase);
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
  assert.match(reference("task-package-templates.md"), /auto.*不是 TaskPackage 字段/);
  assert.match(reference("dispatch-workflow.md"), /新的 task_id/);
});

test("approval, quota-stop and independent acceptance survive progressive disclosure", () => {
  assert.match(reference("monitoring-and-approval.md"), /只有用户明确授权/);
  assert.match(reference("review-and-recovery.md"), /zcode_usage_exhausted/);
  assert.match(reference("review-and-recovery.md"), /独立/);
  assert.match(reference("runtime-boundaries.md"), /不是.*凭证|不是.*鉴权/);
});

test("Skill does not claim SQLite or unmerged release-intent behavior is deployed", () => {
  assert.doesNotMatch(skill, /SQLite 协作合同允许/);
  assert.match(reference("runtime-boundaries.md"), /当前主线不提供release-intent/);
  assert.match(reference("runtime-boundaries.md"), /不引入|未随本功能集成/);
});
