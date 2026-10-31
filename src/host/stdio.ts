// stdio entry point for the Bridge MCP server (ARCHITECTURE component 1).
//
// Startup never resolves the ZCode provider configuration, so a missing or
// broken ZCode setup cannot prevent the server from starting; such problems
// surface per task through the existing failure flow. All protocol traffic
// goes to stdout via the SDK's serveStdio transport; every log line here is
// written to stderr. A connected Host keeps the transport available until
// lifecycle shutdown verifies Cleanup; stdin EOF is handled separately.
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { homedir } from "node:os";
import path from "node:path";
import { findPackageRoot, loadPersistedRuntimeEnvironment } from "../runtime/resolver.js";
import { DirectWorkspaceProvider } from "../workspace/direct-provider.js";
import { BridgeTaskManager } from "../manager/task-manager.js";
import { createBridgeServer } from "../mcp/server.js";
import { DEFAULT_TASK_TIMEOUT_MS, validateTaskTimeout } from "../runtime/task-timeout.js";
import { runBridgeDoctor } from "../runtime/doctor.js";
import { ZCodeModelSettings } from "../runtime/model-settings.js";
import { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "./profile.js";
import { createWorkerSpawner, workerEntryPath } from "../manager/spawn-worker.js";
import { createPlatformProbe, type ProcessIdentity } from "../runtime/process-probe.js";
import { fingerprintRuntimeArtifact } from "../runtime/build-provenance.js";
import { createTrustedLocalStdioContext } from "../runtime/trusted-local-deployment.js";
import { SERVER_VERSION } from "../mcp/server.js";
import { registerManagerJsonWriter } from "../store/json-writer-quiescence.js";
import {
  loadInstallAuthoritySelection,
  prepareFreshSqliteStateDirectory,
  resolveSqliteStateDirectory,
  FRESH_SQLITE_DATABASE_FILE,
} from "../runtime/sqlite-install-config.js";

export interface DataRootResolution {
  readonly dataRoot: string;
  readonly warning?: string;
}

export class SqliteAuthorityStartupError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "SqliteAuthorityStartupError";
  }
}

/** Resolve the JSON root that the same Host would have used before an explicit SQLite switch. */
export function resolveLegacyJsonDataRoot(host: BridgeHostProfile, runtimeEnv: NodeJS.ProcessEnv): string {
  const configured = runtimeEnv["ZCODE_BRIDGE_DATA_DIR"]?.trim();
  if (configured && path.isAbsolute(configured)) return path.normalize(configured);
  if (host.defaultDataRoot) return path.normalize(host.defaultDataRoot);
  if (runtimeEnv["ZCODE_BRIDGE_PLUGIN_MODE"] === "1") return path.normalize(host.settingsDirectory);
  return findPackageRoot();
}

/**
 * A missing SQLite database is a fresh install only when the legacy Task root
 * is absent or empty. The check is read-only and never treats unreadable or
 * redirected state as empty.
 */
export function assertFreshInstallLegacyJsonEmpty(legacyDataRoot: string): void {
  const tasksRoot = path.join(path.normalize(legacyDataRoot), ".tasks");
  let stat;
  try {
    stat = lstatSync(tasksRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new SqliteAuthorityStartupError("legacy_json_tasks_root_unreadable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SqliteAuthorityStartupError("legacy_json_tasks_root_unsafe");
  }
  let entries: string[];
  try {
    entries = readdirSync(tasksRoot);
  } catch {
    throw new SqliteAuthorityStartupError("legacy_json_tasks_root_unreadable");
  }
  if (entries.length > 0) {
    throw new SqliteAuthorityStartupError(
      "migration_required_for_existing_json_authority",
      "SQLite is missing while the legacy JSON Task root contains state; run the explicit stop-the-world migration",
    );
  }
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
  manager: Pick<BridgeTaskManager, "shutdown">,
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

export async function startBridge(
  host: BridgeHostProfile = codexHostProfile(),
  version = SERVER_VERSION,
  bridgeEntryPath = process.argv[1],
): Promise<void> {
  validateHostProfile(host);
  const authoritySelection = loadInstallAuthoritySelection(host);
  const runtimeEnv = loadPersistedRuntimeEnvironment(process.env, homedir(), host);
  let dataRoot = "";
  let warning: string | undefined;
  let sqliteDatabaseMissing = false;
  if (authoritySelection.state === "json") {
    if (!runtimeEnv["ZCODE_BRIDGE_DATA_DIR"]?.trim() && host.defaultDataRoot) runtimeEnv["ZCODE_BRIDGE_DATA_DIR"] = host.defaultDataRoot;
    // Keep legacy JSON records outside the versioned marketplace cache.
    if (process.env["ZCODE_BRIDGE_PLUGIN_MODE"] === "1" && !runtimeEnv["ZCODE_BRIDGE_DATA_DIR"]?.trim()) {
      runtimeEnv["ZCODE_BRIDGE_DATA_DIR"] = host.settingsDirectory;
    }
    const resolved = resolveDataRoot(runtimeEnv);
    dataRoot = resolved.dataRoot;
    warning = resolved.warning;
  } else {
    const resolvedState = resolveSqliteStateDirectory(authoritySelection, process.env);
    sqliteDatabaseMissing = !existsSync(path.join(resolvedState.dataRoot, FRESH_SQLITE_DATABASE_FILE));
    if (sqliteDatabaseMissing) {
      assertFreshInstallLegacyJsonEmpty(resolveLegacyJsonDataRoot(host, runtimeEnv));
    }
    const prepared = prepareFreshSqliteStateDirectory(authoritySelection, process.env);
    dataRoot = prepared.dataRoot;
  }
  const provenance = {
    bridge: fingerprintRuntimeArtifact(bridgeEntryPath),
    worker: fingerprintRuntimeArtifact(host.workerEntryPath ?? workerEntryPath()),
  };
  console.error(`[bridge] runtime provenance: ${JSON.stringify({
    bridge: { sha256: provenance.bridge.sha256 },
    worker: { sha256: provenance.worker.sha256 },
  })}`);
  if (warning) {
    console.error(`[bridge] ${warning}`);
  }
  console.error(`[bridge] data root: ${dataRoot}`);

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

  const processProbe = createPlatformProbe();
  let manager: BridgeTaskManager;
  if (authoritySelection.state === "sqlite") {
    const trustedLocalContext = createTrustedLocalCandidateContext(host);
    if (trustedLocalContext.status !== "enabled") {
      throw new Error(`SQLite Authority startup refused: Trusted Local policy is ${trustedLocalContext.status}`);
    }
    const databasePath = path.join(dataRoot, FRESH_SQLITE_DATABASE_FILE);
    const lifecycleGate = await import("../store/lifecycle-gate.js");
    if (sqliteDatabaseMissing) {
      await lifecycleGate.initializeFreshInstallSqliteRoot(dataRoot, FRESH_SQLITE_DATABASE_FILE);
    }
    const { SqliteLifecycleMcpAuthority } = await import("../manager/sqlite-lifecycle-mcp-authority.js");
    const authority = await SqliteLifecycleMcpAuthority.create({
      dataRoot,
      databaseFileName: FRESH_SQLITE_DATABASE_FILE,
      managedDataDirectory: true,
      workerEntryPath: host.workerEntryPath ?? workerEntryPath(),
      hostProfile: host,
      bridgeEntryPath: bridgeEntryPath ?? "",
      processProbe,
      trustedLocalContext,
      requireAuthorityReceipt: true,
    });
    manager = new BridgeTaskManager({ lifecycleAuthority: authority, maxConcurrentWorkers: workerLimit.maxConcurrentWorkers });
    console.error(`[bridge] SQLite Authority ready at ${databasePath}`);
  } else {
    let managerIdentity: ProcessIdentity | null = null;
    try {
      const observed = await processProbe.selfIdentity();
      if (observed.fingerprint_precision === "exact" && observed.fingerprint) managerIdentity = observed;
    }
    catch { /* normal JSON startup remains available; cutover cannot seal unknown identity */ }
    const managerWriterLeaseToken = await registerManagerJsonWriter(dataRoot, managerIdentity);
    const { TaskStore } = await import("../store/task-store.js");
    const store = new TaskStore(dataRoot, { writerQuiescence: true, writerLeaseToken: managerWriterLeaseToken });
    manager = new BridgeTaskManager({
      store,
      workspaceProvider: new DirectWorkspaceProvider(),
      maxConcurrentWorkers: workerLimit.maxConcurrentWorkers,
      spawnWorker: createWorkerSpawner(host, provenance, { writerQuiescence: true }),
      probe: processProbe,
      managerWriterLeaseToken,
    });
  }
  const modelSettings = new ZCodeModelSettings(process.env, { host });
  const server = createBridgeServer({
    taskManager: manager,
    doctor: () => runBridgeDoctor({ env: runtimeEnv, dataRoot, resolver: { host } }),
    modelSettings,
    serverInfo: { name: host.name, version },
    instructions: host.instructions,
  });
  const stdioHost = serveStdioLifecycleHost(server, manager, {
    onShutdownFailure: (reason, error) => {
      process.exitCode = 1;
      console.error(`[bridge] ${reason} shutdown retained the lifecycle Root because cleanup was not verified: ${error instanceof Error ? error.message : String(error)}`);
    },
    onShutdownComplete: (reason) => {
      if (reason !== "EOF") process.exit(0);
    },
  });
  const shutdown = (signal: string): void => {
    console.error(`[bridge] received ${signal}; fencing Admission/Dispatch before closing MCP transport`);
    void stdioHost.shutdown(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  console.error(`[bridge] ${host.name} stdio MCP server ready`);
}
