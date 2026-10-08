// Minimal PromptBuilder per docs/ARCHITECTURE.md: renders the task package and
// continuation feedback as a bounded subordinate-coder prompt that requests a
// JSON AgentReport embedded in the ZCode `response`. Pure functions; no I/O.
import type { TaskPackage, TaskResult } from "../interfaces.js";

const MAX_PROMPT_CHARS = 60_000;
const MAX_SECTION_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 2_000;

export interface ContinuePromptInput {
  readonly task: TaskPackage;
  readonly feedback: string;
  readonly additionalRequirements: readonly string[];
  readonly previousSessionId: string | null;
  readonly previousResult: TaskResult | null;
}

export function buildTaskPrompt(task: TaskPackage): string {
  const sections: string[] = [
    `TASK ID: ${task.task_id}`,
    "You are a subordinate coding agent executing one bounded task inside the current working directory. Stay inside the workspace; do not touch files outside it.",
    `PROJECT WORKSPACE: ${task.workspace}`,
    ...(task.worktree_path ? [`HOST-SELECTED EXECUTION WORKTREE: ${task.worktree_path}. Make task changes in the current working directory, which is this worktree; the project workspace above identifies its parent project.`] : []),
    ...(task.model ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`] : []),
    ...(task.timeout_ms ? [`EXECUTION TIME LIMIT: ${task.timeout_ms} ms for this attempt.`] : []),
    `OBJECTIVE\n${task.objective}`,
    renderList("REQUIREMENTS", task.requirements),
    renderPaths("ALLOWED PATHS (write only inside these when provided)", task.allowed_paths),
    renderPaths("FORBIDDEN PATHS (never create, modify, or delete)", task.forbidden_paths),
    renderList(
      "ACCEPTANCE CRITERIA (the master verifies these independently; do not self-certify)",
      task.acceptance_criteria,
    ),
    renderList(
      "TEST COMMANDS (run the applicable ones and report a status for each)",
      task.test_commands,
    ),
    DECISION_RULE,
  ];
  if (task.context && task.context.trim().length > 0) {
    sections.push(`CONTEXT\n${bounded(task.context, MAX_CONTEXT_CHARS)}`);
  }
  return joinBoundedPreservingTail([...sections, OUTPUT_CONTRACT], OUTPUT_CONTRACT);
}

export function buildContinuePrompt(input: ContinuePromptInput): string {
  const { task, feedback, additionalRequirements, previousSessionId, previousResult } = input;
  const sections: string[] = [
    `TASK ID: ${task.task_id}`,
    "You are a subordinate coding agent continuing a previous task in the same workspace. Stay inside the workspace.",
    ...(task.model ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`] : []),
  ];
  if (previousSessionId) {
    sections.push(
      `This run resumes persisted session ${previousSessionId}; earlier conversation context may be available.`,
    );
  }
  if (previousResult?.error_code === "invalid_agent_report") {
    // Do not reintroduce implementation instructions or test commands in a
    // report-only continuation. Candidate claims precede the bounded raw
    // response so a long response cannot hide the useful structured evidence.
    sections.push(
      "REPORT REPAIR MODE: The previous execution has ended. Only its final report failed validation. Do not use tools, edit files, rerun tests, or repeat task work. Return the corrected JSON report from the evidence below. Preserve claims as claims, including not_run and failures. Do not invent tests or missing facts. If needs_master_decision cannot be established, explicitly set it to true and record the uncertainty in issues.",
      `PROJECT WORKSPACE: ${task.workspace}`,
      ...(task.worktree_path ? [`HOST-SELECTED EXECUTION WORKTREE: ${task.worktree_path}`] : []),
      `PREVIOUS REPORT ERROR\n${previousResult.summary}`,
      `REPORT CANDIDATE CLAIMS (not independently verified)\n${JSON.stringify(previousResult.report_candidate ?? {}, null, 2)}`,
      `PREVIOUS RESPONSE\n${bounded(previousResult.zcode_output, MAX_SECTION_CHARS)}`,
      `MASTER FEEDBACK (report repair only)\n${feedback}`,
      ...(additionalRequirements.length ? [renderList("ADDITIONAL REPORT REQUIREMENTS", [...additionalRequirements])] : []),
      OUTPUT_CONTRACT,
    );
    return joinBoundedPreservingTail(sections, OUTPUT_CONTRACT);
  }
  if (previousResult) {
    sections.push(
      `PREVIOUS RESULT (normalized claims from the previous attempt)\n${bounded(
        JSON.stringify(previousResult, null, 2),
        MAX_SECTION_CHARS,
      )}`,
    );
  }
  sections.push(`MASTER FEEDBACK (address every point)\n${feedback}`);
  if (additionalRequirements.length > 0) {
    sections.push(renderList("ADDITIONAL REQUIREMENTS", [...additionalRequirements]));
  }
  sections.push(`ORIGINAL TASK\n${buildTaskPrompt(task)}`);
  return joinBoundedPreservingTail(sections, OUTPUT_CONTRACT);
}

const OUTPUT_CONTRACT = [
  "OUTPUT CONTRACT (mandatory)",
  "Your final response must be exactly one JSON object with no markdown fences and no text before or after it.",
  'Required fields: summary (non-empty string), files_changed (array of strings), tests (array of objects with command string, status "passed" | "failed" | "not_run", optional details string), issues (array of strings), needs_master_decision (JSON boolean).',
  'Valid JSON example (replace example values with observed facts): {"summary":"Describe the actual work","files_changed":[],"tests":[{"command":"An applicable command","status":"not_run","details":"Explain why it was not run"}],"issues":[],"needs_master_decision":true}',
  "List every file you created or modified in files_changed (workspace-relative paths). Give one tests entry per applicable test command; use status not_run when a command was not applicable or could not run. Record problems in issues. Set needs_master_decision=true only when a required decision is outside your authority; never guess.",
  "Before sending, check that all five top-level fields exist and needs_master_decision is a JSON boolean true or false, never a quoted string and never text such as needs_master_decision=false. If its value is uncertain, set true and explain in issues. Do not omit it.",
].join("\n");

const DECISION_RULE = [
  "DECISION RULE",
  "Use only this task package, this prompt, repository files you inspect, and available tools; do not assume access to the calling host's conversation.",
  "Do not choose unresolved items explicitly listed under OPEN DECISIONS; a later explicit Master Feedback decision resolves that item. Also escalate conflicting requirements or missing decisions that would materially change externally visible behavior, even when the calling host did not list them. Record the exact question in issues and set needs_master_decision=true. Continue independent work that does not depend on the decision. For low-impact implementation choices, use the simplest consistent option and state the assumption in issues.",
].join("\n");

function renderList(title: string, items: readonly string[]): string {
  if (items.length === 0) {
    return `${title}\n- (none)`;
  }
  return `${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function renderPaths(title: string, paths: readonly string[]): string {
  if (paths.length === 0) {
    return `${title}\n- (unspecified; still write only within the workspace)`;
  }
  return `${title}\n${paths.map((item) => `- ${item}`).join("\n")}`;
}

function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated]`;
}

function joinBoundedPreservingTail(sections: readonly string[], requiredTail: string): string {
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_PROMPT_CHARS) return joined;
  void requiredTail;
  throw new Error(`task prompt exceeds ${MAX_PROMPT_CHARS} characters; shorten the task package without dropping constraints`);
}
