// stdio entry point for the Bridge MCP server (ARCHITECTURE component 1).
//
// Startup never resolves the ZCode provider configuration, so a missing or
// broken ZCode setup cannot prevent the server from starting; such problems
// surface per task through the existing failure flow. All protocol traffic
// goes to stdout via the SDK's serveStdio transport; every log line here is
// written to stderr. A connected Host keeps the transport available until
// lifecycle shutdown verifies Cleanup; stdin EOF is handled separately.
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import path from "node:path";
import { findPackageRoot, loadPersistedRuntimeEnvironment } from "../runtime/resolver.js";
import type { SqliteLifecycleMcpAuthority } from "../manager/sqlite-lifecycle-mcp-authority.js";
import { createBridgeServer } from "../mcp/server.js";
import { DEFAULT_TASK_TIMEOUT_MS, validateTaskTimeout } from "../runtime/task-timeout.js";
import type { DoctorReport } from "../runtime/doctor.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "./profile.js";
import { workerEntryPath } from "../manager/spawn-worker.js";
import { createPlatformProbe } from "../runtime/process-probe.js";
import { fingerprintRuntimeArtifact } from "../runtime/build-provenance.js";
import { createTrustedLocalStdioContext } from "../runtime/trusted-local-deployment.js";
import { SERVER_VERSION } from "../mcp/server.js";
import {
  loadInstallAuthoritySelection,
  prepareFreshSqliteStateDirectory,
  FRESH_SQLITE_DATABASE_FILE,
} from "../runtime/sqlite-install-config.js";
import {
  acquireExecutorLease,
  assertExecutorLeaseTransition,
  EXECUTOR_UNLEASED_TRANSITION_ENV,
  type ExecutorLeaseHandle,
} from "../executor/lease.js";
import { LeaseGuardedTaskManager } from "../executor/lease-guarded-task-manager.js";
import { ExecutorControlClient } from "../executor/control-client.js";
import { RemoteTaskManager } from "../executor/remote-task-manager.js";
import { RemoteModelSettings } from "../executor/remote-model-settings.js";
import { executorPipeName } from "../executor/service.js";
import {
  createProductionAuthorityComposition,
} from "./production-composition.js";

export {
  createHostStartPlanIssuer,
  formatWorkerFailureFactsLine,
  type HostStartPlanIssuerOptions,
} from "./production-composition.js";

export interface DataRootResolution {
  readonly dataRoot: string;
  readonly warning?: string;
}

/** Internal capability factory used only by the local stdio Host composition. */
export function createTrustedLocalCandidateContext(host: BridgeHostProfile) {
  validateHostProfile(host);
  return createTrustedLocalStdioContext(host);
}

/** Frozen rule: use a valid ZCODE_BRIDGE_DATA_DIR, else the Bridge install dir. */
export function resolveDataRoot(env: NodeJS.ProcessEnv): DataRootResolution {
  const override = env["ZCODE_BRIDGE_DATA_DIR"]?.trim();
  if (override) {
    if (!path.isAbsolute(override)) {
      return {
        dataRoot: findPackageRoot(),
        warning: `ZCODE_BRIDGE_DATA_DIR must be an absolute path; ignoring ${override} and using the Bridge installation directory`,
      };
    }
    return { dataRoot: path.normalize(override) };
  }
  return { dataRoot: findPackageRoot() };
}

export interface WorkerLimitResolution {
  readonly maxConcurrentWorkers: number;
  readonly warning?: string;
}

/** Defaults to eight concurrent workers; invalid values fail safely back to one worker. */
export function resolveMaxConcurrentWorkers(env: NodeJS.ProcessEnv): WorkerLimitResolution {
  const raw = env["ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS"]?.trim();
  if (!raw) return { maxConcurrentWorkers: 8 };
  if (!/^[1-8]$/u.test(raw)) {
    return {
      maxConcurrentWorkers: 1,
      warning: "ZCODE_BRIDGE_MAX_CONCURRENT_WORKERS must be an integer from 1 to 8; using 1",
    };
  }
  return { maxConcurrentWorkers: Number(raw) };
}

export interface StdioLifecycleHost {
  /** Begin or retry graceful shutdown. False means the connected Host remains available. */
  shutdown(reason: string): Promise<boolean>;
}

/**
 * Serves one MCP stdio connection and coordinates its Manager shutdown.
 * Signals drain the Manager before closing the transport. If Cleanup is
 * unknown, the Manager keeps its Root and the still-connected client can
 * inspect state, finish a live Worker, or issue a bounded Cancel retry.
 * stdin EOF is different: the SDK closes the disconnected wire and this
 * function makes the same bounded shutdown attempt without promising a query
 * channel afterward.
 */
export function serveStdioLifecycleHost(
  server: ReturnType<typeof createBridgeServer>,
  manager: Pick<SqliteLifecycleMcpAuthority, "shutdown">,
  options: {
    readonly stdin?: Readable;
    readonly stdout?: Writable;
    readonly onShutdownFailure?: (reason: string, error: unknown) => void;
    readonly onShutdownComplete?: (reason: string) => void;
  } = {},
): StdioLifecycleHost {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);
  let handle: StdioServerHandle;
  let closed = false;
  let disconnected = false;
  let current: Promise<boolean> | null = null;
  let shutdown!: (reason: string) => Promise<boolean>;

  const onDisconnect = (): void => {
    if (disconnected) return;
    disconnected = true;
    void shutdown("EOF");
  };
  // Register before the SDK starts the transport so EOF fences the Manager
  // before the SDK's own listener closes the stdio wire.
  stdin.once("end", onDisconnect);
  stdin.once("close", onDisconnect);

  shutdown = (reason: string): Promise<boolean> => {
    if (closed) return Promise.resolve(true);
    if (current) return current;
    let attempt!: Promise<boolean>;
    attempt = (async () => {
      try {
        await manager.shutdown();
        if (!disconnected) await handle.close();
        closed = true;
        options.onShutdownComplete?.(reason);
        return true;
      } catch (error) {
        options.onShutdownFailure?.(reason, error);
        return false;
      } finally {
        if (current === attempt) current = null;
      }
    })();
    current = attempt;
    return attempt;
  };

  handle = serveStdio(() => server, { transport });
  // StdioServerTransport schedules close for a stream that was already ended
  // before listeners were attached. Mirror that case for Manager shutdown.
  if (stdin.readableEnded || stdin.destroyed) queueMicrotask(onDisconnect);
  return { shutdown };
}

/**
 * Thin MCP lifecycle: closing stdio only disconnects the control client. The
 * Executor and every accepted Task remain owned by their lifetime lease.
 */
export function serveStdioThinHost(
  server: ReturnType<typeof createBridgeServer>,
  client: ExecutorControlClient,
  options: {
    readonly stdin?: Readable;
    readonly stdout?: Writable;
    readonly onShutdownFailure?: (reason: string, error: unknown) => void;
    readonly onShutdownComplete?: (reason: string) => void;
  } = {},
): StdioLifecycleHost {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const transport = new StdioServerTransport(stdin, stdout);
  let handle: StdioServerHandle;
  let closed = false;
  let current: Promise<boolean> | null = null;
  let shutdown!: (reason: string) => Promise<boolean>;
  const disconnect = (): void => {
    if (closed) return;
    closed = true;
    client.close();
  };
  stdin.once("end", disconnect);
  stdin.once("close", disconnect);

  shutdown = (reason: string): Promise<boolean> => {
    if (closed) return Promise.resolve(true);
    if (current) return current;
    let attempt!: Promise<boolean>;
    attempt = (async () => {
      try {
        await handle.close();
        disconnect();
        options.onShutdownComplete?.(reason);
        return true;
      } catch (error) {
        options.onShutdownFailure?.(reason, error);
        return false;
      } finally {
        if (current === attempt) current = null;
      }
    })();
    current = attempt;
    return attempt;
  };

  handle = serveStdio(() => server, { transport });
  if (stdin.readableEnded || stdin.destroyed) queueMicrotask(disconnect);
  return { shutdown };
}

export function resolveMcpTransport(env: NodeJS.ProcessEnv): "in_process" | "control" {
  const raw = env["ZCODE_BRIDGE_MCP_TRANSPORT"]?.trim().toLowerCase() ?? "in_process";
  if (raw === "in_process" || raw === "control") return raw;
  throw new Error("ZCODE_BRIDGE_MCP_TRANSPORT must be in_process or control");
}

async function startThinBridge(
  host: BridgeHostProfile,
  version: string,
): Promise<void> {
  validateHostProfile(host);
  const authoritySelection = loadInstallAuthoritySelection(host);
  const prepared = prepareFreshSqliteStateDirectory(authoritySelection, process.env);
  const dataRoot = prepared.dataRoot;
  const client = new ExecutorControlClient({ pipeName: executorPipeName(dataRoot) });
  const taskManager = new RemoteTaskManager(client);
  const modelSettings = new RemoteModelSettings(client);
  const doctor = async (): Promise<DoctorReport> => {
    await client.connect();
    const response = await client.request("doctor", {});
    if (!response.ok) {
      const error = new Error(response.error?.message ?? "EXECUTOR_REQUEST_FAILED") as Error & { code?: string };
      error.code = response.error?.code ?? "EXECUTOR_REQUEST_FAILED";
      throw error;
    }
    return response.result as unknown as DoctorReport;
  };
  const server = createBridgeServer({
    taskManager,
    doctor,
    modelSettings,
    serverInfo: { name: host.name, version },
    instructions: host.instructions,
  });
  const stdioHost = serveStdioThinHost(server, client, {
    onShutdownFailure: (reason, error) => {
      process.exitCode = 1;
      console.error(`[bridge] ${reason} thin MCP disconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    },
    onShutdownComplete: (reason) => {
      if (reason !== "EOF") process.exit(0);
    },
  });
  const shutdown = (signal: string): void => {
    console.error(`[bridge] received ${signal}; closing thin MCP transport without cancelling Executor Tasks`);
    void stdioHost.shutdown(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  console.error("[bridge] Executor control transport enabled; no local SQLite Manager is constructed");
  console.error(`[bridge] ${host.name} thin stdio MCP server ready`);
}

export async function startBridge(
  host: BridgeHostProfile = codexHostProfile(),
  version = SERVER_VERSION,
  bridgeEntryPath = process.argv[1],
): Promise<void> {
  validateHostProfile(host);
  if (resolveMcpTransport(process.env) === "control") {
    await startThinBridge(host, version);
    return;
  }
  console.error("[bridge] SQLITE_INITIALIZING");
  let authoritySelection: ReturnType<typeof loadInstallAuthoritySelection>;
  let runtimeEnv: ReturnType<typeof loadPersistedRuntimeEnvironment>;
  let prepared: ReturnType<typeof prepareFreshSqliteStateDirectory>;
  try {
    runtimeEnv = loadPersistedRuntimeEnvironment(process.env, homedir(), host);
    authoritySelection = loadInstallAuthoritySelection(host);
    prepared = prepareFreshSqliteStateDirectory(authoritySelection, process.env);
  } catch (error) {
    console.error(`[bridge] SQLITE_INITIALIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  const dataRoot = prepared.dataRoot;
  const provenance = {
    bridge: fingerprintRuntimeArtifact(bridgeEntryPath),
    worker: fingerprintRuntimeArtifact(host.workerEntryPath ?? workerEntryPath()),
  };
  console.error(`[bridge] runtime provenance: ${JSON.stringify({
    bridge: { sha256: provenance.bridge.sha256 },
    worker: { sha256: provenance.worker.sha256 },
  })}`);
  console.error(`[bridge] data root: ${dataRoot}`);
  if (!provenance.bridge.sha256 || !provenance.worker.sha256) {
    throw new Error("BRIDGE_BUILD_PROVENANCE_UNAVAILABLE");
  }
  assertExecutorLeaseTransition({
    authorityRoot: dataRoot,
    databaseFileName: FRESH_SQLITE_DATABASE_FILE,
    acceptUnleasedExistingRoot: process.env[EXECUTOR_UNLEASED_TRANSITION_ENV] === "1",
  });
  const processProbe = createPlatformProbe();
  let leaseHandle: ExecutorLeaseHandle;
  try {
    leaseHandle = await acquireExecutorLease({
      authorityRoot: dataRoot,
      ownerKind: "legacy_mcp",
      processProbe,
      identity: await processProbe.selfIdentity(),
      bridgeSha256: provenance.bridge.sha256,
      workerSha256: provenance.worker.sha256,
      pipeName: null,
    });
  } catch (error) {
    console.error(`[bridge] EXECUTOR_LEASE_REFUSED: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  let leaseSafe = true;
  let leaseFailureReported = false;
  const leaseHeartbeat = setInterval(() => {
    void leaseHandle.heartbeat({
      onUnknown: (error) => {
        leaseSafe = false;
        if (!leaseFailureReported) {
          leaseFailureReported = true;
          console.error(`[bridge] EXECUTOR_HEARTBEAT_UNKNOWN: ${error.message}`);
        }
      },
    }).catch(() => undefined);
  }, 5_000);
  leaseHeartbeat.unref?.();

  const workerLimit = resolveMaxConcurrentWorkers(runtimeEnv);
  if (workerLimit.warning) console.error(`[bridge] ${workerLimit.warning}`);
  console.error(`[bridge] max concurrent workers: ${workerLimit.maxConcurrentWorkers}`);
  const timeoutSetting = runtimeEnv["ZCODE_BRIDGE_TIMEOUT_MS"]?.trim();
  if (timeoutSetting) {
    try {
      validateTaskTimeout(Number(timeoutSetting));
    } catch (error) {
      console.error(`[bridge] ${error instanceof Error ? error.message : String(error)}; using the ${DEFAULT_TASK_TIMEOUT_MS / 60_000} minute default`);
    }
  }

  const databasePath = path.join(dataRoot, FRESH_SQLITE_DATABASE_FILE);
  let composition: Awaited<ReturnType<typeof createProductionAuthorityComposition>>;
  try {
    composition = await createProductionAuthorityComposition({
      authorityRoot: dataRoot,
      host,
      bridgeEntryPath: bridgeEntryPath ?? "",
      workerEntryPath: host.workerEntryPath ?? workerEntryPath(),
      env: process.env,
      homeDir: homedir(),
      processProbe,
    });
  } catch (error) {
    console.error(`[bridge] SQLITE_INITIALIZATION_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  const manager = composition.authority;
  const taskManager = new LeaseGuardedTaskManager(manager, () => leaseSafe);
  const server = createBridgeServer({
    taskManager,
    doctor: composition.doctor,
    modelSettings: composition.modelSettings,
    serverInfo: { name: host.name, version },
    instructions: host.instructions,
  });
  const lifecycleManager = {
    async shutdown(): Promise<void> {
      await manager.shutdown();
      try {
        await leaseHandle.release();
      } catch (error) {
        throw new Error(`EXECUTOR_LEASE_RELEASE_UNKNOWN: ${error instanceof Error ? error.message : String(error)}`);
      }
      clearInterval(leaseHeartbeat);
    },
  };
  const stdioHost = serveStdioLifecycleHost(server, lifecycleManager, {
    onShutdownFailure: (reason, error) => {
      composition.abortAuthentication();
      process.exitCode = 1;
      console.error(`[bridge] ${reason} shutdown retained the lifecycle Root because cleanup was not verified: ${error instanceof Error ? error.message : String(error)}`);
    },
    onShutdownComplete: (reason) => {
      composition.abortAuthentication();
      if (reason !== "EOF") process.exit(0);
    },
  });
  const shutdown = (signal: string): void => {
    console.error(`[bridge] received ${signal}; fencing Admission/Dispatch before closing MCP transport`);
    void stdioHost.shutdown(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.error(`[bridge] SQLITE_READY at ${databasePath}`);
  console.error(`[bridge] ${host.name} stdio MCP server ready`);
}
