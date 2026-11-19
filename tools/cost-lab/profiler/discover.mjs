import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./util.mjs";

function resolveCodexHome(options) {
  const explicit = options.codexHome;
  if (typeof explicit === "string" && explicit.trim()) return path.resolve(explicit);
  const envHome = options.env?.CODEX_HOME ?? process.env.CODEX_HOME;
  if (typeof envHome === "string" && envHome.trim()) return path.resolve(envHome);
  return path.join(os.homedir(), ".codex");
}

function walkFiles(root, predicate, result) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, predicate, result);
    } else if (entry.isFile() && predicate(fullPath, entry.name)) {
      result.push(fullPath);
    }
  }
}

function fileDescriptor(kind, filePath, options, warnings) {
  try {
    const info = statSync(filePath);
    if (!info.isFile()) return null;
    const sourceId = sha256(`${kind}\0${path.resolve(filePath)}`);
    return {
      source_id: sourceId,
      kind,
      path: path.resolve(filePath),
      display_name: path.basename(filePath),
      compression: filePath.toLowerCase().endsWith(".zst") ? "zstd" : "none",
      ...(options.includePaths ? { path: path.resolve(filePath) } : {}),
      size_bytes: info.size,
      modified_at: new Date(info.mtimeMs).toISOString(),
      read_only: true,
    };
  } catch (error) {
    warnings.push({
      code: "source_stat_failed",
      source_kind: kind,
      message: error instanceof Error ? error.name : "unknown_error",
    });
    return null;
  }
}

function addUniqueSource(target, source) {
  if (!source) return;
  if (target.some((item) => item.source_id === source.source_id)) return;
  target.push(source);
}

export function discoverProfilerSources(options = {}) {
  const includePaths = options.includePaths === true;
  const codexHome = resolveCodexHome(options);
  const warnings = [];
  const sources = [];
  const rolloutFiles = [];
  const sessionRoots = options.sessionRoots ?? [
    path.join(codexHome, "sessions"),
    path.join(codexHome, "archived_sessions"),
  ];
  const includeArchived = options.includeArchived !== false;

  for (const root of sessionRoots) {
    if (!existsSync(root)) {
      warnings.push({
        code: "rollout_root_absent",
        source_kind: "codex_rollout_jsonl",
        root_label: path.basename(root),
      });
      if (root.endsWith(`${path.sep}archived_sessions`) && !includeArchived) continue;
      continue;
    }
    if (!includeArchived && path.basename(root) === "archived_sessions") continue;
    walkFiles(
      root,
      (_fullPath, name) => /^rollout-.*\.jsonl(?:\.zst)?$/u.test(name),
      rolloutFiles,
    );
  }
  for (const filePath of options.rolloutFiles ?? []) rolloutFiles.push(path.resolve(filePath));
  rolloutFiles.sort((left, right) => left.localeCompare(right));
  for (const filePath of rolloutFiles) {
    addUniqueSource(
      sources,
      fileDescriptor("codex_rollout_jsonl", filePath, { includePaths }, warnings),
    );
  }

  const databasePaths = [];
  const bridgeDataRoots = options.bridgeDataRoots ?? [];
  for (const root of bridgeDataRoots) {
    const candidate = path.join(path.resolve(root), options.bridgeDatabaseFile ?? "bridge.sqlite");
    if (existsSync(candidate)) databasePaths.push(candidate);
  }
  const localAppData = options.env?.LOCALAPPDATA ?? process.env.LOCALAPPDATA;
  if (localAppData && options.includeDefaultBridge !== false) {
    const candidate = path.join(
      localAppData,
      "CodexZCodeBridge",
      "state",
      options.bridgeDatabaseFile ?? "bridge.sqlite",
    );
    if (existsSync(candidate)) databasePaths.push(candidate);
  }
  for (const explicit of options.bridgeDatabasePaths ?? []) {
    if (existsSync(explicit)) databasePaths.push(path.resolve(explicit));
  }
  databasePaths.sort((left, right) => left.localeCompare(right));
  for (const filePath of databasePaths) {
    addUniqueSource(
      sources,
      fileDescriptor("bridge_sqlite", filePath, { includePaths }, warnings),
    );
  }

  const historyFiles = [...(options.historyFiles ?? [])].map((value) => path.resolve(value));
  historyFiles.sort((left, right) => left.localeCompare(right));
  for (const filePath of historyFiles) {
    addUniqueSource(
      sources,
      fileDescriptor("bridge_history_json", filePath, { includePaths }, warnings),
    );
  }

  if (!sources.some((source) => source.kind === "codex_rollout_jsonl")) {
    warnings.push({
      code: "no_codex_rollout_sources",
      source_kind: "codex_rollout_jsonl",
    });
  }
  if (!sources.some((source) => source.kind === "bridge_sqlite")) {
    warnings.push({
      code: "no_bridge_sqlite_sources",
      source_kind: "bridge_sqlite",
    });
  }

  return {
    codex_home: includePaths ? codexHome : null,
    read_only: true,
    discovered_at: null,
    sources,
    warnings,
  };
}
