// Prompt builder tests: required sections, output contract, bounds.
import assert from "node:assert/strict";
import test from "node:test";
import { buildContinuePrompt, buildTaskPrompt, MAX_PROMPT_CHARS, TaskPromptCapacityError } from "../src/prompts/task-prompt.js";
import { makeTask } from "./helpers.js";
import { parseAgentReport } from "../src/adapters/agent-report.js";
import type { TaskResult } from "../src/interfaces.js";

const occurrences = (text: string, value: string): number => text.split(value).length - 1;

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

test("stable worker rules precede the dynamic task identifier", () => {
  const prompt = buildTaskPrompt(makeTask());
  const taskId = prompt.indexOf("TASK ID:");
  assert.ok(taskId > 0);
  assert.ok(prompt.indexOf("DELIVERY OWNERSHIP") < taskId);
  assert.ok(prompt.indexOf("DECISION RULE") < taskId);
  assert.equal(occurrences(prompt, "DELIVERY OWNERSHIP"), 1);
  assert.equal(occurrences(prompt, "DECISION RULE"), 1);
  assert.equal(occurrences(prompt, "OUTPUT CONTRACT (mandatory)"), 1);
  assert.match(prompt, /one complete task/);
  assert.match(prompt, /DELIVERY OWNERSHIP/);
  assert.match(prompt, /implement every required change/);
  assert.match(prompt, /Do not stop after a partial step/);
  assert.match(prompt, /your report is evidence of what you did/);
});

test("different first dispatches share a stable prefix before task-specific data", () => {
  const first = buildTaskPrompt(makeTask({ task_id: "task_a" }));
  const second = buildTaskPrompt(makeTask({
    task_id: "task_b",
    objective: "Review a different parser",
  }));
  let common = 0;
  while (common < first.length && common < second.length && first[common] === second[common]) {
    common += 1;
  }
  const prefix = first.slice(0, common);
  assert.match(prefix, /DELIVERY OWNERSHIP/);
  assert.match(prefix, /DECISION RULE/);
  assert.doesNotMatch(prefix, /task_a|task_b/);
  assert.ok(common > 1_000);
});

test("mandatory output example is valid JSON with all required fields", () => {
  const prompt = buildTaskPrompt(makeTask());
  const line = prompt.split("\n").find((text) => text.startsWith("Valid JSON example"));
  assert.ok(line);
  assert.equal(parseAgentReport(line.slice(line.indexOf("{"))).error, null);
});

test("report-only continuation preserves candidate claims and a bounded response tail without implementation instructions", () => {
  const result: TaskResult = {
    task_id: "repair", status: "failed", error_code: "invalid_agent_report", summary: "report.needs_master_decision must be a boolean",
    files_changed: [], tests: [], issues: [], needs_master_decision: true,
    zcode_output: `HEAD_SENTINEL\n${"x".repeat(50_000)}\nTAIL_SENTINEL`,
    exit_code: 0, session_id: "session", attempt: 1, started_at: null, finished_at: null,
    report_candidate: { summary: "actual candidate", files_changed: ["only.txt"], tests: [{ command: "actual test", status: "failed" }], issues: ["known issue"] },
  };
  const prompt = buildContinuePrompt({ task: makeTask({ objective: "IMPLEMENTATION_SENTINEL", test_commands: ["DO_NOT_RERUN"] }),
    feedback: "Correct the report", additionalRequirements: [], previousSessionId: "session", previousResult: result });
  assert.match(prompt, /actual candidate/);
  assert.match(prompt, /actual test/);
  assert.match(prompt, /known issue/);
  assert.match(prompt, /"status":"failed"/);
  assert.match(prompt, /Do not use tools/);
  assert.match(prompt, /HEAD_SENTINEL/);
  assert.match(prompt, /TAIL_SENTINEL/);
  assert.match(prompt, /characters omitted/);
  assert.doesNotMatch(prompt, /DELIVERY OWNERSHIP|implement every required change|run the applicable tests|IMPLEMENTATION_SENTINEL|DO_NOT_RERUN|ORIGINAL TASK/);
  assert.equal(occurrences(prompt, "OUTPUT CONTRACT (mandatory)"), 1);
  assert.ok(prompt.length < 8_000);
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

test("accepted task context is preserved without a hidden character cap", () => {
  const context = `普通上下文 ${"界".repeat(2_500)} Unicode e\u0301 emoji 😀`;
  const prompt = buildTaskPrompt(makeTask({ context }));
  assert.ok(prompt.includes(context));
  assert.ok(Buffer.byteLength(prompt, "utf8") > Buffer.byteLength("界".repeat(2_000), "utf8"));
});

test("task context boundary is enforced by the total prompt capacity", () => {
  const task = makeTask();
  const oneCharacterPromptLength = buildTaskPrompt({ ...task, context: "x" }).length;
  const context = "x".repeat(MAX_PROMPT_CHARS - oneCharacterPromptLength + 1);
  assert.equal(buildTaskPrompt({ ...task, context }).length, MAX_PROMPT_CHARS);
  assert.throws(
    () => buildTaskPrompt({ ...task, context: `${context}x` }),
    (error: unknown) => error instanceof TaskPromptCapacityError
      && error.code === "task_prompt_exceeds_capacity"
      && error.maxChars === MAX_PROMPT_CHARS,
  );
});

test("over-capacity Chinese and Unicode context fails instead of truncating", () => {
  const context = `中文任务约束 😀 ${"界".repeat(MAX_PROMPT_CHARS)}`;
  assert.throws(() => buildTaskPrompt(makeTask({ context })), TaskPromptCapacityError);
});

test("continue prompt keeps the task contract once and projects only actionable prior evidence", () => {
  const prompt = buildContinuePrompt({
    task: makeTask({ task_id: "task_cont" }),
    feedback: "Test X still fails; fix it",
    additionalRequirements: ["Keep the public API stable"],
    previousSessionId: "sess_abc",
    previousResult: {
      task_id: "task_cont",
      status: "failed",
      summary: "previous attempt summary",
      files_changed: ["a.py", "b.py"],
      tests: [
        { command: "pytest", status: "failed", details: "assert 1==2" },
        { command: "lint", status: "not_run", details: "blocked by failure" },
        { command: "smoke", status: "passed" },
      ],
      issues: ["Keep the public API stable", "Decide the migration boundary"],
      needs_master_decision: false,
      zcode_output: "OLD_OUTPUT_SENTINEL",
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
  assert.match(prompt, /"status":"failed"/);
  assert.match(prompt, /"status":"not_run"/);
  assert.match(prompt, /"passed":1/);
  assert.match(prompt, /a\.py/);
  assert.match(prompt, /b\.py/);
  assert.doesNotMatch(prompt, /OLD_OUTPUT_SENTINEL|ORIGINAL TASK/);
  assert.match(prompt, /DELIVERY OWNERSHIP/);
  assert.match(prompt, /needs_master_decision/);
  assert.equal(occurrences(prompt, "DELIVERY OWNERSHIP"), 1);
  assert.equal(occurrences(prompt, "DECISION RULE"), 1);
  assert.equal(occurrences(prompt, "OUTPUT CONTRACT (mandatory)"), 1);
  assert.equal(occurrences(prompt, "TASK ID:"), 1);
});

test("continue without a session still carries the full effective task contract", () => {
  const prompt = buildContinuePrompt({
    task: makeTask({
      task_id: "no_session",
      objective: "OBJECTIVE_SENTINEL",
      requirements: ["REQUIREMENT_SENTINEL"],
      allowed_paths: ["ALLOWED_SENTINEL"],
      forbidden_paths: ["FORBIDDEN_SENTINEL"],
      acceptance_criteria: ["ACCEPTANCE_SENTINEL"],
      test_commands: ["TEST_SENTINEL"],
    }),
    feedback: "CONTINUE_FEEDBACK_SENTINEL",
    additionalRequirements: [],
    previousSessionId: null,
    previousResult: null,
  });
  for (const sentinel of [
    "OBJECTIVE_SENTINEL",
    "REQUIREMENT_SENTINEL",
    "ALLOWED_SENTINEL",
    "FORBIDDEN_SENTINEL",
    "ACCEPTANCE_SENTINEL",
    "TEST_SENTINEL",
    "CONTINUE_FEEDBACK_SENTINEL",
  ]) assert.match(prompt, new RegExp(sentinel));
  assert.doesNotMatch(prompt, /SESSION CONTEXT/);
  assert.equal(occurrences(prompt, "DELIVERY OWNERSHIP"), 1);
  assert.equal(occurrences(prompt, "OUTPUT CONTRACT (mandatory)"), 1);
});

test("later continuations do not accumulate older result text", () => {
  const prompt = buildContinuePrompt({
    task: makeTask({ task_id: "later_continue" }),
    feedback: "Address only the current failure",
    additionalRequirements: [],
    previousSessionId: "session-2",
    previousResult: {
      task_id: "later_continue",
      status: "failed",
      summary: "attempt two",
      files_changed: [],
      tests: [],
      issues: [],
      needs_master_decision: false,
      zcode_output: "ATTEMPT_TWO_OUTPUT",
      exit_code: 0,
      session_id: "session-2",
      attempt: 2,
      started_at: null,
      finished_at: null,
    },
  });
  assert.match(prompt, /attempt two/);
  assert.match(prompt, /session-2/);
  assert.doesNotMatch(prompt, /ATTEMPT_ONE_OUTPUT|ATTEMPT_TWO_OUTPUT/);
});

test("continue capacity failure is explicit rather than silently dropping constraints", () => {
  assert.throws(
    () => buildContinuePrompt({
      task: makeTask({ context: "x".repeat(MAX_PROMPT_CHARS + 1_000) }),
      feedback: "continue",
      additionalRequirements: [],
      previousSessionId: null,
      previousResult: null,
    }),
    (error: unknown) => error instanceof TaskPromptCapacityError
      && error.code === "task_prompt_exceeds_capacity",
  );
});

test("continue bounds feedback to the remaining capacity so an accepted task stays continuable (P2 §4.4)", () => {
  const nearLimitContext = "x".repeat(MAX_PROMPT_CHARS - 12_000);
  const task = makeTask({ context: nearLimitContext });
  const feedback = "y".repeat(30_000);
  const prompt = buildContinuePrompt({
    task, feedback, additionalRequirements: [], previousSessionId: null, previousResult: null,
  });
  assert.ok(prompt.length <= MAX_PROMPT_CHARS, `continue must stay within capacity (got ${prompt.length})`);
  assert.match(prompt, /excerpted to fit the prompt capacity/u);
  assert.match(prompt, /characters omitted/u);
  assert.match(prompt, /OUTPUT CONTRACT \(mandatory\)/u, "the contract stays present");
  assert.match(prompt, /OBJECTIVE/u, "the task contract stays present");
});

test("a failed previous result with empty normalized fields carries a bounded raw-output excerpt with middle error signals", () => {
  const middle = [
    "INFO start",
    ...Array.from({ length: 400 }, (_, index) => `routine line ${index}`),
    "FATAL Cannot resolve dependency unique-root-cause-marker",
    ...Array.from({ length: 400 }, (_, index) => `routine tail line ${index}`),
  ].join("\n");
  const previousResult: TaskResult = {
    task_id: "gap", attempt: 1, status: "failed",
    summary: "", files_changed: [], tests: [], issues: [], needs_master_decision: false,
    zcode_output: middle, exit_code: 1, session_id: null, started_at: null, finished_at: null,
  };
  const prompt = buildContinuePrompt({
    task: makeTask({}), feedback: "diagnose and fix", additionalRequirements: [],
    previousSessionId: null, previousResult,
  });
  assert.match(prompt, /raw_output_excerpt/u);
  assert.match(prompt, /unique-root-cause-marker/u, "the middle root cause stays recoverable");
  assert.match(prompt, /MIDDLE ERROR SIGNALS/u);
  assert.match(prompt, /characters omitted/u, "the omission stays explicit");
});

test("long failed-test details keep middle error signals instead of only head and tail", () => {
  const details = [
    ...Array.from({ length: 300 }, (_, index) => `ok ${index}`),
    "Error: assertion failed at deep-middle-sentinel",
    ...Array.from({ length: 300 }, (_, index) => `tail ${index}`),
  ].join("\n");
  const previousResult: TaskResult = {
    task_id: "details", attempt: 1, status: "failed",
    summary: "one test failed", files_changed: [], issues: [], needs_master_decision: false,
    zcode_output: "", exit_code: 1, session_id: null, started_at: null, finished_at: null,
    tests: [{ command: "npm test", status: "failed", details }],
  };
  const prompt = buildContinuePrompt({
    task: makeTask({}), feedback: "fix the failing test", additionalRequirements: [],
    previousSessionId: null, previousResult,
  });
  assert.match(prompt, /deep-middle-sentinel/u, "the mid-log root cause stays recoverable");
  assert.match(prompt, /characters omitted/u);
});
