#!/usr/bin/env node
// Thin host waiter adapted from PR #49's wait-task.mjs lifecycle. The original
// contribution is by Bill <chen.pengyu1@student.zy.cdut.edu.cn>.
// It waits on the shared SQLite Attention projection and never reads legacy
// JSON task records, approves interactions, or starts the MCP server.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openReadOnlyAttention } from "../attention/read-only.js";
import { waitForAttentionSnapshot, type AttentionWakeReason } from "../attention/wait.js";
import { TaskManagerError } from "../manager/errors.js";
import { codexHostProfile } from "../host/profile.js";
import {
  FRESH_SQLITE_DATABASE_FILE,
  loadInstallAuthoritySelection,
  resolveSqliteStateDirectory,
} from "../runtime/sqlite-install-config.js";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
export const THIN_WAITER_SCHEMA = "zcode-bridge/wait-task-v2";
const PENDING_OUTPUT_LIMIT = 4_096;

export class UsageError extends Error {}

export interface WaitTaskOptions {
  readonly task: string;
  readonly timeoutS: number;
  readonly pollMs: number;
  readonly dataDir: string | null;
}

export interface ThinWaitOutput {
  readonly schema: typeof THIN_WAITER_SCHEMA;
  readonly task_id: string;
  readonly reason: AttentionWakeReason;
  readonly status: string;
  readonly attempt: number;
  readonly initial_attempt: number;
  readonly elapsed_ms: number;
  readonly pending_count: number;
  readonly pending_requests: string[];
  readonly pending_truncated: boolean;
  readonly note: string;
}

export interface WaitDataSource {
  readonly dataRoot: string;
  readonly databaseFileName: string;
}

export function parseWaitTaskArgs(argv: readonly string[]): WaitTaskOptions {
  const options: { task: string | null; timeoutS: number; pollMs: number; dataDir: string | null } = {
    task: null,
    timeoutS: 1_500,
    pollMs: 2_000,
    dataDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--help" || flag === "-h") throw new UsageError("");
    if (value === undefined) throw new UsageError(`missing value for ${flag}`);
    index += 1;
    if (flag === "--task") options.task = value;
    else if (flag === "--timeout-s") options.timeoutS = integer(flag, value, 1, 86_400);
    else if (flag === "--poll-ms") options.pollMs = integer(flag, value, 250, 60_000);
    else if (flag === "--data-dir") options.dataDir = value;
    else throw new UsageError(`unknown option ${flag}`);
  }
  if (!options.task || !TASK_ID.test(options.task)) {
    throw new UsageError("--task must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
  }
  if (options.dataDir !== null) options.dataDir = requireAbsolute(options.dataDir, "--data-dir");
  return options as WaitTaskOptions;
}

/**
 * Resolve the same installed Authority selection as the Bridge. An explicit
 * --data-dir is the SQLite state directory, not a legacy JSON task root.
 */
export function resolveWaitDataRoot(
  dataDir: string | null,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): WaitDataSource {
  if (dataDir) {
    return { dataRoot: requireAbsolute(dataDir, "--data-dir"), databaseFileName: FRESH_SQLITE_DATABASE_FILE };
  }
  const selection = loadInstallAuthoritySelection(codexHostProfile(home));
  if (selection.state !== "sqlite") {
    throw new Error("SQLite authority is not selected; thin waiter never falls back to legacy JSON");
  }
  return resolveSqliteStateDirectory(selection, env);
}

export async function runThinWaitTask(options: WaitTaskOptions): Promise<ThinWaitOutput> {
  const dataSource = resolveWaitDataRoot(options.dataDir);
  const source = await openReadOnlyAttention(dataSource);
  try {
    const result = await waitForAttentionSnapshot({
      read: async () => {
        const value = source.read(options.task);
        if (value === null) throw new TaskManagerError("TASK_NOT_FOUND", `unknown SQLite task: ${options.task}`);
        return value;
      },
      timeoutMs: options.timeoutS * 1_000,
      pollMs: options.pollMs,
    });
    const pending = boundedPending(result.snapshot.pending_requests);
    return {
      schema: THIN_WAITER_SCHEMA,
      task_id: options.task,
      reason: result.reason,
      status: result.snapshot.status,
      attempt: result.snapshot.attempt,
      initial_attempt: result.initial_attempt,
      elapsed_ms: result.elapsed_ms,
      pending_count: result.snapshot.pending_requests.length,
      pending_requests: pending.requests,
      pending_truncated: pending.truncated,
      note: "Read-only observation from the SQLite Attention Core. Read request details and make decisions through zcode_events and zcode_interaction_reply; completed is not acceptance.",
    };
  } finally {
    source.close();
  }
}

async function main(): Promise<void> {
  let options: WaitTaskOptions;
  try {
    options = parseWaitTaskArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (error.message) console.error(`wait-task: ${error.message}`);
    console.error("usage: node wait-task.mjs --task <task_id> [--timeout-s S] [--poll-ms MS] [--data-dir ABS_SQLITE_STATE_DIR]");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runThinWaitTask(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.reason === "timeout" ? 3 : 0;
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === "string" ? `${(error as { code: string }).code}: ` : "";
    console.error(`wait-task: ${code}${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

function boundedPending(values: readonly string[]): { requests: string[]; truncated: boolean } {
  const requests: string[] = [];
  let bytes = 2;
  for (const value of values) {
    const size = Buffer.byteLength(JSON.stringify(value), "utf8") + (requests.length ? 1 : 0);
    if (requests.length > 0 && bytes + size > PENDING_OUTPUT_LIMIT) return { requests, truncated: true };
    requests.push(value);
    bytes += size;
  }
  return { requests, truncated: false };
}

function integer(flag: string, value: string, min: number, max: number): number {
  if (!/^\d+$/u.test(value)) throw new UsageError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be within ${min}..${max}`);
  }
  return parsed;
}

function requireAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new UsageError(`${label} must be an absolute path: ${value}`);
  return path.normalize(value);
}

function isEntry(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = realpathSync(path.resolve(process.argv[1]));
    return process.platform === "win32"
      ? self.toLocaleLowerCase("en-US") === entry.toLocaleLowerCase("en-US")
      : self === entry;
  } catch {
    return false;
  }
}

if (isEntry()) await main();
