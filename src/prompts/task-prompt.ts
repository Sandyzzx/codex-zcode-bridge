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
    "You are a subordinate coding agent executing one bounded task inside the current working directory. Stay inside the workspace; do not touch files outside it.",
    `TASK ID: ${task.task_id}`,
    ...(task.model ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`] : []),
    `OBJECTIVE\n${bounded(task.objective, MAX_SECTION_CHARS)}`,
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
  ];
  if (task.context && task.context.trim().length > 0) {
    sections.push(`CONTEXT\n${bounded(task.context, MAX_CONTEXT_CHARS)}`);
  }
  sections.push(OUTPUT_CONTRACT);
  return joinBounded(sections);
}

export function buildContinuePrompt(input: ContinuePromptInput): string {
  const { task, feedback, additionalRequirements, previousSessionId, previousResult } = input;
  const sections: string[] = [
    "You are a subordinate coding agent continuing a previous task in the same workspace. Stay inside the workspace.",
    `TASK ID: ${task.task_id}`,
    ...(task.model ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`] : []),
  ];
  if (previousSessionId) {
    sections.push(
      `This run resumes persisted session ${previousSessionId}; earlier conversation context may be available.`,
    );
  }
  if (previousResult) {
    sections.push(
      `PREVIOUS RESULT (normalized claims from the previous attempt)\n${bounded(
        JSON.stringify(previousResult, null, 2),
        MAX_SECTION_CHARS,
      )}`,
    );
  }
  sections.push(`MASTER FEEDBACK (address every point)\n${bounded(feedback, MAX_SECTION_CHARS)}`);
  if (additionalRequirements.length > 0) {
    sections.push(renderList("ADDITIONAL REQUIREMENTS", [...additionalRequirements]));
  }
  sections.push(`ORIGINAL TASK\n${buildTaskPrompt(task)}`);
  return joinBounded(sections);
}

const OUTPUT_CONTRACT = [
  "OUTPUT CONTRACT (mandatory)",
  "Your final response must be exactly one JSON object with no markdown fences and no text before or after it, matching this shape:",
  '{"summary": string, "files_changed": string[], "tests": [{"command": string, "status": "passed" | "failed" | "not_run", "details"?: string}], "issues": string[], "needs_master_decision": boolean}',
  "List every file you created or modified in files_changed (workspace-relative paths). Give one tests entry per applicable test command; use status not_run when a command was not applicable or could not run. Record problems in issues. Set needs_master_decision=true only when a required decision is outside your authority; never guess.",
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

function joinBounded(sections: readonly string[]): string {
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_PROMPT_CHARS) return joined;
  return `${joined.slice(0, MAX_PROMPT_CHARS)}…[truncated]`;
}
