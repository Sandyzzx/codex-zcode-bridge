import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createWorkerEnv } from "../runtime/child-env.js";
import { BRIDGE_WORKER_LAUNCH_MARKER, type RuntimeBuildProvenance } from "../runtime/build-provenance.js";

/** SQLite production Worker with private lifecycle channels. */
export interface ClaimOnlyWorkerProcess extends ChildProcess {
  readonly bootstrapChannel: Writable | null;
  readonly reportChannel: Readable | null;
  readonly decisionChannel: Writable | null;
  readonly resultChannel: Readable | null;
  readonly interactionRequestChannel: Readable | null;
  readonly interactionReplyChannel: Writable | null;
  readonly interactionAcknowledgementChannel: Readable | null;
  readonly exitSeen: boolean;
}

export type SqliteWorkerAdapterMode = "zcode_app_server" | "test_fake";

/**
 * Launch the existing Worker entry with private one-shot control pipes for the
 * SQLite lifecycle driver. No Bootstrap value is placed in argv/env.
 */
export function spawnClaimOnlyWorker(
  workerPath: string,
  provenance: RuntimeBuildProvenance,
  options: { readonly interactionChannel?: boolean; readonly dropAfterPrepared?: boolean } = {},
): ClaimOnlyWorkerProcess {
  if (!path.isAbsolute(workerPath)) throw new TypeError("claim-only worker path must be absolute");
  if (options.dropAfterPrepared && !options.interactionChannel) throw new TypeError("interaction channel is required for drop-after-prepared");
  const env = {
    ...createWorkerEnv(process.env),
    ZCODE_BRIDGE_RUNTIME_PROVENANCE: JSON.stringify(provenance),
  };
  const args = [workerPath, ...(options.interactionChannel ? ["--bridge-sqlite-interaction-v1"] : []),
    ...(options.dropAfterPrepared ? ["--bridge-sqlite-interaction-drop-after-prepared-v1"] : []), BRIDGE_WORKER_LAUNCH_MARKER];
  const child = spawn(process.execPath, args, {
    detached: true,
    shell: false,
    stdio: options.interactionChannel
      ? ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
      : ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
    cwd: path.dirname(workerPath),
    env,
  }) as ClaimOnlyWorkerProcess;
  // Workers synchronously write diagnostics to fd 2. Always drain it, including
  // when no diagnostic observer is installed, so a full OS pipe cannot block
  // the Worker before Result/exit. Observers may still subscribe to data;
  // unobserved bytes are discarded without accumulating logs in memory.
  child.stderr?.resume();
  const pipes = child.stdio as unknown as readonly (Readable | Writable | null)[];
  let exitSeen = false;
  Object.defineProperties(child, {
    bootstrapChannel: { enumerable: false, get: () => pipes[3] as Writable | null },
    reportChannel: { enumerable: false, get: () => pipes[4] as Readable | null },
    decisionChannel: { enumerable: false, get: () => pipes[5] as Writable | null },
    resultChannel: { enumerable: false, get: () => pipes[6] as Readable | null },
    interactionRequestChannel: { enumerable: false, get: () => pipes[7] as Readable | null },
    interactionReplyChannel: { enumerable: false, get: () => pipes[8] as Writable | null },
    interactionAcknowledgementChannel: { enumerable: false, get: () => pipes[9] as Readable | null },
    exitSeen: { enumerable: false, get: () => exitSeen },
  });
  child.once("exit", () => { exitSeen = true; });
  return child;
}

export function workerEntryPath(): string {
  if (process.env["ZCODE_BRIDGE_PLUGIN_MODE"] === "1") {
    return fileURLToPath(new URL("../worker/worker-main.mjs", import.meta.url));
  }
  return fileURLToPath(new URL("../worker/worker-main.js", import.meta.url));
}
