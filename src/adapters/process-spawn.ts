// Process helpers for the ZCode adapter: bounded output capture, process-tree
// termination with verification.
//
// Portions adapted from cc-plugin-codex, file scripts/lib/process.mjs
// (https://github.com/hex1n/cc-plugin-codex, commit
// 501f975372ddb5117b6389114c15f1ccd0104711), licensed under the Apache License,
// Version 2.0. Modifications: TypeScript ESM, injection-friendly types for the
// Bridge adapter contract, extra termination verification for this project.
import { spawn } from "node:child_process";
import { createPlatformProbe } from "../runtime/process-probe.js";
import { parseWindowsTreeCapture, terminateWindowsProcessTree, windowsTreeCaptureScript } from "./windows-process-cleanup.js";

export interface OutputStreamLike {
  setEncoding(encoding: "utf8"): void;
  on(event: "data", listener: (chunk: string) => void): void;
}

export interface SpawnedProcess {
  readonly pid?: number;
  readonly stdout: OutputStreamLike | null;
  readonly stderr: OutputStreamLike | null;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnOptionsLike {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: boolean;
}

export type SpawnFunction = (
  file: string,
  args: string[],
  options: SpawnOptionsLike,
) => SpawnedProcess;

export const defaultSpawnFunction: SpawnFunction = (file, args, options) =>
  // detached on POSIX so the child leads its own process group and the whole
  // tree can be signalled; Windows uses taskkill /T instead.
  spawn(file, args, {
    ...options,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

export interface BoundedText {
  value: string;
  truncated: boolean;
}

export function appendBounded(current: BoundedText, chunk: string, maxBytes: number): BoundedText {
  if (!(maxBytes > 0)) return { value: current.value + chunk, truncated: current.truncated };
  const remaining = maxBytes - Buffer.byteLength(current.value, "utf8");
  if (remaining <= 0) return chunk ? { value: current.value, truncated: true } : current;
  const bytes = Buffer.from(chunk, "utf8");
  if (bytes.length <= remaining) {
    return { value: current.value + chunk, truncated: current.truncated };
  }
  return {
    value: current.value + bytes.subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export interface TerminationResult {
  readonly pid: number;
  readonly signal: "SIGTERM" | "SIGKILL";
  readonly verified: true;
}

export type TerminateProcessTree = (
  pid: number,
  options?: { graceMs?: number; killWaitMs?: number },
) => Promise<TerminationResult>;

/**
 * Terminates a process tree and only resolves after termination is verified.
 * Windows: `taskkill /PID <pid> /T /F`, followed by startup-identity checks
 * of the captured root and descendants, regardless of its exit code.
 * POSIX: SIGTERM to the process group, then
 * SIGKILL, verified by group/pid liveness polls.
 */
export const terminateProcessTree: TerminateProcessTree = async (pid, options = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`A positive integer PID is required, got: ${pid}`);
  }
  if (process.platform === "win32") {
    const probe = createPlatformProbe();
    await terminateWindowsProcessTree(pid, options.killWaitMs ?? 2_000, {
      capture: async (root) => {
        let snapshot: CommandResult;
        try {
          snapshot = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsTreeCaptureScript(root)], {
            timeoutMs: 5_000, maxOutputBytes: 128_000,
          });
        } catch { throw new Error("process_tree_snapshot_unverified: query failed"); }
        if (snapshot.code !== 0 || snapshot.stdoutTruncated || snapshot.stderr.length > 0) {
          throw new Error("process_tree_snapshot_unverified: query failed or incomplete");
        }
        return parseWindowsTreeCapture(snapshot.stdout, root);
      },
      probe: (requests) => probe.probe(requests),
      kill: async (root) => (await runCommand("taskkill", ["/PID", String(root), "/T", "/F"], { timeoutMs: 15_000 })).code,
    });
    return { pid, signal: "SIGKILL", verified: true };
  }
  signalProcessTree(pid, "SIGTERM");
  if (await waitForProcessTreeExit(pid, options.graceMs ?? 500)) {
    return { pid, signal: "SIGTERM", verified: true };
  }
  signalProcessTree(pid, "SIGKILL");
  if (!(await waitForProcessTreeExit(pid, options.killWaitMs ?? 2_000))) {
    throw new Error(`Process tree ${pid} did not exit after SIGKILL`);
  }
  return { pid, signal: "SIGKILL", verified: true };
};

interface CommandResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
}

/** Minimal shell-free runner (used for taskkill). Not for model invocation. */
function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: BoundedText = { value: "", truncated: false };
    let stderr: BoundedText = { value: "", truncated: false };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk, options.maxOutputBytes ?? 1_000_000);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, options.maxOutputBytes ?? 1_000_000);
    });
    let timedOut = false;
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch {
              // process already gone
            }
          }, options.timeoutMs)
        : null;
    timer?.unref();
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? null : code,
        signal: timedOut ? "SIGKILL" : signal,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
      });
    });
  });
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ESRCH") throw inner;
      }
    } else {
      throw error;
    }
  }
}

function isProcessTreeRunning(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return isProcessRunning(pid);
    throw error;
  }
}

async function waitForProcessTreeExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessTreeRunning(pid) && Date.now() < deadline) {
    await sleep(20);
  }
  return !isProcessTreeRunning(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
