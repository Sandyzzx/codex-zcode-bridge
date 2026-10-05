import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
  const token = randomUUID();
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
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(directory, "owner.json"), JSON.stringify(ownerRecord), { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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
      // An interrupted acquisition has no owner; allow time for publication.
      // Ownership is never taken by lock age alone (A2-07): an unreadable
      // owner stays blocking, and reclaim requires explicit exit evidence.
      try {
        if (Date.now() - statSync(directory).mtimeMs > 30_000) throw new Error(`unreadable lock owner: ${directory}`);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      }
    }
    return null;
  }
  return () => {
    const owner = JSON.parse(readFileSync(path.join(directory, "owner.json"), "utf8")) as { token?: string };
    if (owner.token !== token) throw new Error("process lock ownership changed");
    unlinkSync(path.join(directory, "owner.json"));
    rmdirSync(directory);
  };
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
    unlinkSync(path.join(retired, "owner.json"));
    rmdirSync(retired);
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
  finally { rmdirSync(guard); }
}
