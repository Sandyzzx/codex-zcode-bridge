// Production worker spawner: launches a detached worker process for one task.
// Detached + stdio ignore: the worker outlives MCP server restarts; all
// communication happens through the TaskStore files.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createWorkerEnv } from "../runtime/child-env.js";

export interface SpawnedWorker {
  readonly pid: number;
}

export type SpawnWorker = (dataRoot: string, taskId: string) => SpawnedWorker;

export function workerEntryPath(): string {
  return fileURLToPath(new URL("../worker/worker-main.js", import.meta.url));
}

export const defaultSpawnWorker: SpawnWorker = (dataRoot, taskId) => {
  const child = spawn(process.execPath, [workerEntryPath(), dataRoot, taskId], {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
    cwd: dataRoot,
    env: createWorkerEnv(process.env),
  });
  child.unref();
  if (typeof child.pid !== "number") {
    throw new Error("worker process did not provide a pid");
  }
  return { pid: child.pid };
};
