import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authorityRootDigest } from "../executor/lease.js";
import { createPlatformProbe, type ProcessProbe } from "../runtime/process-probe.js";
import {
  fetchTaskConsoleSession,
  inspectTaskConsoleDiscovery,
  removeTaskConsoleDiscovery,
  type TaskConsoleDiscoveryRecord,
} from "./discovery.js";

export interface TaskConsoleLinkResult {
  readonly web_url: string;
  readonly console_id: string;
  readonly console_pid: number;
  readonly console_reused: boolean;
  readonly executor_lease_id: string;
  readonly authority_root_digest: string;
}

export interface ResolveTaskConsoleLinkOptions {
  readonly dataRoot: string;
  readonly settingsDirectory: string;
  readonly taskId: string;
  readonly leaseId: string;
  readonly timeoutMs?: number;
  readonly noStart?: boolean;
  readonly processProbe?: ProcessProbe;
  readonly spawnConsole?: (input: {
    readonly dataRoot: string;
    readonly settingsDirectory: string;
  }) => { readonly pid: number | undefined };
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolveTaskConsoleEntry(): string {
  const bundled = fileURLToPath(new URL("./web-console.mjs", import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL("../web/main.js", import.meta.url));
}

export function spawnTaskConsole(input: {
  readonly dataRoot: string;
  readonly settingsDirectory: string;
}): { readonly pid: number | undefined } {
  const child = spawn(process.execPath, [
    resolveTaskConsoleEntry(),
    "--data-root", input.dataRoot,
    "--settings-directory", input.settingsDirectory,
    "--port", "0",
  ], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid };
}

async function waitForTaskConsole(
  dataRoot: string,
  leaseId: string,
  timeoutMs: number,
  processProbe: ProcessProbe,
  wait: (milliseconds: number) => Promise<void>,
): Promise<{ readonly record: TaskConsoleDiscoveryRecord }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    const inspection = await inspectTaskConsoleDiscovery(dataRoot, processProbe);
    if (inspection.state === "active_owner" && inspection.record) {
      try {
        const session = await fetchTaskConsoleSession(inspection.record);
        if (session.executor.lease_id === leaseId) return { record: inspection.record };
        lastError = Object.assign(new Error("Task Console is bound to a different Executor lease"), {
          code: "WEB_CONSOLE_LEASE_MISMATCH",
        });
      } catch (error) {
        lastError = error;
      }
    } else if (inspection.state === "stale_owner" && inspection.record) {
      removeTaskConsoleDiscovery(dataRoot, inspection.record);
    } else if (inspection.state === "owner_unknown") {
      throw Object.assign(new Error("Task Console owner state is unknown"), {
        code: "WEB_CONSOLE_OWNER_UNKNOWN",
      });
    }
    await wait(250);
  }
  throw lastError instanceof Error
    ? lastError
    : Object.assign(new Error("Task Console did not become ready"), { code: "WEB_CONSOLE_UNAVAILABLE" });
}

/**
 * Resolve a verified Task Console deep link. Starting the console is best
 * effort: callers that must not reject an accepted Task treat any thrown
 * error as link-unavailable evidence.
 */
export async function resolveTaskConsoleLink(
  options: ResolveTaskConsoleLinkOptions,
): Promise<TaskConsoleLinkResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const processProbe = options.processProbe ?? createPlatformProbe();
  const wait = options.sleep ?? sleep;
  let discovery = await inspectTaskConsoleDiscovery(options.dataRoot, processProbe);
  if (discovery.state === "stale_owner" && discovery.record) {
    removeTaskConsoleDiscovery(options.dataRoot, discovery.record);
    discovery = await inspectTaskConsoleDiscovery(options.dataRoot, processProbe);
  }
  const reused = discovery.state === "active_owner";
  if (!reused) {
    if (options.noStart) {
      throw Object.assign(new Error("Task Console is not available and --no-start was requested"), {
        code: "WEB_CONSOLE_UNAVAILABLE",
      });
    }
    const spawned = (options.spawnConsole ?? spawnTaskConsole)({
      dataRoot: options.dataRoot,
      settingsDirectory: options.settingsDirectory,
    });
    if (!spawned.pid) {
      console.error("zcode-bridge: Task Console process has no PID; discovery verification will still run\n");
    }
  }
  const found = await waitForTaskConsole(options.dataRoot, options.leaseId, timeoutMs, processProbe, wait);
  return {
    web_url: `${found.record.url}?task_id=${encodeURIComponent(options.taskId)}`,
    console_id: found.record.console_id,
    console_pid: found.record.pid,
    console_reused: reused,
    executor_lease_id: options.leaseId,
    authority_root_digest: authorityRootDigest(options.dataRoot),
  };
}
