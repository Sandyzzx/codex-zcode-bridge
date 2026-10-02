// Production worker spawner: launches a detached worker process for one task.
// Detached + stdio ignore: the worker outlives MCP server restarts; all
// communication happens through the TaskStore files.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkerEnv } from "../runtime/child-env.js";
import { validateHostProfile, type BridgeHostProfile } from "../host/profile.js";

export interface SpawnedWorker {
  readonly pid: number;
}

export type SpawnWorker = (dataRoot: string, taskId: string, attempt: number) => SpawnedWorker;

export function workerEntryPath(): string {
  if (process.env["ZCODE_BRIDGE_PLUGIN_MODE"] === "1") {
    return fileURLToPath(new URL("../worker/worker-main.mjs", import.meta.url));
  }
  return fileURLToPath(new URL("../worker/worker-main.js", import.meta.url));
}

export function createWorkerSpawner(host?: BridgeHostProfile): SpawnWorker {
  if (host) validateHostProfile(host);
  return (dataRoot, taskId, attempt) => {
  const attemptDir = path.join(dataRoot, ".tasks", taskId, "attempts", String(attempt));
  mkdirSync(attemptDir, { recursive: true });
  const stderrFd = openSync(path.join(attemptDir, "worker-stderr.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [host?.workerEntryPath ?? workerEntryPath(), dataRoot, taskId, String(attempt)], {
      detached: true,
      shell: false,
      stdio: ["ignore", "ignore", stderrFd],
      windowsHide: true,
      cwd: dataRoot,
      env: { ...createWorkerEnv(process.env), ...(host ? { ZCODE_BRIDGE_HOST_PROFILE: JSON.stringify(host) } : {}) },
    });
    child.on("error", (error) => console.error(`Bridge worker spawn failed: ${error.message}`));
    child.unref();
    if (typeof child.pid !== "number") {
      throw new Error("worker process did not provide a pid");
    }
    return { pid: child.pid };
  } finally {
    closeSync(stderrFd);
  }
  };
}

export const defaultSpawnWorker: SpawnWorker = createWorkerSpawner();
