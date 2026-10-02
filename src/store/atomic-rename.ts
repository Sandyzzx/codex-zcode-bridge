import { renameSync } from "node:fs";
import { rename } from "node:fs/promises";

function retryable(error: unknown, deadline: number): boolean {
  return process.platform === "win32" && Date.now() < deadline && ["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/** Windows readers/scanners can briefly prevent replacing an existing file. */
export function atomicRenameSync(source: string, target: string): void {
  const deadline = Date.now() + 2_000;
  while (true) {
    try { renameSync(source, target); return; }
    catch (error) {
      if (!retryable(error, deadline)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

export async function atomicRename(source: string, target: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try { await rename(source, target); return; }
    catch (error) {
      if (!retryable(error, deadline)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
