import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeProfilerSnapshot,
  collectProfilerSnapshot,
  compareProfilerReports,
  readProfilerReport,
  readProfilerSnapshot,
  renderProfilerMarkdown,
  writeProfilerReport,
  writeProfilerSnapshot,
} from "./profiler/index.mjs";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(SCRIPT_ROOT, "..", "..");
export const DEFAULT_PROFILER_ROOT = path.join(PROJECT_ROOT, ".run", "cost-lab", "profiler");

async function atomicWriteText(target, text) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function readJsonIfPresent(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function directoryPaths(projectRoot, profilerRoot) {
  const root = path.resolve(profilerRoot ?? path.join(projectRoot, ".run", "cost-lab", "profiler"));
  const runRoot = path.join(path.resolve(projectRoot), ".run");
  const relative = path.relative(runRoot, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("profiler_root_outside_run_directory");
  }
  return {
    root,
    snapshots: path.join(root, "snapshots"),
    reports: path.join(root, "reports"),
    comparisons: path.join(root, "comparisons"),
    latestSnapshot: path.join(root, "snapshots", "latest.json"),
    state: path.join(root, "state.json"),
  };
}

function snapshotFile(paths, snapshotId) {
  return path.join(paths.snapshots, `${snapshotId}.json`);
}

function reportFile(paths, reportId) {
  return path.join(paths.reports, `${reportId}.json`);
}

function withoutIncrementalState(snapshot) {
  const { next_incremental_state: _nextState, ...stored } = snapshot;
  return stored;
}

function sortedAgents(snapshot) {
  return [...snapshot.agents].sort((left, right) => (
    (left.started_at ?? "").localeCompare(right.started_at ?? "")
    || left.agent_id.localeCompare(right.agent_id)
  ));
}

export function profilerServicePaths(options = {}) {
  return directoryPaths(options.projectRoot ?? PROJECT_ROOT, options.profilerRoot);
}

export async function collectAndStoreProfilerSnapshot(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const paths = profilerServicePaths({ ...options, projectRoot });
  await mkdir(paths.snapshots, { recursive: true });
  await mkdir(paths.reports, { recursive: true });
  await mkdir(paths.comparisons, { recursive: true });

  const forceFull = options.forceFull === true;
  const collectedAt = (options.now?.() ?? new Date()).toISOString();
  const previousStored = !forceFull && await readJsonIfPresent(paths.latestSnapshot);
  const previousSnapshot = previousStored
    ? withoutIncrementalState(readProfilerSnapshot(paths.latestSnapshot))
    : null;
  const previousStateFile = !forceFull && await readJsonIfPresent(paths.state);
  const snapshot = await collectProfilerSnapshot({
    codexHome: options.codexHome,
    env: options.env,
    sessionRoots: options.sessionRoots,
    rolloutFiles: options.rolloutFiles,
    includeArchived: options.includeArchived,
    bridgeDataRoots: options.bridgeDataRoots,
    bridgeDatabasePaths: options.bridgeDatabasePaths,
    historyFiles: options.historyFiles,
    includeDefaultBridge: options.includeDefaultBridge,
    previousSnapshot,
    incrementalState: previousStateFile?.next_incremental_state ?? {},
    chunkBytes: options.chunkBytes,
    maxBytesPerSource: options.maxBytesPerSource,
    generatedAt: collectedAt,
  });
  const nextState = snapshot.next_incremental_state ?? {};
  const storedSnapshot = withoutIncrementalState(snapshot);
  const archivePath = snapshotFile(paths, storedSnapshot.snapshot_id);
  await writeProfilerSnapshot(storedSnapshot, archivePath, {
    baseDir: paths.root,
    allowedRoots: [paths.root],
  });
  await writeProfilerSnapshot(storedSnapshot, paths.latestSnapshot, {
    baseDir: paths.root,
    allowedRoots: [paths.root],
  });
  await atomicWriteText(paths.state, `${JSON.stringify({
    schema_version: 1,
    snapshot_id: storedSnapshot.snapshot_id,
    collected_at: collectedAt,
    next_incremental_state: nextState,
  }, null, 2)}\n`);
  return {
    snapshot: storedSnapshot,
    collected_at: collectedAt,
    paths,
  };
}

export async function loadStoredProfilerSnapshot(options = {}) {
  const paths = profilerServicePaths(options);
  if (options.snapshotId) {
    const file = snapshotFile(paths, await resolveArtifactId(paths.snapshots, options.snapshotId, "snapshot"));
    return readProfilerSnapshot(file);
  }
  if (!await readJsonIfPresent(paths.latestSnapshot)) {
    return (await collectAndStoreProfilerSnapshot(options)).snapshot;
  }
  return readProfilerSnapshot(paths.latestSnapshot);
}

export async function readLatestStoredProfilerSnapshot(options = {}) {
  const paths = profilerServicePaths(options);
  if (!await readJsonIfPresent(paths.latestSnapshot)) return null;
  return readProfilerSnapshot(paths.latestSnapshot);
}

export async function createStoredProfilerReport(options = {}) {
  const collected = options.snapshot
    ? { snapshot: options.snapshot, collected_at: null, paths: profilerServicePaths(options) }
    : await collectAndStoreProfilerSnapshot(options);
  const report = analyzeProfilerSnapshot(collected.snapshot, {
    goalId: options.goalId,
    threadId: options.threadId,
    agentId: options.agentId,
    from: options.from,
    to: options.to,
    now: options.now,
  });
  report.generated_at = (options.now?.() ?? new Date()).toISOString();
  await writeProfilerReport(report, reportFile(collected.paths, report.report_id), {
    baseDir: collected.paths.root,
    allowedRoots: [collected.paths.root],
  });
  return { report, snapshot: collected.snapshot, paths: collected.paths };
}

export async function listStoredProfilerReports(options = {}) {
  const paths = profilerServicePaths(options);
  let names;
  try {
    names = await readdir(paths.reports);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const reports = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const report = readProfilerReport(path.join(paths.reports, name));
      reports.push({
        report_id: report.report_id,
        generated_at: report.generated_at ?? null,
        captured_at: report.captured_at ?? null,
        scope: report.scope ?? null,
        total_tokens: report.usage?.overall?.total_tokens ?? null,
        response_count: report.usage?.overall?.response_count ?? null,
        diagnostics_count: report.diagnostics?.length ?? 0,
      });
    } catch {
      // A partial or obsolete artifact must not hide the remaining valid history.
    }
  }
  return reports.sort((left, right) => (
    (right.generated_at ?? "").localeCompare(left.generated_at ?? "")
    || right.report_id.localeCompare(left.report_id)
  ));
}

async function resolveArtifactId(directory, requested, label) {
  const value = String(requested ?? "").trim();
  if (!value) throw new Error(`${label}_id_required`);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label}_not_found`);
    throw error;
  }
  const ids = names
    .filter((name) => name.endsWith(".json") && name !== "latest.json")
    .map((name) => name.slice(0, -5));
  const exact = ids.find((id) => id === value);
  if (exact) return exact;
  const matches = ids.filter((id) => id.startsWith(value));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`${label}_id_ambiguous`);
  throw new Error(`${label}_not_found`);
}

export async function loadStoredProfilerReportById(reportId, options = {}) {
  const paths = profilerServicePaths(options);
  const id = await resolveArtifactId(paths.reports, reportId, "profiler_report");
  return readProfilerReport(reportFile(paths, id));
}

export async function createStoredProfilerComparison(options = {}) {
  const before = await loadStoredProfilerReportById(options.before, options);
  const after = await loadStoredProfilerReportById(options.after, options);
  const comparison = compareProfilerReports(before, after);
  const comparisonId = createHash("sha256")
    .update(`${before.report_id}\0${after.report_id}`)
    .digest("hex");
  const enriched = {
    ...comparison,
    comparison_id: comparisonId,
    generated_at: (options.now?.() ?? new Date()).toISOString(),
  };
  const target = path.join(profilerServicePaths(options).comparisons, `${comparisonId}.json`);
  await atomicWriteText(target, `${JSON.stringify(enriched, null, 2)}\n`);
  return enriched;
}

export function profilerSessions(snapshot) {
  return sortedAgents(snapshot).map((agent) => ({
    agent_id: agent.agent_id,
    kind: agent.kind,
    thread_id: agent.thread_id,
    parent_thread_id: agent.parent_thread_id,
    parent_agent_id: agent.parent_agent_id,
    root_agent_id: agent.root_agent_id,
    goal_id: agent.goal_id,
    nickname: agent.nickname,
    task_id: agent.task_id,
    provider: agent.provider,
    model: agent.model,
    reasoning_effort: agent.reasoning_effort,
    started_at: agent.started_at,
    ended_at: agent.ended_at,
    duration_ms: agent.duration_ms,
    response_count: agent.response_count,
    unknown_usage_response_count: agent.unknown_usage_response_count,
    total_tokens: agent.usage?.total_tokens ?? null,
    input_tokens: agent.usage?.input_tokens ?? null,
    cached_input_tokens: agent.usage?.cached_input_tokens ?? null,
    uncached_input_tokens: agent.usage?.uncached_input_tokens ?? null,
    output_tokens: agent.usage?.output_tokens ?? null,
    reasoning_tokens: agent.usage?.reasoning_tokens ?? null,
    correlation_status: agent.correlation?.status ?? "UNKNOWN",
    evidence_level: agent.usage?.evidence_level ?? "UNKNOWN",
  }));
}

export async function loadReportMarkdown(reportId, options = {}) {
  return renderProfilerMarkdown(await loadStoredProfilerReportById(reportId, options));
}
