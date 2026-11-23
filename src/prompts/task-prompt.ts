// Minimal PromptBuilder per docs/ARCHITECTURE.md: renders the task package and
// continuation feedback as a complete-delivery coding prompt that requests a
// JSON AgentReport embedded in the ZCode `response`. Pure functions; no I/O.
import type { AgentReport, TaskPackage, TaskResult, TestReport } from "../interfaces.js";

export const MAX_PROMPT_CHARS = 60_000;
const MAX_EVIDENCE_ITEM_CHARS = 2_000;
const MAX_REPAIR_RESPONSE_CHARS = 5_000;

export class TaskPromptCapacityError extends Error {
  readonly code = "task_prompt_exceeds_capacity";
  readonly actualChars: number;
  readonly maxChars: number;

  constructor(actualChars: number) {
    super(`task prompt exceeds ${MAX_PROMPT_CHARS} characters (actual ${actualChars}); shorten the task package without dropping constraints`);
    this.name = "TaskPromptCapacityError";
    this.actualChars = actualChars;
    this.maxChars = MAX_PROMPT_CHARS;
  }
}

export interface ContinuePromptInput {
  readonly task: TaskPackage;
  readonly feedback: string;
  readonly additionalRequirements: readonly string[];
  readonly previousSessionId: string | null;
  readonly previousResult: TaskResult | null;
}

export function buildTaskPrompt(task: TaskPackage): string {
  const sections: string[] = [
    DELIVERY_OWNERSHIP,
    DECISION_RULE,
    ...renderTaskPackage(task),
  ];
  const context = renderContext(task.context);
  if (context) sections.push(context);
  sections.push(OUTPUT_CONTRACT);
  return joinBoundedPrompt(sections);
}

export function buildContinuePrompt(input: ContinuePromptInput): string {
  const { task, feedback, additionalRequirements, previousSessionId, previousResult } = input;
  if (previousResult?.error_code === "invalid_agent_report") {
    return buildReportRepairPrompt(input);
  }

  const sections: string[] = [
    DELIVERY_OWNERSHIP,
    DECISION_RULE,
    CONTINUATION_CONTEXT,
    ...(previousSessionId
      ? [`PERSISTED SESSION: ${previousSessionId}`]
      : []),
    ...renderTaskPackage(task),
  ];
  const context = renderContext(task.context);
  if (context) sections.push(context);
  if (previousResult) {
    sections.push(renderPreviousResultEvidence(previousResult));
  }
  sections.push(`MASTER FEEDBACK (address every point)\n${feedback}`);
  if (additionalRequirements.length > 0) {
    sections.push(renderList("ADDITIONAL REQUIREMENTS", [...additionalRequirements]));
  }
  sections.push(OUTPUT_CONTRACT);
  return joinBoundedPrompt(sections);
}

function buildReportRepairPrompt(input: ContinuePromptInput): string {
  const { task, feedback, additionalRequirements, previousResult } = input;
  if (!previousResult || previousResult.error_code !== "invalid_agent_report") {
    throw new Error("report repair prompt requires an invalid_agent_report result");
  }
  const sections: string[] = [
    REPORT_REPAIR_MODE,
    `TASK ID: ${task.task_id}`,
    `PROJECT WORKSPACE: ${task.workspace}`,
    ...(task.worktree_path ? [`HOST-SELECTED EXECUTION WORKTREE: ${task.worktree_path}`] : []),
    `PREVIOUS REPORT ERROR\n${boundedEvidenceText(previousResult.summary)}`,
    `REPORT CANDIDATE CLAIMS (not independently verified)\n${JSON.stringify(projectReportCandidate(previousResult.report_candidate ?? {}))}`,
    `PREVIOUS RESPONSE EXCERPT\n${excerptEvidence(previousResult.zcode_output, MAX_REPAIR_RESPONSE_CHARS)}`,
    `MASTER FEEDBACK (report repair only)\n${feedback}`,
    ...(additionalRequirements.length
      ? [renderList("ADDITIONAL REPORT REQUIREMENTS", [...additionalRequirements])]
      : []),
    OUTPUT_CONTRACT,
  ];
  return joinBoundedPrompt(sections);
}

function renderTaskPackage(task: TaskPackage): string[] {
  return [
    `TASK ID: ${task.task_id}`,
    `PROJECT WORKSPACE: ${task.workspace}`,
    ...(task.worktree_path
      ? [`HOST-SELECTED EXECUTION WORKTREE: ${task.worktree_path}. Make task changes in the current working directory, which is this worktree; the project workspace above identifies its parent project.`]
      : []),
    ...(task.model
      ? [`REQUESTED ZCODE MODEL: ${task.model.provider_id}/${task.model.model_id}${task.model.reasoning_level ? ` (reasoning level: ${task.model.reasoning_level})` : ""}. The Bridge configures this model for the session.`]
      : []),
    ...(task.timeout_ms ? [`EXECUTION TIME LIMIT: ${task.timeout_ms} ms for this attempt.`] : []),
    `OBJECTIVE\n${task.objective}`,
    renderList("REQUIREMENTS", task.requirements),
    renderPaths("ALLOWED PATHS (write only inside these when provided; relative paths resolve against the current working directory)", task.allowed_paths),
    renderPaths("FORBIDDEN PATHS (never create, modify, or delete; relative paths resolve against the current working directory)", task.forbidden_paths),
    renderList(
      "ACCEPTANCE CRITERIA (the master verifies these independently; do not self-certify)",
      task.acceptance_criteria,
    ),
    renderList(
      "TEST COMMANDS (run the applicable ones and report a status for each)",
      task.test_commands,
    ),
  ];
}

function renderContext(context: string | undefined): string | null {
  return context && context.trim().length > 0 ? `CONTEXT\n${context}` : null;
}

function renderPreviousResultEvidence(result: TaskResult): string {
  return `PREVIOUS ATTEMPT EVIDENCE (structured; not independently verified)\n${JSON.stringify(projectPreviousResult(result))}`;
}

function projectPreviousResult(result: TaskResult): Record<string, unknown> {
  const failedTests = result.tests.filter((test) => test.status === "failed").map(projectTest);
  const notRunTests = result.tests.filter((test) => test.status === "not_run").map(projectTest);
  const counts = { passed: 0, failed: failedTests.length, not_run: notRunTests.length };
  for (const test of result.tests) {
    if (test.status === "passed") counts.passed += 1;
  }
  return {
    task_id: result.task_id,
    attempt: result.attempt,
    status: result.status,
    ...(result.error_code ? { error_code: result.error_code } : {}),
    summary: boundedEvidenceText(result.summary),
    files_changed: result.files_changed.map((file) => boundedEvidenceText(file)),
    failed_tests: failedTests,
    not_run_tests: notRunTests,
    test_counts: counts,
    issues: result.issues.map((issue) => boundedEvidenceText(issue)),
    needs_master_decision: result.needs_master_decision,
  };
}

function projectReportCandidate(candidate: Partial<AgentReport>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  if (typeof candidate.summary === "string") projected.summary = boundedEvidenceText(candidate.summary);
  if (Array.isArray(candidate.files_changed)) {
    projected.files_changed = candidate.files_changed.map((file) => boundedEvidenceText(file));
  }
  if (Array.isArray(candidate.tests)) projected.tests = candidate.tests.map(projectTest);
  if (Array.isArray(candidate.issues)) {
    projected.issues = candidate.issues.map((issue) => boundedEvidenceText(issue));
  }
  if (typeof candidate.needs_master_decision === "boolean") {
    projected.needs_master_decision = candidate.needs_master_decision;
  }
  return projected;
}

function projectTest(test: TestReport): TestReport {
  return {
    command: boundedEvidenceText(test.command),
    status: test.status,
    ...(test.details === undefined ? {} : { details: boundedEvidenceText(test.details) }),
  };
}

function boundedEvidenceText(text: string, maxChars = MAX_EVIDENCE_ITEM_CHARS): string {
  return excerptEvidence(text, maxChars);
}

function excerptEvidence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = (omitted: number) => `...[${omitted} characters omitted]...`;
  const markerLength = marker(text.length).length;
  const available = Math.max(0, maxChars - markerLength);
  const headChars = Math.ceil(available * 0.6);
  const tailChars = available - headChars;
  return `${text.slice(0, headChars)}${marker(text.length - headChars - tailChars)}${text.slice(-tailChars)}`;
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
  "Do not choose unresolved items explicitly listed under OPEN DECISIONS; a later explicit Master feedback or additional requirement resolves that item. Also escalate conflicting requirements or missing decisions that would materially change externally visible behavior, even when the calling host did not list them. Record the exact question in issues and set needs_master_decision=true. Continue independent work that does not depend on the decision. For low-impact implementation choices, use the simplest consistent option and state the assumption in issues.",
].join("\n");

const DELIVERY_OWNERSHIP = [
  "DELIVERY OWNERSHIP",
  "You are the Coding Worker for one complete task in the current working directory. Own this task's complete delivery, not a single step of it.",
  "Inspect the repository, plan the work internally, implement every required change, run the applicable tests, fix failures you can resolve within the stated boundaries, and repeat until the acceptance criteria are met or a genuine blocker requires the master.",
  "Do not stop after a partial step to ask what to do next, and do not wait for the master to list files or functions. Make low-impact implementation choices yourself and record assumptions in issues.",
  "The master independently verifies the final result; your report is evidence of what you did, not a substitute for that review.",
  "Work only in the current working directory, which is the selected execution root; do not touch files outside it.",
].join("\n");

const CONTINUATION_CONTEXT = [
  "CONTINUATION CONTEXT",
  "This is a continuation of the same task. The original task package below remains authoritative even when a persisted session is available.",
  "A persisted session may provide earlier context, but it is not assumed complete. Use the original objective and constraints below, the current feedback, and the previous-attempt evidence.",
].join("\n");

const REPORT_REPAIR_MODE = [
  "REPORT REPAIR MODE",
  "The previous execution has ended. Only its final report failed validation. Do not use tools, edit files, rerun tests, or repeat task work.",
  "Return the corrected five-field JSON report using only the evidence below. Preserve claims as claims, including not_run and failures. Do not invent tests or missing facts. If needs_master_decision cannot be established, set it to true and record the uncertainty in issues.",
].join("\n");

function renderList(title: string, items: readonly string[]): string {
  if (items.length === 0) {
    return `${title}\n- (none)`;
  }
  return `${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function renderPaths(title: string, paths: readonly string[]): string {
  if (paths.length === 0) {
    return `${title}\n- (unspecified; still write only within the current working directory)`;
  }
  return `${title}\n${paths.map((item) => `- ${item}`).join("\n")}`;
}

function joinBoundedPrompt(sections: readonly string[]): string {
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_PROMPT_CHARS) return joined;
  throw new TaskPromptCapacityError(joined.length);
}
