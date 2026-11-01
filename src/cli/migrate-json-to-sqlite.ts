#!/usr/bin/env node
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPlatformProbe } from "../runtime/process-probe.js";
import { publishJsonAuthority } from "../store/json-authority-cutover.js";
import {
  createJsonHistoryArchive,
  scanJsonHistorySource,
} from "../store/json-history-archive.js";
import {
  beginJsonWriterDrain,
  jsonWriterFenceState,
  sealJsonWriterRoot,
} from "../store/json-writer-quiescence.js";
import { TaskStore } from "../store/task-store.js";

interface CliOptions {
  readonly apply: boolean;
  readonly prepare: boolean;
  readonly jsonDataRoot: string;
  readonly sqliteRoot: string;
  readonly backupRoot: string;
  readonly databaseFileName: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let apply = false;
  let prepare = false;
  let jsonDataRoot = "";
  let sqliteRoot = "";
  let backupRoot = "";
  let databaseFileName = "bridge.sqlite";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--prepare") {
      prepare = true;
    } else if (argument === "--json-data-root" || argument === "--sqlite-root" || argument === "--backup-root" || argument === "--database") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--json-data-root") jsonDataRoot = value;
      else if (argument === "--sqlite-root") sqliteRoot = value;
      else if (argument === "--backup-root") backupRoot = value;
      else databaseFileName = value;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(help());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (apply && prepare) throw new Error("--apply and --prepare are mutually exclusive");
  if (prepare && (sqliteRoot || backupRoot || databaseFileName !== "bridge.sqlite")) {
    throw new Error("--prepare accepts only --json-data-root");
  }
  if (backupRoot && !apply) throw new Error("--backup-root requires --apply");
  if (!jsonDataRoot) throw new Error("--json-data-root is required");
  if (!prepare && !sqliteRoot) throw new Error("--sqlite-root is required unless --prepare is used");
  if (apply && !backupRoot) throw new Error("--backup-root is required with --apply");
  if (!path.isAbsolute(jsonDataRoot)
    || (!prepare && !path.isAbsolute(sqliteRoot))
    || (backupRoot && !path.isAbsolute(backupRoot))) {
    throw new Error("all provided roots must be absolute paths");
  }
  return { apply, prepare, jsonDataRoot, sqliteRoot, backupRoot, databaseFileName };
}

function help(): string {
  return [
    "Usage: node dist/src/cli/migrate-json-to-sqlite.js --json-data-root <path> --sqlite-root <path> [--database bridge.sqlite] [--apply --backup-root <path>]",
    "       node dist/src/cli/migrate-json-to-sqlite.js --json-data-root <path> --prepare",
    "",
    "The default is a read-only validation scan. --prepare drains and seals JSON writers.",
    "--apply first creates or verifies a complete JSON history archive, then performs",
    "the stop-the-world migration and atomic publish.",
    "",
  ].join("\n");
}

class CliBlockedError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliBlockedError";
    this.code = code;
  }
}

function requirePlainDirectory(value: string, code: string): string {
  let stat;
  try {
    stat = lstatSync(value);
  } catch (error) {
    throw new CliBlockedError(code, `${code}: ${value}`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliBlockedError(code, `${code}: ${value} must be a plain directory`);
  }
  return realpathSync.native(value);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function canonicalizePotentialPath(value: string, code: string): string {
  const absolute = path.resolve(value);
  let current = absolute;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new CliBlockedError(code, `${code}: no existing ancestor for ${value}`);
    }
    current = parent;
  }
  const stat = lstatSync(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CliBlockedError(code, `${code}: ${current} must be a plain directory`);
  }
  return path.resolve(realpathSync.native(current), path.relative(current, absolute));
}

function requireDisjointRoots(jsonDataRoot: string, sqliteRoot: string, backupRoot: string): void {
  const roots = [
    requirePlainDirectory(jsonDataRoot, "json_data_root_unavailable"),
    requirePlainDirectory(sqliteRoot, "sqlite_root_unavailable"),
    canonicalizePotentialPath(backupRoot, "archive_root_unavailable"),
  ];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (isWithin(roots[left]!, roots[right]!) || isWithin(roots[right]!, roots[left]!)) {
        throw new CliBlockedError(
          "cutover_roots_overlap",
          "JSON, SQLite and archive roots must be disjoint",
        );
      }
    }
  }
}

async function prepareJsonAuthority(jsonDataRoot: string): Promise<Record<string, unknown>> {
  const dataRoot = requirePlainDirectory(jsonDataRoot, "json_data_root_unavailable");
  requirePlainDirectory(path.join(dataRoot, ".tasks"), "json_tasks_root_unavailable");
  const drainState = await beginJsonWriterDrain(dataRoot);
  const store = new TaskStore(dataRoot);
  const result = await sealJsonWriterRoot(dataRoot, store, createPlatformProbe({ timeoutMs: 5_000 }));
  return {
    status: result.sealed ? "sealed" : "blocked",
    drain_state: drainState,
    sealed: result.sealed,
    state: result.state,
    blockers: result.blockers,
    reaped_leases: result.reaped_leases,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.prepare) {
    const result = await prepareJsonAuthority(options.jsonDataRoot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.sealed !== true) process.exitCode = 1;
    return;
  }
  if (!options.apply) {
    const dataRoot = requirePlainDirectory(options.jsonDataRoot, "json_data_root_unavailable");
    const tasksRoot = requirePlainDirectory(path.join(dataRoot, ".tasks"), "json_tasks_root_unavailable");
    const scan = await scanJsonHistorySource(tasksRoot);
    process.stdout.write(`${JSON.stringify({
      status: "validated",
      apply_requested: false,
      sealed: jsonWriterFenceState(dataRoot) === "sealed",
      source_digest: scan.source_digest,
      source_tasks_root: scan.source_tasks_root,
      artifact_count: scan.file_count,
      artifact_bytes: scan.byte_count,
    }, null, 2)}\n`);
    return;
  }
  requireDisjointRoots(options.jsonDataRoot, options.sqliteRoot, options.backupRoot);
  const dataRoot = requirePlainDirectory(options.jsonDataRoot, "json_data_root_unavailable");
  if (jsonWriterFenceState(dataRoot) !== "sealed") {
    throw new CliBlockedError("json_writer_root_not_sealed", "JSON writer fence must be sealed before apply");
  }
  const tasksRoot = requirePlainDirectory(path.join(dataRoot, ".tasks"), "json_tasks_root_unavailable");
  const archive = await createJsonHistoryArchive(
    tasksRoot,
    options.backupRoot,
    { mode: "raw" },
  );
  if (archive.manifest.archive_mode !== "raw"
    || archive.manifest.archive_status !== "archived"
    || archive.identity.source_tasks_root !== tasksRoot) {
    throw new CliBlockedError(
      "json_history_archive_incomplete",
      "raw JSON history archive is not complete or does not match the sealed migration source",
    );
  }
  const result = await publishJsonAuthority({
    jsonDataRoot: options.jsonDataRoot,
    sqliteRoot: options.sqliteRoot,
    databaseFileName: options.databaseFileName,
    archiveDirectory: archive.archive_directory,
    expectedArchiveManifestDigest: archive.identity.manifest_digest,
  });
  process.stdout.write(`${JSON.stringify({
    ...result,
    backup: {
      disposition: archive.disposition,
      archive_directory: archive.archive_directory,
      archive_manifest_digest: archive.identity.manifest_digest,
      archive_source_tasks_root: archive.identity.source_tasks_root,
      archive_status: archive.manifest.archive_status,
      source_file_count: archive.manifest.source_file_count,
      source_byte_count: archive.manifest.source_byte_count,
    },
  }, null, 2)}\n`);
}

const isEntry = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  main().catch((error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "migration_failed";
    process.stderr.write(`${JSON.stringify({
      status: "blocked",
      error_code: code,
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  });
}
