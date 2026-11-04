import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { TaskAttentionSnapshot } from "../interfaces.js";
import { assertSupportedNodeRuntime } from "../runtime/node-runtime.js";
import { parseTaskAttentionSnapshot } from "./snapshot.js";

type RecoveryAttentionStore = {
  readTaskAttention(taskId: string): Readonly<Record<string, unknown>> | null;
  close(): void;
};

type RecoveryStoreModule = {
  readonly IsolatedAdmissionStore: {
    openForRecovery(root: string, options?: Readonly<Record<string, unknown>>): RecoveryAttentionStore | undefined;
  };
};

export interface ReadOnlyAttentionSource {
  read(taskId: string): TaskAttentionSnapshot | null;
  close(): void;
}

export interface OpenReadOnlyAttentionOptions {
  readonly dataRoot: string;
  readonly databaseFileName?: string;
  readonly loadModule?: () => Promise<RecoveryStoreModule>;
}

/**
 * Open the existing SQLite store in its dedicated read-only recovery mode.
 * This entry point never initializes, migrates, repairs, or falls back to JSON.
 */
export async function openReadOnlyAttention(options: OpenReadOnlyAttentionOptions): Promise<ReadOnlyAttentionSource> {
  assertSupportedNodeRuntime();
  const root = requirePlainDirectory(options.dataRoot);
  const load = options.loadModule ?? (() => import("../sqlite-candidate/wp6b2b1/store.mjs") as Promise<RecoveryStoreModule>);
  const module = await load();
  const databaseFileName = options.databaseFileName ?? "bridge.sqlite";
  const store = module.IsolatedAdmissionStore.openForRecovery(root, {
    databaseFileName,
    managedDataDirectory: true,
  });
  if (!store) throw new Error("read-only SQLite Attention Store was not opened");
  let closed = false;
  return {
    read(taskId: string): TaskAttentionSnapshot | null {
      if (closed) throw new Error("read-only SQLite Attention Store is closed");
      const value = store.readTaskAttention(taskId);
      return value === null ? null : parseTaskAttentionSnapshot(value, taskId);
    },
    close(): void {
      if (closed) return;
      closed = true;
      store.close();
    },
  };
}

function requirePlainDirectory(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("SQLite data directory must be an absolute path");
  const stat = lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("SQLite data directory must be a plain directory");
  const resolved = realpathSync.native(value);
  if (!samePath(value, resolved)) throw new Error("SQLite data directory must not be redirected");
  return resolved;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32"
    ? path.win32.normalize(value).replace(/[\\/]+$/u, "").toLocaleLowerCase("en-US")
    : path.resolve(value);
  return normalize(left) === normalize(right);
}
