// A2 narrow process-identity interface. OS-level capability verified on
// Windows 10 (2026-10-04): PowerShell `Get-Process -Id a,b,c` exposes
// `StartTime.Ticks` (.NET FileTime, 100ns creation fingerprint) in ~350ms for
// a batch query; absent PIDs are skipped silently (non-terminating error) so
// a missing PID in the output is conclusive exit evidence. The probe never
// treats query failures as death: permission errors, timeouts, and unparsable
// output all return unknown.
//
// Identity semantics: same PID + same startup fingerprint is the same executor
// alive; PID absent or fingerprint changed means the previous executor exited
// (the PID was reused or released). This is not authentication against a
// malicious same-user process.
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ExecutorState } from "../observation/types.js";

export const PROCESS_IDENTITY_VERSION = 1 as const;

export type FingerprintPrecision = "exact" | "coarse" | "unknown";

export interface ProcessIdentity {
  readonly pid: number;
  readonly fingerprint: string | null;
  readonly fingerprint_precision: FingerprintPrecision;
  readonly identity_version: typeof PROCESS_IDENTITY_VERSION;
  readonly platform: string;
  readonly captured_at: string;
}

export interface ProbeVerdict {
  readonly state: ExecutorState;
  readonly reason_code: string;
  readonly observed_at: string;
}

export interface ProbeRequest {
  readonly pid: number;
  /** Persisted identity of the executor that was expected to own this PID. */
  readonly identity: ProcessIdentity | null;
}

export interface ProcessProbe {
  readonly platform: NodeJS.Platform;
  identityOf(pid: number): Promise<ProcessIdentity>;
  selfIdentity(): Promise<ProcessIdentity>;
  /** Batch probe; results are order-preserving. One failure marks that request unknown, not dead. */
  probe(requests: readonly ProbeRequest[]): Promise<ProbeVerdict[]>;
}

export interface PlatformProbeOptions {
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly now?: () => number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONCURRENT = 2;

export function identityFormatVersion(): typeof PROCESS_IDENTITY_VERSION {
  return PROCESS_IDENTITY_VERSION;
}

function identityOfFingerprint(pid: number, fingerprint: string | null, precision: FingerprintPrecision, now: () => number): ProcessIdentity {
  return {
    pid,
    fingerprint,
    fingerprint_precision: precision,
    identity_version: PROCESS_IDENTITY_VERSION,
    platform: process.platform,
    captured_at: new Date(now()).toISOString(),
  };
}

function verdict(state: ExecutorState, reason: string, now: () => number): ProbeVerdict {
  return { state, reason_code: reason, observed_at: new Date(now()).toISOString() };
}

/** Outcome of one OS fingerprint query. `ok=false` means the query itself
 * failed (spawn error, timeout, unparsable output): callers must answer
 * unknown, never exited. */
interface FingerprintQuery {
  readonly ok: boolean;
  readonly reason: string;
  readonly fingerprints: Map<number, string>;
}

function failedQuery(reason: string): FingerprintQuery {
  return { ok: false, reason, fingerprints: new Map() };
}

/** Batch Windows probe: one hidden PowerShell call, structured `pid|ticks` lines, bounded timeout. */
function windowsBatchQuery(pids: number[], timeoutMs: number): Promise<FingerprintQuery> {
  return new Promise((resolve) => {
    const script = `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "{0}|{1}" -f $_.Id, $_.StartTime.Ticks }`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let settled = false;
    const finish = (query: FingerprintQuery): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(query);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(failedQuery("timeout"));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // Bounded captures; stderr content is never surfaced (only its existence).
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: string) => { stderrBytes = Math.min(64_000, stderrBytes + chunk.length); });
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.on("error", () => finish(failedQuery("spawn_error")));
    child.on("close", () => {
      const map = new Map<number, string>();
      for (const line of stdout.split(/\r?\n/u)) {
        const match = /^(\d+)\|(\d+)$/u.exec(line.trim());
        if (!match) continue;
        map.set(Number(match[1]), match[2]!);
      }
      // Rows for missing PIDs are conclusive (Get-Process skips exited PIDs
      // and exits non-zero), so any parsed row means the query ran. With no
      // rows at all we cannot tell "all exited" from "broken query" unless
      // stdout was well-formed but empty, which Get-Process guarantees only
      // when the query executed: treat empty stdout + empty stderr as an
      // executed query with zero matches.
      if (map.size === 0) {
        finish(stderrBytes > 0 ? failedQuery("query_error") : { ok: true, reason: "ok", fingerprints: map });
        return;
      }
      finish({ ok: true, reason: "ok", fingerprints: map });
    });
  });
}

async function darwinQuery(pids: number[], timeoutMs: number): Promise<FingerprintQuery> {
  // `lstart` is second-precision: coarse by definition. macOS sampling
  // precision is disclosed, never claimed as an absolute unique identity.
  return new Promise((resolve) => {
    const child = spawn("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(failedQuery("timeout"));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < 1_000_000) stdout += chunk; });
    child.on("error", () => { if (!settled) { settled = true; clearTimeout(timer); resolve(failedQuery("spawn_error")); } });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const map = new Map<number, string>();
      for (const line of stdout.split(/\r?\n/u)) {
        const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
        if (match) map.set(Number(match[1]), match[2]!.trim());
      }
      // ps exits 0 even when a requested PID is missing; rows found mean the
      // query ran. A completely empty result is ambiguous only when ps itself
      // failed, which the error event already covers; treat empty as executed.
      resolve({ ok: true, reason: "ok", fingerprints: map });
    });
  });
}

export function createPlatformProbe(options: PlatformProbeOptions = {}): ProcessProbe {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const now = options.now ?? Date.now;
  let chain: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  let waiters: Array<() => void> = [];

  // Simple bounded-concurrency gate so recovery scans cannot storm the OS.
  const schedule = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (inFlight >= maxConcurrent) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    inFlight += 1;
    try {
      return await operation();
    } finally {
      inFlight -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  };

  const probe = async (requests: readonly ProbeRequest[]): Promise<ProbeVerdict[]> => {
    if (requests.length === 0) return [];
    const distinct = [...new Set(requests.map((request) => request.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];
    const query = await schedule(async () => {
      if (process.platform === "win32") return windowsBatchQuery(distinct, timeoutMs);
      if (process.platform === "darwin") return darwinQuery(distinct, timeoutMs);
      if (process.platform === "linux") {
        const map = new Map<number, string>();
        for (const pid of distinct) {
          try {
            const stat = await readFile(`/proc/${pid}/stat`, "utf8");
            // Field 22 (1-based) is starttime; the comm field may contain
            // spaces, so parse after the last ')'.
            const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
            const fields = afterComm.split(" ");
            const starttime = fields[19];
            if (starttime) map.set(pid, starttime.trim());
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // PID absent: conclusive below.
            return failedQuery("proc_read_error");
          }
        }
        return { ok: true, reason: "ok", fingerprints: map };
      }
      return failedQuery("unsupported_platform");
    });

    return requests.map((request) => {
      if (!Number.isInteger(request.pid) || request.pid <= 0) return verdict("unknown", "invalid_pid", now);
      if (!query.ok) return verdict("unknown", `query_${query.reason}`, now);
      const fingerprint = query.fingerprints.get(request.pid);
      if (fingerprint === undefined) {
        // The PID does not exist right now: conclusive exit of whatever the
        // identity described (the identity owner cannot come back).
        return verdict("exited", "pid_absent", now);
      }
      if (!request.identity || request.identity.fingerprint === null) {
        // A live process occupies the PID, but we cannot compare startup
        // fingerprints. Never claim alive for the old executor.
        return verdict("unknown", "live_pid_no_fingerprint", now);
      }
      if (request.identity.fingerprint_precision === "coarse") {
        // Coarse fingerprints can collide across process generations; only a
        // mismatch is conclusive (reuse), a match stays unknown.
        return request.identity.fingerprint === fingerprint
          ? verdict("unknown", "coarse_fingerprint_match", now)
          : verdict("exited", "pid_reused_coarse", now);
      }
      if (request.identity.fingerprint !== fingerprint) {
        return verdict("exited", "pid_reused", now);
      }
      return verdict("alive", "pid_and_fingerprint_match", now);
    });
  };

  const fingerprintOfPid = async (pid: number): Promise<ProcessIdentity> => {
    const query = await schedule(async () => {
      if (process.platform === "win32") return windowsBatchQuery([pid], timeoutMs);
      if (process.platform === "darwin") return darwinQuery([pid], timeoutMs);
      if (process.platform === "linux") {
        const map = new Map<number, string>();
        try {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
          const starttime = afterComm.split(" ")[19];
          if (starttime) map.set(pid, starttime.trim());
        } catch { /* absent */ }
        return { ok: true, reason: "ok", fingerprints: map };
      }
      return failedQuery("unsupported_platform");
    });
    const fingerprint = query.fingerprints.get(pid);
    if (!query.ok || !fingerprint) return identityOfFingerprint(pid, null, "unknown", now);
    const precision: FingerprintPrecision = process.platform === "darwin" ? "coarse" : "exact";
    return identityOfFingerprint(pid, fingerprint, precision, now);
  };

  return {
    platform: process.platform,
    identityOf: fingerprintOfPid,
    selfIdentity: () => fingerprintOfPid(process.pid),
    probe,
  };
}

/** Fall-back verdict derived from a plain kill(pid,0) liveness check (no identity).
 * kill0-alive counts as alive with weaker evidence — recovery keeps the task
 * occupied and cancel may terminate it, exactly as the legacy contract did.
 * Only PID-absence (kill0 ESRCH) is conclusive exit evidence here. */
export function livenessVerdict(pid: number | null, isAlive: (pid: number) => boolean, now: () => number): ProbeVerdict {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return verdict("unknown", "no_pid_recorded", now);
  return isAlive(pid) ? verdict("alive", "kill0_alive_no_identity", now) : verdict("exited", "kill0_pid_absent", now);
}
