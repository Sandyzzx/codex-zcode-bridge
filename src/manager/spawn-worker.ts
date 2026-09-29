// Production worker spawner: launches a detached worker process for one task.
// Detached + stdio ignore: the worker outlives MCP server restarts; all
// communication happens through the TaskStore files.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkerEnv } from "../runtime/child-env.js";

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

export const defaultSpawnWorker: SpawnWorker = (dataRoot, taskId, attempt) => {
  const attemptDir = path.join(dataRoot, ".tasks", taskId, "attempts", String(attempt));
  mkdirSync(attemptDir, { recursive: true });
  const stderrFd = openSync(path.join(attemptDir, "worker-stderr.log"), "a", 0o600);
  try {
    const child = spawn(process.execPath, [workerEntryPath(), dataRoot, taskId], {
      detached: true,
      shell: false,
      stdio: ["ignore", "ignore", stderrFd],
      windowsHide: true,
      cwd: dataRoot,
      env: createWorkerEnv(process.env),
    });
    child.unref();
    if (typeof child.pid !== "number") {
      throw new Error("worker process did not provide a pid");
    }
    return { pid: child.pid };
  } finally {
    closeSync(stderrFd);
  }
};
