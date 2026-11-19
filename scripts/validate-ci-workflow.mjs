#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_CHECK_NAMES = Object.freeze([
  "Verify (${{ matrix.os }})",
  "SQLite resource matrix (${{ matrix.os }})",
]);

const REQUIRED_JOBS = Object.freeze({
  impact: "Select impact gates",
  fast: "Fast PR gate",
  cost_lab: "Cost Lab",
  integration: "Integration gate (Windows)",
  release: "Verify (${{ matrix.os }})",
  "sqlite-stress": "SQLite resource matrix (${{ matrix.os }})",
});

const REQUIRED_IMPACT_OUTPUTS = Object.freeze([
  "bridge_mode",
  "bridge_full_required",
  "bridge_targeted_required",
  "cost_lab_required",
  "cost_lab_web_required",
  "shared_runtime_required",
  "selector_required",
  "workflow_required",
  "docs_required",
  "integration_required",
  "stress_required",
]);

function lineIndent(line) {
  return line.match(/^\s*/u)?.[0].length ?? 0;
}

function blockAfter(source, header) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === header);
  if (start < 0) return null;
  const indent = lineIndent(lines[start]);
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && lineIndent(line) <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

function topLevelBlock(source, header) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === header);
  if (start < 0) return null;
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && lineIndent(line) === 0) break;
    block.push(line);
  }
  return block.join("\n");
}

export function parseJobs(source) {
  const jobsSource = topLevelBlock(source, "jobs:");
  if (jobsSource === null) return new Map();
  const jobs = new Map();
  let current = null;
  for (const line of jobsSource.split("\n")) {
    const match = line.match(/^  ([A-Za-z0-9_-]+):\s*$/u);
    if (match) {
      current = { id: match[1], lines: [] };
      jobs.set(current.id, current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  for (const job of jobs.values()) job.source = job.lines.join("\n");
  return jobs;
}

export function validateCiWorkflowText(text) {
  const source = text.replace(/\r\n/gu, "\n");
  const errors = [];
  const requireMatch = (pattern, message) => {
    if (!pattern.test(source)) errors.push(message);
  };

  if (/\t/u.test(source)) errors.push("workflow must not contain tab indentation");
  for (const line of source.split("\n")) {
    if (line.trim() && lineIndent(line) % 2 !== 0) {
      errors.push(`workflow indentation must use even spaces: ${line.trimStart()}`);
      break;
    }
  }
  requireMatch(/^name: CI$/mu, "workflow name must remain CI");
  const eventBlock = topLevelBlock(source, "on:");
  if (eventBlock === null) {
    errors.push("workflow must define an on: event block");
  } else {
    if (/^\s+paths:/mu.test(eventBlock)) errors.push("top-level pull-request/push path filters are forbidden");
    if (!/^\s+pull_request:\s*$/mu.test(eventBlock)) errors.push("pull_request trigger is required");
    if (!/^\s+workflow_dispatch:\s*$/mu.test(eventBlock)) errors.push("workflow_dispatch trigger is required");
    if (!/^\s+-\s+preview\s*$/mu.test(eventBlock)) errors.push("preview push trigger is required");
    if (!/^\s+-\s+master\s*$/mu.test(eventBlock)) errors.push("master push trigger is required");
  }

  const jobs = parseJobs(source);
  for (const [id, name] of Object.entries(REQUIRED_JOBS)) {
    const job = jobs.get(id);
    if (!job) {
      errors.push(`missing required job: ${id}`);
      continue;
    }
    if (!new RegExp(`^    name: ${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu").test(job.source)) {
      errors.push(`job ${id} must keep stable check name: ${name}`);
    }
  }

  const impact = jobs.get("impact")?.source ?? "";
  for (const output of REQUIRED_IMPACT_OUTPUTS) {
    requireMatch(new RegExp(`^\\s{6}${output}:`, "mu"), `impact job must export ${output}`);
  }
  requireMatch(/workflow_dispatch/u, "workflow_dispatch must force the full selector path");
  requireMatch(/refs\/heads\/master/u, "master push must force the full selector path");
  requireMatch(/--force-full/u, "impact selection must fail safe to --force-full");
  if (/github\.event_name\s*==\s*'push'/u.test(source)) {
    errors.push("preview pushes must use the same selector route as pull requests");
  }

  for (const id of ["fast", "cost_lab", "integration", "sqlite-stress"]) {
    const job = jobs.get(id);
    if (job && !/^    if: always\(\)$/mu.test(job.source)) {
      errors.push(`${id} must use job-level if: always() so its check concludes deterministically`);
    }
  }
  if (!/routing conclusion, not a test PASS/u.test(jobs.get("fast")?.source ?? "")) {
    errors.push("Fast no-op routing must not claim a test PASS");
  }

  const release = jobs.get("release")?.source ?? "";
  if (!/^    if: always\(\)$/mu.test(release)) {
    errors.push("Verify matrix must use job-level if: always() so required contexts conclude deterministically");
  }
  if (/github\.event_name\s*==\s*'push'/u.test(release)) {
    errors.push("Verify matrix must not bypass selectors for preview pushes");
  }
  if ((release.match(/^\s*-\s+run:\s+npm test\s*$/gmu) ?? []).length !== 1) {
    errors.push("exactly one full npm test step must belong to Verify");
  }
  requireMatch(/bridge_mode == 'FULL'/u, "Verify full-suite steps must be conditioned on bridge_mode");
  requireMatch(/needs\.cost_lab\.result/u, "Verify must aggregate the Cost Lab job result");
  requireMatch(/needs\.integration\.result/u, "Verify must aggregate the Integration job result");

  const sqlite = jobs.get("sqlite-stress")?.source ?? "";
  if (!/^    if: always\(\)$/mu.test(sqlite)) {
    errors.push("SQLite resource matrix must use if: always()");
  }
  if (!new RegExp("if: needs\\.impact\\.outputs\\.stress_required == 'true'", "u").test(sqlite)) {
    errors.push("SQLite stress execution must be conditioned on stress_required");
  }
  if (!/npm run test:stress/u.test(sqlite)) errors.push("SQLite matrix must retain npm run test:stress");
  if (!/routing conclusion, not a stress-test PASS/u.test(sqlite)) {
    errors.push("SQLite no-op routing must not claim a stress-test PASS");
  }

  const integration = jobs.get("integration")?.source ?? "";
  if (!/^    if: always\(\)$/mu.test(integration)) {
    errors.push("Integration must stay a stable check and use if: always()");
  }
  if (!/bridge_mode == 'TARGETED' && needs\.impact\.outputs\.integration_required == 'true'/u.test(integration)) {
    errors.push("Integration execution must be conditioned on targeted Bridge impact");
  }
  if (!/routing conclusion, not a test PASS/u.test(integration)) {
    errors.push("Integration no-op routing must not claim a test PASS");
  }

  const costLab = jobs.get("cost_lab")?.source ?? "";
  if (!/^    if: always\(\)$/mu.test(costLab)) {
    errors.push("Cost Lab must stay a stable check and use if: always()");
  }
  if (!/routing conclusion, not a test PASS/u.test(costLab)) {
    errors.push("Cost Lab no-op routing must not claim a test PASS");
  }
  requireMatch(/npm run cost-lab:test/u, "Cost Lab job must run its dedicated suite");
  requireMatch(/cost_lab_web_required == 'true'/u, "Cost Lab Web smoke must be separately routed");
  requireMatch(/shared_runtime_required == 'true'[\s\S]*?npm run build:core/u,
    "shared runtime changes must build the Bridge compatibility dependency");
  requireMatch(/node scripts\/validate-ci-workflow\.mjs/u, "selector/workflow changes must validate the workflow");
  requireMatch(/test-impact-selector\.test\.js/u, "selector changes must run the selector matrix");

  if (errors.length > 0) {
    throw new Error(`CI workflow validation failed:\n- ${errors.join("\n- ")}`);
  }
  return {
    jobs: [...jobs.keys()],
    required_check_names: [...REQUIRED_CHECK_NAMES],
  };
}

export function validateReleasePleaseWorkflowText(text) {
  const source = text.replace(/\r\n/gu, "\n");
  const errors = [];
  const eventBlock = topLevelBlock(source, "on:");
  if (!/^name: Release Please$/mu.test(source)) errors.push("release-please workflow name changed");
  if (eventBlock === null) {
    errors.push("release-please workflow must define an on: event block");
  } else {
    if (/^\s+pull_request:/mu.test(eventBlock)) errors.push("release-please must not run for pull requests");
    if (/^\s+workflow_dispatch:/mu.test(eventBlock)) errors.push("release-please must remain push-triggered");
    if (!/^\s{2}push:\s*$/mu.test(eventBlock)) errors.push("release-please must keep its push trigger");
    if (!/^\s{6}-\s+master\s*$/mu.test(eventBlock)) errors.push("release-please must remain master-only");
  }
  if (!/googleapis\/release-please-action@[0-9a-f]{40}\b/u.test(source)) {
    errors.push("release-please action must remain pinned to a full commit SHA");
  }
  if (errors.length > 0) {
    throw new Error(`Release workflow validation failed:\n- ${errors.join("\n- ")}`);
  }
  return "master-push-only";
}

export function validateCiWorkflowFile(file = path.resolve(".github/workflows/ci.yml")) {
  const workflowRoot = path.dirname(file);
  return {
    ...validateCiWorkflowText(readFileSync(file, "utf8")),
    release_please_trigger: validateReleasePleaseWorkflowText(
      readFileSync(path.join(workflowRoot, "release-please.yml"), "utf8"),
    ),
  };
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = validateCiWorkflowFile(path.join(repositoryRoot, ".github/workflows/ci.yml"));
  console.log(JSON.stringify({ status: "CI_WORKFLOW_VALIDATION_PASS", ...result }, null, 2));
}
