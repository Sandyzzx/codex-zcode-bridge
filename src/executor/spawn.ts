import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXECUTOR_UNLEASED_TRANSITION_ENV } from "./lease.js";

export interface ExecutorSpawnInput {
  readonly dataRoot: string;
  readonly settingsDirectory: string;
  readonly heartbeatMs?: number;
  readonly acceptUnleasedTransition?: true;
  readonly bridgeEntryPath?: string;
  readonly executorEntryPath?: string;
  readonly moduleUrl?: string | URL;
}

export interface ExecutorSpawnHandle {
  readonly pid: number | undefined;
}

/** Start the standalone Executor without inheriting the Host's stdio. */
export function spawnExecutorProcess(input: ExecutorSpawnInput): ExecutorSpawnHandle {
  const executorEntry = input.executorEntryPath ?? resolveExecutorEntry(input.moduleUrl);
  const bridgeEntry = input.bridgeEntryPath ?? resolveBridgeEntry(input.moduleUrl);
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

export function resolveExecutorEntry(moduleUrl: string | URL = import.meta.url): string {
  const bundled = fileURLToPath(new URL("./executor.mjs", moduleUrl));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../executor/main.js", moduleUrl));
}

export function resolveBridgeEntry(moduleUrl: string | URL = import.meta.url): string {
  const bundled = fileURLToPath(new URL("./bridge.mjs", moduleUrl));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../mcp/main.js", moduleUrl));
}
