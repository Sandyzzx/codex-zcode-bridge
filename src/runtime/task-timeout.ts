import type { TaskPackage } from "../interfaces.js";

export const DEFAULT_TASK_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_TASK_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MIN_TASK_TIMEOUT_MS = 60 * 1000;

/** A task override wins; otherwise use the user's bounded Bridge default. */
export function resolveTaskTimeout(task: Pick<TaskPackage, "timeout_ms">, env: NodeJS.ProcessEnv): number {
  if (task.timeout_ms !== undefined) return validateTaskTimeout(task.timeout_ms);
  const raw = env["ZCODE_BRIDGE_TIMEOUT_MS"]?.trim();
  if (!raw) return DEFAULT_TASK_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_TASK_TIMEOUT_MS || value > MAX_TASK_TIMEOUT_MS) {
    return DEFAULT_TASK_TIMEOUT_MS;
  }
  return value;
}

export function validateTaskTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TASK_TIMEOUT_MS || value > MAX_TASK_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer from ${MIN_TASK_TIMEOUT_MS} to ${MAX_TASK_TIMEOUT_MS}`);
  }
  return value;
}
