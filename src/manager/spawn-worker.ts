import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createWorkerEnv } from "../runtime/child-env.js";
import { BRIDGE_WORKER_LAUNCH_MARKER, fingerprintRuntimeArtifact, type RuntimeBuildProvenance } from "../runtime/build-provenance.js";
import { validateHostProfile, type BridgeHostProfile } from "../host/profile.js";

export interface SpawnedWorker {
  readonly pid: number;
}

export type SpawnWorker = (dataRoot: string, taskId: string, attempt: number, writerLeaseToken?: string) => SpawnedWorker;

/** Test-only cross-process claim worker. It is never selected by startBridge(). */
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
 * isolated WP6B Claim-only harness. No Bootstrap value is placed in argv/env.
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
    // Match the production detached-worker process boundary while retaining
    // this test-only harness's direct ChildProcess handle and private pipes.
    detached: true,
    shell: false,
    stdio: options.interactionChannel
      ? ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"]
      : ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
    windowsHide: true,
    cwd: path.dirname(workerPath),
    env,
  }) as ClaimOnlyWorkerProcess;
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

export function createWorkerSpawner(host?: BridgeHostProfile, provenance?: RuntimeBuildProvenance, options: { writerQuiescence?: boolean } = {}): SpawnWorker {
  if (host) validateHostProfile(host);
  const runtimeProvenance = provenance ?? {
    bridge: fingerprintRuntimeArtifact(process.argv[1]),
    worker: fingerprintRuntimeArtifact(host?.workerEntryPath ?? workerEntryPath()),
  };
  return (dataRoot, taskId, attempt, writerLeaseToken) => {
  const attemptDir = path.join(dataRoot, ".tasks", taskId, "attempts", String(attempt));
  mkdirSync(attemptDir, { recursive: true });
  const stderrFd = openSync(path.join(attemptDir, "worker-stderr.log"), "a", 0o600);
  try {
    const workerEnv = {
      ...createWorkerEnv(process.env),
      ...(host ? { ZCODE_BRIDGE_HOST_PROFILE: JSON.stringify(host) } : {}),
      // Internal Bridge-to-Worker bootstrap metadata. It is deliberately not
      // part of createWorkerEnv's inherited allowlist, and the Worker uses
      // createMinimalOsEnv before spawning ZCode so this value is not exposed
      // to the app-server or its tools.
      ZCODE_BRIDGE_RUNTIME_PROVENANCE: JSON.stringify(runtimeProvenance),
      ...(options.writerQuiescence && writerLeaseToken ? { ZCODE_BRIDGE_JSON_WRITER_LEASE: writerLeaseToken } : {}),
      // DeepSeek Harness may host its MCP entrypoint inside Electron. Its
      // executable is reusable for detached Node workers only in this mode.
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };
    const child = spawn(process.execPath, [host?.workerEntryPath ?? workerEntryPath(), dataRoot, taskId, String(attempt), BRIDGE_WORKER_LAUNCH_MARKER], {
      detached: true,
      shell: false,
      stdio: ["ignore", "ignore", stderrFd],
      windowsHide: true,
      cwd: dataRoot,
      env: workerEnv,
    });
    child.on("error", (error) => console.error(`Bridge worker spawn failed: ${error.message}`));
    child.unref();
    if (typeof child.pid !== "number") {
      throw new Error("worker process did not provide a pid");
    }
    return { pid: child.pid };
  } finally {
    closeSync(stderrFd);
  }
  };
}

export const defaultSpawnWorker: SpawnWorker = createWorkerSpawner();
