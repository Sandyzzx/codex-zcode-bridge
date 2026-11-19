#!/usr/bin/env node

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  collectAndStoreProfilerSnapshot,
  createStoredProfilerComparison,
  createStoredProfilerReport,
  listStoredProfilerReports,
  loadStoredProfilerReportById,
  profilerServicePaths,
  profilerSessions,
  PROJECT_ROOT,
} from "./profiler-service.mjs";
import { renderProfilerMarkdown } from "./profiler/index.mjs";

function parseOptions(argv) {
  const positional = [];
  const options = {
    json: false,
    markdown: false,
    forceFull: false,
    bridgeDataRoots: [],
    bridgeDatabasePaths: [],
    rolloutFiles: [],
    historyFiles: [],
  };
  const valueOptions = new Map([
    ["--thread", "threadId"],
    ["--goal", "goalId"],
    ["--agent", "agentId"],
    ["--from", "from"],
    ["--to", "to"],
    ["--before", "before"],
    ["--after", "after"],
    ["--id", "reportId"],
    ["--out", "out"],
    ["--codex-home", "codexHome"],
    ["--snapshot-id", "snapshotId"],
    ["--limit", "limit"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--markdown") options.markdown = true;
    else if (argument === "--full" || argument === "--refresh") options.forceFull = true;
    else if (argument === "--no-default-bridge") options.includeDefaultBridge = false;
    else if (argument === "--only-explicit-sources") options.onlyExplicitSources = true;
    else if (argument === "--bridge-data-root") {
      const value = argv[++index];
      if (!value) throw new Error("--bridge-data-root requires a path");
      options.bridgeDataRoots.push(path.resolve(value));
    } else if (argument === "--bridge-sqlite") {
      const value = argv[++index];
      if (!value) throw new Error("--bridge-sqlite requires a path");
      options.bridgeDatabasePaths.push(path.resolve(value));
    } else if (argument === "--rollout") {
      const value = argv[++index];
      if (!value) throw new Error("--rollout requires a path");
      options.rolloutFiles.push(path.resolve(value));
    } else if (argument === "--history") {
      const value = argv[++index];
      if (!value) throw new Error("--history requires a path");
      options.historyFiles.push(path.resolve(value));
    } else if (valueOptions.has(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      options[valueOptions.get(argument)] = value;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  return { positional, options };
}

function usage() {
  return [
    "Usage:",
    "  node tools/cost-lab/cli.mjs profiler sessions [--json] [--full]",
    "  node tools/cost-lab/cli.mjs profiler analyze (--thread <id> | --goal <id> | --agent <id>) [--json]",
    "  node tools/cost-lab/cli.mjs profiler analyze --from <time> --to <time> [--json]",
    "  node tools/cost-lab/cli.mjs profiler compare --before <report-id> --after <report-id> [--json]",
    "  node tools/cost-lab/cli.mjs profiler report --id <report-id> [--json]",
    "  node tools/cost-lab/cli.mjs profiler reports [--json]",
    "  Add --only-explicit-sources with repeated --rollout paths to exclude default session roots.",
    "",
    "Read-only sources: Codex rollout JSONL/JSONL.zst and Bridge SQLite.",
    "Stored artifacts: .run/cost-lab/profiler",
  ].join("\n");
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatNumber(value) {
  return value === null || value === undefined
    ? "UNKNOWN"
    : Number(value).toLocaleString("en-US");
}

function formatDuration(value) {
  if (value === null || value === undefined) return "UNKNOWN";
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function sessionTable(rows) {
  const header = [
    "KIND",
    "AGENT / THREAD",
    "PARENT",
    "PROVIDER / MODEL",
    "TOKENS",
    "CACHED",
    "RESP",
    "DURATION",
    "CORRELATION",
  ].join("\t");
  const body = rows.map((row) => [
    row.kind,
    `${row.agent_id}${row.nickname ? ` (${row.nickname})` : ""}`,
    row.parent_agent_id ?? row.parent_thread_id ?? "-",
    `${row.provider ?? "UNKNOWN"}/${row.model ?? "UNKNOWN"}`,
    formatNumber(row.total_tokens),
    formatNumber(row.cached_input_tokens),
    formatNumber(row.response_count),
    formatDuration(row.duration_ms),
    row.correlation_status,
  ].join("\t"));
  return `${[header, ...body].join("\n")}\n`;
}

async function writeOutput(target, text, projectRoot, stdout = process.stdout) {
  if (!target) {
    stdout.write(text);
    return;
  }
  const resolved = path.resolve(target);
  const relative = path.relative(path.join(projectRoot, ".run"), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("profiler_output_outside_run_directory");
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, resolved);
  stdout.write(`${resolved}\n`);
}

async function main(argv = process.argv.slice(2), context = {}) {
  const { positional, options } = parseOptions(argv);
  if (positional.length === 0 || positional[0] !== "profiler") {
    process.stdout.write(`${usage()}\n`);
    return 1;
  }
  const command = positional[1];
  if (!command) throw new Error("profiler_subcommand_required");

  const projectRoot = path.resolve(context.projectRoot ?? PROJECT_ROOT);
  const stdout = context.stdout ?? process.stdout;
  options.projectRoot = projectRoot;
  if (options.onlyExplicitSources) options.sessionRoots = [];
  const collected = command === "report" || command === "reports" || command === "compare"
    ? null
    : await collectAndStoreProfilerSnapshot(options);

  if (command === "sessions") {
    const sessions = profilerSessions(collected.snapshot);
    const limit = options.limit ? Number(options.limit) : sessions.length;
    const selected = sessions.slice(0, Number.isSafeInteger(limit) && limit > 0 ? limit : sessions.length);
    const output = options.json
      ? jsonText({
          schema_version: 1,
          snapshot_id: collected.snapshot.snapshot_id,
          collected_at: collected.collected_at,
          sources: collected.snapshot.sources,
          sessions: selected,
          warnings: collected.snapshot.warnings,
        })
      : sessionTable(selected);
    await writeOutput(options.out, output, projectRoot, stdout);
    return 0;
  }

  if (command === "analyze") {
    const selectorCount = [options.threadId, options.goalId, options.agentId, options.from || options.to]
      .filter(Boolean).length;
    if (selectorCount === 0) {
      throw new Error("profiler_analyze_requires_thread_goal_agent_or_time_range");
    }
    const created = await createStoredProfilerReport({ ...options, snapshot: collected.snapshot });
    const output = options.json
      ? jsonText(created.report)
      : `${renderProfilerMarkdown(created.report)}` +
        `\nSaved JSON: ${path.join(collected.paths.reports, `${created.report.report_id}.json`)}\n`;
    await writeOutput(options.out, output, projectRoot, stdout);
    return 0;
  }

  if (command === "report") {
    if (!options.reportId) throw new Error("--id is required");
    const report = await loadStoredProfilerReportById(options.reportId, options);
    await writeOutput(options.out, options.json ? jsonText(report) : renderProfilerMarkdown(report), projectRoot, stdout);
    return 0;
  }

  if (command === "reports") {
    const reports = await listStoredProfilerReports(options);
    const output = options.json
      ? jsonText(reports)
      : reports.map((row) => [
          row.report_id,
          row.generated_at ?? "UNKNOWN",
          formatNumber(row.total_tokens),
          formatNumber(row.response_count),
          row.diagnostics_count,
        ].join("\t")).join("\n") + (reports.length ? "\n" : "");
    await writeOutput(options.out, output, projectRoot, stdout);
    return 0;
  }

  if (command === "compare") {
    if (!options.before || !options.after) throw new Error("--before and --after are required");
    const comparison = await createStoredProfilerComparison(options);
    const output = options.json
      ? jsonText(comparison)
      : `${renderProfilerMarkdown(comparison)}` +
        `\nSaved JSON: ${path.join(profilerServicePaths(options).comparisons, `${comparison.comparison_id}.json`)}\n`;
    await writeOutput(options.out, output, projectRoot, stdout);
    return 0;
  }

  throw new Error(`unknown profiler command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`Cost Lab profiler: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

export { main, parseOptions };
