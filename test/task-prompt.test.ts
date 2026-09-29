// Prompt builder tests: required sections, output contract, bounds.
import assert from "node:assert/strict";
import test from "node:test";
import { buildContinuePrompt, buildTaskPrompt } from "../src/prompts/task-prompt.js";
import { makeTask } from "./helpers.js";

test("task prompt contains the package and the output contract", () => {
  const prompt = buildTaskPrompt(makeTask({ task_id: "task_prompt" }));
  assert.match(prompt, /task_prompt/);
  assert.match(prompt, /OBJECTIVE/);
  assert.match(prompt, /Create bridge-smoke\.txt/);
  assert.match(prompt, /REQUIREMENTS/);
  assert.match(prompt, /ALLOWED PATHS/);
  assert.match(prompt, /bridge-smoke\.txt/);
  assert.match(prompt, /FORBIDDEN PATHS/);
  assert.match(prompt, /\.\.\/outside/);
  assert.match(prompt, /ACCEPTANCE CRITERIA/);
  assert.match(prompt, /needs_master_decision/);
  assert.match(prompt, /exactly one JSON object/);
});

test("empty arrays render as explicit none", () => {
  const prompt = buildTaskPrompt(
    makeTask({ requirements: [], allowed_paths: [], forbidden_paths: [], acceptance_criteria: [], test_commands: [] }),
  );
  assert.match(prompt, /\(none\)/);
});

test("an explicitly selected ZCode model is recorded in the bounded prompt", () => {
  const prompt = buildTaskPrompt(makeTask({ model: { provider_id: "provider-1", model_id: "model-x", reasoning_level: "high" } }));
  assert.match(prompt, /REQUESTED ZCODE MODEL: provider-1\/model-x \(reasoning level: high\)/);
});

test("oversized context is bounded with a truncation marker", () => {
  const prompt = buildTaskPrompt(makeTask({ context: "c".repeat(100_000) }));
  assert.ok(prompt.length < 20_000);
  assert.match(prompt, /\[truncated\]/);
});

test("continue prompt carries feedback, additional requirements, and prior result", () => {
  const prompt = buildContinuePrompt({
    task: makeTask({ task_id: "task_cont" }),
    feedback: "Test X still fails; fix it",
    additionalRequirements: ["Keep the public API stable"],
    previousSessionId: "sess_abc",
    previousResult: {
      task_id: "task_cont",
      status: "failed",
      summary: "previous attempt summary",
      files_changed: ["a.py"],
      tests: [{ command: "pytest", status: "failed", details: "assert 1==2" }],
      issues: [],
      needs_master_decision: false,
      zcode_output: "",
      exit_code: 0,
      session_id: "sess_abc",
      attempt: 1,
      started_at: null,
      finished_at: null,
    },
  });
  assert.match(prompt, /Test X still fails; fix it/);
  assert.match(prompt, /Keep the public API stable/);
  assert.match(prompt, /previous attempt summary/);
  assert.match(prompt, /sess_abc/);
  assert.match(prompt, /needs_master_decision/);
});
