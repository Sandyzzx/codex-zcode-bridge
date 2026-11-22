// Internal Executor entry point. This is not a user-facing management CLI.
// It exists so ownership and lifecycle contracts can be exercised across real
// OS processes before the MCP Host is migrated to the control transport.
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { codexHostProfile } from "../runtime/host-profile.js";
import { startExecutorService } from "./service.js";
import { EXECUTOR_UNLEASED_TRANSITION_ENV } from "./lease.js";

export const EXECUTOR_USAGE = [
  "EXECUTOR_USAGE: node dist/src/executor/main.js --data-root <absolute-path>",
  "  [--bridge-entry <absolute-path>] [--settings-directory <absolute-path>]",
  "  [--heartbeat-ms <positive-integer>]",
].join(" ");

export interface ExecutorMainOptions {
  /** Only the dist-test harness may enable synthetic execution flags. */
  readonly testOnly?: boolean;
}

function fail(message: string): never {
  console.error(`EXECUTOR_START_FAILED ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail("heartbeat_ms_invalid");
  return parsed;
}

function printUsage(testOnly = false): void {
  console.error(EXECUTOR_USAGE);
  if (testOnly) {
    console.error("EXECUTOR_TEST_USAGE: [--worker-entry <absolute-path>] [--test-only-fake-adapter]");
  }
}

export async function runExecutorMain(
  argv: readonly string[] = process.argv.slice(2),
  options: ExecutorMainOptions = {},
): Promise<void> {
  const testOnly = options.testOnly === true;
  const parsed: {
    dataRoot?: string;
    bridgeEntry?: string;
    workerEntry?: string;
    settingsDirectory?: string;
    heartbeatMs?: number;
    fake?: true;
  } = {};
  if (argv.includes("--help")) {
    printUsage(testOnly);
    return;
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--test-only-fake-adapter") {
      if (!testOnly) fail(`unknown_argument:${argument}`);
      parsed.fake = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) fail("argument_value_missing");
    if (argument === "--data-root") parsed.dataRoot = value;
    else if (argument === "--bridge-entry") parsed.bridgeEntry = value;
    else if (argument === "--worker-entry") {
      if (!testOnly) fail(`unknown_argument:${argument}`);
      parsed.workerEntry = value;
    }
    else if (argument === "--settings-directory") parsed.settingsDirectory = value;
    else if (argument === "--heartbeat-ms") parsed.heartbeatMs = parsePositiveInteger(value);
    else fail(`unknown_argument:${argument}`);
    index += 1;
  }
  if (!parsed.dataRoot || !path.isAbsolute(parsed.dataRoot)) fail("data_root_absolute_required");
  if (parsed.settingsDirectory !== undefined && !path.isAbsolute(parsed.settingsDirectory)) fail("settings_directory_absolute_required");

  const bridgeEntry = parsed.bridgeEntry ?? path.resolve("dist/src/executor/main.js");
  try {
    const service = await startExecutorService({
      dataRoot: parsed.dataRoot,
      host: parsed.settingsDirectory
        ? { ...codexHostProfile(), settingsDirectory: parsed.settingsDirectory }
        : codexHostProfile(),
      bridgeEntryPath: bridgeEntry,
      heartbeatMs: parsed.heartbeatMs,
      acceptUnleasedExistingRoot: process.env[EXECUTOR_UNLEASED_TRANSITION_ENV] === "1",
      ...(parsed.workerEntry ? { testWorkerEntryPath: parsed.workerEntry } : {}),
      ...(parsed.fake ? { testOnlyFakeAdapter: true } : {}),
    });
    console.log(`EXECUTOR_READY ${JSON.stringify({ lease_id: service.leaseId, pipe_name: service.pipeName })}`);
    await new Promise<void>((resolve) => {
      let inProgress = false;
      let releaseUnknown = false;
      const requestShutdown = (signal: string): void => {
        if (inProgress || releaseUnknown) return;
        inProgress = true;
        console.error(`EXECUTOR_SHUTDOWN_REQUESTED ${signal}`);
        void service.shutdown().then((shutdown) => {
          if (shutdown.status === "closed") {
            process.off("SIGINT", onInterrupt);
            process.off("SIGTERM", onTerminate);
            process.exitCode = 0;
            resolve();
            return;
          }
          if (shutdown.status === "not_idle") {
            console.error(`EXECUTOR_SHUTDOWN_NOT_IDLE ${JSON.stringify({ blockers: shutdown.blockers })}`);
            process.exitCode = 0;
            inProgress = false;
            return;
          }
          releaseUnknown = true;
          process.exitCode = 3;
          console.error(`EXECUTOR_LEASE_RELEASE_UNKNOWN ${JSON.stringify({ blockers: shutdown.blockers })}`);
          // Keep the process and its heartbeat alive: the Store may still be
          // open or the published owner record may be unknown. Operator
          // recovery must not be replaced by process exit.
        }).catch((error: unknown) => {
          releaseUnknown = true;
          process.exitCode = 3;
          console.error(`EXECUTOR_SHUTDOWN_UNKNOWN ${error instanceof Error ? error.message : String(error)}`);
        });
      };
      const onInterrupt = (): void => requestShutdown("SIGINT");
      const onTerminate = (): void => requestShutdown("SIGTERM");
      process.on("SIGINT", onInterrupt);
      process.on("SIGTERM", onTerminate);
    });
    console.log("EXECUTOR_CLOSED");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void runExecutorMain();
}
