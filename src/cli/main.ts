#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  loadInstallAuthoritySelection,
  resolveSqliteStateDirectory,
} from "../runtime/sqlite-install-config.js";
import { codexHostProfile, type BridgeHostProfile } from "../runtime/host-profile.js";
import { createPlatformProbe } from "../runtime/process-probe.js";
import { ExecutorControlClient } from "../executor/control-client.js";
import type {
  ExecutorControlMethod,
  ExecutorControlParamsByMethod,
  ExecutorControlResponse,
} from "../executor/protocol.js";
import { executorPipeName } from "../executor/pipe.js";
import {
  clearExecutorLease,
  EXECUTOR_UNLEASED_TRANSITION_ENV,
  inspectExecutorLease,
  type ExecutorLeaseInspection,
  type ExecutorLeaseRecord,
} from "../executor/lease.js";
import { resolveTaskConsoleLink } from "../web/console-link.js";
import {
  listTasksInputSchema,
  type ListTasksInput,
} from "../task-list.js";
import type { GetEventsInput, TaskResult, ZCodeInteractionReplyInput } from "../interfaces.js";

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const RESULT_STDOUT_LIMIT_BYTES = 1024 * 1024;

export const TASK_CLI_USAGE = [
  "usage: zcode-bridge [--data-root ABS] [--settings-directory ABS] <command>",
  "  executor start [--timeout-ms MS] [--accept-unleased-transition]",
  "  executor status",
  "  executor stop [--timeout-ms MS]",
  "  executor lease status",
  "  executor lease clear --confirm-owner-exited",
  "  task list [--after-task-id ID] [--limit 1..100] [--status STATUS]",
  "  task status <task_id>",
  "  task events <task_id> [--after-seq N] [--limit 1..200] [--wait-ms 0..25000]",
  "  task result <task_id> [--view summary|full] [--output ABS_PATH]",
  "  task cancel <task_id>",
  "  task reply <task_id> --request-id ID --decision allow|deny|accept|decline [--reason TEXT] [--answer KEY=VALUE]",
  "  task console-url <task_id> [--no-start] [--timeout-ms 500..60000]",
].join("\n");

export class CliUsageError extends Error {}

interface GlobalOptions {
  readonly dataRoot: string | null;
  readonly settingsDirectory: string | null;
}

interface CliControlClient {
  connect(): Promise<void>;
  request<M extends ExecutorControlMethod>(
    method: M,
    params: ExecutorControlParamsByMethod[M],
  ): Promise<ExecutorControlResponse>;
  close(): void;
}

export interface TaskCliDependencies {
  readonly createClient?: (pipeName: string, connectTimeoutMs?: number) => CliControlClient;
  readonly spawnExecutor?: (input: {
    readonly dataRoot: string;
    readonly settingsDirectory: string;
    readonly heartbeatMs?: number;
    readonly timeoutMs: number;
    readonly acceptUnleasedTransition?: true;
  }) => { readonly pid: number | undefined };
  readonly inspectLease?: (dataRoot: string) => Promise<ExecutorLeaseInspection>;
  readonly clearLease?: (dataRoot: string) => Promise<ExecutorLeaseRecord>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly spawnTaskConsole?: (input: {
    readonly dataRoot: string;
    readonly settingsDirectory: string;
  }) => { readonly pid: number | undefined };
}

export interface TaskCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const DEFAULT_IO: TaskCliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export async function runTaskCli(
  argv: readonly string[],
  io: TaskCliIo = DEFAULT_IO,
  dependencies: TaskCliDependencies = {},
): Promise<number> {
  try {
    const { globals, args } = parseGlobalOptions(argv);
    const command = args[0];
    const bridgeHost = hostWithSettings(globals.settingsDirectory);
    const dataRoot = resolveDataRoot(globals.dataRoot, bridgeHost);
    const pipeName = executorPipeName(dataRoot);

    if (command === "task") {
      return await runTaskCommand(args.slice(1), dataRoot, pipeName, bridgeHost.settingsDirectory, io, dependencies);
    }
    if (command === "executor") {
      return await runExecutorCommand(args.slice(1), {
        dataRoot,
        settingsDirectory: bridgeHost.settingsDirectory,
        pipeName,
      }, io, dependencies);
    }
    if (command === "--help" || command === "-h" || command === "help" || command === undefined) {
      io.stdout(`${TASK_CLI_USAGE}\n`);
      return 0;
    }
    throw new CliUsageError(`unknown command: ${command}`);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`zcode-bridge: ${error.message}\n${TASK_CLI_USAGE}\n`);
      return 2;
    }
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? `${error.code}: `
      : "";
    io.stderr(`zcode-bridge: ${code}${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parseGlobalOptions(argv: readonly string[]): { globals: GlobalOptions; args: string[] } {
  let dataRoot: string | null = null;
  let settingsDirectory: string | null = null;
  const args: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--data-root" || argument === "--settings-directory") {
      const value = argv[++index];
      if (!value) throw new CliUsageError(`${argument} requires an absolute path`);
      if (!path.isAbsolute(value)) throw new CliUsageError(`${argument} requires an absolute path`);
      if (argument === "--data-root") {
        if (dataRoot !== null) throw new CliUsageError("--data-root may appear only once");
        dataRoot = path.normalize(value);
      } else {
        if (settingsDirectory !== null) throw new CliUsageError("--settings-directory may appear only once");
        settingsDirectory = path.normalize(value);
      }
      continue;
    }
    args.push(argument);
  }
  return { globals: { dataRoot, settingsDirectory }, args };
}

function hostWithSettings(settingsDirectory: string | null): BridgeHostProfile {
  return settingsDirectory === null
    ? codexHostProfile()
    : { ...codexHostProfile(), settingsDirectory };
}

function resolveDataRoot(override: string | null, host: BridgeHostProfile): string {
  if (override !== null) return override;
  const selection = loadInstallAuthoritySelection(host);
  return resolveSqliteStateDirectory(selection, process.env).dataRoot;
}

async function runTaskCommand(
  args: readonly string[],
  dataRoot: string,
  pipeName: string,
  settingsDirectory: string,
  io: TaskCliIo,
  dependencies: TaskCliDependencies,
): Promise<number> {
  const subcommand = args[0];
  if (subcommand === "list") {
    const options = parseFlags(args.slice(1), new Set([
      "--after-task-id", "--limit", "--status",
    ]));
    const input: ListTasksInput = listTasksInputSchema.parse({
      ...(options.single.get("--after-task-id")
        ? { after_task_id: options.single.get("--after-task-id") }
        : {}),
      ...(options.single.get("--limit")
        ? { limit: integer("--limit", options.single.get("--limit")!, 1, 100) }
        : {}),
      ...(options.single.get("--status")
        ? { status: options.single.get("--status") }
        : {}),
    });
    return withClient(dependencies, pipeName, async (client) => {
      writeJson(io, (await requestOk(client, "listTasks", input)).result);
      return 0;
    });
  }
  if (subcommand === "console-url") {
    return runTaskConsoleUrl(args.slice(1), dataRoot, pipeName, settingsDirectory, io, dependencies);
  }

  const taskId = args[1];
  if (subcommand !== undefined && TASK_ID.test(taskId ?? "")) {
    if (subcommand === "status") {
      requireNoFlags(args.slice(2));
      return withClient(dependencies, pipeName, async (client) => {
        writeJson(io, (await requestOk(client, "getStatus", { task_id: taskId! })).result);
        return 0;
      });
    }
    if (subcommand === "events") {
      const options = parseFlags(args.slice(2), new Set([
        "--after-seq", "--limit", "--wait-ms", "--view", "--include-attempt",
        "--scan-cursor", "--max-bytes", "--wait-for-attention",
      ]), new Set(["--include-attempt", "--wait-for-attention"]));
      const input: GetEventsInput = {
        task_id: taskId!,
        ...(options.single.get("--after-seq")
          ? { after_seq: integer("--after-seq", options.single.get("--after-seq")!, 0, Number.MAX_SAFE_INTEGER) }
          : {}),
        ...(options.single.get("--limit")
          ? { limit: integer("--limit", options.single.get("--limit")!, 1, 200) }
          : {}),
        ...(options.single.get("--wait-ms")
          ? { wait_ms: integer("--wait-ms", options.single.get("--wait-ms")!, 0, 25_000) }
          : {}),
        ...(options.single.get("--view")
          ? { view: enumValue("--view", options.single.get("--view")!, ["raw", "summary"] as const) }
          : {}),
        ...(options.single.get("--scan-cursor")
          ? { scan_cursor: options.single.get("--scan-cursor")! }
          : {}),
        ...(options.single.get("--max-bytes")
          ? { max_bytes: integer("--max-bytes", options.single.get("--max-bytes")!, 1_024, 33_554_432) }
          : {}),
        ...(options.boolean.has("--include-attempt") ? { include_attempt: true } : {}),
        ...(options.boolean.has("--wait-for-attention") ? { wait_for: "attention" as const } : {}),
      };
      return withClient(dependencies, pipeName, async (client) => {
        writeJson(io, (await requestOk(client, "getEvents", { input })).result);
        return 0;
      });
    }
    if (subcommand === "result") {
      const options = parseFlags(args.slice(2), new Set(["--view", "--output"]));
      const view = options.single.has("--view")
        ? enumValue("--view", options.single.get("--view")!, ["summary", "full"] as const)
        : "summary";
      const output = options.single.get("--output");
      if (output !== undefined && !path.isAbsolute(output)) throw new CliUsageError("--output requires an absolute path");
      return withClient(dependencies, pipeName, async (client) => {
        // P1 §3.4B: the summary projection runs Executor-side; the CLI stops
        // transporting the full Result for summary reads.
        const result = (await requestOk(client, "getResult", { task_id: taskId!, ...(view ? { view } : {}) })).result as unknown as TaskResult;
        const value = result;
        const serialized = `${JSON.stringify(value, null, 2)}\n`;
        if (output !== undefined) {
          writeFileSync(path.normalize(output), serialized, { encoding: "utf8", flag: "wx" });
          writeJson(io, { task_id: result.task_id, attempt: result.attempt, output: path.normalize(output), bytes: Buffer.byteLength(serialized) });
          return 0;
        }
        if (Buffer.byteLength(serialized) > RESULT_STDOUT_LIMIT_BYTES) {
          throw Object.assign(new Error("Result exceeds the 1 MiB stdout budget; use --output with an absolute path"), {
            code: "RESULT_OUTPUT_BOUNDED",
          });
        }
        io.stdout(serialized);
        return 0;
      });
    }
    if (subcommand === "cancel") {
      requireNoFlags(args.slice(2));
      return withClient(dependencies, pipeName, async (client) => {
        writeJson(io, (await requestOk(client, "cancelTask", { task_id: taskId! })).result);
        return 0;
      });
    }
    if (subcommand === "reply") {
      const options = parseFlags(args.slice(2), new Set([
        "--request-id", "--decision", "--reason", "--answer",
      ]), new Set(), new Set(["--answer"]));
      const requestId = required(options.single, "--request-id");
      const decision = enumValue(
        "--decision",
        required(options.single, "--decision"),
        ["allow", "deny", "accept", "decline"] as const,
      );
      const answers = Object.fromEntries(options.multiple.map((entry) => {
        const separator = entry.indexOf("=");
        if (separator <= 0 || separator === entry.length - 1) {
          throw new CliUsageError("--answer must use KEY=VALUE");
        }
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }));
      const input: ZCodeInteractionReplyInput = {
        task_id: taskId!,
        request_id: requestId,
        decision,
        ...(options.single.get("--reason") ? { reason: options.single.get("--reason") } : {}),
        ...(Object.keys(answers).length > 0 ? { answers } : {}),
      };
      return withClient(dependencies, pipeName, async (client) => {
        writeJson(io, (await requestOk(client, "replyToInteraction", { input })).result);
        return 0;
      });
    }
  }
  throw new CliUsageError("unknown or invalid task command");
}

async function runTaskConsoleUrl(
  args: readonly string[],
  dataRoot: string,
  pipeName: string,
  settingsDirectory: string,
  io: TaskCliIo,
  dependencies: TaskCliDependencies,
): Promise<number> {
  const taskId = args[0];
  if (!TASK_ID.test(taskId ?? "")) throw new CliUsageError("console-url requires a valid task_id");
  const options = parseFlags(
    args.slice(1),
    new Set(["--no-start", "--timeout-ms"]),
    new Set(["--no-start"]),
  );
  const timeoutMs = options.single.has("--timeout-ms")
    ? integer("--timeout-ms", options.single.get("--timeout-ms")!, 500, 60_000)
    : 5_000;
  const noStart = options.boolean.has("--no-start");
  return withClient(dependencies, pipeName, async (client) => {
    const taskStatus = (await requestOk(client, "getStatus", { task_id: taskId! })).result as {
      readonly status?: string;
      readonly attempt?: number;
    };
    const executor = (await requestOk(client, "executorStatus", {})).result ?? {};
    const leaseId = typeof executor.lease_id === "string" ? executor.lease_id : null;
    if (!leaseId) {
      throw Object.assign(new Error("Executor lease identity is unavailable"), {
        code: "EXECUTOR_LEASE_UNKNOWN",
      });
    }
    const link = await resolveTaskConsoleLink({
      dataRoot,
      settingsDirectory,
      taskId: taskId!,
      leaseId,
      timeoutMs,
      noStart,
      ...(dependencies.spawnTaskConsole ? { spawnConsole: dependencies.spawnTaskConsole } : {}),
      ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
    });
    writeJson(io, {
      task_id: taskId,
      status: taskStatus.status ?? "unknown",
      attempt: taskStatus.attempt ?? null,
      ...link,
    });
    return 0;
  });
}

async function runExecutorCommand(
  args: readonly string[],
  context: { readonly dataRoot: string; readonly settingsDirectory: string; readonly pipeName: string },
  io: TaskCliIo,
  dependencies: TaskCliDependencies,
): Promise<number> {
  const command = args[0];
  if (command === "status") {
    requireNoFlags(args.slice(1));
    return withClient(dependencies, context.pipeName, async (client) => {
      writeJson(io, (await requestOk(client, "executorStatus", {})).result);
      return 0;
    });
  }
  if (command === "start") {
    const options = parseFlags(
      args.slice(1),
      new Set(["--timeout-ms", "--heartbeat-ms", "--accept-unleased-transition"]),
      new Set(["--accept-unleased-transition"]),
    );
    const timeoutMs = options.single.has("--timeout-ms")
      ? integer("--timeout-ms", options.single.get("--timeout-ms")!, 500, 60_000)
      : 10_000;
    const heartbeatMs = options.single.has("--heartbeat-ms")
      ? integer("--heartbeat-ms", options.single.get("--heartbeat-ms")!, 100, 60_000)
      : undefined;
    const existing = await tryExecutorStatus(context.pipeName, dependencies);
    if (existing !== null) {
      writeJson(io, {
        status: "already_running",
        pid: null,
        ...existing,
      });
      return 0;
    }
    const spawned = (dependencies.spawnExecutor ?? spawnExecutor)({
      dataRoot: context.dataRoot,
      settingsDirectory: context.settingsDirectory,
      ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
      timeoutMs,
      ...(options.boolean.has("--accept-unleased-transition")
        ? { acceptUnleasedTransition: true as const }
        : {}),
    });
    const status = await waitForExecutorStatus(context.pipeName, dependencies, timeoutMs);
    writeJson(io, { status: "started", pid: spawned.pid ?? null, ...status });
    return 0;
  }
  if (command === "stop") {
    const options = parseFlags(args.slice(1), new Set(["--timeout-ms"]));
    const timeoutMs = options.single.has("--timeout-ms")
      ? integer("--timeout-ms", options.single.get("--timeout-ms")!, 500, 60_000)
      : 10_000;
    return withClient(dependencies, context.pipeName, async (client) => {
      const decision = (await requestOk(client, "shutdown", {})).result;
      if (decision?.status !== "accepted") {
        writeJson(io, decision);
        return decision?.status === "not_idle" ? 3 : 1;
      }
      client.close();
      const state = await waitForExecutorDown(context.pipeName, dependencies, timeoutMs);
      writeJson(io, { status: "closed", requested: "accepted", ...state });
      return state.state === "closed" ? 0 : 1;
    });
  }
  if (command === "lease") {
    const leaseCommand = args[1];
    if (leaseCommand === "status") {
      requireNoFlags(args.slice(2));
      const inspection = await (dependencies.inspectLease ?? inspectLease)(context.dataRoot);
      writeJson(io, inspection);
      return inspection.owner_state === "alive" && inspection.lease.state === "active" ? 0 : 3;
    }
    if (leaseCommand === "clear") {
      const options = parseFlags(args.slice(2), new Set(), new Set(["--confirm-owner-exited"]));
      if (!options.boolean.has("--confirm-owner-exited")) {
        throw new CliUsageError("lease clear requires --confirm-owner-exited");
      }
      const cleared = await (dependencies.clearLease ?? clearLease)(context.dataRoot);
      writeJson(io, cleared);
      return 0;
    }
  }
  throw new CliUsageError("unknown executor command");
}

async function withClient(
  dependencies: TaskCliDependencies,
  pipeName: string,
  operation: (client: CliControlClient) => Promise<number>,
): Promise<number> {
  const client = (dependencies.createClient ?? defaultClient)(pipeName);
  try {
    await client.connect();
    return await operation(client);
  } finally {
    client.close();
  }
}

async function requestOk<M extends ExecutorControlMethod>(
  client: CliControlClient,
  method: M,
  params: ExecutorControlParamsByMethod[M],
): Promise<ExecutorControlResponse> {
  const response = await client.request(method, params);
  if (!response.ok) {
    throw Object.assign(
      new Error(response.error?.message ?? "EXECUTOR_REQUEST_FAILED"),
      { code: response.error?.code ?? "EXECUTOR_REQUEST_FAILED" },
    );
  }
  return response;
}

function defaultClient(pipeName: string, connectTimeoutMs?: number): CliControlClient {
  return new ExecutorControlClient({
    pipeName,
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
  });
}

function spawnExecutor(input: {
  readonly dataRoot: string;
  readonly settingsDirectory: string;
  readonly heartbeatMs?: number;
  readonly timeoutMs: number;
  readonly acceptUnleasedTransition?: true;
}): { readonly pid: number | undefined } {
  const executorEntry = resolveExecutorEntry();
  const bridgeEntry = resolveBridgeEntry();
  const child = spawn(process.execPath, [
    executorEntry,
    "--data-root", input.dataRoot,
    "--bridge-entry", bridgeEntry,
    "--settings-directory", input.settingsDirectory,
    ...(input.heartbeatMs === undefined ? [] : ["--heartbeat-ms", String(input.heartbeatMs)]),
  ], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ...(input.acceptUnleasedTransition === true
        ? { [EXECUTOR_UNLEASED_TRANSITION_ENV]: "1" }
        : {}),
    },
  });
  child.unref();
  return { pid: child.pid };
}

function resolveExecutorEntry(): string {
  const bundled = fileURLToPath(new URL("./executor.mjs", import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../executor/main.js", import.meta.url));
}

function resolveBridgeEntry(): string {
  const bundled = fileURLToPath(new URL("./bridge.mjs", import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../mcp/main.js", import.meta.url));
}

async function tryExecutorStatus(
  pipeName: string,
  dependencies: TaskCliDependencies,
): Promise<Record<string, unknown> | null> {
  const client = (dependencies.createClient ?? defaultClient)(pipeName, 250);
  try {
    await client.connect();
    return (await requestOk(client, "executorStatus", {})).result ?? {};
  } catch (error) {
    if (isUnavailable(error)) return null;
    throw error;
  } finally {
    client.close();
  }
}

async function waitForExecutorStatus(
  pipeName: string,
  dependencies: TaskCliDependencies,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const client = (dependencies.createClient ?? defaultClient)(pipeName, 250);
    try {
      await client.connect();
      return (await requestOk(client, "executorStatus", {})).result ?? {};
    } catch (error) {
      if (!isUnavailable(error)) throw error;
    } finally {
      client.close();
    }
    await (dependencies.sleep ?? sleep)(250);
  }
  throw Object.assign(new Error("Executor did not become ready before the bounded timeout"), {
    code: "EXECUTOR_START_TIMEOUT",
  });
}

async function waitForExecutorDown(
  pipeName: string,
  dependencies: TaskCliDependencies,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    await (dependencies.sleep ?? sleep)(100);
    const client = (dependencies.createClient ?? defaultClient)(pipeName, 250);
    try {
      await client.connect();
      lastStatus = (await requestOk(client, "executorStatus", {})).result ?? {};
    } catch (error) {
      if (isUnavailable(error)) return { state: "closed" };
      throw error;
    } finally {
      client.close();
    }
  }
  return {
    state: "unknown",
    reason: "shutdown_timeout",
    ...(lastStatus === null ? {} : { last_status: lastStatus }),
  };
}

function inspectLease(dataRoot: string): Promise<ExecutorLeaseInspection> {
  return inspectExecutorLease({ authorityRoot: dataRoot, processProbe: createPlatformProbe() });
}

function clearLease(dataRoot: string): Promise<ExecutorLeaseRecord> {
  return clearExecutorLease({ authorityRoot: dataRoot, processProbe: createPlatformProbe() });
}

function parseFlags(
  args: readonly string[],
  allowed: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string> = new Set(),
  multipleFlags: ReadonlySet<string> = new Set(),
): {
  readonly single: Map<string, string>;
  readonly boolean: Set<string>;
  readonly multiple: string[];
} {
  const single = new Map<string, string>();
  const boolean = new Set<string>();
  const multiple: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!allowed.has(flag)) throw new CliUsageError(`unknown option: ${flag}`);
    if (booleanFlags.has(flag)) {
      if (boolean.has(flag)) throw new CliUsageError(`${flag} may appear only once`);
      boolean.add(flag);
      continue;
    }
    const value = args[++index];
    if (value === undefined) throw new CliUsageError(`${flag} requires a value`);
    if (multipleFlags.has(flag)) multiple.push(value);
    else if (single.has(flag)) throw new CliUsageError(`${flag} may appear only once`);
    else single.set(flag, value);
  }
  return { single, boolean, multiple };
}

function requireNoFlags(args: readonly string[]): void {
  if (args.length > 0) throw new CliUsageError(`unexpected argument: ${args[0]}`);
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new CliUsageError(`${flag} is required`);
  return value;
}

function integer(flag: string, value: string, min: number, max: number): number {
  if (!/^\d+$/u.test(value)) throw new CliUsageError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CliUsageError(`${flag} must be within ${min}..${max}`);
  }
  return parsed;
}

function enumValue<T extends string>(flag: string, value: string, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new CliUsageError(`${flag} must be one of ${values.join(", ")}`);
  return value as T;
}

function isUnavailable(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && ["EXECUTOR_UNAVAILABLE", "ECONNREFUSED", "ENOENT"].includes(String(error.code));
}

function writeJson(io: TaskCliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await runTaskCli(process.argv.slice(2));
}
