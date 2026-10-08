import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ProcessIdentity } from "../runtime/process-probe.js";

/** Best-effort self identity published with lock ownership. Initialized
 * asynchronously at startup; until then locks are written with a null
 * fingerprint, which stays readable for old records and never auto-binds a
 * recycled PID to the previous owner (A2). */
let selfIdentity: ProcessIdentity | null = null;

export function publishSelfIdentity(identity: ProcessIdentity): void {
  selfIdentity = identity;
}

export function currentSelfIdentity(): ProcessIdentity | null {
  return selfIdentity;
}

/** Cross-process exclusion. A live owner is never evicted by elapsed time. */
export async function withProcessLock<T>(directory: string, operation: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let release: (() => void) | null;
  while (!(release = tryAcquireProcessLock(directory))) {
    if (Date.now() >= deadline) {
      const owner = describeLockOwner(directory);
      throw new Error(`timed out waiting for process lock: ${directory}${owner ? ` (live owner: ${owner})` : ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { return await operation(); }
  finally { release(); }
}

function describeLockOwner(directory: string): string | null {
  try {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")) as { pid?: number; started_at?: string };
    if (!Number.isSafeInteger(owner.pid)) return null;
    return `pid ${String(owner.pid)}${owner.started_at ? `, started ${owner.started_at}` : ""}`;
  } catch {
    return null;
  }
}

/** Shared by short synchronous store transactions and asynchronous managers. */
export function tryAcquireProcessLock(directory: string): (() => void) | null {
  return tryAcquireProcessLockWithRetry(directory, 0);
}

function tryAcquireProcessLockWithRetry(directory: string, retries: number): (() => void) | null {
  const token = randomUUID();
  // Publish only a complete owner record. If the process exits during the
  // write, its private staging directory is harmless and the shared lock
  // path remains absent. Directory rename is the single publication point.
  const staging = `${directory}.${process.pid}.${token}.pending`;
  const ownerRecord = {
    pid: process.pid,
    token,
    started_at: new Date().toISOString(),
    // Fingerprint may be null before the async self-identity probe finishes;
    // null never authorizes binding a recycled PID to a prior owner.
    identity: selfIdentity
      ? { fingerprint: selfIdentity.fingerprint, identity_version: selfIdentity.identity_version, platform: selfIdentity.platform }
      : null,
  };
  try {
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(path.join(staging, "owner.json"), JSON.stringify(ownerRecord), { mode: 0o600, flag: "wx" });
    try {
      renameSync(staging, directory);
    } catch (error) {
      removeStagedLock(staging);
      // Windows may report EEXIST or a directory-specific error when another
      // process wins the publication race. Only inspect it if the destination
      // actually exists. If a competing owner released between the failed
      // rename and this check, retry the publication a few times rather than
      // surfacing a transient EPERM/EEXIST as a failed store transaction.
      if (!existsSync(directory)) {
        const code = (error as NodeJS.ErrnoException).code;
        if (retries < 3 && (code === "EEXIST" || code === "EPERM" || code === "EACCES")) {
          return tryAcquireProcessLockWithRetry(directory, retries + 1);
        }
        throw error;
      }
      return acquireExistingLock(directory);
    }
  } catch (error) {
    removeStagedLock(staging);
    throw error;
  }
  return () => {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")) as { token?: string };
    if (owner.token !== token) throw new Error("process lock ownership changed");
    // Withdraw the complete owner atomically before deleting anything. A
    // crash during private cleanup must not leave an unreadable shared lock.
    const retired = `${directory}.${token}.retired`;
    renameSync(directory, retired);
    removeStagedLock(retired);
  };
}

function acquireExistingLock(directory: string): (() => void) | null {
  try {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")) as { pid: number };
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("invalid lock owner");
    try { process.kill(owner.pid, 0); }
    catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ESRCH") {
        if (reclaimDeadOwner(directory)) return tryAcquireProcessLock(directory);
      }
    }
  } catch {
    // Never reclaim an unreadable legacy lock by age. It needs explicit
    // diagnosis; new acquisitions cannot create this state after staged publish.
    try {
      if (Date.now() - statSync(directory).mtimeMs > 30_000) throw new Error(`unreadable lock owner: ${directory}`);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
    }
  }
  return null;
}

function removeStagedLock(directory: string): void {
  try { unlinkSync(path.join(directory, "owner.json")); } catch { /* staging may not have reached the write */ }
  try { rmdirSync(directory); } catch { /* preserve the original acquisition error */ }
}

function reclaimDeadOwner(directory: string): boolean {
  const guard = `${directory}.reclaim`;
  try { mkdirSync(guard); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  try {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")) as { pid: number };
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    const retired = `${directory}.${randomUUID()}.retired`;
    renameSync(directory, retired);
    removeStagedLock(retired);
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
  finally { rmdirSync(guard); }
}
