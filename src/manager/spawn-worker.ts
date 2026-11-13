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
  readonly privateAuthRequestChannel: Readable | null;
  readonly privateAuthResponseChannel: Writable | null;
  readonly privateAuthAcknowledgementChannel: Readable | null;
  readonly privateAuthLifetimeChannel: Writable | null;
  readonly runtimeEventChannel: Readable | null;
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
  options: { readonly interactionChannel?: boolean; readonly dropAfterPrepared?: boolean; readonly privateAuthChannel?: boolean;
    readonly runtimeEventChannel?: boolean;
    /** Bounded private diagnostics: complete Worker stderr lines matching the
     * ADR-011 failure-facts marker are forwarded for validated handling;
     * every other byte stays discarded. */
    readonly onWorkerDiagnosticLine?: (line: string) => void } = {},
): ClaimOnlyWorkerProcess {
  if (!path.isAbsolute(workerPath)) throw new TypeError("claim-only worker path must be absolute");
  if (options.dropAfterPrepared && !options.interactionChannel) throw new TypeError("interaction channel is required for drop-after-prepared");
  if (options.privateAuthChannel && !options.interactionChannel) throw new TypeError("private auth requires interaction channel allocation");
  if (options.runtimeEventChannel && !options.interactionChannel) throw new TypeError("runtime events require interaction channel allocation");
  const env = {
    ...createWorkerEnv(process.env),
    ZCODE_BRIDGE_RUNTIME_PROVENANCE: JSON.stringify(provenance),
  };
  const args = [workerPath, ...(options.interactionChannel ? ["--bridge-sqlite-interaction-v1"] : []),
    ...(options.privateAuthChannel ? ["--bridge-sqlite-private-auth-v1"] : []),
    ...(options.runtimeEventChannel ? ["--bridge-sqlite-runtime-events-v1"] : []),
    ...(options.dropAfterPrepared ? ["--bridge-sqlite-interaction-drop-after-prepared-v1"] : []),
    BRIDGE_WORKER_LAUNCH_MARKER];
  const stdioLength = options.runtimeEventChannel
    ? 15
    : options.privateAuthChannel
      ? 14
      : options.interactionChannel
        ? 10
        : 7;
  const stdio = Array<"ignore" | "pipe">(stdioLength).fill("ignore");
  for (let fd = 2; fd <= 6; fd += 1) stdio[fd] = "pipe";
  if (options.interactionChannel) for (let fd = 7; fd <= 9; fd += 1) stdio[fd] = "pipe";
  if (options.privateAuthChannel) for (let fd = 10; fd <= 13; fd += 1) stdio[fd] = "pipe";
  if (options.runtimeEventChannel) stdio[14] = "pipe";
  const child = spawn(process.execPath, args, {
    detached: true,
    shell: false,
    stdio,
    windowsHide: true,
    cwd: path.dirname(workerPath),
    env,
  }) as ClaimOnlyWorkerProcess;
  // Workers synchronously write diagnostics to fd 2. Always drain it, including
  // when no diagnostic observer is installed, so a full OS pipe cannot block
  // the Worker before Result/exit. Observers may still subscribe to data;
  // unobserved bytes are discarded without accumulating logs in memory.
  const diagnosticSink = options.onWorkerDiagnosticLine;
  if (diagnosticSink) {
    child.stderr?.setEncoding("utf8");
    let pending = "";
    child.stderr?.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 65_536) {
        // Oversized garbage is dropped, never queued: diagnostics cannot
        // block or grow unbounded ahead of Result/exit.
        pending = pending.slice(pending.lastIndexOf("\n") + 1);
        return;
      }
      for (;;) {
        const index = pending.indexOf("\n");
        if (index < 0) break;
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        if (line.startsWith("[bridge-worker] failure-facts ")) diagnosticSink(line);
      }
    });
  } else {
    child.stderr?.resume();
  }
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
    privateAuthRequestChannel: { enumerable: false, get: () => pipes[10] as Readable | null },
    privateAuthResponseChannel: { enumerable: false, get: () => pipes[11] as Writable | null },
    privateAuthAcknowledgementChannel: { enumerable: false, get: () => pipes[12] as Readable | null },
    privateAuthLifetimeChannel: { enumerable: false, get: () => pipes[13] as Writable | null },
    runtimeEventChannel: { enumerable: false, get: () => pipes[14] as Readable | null },
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
