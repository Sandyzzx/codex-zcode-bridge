import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** Cross-process exclusion. A live owner is never evicted by elapsed time. */
export async function withProcessLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  let release: (() => void) | null;
  while (!(release = tryAcquireProcessLock(directory))) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for process lock: ${directory}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { return await operation(); }
  finally { release(); }
}

/** Shared by short synchronous store transactions and asynchronous managers. */
export function tryAcquireProcessLock(directory: string): (() => void) | null {
  const token = randomUUID();
  try {
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
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
