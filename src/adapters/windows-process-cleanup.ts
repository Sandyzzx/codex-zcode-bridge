import { performance } from "node:perf_hooks";
import type { ProbeRequest, ProbeVerdict } from "../runtime/process-probe.js";

export interface WindowsCleanupDependencies {
  capture: (pid: number) => Promise<readonly ProbeRequest[]>;
  probe: (requests: readonly ProbeRequest[]) => Promise<readonly ProbeVerdict[]>;
  kill: (pid: number) => Promise<number | null>;
}

/** Verify recorded executors, not taskkill's localized output or the root alone. */
export async function terminateWindowsProcessTree(
  pid: number,
  killWaitMs: number,
  dependencies: WindowsCleanupDependencies,
): Promise<void> {
  const requests = await dependencies.capture(pid);
  if (!requests.some((request) => request.pid === pid)) throw new Error("process_tree_snapshot_invalid: root missing");
  const inspect = async (): Promise<readonly ProbeVerdict[]> => {
    const verdicts = await dependencies.probe(requests);
    if (verdicts.length !== requests.length || verdicts.some((verdict) => verdict.state === "unknown")) {
      throw new Error("process_tree_probe_unverified: recorded executor exit is unknown");
    }
    return verdicts;
  };
  const before = await inspect();
  if (before.every((verdict) => verdict.state === "exited")) return;
  const rootIndex = requests.findIndex((request) => request.pid === pid);
  if (before[rootIndex]?.state !== "alive") {
    // Never signal a recycled root PID. Its remaining children need review.
    throw new Error("process_tree_descendants_alive: root exited before termination");
  }
  let exitCode: number | null = null;
  let commandFailed = false;
  try { exitCode = await dependencies.kill(pid); }
  catch { commandFailed = true; }
  const deadline = performance.now() + Math.max(0, killWaitMs);
  for (;;) {
    const after = await inspect();
    if (after.every((verdict) => verdict.state === "exited")) return;
    if (performance.now() >= deadline) {
      const reason = commandFailed ? "command_error" : exitCode === null ? "timeout" : `exit_${exitCode}`;
      throw new Error(`process_tree_cleanup_unverified: taskkill ${reason}; recorded executors remain alive`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** ASCII-only protocol; locale-dependent stderr never becomes a public error. */
export function windowsTreeCaptureScript(pid: number): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
    `$selected = [System.Collections.Generic.HashSet[int]]::new(); [void]$selected.Add(${pid})`,
    "do { $changed = $false; foreach ($item in $all) { if ($selected.Contains([int]$item.ParentProcessId)) { if ($selected.Add([int]$item.ProcessId)) { $changed = $true } } } } while ($changed)",
    "'bridge_tree_snapshot_v1'",
    "foreach ($candidate in $selected) { $item = Get-Process -Id $candidate -ErrorAction SilentlyContinue; if ($null -eq $item) { '{0}|absent' -f $candidate } else { '{0}|{1}' -f $candidate, $item.StartTime.Ticks } }",
  ].join("; ");
}

export function parseWindowsTreeCapture(stdout: string, pid: number): ProbeRequest[] {
  const lines = stdout.trim().split(/\r?\n/u);
  if (lines.shift() !== "bridge_tree_snapshot_v1") throw new Error("process_tree_snapshot_invalid: protocol missing");
  const capturedAt = new Date().toISOString();
  const requests: ProbeRequest[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    const match = /^(\d+)\|(\d+|absent)$/u.exec(line.trim());
    const candidate = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(candidate) || candidate <= 0 || seen.has(candidate)) {
      throw new Error("process_tree_snapshot_invalid: malformed identity");
    }
    seen.add(candidate);
    requests.push({ pid: candidate, identity: match[2] === "absent" ? null : {
      pid: candidate, fingerprint: match[2]!, fingerprint_precision: "exact", identity_version: 1,
      platform: "win32", captured_at: capturedAt,
    } });
  }
  if (!seen.has(pid)) throw new Error("process_tree_snapshot_invalid: root missing");
  return requests;
}
